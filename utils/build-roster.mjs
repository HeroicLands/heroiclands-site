/**
 * Write `data/roster.json` and `static/nav.json` from `roster.mjs`, check that
 * both are current, and hand the header navigation to the site build.
 *
 * `roster.mjs` is the one authored list of packages HeroicLands publishes,
 * carrying the reasoning a generated file cannot. This script projects it into
 * the two formats its readers take natively: `data/roster.json`, the
 * cross-link projection, and `static/nav.json`, the header navigation
 * published at `https://www.heroiclands.org/nav.json`, which every package
 * site's `package-build deps fetch` caches for its own header.
 *
 * The projections are **committed**, not built at deploy time, so they are
 * readable in review and checked on the pull request. A committed copy can go
 * stale, so it is the check below that makes this safe rather than the
 * convention. `worker/test/roster.test.mjs` asserts the same thing, so the
 * suite the pull request already runs fails on a stale copy even if nobody
 * runs this script.
 *
 * This site draws its own header from the same navigation. `--cache` writes
 * it where `package-build site build` reads a cached navigation from — the
 * `paths.navigationCache` default, `build/cache/navigation/`, stamped
 * complete as `package-build deps fetch` stamps it — so the header is the
 * roster as committed rather than the copy this site last published.
 * `--publish <dir>` copies `static/nav.json` into the built site, where it is
 * served at `/nav.json`.
 *
 * Usage:
 *   node utils/build-roster.mjs                  # write both files
 *   node utils/build-roster.mjs --check          # fail if either is not what would be written
 *   node utils/build-roster.mjs --cache          # check, then cache the navigation for the site build
 *   node utils/build-roster.mjs --publish <dir>  # check, then copy nav.json into a built site
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { renderDataFile, renderNavFile } from "../roster.mjs";

/** Every derived file, and how to render it. */
const TARGETS = [
    { url: new URL("../data/roster.json", import.meta.url), render: renderDataFile },
    { url: new URL("../static/nav.json", import.meta.url), render: renderNavFile },
];

/** Where `package-build site build` reads the cached navigation from. */
const NAVIGATION_CACHE = new URL("../build/cache/navigation/", import.meta.url);

const args = process.argv.slice(2);
const at = (flag) => args.indexOf(flag);
const check = at("--check") >= 0 || at("--cache") >= 0 || at("--publish") >= 0;
const publish = at("--publish") >= 0 ? args[at("--publish") + 1] : undefined;
if (at("--publish") >= 0 && !publish) {
    console.error("build-roster: --publish needs the built site's directory");
    process.exit(2);
}

let stale = false;
for (const { url, render } of TARGETS) {
    const path = fileURLToPath(url);
    const rel = relative(process.cwd(), path);
    const expected = render();

    if (check) {
        let actual;
        try {
            actual = readFileSync(url, "utf8");
        } catch {
            console.error(`${rel}: error: missing; run \`npm run roster\``);
            stale = true;
            continue;
        }
        if (actual !== expected) {
            console.error(`${rel}: error: does not match roster.mjs; run \`npm run roster\``);
            stale = true;
        }
    } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(url, expected);
        console.log(`Wrote ${rel}`);
    }
}
if (stale) process.exit(1);

const nav = fileURLToPath(TARGETS[1].url);
if (at("--cache") >= 0) {
    const dir = fileURLToPath(NAVIGATION_CACHE);
    mkdirSync(dir, { recursive: true });
    copyFileSync(nav, join(dir, "nav.json"));
    writeFileSync(join(dir, ".complete"), "");
    console.log(`Cached the navigation in ${relative(process.cwd(), dir)}`);
} else if (publish) {
    copyFileSync(nav, join(publish, "nav.json"));
    console.log(
        `Published the navigation as ${relative(process.cwd(), join(publish, "nav.json"))}`,
    );
} else if (check) {
    console.log("data/roster.json and static/nav.json are current.");
}
