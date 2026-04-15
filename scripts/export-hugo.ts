#!/usr/bin/env npx ts-node

/**
 * export-hugo.ts
 *
 * Exports publishable content from the Thalorna Obsidian vault
 * to the heroiclands-site Hugo project.
 *
 * Usage:
 *   npx ts-node export-hugo.ts [--dry-run] [--verbose]
 *
 * What it does:
 *   1. Scans the Obsidian vault for files with publish.website: true
 *   2. Builds a lookup map of all publishable files (filename → type, title, slug)
 *   3. Transforms front matter (strips game-mechanical fields, maps to Hugo fields)
 *   4. Rewrites Obsidian wikilinks and image embeds to Hugo-compatible Markdown.
 *      Image embeds are rewritten to CDN URLs (https://cdn.heroiclands.org/images/...);
 *      the actual image files live on the CDN and are not bundled with the site.
 *   5. Writes transformed files to bucket-specific output paths
 *      (e.g. content/world/thalorna/{type}/{slug}.md,
 *      content/project/{bucket}/{slug}.md, content/blog/YYYY/MM/{slug}.md)
 */

import * as fs from "fs";
import * as path from "path";

// ── Configuration ──────────────────────────────────────────────────

const VAULT_ROOT = process.env.VAULT_ROOT
    || path.join(process.env.HOME || "/Users/tomr", "dev/github/HeroicLands");
const HUGO_ROOT = process.env.HUGO_ROOT
    || path.resolve(__dirname, "..");
const HUGO_CONTENT = path.join(HUGO_ROOT, "content");
// Base URL for image references emitted into rendered markdown.
// All site images live on the CDN — nothing is bundled into static/.
const IMAGE_CDN_BASE = "https://cdn.heroiclands.org/images";

const VALID_TYPES = [
    "blog-post",
    "character",
    "continent",
    "creature",
    "faith",
    "religion",
    "language",
    "lore",
    "organization",
    "page",
    "pantheon",
    "people",
    "polity",
    "project-page",
    "region",
    "settlement",
    "site",
    "type-catalog",
    "world",
] as const;

type ContentType = (typeof VALID_TYPES)[number];

// ── Bucket configuration ───────────────────────────────────────────

/**
 * A bucket maps a vault-path prefix to a Hugo content path with a
 * specific routing strategy for the files within it.
 *
 *   vaultPrefix: path under VAULT_ROOT that identifies this bucket
 *     (must end with "/")
 *   hugoPath:    destination path under HUGO_CONTENT (no leading slash)
 *   routing:
 *     "by-type"  - per-type subdir, e.g. content/world/thalorna/character/{slug}.md
 *     "flat"     - all entries at bucket root, e.g. content/project/sohl/{slug}.md
 *     "by-date"  - date-prefixed from frontmatter.date (YYYY-MM-DD),
 *                  e.g. content/blog/YYYY/MM/{slug}.md
 *
 * Order matters: buckets are matched longest-prefix-first, so more
 * specific paths (e.g. "Projects/Song_of_Heroic_Lands/") must come
 * before less specific ones (e.g. "Projects/").
 */
interface BucketConfig {
    vaultPrefix: string;
    hugoPath: string;
    routing: "by-type" | "flat" | "by-date";
}

const BUCKETS: BucketConfig[] = [
    { vaultPrefix: "Types/",                         hugoPath: "types",           routing: "flat"    },
    { vaultPrefix: "Projects/Song_of_Heroic_Lands/", hugoPath: "project/sohl",    routing: "flat"    },
    { vaultPrefix: "Projects/HM3/",                  hugoPath: "project/hm3",     routing: "flat"    },
    { vaultPrefix: "Projects/Modules/",              hugoPath: "project/modules", routing: "flat"    },
    { vaultPrefix: "Projects/",                      hugoPath: "project",         routing: "flat"    },
    { vaultPrefix: "Worlds/Thalorna/",               hugoPath: "world/thalorna",  routing: "by-type" },
    { vaultPrefix: "Blog/",                          hugoPath: "blog",            routing: "by-date" },
];

function resolveBucket(filepath: string): BucketConfig | null {
    const rel = path.relative(VAULT_ROOT, filepath);
    for (const bucket of BUCKETS) {
        if (rel.startsWith(bucket.vaultPrefix)) {
            return bucket;
        }
    }
    return null;
}

// ── Types ──────────────────────────────────────────────────────────

interface VaultEntry {
    /** Absolute path to the source .md file */
    filepath: string;
    /** Filename without extension, e.g. "Groa_the_Seior_of_Norgaad" */
    stem: string;
    /** Parsed front matter (raw) */
    frontmatter: Record<string, any>;
    /** Markdown body (everything after front matter) */
    body: string;
    /** Content type from front matter (or "page" for _index.md section indexes) */
    type: ContentType;
    /** Display title from name.full or title or stem */
    title: string;
    /** Lowercase slug for Hugo path */
    slug: string;
    /** Which bucket this entry belongs to, based on its vault path */
    bucket: BucketConfig;
    /** Whether this entry is a section index (_index.md) */
    isIndex: boolean;
    /** Absolute output path in the Hugo content tree */
    outputPath: string;
    /** Public URL path for wikilink resolution (leading slash, trailing slash) */
    url: string;
}

