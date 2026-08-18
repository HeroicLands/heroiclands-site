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
 *   5. Writes transformed files to type-dispatched output paths
 *      (e.g. content/thalorna/{type|category}/{slug}.md for world content,
 *      content/sohl/{type}/{slug}.md for SoHL system content,
 *      content/blog/YYYY/MM/{slug}.md for blog posts).
 *      See the "Routing model" section below for the full dispatch
 *      table.
 */

import * as fs from "fs";
import * as path from "path";
import { contentSlug } from "./content-slug";
import {
    LEGACY_SLUGS_PATH,
    legacyKey,
    readLegacySlugs,
    slugOfUrl,
} from "./legacy-urls";
import { noteName } from "./vault-frontmatter";

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
    "affiliation",
    "affliction",
    "armorgear",
    "attribute",
    "blog-post",
    "character",
    "concoctiongear",
    "containergear",
    "creature",
    "doc",
    "hm3-rules",
    "hm3-user-guide",
    "corpus",
    "miscgear",
    "mystery",
    "mysticalability",
    "page",
    "projectilegear",
    "skill",
    "trait",
    "weapongear",
] as const;

type ContentType = (typeof VALID_TYPES)[number];

// World-content types that participate in package-driven routing
// (URL = /{package}/{type}/{slug}/). Most former entries (adventure,
// campaign, company, continent, language, location, lore, people, polity,
// reference, region, settlement, world, …) collapsed into doc categories and
// now route via `type: doc` + `category: X` instead.
//
// `affiliation` is not among them: it is a real type, because it is a real
// Foundry item — the thalorna module compiles a note into an Affiliation item
// precisely when its `type` reads "affiliation". Every organized body in the
// setting is one, and `sohl.subType` says which kind: a religion or church
// (`divine`), a school of magic (`arcane`), a spirit or ancestor tradition
// (`spirit`), or a secular guild, bank, syndicate, or military unit
// (`social`). It therefore names its own section and carries its variation in
// the subtype, exactly as `skill`, `mysticalability`, and `mystery` do — one
// flat section whose members differ by subtype, not several sections invented
// to stand in for one. See #1419.
//
// `page` stays as the runtime type assigned to _index.md and Projects/
// landings; both dispatch via the Blog/Projects path branches before reaching
// the type-based dispatch, but `page` remains here as a defensive fallback
// for any future non-Blog/non-Projects _index.md.
const SETTING_TYPES: ReadonlySet<ContentType> = new Set([
    "affiliation",
    "character",
    "creature",
    "page",
]);

// SoHL game-system types that participate in package-driven routing
// (gear catalogs, character mechanics). The `package: sohl` frontmatter
// puts these under /sohl/{type}/{slug}/. When HM3 grows its own copies
// of these, they'll either set `package: hm3` directly or be added with
// an "hm3-" compound-type prefix that routes via /hm3/{kind}/{slug}/.
const SOHL_SYSTEM_TYPES: ReadonlySet<ContentType> = new Set([
    "affliction",
    "armorgear",
    "attribute",
    "concoctiongear",
    "containergear",
    "corpus",
    "miscgear",
    "mystery",
    "mysticalability",
    "projectilegear",
    "skill",
    "trait",
    "weapongear",
]);

// World-content types whose URL segment is the note's `category` rather than
// its type name. Only `doc` routes this way — it is narrative content whose
// sole identity is its subtype label, so without a category it has no address
// at all. Every other type names its own section and carries its variation in
// `sohl.subType`, the way `skill`, `mysticalability`, and `mystery` do.
const CATEGORY_ROUTED_TYPES: ReadonlySet<ContentType> = new Set(["doc"]);

// Packages this site no longer publishes. Their notes are still read and
// indexed (other content cross-references them), but they are not routed to
// an output page here — another site is now their canonical home.
const RETIRED_PACKAGES: ReadonlySet<string> = new Set(["sohl"]);

/** Notes skipped because their package is retired — reported after the run. */
let retiredPackageSkips = 0;

// ── Routing model ──────────────────────────────────────────────────

