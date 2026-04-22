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
    "affliction",
    "armorgear",
    "blog-post",
    "character",
    "concoctiongear",
    "containergear",
    "continent",
    "creature",
    "domain",
    "faith",
    "religion",
    "language",
    "lore",
    "miscgear",
    "mystery",
    "mysticalability",
    "organization",
    "page",
    "pantheon",
    "people",
    "polity",
    "project-page",
    "projectilegear",
    "region",
    "settlement",
    "site",
    "skill",
    "trait",
    "type-catalog",
    "weapongear",
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
    { vaultPrefix: "Types/",                              hugoPath: "types",                routing: "flat"    },
    { vaultPrefix: "Projects/Song_of_Heroic_Lands/",      hugoPath: "project/sohl",         routing: "flat"    },
    { vaultPrefix: "Projects/HM3/",                       hugoPath: "project/hm3",          routing: "flat"    },
    { vaultPrefix: "Projects/Modules/",                   hugoPath: "project/modules",      routing: "flat"    },
    { vaultPrefix: "Projects/Systems/Characteristics/",   hugoPath: "project/characteristics", routing: "by-type" },
    { vaultPrefix: "Projects/Systems/Domains/",           hugoPath: "project/domain",       routing: "flat"    },
    { vaultPrefix: "Projects/Systems/Possessions/",       hugoPath: "project/possessions",  routing: "by-type" },
    { vaultPrefix: "Projects/",                           hugoPath: "project",              routing: "flat"    },
    { vaultPrefix: "Worlds/Thalorna/",                    hugoPath: "cosmos",               routing: "by-type" },
    { vaultPrefix: "Blog/",                               hugoPath: "blog",                 routing: "by-date" },
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
    /** Content type, e.g. "character", "region" */
    type: ContentType;
}

/**
 * A reference in the wikilink graph — minimal info needed to render
 * a "Related" list item at the bottom of a page.
 */
