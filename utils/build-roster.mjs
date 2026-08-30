/**
 * Write `data/roster.json` from `roster.mjs`, or check that it is current.
 *
 * Hugo reads `data/*.json` natively and cannot read a JavaScript module; a
 * JavaScript module can carry the reasoning behind every entry and JSON cannot.
 * So the roster is authored where the prose can live and projected into the
 * format the site build reads — with the derivable parts (each package's prefix,
 * and its dependents) resolved on the way through, so a template does no reverse
 * lookup.
 *
 * The projection is **committed**, not built at deploy time. `deploy.yml` runs
 * Hugo and nothing else, so a data file produced by a build step would have to
 * add one — and a step that only ever runs on `main` is a step whose failure is
 * discovered by the deploy it was meant to protect (heroiclands-site#27). A
 * committed copy is readable in review and is checked on the pull request
 * instead, which is the trade every other generated artifact here makes.
 *
 * A committed copy can go stale, so it is the check below that makes this safe
 * rather than the convention. `worker/test/roster.test.mjs` asserts the same
 * thing, so the suite the pull request already runs fails on a stale copy even
 * if nobody runs this script.
 *
 * Usage:
 *   node utils/build-roster.mjs            # write data/roster.json
 *   node utils/build-roster.mjs --check    # fail if it is not what would be written
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderDataFile } from "../roster.mjs";

/** Where the projection is written, relative to this file. */
const OUT = new URL("../data/roster.json", import.meta.url);

const check = process.argv.slice(2).includes("--check");
const expected = renderDataFile();
const path = fileURLToPath(OUT);

if (check) {
    let actual;
    try {
        actual = readFileSync(OUT, "utf8");
    } catch {
        console.error("data/roster.json is missing.\nRun: npm run roster");
        process.exit(1);
    }

    if (actual !== expected) {
        console.error(
            "data/roster.json does not match roster.mjs.\nRun: npm run roster",
        );
        process.exit(1);
    }

    console.log("data/roster.json is current.");
} else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(OUT, expected);
    console.log(`Wrote ${path}`);
}
