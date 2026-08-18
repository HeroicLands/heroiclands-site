import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    ROUTES,
    routeFor,
    upstreamURL,
    rewriteLocation,
} from "../src/router.js";

test("the table carries prefixes, not pages", () => {
    // The router's whole claim is that adding or removing a package is one row.
    for (const r of ROUTES) {
        assert.match(r.prefix, /^\/[^/]+\/$/, `${r.prefix} is not a prefix`);
        assert.equal(new URL(r.origin).pathname, "/", `${r.origin} has a path`);
    }
});

test("routes a package prefix, and its bare form", () => {
    assert.equal(routeFor("/sohl/").origin, "https://sohl-kb.pages.dev");
    assert.equal(routeFor("/sohl/kb/skill/acrobatics/").prefix, "/sohl/");
    // Without the trailing slash the package's own hosting answers, so it can
    // redirect the near-miss rather than this site 404ing it.
    assert.equal(routeFor("/sohl").prefix, "/sohl/");
});

test("routes each package to its own repository's project", () => {
    // Two packages, two projects, no shared deploy: the property #1468 asks
    // for is that these origins are independent of one another.
    assert.equal(
        routeFor("/thalorna/world/thalorna/").origin,
        "https://sohl-thalorna.pages.dev",
    );
    assert.equal(routeFor("/thalorna").prefix, "/thalorna/");
    assert.notEqual(routeFor("/sohl/").origin, routeFor("/thalorna/").origin);
});

test("leaves this site's own paths alone", () => {
    for (const p of ["/", "/projects/", "/blog/", "/license/"]) {
        assert.equal(routeFor(p), undefined, p);
    }
});

test("the Worker routes and the table name the same packages", () => {
    // A route with no row proxies nothing and a row with no route is never
    // consulted; either way the prefix silently serves the wrong thing, which
    // is why the two files are checked against each other rather than by eye.
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const patterns = [...toml.matchAll(/^pattern = "(.+)"$/gm)].map((m) => m[1]);
    const expected = ROUTES.flatMap((r) => [
        `www.heroiclands.org${r.prefix.slice(0, -1)}`,
        `www.heroiclands.org${r.prefix}*`,
    ]);
    assert.deepEqual(patterns.sort(), expected.sort());
});

test("does not route a prefix that merely starts the same way", () => {
    // /sohlx/ is a different section, not the sohl package.
    assert.equal(routeFor("/sohlx/"), undefined);
    assert.equal(routeFor("/sohl-legacy/"), undefined);
    assert.equal(routeFor("/thalornan/"), undefined);
});

test("preserves the path and query verbatim", () => {
    const origin = "https://sohl-kb.pages.dev";
    assert.equal(
        upstreamURL("https://www.heroiclands.org/sohl/kb/rules/", origin),
        "https://sohl-kb.pages.dev/sohl/kb/rules/",
    );
    assert.equal(
        upstreamURL("https://www.heroiclands.org/sohl/api/?q=roll#x", origin),
        "https://sohl-kb.pages.dev/sohl/api/?q=roll",
    );
});

test("keeps the prefix rather than stripping it", () => {
    // The package's deployment carries /sohl/ physically, so stripping it here
    // would 404 upstream and make the project's own address disagree.
    assert.ok(
        upstreamURL("https://www.heroiclands.org/sohl/kb/", "https://x.dev")
            .endsWith("/sohl/kb/"),
    );
});

test("rewrites a redirect that names the upstream host", () => {
    const origin = "https://sohl-kb.pages.dev";
    assert.equal(
        rewriteLocation(`${origin}/sohl/kb/x/`, origin),
        "https://www.heroiclands.org/sohl/kb/x/",
    );
});

test("leaves relative and third-party redirects alone", () => {
    const origin = "https://sohl-kb.pages.dev";
    assert.equal(rewriteLocation("/sohl/kb/x/", origin), "/sohl/kb/x/");
    assert.equal(
        rewriteLocation("https://example.org/x", origin),
        "https://example.org/x",
    );
    assert.equal(rewriteLocation(null, origin), null);
});