interface RelatedRef {
    title: string;
    url: string;
    type: ContentType;
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
            type: entry.type,
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

// ── Mystical-ability index ─────────────────────────────────────────

/**
 * Per-shortcode indexes for mystical-ability resolution.
 *
 * Characters and creatures reference spells, arcane talents, and the
 * domains those spells belong to by shortcode inside `sohl.items[]`.
 * Building dedicated shortcode-keyed maps (rather than reusing the
 * wikilink `lookup` map, which is keyed by stem/alias/name) lets the
 * exporter resolve those references without ambiguity and independent
 * of what stems authors happen to use.
 *
 * Only publishable entries are indexed, so an unpublished spell/talent/
 * domain gracefully falls back to rendering just the shortcode. Later
 * duplicate shortcodes in the same category are ignored so the first
 * published definition wins (noisy, but non-fatal).
 */
interface MysticalRef {
    title: string;
    url: string;
    /** For spells: the `sohl.<pantheon>.<domain>` code; null for talents. */
    domainCode: string | null;
}

interface DomainRef {
    title: string;
    url: string;
    shortcode: string;
}

interface MysticalIndex {
    spells: Map<string, MysticalRef>;
    talents: Map<string, MysticalRef>;
    domains: Map<string, DomainRef>;
}

/**
 * A catalog entry for a piece of gear — just enough for a sidebar to
 * render a readable name and (when published) link back to the item page.
 */
interface GearRef {
    title: string;
    url: string;
    /** Content type so we know which gear bucket this belongs to. */
    type: ContentType;
}

/**
 * Shortcode → GearRef, shared across every gear subtype. The shortcode
 * namespace is globally unique in practice (HAxe, WCoat, bktlrg, …) so a
 * single map keeps the lookup fast and the API simple; the `type` on each
 * ref disambiguates weapons vs. armor vs. containers if a caller needs it.
 */
type GearIndex = Map<string, GearRef>;

function buildMysticalIndex(entries: VaultEntry[]): MysticalIndex {
    const spells = new Map<string, MysticalRef>();
    const talents = new Map<string, MysticalRef>();
    const domains = new Map<string, DomainRef>();

    for (const entry of entries) {
        const fm = entry.frontmatter;
        const shortcode =
            typeof fm.shortcode === "string" ? fm.shortcode : null;
        if (!shortcode) continue;

        if (entry.type === "mysticalability") {
            const subType = typeof fm.subType === "string" ? fm.subType : "";
            const domainCode =
                typeof fm.domainCode === "string" ? fm.domainCode : null;
            const ref: MysticalRef = {
                title: entry.title,
                url: entry.url,
                domainCode,
            };
            if (subType === "arcaneincantation" && !spells.has(shortcode)) {
                spells.set(shortcode, ref);
            } else if (subType === "arcanetalent" && !talents.has(shortcode)) {
                talents.set(shortcode, ref);
            }
        } else if (entry.type === "domain") {
            if (!domains.has(shortcode)) {
                domains.set(shortcode, {
                    title: entry.title,
                    url: entry.url,
                    shortcode,
                });
            }
        }
    }

    return { spells, talents, domains };
}

/**
 * Build a shortcode → {title, url, type} map for every published gear
 * entry (weapons, armor, miscgear, containers, projectiles, concoctions).
 *
 * The vault stores each gear item as its own note with a `shortcode`
 * frontmatter field (e.g. HAxe, WCoat, bktlrg). Characters reference
 * items by shortcode inside `sohl.items[]`; the sidebar renders the
 * friendly name from this index rather than the shortcode.
 *
 * Duplicate shortcodes ignored — first published definition wins, which
 * is acceptably stable since the Foundry-VTT data uses unique shortcodes.
 */
function buildGearIndex(entries: VaultEntry[]): GearIndex {
    const gear: GearIndex = new Map();
    const GEAR_TYPES: ContentType[] = [
        "weapongear",
        "armorgear",
        "miscgear",
        "containergear",
        "projectilegear",
        "concoctiongear",
    ];
    for (const entry of entries) {
        if (!GEAR_TYPES.includes(entry.type)) continue;
        const shortcode = entry.frontmatter.shortcode;
        if (typeof shortcode !== "string" || !shortcode) continue;
        if (gear.has(shortcode)) continue;
        gear.set(shortcode, {
            title: entry.title,
            url: entry.url,
            type: entry.type,
        });
    }
    return gear;
}

/**
 * Resolve a domainCode like "sohl.hexhodai.physera" to the last segment,
 * which by convention is the domain's own shortcode.
 */
function domainShortcodeFromCode(code: string | null | undefined): string | null {
    if (!code || typeof code !== "string") return null;
    const idx = code.lastIndexOf(".");
    const sc = idx === -1 ? code : code.slice(idx + 1);
    return sc.trim() || null;
}

// ── Wikilink graph ─────────────────────────────────────────────────

/**
 * Build a bidirectional wikilink graph across all entries.
 *
 * Returns two maps keyed by entry URL:
 *   - backlinks: for each page, the list of OTHER pages that link to it
 *   - mentions:  for each page, the list of OTHER pages it links to
 *
 * Image embeds (`![[...]]`) are excluded. Self-links are excluded.
 * Each (source, target) pair is counted at most once per direction.
 * Both lists are sorted alphabetically by title.
 *
 * The exporter injects these lists into frontmatter (`related.backlinks`
 * and `related.mentions`) so layouts can render a "Related" section
 * at the bottom of each page without re-parsing content.
 */
interface LinkGraph {
    backlinks: Map<string, RelatedRef[]>;
    mentions: Map<string, RelatedRef[]>;
}

/**
 * Resolve a wikilink target against the lookup map.
 *
 * Tries the full target first; if that misses and the target contains path
 * separators, falls back to the last path segment (its basename). This
 * mirrors Obsidian's own behavior, which accepts path-form targets like
 * `[[Worlds/Thalorna/Creatures/Creatures]]` and resolves them by filename.
 *
 * Used by both the wikilink-rewriter and the backlink-graph builder so they
 * agree on what resolves.
 */
function resolveWikilinkTarget(
    target: string,
    lookup: Map<string, LookupEntry>,
): LookupEntry | undefined {
    const trimmed = target.trim();
    const direct = lookup.get(trimmed);
    if (direct) return direct;
    const slashIdx = trimmed.lastIndexOf("/");
    if (slashIdx === -1) return undefined;
    const basename = trimmed.slice(slashIdx + 1);
    return basename ? lookup.get(basename) : undefined;
}

function buildLinkGraph(
    entries: VaultEntry[],
    lookup: Map<string, LookupEntry>,
): LinkGraph {
    const backlinks = new Map<string, RelatedRef[]>();
    const mentions = new Map<string, RelatedRef[]>();

    // Match [[Target]] or [[Target|Display]] but NOT ![[image]] embeds.
    // The negative lookbehind keeps the image-embed syntax out.
    const wikilinkRe = /(?<!!)\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

    for (const entry of entries) {
        const sourceRef: RelatedRef = {
            title: entry.title,
            url: entry.url,
            type: entry.type,
        };
        const seenTargets = new Set<string>();
        let match: RegExpExecArray | null;
        wikilinkRe.lastIndex = 0;
        while ((match = wikilinkRe.exec(entry.body)) !== null) {
            const rawTarget = match[1].trim();
            const targetLookup = resolveWikilinkTarget(rawTarget, lookup);
            if (!targetLookup) continue;
            if (targetLookup.url === entry.url) continue;
            if (seenTargets.has(targetLookup.url)) continue;
            seenTargets.add(targetLookup.url);

            const targetRef: RelatedRef = {
                title: targetLookup.title,
                url: targetLookup.url,
                type: targetLookup.type,
            };

            // Forward: source mentions target
            const fwd = mentions.get(entry.url) ?? [];
            fwd.push(targetRef);
            mentions.set(entry.url, fwd);

            // Back: target is linked from source
            const back = backlinks.get(targetLookup.url) ?? [];
            back.push(sourceRef);
            backlinks.set(targetLookup.url, back);
        }
    }

    // Sort each list by title for stable output.
    const byTitle = (a: RelatedRef, b: RelatedRef) =>
        a.title.localeCompare(b.title);
    for (const list of backlinks.values()) list.sort(byTitle);
    for (const list of mentions.values()) list.sort(byTitle);

    return { backlinks, mentions };
}

// ── Front matter transformation ────────────────────────────────────

/** Fields to carry over to Hugo front matter */
const HUGO_FIELDS: Record<string, (fm: Record<string, any>) => any> = {
    title: (fm) => fm.name?.full || fm.title || "",
    slug: (fm) => fm.slug || undefined,
    description: (fm) => {
        // Description is a first-class authored field in the universal
        // frontmatter schema. Pass through verbatim when present; when absent,
        // leave the page with no description (the hero-banner tagline
        // disappears rather than falling back to the note type).
        if (typeof fm.description === "string" && fm.description.trim()) {
            return fm.description;
        }
        return undefined;
    },
    type: (fm) => fm.type?.toLowerCase(),
    tags: (fm) => fm.tags || [],
    // Blog-post specific fields. Passed through verbatim so Hugo's
    // .Params.date / .Params.series (and date-based sort) work.
    date: (fm) => fm.date || undefined,
    series: (fm) => fm.series || undefined,
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
    sohl: (fm) => transformSohl(fm.sohl),

    // ── Gear-specific top-level fields ─────────────────────────────
    // These live at the top level of gear frontmatter (mirroring the
    // Foundry system's Item document shape). Passed through so the gear
    // sidebar can render weapon stats, armor stats, strike-modes, etc.
    // Other content types don't set these and will silently emit undefined.
    weaponType: (fm) => fm.weaponType || undefined,
    length: (fm) => (typeof fm.length === "number" ? fm.length : undefined),
    strikeModes: (fm) => fm.strikeModes || undefined,
    armorType: (fm) => fm.armorType || undefined,
    detailMaterial: (fm) => fm.detailMaterial || undefined,
    material: (fm) => fm.material || undefined,
};

/**
 * Transform the `sohl` block for Hugo consumption.
 *
 * The vault's canonical format stores skills and gear as tagged objects
 * inside `sohl.items[]` (each with `shortcode`, `type`, and type-specific
 * payload fields — e.g. skill items carry `"system.masteryLevelBase"`,
 * gear items carry `type: weapongear | armorgear | miscgear | containergear`).
 *
 * The Hugo sidebars still read `.Params.sohl.skills` as a flat
 * `shortcode → score` map (and similar grouped gear arrays may be added in
 * future). To keep layouts unchanged while the source-of-truth format
 * evolves, derive the legacy shapes here from `sohl.items`:
 *   - sohl.skills:       { shortcode: masteryLevelBase } for type:skill items
 *   - sohl.gear.weapons: [shortcode|name] for type:weapongear
 *   - sohl.gear.armor:   [shortcode|name] for type:armorgear
 *   - sohl.gear.misc:    [shortcode|name] for type:miscgear
 *   - sohl.gear.containers: [shortcode|name] for type:containergear
 *
 * `sohl.items` itself is passed through verbatim so future layouts can
 * read the richer per-item system fields (weight, quantity, durability, …)
 * without another export change.
 *
 * Derived fields only populate when missing from the source, so any
 * hand-authored `sohl.skills` or `sohl.gear.*` still wins (useful during
 * migration while a few notes may retain the legacy shape).
 */
function transformSohl(sohl: any): Record<string, any> | undefined {
    if (!sohl || typeof sohl !== "object") return undefined;
    const out: Record<string, any> = { ...sohl };

    if (!Array.isArray(out.items) || out.items.length === 0) {
        return out;
    }

    // Derive skills map if absent.
    const hasSkillsMap =
        out.skills && typeof out.skills === "object" &&
        !Array.isArray(out.skills) && Object.keys(out.skills).length > 0;
    if (!hasSkillsMap) {
        const skills: Record<string, number> = {};
        for (const item of out.items) {
            if (!item || typeof item !== "object") continue;
            if (item.type !== "skill") continue;
            const shortcode = item.shortcode;
            // Foundry-style flat key: `"system.masteryLevelBase": N`.
            // YAML quoting preserves the dot-laden key as a single string,
            // not a nested `system.masteryLevelBase` object.
            const level = (item as Record<string, any>)["system.masteryLevelBase"];
            if (typeof shortcode === "string" && typeof level === "number") {
                skills[shortcode] = level;
            }
        }
        if (Object.keys(skills).length > 0) {
            out.skills = skills;
        }
    }

    // Gear derivation moved to deriveSohlGear (post-pass) — it needs the
    // vault-wide gear index to resolve shortcodes to display names + URLs,
    // which isn't available here. `items` itself passes through verbatim.

    return out;
}

/**
 * Gear category keys used on the emitted `sohl.gear` dict. Ordering here
 * matches the order sidebars should render groups in.
 */
const GEAR_TYPE_TO_KEY: Record<string, string> = {
    weapongear: "weapons",
    armorgear: "armor",
    projectilegear: "projectiles",
    miscgear: "misc",
    containergear: "containers",
    concoctiongear: "concoctions",
};

/**
 * Augment an already-transformed sohl block with resolved gear lists
 * derived from `sohl.items[]` using the vault-wide gear index.
 *
 * Emits `sohl.gear.{weapons, armor, projectiles, misc, containers,
 * concoctions}` as arrays of objects:
 *
 *   { name: "Handaxe", shortcode: "HAxe", url: "/project/possessions/weapongear/handaxe/" }
 *
 * Resolution rules:
 *   - If the item has an inline `name`, it wins (homebrew / freeform
 *     items like "Carpenter's toolbox" that don't appear in the gear
 *     catalog still render readably).
 *   - Otherwise, look up the item's `shortcode` in the gear index and
 *     take its `title` and `url`. Both are copied to the emitted entry.
 *   - If neither resolves — no inline name and no catalog hit — fall back
 *     to the raw shortcode as the name so the item still surfaces (better
 *     than silently dropping it).
 *
 * Existing hand-authored `sohl.gear.*` arrays are left alone (useful for
 * edge cases and during migration).
 */
function deriveSohlGear(
    sohl: Record<string, any> | undefined,
    index: GearIndex,
): void {
    if (!sohl || typeof sohl !== "object") return;
    const items = sohl.items;
    if (!Array.isArray(items) || items.length === 0) return;

    const existingGear =
        sohl.gear && typeof sohl.gear === "object" && !Array.isArray(sohl.gear)
            ? sohl.gear
            : null;

    const derived: Record<string, Array<Record<string, string>>> = {};
    for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const it = item as Record<string, any>;
        const key = GEAR_TYPE_TO_KEY[it.type];
        if (!key) continue;

        const shortcode = typeof it.shortcode === "string" ? it.shortcode : null;
        const inlineName = typeof it.name === "string" ? it.name : null;
        const ref = shortcode ? index.get(shortcode) : undefined;

        const name = inlineName ?? ref?.title ?? shortcode;
        if (!name) continue;

        const entry: Record<string, string> = { name };
        if (shortcode) entry.shortcode = shortcode;
        if (ref?.url) entry.url = ref.url;
        (derived[key] ??= []).push(entry);
    }

