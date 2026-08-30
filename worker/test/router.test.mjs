import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import handler from "../src/index.js";
import {
    ORIGIN_FAILURE_STATUSES,
    PACKAGE_ORIGIN_SUFFIX,
    SITE_SEGMENTS,
    canonicalHeaders,
    isOriginFailure,
    originFor,
    packageFor,
    rewriteLocation,
    routeFor,
    upstreamURL,
} from "../src/router.js";

const repo = new URL("../../", import.meta.url);

/**
 * Run `fn` with `globalThis.fetch` replaced, restoring it afterwards.
 *
 * @param {(request: Request) => Promise<Response>} stub - Stand-in for fetch.
 * @param {() => Promise<unknown>} fn - The body to run.
 * @returns {Promise<unknown>} Whatever `fn` returns.
 */
async function withFetch(stub, fn) {
    const real = globalThis.fetch;
    globalThis.fetch = stub;
    try {
        return await fn();
    } finally {
        globalThis.fetch = real;
    }
}

// ---------------------------------------------------------------------------
// Deriving a package's origin from its prefix
// ---------------------------------------------------------------------------

test("derives a package's origin from its prefix alone", () => {
    // The whole claim of #25: a package appears at /<package>/ with no change
    // to this repository, so none of these names is written down anywhere here.
    for (const pkg of ["kethira", "hm3", "harnensemble", "harnadventures"]) {
        const route = routeFor(`/${pkg}/`);
        assert.equal(route.package, pkg, pkg);
        assert.equal(route.prefix, `/${pkg}/`, pkg);
        assert.equal(route.origin, `https://${pkg}.${PACKAGE_ORIGIN_SUFFIX}`);
        // An origin, not a path: the request's own path is appended verbatim.
        assert.equal(new URL(route.origin).pathname, "/", pkg);
    }
});

test("derives into a namespace this organisation owns", () => {
    // Not <package>.pages.dev: that namespace is global across every Cloudflare
    // account and `hm3.pages.dev` is already somebody else's live project, so
    // the convention would collide on a package it is being built for.
    assert.ok(PACKAGE_ORIGIN_SUFFIX.endsWith(".heroiclands.org"));
    assert.doesNotMatch(originFor("hm3"), /pages\.dev/);
});

test("routes a package's whole subtree, and its bare prefix", () => {
    assert.equal(routeFor("/kethira/module/install/").package, "kethira");
    // Without the trailing slash the package's own hosting answers, so it can
    // redirect the near-miss rather than this site 404ing it.
    assert.equal(routeFor("/kethira").package, "kethira");
    assert.equal(routeFor("/kethira").prefix, "/kethira/");
});

test("routes each package to its own repository's project", () => {
    // Two packages, two projects, no shared deploy: the property #1468 asks
    // for is that these origins are independent of one another.
    assert.notEqual(routeFor("/sohl/").origin, routeFor("/thalorna/").origin);
});

// ---------------------------------------------------------------------------
// Telling a package prefix from one of this site's own paths
// ---------------------------------------------------------------------------

test("leaves this site's own paths alone", () => {
    const own = [
        "/",
        "/blog/",
        "/blog/2025/a-post/",
        "/projects/song-of-heroic-lands/",
        "/tags/harn/",
        "/license",
        "/author/",
        "/css/style.css",
        "/img/brand/sohl-icon-white.webp",
        "/fonts/x.woff2",
    ];
    for (const p of own) assert.equal(routeFor(p), undefined, p);
});

test("leaves the site's root files alone without listing them", () => {
    // A dot cannot appear in a package name, which is what keeps every one of
    // these out — no enumeration of Hugo's output files needed.
    for (const p of [
        "/sitemap.xml",
        "/index.xml",
        "/404.html",
        "/robots.txt",
        "/favicon.ico",
        "/.well-known/security.txt",
        "/CNAME",
    ]) {
        assert.equal(routeFor(p), undefined, p);
    }
});

