/**
 * What identifies a content note, and which front-matter fields point at one.
 *
 * A note has two names and they do different jobs. Its **shortcode** is
 * identity: `(type, shortcode)` is unique by rule, it is what saved Foundry
 * world data refers to, and it does not change when the note is retitled. Its
 * **slug** is presentation: the segment its URL is published under, which
 * should read like prose and is free to change whenever the title improves.
 *
 * Cross-page references used to join on the slug, which put presentation in
 * the load-bearing position: renaming a settlement silently emptied the
 * "Capital" row of every polity that named it, because Hugo's `where` returns
 * an empty result for a value nothing matches and reports no error (#1388).
 * References join on the shortcode instead, and this module is the one place
 * that says which fields are references and what they point at.
 */

// `subtypeOf` is the same collapse the theme's `single.html` makes, and it
// already lives in vault-frontmatter.ts. Re-exported here so a caller resolving
// references has one import, not two, and so the two can never fork.
export { subtypeOf } from "./vault-frontmatter";

/**
 * A front-matter field whose values name other notes.
 *
 * `path` is the field's position from the front-matter root, so
 * `["parent", "regions"]` targets a region list nested under `parent:` without
 * also matching a top-level `regions:`.
 *
 * `expect` lists the subtypes a value may legitimately resolve to, best first.
 * It exists because slugs are only unique by accident: the vault holds four
 * duplicate slugs today, and `kalihara` names both a polity and a continent —
 * so `parent.continents: [kalihara]` currently resolves to the *polity* and
 * renders a continent row linking to itself. Preferring the expected subtype
 * resolves that correctly.
 *
 * Several entries list more than one subtype, and those are not hedges: a
 * handful of language notes are typed `skill` or filed under `lore`, and those
 * are the real targets, so the reference must be allowed to reach them.
 */
export interface RefField {
    /** Position from the front-matter root, outermost key first. */
    path: string[];
    /** Subtypes a value may resolve to, most-expected first. */
    expect: string[];
}

/**
 * Every front-matter field the theme resolves to another page.
 *
 * Deliberately *not* included, though they look similar:
 *
 * - `peoples` — the polity infobox humanises these rather than linking them,
 *   and only 14 of 132 values name a note at all; the rest are plain words
 *   like `human`. It is a label list, not a reference list, until #1427 makes
 *   it one.
 * - `thalorna.faith` — retired outright rather than migrated (#1419). A
 *   character's religion is an affiliation they hold, recorded in
 *   `sohl.items`, because standing in a body is not a property of the person.
 * - `deity`, `demonym`, `domain`, `epithet`, `symbol`, `settlementType`,
 *   `subType`, `government.*`, `ruler.*`, `terran_analog` — free-text display
 *   values. They resolve against nothing and are rendered verbatim.
 * - `parent.polity`, `parent.region`, `parent.organization` — singular
 *   misspellings of the plural fields, on four notes between them. Nothing
 *   reads them, so converting them would only make dead data look live.
 */
export const REF_FIELDS: readonly RefField[] = [
    { path: ["capital"], expect: ["settlement"] },
    { path: ["languages"], expect: ["language", "skill", "lore"] },
    // Every organized body is an affiliation and nothing else — there is no
    // `pantheon` subtype, and no religion is a `doc` (#1419).
    { path: ["pantheons"], expect: ["affiliation"] },
    { path: ["pantheon"], expect: ["affiliation"] },
    { path: ["world"], expect: ["world"] },
    { path: ["parent", "polities"], expect: ["polity"] },
    { path: ["parent", "regions"], expect: ["region"] },
    { path: ["parent", "continents"], expect: ["continent"] },
    // Read by the character sidebar, which renders each as a link. `expect` is
    // load-bearing here rather than a tie-breaker: `kalihara` names a polity
    // and no region, so an unnarrowed region lookup resolves to the country.
    { path: ["thalorna", "realm"], expect: ["polity"] },
    { path: ["thalorna", "region"], expect: ["region"] },
];

/** Whether a scanned front-matter line sits at a reference field. */
export function refFieldAt(path: string[]): RefField | undefined {
    return REF_FIELDS.find(
        (f) =>
            f.path.length === path.length &&
            f.path.every((seg, i) => seg === path[i]),
    );
}

/** One note, as the resolver needs to see it. */
export interface IndexedNote {
    /** Path relative to the vault root, for reporting. */
    file: string;
    slug: string | null;
    shortcode: string | null;
    subtype: string;
    /** `name.full`, falling back to the note's title. */
    name: string;
}

/**
 * Resolve a reference value to the note it names.
 *
 * @param value - The authored value: a slug before the migration, a shortcode
 *   after it. Both are accepted so the migration is safely re-runnable and a
 *   half-converted tree still resolves.
 * @param field - The field the value came from, whose `expect` breaks ties.
 * @param bySlug - Slug → every note carrying it.
 * @param byShortcode - Shortcode → every note carrying it.
 * @returns The note, or `null` when nothing matches or the match is ambiguous
 *   even after preferring the expected subtypes.
 */
export function resolveRef(
    value: string,
    field: RefField,
    bySlug: Map<string, IndexedNote[]>,
    byShortcode: Map<string, IndexedNote[]>,
): IndexedNote | null {
    const maps = [byShortcode.get(value) ?? [], bySlug.get(value) ?? []];

    // A match of the expected subtype wins over any unexpected one, whichever
    // map it came from. This is what makes `parent.continents: [kalihara]`
    // reach the continent rather than the like-slugged polity, and what keeps
    // a slug from being captured by an unrelated note's identical shortcode.
    for (const expected of field.expect) {
        for (const candidates of maps) {
            const hits = candidates.filter((n) => n.subtype === expected);
            if (hits.length === 1) return hits[0];
            // Two notes of one subtype share the value: report rather than
            // pick, since picking would be a coin flip.
            if (hits.length > 1) return null;
        }
    }

    // No expected subtype matched. Accept an unambiguous match anyway — the
    // subtype lists cannot anticipate every way the vault files a note — but
    // never guess between several.
    for (const candidates of maps) {
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1) return null;
    }
    return null;
}