    if (Object.keys(derived).length === 0) return;

    const gear: Record<string, any> = existingGear ? { ...existingGear } : {};
    for (const [key, values] of Object.entries(derived)) {
        const existing = gear[key];
        if (Array.isArray(existing) && existing.length > 0) continue;
        gear[key] = values;
    }
    sohl.gear = gear;
}

/**
 * Augment an already-transformed sohl block with resolved mystical-ability
 * lists, derived from `sohl.items[]` using the vault-wide shortcode index.
 *
 *   - type=mysticalability, subType=arcaneincantation  →  sohl.spells
 *     Each entry is `{ name, domain?, url?, domain_url? }`, where `name` is
 *     the spell's `name.full`, `domain` is the owning domain's `name.full`,
 *     and `url` / `domain_url` point to the rendered pages (when published).
 *
 *   - type=mysticalability, subType=arcanetalent       →  sohl.talents
 *     Each entry is `{ name, url? }`.
 *
 * Sidebars render `sohl.spells` as `Domain/Spell` lines and `sohl.talents`
 * as plain names. An item's inline `name` wins over the shortcode lookup,
 * which is useful for homebrew abilities that don't have a catalog entry.
 * If the shortcode resolves to nothing and no inline `name` exists, the
 * item is dropped rather than leaking the raw shortcode.
 *
 * Mutates `sohl` in place (consistent with the caller's post-pass pattern)
 * and leaves existing hand-authored `sohl.spells` / `sohl.talents` alone.
 */
