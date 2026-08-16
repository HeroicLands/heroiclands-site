#!/usr/bin/env ts-node
/**
 * Assert that this site derives a page's URL by exactly the SoHL rule.
 *
 * `scripts/content-slug.ts` is a **port**. The rule it implements is defined in
 * the SoHL system repository (`utils/content-slug.mjs`), which derives the same
 * URLs for the compendium packs and the knowledgebase. Two copies of one rule
 * is how the site and the system came to disagree about a page's address in the
 * first place, so the copies are pinned to each other here until #1390 folds
 * them into a single exporter.
 *
 * The vectors below are the system repository's own
 * (`tests/build/content-slug.test.ts`), verbatim. They are the cases the rule
 * exists for — transliteration, apostrophes, ligatures, vulgar fractions — so a
 * port that satisfies all of them is the same rule, and a port that stops
 * satisfying one has drifted. The two implementations were additionally
 * confirmed to agree on all 3073 distinct names in the vault.
 *
 * Runs as part of `npm run build`.
 *
 * Usage:
 *   npx ts-node scripts/check-slug-rule.ts
 */

import { contentSlug } from "./content-slug";

/** `[name, expected URL segment]`, from the system repository's test suite. */
const VECTORS: readonly [string, string][] = [
    // Plain names
    ["Mail Byrnie", "mail-byrnie"],
    ["Russet Robe", "russet-robe"],
    // Apostrophes are removed, not treated as separators
    ["Armorer's Kit", "armorers-kit"],
    ["Dye, Dragon’s Blood", "dye-dragons-blood"],
    // Accents are transliterated, not dropped
    ["Nüsvōrroth", "nusvorroth"],
    ["Ālverrik Tārvallor", "alverrik-tarvallor"],
    ["Tānvüran Elephant", "tanvuran-elephant"],
    // Ligatures expand the way a reader would spell them out
    ["Þorn Þegn", "thorn-thegn"],
    ["Ærik Ælfwine", "aerik-aelfwine"],
    ["Œuvre", "oeuvre"],
    ["Straße", "strasse"],
    ["ĲsseImeer", "ijsseimeer"],
    ["Ŋara", "ngara"],
    ["Óðinn", "odinn"],
    ["Ølrún Åsa", "olrun-asa"],
    // A vulgar fraction keeps its digits together
    ["Kûrbúl ¾-Helm", "kurbul-34-helm"],
    ["Plate ½-Helm", "plate-12-helm"],
    // A solidus between non-digits is an ordinary separator
    ["Armor/Clothing", "armor-clothing"],
    // Punctuation, padding and trim
    ["Flask, glass (1 pint)", "flask-glass-1-pint"],
    ["  Spaced  Out  ", "spaced-out"],
    ["-Trim-", "trim"],
];

/** Names that cannot address a page, and must be rejected rather than defaulted. */
const REJECTED: readonly string[] = ["", "   ", "——", "!!!"];

function main(): void {
    const failures: string[] = [];

    for (const [name, expected] of VECTORS) {
        let actual: string;
        try {
            actual = contentSlug(name);
        } catch (err) {
            failures.push(`  ${JSON.stringify(name)} → threw (${err}), expected "${expected}"`);
            continue;
        }
        if (actual !== expected) {
            failures.push(
                `  ${JSON.stringify(name)} → "${actual}", expected "${expected}"`,
            );
        }
    }

    for (const name of REJECTED) {
        let actual: string | null = null;
        try {
            actual = contentSlug(name);
        } catch {
            continue; // rejected, as it must be
        }
        failures.push(
            `  ${JSON.stringify(name)} → "${actual}", expected it to be rejected`,
        );
    }

    if (failures.length > 0) {
        console.error(
            `✗ The URL rule has drifted from the SoHL system repository's utils/content-slug.mjs:`,
        );
        failures.forEach((f) => console.error(f));
        console.error(
            `\nReconcile scripts/content-slug.ts with utils/content-slug.mjs before building.`,
        );
        process.exit(1);
    }

    console.log(
        `✓ URL rule matches the SoHL system repository (${VECTORS.length} vectors, ${REJECTED.length} rejections).`,
    );
}

main();
