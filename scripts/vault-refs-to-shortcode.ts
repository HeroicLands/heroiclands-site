#!/usr/bin/env ts-node
/**
 * One-shot migration: point the vault's cross-references at shortcodes.
 *
 * Fields like `capital`, `parent.polities` and `languages` name other notes by
 * **slug** — the segment those notes are published under. That made a URL the
 * join key, so retitling a settlement quietly emptied the "Capital" row of
 * every polity naming it: Hugo's `where` yields nothing for an unmatched value
 * and reports no error, so the row simply vanished. Shortcodes are identity and
 * survive a rename, so the references move onto them (#1388).
 *
 * This runs **once, deliberately, by the maintainer** — the same courtesy the
 * alias seeder extends. Nothing in the build writes to the vault; a check may
 * report, never rewrite. It is safe to re-run: an already-converted value
 * resolves to the same note and is left alone.
 *
 * Values it cannot resolve are **left exactly as they are** and listed at the
 * end. Most are already-dangling references that name a note the vault does not
 * contain, and inventing a shortcode for them would bury a real content bug.
 *
 * Usage:
 *   npx ts-node scripts/vault-refs-to-shortcode.ts              # dry run (default)
 *   npx ts-node scripts/vault-refs-to-shortcode.ts --write      # apply
 *   npx ts-node scripts/vault-refs-to-shortcode.ts --verbose    # list every change
 *   VAULT_ROOT=/path/to/vault npx ts-node scripts/vault-refs-to-shortcode.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    findNotes,
    joinNote,
    readFrontMatter,
    rewriteFrontMatter,
    splitNote,
} from "./vault-frontmatter";
import {
    IndexedNote,
    refFieldAt,
    resolveRef,
    subtypeOf,
} from "./vault-identity";

const VAULT_ROOT =
    process.env.VAULT_ROOT || path.join(os.homedir(), "dev/github/HeroicLands");

const WRITE = process.argv.includes("--write");
const VERBOSE = process.argv.includes("--verbose");

interface Unresolved {
    file: string;
    field: string;
    value: string;
}

function main(): void {
    if (!fs.existsSync(VAULT_ROOT)) {
        console.error(`Vault not found at ${VAULT_ROOT}`);
        console.error(`Set VAULT_ROOT to the vault's location.`);
        process.exit(1);
    }

    console.log(`Vault: ${VAULT_ROOT}`);
    console.log(WRITE ? "Mode:  WRITE\n" : "Mode:  dry run (pass --write to apply)\n");

    const files = findNotes(VAULT_ROOT);

    // ── Index every note by both of its names ──────────────────────
    const bySlug = new Map<string, IndexedNote[]>();
    const byShortcode = new Map<string, IndexedNote[]>();
    const parsed = new Map<string, Record<string, any>>();

    for (const file of files) {
        let text: string;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            continue;
        }
        const fm = readFrontMatter(text);
        if (!fm) continue;
        parsed.set(file, fm);

        const note: IndexedNote = {
            file: path.relative(VAULT_ROOT, file),
            slug: typeof fm.slug === "string" ? fm.slug : null,
            shortcode: typeof fm.shortcode === "string" ? fm.shortcode : null,
            subtype: subtypeOf(fm),
            name: fm.name?.full || fm.title || path.basename(file, ".md"),
        };
        if (note.slug) push(bySlug, note.slug, note);
        if (note.shortcode) push(byShortcode, note.shortcode, note);
    }

    console.log(
        `Indexed ${parsed.size} notes — ${bySlug.size} slugs, ${byShortcode.size} shortcodes.\n`,
    );

    // ── Rewrite ────────────────────────────────────────────────────
    let filesChanged = 0;
    let valuesChanged = 0;
    let alreadyConverted = 0;
    const unresolved: Unresolved[] = [];
    const noShortcode: Unresolved[] = [];

    for (const file of files) {
        const fm = parsed.get(file);
        if (!fm) continue;
        const text = fs.readFileSync(file, "utf8");
        const split = splitNote(text);
        if (!split) continue;
        const rel = path.relative(VAULT_ROOT, file);

        const { text: nextFm, changed } = rewriteFrontMatter(
            split.frontMatter,
            (line) => {
                const field = refFieldAt(line.path);
                if (!field) return null;
                const fieldName = field.path.join(".");

                const target = resolveRef(line.value!, field, bySlug, byShortcode);
                if (!target) {
                    unresolved.push({ file: rel, field: fieldName, value: line.value! });
                    return null;
                }
                if (!target.shortcode) {
                    // The target exists but has no identity to point at. Leave
                    // the slug in place: it is the only handle there is.
                    noShortcode.push({
                        file: rel,
                        field: fieldName,
                        value: line.value!,
                    });
                    return null;
                }
                if (target.shortcode === line.value) {
                    alreadyConverted++;
                    return null;
                }
                if (VERBOSE) {
                    console.log(
                        `  ${rel}: ${fieldName}  ${line.value} → ${target.shortcode}  (${target.subtype})`,
                    );
                }
                valuesChanged++;
                return target.shortcode;
            },
        );

        if (changed === 0) continue;
        filesChanged++;
        if (WRITE) {
            fs.writeFileSync(file, joinNote({ ...split, frontMatter: nextFm }), "utf8");
        }
    }

    // ── Report ─────────────────────────────────────────────────────
    console.log(
        `\n${WRITE ? "Converted" : "Would convert"} ${valuesChanged} value(s) across ${filesChanged} file(s).`,
    );
    if (alreadyConverted > 0) {
        console.log(`${alreadyConverted} value(s) already name a shortcode — left as-is.`);
    }

    report(
        "Unresolved — no note carries this slug or shortcode (left unchanged)",
        unresolved,
    );
    report(
        "Target has no shortcode — nothing to point at (left unchanged)",
        noShortcode,
    );

    if (!WRITE) {
        console.log(`\nDry run: nothing written. Re-run with --write to apply.`);
    }
}

function push(map: Map<string, IndexedNote[]>, key: string, note: IndexedNote): void {
    const list = map.get(key);
    if (list) list.push(note);
    else map.set(key, [note]);
}

function report(title: string, rows: Unresolved[]): void {
    if (rows.length === 0) return;
    console.log(`\n${title}: ${rows.length}`);
    // Group by value so one missing note is one line, not forty.
    const byValue = new Map<string, Unresolved[]>();
    for (const r of rows) {
        const list = byValue.get(r.value);
        if (list) list.push(r);
        else byValue.set(r.value, [r]);
    }
    for (const [value, hits] of [...byValue].sort()) {
        const fields = [...new Set(hits.map((h) => h.field))].join(", ");
        console.log(
            `  ${value}  (${fields}) — ${hits.length} reference(s), e.g. ${hits[0].file}`,
        );
    }
}

main();