test("the reserved segments cover everything this repository publishes", () => {
    // Replaces the old "wrangler.toml and ROUTES name the same packages" check.
    // That agreement is gone — neither file names a package now — but the same
    // silent-drift hazard moved here: a new top-level section of this site that
    // nobody reserved would be treated as a package. Checked against the tree
    // rather than by eye, as before.
    const published = readdirSync(new URL("content/", repo), {
        withFileTypes: true,
    })
        .filter((e) => !e.name.startsWith("_") && !e.name.startsWith("."))
        .map((e) => e.name.replace(/\.md$/, ""));

    assert.ok(published.length > 0, "content/ read no sections");
    for (const section of published) {
        assert.equal(
            routeFor(`/${section}/`),
            undefined,
            `/${section}/ is this site's own, but is treated as a package`,
        );
    }

    // The theme's static/ becomes top-level paths too. Only present once the
    // theme is installed — which the pull-request check does (`npm ci` before
    // `npm test`, see .github/workflows/worker-test.yml) and the deploy job
    // does not, so the guard stays for the run that has no node_modules.
    const themeStatic = new URL(
        "node_modules/@heroiclands/hugo-theme/static/",
        repo,
    );
    if (existsSync(themeStatic)) {
        for (const dir of readdirSync(themeStatic, { withFileTypes: true })) {
            if (!dir.isDirectory()) continue;
            assert.equal(
                routeFor(`/${dir.name}/`),
                undefined,
                `/${dir.name}/ is a theme asset directory, not a package`,
            );
        }
    }

    // And the taxonomies, which are configured rather than directories.
    const hugo = readFileSync(new URL("hugo.toml", repo), "utf8");
    const taxonomies = hugo.split("[taxonomies]")[1] ?? "";
    const terms = [...taxonomies.matchAll(/^\s*\S+ = "([\w-]+)"$/gm)].map(
        (m) => m[1],
    );
    assert.ok(terms.length > 0, "hugo.toml declared no taxonomy");
    for (const term of terms) {
        assert.equal(
            routeFor(`/${term}/`),
            undefined,
            `/${term}/ is a taxonomy of this site, not a package`,
        );
    }
});

test("does not route a prefix that merely starts the same way", () => {
    // /sohlx/ is a different package, not a longer form of /sohl/ — each gets
    // its own origin, and neither is a prefix match on the other.
    assert.equal(packageFor("/sohlx/"), "sohlx");
    assert.equal(packageFor("/sohl-legacy/"), "sohl-legacy");
    assert.notEqual(routeFor("/sohlx/").origin, routeFor("/sohl/").origin);
});

test("refuses a segment that could not be a hostname label", () => {
    for (const p of ["/SoHL/", "/-sohl/", "/so%20hl/", "/sohl_kb/", "//"]) {
        assert.equal(routeFor(p), undefined, p);
    }
});

// ---------------------------------------------------------------------------
// URL and header handling
// ---------------------------------------------------------------------------

test("preserves the path and query verbatim", () => {
    const origin = originFor("sohl");
    assert.equal(
        upstreamURL("https://www.heroiclands.org/sohl/kb/rules/", origin),
        "https://sohl.pkg.heroiclands.org/sohl/kb/rules/",
    );
    assert.equal(
        upstreamURL("https://www.heroiclands.org/sohl/api/?q=roll#x", origin),
        "https://sohl.pkg.heroiclands.org/sohl/api/?q=roll",
    );
});

test("keeps the prefix rather than stripping it", () => {
    // The package's deployment carries /sohl/ physically, so stripping it here
    // would 404 upstream and make the project's own address disagree.
    assert.ok(
        upstreamURL(
            "https://www.heroiclands.org/sohl/kb/",
            "https://x.dev",
        ).endsWith("/sohl/kb/"),
    );
});

test("rewrites a redirect that names the upstream host", () => {
    const origin = originFor("sohl");
    assert.equal(
        rewriteLocation(`${origin}/sohl/kb/x/`, origin),
        "https://www.heroiclands.org/sohl/kb/x/",
    );
});

test("leaves relative and third-party redirects alone", () => {
    const origin = originFor("sohl");
    assert.equal(rewriteLocation("/sohl/kb/x/", origin), "/sohl/kb/x/");
    assert.equal(
        rewriteLocation("https://example.org/x", origin),
        "https://example.org/x",
    );
    assert.equal(rewriteLocation(null, origin), null);
});

test("drops the noindex a package sets for its own address", () => {
    // The package's deployment marks its hosting address noindex so that
    // second address cannot compete with this one in search results
    // (Song-of-Heroic-Lands-FoundryVTT#1469). Served here the page IS the
    // canonical one and must stay indexable — and this is the only place the
    // two addresses can be told apart.
    const headers = canonicalHeaders(
        new Headers({ "x-robots-tag": "noindex" }),
        originFor("sohl"),
    );
    assert.equal(headers.get("x-robots-tag"), null);
});

