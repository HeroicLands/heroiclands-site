/**
 * The keys of `package-build.config.yaml`'s `site` block the router's suite
 * checks against, read without a YAML parser.
 *
 * The Worker has no dependencies and its suite runs where nothing is
 * installed, so the few keys it needs are read by their shapes: a mapping of
 * one-word keys (`sections`), a one-word value (`feed`), a boolean (`tags`)
 * and a flow list (`sitemaps`, `mergeIndexes`). A key in any other shape is
 * reported as missing, which fails the test that reads it.
 */

import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../../package-build.config.yaml", import.meta.url), "utf8");

/** The `site` block's own lines, at their indentation under it. */
const site = (() => {
    const at = text.search(/^site:\s*$/m);
    if (at < 0) return "";
    const rest = text.slice(at).split("\n").slice(1);
    const end = rest.findIndex((line) => /^\S/.test(line));
    return rest.slice(0, end < 0 ? rest.length : end).join("\n");
})();

/** A one-word value of the `site` block, or `undefined`. */
function scalar(key) {
    return new RegExp(`^ {4}${key}: *([\\w-]+) *$`, "m").exec(site)?.[1];
}

/** A flow list of the `site` block, or `undefined`. */
function list(key) {
    const found = new RegExp(`^ {4}${key}: *\\[([^\\]]*)\\]`, "m").exec(site);
    return found ?
            found[1]
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
        :   undefined;
}

/** `site.sections`, as `{name: address}`, or `undefined`. */
function sections() {
    const found = /^ {4}sections: *\n((?: {8}[\w-]+: *[\w-]+ *\n)+)/m.exec(`${site}\n`);
    if (!found) return undefined;
    return Object.fromEntries(
        found[1]
            .trim()
            .split("\n")
            .map((line) => line.trim().split(/: */)),
    );
}

export const SITE = Object.freeze({
    sections: sections(),
    feed: scalar("feed"),
    tags: scalar("tags") === "true",
    sitemaps: list("sitemaps"),
    mergeIndexes: list("mergeIndexes"),
});

/**
 * Every top-level section the site publishes: each of `site.sections`, the
 * section `site.feed` names, and `tags` when `site.tags` is on.
 *
 * @returns {string[]} The sections.
 */
export function publishedSections() {
    return [
        ...new Set([
            ...Object.keys(SITE.sections ?? {}),
            ...(SITE.feed ? [SITE.feed] : []),
            ...(SITE.tags ? ["tags"] : []),
        ]),
    ];
}
