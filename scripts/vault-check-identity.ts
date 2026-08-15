#!/usr/bin/env ts-node
/**
 * Verify that every content note has a usable identity, and fail the build if not.
 *
 * Cross-page references resolve on `(type, shortcode)` (#1388). That only works
 * while the pair is unique: two notes of one type sharing a shortcode make
 * every reference to either of them a coin flip, and — because Hugo's `where`
 * reports nothing when a lookup is ambiguous or empty — the wrong page would be
 * linked with no warning at all. So the invariant is checked here, before the
 * export runs, and a violation stops the build.
 *
 * A shortcode shared across *different* types is fine and expected: the totem
 * mystery `boar` and the animal `boar` are different documents with different
 * URLs, and no reference field can confuse them because each names the type it
 * points at.
 *
 * This checks and never fixes. The vault is hand-authored, and a duplicate
 * shortcode is a decision about which document is which — not something a
 * script should decide.
 *
 * Usage:
 *   npx ts-node scripts/vault-check-identity.ts
 *   npx ts-node scripts/vault-check-identity.ts --verbose   # also list notes with no shortcode
 *   VAULT_ROOT=/path/to/vault npx ts-node scripts/vault-check-identity.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findNotes, readFrontMatter } from "./vault-frontmatter";

const VAULT_ROOT =
    process.env.VAULT_ROOT || path.join(os.homedir(), "dev/github/HeroicLands");

const VERBOSE = process.argv.includes("--verbose");

/**
 * Directories holding vault scaffolding rather than content.
 *
 * `Templates/` are the blank forms an author copies to start a note, and
 * `Types/` are the collection landings that group them. Their placeholder
 * shortcodes are not identities and must not be checked for uniqueness — the
 * same exclusion the alias lint applies.
 */
const SCAFFOLDING = ["Templates/", "Types/"];

interface Note {
    file: string;
    type: string;
    shortcode: string;
}

function main(): void {
    if (!fs.existsSync(VAULT_ROOT)) {
        console.error(`Vault not found at ${VAULT_ROOT}`);
        process.exit(1);
    }

    const byId = new Map<string, Note[]>();
    const missing: string[] = [];
    let checked = 0;

    for (const filepath of findNotes(VAULT_ROOT)) {
        const rel = path.relative(VAULT_ROOT, filepath);
        if (SCAFFOLDING.some((dir) => rel.startsWith(dir))) continue;

        const fm = readFrontMatter(fs.readFileSync(filepath, "utf8"));
        if (!fm) continue;

        const type = typeof fm.type === "string" ? fm.type.toLowerCase() : "";
        // A note with no type is not content — prose, an index, a scratch
        // page — and carries no identity to check.
        if (!type) continue;
        checked++;

        const shortcode = typeof fm.shortcode === "string" ? fm.shortcode : "";
        if (!shortcode) {
            missing.push(rel);
            continue;
        }

        const key = `${type}/${shortcode}`;
        const list = byId.get(key);
        if (list) list.push({ file: rel, type, shortcode });
        else byId.set(key, [{ file: rel, type, shortcode }]);
    }

    const duplicates = [...byId.entries()].filter(([, v]) => v.length > 1);

    console.log(
        `Checked ${checked} content note(s): ${byId.size} distinct (type, shortcode) identities.`,
    );

    if (missing.length > 0) {
        console.warn(
            `\n${missing.length} content note(s) carry no shortcode, so nothing can reference them:`,
        );
        for (const file of VERBOSE ? missing : missing.slice(0, 10)) {
            console.warn(`  ${file}`);
        }
        if (!VERBOSE && missing.length > 10) {
            console.warn(`  … and ${missing.length - 10} more (pass --verbose)`);
        }
    }

    if (duplicates.length > 0) {
        console.error(
            `\n✗ ${duplicates.length} duplicate (type, shortcode) identit${duplicates.length === 1 ? "y" : "ies"} — every reference to these is ambiguous:`,
        );
        for (const [key, notes] of duplicates.sort()) {
            console.error(`  ${key}`);
            for (const n of notes) console.error(`      ${n.file}`);
        }
        console.error(
            `\nGive each note its own shortcode within its type, then re-run.`,
        );
        process.exit(1);
    }

    console.log("✓ Every (type, shortcode) identity is unique.");
}

main();
