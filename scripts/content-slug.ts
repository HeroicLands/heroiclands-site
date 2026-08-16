/**
 * The URL segment of a content note — derived from its name.
 *
 * Content notes carry no authored `slug` (#1389): it was a hand-maintained
 * second spelling of something already determined, free to drift from the page
 * it named, and it was the reason this site and the SoHL system repository
 * disagreed about where a page lives. The URL is derived instead.
 *
 * It is derived from the **name**, deliberately not from the `shortcode`, even
 * though `(type, shortcode)` is unique by rule and would be a tempting key. A
 * shortcode is *identity*: it is referenced from saved world data — actions,
 * cohorts, expressions, archetypes, pack lookups — so binding the public URL to
 * it would make a cosmetic URL change into a data migration. A URL is
 * presentation, and it should read like one (`/creature/nusvorroth/`, not
 * `/creature/nsvrroth/`). Renames are what a URL must survive, and they do:
 * every change is recorded in `legacy-slugs.json`, which emits a redirect.
 *
 * **This is a port, and it must not drift.** The rule is defined in the SoHL
 * system repository as `utils/content-slug.mjs`, which derives the same URLs
 * for the compendium packs and the knowledgebase. The two are verified to agree
 * across every name in the vault. Folding them into one implementation is
 * #1390's job; until then, a change here is a change there.
 */

import unidecode = require("unidecode");

/**
 * The URL segment for one content note.
 *
 * The name is **transliterated** before it is reduced, so an accented character
 * is carried across rather than dropped — dropping is what turned `Nüsvōrroth`
 * into `n-sv-rroth` and forced a hand-written slug in the first place.
 *
 * Two reductions are ours rather than the transliterator's:
 *
 * - **apostrophes are removed**, not treated as separators (`Armorer's Kit` →
 *   `armorers-kit`), matching the URLs these pages already publish at;
 * - **a fraction keeps its digits together** — a vulgar fraction expands to
 *   `3/4`, and the solidus would otherwise split it into `3-4`, so a slash
 *   *between digits* is closed up (`Kûrbúl ¾-Helm` → `kurbul-34-helm`).
 *
 * @param name - The note's display name (`name.full`), which a malformed note
 *   may not have at all.
 * @returns The URL segment (never empty).
 * @throws When there is no name, or the name carries no URL-safe characters —
 *   either way the note cannot be addressed, which is a content error rather
 *   than something to paper over with a fallback.
 */
export function contentSlug(name: string | undefined): string {
    const raw = typeof name === "string" ? name.trim() : "";
    if (!raw) {
        throw new Error("content note has no name, so it has no URL");
    }
    const slug = unidecode(raw)
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/(\d)\/(\d)/g, "$1$2")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (!slug) {
        throw new Error(
            `name "${raw}" has no URL-safe characters, so it cannot address a page`,
        );
    }
    return slug;
}
