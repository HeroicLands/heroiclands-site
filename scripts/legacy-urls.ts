/**
 * The record of where pages used to be published.
 *
 * A page's address used to be an authored `slug` in its front matter. #1389
 * removes that property and derives the URL from the note's name instead, which
 * moves 238 pages. Their previous addresses exist nowhere else — deleting the
 * property destroys the only copy — so they are captured first, committed as
 * source, and read back here.
 *
 * Two consumers, both of which would otherwise break silently:
 *
 * - **Redirects.** Each recorded URL becomes a Hugo alias on the page that
 *   moved, so existing links and bookmarks still land.
 * - **Artwork.** Character and creature portraits are CDN objects named after
 *   the slug the page had when the image was uploaded
 *   (`/images/<slug>.webp`). Deriving a new URL does not rename a file on a
 *   CDN, so the sidebars keep asking for the recorded name.
 *
 * Keyed `type:shortcode` — identity, the one handle neither a rename nor the
 * slug removal disturbs — matching `kb/data/legacy-slugs.json` in the SoHL
 * system repository, which records the same history for the knowledgebase.
 *
 * This file is **committed and never regenerated from scratch**. An address it
 * records was real and may still be linked; a capture run merges into it.
 *
 * The module and the data it reads are named differently on purpose: Node
 * resolves `./legacy-slugs` to `legacy-slugs.json` before `legacy-slugs.ts`,
 * so a matching pair silently imports the data file and every function comes
 * back undefined.
 */

import * as fs from "fs";
import * as path from "path";

/** Where the committed record lives. */
export const LEGACY_SLUGS_PATH = path.join(__dirname, "legacy-slugs.json");

/**
 * Read the committed record.
 *
 * @returns `type:shortcode` → the page's previous URL. Empty when the record
 *   does not exist yet, which is the state before the first capture.
 */
export function readLegacySlugs(): Record<string, string> {
    if (!fs.existsSync(LEGACY_SLUGS_PATH)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(LEGACY_SLUGS_PATH, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
        // Refuse to continue rather than publish without redirects: an
        // unreadable record looks exactly like an empty one, and silently
        // dropping every redirect is the failure this file exists to prevent.
        throw new Error(
            `${LEGACY_SLUGS_PATH} is not readable JSON (${err}). ` +
                `It is the only record of where pages used to be published — ` +
                `fix or restore it rather than deleting it.`,
        );
    }
}

/**
 * The key one page is recorded under.
 *
 * Identity — `type:shortcode` — wherever there is one, because it is the handle
 * that survives both a rename and the slug removal.
 *
 * The site's own landing pages have neither. `Projects/HM3.md` and its siblings
 * are hand-authored pages, not content notes, and they are among the most
 * publicly linked URLs the site has (`/projects/hm3/`, `/projects/sohl.md/`).
 * They are keyed by vault path instead, which is every bit as durable for a
 * page whose address is mirrored from that path.
 *
 * @param fm - The page's front matter.
 * @param vaultPath - Its path relative to the vault root.
 */
export function legacyKey(
    fm: Record<string, any>,
    vaultPath: string,
): string {
    const type = typeof fm.type === "string" ? fm.type.toLowerCase() : "";
    const shortcode = typeof fm.shortcode === "string" ? fm.shortcode : "";
    if (type && shortcode) return `${type}:${shortcode}`;
    return `path:${vaultPath.split(path.sep).join("/")}`;
}

/**
 * The last segment of a recorded URL — the slug the page used to publish under,
 * and so the name its CDN artwork was uploaded as.
 *
 * @param url - A recorded URL, e.g. `/thalorna/character/groa-vindrkve/`.
 * @returns The segment, or `""` when the URL has none.
 */
export function slugOfUrl(url: string): string {
    const parts = url.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : "";
}
