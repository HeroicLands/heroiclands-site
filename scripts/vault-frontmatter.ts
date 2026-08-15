/**
 * Reading and surgically rewriting a vault note's YAML front matter.
 *
 * The vault is hand-authored in Obsidian, so a rewrite must be *surgical*.
 * Loading the front matter with js-yaml and dumping it back would reformat
 * every note in the tree — reordering keys, restyling quotes, collapsing the
 * author's line breaks — and bury the one-line change we actually intended in
 * a 3000-file diff nobody can review. So the value edits here are made against
 * the front matter **text**, line by line, and every byte we did not target is
 * returned exactly as it was found.
 *
 * Shared by the one-shot migrations that run against the vault
 * (`vault-refs-to-shortcode.ts`, `vault-drop-slug.ts`), which is why it lives
 * apart from either of them.
 */

import * as fs from "fs";
import * as yaml from "js-yaml";

/** A note's front matter, split from its body but not yet interpreted. */
export interface SplitNote {
    /** The text between the `---` fences, without either fence. */
    frontMatter: string;
    /** Everything after the closing fence, verbatim. */
    body: string;
    /** The line ending the file uses, so a rewrite preserves it. */
    eol: "\n" | "\r\n";
}

/**
 * Split a note into front matter and body.
 *
 * @param text - The whole file.
 * @returns The split, or `null` when the file has no front-matter block —
 *   which is not an error: vault scaffolding and prose notes legitimately
 *   have none, and a caller skips them.
 */
export function splitNote(text: string): SplitNote | null {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    // The opening fence must be the very first line; a `---` further down is a
    // horizontal rule in the body, not a front-matter delimiter.
    const fence = `---${eol}`;
    if (!text.startsWith(fence)) return null;
    const close = text.indexOf(`${eol}---`, fence.length - eol.length);
    if (close === -1) return null;
    const frontMatter = text.slice(fence.length, close + eol.length);
    const body = text.slice(close + eol.length + 3);
    return { frontMatter, body, eol };
}

/** Reassemble a split note into file text. */
export function joinNote(note: SplitNote): string {
    return `---${note.eol}${note.frontMatter}---${note.body}`;
}

/**
 * Parse a note's front matter into a plain object.
 *
 * @param text - The whole file.
 * @returns The parsed front matter, or `null` when there is none or it does
 *   not parse. A malformed note is reported by the caller rather than thrown
 *   on, so one bad file cannot abort a whole-tree pass.
 */
export function readFrontMatter(text: string): Record<string, any> | null {
    const split = splitNote(text);
    if (!split) return null;
    try {
        const data = yaml.load(split.frontMatter);
        return data && typeof data === "object" ? (data as Record<string, any>) : null;
    } catch {
        return null;
    }
}

/** Read and parse a note from disk, returning `null` on any failure. */
export function readNote(
    filepath: string,
): { text: string; fm: Record<string, any> } | null {
    let text: string;
    try {
        text = fs.readFileSync(filepath, "utf8");
    } catch {
        return null;
    }
    const fm = readFrontMatter(text);
    return fm ? { text, fm } : null;
}

/** Every `.md` file under `root`, skipping VCS and editor scaffolding. */
export function findNotes(root: string): string[] {
    const SKIP = new Set([".git", ".obsidian", ".trash", "node_modules", "nogit"]);
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(e.name)) continue;
            const p = `${dir}/${e.name}`;
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".md")) out.push(p);
        }
    };
    walk(root);
    return out.sort();
}

/**
 * One line of front matter, located by its path from the document root.
 *
 * `path` names the mapping keys enclosing the line, outermost first. A scalar
 * `capital: qasirah` inside no parent is `["capital"]`; the `- tzuma-notun`
 * under `parent:` → `polities:` is `["parent", "polities"]`. That is what lets
 * a caller target `parent.regions` without also matching a top-level
 * `regions:`.
 */
export interface FrontMatterLine {
    /** Index into the array returned by {@link scanFrontMatter}. */
    index: number;
    /** Enclosing mapping keys, outermost first. */
    path: string[];
    /** `true` when the line is a `- item` sequence entry. */
    isSequenceItem: boolean;
    /**
     * The scalar this line carries, unquoted — the value of a `key: value`
     * line or the item of a `- value` line. `null` when the line opens a block
     * (`key:` with nothing after it), is a comment, or is blank.
     */
    value: string | null;
}

/**
 * Reduce a raw scalar to its value: drop a trailing comment, then one layer of
 * matching quotes.
 *
 * YAML only reads `#` as a comment when whitespace precedes it, which is what
 * keeps a value like `Nu#3` intact. Quoted scalars are taken whole, since a
 * `#` inside quotes is content.
 */
function unquote(raw: string): string {
    const s = raw.trim();
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'")) {
        const close = s.lastIndexOf(s[0]);
        if (close > 0) return s.slice(1, close);
    }
    return s.replace(/\s+#.*$/, "").trim();
}