interface LookupEntry {
    title: string;
    /** Public URL path, e.g. "/world/thalorna/character/some-person/" */
    url: string;
}

// ── Front matter parsing ───────────────────────────────────────────

/**
 * YAML front matter parser that handles nested objects and arrays.
 *
 * Uses js-yaml if available, otherwise falls back to a hand-rolled
 * indent-aware parser that handles the vault's front matter patterns:
 *   - dot-notation keys (name.full, traits.height.m)
 *   - nested objects (publish: { website: true })
 *   - arrays of scalars and key:value pairs (sohl.skills: [- str:9])
 */

let jsYamlLoad: ((str: string) => any) | null = null;
try {
    jsYamlLoad = require("js-yaml").load;
} catch {
    // js-yaml not installed; fall back to hand-rolled parser
}

function parseFrontMatter(
    content: string,
): { frontmatter: Record<string, any>; body: string } | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return null;

    const yamlStr = match[1];
    const body = match[2];

    if (jsYamlLoad) {
        try {
            const fm = jsYamlLoad(yamlStr);
            if (fm && typeof fm === "object") {
                return { frontmatter: fm, body };
            }
        } catch {
            // Fall through to hand-rolled parser
        }
    }

    // ── Hand-rolled indent-aware YAML parser ──

    const root: Record<string, any> = {};
    const lines = yamlStr.split("\n");

    interface Frame {
        target: Record<string, any> | any[];
        indent: number;
    }

    const stack: Frame[] = [{ target: root, indent: -1 }];

    function current(): Frame {
        return stack[stack.length - 1];
    }

    function popToIndent(indent: number): void {
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }
    }

    function parseValue(raw: string): any {
        if (!raw) return undefined;

        // Inline array [a, b, c]
        if (raw.startsWith("[") && raw.endsWith("]")) {
            return raw
                .slice(1, -1)
                .split(",")
                .map((s) => s.trim().replace(/^["']|["']$/g, ""))
                .filter((s) => s.length > 0);
        }

        const cleaned = raw.replace(/^["']|["']$/g, "");
        if (cleaned === "true") return true;
        if (cleaned === "false") return false;
        if (/^\d+\/\d+\/\d+$/.test(cleaned)) return cleaned; // date like 692/4/3
        if (/^\d+$/.test(cleaned)) return parseInt(cleaned, 10);
        if (/^\d+\.\d+$/.test(cleaned)) return parseFloat(cleaned);
        return cleaned;
    }

    function peekNextContentLine(fromIdx: number): string | null {
        for (let i = fromIdx + 1; i < lines.length; i++) {
            const t = lines[i].trim();
            if (t && !t.startsWith("#")) return lines[i];
        }
        return null;
    }

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const indent = line.search(/\S/);

        // ── Array item ──
        if (trimmed.startsWith("- ")) {
            const itemContent = trimmed.slice(2).trim();
            popToIndent(indent);
            const frame = current();

            if (Array.isArray(frame.target)) {
                // Check if item is key:value (like "str:9")
                const kvInItem = itemContent.match(/^([^:]+):\s*(.+)$/);
                if (kvInItem) {
                    // Store as "key:value" string to preserve format
                    frame.target.push(`${kvInItem[1].trim()}:${kvInItem[2].trim()}`);
                } else {
                    frame.target.push(parseValue(itemContent));
                }
            }
            continue;
        }

        // ── Key: value ──
        const kvMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
        if (kvMatch) {
            const key = kvMatch[1].trim();
            const rawValue = kvMatch[2].trim();

            popToIndent(indent);
            const frame = current();
            const target = frame.target as Record<string, any>;

            if (rawValue === "") {
                // Start of nested structure — peek to see if array or object
                const nextLine = peekNextContentLine(li);
                const isArray = nextLine ? nextLine.trim().startsWith("- ") : false;

                if (isArray) {
                    const arr: any[] = [];
                    target[key] = arr;
                    stack.push({ target: arr, indent });
                } else {
                    const obj: Record<string, any> = {};
                    target[key] = obj;
                    stack.push({ target: obj, indent });
                }
            } else {
                target[key] = parseValue(rawValue);
            }
        }
    }

    return { frontmatter: root, body };
}

/**
 * Check if an entry is publishable.
 *
 * An entry is publishable unless it is explicitly marked as a draft.
 * This matches the universal vault schema: `draft` defaults to false,
 * so any file without an explicit `draft: true` is treated as ready.
 */
function isPublishable(fm: Record<string, any>): boolean {
    return fm.draft !== true;
}

// ── Scanning ───────────────────────────────────────────────────────

/**
 * Recursively find all .md files in a directory.
 */
function findMarkdownFiles(dir: string): string[] {
    const results: string[] = [];

    function walk(d: string) {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(d, entry.name);
            if (entry.isDirectory()) {
                // Skip hidden directories and images
                if (!entry.name.startsWith(".") && entry.name !== "images") {
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
 * Scan the vault and build a list of publishable entries.
 */
/**
 * Given a bucket and source filepath, compute where the file should
 * be written in the Hugo content tree and what its public URL will be.
 *
 * For `_index.md` files, the output is the section-index of the
 * appropriate bucket-subpath (preserving the vault's directory nesting).
 * For regular files, the bucket's routing strategy determines the
 * output path shape.
 *
 * Returns null if the entry cannot be routed (e.g. by-date bucket
 * but no valid date in frontmatter).
 */
function resolveOutputPath(
    entry: Omit<VaultEntry, "outputPath" | "url" | "bucket" | "isIndex"> & {
        bucket: BucketConfig;
        isIndex: boolean;
    },
): { outputPath: string; url: string } | null {
    const hugoBase = path.join(HUGO_CONTENT, entry.bucket.hugoPath);
    const urlBase = `/${entry.bucket.hugoPath}`;

    if (entry.isIndex) {
        // Preserve vault subpath structure within the bucket.
        const rel = path.relative(VAULT_ROOT, entry.filepath);
        const vaultSubpath = path.dirname(
            rel.substring(entry.bucket.vaultPrefix.length),
        );
        const subSegments =
            vaultSubpath === "." || vaultSubpath === ""
                ? []
                : vaultSubpath.split(path.sep).map((s) => s.toLowerCase());
        const outputPath = path.join(
            hugoBase,
            ...subSegments,
            "_index.md",
        );
        const url = subSegments.length === 0
            ? `${urlBase}/`
            : `${urlBase}/${subSegments.join("/")}/`;
        return { outputPath, url };
    }

    switch (entry.bucket.routing) {
        case "by-type": {
            const outputPath = path.join(
                hugoBase,
                entry.type,
                `${entry.slug}.md`,
            );
            const url = `${urlBase}/${entry.type}/${entry.slug}/`;
            return { outputPath, url };
        }
        case "flat": {
            const outputPath = path.join(hugoBase, `${entry.slug}.md`);
            const url = `${urlBase}/${entry.slug}/`;
            return { outputPath, url };
        }
        case "by-date": {
            const date = entry.frontmatter.date;
            const match = typeof date === "string"
                ? date.match(/^(\d{4})-(\d{2})-\d{2}/)
                : null;
            if (!match) return null;
            const [, year, month] = match;
            const outputPath = path.join(
                hugoBase,
                year,
                month,
                `${entry.slug}.md`,
            );
            const url = `${urlBase}/${year}/${month}/${entry.slug}/`;
            return { outputPath, url };
        }
    }
    return null;
}

function scanVault(verbose: boolean): VaultEntry[] {
    const files = findMarkdownFiles(VAULT_ROOT);
    const entries: VaultEntry[] = [];

    if (verbose) {
        console.log(`Found ${files.length} markdown files in vault`);
    }

    for (const filepath of files) {
        const content = fs.readFileSync(filepath, "utf-8");
        const parsed = parseFrontMatter(content);
        if (!parsed) continue;

        const { frontmatter: fm, body } = parsed;

        if (!isPublishable(fm)) continue;

        const bucket = resolveBucket(filepath);
        if (!bucket) {
            // File sits outside any configured bucket (e.g. at vault root).
            // These are meta files (CLAUDE.md, TASKS.md) — silently skip.
            continue;
        }

        const stem = path.basename(filepath, ".md");
        const isIndex = stem === "_index";

        // Section indexes don't require a type; they are handled specially.
        // Regular entries must declare a type from VALID_TYPES.
        let rawType: ContentType;
        if (isIndex) {
            rawType = "page";
        } else {
            const declaredType = (fm.type || "").toString().toLowerCase();
            if (!VALID_TYPES.includes(declaredType as ContentType)) {
                if (verbose) {
                    console.warn(
                        `  Skipping ${filepath}: unknown type "${fm.type}"`,
                    );
                }
                continue;
            }
            rawType = declaredType as ContentType;
        }

        const title =
            fm.name?.full || fm.title || stem.replace(/_/g, " ");
        const slug = fm.slug || stem.toLowerCase().replace(/_/g, "-");

        const resolved = resolveOutputPath({
            filepath,
            stem,
            frontmatter: fm,
            body,
            type: rawType,
            title,
            slug,
            bucket,
            isIndex,
        });

        if (!resolved) {
            if (verbose) {
                console.warn(
                    `  Skipping ${filepath}: could not resolve output path (bucket "${bucket.hugoPath}", routing "${bucket.routing}" — check frontmatter)`,
                );
            }
            continue;
        }

        entries.push({
            filepath,
            stem,
            frontmatter: fm,
            body,
            type: rawType,
            title,
            slug,
            bucket,
            isIndex,
            outputPath: resolved.outputPath,
            url: resolved.url,
        });
    }

    if (verbose) {
        console.log(`Found ${entries.length} publishable files`);
    }

    return entries;
}

// ── Lookup map ─────────────────────────────────────────────────────

function buildLookupMap(entries: VaultEntry[]): Map<string, LookupEntry> {
    const map = new Map<string, LookupEntry>();
    for (const entry of entries) {
        const lookupEntry: LookupEntry = {
            title: entry.title,
            url: entry.url,
        };

        if (entry.isIndex) {
            // _index.md files all share the stem "_index", so indexing by
            // stem would cause every index file to collide. Instead, index
            // them by the name of their parent directory (which is what
            // authors naturally wikilink to, e.g. [[Song_of_Heroic_Lands]]).
            const parentDirName = path.basename(path.dirname(entry.filepath));
            if (parentDirName && !map.has(parentDirName)) {
                map.set(parentDirName, lookupEntry);
            }
        } else {
            // Index by filename stem (primary key)
            map.set(entry.stem, lookupEntry);
        }

        // Index by aliases from front matter
        const aliases = entry.frontmatter.aliases;
        if (Array.isArray(aliases)) {
            for (const alias of aliases) {
                if (typeof alias === "string" && !map.has(alias)) {
                    map.set(alias, lookupEntry);
                }
            }
        }

        // Index by name.aliases as well
        const nameAliases = entry.frontmatter.name?.aliases;
        if (Array.isArray(nameAliases)) {
            for (const alias of nameAliases) {
                if (typeof alias === "string" && !map.has(alias)) {
                    map.set(alias, lookupEntry);
                }
            }
        }

        // Index by name.full
        const nameFull = entry.frontmatter.name?.full;
        if (typeof nameFull === "string" && !map.has(nameFull)) {
            map.set(nameFull, lookupEntry);
        }

        // Index by name.given
        const nameGiven = entry.frontmatter.name?.given;
        if (typeof nameGiven === "string" && !map.has(nameGiven)) {
            map.set(nameGiven, lookupEntry);
        }
    }
    return map;
}

// ── Front matter transformation ────────────────────────────────────

/** Fields to carry over to Hugo front matter */
const HUGO_FIELDS: Record<string, (fm: Record<string, any>) => any> = {
    title: (fm) => fm.name?.full || fm.title || "",
    slug: (fm) => fm.slug || undefined,
    description: (fm) => {
        const type = fm.type || "";
        const realm = fm.thalorna?.realm || "";
        const occupation = fm.social?.occupation || "";
        const parts: string[] = [];
        if (occupation) parts.push(occupation);
        if (realm) parts.push(`of ${realm}`);
        if (parts.length === 0 && type) parts.push(type);
        return parts.join(" ") || undefined;
    },
    type: (fm) => fm.type?.toLowerCase(),
    tags: (fm) => fm.tags || [],
    realm: (fm) => fm.thalorna?.realm || undefined,
    lineage: (fm) => fm.traits?.lineage || undefined,
    gender: (fm) => fm.traits?.gender || undefined,
    occupation: (fm) => fm.social?.occupation || undefined,
    // Page-level banner override. Accepts either a full URL or a CDN-relative
    // fragment like "banners/character.webp"; hero-banner.html resolves both.
    banner: (fm) => fm.banner || undefined,
    aliases: (fm) => {
        const aliases = fm.aliases;
        return aliases && aliases.length > 0 ? aliases : undefined;
    },
    // Nested structures passed through verbatim so layouts can read them
    // directly (e.g. .Params.sohl.attributes.str, .Params.traits.height.m).
    // serializeFrontMatter emits these as proper nested YAML.
    name: (fm) => fm.name || undefined,
    social: (fm) => fm.social || undefined,
    thalorna: (fm) => fm.thalorna || undefined,
    traits: (fm) => fm.traits || undefined,
    sohl: (fm) => fm.sohl || undefined,
};

function transformFrontMatter(fm: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, extractor] of Object.entries(HUGO_FIELDS)) {
        const value = extractor(fm);
        if (value !== undefined && value !== "") {
            result[key] = value;
        }
    }
    return result;
}

/** Quote a scalar string for YAML when it contains special characters. */
function yamlScalar(value: string): string {
    if (
        value === "" ||
        value.includes(":") ||
        value.includes('"') ||
        value.includes("'") ||
        value.includes("#") ||
        value.startsWith(" ") ||
        value.startsWith("[") ||
        value.startsWith("{") ||
        value.startsWith("-") ||
        value.startsWith("*") ||
        value.startsWith("&") ||
        value.startsWith("!") ||
        value.startsWith("|") ||
        value.startsWith(">") ||
        value.startsWith("@") ||
        value.startsWith("`") ||
        /^(true|false|null|yes|no|on|off)$/i.test(value) ||
        /^-?\d+(\.\d+)?$/.test(value)
    ) {
        return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
}

function scalarLine(value: any): string {
    if (typeof value === "string") return yamlScalar(value);
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number") return String(value);
    return JSON.stringify(value);
}

function isScalar(value: any): boolean {
    return (
        value === null ||
        value === undefined ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    );
}

/** Emit lines for an array or object value at the given indent depth. */
function emitBlock(value: any, indent: number): string[] {
    const pad = "  ".repeat(indent);
    if (Array.isArray(value)) {
        if (value.length === 0) return [];
        const lines: string[] = [];
        for (const item of value) {
            if (item === null || item === undefined) continue;
            if (isScalar(item)) {
                lines.push(`${pad}- ${scalarLine(item)}`);
            } else if (Array.isArray(item)) {
                lines.push(`${pad}-`);
                lines.push(...emitBlock(item, indent + 1));
            } else {
                // object item — dash + first key inline; remaining keys indented
                const entries = Object.entries(item).filter(
                    ([, v]) => v !== undefined && v !== null,
                );
                if (entries.length === 0) {
                    lines.push(`${pad}- {}`);
                    continue;
                }
                const [firstKey, firstVal] = entries[0];
                if (isScalar(firstVal)) {
                    lines.push(`${pad}- ${firstKey}: ${scalarLine(firstVal)}`);
                } else {
                    lines.push(`${pad}- ${firstKey}:`);
                    lines.push(...emitBlock(firstVal, indent + 1));
                }
                const childPad = "  ".repeat(indent + 1);
                for (let i = 1; i < entries.length; i++) {
                    const [k, v] = entries[i];
                    if (isScalar(v)) {
                        lines.push(`${childPad}${k}: ${scalarLine(v)}`);
                    } else if (
                        (Array.isArray(v) && v.length === 0) ||
                        (typeof v === "object" && v !== null && Object.keys(v).length === 0)
                    ) {
                        // skip empty collections inside object items
                        continue;
                    } else {
                        lines.push(`${childPad}${k}:`);
                        lines.push(...emitBlock(v, indent + 2));
                    }
                }
            }
        }
        return lines;
    }
    if (value !== null && typeof value === "object") {
        const lines: string[] = [];
        for (const [k, v] of Object.entries(value)) {
            if (v === undefined || v === null) continue;
            if (isScalar(v)) {
                lines.push(`${pad}${k}: ${scalarLine(v)}`);
            } else if (Array.isArray(v)) {
                if (v.length === 0) continue;
                lines.push(`${pad}${k}:`);
                lines.push(...emitBlock(v, indent + 1));
            } else {
                if (Object.keys(v).length === 0) continue;
                lines.push(`${pad}${k}:`);
                lines.push(...emitBlock(v, indent + 1));
            }
        }
        return lines;
    }
    // Shouldn't reach here — scalars handled by caller
    return [`${pad}${scalarLine(value)}`];
}

function serializeFrontMatter(fm: Record<string, any>): string {
    const lines: string[] = ["---"];
    for (const [key, value] of Object.entries(fm)) {
        if (value === undefined || value === null) continue;
        if (isScalar(value)) {
            lines.push(`${key}: ${scalarLine(value)}`);
        } else if (Array.isArray(value)) {
            if (value.length === 0) continue;
            lines.push(`${key}:`);
            lines.push(...emitBlock(value, 1));
        } else {
            if (Object.keys(value).length === 0) continue;
            lines.push(`${key}:`);
            lines.push(...emitBlock(value, 1));
        }
    }
    lines.push("---");
    return lines.join("\n");
}

// ── Body transformation ────────────────────────────────────────────

// ── Nested path helper ────────────────────────────────────────────

/**
 * Resolve a dot-notation path against a nested object.
 * e.g., getNestedValue(fm, "name.full") → fm.name.full
 */
function getNestedValue(obj: Record<string, any>, dotPath: string): any {
    const parts = dotPath.split(".");
    let current: any = obj;
    for (const part of parts) {
        if (current == null || typeof current !== "object") return undefined;
        current = current[part];
    }
    return current;
}

// ── Dataview query resolution ──────────────────────────────────────

/**
 * Resolve Dataview LIST queries into markdown lists.
 *
 * Supports a subset of the Dataview query language:
 *   LIST [field]
 *   FROM #tag | FROM "Folder"
 *   WHERE condition (simple equality/contains)
 *   SORT file.name ASC|DESC
 *
 * Only publishable entries are included in results.
 */
function resolveDataviewQueries(
    body: string,
    entries: VaultEntry[],
    lookup: Map<string, LookupEntry>,
    verbose: boolean,
): string {
    // Match ```dataview ... ``` blocks
    return body.replace(
        /```dataview\s*\n([\s\S]*?)```/g,
        (_match, queryBlock: string) => {
            const query = queryBlock.trim();
            if (verbose) {
                console.log(`    Resolving dataview query: ${query.substring(0, 80)}...`);
            }

            // Normalize query into clauses by splitting on keywords.
            // Handles both single-line and multi-line queries:
            //   LIST this["name.full"] FROM #animal SORT file.name ASC
            //   LIST this["name.full"]
            //   FROM #animal
            //   SORT file.name ASC
            const normalized = query.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

            const listMatch = normalized.match(/^LIST\s+(.*?)(?=\s+(?:FROM|WHERE|SORT)\s|$)/i);
            const tableMatch = normalized.match(/^TABLE(\s+WITHOUT\s+ID)?\s+(.*?)(?=\s+(?:FROM|WHERE|SORT)\s|$)/i);

            if (!listMatch && !tableMatch) {
                if (verbose) console.warn(`    Unsupported dataview query type: ${normalized.substring(0, 40)}`);
                return _match;
            }

            const isTable = !!tableMatch;
            const tableWithoutId = !!(tableMatch && tableMatch[1]);
            let displayField = listMatch ? listMatch[1]?.trim() || "" : "";
            let tableColumnsRaw = tableMatch ? tableMatch[2]?.trim() || "" : "";
            let fromClause = "";
            let whereClause = "";
            let sortFields: Array<{ field: string; dir: "ASC" | "DESC" }> = [
                { field: "file.name", dir: "ASC" },
            ];

            const fromMatch = normalized.match(/\bFROM\s+(.*?)(?=\s+(?:WHERE|SORT)\s|$)/i);
            const whereMatch = normalized.match(/\bWHERE\s+(.*?)(?=\s+(?:SORT)\s|$)/i);
            const sortMatch = normalized.match(/\bSORT\s+(.+?)$/i);

            if (fromMatch) fromClause = fromMatch[1].trim();
            if (whereMatch) whereClause = whereMatch[1].trim();
            if (sortMatch) {
                // Parse multi-field sort: "thalorna.realm, file.name ASC"
                const sortExpr = sortMatch[1].trim();
                const trailingDirMatch = sortExpr.match(/^(.*?)\s+(ASC|DESC)\s*$/i);
                let sortBody = sortExpr;
                let defaultDir: "ASC" | "DESC" = "ASC";
                if (trailingDirMatch) {
                    sortBody = trailingDirMatch[1].trim();
                    defaultDir = trailingDirMatch[2].toUpperCase() as "ASC" | "DESC";
                }
                sortFields = sortBody.split(",").map((piece) => {
                    const p = piece.trim();
                    const withDir = p.match(/^(.+?)\s+(ASC|DESC)$/i);
                    if (withDir) {
                        return {
                            field: withDir[1].trim(),
                            dir: withDir[2].toUpperCase() as "ASC" | "DESC",
                        };
                    }
                    return { field: p, dir: defaultDir };
                });
            }

            // Filter entries
            let filtered = entries.slice();

            // FROM #tag
            if (fromClause) {
                const tagMatch = fromClause.match(/^#(\S+)$/);
                const folderMatch = fromClause.match(/^"([^"]+)"$/);

                if (tagMatch) {
                    const tag = tagMatch[1].toLowerCase();
                    filtered = filtered.filter((e) => {
                        const tags = e.frontmatter.tags;
                        if (!Array.isArray(tags)) return false;
                        return tags.some(
                            (t: string) => t.toLowerCase() === tag,
                        );
                    });
                } else if (folderMatch) {
                    const folder = folderMatch[1];
                    filtered = filtered.filter((e) =>
                        e.filepath.includes(`/${folder}/`),
                    );
                }
            }

            // WHERE (simple support: field = "value" or contains(field, "value"))
            if (whereClause) {
                const eqMatch = whereClause.match(
                    /^(\S+)\s*=\s*"([^"]+)"$/,
                );
                const containsMatch = whereClause.match(
                    /^contains\((\S+),\s*"([^"]+)"\)$/i,
                );

                if (eqMatch) {
                    const [, field, value] = eqMatch;
                    filtered = filtered.filter(
                        (e) =>
                            String(
                                getNestedValue(e.frontmatter, field) ?? "",
                            ).toLowerCase() === value.toLowerCase(),
                    );
                } else if (containsMatch) {
                    const [, field, value] = containsMatch;
                    filtered = filtered.filter((e) => {
                        const fv = getNestedValue(e.frontmatter, field);
                        if (Array.isArray(fv))
                            return fv.some(
                                (v: string) =>
                                    String(v)
                                        .toLowerCase()
                                        .includes(value.toLowerCase()),
                            );
                        return String(fv ?? "")
                            .toLowerCase()
                            .includes(value.toLowerCase());
                    });
                }
            }

            // Multi-field sort
            const fieldValueForSort = (e: VaultEntry, field: string): string => {
                if (field === "file.name") return e.stem.toLowerCase();
                if (field === "file.link") return e.stem.toLowerCase();
                const v = getNestedValue(e.frontmatter, field);
                return String(v ?? "").toLowerCase();
            };
            filtered.sort((a, b) => {
                for (const { field, dir } of sortFields) {
                    const aVal = fieldValueForSort(a, field);
                    const bVal = fieldValueForSort(b, field);
                    const cmp = aVal.localeCompare(bVal);
                    if (cmp !== 0) return dir === "DESC" ? -cmp : cmp;
                }
                return 0;
            });

            if (verbose) {
                console.log(`    Dataview query matched ${filtered.length} entries`);
            }

            if (filtered.length === 0) {
                return "*No matching entries.*\n";
            }

            // ── TABLE output ────────────────────────────────────────
            if (isTable) {
                // Parse columns from tableColumnsRaw.
                // Handles commas inside parens by tracking depth.
                const splitColumns = (raw: string): string[] => {
                    const parts: string[] = [];
                    let depth = 0;
                    let cur = "";
                    for (const ch of raw) {
                        if (ch === "(") depth++;
                        else if (ch === ")") depth--;
                        if (ch === "," && depth === 0) {
                            parts.push(cur.trim());
                            cur = "";
                        } else {
                            cur += ch;
                        }
                    }
                    if (cur.trim()) parts.push(cur.trim());
                    return parts;
                };

                type Col = { expr: string; header: string };
                const columns: Col[] = splitColumns(tableColumnsRaw).map((piece) => {
                    const asMatch = piece.match(/^(.+?)\s+AS\s+"([^"]+)"\s*$/i);
                    if (asMatch) {
                        return { expr: asMatch[1].trim(), header: asMatch[2] };
                    }
                    return { expr: piece.trim(), header: piece.trim() };
                });

                const resolveCell = (e: VaultEntry, expr: string): string => {
                    // link(file.link, display_field) — render as markdown link
                    const linkMatch = expr.match(/^link\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/i);
                    if (linkMatch) {
                        const displayExpr = linkMatch[2].trim();
                        const displayVal = resolveCell(e, displayExpr) || e.title;
                        const lookupEntry = lookup.get(e.stem);
                        if (lookupEntry) {
                            return `[${displayVal}](${lookupEntry.url})`;
                        }
                        return displayVal;
                    }
                    // file.link → same as bare link
                    if (expr === "file.link") {
                        const lookupEntry = lookup.get(e.stem);
                        if (lookupEntry) {
                            return `[${e.title}](${lookupEntry.url})`;
                        }
                        return e.title;
                    }
                    if (expr === "file.name") return e.stem;
                    // Bracket notation this["foo.bar"]
                    const bracket = expr.match(/^this\["([^"]+)"\]$/);
                    const field = bracket ? bracket[1] : expr;
                    const v = getNestedValue(e.frontmatter, field);
                    if (v == null) return "";
                    if (Array.isArray(v)) return v.join(", ");
                    return String(v);
                };

                // Build markdown table
                const headers = columns.map((c) => c.header);
                const headerRow = `| ${headers.join(" | ")} |`;
                const separator = `| ${headers.map(() => "---").join(" | ")} |`;
                const dataRows = filtered.map((e) => {
                    const cells = columns.map((c) =>
                        resolveCell(e, c.expr).replace(/\|/g, "\\|"),
                    );
                    return `| ${cells.join(" | ")} |`;
                });
                // tableWithoutId suppresses the "File" column that dataview normally adds;
                // since we only render declared columns, the flag is effectively honored already.
                void tableWithoutId;
                return [headerRow, separator, ...dataRows].join("\n") + "\n";
            }

            // ── LIST output ─────────────────────────────────────────
            // Clean up display field — handle this["name.full"] → name.full
            const bracketFieldMatch = displayField.match(
                /^this\["([^"]+)"\]$/,
            );
            const resolvedField = bracketFieldMatch
                ? bracketFieldMatch[1]
                : displayField;

            // Build markdown list
            const listItems = filtered.map((e) => {
                let display = e.title;
                if (resolvedField) {
                    const fieldVal = getNestedValue(e.frontmatter, resolvedField);
                    if (fieldVal) display = String(fieldVal);
                }

                const lookupEntry = lookup.get(e.stem);
                if (lookupEntry) {
                    return `- [${display}](${lookupEntry.url})`;
                }
                return `- ${display}`;
            });

            return listItems.join("\n") + "\n";
        },
    );
}

/**
 * Rewrite Obsidian-flavored Markdown to Hugo-compatible Markdown.
 */
function transformBody(
    body: string,
    entries: VaultEntry[],
    lookup: Map<string, LookupEntry>,
    verbose: boolean,
): string {
    // Resolve dataview queries first (before wikilink rewriting)
    let result = resolveDataviewQueries(body, entries, lookup, verbose);

    // Rewrite image embeds: ![[foo.webp]] → ![foo](https://cdn.heroiclands.org/images/foo.webp)
    // The actual files live on the CDN; the export pipeline doesn't bundle them.
    result = result.replace(/!\[\[([^\]]+)\]\]/g, (_match, filename: string) => {
        const basename = path.parse(filename).name;
        return `![${basename}](${IMAGE_CDN_BASE}/${filename})`;
    });

    // Rewrite wikilinks with display text: [[Target|Display]] → [Display](/url/)
    result = result.replace(
        /\[\[([^\]|]+)\|([^\]]+)\]\]/g,
        (_match, target: string, display: string) => {
            const entry = lookup.get(target.trim());
            if (entry) {
                return `[${display.trim()}](${entry.url})`;
            }
            if (verbose) {
                console.warn(`  Unresolved wikilink: [[${target}|${display}]]`);
            }
            // Leave as plain text if target isn't publishable
            return display.trim();
        },
    );

    // Rewrite plain wikilinks: [[Target]] → [Title](/url/)
    result = result.replace(
        /\[\[([^\]|]+)\]\]/g,
        (_match, target: string) => {
            const entry = lookup.get(target.trim());
            if (entry) {
                return `[${entry.title}](${entry.url})`;
            }
            if (verbose) {
                console.warn(`  Unresolved wikilink: [[${target}]]`);
            }
            // Leave as plain text if target isn't publishable
            return target.trim().replace(/_/g, " ");
        },
    );

    return result;
}