/**
 * URL dispatch is a hybrid of vault-path and frontmatter-type rules:
 *
 *   1. Files under Blog/ → /blog/YYYY/MM/{slug}/, dated from
 *      frontmatter.date. Vault subpath is otherwise ignored.
 *   2. Files under Projects/ → /projects/{slug}/, path-mirrored.
 *      Projects/ contains only landing pages (one .md per project
 *      plus a top-level _index.md).
 *   3. Everything else dispatches by `type` field — vault folder
 *      location is irrelevant. Each type maps to a URL prefix:
 *
 *        hm3-user-guide        → /hm3/user-guide/{slug}/
 *        hm3-rules             → /hm3/rules/{slug}/
 *        T in CATEGORY_ROUTED_TYPES
 *                              → /{package}/{category}/{slug}/   (see below)
 *        T in SETTING_TYPES ∪ SOHL_SYSTEM_TYPES
 *                              → /{package}/{T}/{slug}/          (see below)
 *
 * Files that land in none of the above are skipped with a warning.
 *
 * Package-driven routing.
 * -----------------------
 * Every typed piece of content (other than the special cases above)
 * declares a `package` frontmatter property naming the Foundry
 * distribution unit it belongs to ("sohl", "thalorna", "kethira",
 * future "hm3", etc.). The package is the top-level URL segment.
 *
 * The middle segment depends on the type:
 *   - For a type in CATEGORY_ROUTED_TYPES (`doc`), it's the `category`
 *     property (a subtype label like "lore", "settlement", "polity", or
 *     "user-guide"). The category selects which optional schema/layout
 *     applies and groups docs of the same subtype together on the site.
 *   - For all other types, it's the type name itself ("character",
 *     "affiliation", "weapongear", "skill", …).
 *
 * Both views collapse into the same shape: /{package}/{type|category}/{slug}/.
 * The package property is required for both; a category-routed type
 * additionally requires category. Missing required properties skip the
 * file with a warning.
 *
 * When adding a brand-new package (a new top-level URL segment), also
 * add that name to CONTENT_ROOTS so stale-file cleanup walks it, and
 * add a matching entry to the $packageLabels dict in
 * layouts/partials/breadcrumbs.html so breadcrumbs render the right
 * proper-noun casing.
 */

/**
 * Top-level Hugo content directories the exporter writes into.
 * Used by cleanStaleFiles() to know which subtrees of content/ to
 * walk when sweeping orphaned files. Anything else under content/
 * (such as hand-authored pages mounted from pages/) is left alone.
 */
const CONTENT_ROOTS: readonly string[] = [
    "blog",
    "hm3",
    "kethira",
    "projects",
    "setting",
    "sohl",
    "thalorna",
];

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
    /** Whether this entry is a section index (_index.md) */
    isIndex: boolean;
    /** Absolute output path in the Hugo content tree */
    outputPath: string;
    /** Public URL path for wikilink resolution (leading slash, trailing slash) */
    url: string;
    /**
     * Where this page published under the previous rule — an authored `slug`
     * if it had one, otherwise its filename. Undefined once the rules agree.
     * Only meaningful while the vault still carries slugs; it is what the
     * `--capture-legacy-urls` pass records so the address survives their
     * removal.
     */
    legacyUrl?: string;
}