/**
 * Walk front-matter text and describe every line's position and scalar.
 *
 * An indent-aware scan rather than a YAML parse: the point is to know which
 * *line* holds a value, which a parse discards. It handles the shapes the
 * vault actually uses — nested mappings and sequences of scalars — and simply
 * reports `value: null` for anything else (flow collections, block scalars,
 * comments), so an unrecognised shape is skipped rather than mangled.
 *
 * @param frontMatter - The text between the fences.
 * @returns One entry per line, in order.
 */
export function scanFrontMatter(frontMatter: string): FrontMatterLine[] {
    const lines = frontMatter.split(/\r?\n/);
    const out: FrontMatterLine[] = [];
    // Enclosing mapping keys and the indent each was declared at.
    const stack: { indent: number; key: string }[] = [];

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            out.push({ index, path: [], isSequenceItem: false, value: null });
            return;
        }
        const indent = line.length - line.trimStart().length;

        if (trimmed.startsWith("- ") || trimmed === "-") {
            // A sequence item belongs to the mapping key that opened the
            // block, so the stack is left as the key's own line set it.
            const rest = trimmed === "-" ? "" : trimmed.slice(2);
            out.push({
                index,
                path: stack.map((s) => s.key),
                isSequenceItem: true,
                // `- key: value` is a mapping inside a sequence, not a scalar
                // item; leave it alone.
                value: rest && !/^[\w.-]+:(\s|$)/.test(rest) ? unquote(rest) : null,
            });
            return;
        }

        const m = /^([^:#]+):(.*)$/.exec(trimmed);
        if (!m) {
            out.push({ index, path: [], isSequenceItem: false, value: null });
            return;
        }
        const key = m[1].trim();
        const rest = m[2].trim();

        // Pop every enclosing key declared at this indent or deeper: they
        // closed when a sibling or shallower key appeared.
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

        if (rest === "") {
            // Opens a nested mapping or sequence block.
            out.push({
                index,
                path: [...stack.map((s) => s.key), key],
                isSequenceItem: false,
                value: null,
            });
            stack.push({ indent, key });
            return;
        }

        out.push({
            index,
            path: [...stack.map((s) => s.key), key],
            isSequenceItem: false,
            // Flow collections (`[a, b]`, `{a: 1}`) are not scalars; the vault
            // does not use them for the fields we rewrite, so report nothing
            // rather than guess at their contents.
            value: /^[[{]/.test(rest) ? null : unquote(rest),
        });
    });

    return out;
}

/**
 * Rewrite selected scalars in a front-matter block, leaving all else byte-identical.
 *
 * @param frontMatter - The text between the fences.
 * @param replace - Called for every line carrying a scalar. Return the
 *   replacement scalar, or `null`/`undefined` to leave the line untouched.
 * @returns The rewritten text and the number of lines changed.
 */
export function rewriteFrontMatter(
    frontMatter: string,
    replace: (line: FrontMatterLine) => string | null | undefined,
): { text: string; changed: number } {
    const eol = frontMatter.includes("\r\n") ? "\r\n" : "\n";
    const lines = frontMatter.split(/\r?\n/);
    const scanned = scanFrontMatter(frontMatter);
    let changed = 0;

    for (const entry of scanned) {
        if (entry.value === null) continue;
        const next = replace(entry);
        if (next == null || next === entry.value) continue;

        const line = lines[entry.index];
        const indent = line.slice(0, line.length - line.trimStart().length);
        const quoted = needsQuoting(next) ? JSON.stringify(next) : next;

        if (entry.isSequenceItem) {
            const raw = line.trim().slice(2);
            lines[entry.index] = `${indent}- ${quoted}${trailingComment(raw)}`;
        } else {
            const m = /^([^:#]+):(.*)$/.exec(line.trim())!;
            lines[entry.index] =
                `${indent}${m[1].trim()}: ${quoted}${trailingComment(m[2])}`;
        }
        changed++;
    }

    // `frontMatter` ends with its final newline, so the split leaves a trailing
    // empty element that rejoins to reproduce it.
    return { text: lines.join(eol), changed };
}

/**
 * The trailing comment on a raw scalar, including its leading whitespace, so a
 * rewritten line can carry the author's note across. Empty when there is none.
 *
 * Only an *unquoted* scalar can be followed by a comment here: inside quotes a
 * `#` is content, and {@link unquote} keeps it.
 */
function trailingComment(rawScalar: string): string {
    const s = rawScalar.trim();
    if (s.startsWith('"') || s.startsWith("'")) return "";
    const m = /(\s+#.*)$/.exec(s);
    return m ? m[1] : "";
}

/**
 * Whether a scalar has to be quoted to survive a YAML round trip.
 *
 * Shortcodes are alphanumeric by rule (#1397), so in practice this never
 * fires — it is here so the helper stays correct if it is ever pointed at a
 * field whose values are not.
 */
function needsQuoting(value: string): boolean {
    if (value === "") return true;
    if (/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value) === false) return true;
    // Bare words YAML would read as something other than a string.
    return /^(true|false|null|yes|no|on|off|~)$/i.test(value) || /^-?\d/.test(value);
}
