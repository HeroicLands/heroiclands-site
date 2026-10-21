/**
 * The package roster, and the two things that must agree with it.
 *
 * The roster (`roster.mjs`) is not a routing table and the router does not read
 * it — a package's origin is derived from its prefix and this repository holds
 * no list. So the roster is *checked* against the router
 * rather than driving it, and these are the checks:
 *
 * 1. **The router resolves every package the roster names.** A roster entry the
 *    router will not route is a page that 404s. Since the router derives, the
 *    only ways that happens are a malformed id and a collision with one of this
 *    site's own top-level sections — and both are silent.
 * 2. **The committed projections are current.** `data/roster.json` and
 *    `static/nav.json` are generated from `roster.mjs` and committed, so they
 *    can go stale between the two. This fails when they have.
 * 3. **The site's sitemap index names every package.** `site.sitemaps` in
 *    `package-build.config.yaml` lists the roster's packages, in roster order,
 *    and `site.mergeIndexes` names none outside it.
 *
 * These live in the router's suite because it is the only Node suite this
 * repository has and the only one a pull request runs (`worker-test.yml`), and
 * because the agreement being checked is with the router. That suite already
 * reaches outside `worker/` for the same reason — its `SITE_SEGMENTS` drift
 * check reads `package-build.config.yaml`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    PACKAGES,
    dependentsOf,
    packageById,
    prefixFor,
    renderDataFile,
    renderNavFile,
} from "../../roster.mjs";
import { PACKAGE_ORIGIN_SUFFIX, PACKAGE_SEGMENT, SITE_SEGMENTS, routeFor } from "../src/router.js";
import { SITE, publishedSections } from "./site-config.mjs";

const repo = new URL("../../", import.meta.url);

// ---------------------------------------------------------------------------
// The roster itself
// ---------------------------------------------------------------------------

test("names the seven packages HeroicLands publishes", () => {
    // Verified against each repository's `package-build.config.yaml`
    // (`contentPackage`) rather than against any list written down elsewhere.
    assert.deepEqual(
        PACKAGES.map((pkg) => pkg.id),
        ["sohl", "hm3", "thalorna", "kethira", "thalornaaltart", "harnensemble", "harnadventures"],
    );
});

test("every entry is complete and well-formed", () => {
    const ids = new Set();
    for (const pkg of PACKAGES) {
        assert.ok(!ids.has(pkg.id), `${pkg.id} appears twice`);
        ids.add(pkg.id);
        assert.match(pkg.id, PACKAGE_SEGMENT, pkg.id);
        assert.ok(pkg.title.length > 0, `${pkg.id} has no title`);
        assert.ok(pkg.repository.length > 0, `${pkg.id} names no repository`);
        assert.ok(["system", "module"].includes(pkg.kind), `${pkg.id} kind: ${pkg.kind}`);
        assert.ok(
            ["content", "homepage"].includes(pkg.publishes),
            `${pkg.id} publishes: ${pkg.publishes}`,
        );
        assert.ok(["top", "modules"].includes(pkg.nav), `${pkg.id} nav: ${pkg.nav}`);
    }
});

test("a package's address is its contentPackage, not its repository name", () => {
    // The obvious wrong move, and it would break four of six. Pinned so that a
    // later tidy-up "correcting" one to the other fails here rather than
    // unpublishing four packages.
    const divergent = PACKAGES.filter((pkg) => pkg.id !== pkg.repository);
    assert.deepEqual(
        divergent.map((pkg) => [pkg.id, pkg.repository]),
        [
            ["sohl", "Song-of-Heroic-Lands-FoundryVTT"],
            ["hm3", "HarnMaster-3-FoundryVTT"],
            ["thalorna", "sohl-thalorna"],
            ["kethira", "sohl-kethira-basic"],
            ["harnensemble", "harn-ensemble"],
            ["harnadventures", "harn-adventures"],
        ],
    );

    // And the two are not interchangeable: routing the repository name reaches
    // a different origin, or none at all.
    for (const pkg of divergent) {
        assert.notEqual(
            routeFor(`/${pkg.repository}/`)?.origin,
            routeFor(prefixFor(pkg.id)).origin,
            pkg.repository,
        );
    }
});

test("every system a package names is a system in the roster", () => {
    // The dependents index is only worth rendering if both ends of every edge
    // resolve. An unknown id here is a link to nothing; a module named as a
    // system is a link to the wrong kind of thing.
    for (const pkg of PACKAGES) {
        for (const id of pkg.systems) {
            const target = packageById(id);
            assert.ok(target, `${pkg.id} names an unknown system: ${id}`);
            assert.equal(target.kind, "system", `${id} is not a system`);
            assert.notEqual(id, pkg.id, `${pkg.id} names itself`);
        }
        if (pkg.kind === "system") {
            assert.deepEqual(pkg.systems, [], `${pkg.id} is a system`);
        }
    }
});

test("the dependents index is the one no package can hold for itself", () => {
    // What a system's homepage links to. Neither system declares these and
    // neither can: a module names the system it is for, never the reverse.
    assert.deepEqual(
        dependentsOf("sohl").map((pkg) => pkg.id),
        ["thalorna", "kethira", "thalornaaltart", "harnensemble"],
    );
    assert.deepEqual(
        dependentsOf("hm3").map((pkg) => pkg.id),
        ["harnensemble", "harnadventures"],
    );
    // A module is not a platform; nothing builds on one.
    for (const pkg of PACKAGES.filter((p) => p.kind === "module")) {
        assert.deepEqual(dependentsOf(pkg.id), [], pkg.id);
    }
});

// ---------------------------------------------------------------------------
// The router resolves every package the roster names
// ---------------------------------------------------------------------------

test("the router resolves every package in the roster", () => {
    for (const pkg of PACKAGES) {
        const origin = `https://${pkg.id}.${PACKAGE_ORIGIN_SUFFIX}`;
        for (const path of [prefixFor(pkg.id), `/${pkg.id}`, `${prefixFor(pkg.id)}kb/deep/page/`]) {
            const route = routeFor(path);
            assert.ok(route, `${path} routes nowhere`);
            assert.equal(route.package, pkg.id, path);
            assert.equal(route.prefix, prefixFor(pkg.id), path);
            assert.equal(route.origin, origin, path);
        }
    }
});

test("no package claims a path this site publishes itself", () => {
    // The one collision the router cannot report. A reserved segment wins in
    // `packageFor`, so a package named `blog` would simply never be routed —
    // no error anywhere, just a 404 at an address that is in the roster.
    for (const pkg of PACKAGES) {
        assert.ok(
            !SITE_SEGMENTS.has(pkg.id),
            `/${pkg.id}/ is both a package and one of this site's own sections`,
        );
    }
});

test("no package collides with a top-level section of this repository", () => {
    // The same check against the configuration rather than against the list,
    // because the list can itself be behind — the sections the configuration
    // names are what actually publishes.
    const published = publishedSections();

    assert.ok(published.length > 0, "package-build.config.yaml names no section");
    const ids = new Set(PACKAGES.map((pkg) => pkg.id));
    for (const section of published) {
        assert.ok(
            !ids.has(section),
            `/${section}/ is published by this repository and by a package`,
        );
    }
});

// ---------------------------------------------------------------------------
// The committed projections
// ---------------------------------------------------------------------------

test("data/roster.json is what roster.mjs would write", () => {
    // The generated copy is committed, so it can go stale. This is the check
    // that says so — the same one `npm run check:roster` runs, here so that the
    // suite the pull request already runs cannot miss it.
    const committed = readFileSync(new URL("data/roster.json", repo), "utf8");
    assert.equal(committed, renderDataFile(), "data/roster.json is stale — run: npm run roster");
});

test("static/nav.json is what roster.mjs would write", () => {
    const committed = readFileSync(new URL("static/nav.json", repo), "utf8");
    assert.equal(committed, renderNavFile(), "static/nav.json is stale — run: npm run roster");
});

test("the projection resolves what a template should not have to", () => {
    // A projection, not a transcription: it carries the derived prefix and the
    // reverse index, so a reader renders a cross-link without doing a reverse
    // lookup.
    const data = JSON.parse(readFileSync(new URL("data/roster.json", repo)));
    const sohl = data.packages.find((pkg) => pkg.id === "sohl");
    assert.equal(sohl.prefix, "/sohl/");
    assert.deepEqual(sohl.dependents, ["thalorna", "kethira", "thalornaaltart", "harnensemble"]);
});

// ---------------------------------------------------------------------------
// The site's sitemap index and merged search
// ---------------------------------------------------------------------------

test("the sitemap index names every package in the roster, in roster order", () => {
    // `robots.txt` and `sitemap-index.xml` are written from `site.sitemaps`. A
    // package missing there is a site no crawler is told about.
    assert.deepEqual(
        SITE.sitemaps,
        PACKAGES.map((pkg) => pkg.id),
        "site.sitemaps in package-build.config.yaml does not list the roster",
    );
});

test("the merged search reads only packages in the roster", () => {
    // Each is read from `/<package>/pagefind/`, which only a package published
    // under this hostname serves.
    assert.ok(SITE.mergeIndexes?.length, "site.mergeIndexes names no package");
    const ids = new Set(PACKAGES.map((pkg) => pkg.id));
    for (const id of SITE.mergeIndexes) assert.ok(ids.has(id), `${id} is not in the roster`);
});
