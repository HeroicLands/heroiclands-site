#!/usr/bin/env ts-node
/**
 * Clean all build artifacts and generated content.
 *
 * Removes:
 *   - Hugo build output (public/, resources/_gen/, .hugo_build.lock)
 *   - Generated bucket content trees produced by scripts/export-hugo.ts:
 *       content/world/       — worldbuilding (Worlds/Thalorna/)
 *       content/project/     — projects (Projects/Song_of_Heroic_Lands/, HM3/, Modules/)
 *       content/blog/        — blog posts
 *   - Legacy content/worldbuilding/ (from the pre-bucket pipeline)
 *
 * Preserves:
 *   - Hand-crafted content at the content root (e.g. content/_index.md)
 *     or under any directory not listed above
 *
 * Usage:
 *   npm run clean
 *   npm run clean -- --verbose   # log every path removed
 *   npm run clean -- --dry-run   # report what would be removed without removing
 */

import * as fs from "fs";
import * as path from "path";

// Top-level content directories that are fully managed by the export pipeline.
// Keep this list in sync with BUCKETS in export-hugo.ts (specifically, the
// first path segment of each bucket's hugoPath).
const GENERATED_CONTENT_ROOTS = [
    "content/world",
    "content/project",
    "content/blog",
    // Legacy path from the pre-bucket pipeline; kept here so that upgrading
    // to the new pipeline doesn't leave dangling output from the old one.
    "content/worldbuilding",
];

const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const verbose = args.includes("--verbose") || args.includes("-v");
const dryRun = args.includes("--dry-run") || args.includes("-n");

function removeIfPresent(target: string): void {
    const abs = path.isAbsolute(target) ? target : path.join(ROOT, target);
    if (!fs.existsSync(abs)) {
        if (verbose) console.log(`  skip (missing): ${path.relative(ROOT, abs)}`);
        return;
    }
    if (dryRun) {
        console.log(`  would remove: ${path.relative(ROOT, abs)}`);
        return;
    }
    fs.rmSync(abs, { recursive: true, force: true });
    console.log(`  removed: ${path.relative(ROOT, abs)}`);
}

function main(): void {
    console.log(
        dryRun
            ? "Cleaning build artifacts (dry run)..."
            : "Cleaning build artifacts...",
    );

    // Hugo build output
    removeIfPresent("public");
    removeIfPresent("resources/_gen");
    removeIfPresent(".hugo_build.lock");

    // Generated bucket content trees
    for (const root of GENERATED_CONTENT_ROOTS) {
        removeIfPresent(root);
    }

    console.log(dryRun ? "Done (dry run)." : "Done.");
}

main();