function deriveSohlMysticals(
    sohl: Record<string, any> | undefined,
    index: MysticalIndex,
): void {
    if (!sohl || typeof sohl !== "object") return;
    const items = sohl.items;
    if (!Array.isArray(items) || items.length === 0) return;

    const hasArrayAlready = (key: string): boolean =>
        Array.isArray(sohl[key]) && sohl[key].length > 0;

    const spells: Array<Record<string, string>> = [];
    const talents: Array<Record<string, string>> = [];

    for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const it = item as Record<string, any>;
        if (it.type !== "mysticalability") continue;

        const shortcode = typeof it.shortcode === "string" ? it.shortcode : null;
        const inlineName = typeof it.name === "string" ? it.name : null;

        if (it.subType === "arcaneincantation") {
            const ref = shortcode ? index.spells.get(shortcode) : undefined;
            const name = inlineName ?? ref?.title ?? null;
            if (!name) continue;

            // Domain resolution: item may supply a `domainCode` override, or
            // we fall back to the spell catalog entry's domainCode.
            const domainCode: string | null =
                typeof it.domainCode === "string"
                    ? it.domainCode
                    : ref?.domainCode ?? null;
            const domainShortcode = domainShortcodeFromCode(domainCode);
            const domain = domainShortcode
                ? index.domains.get(domainShortcode)
                : undefined;

            const entry: Record<string, string> = { name };
            if (ref?.url) entry.url = ref.url;
            if (domain) {
                entry.domain = domain.title;
                entry.domain_url = domain.url;
            } else if (domainShortcode) {
                // Unpublished domain — expose the shortcode so layouts can
                // still show *something* meaningful ("physera/Wither").
                entry.domain = domainShortcode;
            }
            spells.push(entry);
        } else if (it.subType === "arcanetalent") {
            const ref = shortcode ? index.talents.get(shortcode) : undefined;
            const name = inlineName ?? ref?.title ?? null;
            if (!name) continue;
            const entry: Record<string, string> = { name };
            if (ref?.url) entry.url = ref.url;
            talents.push(entry);
        }
    }

    if (spells.length > 0 && !hasArrayAlready("spells")) {
        sohl.spells = spells;
    }
    if (talents.length > 0 && !hasArrayAlready("talents")) {
        sohl.talents = talents;
    }
}

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

