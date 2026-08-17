#!/usr/bin/env ts-node
/**
 * Report which cross-page references resolve, and which name nothing.
 *
 * A reference that resolves to no note is not an error anywhere: Hugo's
 * `where` returns an empty result for a value nothing matches and reports
 * nothing, so the infobox falls through to its humanised-label branch and
 * prints the raw value in title case. When the authored value happens to read
 * like the thing it names — `aureldian-pantheon` humanises to "Aureldian
 * Pantheon" — the row looks exactly like the link it was standing in for, and
 * the breakage is invisible on the page. Every settlement and polity infobox
 * rendered such a row for months (#1419).
 *
 * So the only way to see the gap is to measure it. This walks the vault, joins
 * every field in {@link REF_FIELDS} against the note index, and prints what
 * resolves, what is still slug-valued, and what names nothing at all.
 *
 * Reporting only — it changes nothing and always exits 0. It is a measurement
 * tool, not a build gate: what it still reports is notes that have yet to be
 * written or are still drafts, and failing the build on a known gap in the
 * content would only mean nobody could build.
 *
 * Usage:
 *   npm run refs:report
 *   npm run refs:report -- --verbose     # list every unresolved value
 */

import * as path from "path";
import {
    REF_FIELDS,
    resolveRef,
    subtypeOf,
    type IndexedNote,
    type RefField,
} from "./vault-identity";
import { findNotes, noteName, readNote } from "./vault-frontmatter";

const VAULT_ROOT =
    process.env.VAULT_ROOT ||
    path.join(process.env.HOME || "/Users/tomr", "dev/github/HeroicLands");

const verbose = process.argv.includes("--verbose");

/** Read a value at a dotted path, tolerating a missing branch. */
function valueAt(fm: Record<string, any>, keys: string[]): unknown {
    let cur: any = fm;
    for (const k of keys) {
        if (!cur || typeof cur !== "object") return undefined;
        cur = cur[k];
    }
    return cur;
}

interface FieldReport {
    field: RefField;
    /** Values that reached a note by its shortcode — the intended join. */
    byShortcode: number;
    /** Values that reached a note only by its slug — still to migrate. */
    bySlug: number;
    /** Values that reached no note at all, or an ambiguous set. */
    unresolved: string[];
}

function main(): void {
    const bySlug = new Map<string, IndexedNote[]>();
    const byShortcode = new Map<string, IndexedNote[]>();
    const notes: { file: string; fm: Record<string, any> }[] = [];

    for (const file of findNotes(VAULT_ROOT)) {
        const note = readNote(file);
        if (!note || note.fm.draft === true) continue;
        const fm = note.fm;
        const rel = path.relative(VAULT_ROOT, file);
        notes.push({ file: rel, fm });

        const indexed: IndexedNote = {
            file: rel,
            slug: typeof fm.slug === "string" ? fm.slug : null,
            shortcode: typeof fm.shortcode === "string" ? fm.shortcode : null,
            subtype: subtypeOf(fm),
            name: noteName(fm, file),
        };
        if (indexed.slug) {
            bySlug.set(indexed.slug, [...(bySlug.get(indexed.slug) ?? []), indexed]);
        }
        if (indexed.shortcode) {
            byShortcode.set(indexed.shortcode, [
                ...(byShortcode.get(indexed.shortcode) ?? []),
                indexed,
            ]);
        }
    }

    const reports: FieldReport[] = REF_FIELDS.map((field) => ({
        field,
        byShortcode: 0,
        bySlug: 0,
        unresolved: [],
    }));

    for (const { fm } of notes) {
        for (const report of reports) {
            const raw = valueAt(fm, report.field.path);
            if (raw == null || raw === "") continue;
            const values = (Array.isArray(raw) ? raw : [raw]).filter(
                (v): v is string => typeof v === "string" && v !== "",
            );
            for (const value of values) {
                // A shortcode hit is the intended join; a slug-only hit still
                // reaches the page but breaks the moment the note is retitled.
                const isShortcode = byShortcode.has(value);
                const hit = resolveRef(value, report.field, bySlug, byShortcode);
                if (!hit) report.unresolved.push(value);
                else if (isShortcode) report.byShortcode++;
                else report.bySlug++;
            }
        }
    }

    console.log(`Scanned ${notes.length} publishable note(s) in ${VAULT_ROOT}\n`);
    const pad = Math.max(...reports.map((r) => r.field.path.join(".").length));
    console.log(
        `${"field".padEnd(pad)}  ${"shortcode".padStart(9)}  ${"slug".padStart(6)}  ${"unresolved".padStart(10)}`,
    );
    let slugTotal = 0;
    let unresolvedTotal = 0;
    for (const r of reports) {
        slugTotal += r.bySlug;
        unresolvedTotal += r.unresolved.length;
        console.log(
            `${r.field.path.join(".").padEnd(pad)}  ${String(r.byShortcode).padStart(9)}  ` +
                `${String(r.bySlug).padStart(6)}  ${String(r.unresolved.length).padStart(10)}`,
        );
        if (verbose && r.unresolved.length > 0) {
            const counts = new Map<string, number>();
            for (const v of r.unresolved) counts.set(v, (counts.get(v) ?? 0) + 1);
            for (const [v, n] of [...counts].sort((a, b) => b[1] - a[1])) {
                console.log(`      ${String(n).padStart(4)}  ${v}`);
            }
        }
    }

    console.log(
        `\n${slugTotal} value(s) still join on a slug, ${unresolvedTotal} name nothing at all.`,
    );
    // The two remainders have different causes and different fixes, so they are
    // reported apart rather than under one heading.
    if (slugTotal > 0) {
        console.log(
            "A slug is presentation and changes when a note is retitled, so a " +
                "slug-valued reference is a link waiting to break: migrate it " +
                "to the target's shortcode.",
        );
    }
    if (unresolvedTotal > 0) {
        console.log(
            "A value that names nothing is not a migration: there is no " +
                "shortcode to migrate it to. Either the note it names has yet " +
                "to be written, or it is still a draft and so unpublished. " +
                "Re-run with --verbose to see them.",
        );
    }
}

main();
