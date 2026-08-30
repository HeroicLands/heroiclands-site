/**
 * CI guard: every asset URL this site renders must actually be published.
 *
 * Hugo emits image addresses; it never fetches them. So a page can name an
 * image that was never uploaded and nothing fails — not the build, not the
 * deploy, not the Worker. The page just renders with a dead URL behind it,
 * which for a hero banner means a full-height blank band under the title
 * (heroiclands-site#19).
 *
 * The addresses come from three places that no single check upstream can
 * cover: a page's own `banner:` / `img:` front matter, the hero banner the
 * shared theme derives from a page's `type:`, and the image URLs `hugo.toml`
 * hands the theme (the home cards, the brand logo, the 404 hero). The theme
 * declares which banners it believes exist and checks that list against the
 * CDN, but it cannot know what a consumer's config and content ask for. This
 * check reads the answer off the built site instead: whatever the rendered
 * HTML and CSS actually request, from any of those sources, is what gets
 * probed.
 *
 * Usage:
 *   node utils/check-assets.mjs [<dir>] [--base <url>] [--concurrency <n>]
 *
 * `<dir>` is a built site and defaults to `public`, so the whole invocation is
 * `hugo --minify && npm run check:assets`. The host defaults to the Heroic
 * Lands CDN and can be pointed anywhere with `--base` or `ASSET_BASE_URL`.
 *
 * A network failure is reported as a failure rather than skipped: a check that
 * passes when it could not reach the host is worse than no check at all.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const DEFAULT_BASE = "https://cdn.heroiclands.org";
const DEFAULT_DIR = "public";

/** The rendered files that can carry an asset address. */
const SCANNED = new Set([".html", ".css", ".xml", ".json", ".svg"]);

function parseArgs(argv) {
    const opts = {
        dir: DEFAULT_DIR,
        base: process.env.ASSET_BASE_URL || DEFAULT_BASE,
        concurrency: 8,
    };
    let dirGiven = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--base") opts.base = argv[(i += 1)];
        else if (arg === "--concurrency") opts.concurrency = Number(argv[(i += 1)]);
        else if (!arg.startsWith("-") && !dirGiven) {
            opts.dir = arg;
            dirGiven = true;
        } else {
            console.error(`check-assets: unrecognised argument ${arg}`);
            process.exit(2);
        }
    }
    if (!opts.base) {
        console.error("check-assets: no asset host; pass --base or set ASSET_BASE_URL");
        process.exit(2);
    }
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
        console.error("check-assets: --concurrency must be a positive integer");
        process.exit(2);
    }
    opts.base = opts.base.replace(/\/$/, "");
    return opts;
}

/** Diagnostics carry the fields they can know and drop the ones they cannot. */
function diag(where, message) {
    console.error(`${where}: error: ${message}`);
}

/**
 * The shortest path that still resolves from where the check was run, so a
 * diagnostic can be clicked. A build directory outside the working tree keeps
 * its own path rather than climbing out of it with a row of `../`.
 */
function locate(file) {
    const rel = relative(process.cwd(), file);
    return rel.startsWith("..") || isAbsolute(rel) ? file : rel;
}

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) yield* walk(full);
        else if (SCANNED.has(entry.slice(entry.lastIndexOf(".")).toLowerCase()))
            yield full;
    }
}

/**
 * Every reference to the asset host in the built site, as url → where it came
 * from.
 *
 * `hugo --minify` strips attribute quotes and rewrites `url('…')` to `url(…)`,
 * so the terminator can be a quote, a paren, whitespace, or a tag close. The
 * character class below is what stops the match; it is deliberately wider than
 * the un-minified form needs.
 */
function collectReferences(root, base) {
    const pattern = new RegExp(
        `${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^"'()<>\\s\\\\]+`,
        "g",
    );
    const refs = new Map();
    let files = 0;
    for (const file of walk(root)) {
        files += 1;
        const source = readFileSync(file, "utf8");
        const lines = source.split("\n");
        lines.forEach((line, index) => {
            for (const match of line.matchAll(pattern)) {
                const url = match[0].replace(/[.,;:]+$/, "");
                if (!refs.has(url)) refs.set(url, []);
                refs.get(url).push(`${locate(file)}:${index + 1}`);
            }
        });
    }
    return { refs, files };
}

async function probe(url) {
    try {
        // HEAD first — it is what the question actually is. Some object stores
        // answer 405 to it, so fall back to a ranged GET rather than reporting
        // a published file as missing.
        let res = await fetch(url, { method: "HEAD", redirect: "follow" });
        if (res.status === 405 || res.status === 501) {
            res = await fetch(url, {
                headers: { Range: "bytes=0-0" },
                redirect: "follow",
            });
        }
        return { ok: res.status === 200 || res.status === 206, status: String(res.status) };
    } catch (err) {
        return { ok: false, status: `network error: ${err.message}` };
    }
}

async function main() {
    const { dir, base, concurrency } = parseArgs(process.argv.slice(2));

    let root;
    try {
        root = statSync(dir).isDirectory() ? dir : null;
    } catch {
        root = null;
    }
    if (!root) {
        console.error(
            `check-assets: no built site at ${dir}${sep} — run \`hugo --minify\` first, or name a directory`,
        );
        process.exit(2);
    }

    const { refs, files } = collectReferences(root, base);
    if (refs.size === 0) {
        console.error(
            `check-assets: ${files} rendered files under ${dir} reference nothing at ${base}.`,
        );
        console.error(
            "That is not a pass: this site's pages carry a hero banner and a brand logo, so zero references means the scan missed them.",
        );
        process.exit(1);
    }

    const failures = [];
    const queue = [...refs.keys()];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
            const { ok, status } = await probe(url);
            if (!ok) failures.push({ url, status });
        }
    });
    await Promise.all(workers);

    if (failures.length) {
        failures.sort((a, b) => a.url.localeCompare(b.url));
        for (const { url, status } of failures) {
            const where = refs.get(url);
            // One diagnostic per referencing page, so an editor opens the page
            // that has to change rather than the asset that does not exist.
            for (const site of where) {
                diag(site, `asset is not published (${status}): ${url}`);
            }
        }
        console.error(
            `check-assets: ${failures.length} of ${refs.size} distinct assets referenced by ${dir} are missing from ${base}.`,
        );
        console.error(
            "Publish the artwork, or point the page at an address that exists — an unpublished asset is a broken image on every page that names it.",
        );
        process.exit(1);
    }

    console.log(
        `check-assets: all ${refs.size} distinct assets referenced by ${files} rendered files resolve at ${base}`,
    );
}

await main();