/**
 * Look up a field value for Dataview WHERE/SORT evaluation.
 *
 * Handles Dataview's `file.*` special fields (name, link, path, tags) and
 * falls back to dot-path lookup on the frontmatter for everything else.
 * `file.tags` returns the frontmatter tags prefixed with "#", matching
 * Dataview's own convention so that queries like
 * `contains(file.tags, "#heroes-and-knaves")` work as authored.
 */
function getDataviewField(entry: VaultEntry, field: string): any {
    switch (field) {
        case "file.name":
        case "file.link":
            return entry.stem;
        case "file.path":
            return entry.filepath;
        case "file.tags": {
            const tags = entry.frontmatter.tags;
            if (!Array.isArray(tags)) return [];
            return tags.map((t) => `#${String(t).replace(/^#/, "")}`);
        }
        default:
            return getNestedValue(entry.frontmatter, field);
    }
}

/**
 * Evaluate a single Dataview atomic predicate against an entry.
 * Returns true/false, or null if the predicate couldn't be parsed.
 */
function evaluateAtom(atom: string, entry: VaultEntry): boolean | null {
    const trimmed = atom.trim();

    // contains(field, "value")
    const containsMatch = trimmed.match(
        /^contains\(\s*(\S+?)\s*,\s*"([^"]*)"\s*\)$/i,
    );
    if (containsMatch) {
        const [, field, value] = containsMatch;
        const fv = getDataviewField(entry, field);
        const needle = value.toLowerCase();
        if (Array.isArray(fv)) {
            return fv.some((v) =>
                String(v).toLowerCase().includes(needle),
            );
        }
        return String(fv ?? "").toLowerCase().includes(needle);
    }

    // field (= | == | !=) "value"
    const cmpMatch = trimmed.match(
        /^(\S+?)\s*(!=|==|=)\s*"([^"]*)"$/,
    );
    if (cmpMatch) {
        const [, field, op, value] = cmpMatch;
        const fv = getDataviewField(entry, field);
        const a = String(fv ?? "").toLowerCase();
        const b = value.toLowerCase();
        return op === "!=" ? a !== b : a === b;
    }

    return null;
}