test("passes every other header through untouched", () => {
    // The router carries no content and no opinions about it: only the headers
    // naming the upstream's own address are its business.
    const origin = originFor("sohl");
    const link = "<https://fonts.googleapis.com>; rel=preconnect";
    const headers = canonicalHeaders(
        new Headers({
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=0, must-revalidate",
            link,
        }),
        origin,
    );
    assert.equal(headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(
        headers.get("cache-control"),
        "public, max-age=0, must-revalidate",
    );
    assert.equal(headers.get("link"), link);
    assert.equal(headers.get("location"), null);
});

// ---------------------------------------------------------------------------
// wrangler.toml — the wildcard, and that it names no package
// ---------------------------------------------------------------------------

test("the Worker route is a wildcard naming no package", () => {
    // The route table used to have to agree with a list of packages. It now has
    // to contain no list at all: a per-package route here would be a change to
    // this repository every time a package is added, which is the thing #25
    // removes. One wildcard, and the handler decides.
    const toml = readFileSync(
        new URL("../wrangler.toml", import.meta.url),
        "utf8",
    );
    const patterns = [...toml.matchAll(/^pattern = "(.+)"$/gm)].map((m) => m[1]);
    assert.deepEqual(patterns, ["www.heroiclands.org/*"]);
});

// ---------------------------------------------------------------------------
// Telling "the origin never answered" from "the origin answered badly"
// ---------------------------------------------------------------------------

test("treats the edge's did-not-answer statuses as a failure", () => {
    // 530 is "the origin's DNS does not resolve" — the one that took the site
    // down (#28) — and 521-526 are the edge reaching an origin that refused,
    // timed out, or failed TLS. None is content an origin produced.
    for (const status of [521, 522, 523, 524, 525, 526, 530]) {
        assert.equal(isOriginFailure(status), true, String(status));
    }
    assert.deepEqual(
        [...ORIGIN_FAILURE_STATUSES].sort(),
        [521, 522, 523, 524, 525, 526, 530],
    );
});

test("leaves a response the origin actually produced alone", () => {
    // A package's own error page is the package's to serve; the router must not
    // second-guess a host that answered. Ordinary 5xx included — deliberately.
    for (const status of [200, 301, 404, 410, 500, 502, 503, 504, 520]) {
        assert.equal(isOriginFailure(status), false, String(status));
    }
});

// ---------------------------------------------------------------------------
// The entry module: a shape the runtime will start
// ---------------------------------------------------------------------------

test("the entry module exports its handler and nothing else", async () => {
    // The Workers runtime treats **every named export of the entry module as an
    // entrypoint** and refuses to start when one is not a handler ("the
    // provided value is not of type 'function or ExportedHandler'"). A stray
    // `export const` in src/index.js is therefore a Worker that deploys and
    // does not boot — and nothing else here would notice, because Node imports
    // such a module perfectly happily. It is why the routing decisions live in
    // src/router.js at all, so the constraint is worth a check rather than a
    // docstring.
    //
    // This is also the one property a `wrangler dev` smoke test would have
    // added over this suite. It does not need one: #29 established that the
    // local runtime *throws* where the edge answers with a 530, so a smoke test
    // passes on exactly the router that took the site down, while this costs a
    // module import.
    const module = await import("../src/index.js");
    assert.deepEqual(Object.keys(module), ["default"]);
    assert.equal(typeof module.default.fetch, "function");
});

// ---------------------------------------------------------------------------
// The handler: a fault must reach the origin, not a 5xx
// ---------------------------------------------------------------------------

test("a thrown error yields the origin's response, not a 5xx", async () => {
    // The wildcard route means a fault here is the whole site. There is no
    // narrow route left to contain it, so the catch is what does.
    const request = new Request("https://www.heroiclands.org/kethira/");
    await withFetch(async (input) => {
        // Anything proxied upstream blows up; the origin answers normally.
        if (input !== request) throw new TypeError("upstream is on fire");
        return new Response("origin", { status: 200 });
    }, async () => {
        const response = await handler.fetch(request);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "origin");
    });
});

test("a non-package path reaches the origin unchanged", async () => {
    const request = new Request("https://www.heroiclands.org/blog/");
    await withFetch(async (input) => {
        assert.equal(input, request, "the request was rewritten");
        return new Response("origin", { status: 200 });
    }, async () => {
        assert.equal(await (await handler.fetch(request)).text(), "origin");
    });
});

