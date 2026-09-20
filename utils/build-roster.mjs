/**
 * Write `data/roster.json`, `config/_default/menus.toml` and `static/nav.json`
 * from `roster.mjs`, or check that all three are current.
 *
 * `roster.mjs` is the one authored list of packages HeroicLands publishes,
 * carrying the reasoning a generated file cannot. This script projects it into
 * the three formats the build and its consumers read natively: `data/*.json`
 * and `static/*` for Hugo, and a dedicated `config/_default/menus.toml` for
 * this site's own header menu; `hugo.toml` carries no `[menu]` of its own.
 *
 * The projections are **committed**, not built at deploy time. `deploy.yml`
 * runs Hugo and nothing else, so a data file produced by a build step would
 * have to add one — and a step that only ever runs on `main` is a step whose
 * failure is discovered by the deploy it was meant to protect
 * (heroiclands-site#27). A committed copy is readable in review and is
 * checked on the pull request instead, which is the trade every other
 * generated artifact here makes.
 *
 * A committed copy can go stale, so it is the check below that makes this
 * safe rather than the convention. `worker/test/roster.test.mjs` asserts the
 * same thing for `data/roster.json`, so the suite the pull request already
 * runs fails on a stale copy even if nobody runs this script.
 *
 * Usage:
 *   node utils/build-roster.mjs            # write all three files
 *   node utils/build-roster.mjs --check    # fail if any is not what would be written
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { renderDataFile, renderMenusFile, renderNavFile } from "../roster.mjs";

/** Every derived file, and how to render it. */
const TARGETS = [
    { url: new URL("../data/roster.json", import.meta.url), render: renderDataFile },
    {
        url: new URL("../config/_default/menus.toml", import.meta.url),
        render: renderMenusFile,
    },
    { url: new URL("../static/nav.json", import.meta.url), render: renderNavFile },
];

const check = process.argv.slice(2).includes("--check");
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
            console.error(`${rel} is missing.\nRun: npm run roster`);
            stale = true;
            continue;
        }

        if (actual !== expected) {
            console.error(`${rel} does not match roster.mjs.\nRun: npm run roster`);
            stale = true;
        }
    } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(url, expected);
        console.log(`Wrote ${path}`);
    }
}

if (check) {
    if (stale) process.exit(1);
    console.log(
        "data/roster.json, config/_default/menus.toml and static/nav.json are current.",
    );
}