/**
 * Split a WHERE expression on a boolean operator (`and` | `or`) at the top
 * level, respecting double-quoted strings so operators inside string
 * literals don't split.
 */
function splitOnBoolean(
    expr: string,
    op: "and" | "or",
): string[] {
    const parts: string[] = [];
    const re = new RegExp(`\\s+${op}\\s+`, "i");
    let buf = "";
    let inQuote = false;
    let i = 0;
    while (i < expr.length) {
        const ch = expr[i];
        if (ch === '"') {
            inQuote = !inQuote;
            buf += ch;
            i++;
            continue;
        }
        if (!inQuote) {
            // Try to match the operator starting here (with required
            // whitespace on both sides).
            const rest = expr.slice(i);
            const m = rest.match(re);
            if (m && m.index === 0) {
                parts.push(buf);
                buf = "";
                i += m[0].length;
                continue;
            }
        }
        buf += ch;
        i++;
    }
    parts.push(buf);
    return parts;
}

/**
 * Evaluate a compound Dataview WHERE expression against an entry.
 *
 * Grammar (effectively):
 *   expr     := or-expr
 *   or-expr  := and-expr ( OR and-expr )*
 *   and-expr := atom ( AND atom )*
 *   atom     := contains(field, "value") | field (= | == | !=) "value"
 *
 * Unparseable predicates return false (match nothing) so authors notice a
 * broken query instead of getting a table full of unrelated content.
 */