test("a package prefix is proxied to its derived origin", async () => {
    const request = new Request("https://www.heroiclands.org/kethira/x/");
    await withFetch(async (input) => {
        assert.equal(input.url, "https://kethira.pkg.heroiclands.org/kethira/x/");
        return new Response("upstream", {
            status: 200,
            headers: { "x-robots-tag": "noindex" },
        });
    }, async () => {
        const response = await handler.fetch(request);
        assert.equal(await response.text(), "upstream");
        // Re-headed as this site's, per canonicalHeaders.
        assert.equal(response.headers.get("x-robots-tag"), null);
    });
});

test("asks for the derived origin and nothing else", async () => {
    // The migration fallback is gone: sohl.pkg.heroiclands.org and
    // thalorna.pkg.heroiclands.org both answer, so there is no second address
    // for a package and no retry against one (#28). One request, one origin.
    const request = new Request("https://www.heroiclands.org/sohl/kb/");
    const tried = [];
    await withFetch(async (input) => {
        tried.push(input.url);
        return new Response("sohl", { status: 200 });
    }, async () => {
        assert.equal(await (await handler.fetch(request)).text(), "sohl");
    });
    assert.deepEqual(tried, ["https://sohl.pkg.heroiclands.org/sohl/kb/"]);
});

test("a failing package origin falls through to this site's origin", async () => {
    // Nothing to retry against, so the catch takes it: the origin's 404 beats
    // a Worker exception page.
    const request = new Request("https://www.heroiclands.org/hm3/");
    await withFetch(async (input) => {
        if (input !== request) throw new TypeError("no such host");
        return new Response("not found", { status: 404 });
    }, async () => {
        const response = await handler.fetch(request);
        assert.equal(response.status, 404);
    });
});

test("an origin that resolves with a 530 falls through, not passed on", async () => {
    // The test that would have caught the outage. Cloudflare does not throw
    // when an origin hostname does not resolve or does not answer: fetch()
    // RESOLVES, with a 530. A stub that rejects — the natural shape, and what
    // every other handler test here does — models a failure the runtime does
    // not produce, which is exactly why the suite passed through the outage.
    const request = new Request("https://www.heroiclands.org/kethira/");
    await withFetch(async (input) => {
        if (input !== request) {
            return new Response("error code: 1016", { status: 530 });
        }
        return new Response("origin", { status: 200 });
    }, async () => {
        const response = await handler.fetch(request);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "origin");
    });
});

test("falls through for every 52x the edge synthesises too", async () => {
    // 530 is the one that happened; the connection-level failures are the same
    // class of non-answer and must not reach a reader either.
    for (const status of [521, 522, 523, 524, 525, 526]) {
        const request = new Request("https://www.heroiclands.org/kethira/");
        await withFetch(async (input) => {
            if (input !== request) return new Response("", { status });
            return new Response("origin", { status: 200 });
        }, async () => {
            const response = await handler.fetch(request);
            assert.equal(response.status, 200, String(status));
        });
    }
});

test("serves a package's own error response rather than hiding it", async () => {
    // The complement of the fix, and the reason it is a named list and not
    // "any 5xx": a package that answers 503 from its own hosting has answered,
    // and swapping its page for this site's 404 would lose the truth.
    const request = new Request("https://www.heroiclands.org/kethira/x/");
    await withFetch(async (input) => {
        if (input !== request) {
            return new Response("kethira is rebuilding", { status: 503 });
        }
        return new Response("origin", { status: 200 });
    }, async () => {
        const response = await handler.fetch(request);
        assert.equal(response.status, 503);
        assert.equal(await response.text(), "kethira is rebuilding");
    });
});

test("passes a package's own 404 through, prefix and all", async () => {
    // The chosen answer to "404 or an explicit error page?" is that a package
    // prefix gets a 404 either way — from the package when it is up, from this
    // site when it is not. The router holds no list of packages, so it cannot
    // tell a package whose host is down from a first segment that was never a
    // package, and must not claim to.
    const request = new Request("https://www.heroiclands.org/kethira/gone/");
    await withFetch(async (input) => {
        if (input !== request) {
            return new Response("kethira's 404", { status: 404 });
        }
        return new Response("this site's 404", { status: 404 });
    }, async () => {
        const response = await handler.fetch(request);
        assert.equal(response.status, 404);
        assert.equal(await response.text(), "kethira's 404");
    });
});