// ── File output ────────────────────────────────────────────────────

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function writeHugoFile(
    entry: VaultEntry,
    hugoFm: Record<string, any>,
    transformedBody: string,
    dryRun: boolean,
): string {
    const outPath = entry.outputPath;

    if (dryRun) {
        console.log(`  Would write: ${outPath}`);
        return outPath;
    }

    ensureDir(path.dirname(outPath));
    const content = serializeFrontMatter(hugoFm) + "\n" + transformedBody;
    fs.writeFileSync(outPath, content, "utf-8");
    return outPath;
}

// ── Clean stale files ──────────────────────────────────────────────

function cleanStaleFiles(
    entries: VaultEntry[],
    dryRun: boolean,
    verbose: boolean,
): void {
    // Build set of expected output paths (both regular entries and _index files).
    const expectedFiles = new Set<string>();
    for (const entry of entries) {
        expectedFiles.add(entry.outputPath);
    }

    // Walk each bucket's Hugo output tree and remove any .md files
    // that aren't in the expected set. This catches files from deleted
    // vault entries, renamed slugs, etc.
    const bucketRoots = new Set<string>();
    for (const bucket of BUCKETS) {
        // Use only the top-level segment of hugoPath as the clean root,
        // so buckets like "project/sohl" don't cause us to walk the
        // "project/" tree once per sub-bucket.
        const topSegment = bucket.hugoPath.split("/")[0];
        bucketRoots.add(path.join(HUGO_CONTENT, topSegment));
    }

    function walkClean(dir: string) {
        if (!fs.existsSync(dir)) return;
        const dirEntries = fs.readdirSync(dir, { withFileTypes: true });
        for (const de of dirEntries) {
            const fullPath = path.join(dir, de.name);
            if (de.isDirectory()) {
                walkClean(fullPath);
            } else if (de.name.endsWith(".md")) {
                if (!expectedFiles.has(fullPath)) {
                    if (dryRun) {
                        console.log(`  Would remove stale: ${fullPath}`);
                    } else {
                        fs.unlinkSync(fullPath);
                        if (verbose) {
                            console.log(`  Removed stale: ${fullPath}`);
                        }
                    }
                }
            }
        }
    }

    for (const root of bucketRoots) {
        walkClean(root);
    }
}

// ── Main ───────────────────────────────────────────────────────────

function main(): void {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const verbose = args.includes("--verbose");

    if (dryRun) {
        console.log("=== DRY RUN (no files will be written) ===\n");
    }

    console.log("Scanning vault...");
    const entries = scanVault(verbose);

    if (entries.length === 0) {
        console.log("No publishable files found.");
        return;
    }

    console.log(`\nBuilding lookup map (${entries.length} entries)...`);
    const lookup = buildLookupMap(entries);

    let filesWritten = 0;

    console.log("\nExporting files...");
    for (const entry of entries) {
        if (verbose) {
            console.log(`\n  Processing: ${entry.stem}`);
        }

        // Transform front matter
        const hugoFm = transformFrontMatter(entry.frontmatter);

        // Transform body
        const transformedBody = transformBody(
            entry.body,
            entries,
            lookup,
            verbose,
        );

        // Write Hugo file
        writeHugoFile(entry, hugoFm, transformedBody, dryRun);
        filesWritten++;
    }

    // Clean stale files
    console.log("\nCleaning stale files...");
    cleanStaleFiles(entries, dryRun, verbose);

    console.log(`\n✓ Done. ${filesWritten} files exported.`);
}

main();