function evaluateWhere(
    whereClause: string,
    entry: VaultEntry,
    verbose: boolean,
): boolean {
    const orParts = splitOnBoolean(whereClause, "or");
    for (const orPart of orParts) {
        const andParts = splitOnBoolean(orPart, "and");
        let allTrue = true;
        for (const atom of andParts) {
            const result = evaluateAtom(atom, entry);
            if (result === null) {
                if (verbose) {
                    console.warn(
                        `    Unparseable WHERE predicate: ${atom.trim()}`,
                    );
                }
                allTrue = false;
                break;
            }
            if (!result) {
                allTrue = false;
                break;
            }
        }
        if (allTrue) return true;
    }
    return false;
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

            // WHERE clause evaluation.
            //
            // Supports a useful subset of Dataview's expression language:
            //   - Atomic predicates:
            //       field = "value"          (case-insensitive equality)
            //       field != "value"         (negated equality)
            //       contains(field, "value") (substring on strings,
            //                                 element-substring on arrays)
            //   - Compound expressions joined by `and` / `or`, left-to-right
            //     with standard precedence (AND binds tighter than OR).
            //   - Special fields: `file.name` (stem), `file.link` (stem),
            //     `file.path` (absolute path), `file.tags` (array of tags
            //     with "#" prefix, matching Dataview convention).
            //
            // Parenthesized groups and negation (`!`) are not yet supported;
            // none of the vault's current queries use them. An unparseable
            // clause logs a warning (when verbose) and is treated as "match
            // nothing" — safer than silently returning the whole vault.
            if (whereClause) {
                filtered = filtered.filter((e) =>
                    evaluateWhere(whereClause, e, verbose),
                );
            }

            // Multi-field sort. Reuses the same field resolver as WHERE so
            // `file.name`, `file.link`, `file.path`, and `file.tags` all
            // behave consistently across clauses.
            const fieldValueForSort = (e: VaultEntry, field: string): string => {
                const v = getDataviewField(e, field);
                if (Array.isArray(v)) return v.join(",").toLowerCase();
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
            const entry = resolveWikilinkTarget(target, lookup);
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
            const entry = resolveWikilinkTarget(target, lookup);
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

    console.log("Building wikilink graph...");
    const graph = buildLinkGraph(entries, lookup);

    console.log("Indexing mystical abilities...");
    const mysticalIndex = buildMysticalIndex(entries);
    if (verbose) {
        console.log(
            `  spells=${mysticalIndex.spells.size}, talents=${mysticalIndex.talents.size}, domains=${mysticalIndex.domains.size}`,
        );
    }

    console.log("Indexing gear...");
    const gearIndex = buildGearIndex(entries);
    if (verbose) {
        console.log(`  gear shortcodes=${gearIndex.size}`);
    }

    let filesWritten = 0;

    console.log("\nExporting files...");
    for (const entry of entries) {
        if (verbose) {
            console.log(`\n  Processing: ${entry.stem}`);
        }

        // Transform front matter
        const hugoFm = transformFrontMatter(entry.frontmatter);

        // Post-pass: resolve spell/talent shortcodes in sohl.items to named
        // entries the sidebars can render directly.
        deriveSohlMysticals(hugoFm.sohl, mysticalIndex);

        // Post-pass: resolve gear shortcodes (weapons/armor/misc/…) to
        // friendly-named entries with links, using the vault's gear catalog.
        deriveSohlGear(hugoFm.sohl, gearIndex);

        // Inject related (backlinks + mentions) for layouts to render.
        // Omit empty directions and the whole block if both are empty.
        const backlinks = graph.backlinks.get(entry.url) ?? [];
        const mentions = graph.mentions.get(entry.url) ?? [];
        if (backlinks.length > 0 || mentions.length > 0) {
            const rel: Record<string, RelatedRef[]> = {};
            if (backlinks.length > 0) rel.backlinks = backlinks;
            if (mentions.length > 0) rel.mentions = mentions;
            hugoFm.related = rel;
        }

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
