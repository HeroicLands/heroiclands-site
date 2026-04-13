#!/usr/bin/env npx ts-node

/**
 * migrate-dot-notation.ts
 *
 * Converts flat dot-notation YAML frontmatter keys to nested YAML objects
 * across all markdown files in the Thalorna Obsidian vault.
 *
 * Example:
 *   name.full: "Groa"
 *   name.given: Groa
 *   name.aliases: []
 *
 * Becomes:
 *   name:
 *     full: "Groa"
 *     given: Groa
 *     aliases: []
 *
 * Usage:
 *   npx ts-node migrate-dot-notation.ts [--dry-run] [--verbose]
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

const VAULT_ROOT = process.env.VAULT_ROOT
    || path.join(process.env.HOME || "/Users/tomr", "dev/github/thalorna");

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Recursively find all .md files.
 */
function findMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    function walk(d: string) {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(d, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
                    walk(fullPath);
                }
            } else if (entry.name.endsWith(".md") && !entry.name.startsWith(".")) {
                results.push(fullPath);
            }
        }
    }
    walk(dir);
    return results;
}

/**
 * Extract frontmatter string and body from a markdown file's content.
 * Returns null if the file has no frontmatter.
 */
function splitFrontmatterAndBody(
    content: string,
): { yamlStr: string; body: string } | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)([\s\S]*)$/);
    if (!match) return null;
    return { yamlStr: match[1], body: match[2] + match[3] };
}

/**
 * Set a nested key in an object using dot-notation path.
 * e.g., setNestedKey(obj, "name.full", "Groa") → obj.name.full = "Groa"
 */
function setNestedKey(obj: Record<string, any>, dotKey: string, value: any): void {
    const parts = dotKey.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!(part in current) || typeof current[part] !== "object" || current[part] === null || Array.isArray(current[part])) {
            current[part] = {};
        }
        current = current[part];
    }
    current[parts[parts.length - 1]] = value;
}

/**
 * Check if a key uses dot-notation (and isn't a top-level key).
 */
function isDotNotation(key: string): boolean {
    return key.includes(".");
}

/**
 * Convert a flat object with dot-notation keys into a nested object.
 * Non-dot keys are kept at top level.
 */
function nestDotKeys(fm: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(fm)) {
        if (isDotNotation(key)) {
            setNestedKey(result, key, value);
        } else {
            // Keep non-dot keys at top level, but if the key already exists
            // as a nested object from a dot-notation key, merge carefully
            if (key in result && typeof result[key] === "object" && typeof value === "object" && !Array.isArray(value)) {
                Object.assign(result[key], value);
            } else {
                result[key] = value;
            }
        }
    }

    return result;
}

/**
 * Custom YAML serializer that produces clean, readable output.
 * Uses js-yaml's dump with settings tuned for Obsidian compatibility.
 */
function serializeYaml(obj: Record<string, any>): string {
    return yaml.dump(obj, {
        indent: 2,
        lineWidth: -1,         // no line wrapping
        noRefs: true,          // no YAML anchors
        sortKeys: false,       // preserve insertion order
        quotingType: '"',      // use double quotes when quoting
        forceQuotes: false,    // only quote when necessary
    }).trimEnd();
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const verbose = args.includes("--verbose");

    if (dryRun) {
        console.log("=== DRY RUN (no files will be modified) ===\n");
    }

    console.log(`Scanning vault: ${VAULT_ROOT}`);
    const files = findMarkdownFiles(VAULT_ROOT);
    console.log(`Found ${files.length} markdown files\n`);

    let migrated = 0;
    let skipped = 0;
    let noFrontmatter = 0;
    let noDotKeys = 0;
    let errors = 0;

    for (const filepath of files) {
        const relPath = path.relative(VAULT_ROOT, filepath);
        const content = fs.readFileSync(filepath, "utf-8");

        const split = splitFrontmatterAndBody(content);
        if (!split) {
            noFrontmatter++;
            if (verbose) console.log(`  [skip] No frontmatter: ${relPath}`);
            continue;
        }

        let fm: Record<string, any>;
        try {
            fm = yaml.load(split.yamlStr) as Record<string, any>;
        } catch (e) {
            // If js-yaml can't parse it, skip
            errors++;
            console.warn(`  [error] Failed to parse YAML in ${relPath}: ${e}`);
            continue;
        }

        if (!fm || typeof fm !== "object") {
            skipped++;
            if (verbose) console.log(`  [skip] Empty/invalid frontmatter: ${relPath}`);
            continue;
        }

        // Check if there are any dot-notation keys
        const hasDotKeys = Object.keys(fm).some(isDotNotation);
        if (!hasDotKeys) {
            noDotKeys++;
            if (verbose) console.log(`  [skip] No dot-notation keys: ${relPath}`);
            continue;
        }

        // Convert to nested
        const nested = nestDotKeys(fm);

        // Serialize back to YAML
        const newYaml = serializeYaml(nested);
        const newContent = `---\n${newYaml}\n---\n${split.body}`;

        if (dryRun) {
            if (verbose) {
                console.log(`  [migrate] ${relPath}`);
                // Show first few lines of diff
                const oldKeys = Object.keys(fm).filter(isDotNotation).slice(0, 5);
                console.log(`    Dot keys: ${oldKeys.join(", ")}${Object.keys(fm).filter(isDotNotation).length > 5 ? "..." : ""}`);
            } else {
                console.log(`  Would migrate: ${relPath}`);
            }
            migrated++;
            continue;
        }

        // Write the file
        fs.writeFileSync(filepath, newContent, "utf-8");
        migrated++;
        if (verbose) {
            console.log(`  [migrated] ${relPath}`);
        }
    }

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results:`);
    console.log(`  Migrated:        ${migrated}`);
    console.log(`  No frontmatter:  ${noFrontmatter}`);
    console.log(`  No dot keys:     ${noDotKeys}`);
    console.log(`  Skipped:         ${skipped}`);
    console.log(`  Errors:          ${errors}`);
    console.log(`  Total files:     ${files.length}`);
}

main();