interface LookupEntry {
    title: string;
    /** Public URL path, e.g. "/world/thalorna/character/some-person/" */
    url: string;
    /** Content type, e.g. "character", "creature" */
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
 * Compute where a vault entry should be written in the Hugo content
 * tree and what its public URL will be.
 *
 * Dispatch order (see "Routing model" above for full rules):
 *   1. Files under Blog/ → by-date routing, vault subpath ignored.
 *   2. Files under Projects/ → path mirror to /projects/.
 *   3. Otherwise, by `type` field — folder location is irrelevant.
 *
 * Returns null if the entry cannot be routed (unknown type, missing
 * date on a blog post, etc.) — callers warn and skip.
 */
function resolveOutputPath(
    entry: Omit<VaultEntry, "outputPath" | "url" | "isIndex"> & {
        isIndex: boolean;
    },
): { outputPath: string; url: string } | null {
    const rel = path.relative(VAULT_ROOT, entry.filepath);

    // ── 1. Blog/ — by-date ───────────────────────────────────────
    if (rel === "Blog" || rel.startsWith("Blog/") || rel.startsWith("Blog" + path.sep)) {
        if (entry.isIndex) {
            return {
                outputPath: path.join(HUGO_CONTENT, "blog", "_index.md"),
                url: "/blog/",
            };
        }
        const date = entry.frontmatter.date;
        const match = typeof date === "string"
            ? date.match(/^(\d{4})-(\d{2})-\d{2}/)
            : null;
        if (!match) return null;
        const [, year, month] = match;
        return {
            outputPath: path.join(
                HUGO_CONTENT,
                "blog",
                year,
                month,
                `${entry.slug}.md`,
            ),
            url: `/blog/${year}/${month}/${entry.slug}/`,
        };
    }

    // ── 2. Projects/ — path mirror ───────────────────────────────
    if (rel.startsWith("Projects/") || rel.startsWith("Projects" + path.sep)) {
        if (entry.isIndex) {
            return {
                outputPath: path.join(HUGO_CONTENT, "projects", "_index.md"),
                url: "/projects/",
            };
        }
        return {
            outputPath: path.join(HUGO_CONTENT, "projects", `${entry.slug}.md`),
            url: `/projects/${entry.slug}/`,
        };
    }

    // ── 3. Type-based dispatch ───────────────────────────────────
    const T = entry.type;
    const S = entry.slug;

    if (T === "hm3-user-guide") {
        return {
            outputPath: path.join(HUGO_CONTENT, "hm3", "user-guide", `${S}.md`),
            url: `/hm3/user-guide/${S}/`,
        };
    }
    if (T === "hm3-rules") {
        return {
            outputPath: path.join(HUGO_CONTENT, "hm3", "rules", `${S}.md`),
            url: `/hm3/rules/${S}/`,
        };
    }

    // Package-driven routing for the category-routed types and all
    // SETTING/SOHL types. URL = /{package}/{type|category}/{slug}/. The middle
    // segment is `category` for a category-routed type, otherwise the type
    // itself.
    //
    // Special case: category=collection. These notes ARE the
    // section landing for /{package}/{slug}/ — they're authored once per
    // (package, slug) pair when the author wants custom prose/banner above
    // the auto-generated child listing. They're emitted as `_index.md`
    // (Hugo's section-index convention) so the section index template
    // suppresses the auto-list and shows the authored content instead.
    // Sections without a collection note auto-generate their landing via
    // `layouts/_default/list.html`.
    if (
        CATEGORY_ROUTED_TYPES.has(T) ||
        SETTING_TYPES.has(T) ||
        SOHL_SYSTEM_TYPES.has(T)
    ) {
        const pkg = entry.frontmatter.package;
        if (typeof pkg !== "string" || !pkg) {
            return null;
        }
        // The `sohl` package is no longer published here. The same notes are
        // published by the Song-of-Heroic-Lands-FoundryVTT repository, under
        // /sohl/kb/{type}/{slug}/, which is generated by the code
        // that also compiles them into the game's compendium packs — so that
        // copy cannot drift from the system, and this one always could. It
        // had: it still carried `corpus` and `trait` after the system retired
        // both. /sohl/* is redirected to the knowledgebase at the edge; see
        // DEPLOYMENT.md. Marketing pages live under /projects/ and are
        // unaffected.
        if (RETIRED_PACKAGES.has(pkg)) {
            retiredPackageSkips++;
            return null;
        }
        if (
            CATEGORY_ROUTED_TYPES.has(T) &&
            entry.frontmatter.category === "collection"
        ) {
            return {
                outputPath: path.join(HUGO_CONTENT, pkg, S, "_index.md"),
                url: `/${pkg}/${S}/`,
            };
        }
        let middle: string;
        if (CATEGORY_ROUTED_TYPES.has(T)) {
            const category = entry.frontmatter.category;
            if (typeof category !== "string" || !category) {
                return null;
            }
            middle = category;
        } else {
            middle = T;
        }
        return {
            outputPath: path.join(HUGO_CONTENT, pkg, middle, `${S}.md`),
            url: `/${pkg}/${middle}/${S}/`,
        };
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

        const stem = path.basename(filepath, ".md");
        const isIndex = stem === "_index";
        const rel = path.relative(VAULT_ROOT, filepath);
        const isProjectLanding =
            rel.startsWith("Projects/") || rel.startsWith("Projects" + path.sep);

        // _index.md files and Projects/ landing pages don't require a type
        // — both use path-based dispatch and default to "page". Regular
        // entries must declare a type from VALID_TYPES.
        let rawType: ContentType;
        if (isIndex || isProjectLanding) {
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

        const title = noteName(fm, filepath);
        // The URL comes from the note's name, never from an authored `slug`
        // (#1389). A hand-written slug was a second spelling of something the
        // name already decided, free to drift from the page it named, and the
        // reason this site and the SoHL system repository disagreed about a
        // page's address. Where the derived URL differs from the one a page
        // used to publish at, `scripts/legacy-slugs.json` records the old
        // address and it is emitted as a redirect below.
        //
        // One exception, and it is not presentation at all: a
        // `category: collection` note *is* the landing for a section, and its
        // segment names that section — `Weapons.md` lands `/thalorna/weapongear/`,
        // `Arcane_Domains.md` lands `/thalorna/arcane-domain/`. That value is
        // identity, it is not derivable from the note's title, and deriving it
        // anyway detaches every landing from the section it introduces. It is
        // authored as `section`, which says what it does.
        const isCollection =
            CATEGORY_ROUTED_TYPES.has(rawType) && fm.category === "collection";

        // A category-routed note with no category has nowhere to publish, and
        // that failure used to be silent: 129 affiliation notes went
        // unpublished for months while the infoboxes that referenced them fell
        // through to a humanized label that happened to read like the link it
        // was standing in for (#1419). Missing routing data is a defect in the
        // note, so it is reported unconditionally rather than behind --verbose.
        if (
            CATEGORY_ROUTED_TYPES.has(rawType) &&
            !(typeof fm.category === "string" && fm.category)
        ) {
            console.warn(
                `  Skipping ${filepath}: type "${rawType}" routes by category, but the note declares none.`,
            );
            continue;
        }
        // A landing with no `section` is the same defect as a category-routed
        // note with no category: the one value that says where it publishes is
        // missing. Deriving a slug from its title instead would land it at a
        // plausible-looking address that is not the section's, so report it
        // rather than publish it somewhere wrong.
        if (isCollection && !(typeof fm.section === "string" && fm.section)) {
            console.warn(
                `  Skipping ${filepath}: collection landing declares no \`section\` — nothing names the section it introduces.`,
            );
            continue;
        }

        let slug: string;
        if (isCollection) {
            slug = fm.section;
        } else {
            try {
                slug = contentSlug(title);
            } catch (err) {
                console.warn(`  Skipping ${filepath}: ${(err as Error).message}`);
                continue;
            }
        }

        const resolved = resolveOutputPath({
            filepath,
            stem,
            frontmatter: fm,
            body,
            type: rawType,
            title,
            slug,
            isIndex,
        });

        if (!resolved) {
            if (verbose) {
                console.warn(
                    `  Skipping ${filepath}: could not resolve output path for type "${rawType}" — file is outside Blog/ and Projects/, and the type is not a known setting/sohl type (check frontmatter date for blog posts).`,
                );
            }
            continue;
        }

        // Where this page published before the URL was derived from the name:
        // an authored `slug` when it had one, else its filename. Routed through
        // the same resolver, so the recorded address cannot drift from the way
        // addresses are actually built.
        const legacySlug =
            isCollection ?
                slug
            :   fm.slug || stem.toLowerCase().replace(/_/g, "-");
        const legacyUrl =
            legacySlug === slug ? undefined : (
                resolveOutputPath({
                    filepath,
                    stem,
                    frontmatter: fm,
                    body,
                    type: rawType,
                    title,
                    slug: legacySlug,
                    isIndex,
                })?.url
            );

        entries.push({
            filepath,
            stem,
            frontmatter: fm,
            body,
            type: rawType,
            title,
            slug,
            isIndex,
            outputPath: resolved.outputPath,
            url: resolved.url,
            legacyUrl,
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
    /** Content type so callers can disambiguate weapons vs. armor etc. */
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
        }
        // NOTE: domains used to be indexed here via `entry.type === "domain"`,
        // but the vault has since collapsed `domain` into `type: doc,
        // category: arcane-domain`. Domain resolution in spell rendering
        // (around line ~1198) currently always falls through to the
        // "unpublished domain — expose shortcode" branch as a result.
        // Repopulating `domains` from arcane-domain doc pages is a separate
        // fix; the keying convention (slug vs. an explicit shortcode field)
        // needs deciding first since arcane-domain pages don't carry a
        // `shortcode:` frontmatter today.
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
 * Build a shortcode -> {title, url} map for every published corpus note.
 *
 * Characters and creatures reference their corpus (species/body) by
 * shortcode in the `type: corpus` entry of `sohl.items[]`; the sidebar
 * renders the friendly name (and links to the corpus page) from this
 * index rather than the raw shortcode.
 */
type CorpusRef = { title: string; url: string };
type CorpusIndex = Map<string, CorpusRef>;
function buildCorpusIndex(entries: VaultEntry[]): CorpusIndex {
    const corpora: CorpusIndex = new Map();
    for (const entry of entries) {
        if (entry.type !== "corpus") continue;
        const shortcode = entry.frontmatter.shortcode;
        if (typeof shortcode !== "string" || !shortcode) continue;
        if (corpora.has(shortcode)) continue;
        corpora.set(shortcode, { title: entry.title, url: entry.url });
    }
    return corpora;
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
    // Never the authored `slug`. Hugo treats a front-matter `slug` as the URL
    // segment, so passing the vault's through would override the derived one
    // and quietly undo #1389 — and it would keep doing so for as long as any
    // note still carried the property. The derived segment is set in
    // applyUrl() instead, which makes the exporter authoritative about a
    // page's address whether or not the vault has been migrated yet.
    slug: () => undefined,
    // A note's stable identity, and the key every cross-page reference
    // resolves on. `slug` is presentation — it changes whenever a page is
    // renamed or restyled — so joining on it silently blanks an infobox the
    // moment a title changes. `shortcode` never changes, so the infobox
    // partials join on this instead. See assertUniqueShortcodes().
    shortcode: (fm) => fm.shortcode || undefined,
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
    // Documentation routing fields. For type=doc, these define both
    // the URL (/{package}/{category}/{slug}/) and the breadcrumb
    // section label. Other types don't set these.
    package: (fm) => fm.package || undefined,
    category: (fm) => fm.category || undefined,
    // Blog-post specific fields. Passed through verbatim so Hugo's
    // .Params.date / .Params.series (and date-based sort) work.
    date: (fm) => fm.date || undefined,
    series: (fm) => fm.series || undefined,
    realm: (fm) => fm.thalorna?.realm || undefined,
    gender: (fm) => fm.traits?.gender || undefined,
    occupation: (fm) => fm.social?.occupation || undefined,
    // Page-level banner override. Accepts either a full URL or a CDN-relative
    // fragment like "banners/character.webp"; hero-banner.html resolves both.
    banner: (fm) => fm.banner || undefined,
    // `aliases` is one word for two unrelated things, and conflating them
    // published nonsense. In Obsidian a note's aliases are alternative
    // *names* — what a reader might call the thing, and what makes a bare
    // [[Text]] wikilink resolve. In Hugo they are *URL redirects*. Passing the
    // Obsidian ones straight through turned every display name into a live
    // address: /thalorna/settlement/Tz'uma No'tun/ was a real published page,
    // as was /thalorna/settlement/doc-tzumanotun2/ from the addressing alias.
    //
    // A display name is not an old URL, so it is never a redirect. Redirects
    // are generated, from the one record of where a page really did publish
    // before — see addRedirects(). Emitted as undefined here and filled in
    // afterwards, so nothing an author types can become a public URL.
    aliases: () => undefined,
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

    // ── Polity-specific top-level fields ───────────────────────────
    // Passed through so the polity infobox (partials/infobox/polity.html)
    // can render the realm's profile card at the top of the content.
    // Other content types don't set these and will silently emit undefined.
    subType: (fm) => fm.subType || undefined,
    // ── Settlement-specific top-level fields ───────────────────────
    // Passed through so the settlement infobox
    // (partials/infobox/settlement.html) can render a settlement's
    // profile card. settlementType is a free-text display label
    // ("Imperial City (Capital)", "Market & Temple Town") rendered
    // verbatim; population is a display string ("~450,000"). A
    // settlement's languages/pantheons/parent reuse the shared
    // slug-valued fields below.
    settlementType: (fm) => fm.settlementType || undefined,
    // Population is integer-only. Emit it only when it is an actual
    // number; a settlement with unknown population (authored as
    // `population: null`, which some YAML readers surface as the string
    // "null") is dropped so the infobox simply omits the row.
    population: (fm) => (typeof fm.population === "number" ? fm.population : undefined),
    demonym: (fm) => fm.demonym || undefined,
    capital: (fm) => fm.capital || undefined,
    ruler: (fm) => fm.ruler || undefined,
    government: (fm) => fm.government || undefined,
    languages: (fm) => fm.languages || undefined,
    pantheons: (fm) => fm.pantheons || undefined,
    peoples: (fm) => fm.peoples || undefined,
    terran_analog: (fm) => fm.terran_analog || undefined,

    // ── Geographic parent-chain fields ─────────────────────────────
    // Every step in the World → Continent → Region → Polity chain
    // records its immediate parent(s) so infoboxes can render links
    // climbing up the hierarchy. Each one is a list where plausible
    // (regions/continents) so cross-continental or multi-region
    // entities — e.g. Mídhalión straddling Ankaris and Xerathia — can
    // be expressed without a schema change.
    regions: (fm) => fm.regions || undefined,       // polity → region(s)
    continents: (fm) => fm.continents || undefined, // region → continent(s), or polity → continent(s) when no region ancestor exists
    world: (fm) => fm.world || undefined,           // continent → world
    parent: (fm) => fm.parent || undefined,         // polity → parent polity (and settlements → their polity)

    // ── Faith-specific top-level fields ─────────────────────────────
    // Passed through so the faith infobox (partials/infobox/faith.html)
    // can render the deity profile at the top of the content.
    img:      (fm) => fm.img      || undefined,  // per-deity portrait
                                                  // (Aurèldián/Asguardian);
                                                  // wins over `glyph`.
    deity:    (fm) => fm.deity    || undefined,
    epithet:  (fm) => fm.epithet  || undefined,
    domain:   (fm) => fm.domain   || undefined,
    symbol:   (fm) => fm.symbol   || undefined,
    glyph:    (fm) => fm.glyph    || undefined,
    pantheon: (fm) => fm.pantheon || undefined,
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
 * Augment an already-transformed sohl block with a resolved `corpus`
 * reference, derived from the `type: corpus` entry in `sohl.items[]`.
 *
 * Emits `sohl.corpus = { name, shortcode?, url? }` where `name` is the
 * corpus note's title and `url` links to its page. Resolution mirrors
 * deriveSohlGear: an inline `name` on the item wins; otherwise the item's
 * `shortcode` is looked up in the corpus index; failing both, the raw
 * shortcode is used as the name so the row still renders. A hand-authored
 * `sohl.corpus` is left untouched.
 */
function deriveSohlCorpus(
    sohl: Record<string, any> | undefined,
    index: CorpusIndex,
): void {
    if (!sohl || typeof sohl !== "object") return;
    if (sohl.corpus && typeof sohl.corpus === "object") return;
    const items = sohl.items;
    if (!Array.isArray(items) || items.length === 0) return;

    const item = items.find(
        (it: any) => it && typeof it === "object" && it.type === "corpus",
    );
    if (!item) return;

    const shortcode = typeof item.shortcode === "string" ? item.shortcode : null;
    const inlineName = typeof item.name === "string" ? item.name : null;
    const ref = shortcode ? index.get(shortcode) : undefined;

    const name = inlineName ?? ref?.title ?? shortcode;
    if (!name) return;

    const corpus: Record<string, string> = { name };
    if (shortcode) corpus.shortcode = shortcode;
    if (ref?.url) corpus.url = ref.url;
    sohl.corpus = corpus;
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
                        // Link to this row entry's own URL. Resolving via the
                        // stem lookup mis-targets when a name is shared by two
                        // entries (e.g. a creature and its `corpus` body-twin),
                        // since the lookup keeps only one of them.
                        if (e.url) {
                            return `[${displayVal}](${e.url})`;
                        }
                        return displayVal;
                    }
                    // file.link → same as bare link
                    if (expr === "file.link") {
                        if (e.url) {
                            return `[${e.title}](${e.url})`;
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

/**
 * For every package-scoped section directory that received leaf files but
 * has no hand-authored `_index.md` (no `type: doc, category: collection`
 * note from the vault), emit a minimal stub `_index.md`. Hugo otherwise
 * silently skips rendering a section landing for bare directories, so the
 * stubs are what make `/{pkg}/{slug}/` land somewhere instead of 404.
 * The stubs have empty bodies; `layouts/_default/list.html` detects the
 * empty `.Content` and renders the auto-generated child listing.
 *
 * Returns the set of stub output paths written so they can be added to
 * `expectedFiles` before the stale-file sweep.
 */
function generateSectionStubs(
    entries: VaultEntry[],
    dryRun: boolean,
    verbose: boolean,
): Set<string> {
    // Identify (package-dir, section-dir) pairs that received leaf files,
    // and track which already have an _index.md written by the main pass.
    const sectionDirs = new Map<string, { pkg: string; slug: string; hasIndex: boolean }>();
    for (const entry of entries) {
        const out = entry.outputPath;
        const dir = path.dirname(out);
        const isIndex = path.basename(out) === "_index.md";
        // Only consider /{HUGO_CONTENT}/{pkg}/{slug}/... — skip Blog/Projects
        // and any path that's not exactly two segments deep inside content/.
        const rel = path.relative(HUGO_CONTENT, dir);
        const parts = rel.split(path.sep).filter(Boolean);
        if (parts.length < 2) continue;
        const pkg = parts[0];
        const slug = parts[1];
        // Skip Blog and Projects — they own their own _index.md handling.
        if (pkg === "blog" || pkg === "projects") continue;
        const key = `${pkg}/${slug}`;
        const prev = sectionDirs.get(key);
        if (prev) {
            if (isIndex) prev.hasIndex = true;
        } else {
            sectionDirs.set(key, { pkg, slug, hasIndex: isIndex });
        }
    }

    const stubsWritten = new Set<string>();
    for (const { pkg, slug, hasIndex } of sectionDirs.values()) {
        if (hasIndex) continue;
        const stubPath = path.join(HUGO_CONTENT, pkg, slug, "_index.md");
        const title = slug
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
        const content =
            `---\ntitle: ${title}\ntype: doc\ncategory: collection\npackage: ${pkg}\nslug: ${slug}\n---\n`;
        if (dryRun) {
            if (verbose) console.log(`  Would stub: ${stubPath}`);
        } else {
            fs.mkdirSync(path.dirname(stubPath), { recursive: true });
            fs.writeFileSync(stubPath, content, "utf-8");
            if (verbose) console.log(`  Stubbed:   ${stubPath}`);
        }
        stubsWritten.add(stubPath);
    }
    return stubsWritten;
}

function cleanStaleFiles(
    entries: VaultEntry[],
    extraExpected: Set<string>,
    dryRun: boolean,
    verbose: boolean,
): void {
    // Build set of expected output paths (regular entries + stubs + _index files).
    const expectedFiles = new Set<string>(extraExpected);
    for (const entry of entries) {
        expectedFiles.add(entry.outputPath);
    }

    // Walk each top-level Hugo output tree the exporter writes into and
    // remove any .md files that aren't in the expected set. This catches
    // files from deleted vault entries, renamed slugs, etc. Anything
    // outside CONTENT_ROOTS (e.g. hand-authored pages mounted from
    // pages/) is left alone.
    const bucketRoots = new Set<string>();
    for (const root of CONTENT_ROOTS) {
        bucketRoots.add(path.join(HUGO_CONTENT, root));
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

// ── Identity integrity ─────────────────────────────────────────────

/**
 * Fail the export when two publishable notes of the same type claim the
 * same `shortcode`.
 *
 * Cross-page references — a region's continent, a polity's capital, a
 * settlement's languages — resolve on `shortcode` rather than `slug`,
 * because a slug is presentation and changes whenever a page is renamed.
 * Hugo's `where` returns the first match, or nothing, without erroring, so
 * an ambiguous identity would quietly render the wrong page and a missing
 * one would quietly blank the row. Neither shows up in a green build,
 * which is why identity is checked here instead.
 *
 * Uniqueness is scoped per `type`, matching how the vault allocates
 * shortcodes. A collision *across* types cannot be disambiguated by the
 * type-blind join the infoboxes use, but no two colliding pages are both
 * reference targets today, so that case is reported rather than fatal.
 *
 * @param entries Every publishable vault entry.
 * @throws If two entries of one type share a shortcode.
 */
function assertUniqueShortcodes(entries: VaultEntry[]): void {
    const withinType = new Map<string, string[]>();
    const acrossTypes = new Map<string, string[]>();

    for (const entry of entries) {
        const raw = entry.frontmatter.shortcode;
        if (typeof raw !== "string" || !raw.trim()) continue;
        const code = raw.trim();
        const rel = path.relative(VAULT_ROOT, entry.filepath);

        const typed = `${entry.type}/${code}`;
        if (!withinType.has(typed)) withinType.set(typed, []);
        withinType.get(typed)!.push(rel);
        if (!acrossTypes.has(code)) acrossTypes.set(code, []);
        acrossTypes.get(code)!.push(rel);
    }

    const collisions = [...withinType].filter(([, files]) => files.length > 1);
    if (collisions.length > 0) {
        const detail = collisions
            .map(
                ([typed, files]) =>
                    `  ${typed}\n${files.map((f) => `    - ${f}`).join("\n")}`,
            )
            .join("\n");
        throw new Error(
            `Duplicate shortcode within a type — a cross-page reference to it ` +
                `cannot resolve to one page:\n${detail}`,
        );
    }

    const shared = [...acrossTypes].filter(([, files]) => files.length > 1);
    if (shared.length > 0) {
        console.log(
            `  ${shared.length} shortcode(s) shared across types: ` +
                `${shared.map(([code]) => code).join(", ")}.\n` +
                `  Each stays unique within its own type, so references remain ` +
                `unambiguous; only a type-blind reference could pick the wrong page.`,
        );
    }
}

// ── Main ───────────────────────────────────────────────────────────

// ── Redirects and artwork ──────────────────────────────────────────

/** `type:shortcode` → the URL, or URLs, the page used to publish at. */
const LEGACY_URLS: Record<string, string | string[]> = readLegacySlugs();

/**
 * Set a page's derived address, the redirects it owes, and the artwork name it
 * was uploaded under.
 *
 * Deriving the URL from the note's name (#1389) moves 229 pages. Two things
 * would break quietly if nothing carried the old address forward:
 *
 * - **Links and bookmarks** to the previous URL would 404. Hugo's `aliases`
 *   emits a redirect for each, so they still land.
 * - **Portraits.** The character and creature sidebars ask the CDN for
 *   `/images/<slug>.webp`, a filename fixed when the image was uploaded.
 *   Deriving a new URL does not rename a file on a CDN, so the sidebars read
 *   `artwork` — the recorded name — rather than the page's current slug.
 *
 * A page with no recorded history redirects from nothing and keeps its own
 * slug as the artwork name, which is what it has always been.
 *
 * @param hugoFm - The front matter about to be written (mutated).
 * @param entry - The page it belongs to.
 */
function applyUrl(hugoFm: Record<string, any>, entry: VaultEntry): void {
    // The address, derived from the note's name.
    hugoFm.slug = entry.slug;

    // A page may have published at more than one address over its life, so a
    // record is a string or a list of them. Retiring the `faith` designation
    // proved it: /thalorna/affiliation/ is the one section that replaced four,
    // and its landing has to answer at all four of the old addresses.
    const recorded =
        LEGACY_URLS[
            legacyKey(
                entry.frontmatter,
                path.relative(VAULT_ROOT, entry.filepath),
            )
        ];
    const legacyUrls = (
        Array.isArray(recorded) ? recorded
        : recorded ? [recorded]
        : []
        // A page never redirects from where it already is; that is a loop.
    ).filter((u) => u && u !== entry.url);

    if (legacyUrls.length > 0) {
        hugoFm.aliases = legacyUrls;
    }
    // The artwork name is the earliest address it was uploaded under.
    hugoFm.artwork = legacyUrls.length > 0 ? slugOfUrl(legacyUrls[0]) : entry.slug;
}

/**
 * Fail the export when two notes derive the same URL.
 *
 * Nothing stops two notes in one section from sharing a name, and Hugo would
 * simply write one page over the other — the later export wins, the earlier
 * page vanishes, and the build stays green. An authored `slug` used to let a
 * clash be settled by hand; deriving the URL means the clash has to be settled
 * in the name, which is where it belongs, so it is raised here instead of
 * silently resolved.
 *
 * @param entries - Every publishable vault entry.
 * @throws If two entries would publish to the same URL.
 */
function assertUniqueUrls(entries: VaultEntry[]): void {
    const byUrl = new Map<string, VaultEntry[]>();
    for (const entry of entries) {
        const list = byUrl.get(entry.url);
        if (list) list.push(entry);
        else byUrl.set(entry.url, [entry]);
    }

    const clashes = [...byUrl.entries()].filter(([, v]) => v.length > 1);
    if (clashes.length === 0) return;

    console.error(
        `\n\u2717 ${clashes.length} URL(s) claimed by more than one note \u2014 one page would overwrite the other:`,
    );
    for (const [url, notes] of clashes.sort()) {
        console.error(`  ${url}`);
        for (const n of notes) {
            console.error(
                `      ${path.relative(VAULT_ROOT, n.filepath)}  (name: ${n.title})`,
            );
        }
    }
    console.error(
        `\nA page's URL comes from its name, so give each note a name of its own.`,
    );
    process.exit(1);
}

/**
 * Record where every moving page publishes today, then stop.
 *
 * Run once, against a vault that still carries authored slugs, before those
 * slugs are removed:
 *
 *     npm run capture:legacy-urls -- --write
 *
 * A page's previous address exists in exactly one place — the `slug` in its
 * front matter, or failing that its filename — and both disappear as a public
 * address the moment the URL is derived from the note's name. Recording them
 * here rather than in a script of its own is deliberate: the old address is
 * routed through {@link resolveOutputPath}, the same function that builds the
 * real one, so the record cannot drift from the routing. A hand-mirrored copy
 * of those rules got the `collection` landings wrong and missed every note that
 * never had a slug at all.
 *
 * Merges rather than replaces. An address already recorded was real and may
 * still be linked, so it is never dropped.
 *
 * @param entries - Every publishable vault entry.
 * @param write - Whether to write; otherwise report and change nothing.
 */
function captureLegacyUrls(entries: VaultEntry[], write: boolean): void {
    const existing = readLegacySlugs();
    const captured: Record<string, string> = {};

    for (const entry of entries) {
        if (!entry.legacyUrl || entry.legacyUrl === entry.url) continue;
        captured[
            legacyKey(
                entry.frontmatter,
                path.relative(VAULT_ROOT, entry.filepath),
            )
        ] = entry.legacyUrl;
    }

    const merged = { ...existing, ...captured };
    const added = Object.keys(captured).filter((k) => !(k in existing));

    console.log(`\n${entries.length} publishable note(s) scanned.`);
    console.log(`  ${Object.keys(captured).length} change address and are recorded.`);
    console.log(
        `  ${Object.keys(existing).length} already recorded \u2192 ${Object.keys(merged).length} after merge (${added.length} new).`,
    );

    if (!write) {
        console.log(`\nDry run: nothing written. Re-run with --write to record.`);
        return;
    }

    const sorted: Record<string, string | string[]> = {};
    for (const k of Object.keys(merged).sort()) sorted[k] = merged[k];
    fs.writeFileSync(LEGACY_SLUGS_PATH, JSON.stringify(sorted, null, 4) + "\n", "utf8");
    console.log(`\nWrote ${LEGACY_SLUGS_PATH}`);
    console.log(`Commit it: it is now the only record of these addresses.`);
}

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

    console.log("Checking shortcode identity...");
    assertUniqueShortcodes(entries);

    assertUniqueUrls(entries);

    // One-shot: record where these pages publish today, then stop. Must run
    // while the vault still has slugs — see captureLegacyUrls().
    if (process.argv.includes("--capture-legacy-urls")) {
        captureLegacyUrls(entries, process.argv.includes("--write"));
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

    console.log("Indexing corpora...");
    const corpusIndex = buildCorpusIndex(entries);
    if (verbose) {
        console.log(`  corpus shortcodes=${corpusIndex.size}`);
    }

    let filesWritten = 0;

    console.log("\nExporting files...");
    for (const entry of entries) {
        if (verbose) {
            console.log(`\n  Processing: ${entry.stem}`);
        }

        // Transform front matter
        const hugoFm = transformFrontMatter(entry.frontmatter);

        // Publish at the derived address, redirect from wherever this page used
        // to live, and keep its portrait pointed at the CDN filename it was
        // uploaded under.
        applyUrl(hugoFm, entry);

        // Post-pass: resolve spell/talent shortcodes in sohl.items to named
        // entries the sidebars can render directly.
        deriveSohlMysticals(hugoFm.sohl, mysticalIndex);

        // Post-pass: resolve gear shortcodes (weapons/armor/misc/…) to
        // friendly-named entries with links, using the vault's gear catalog.
        deriveSohlGear(hugoFm.sohl, gearIndex);

        // Post-pass: resolve the corpus (species) shortcode in sohl.items to
        // a named, linked entry for the character/creature sidebars.
        deriveSohlCorpus(hugoFm.sohl, corpusIndex);

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

    // Emit stub _index.md for sections that lack a hand-authored collection
    // note, so Hugo renders their auto-generated landing instead of 404.
    console.log("\nGenerating section stubs...");
    const stubs = generateSectionStubs(entries, dryRun, verbose);
    if (verbose) console.log(`  Stubs written: ${stubs.size}`);

    // Clean stale files
    console.log("\nCleaning stale files...");
    cleanStaleFiles(entries, stubs, dryRun, verbose);

    if (retiredPackageSkips > 0) {
        console.log(
            `\n  ${retiredPackageSkips} note(s) not published: package is retired ` +
                `(${[...RETIRED_PACKAGES].join(", ")}) — see DEPLOYMENT.md.`,
        );
    }

    console.log(`\n✓ Done. ${filesWritten} files exported.`);
}

main();
