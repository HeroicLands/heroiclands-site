/**
 * The routing table and the URL handling behind it — pure functions, no fetch.
 *
 * Separate from the Worker entry point for two reasons. The Workers runtime
 * treats **every named export of the entry module as an entrypoint**, so a
 * module that exports a constant alongside its handler refuses to start
 * ("the provided value is not of type 'function or ExportedHandler'"). And
 * keeping the decisions here means they can be tested as ordinary functions,
 * without a runtime at all — see `test/router.test.mjs`.
 */

/**
 * Package prefixes and the hosting project that serves each.
 *
 * A prefix must start and end with `/`. The origin is an absolute URL with no
 * path — the request's own path is appended to it verbatim.
 *
 * `sohl-kb.pages.dev` looks misnamed and is not: a Cloudflare Pages project
 * keeps the `*.pages.dev` subdomain it was created with, so the project renamed
 * to `sohl-site` still publishes there.
 */
export const ROUTES = [
    { prefix: "/sohl/", origin: "https://sohl-kb.pages.dev" },
    { prefix: "/thalorna/", origin: "https://sohl-thalorna.pages.dev" },
];

/** Origin this site's own pages are served from, for rewriting stray redirects. */
export const SITE_ORIGIN = "https://www.heroiclands.org";

/**
 * The route serving `pathname`, or `undefined` for anything this site publishes
 * itself.
 *
 * A bare prefix without its trailing slash (`/sohl`) matches too, so the
 * package's own hosting can answer it with whatever redirect it prefers rather
 * than the reader getting this site's 404 for a near-miss.
 *
 * @param {string} pathname - The request path.
 * @param {Array<{prefix: string, origin: string}>} [routes] - Route table.
 * @returns {{prefix: string, origin: string} | undefined} The matching route.
 */
export function routeFor(pathname, routes = ROUTES) {
    return routes.find(
        (r) =>
            pathname.startsWith(r.prefix) || pathname === r.prefix.slice(0, -1),
    );
}

/**
 * The upstream URL a request is proxied to: the package's origin, the request's
 * own path, and its query string, unchanged.
 *
 * **The prefix is preserved, not stripped.** Each package's deployment carries
 * its own prefix physically — `/sohl/kb/x/` is at `sohl/kb/x/` in the SoHL
 * project's upload — so proxying is a straight pass-through, and that
 * deployment behaves identically at its own `*.pages.dev` address. A router
 * that rewrote the path would make the two disagree, and every absolute link in
 * the proxied site would be wrong at one of them.
 *
 * @param {string} requestUrl - The incoming request URL.
 * @param {string} origin - The route's origin.
 * @returns {string} The upstream URL.
 */
export function upstreamURL(requestUrl, origin) {
    const url = new URL(requestUrl);
    return new URL(url.pathname + url.search, origin).toString();
}

/**
 * A `Location` header with the upstream's own origin swapped for this site's.
 *
 * Cloudflare Pages redirects on its own account — a directory without a
 * trailing slash, an `.html` path it serves extensionless — and those responses
 * name the upstream host. Passed through untouched they would walk the reader
 * off `www.heroiclands.org` and onto `*.pages.dev`, where the address bar, the
 * canonical URL and every subsequent link disagree with the site they started
 * on. A relative or third-party `Location` is left exactly as it is.
 *
 * @param {string | null} location - The upstream `Location` header, if any.
 * @param {string} origin - The upstream origin to replace.
 * @param {string} [siteOrigin] - The origin to replace it with.
 * @returns {string | null} The rewritten header, or the original.
 */
export function rewriteLocation(location, origin, siteOrigin = SITE_ORIGIN) {
    if (!location) return location;
    return location.startsWith(origin) ?
            siteOrigin + location.slice(origin.length)
        :   location;
}

/**
 * The header a package's deployment marks its own host-assigned address with.
 *
 * Lower-case because `Headers` matches case-insensitively and reads back
 * lower-cased; naming it once keeps the test and the router in step.
 */
export const ROBOTS_HEADER = "x-robots-tag";

/**
 * The upstream response's headers as they should be served here: its `Location`
 * pointed back at this site, and its `noindex` dropped.
 *
 * A package's deployment marks the hosting project's own address
 * (`*.pages.dev`) `X-Robots-Tag: noindex`, so that second, unadvertised address
 * for the same pages cannot compete with the canonical URL in search results
 * (Song-of-Heroic-Lands-FoundryVTT#1469). The hosting cannot tell this proxy's
 * request apart from a reader's — it is the same URL at the same address, and
 * Pages answers both as `*.pages.dev` — so the header arrives here too, on
 * pages that are being served at their canonical address and must be indexed.
 * **This is the only place the two addresses are distinguishable**, so removing
 * it is the router's job.
 *
 * A package that wants a page indexed nowhere says so in the document
 * (`<meta name="robots">`), which is body content and passes through untouched.
 *
 * @param {Headers} headers - The upstream response's headers.
 * @param {string} origin - The route's origin.
 * @param {string} [siteOrigin] - The origin to rewrite redirects to.
 * @returns {Headers} Headers to serve at the canonical address.
 */
export function canonicalHeaders(headers, origin, siteOrigin = SITE_ORIGIN) {
    const out = new Headers(headers);
    const location = rewriteLocation(out.get("location"), origin, siteOrigin);
    if (location) out.set("location", location);
    out.delete(ROBOTS_HEADER);
    return out;
}
