/**
 * The routing decisions and the URL handling behind them — pure functions, no
 * fetch.
 *
 * Separate from the Worker entry point for two reasons. The Workers runtime
 * treats **every named export of the entry module as an entrypoint**, so a
 * module that exports a constant alongside its handler refuses to start
 * ("the provided value is not of type 'function or ExportedHandler'"). And
 * keeping the decisions here means they can be tested as ordinary functions,
 * without a runtime at all — see `test/router.test.mjs`.
 */

/**
 * The subdomain every package's hosting project answers on.
 *
 * A package's origin is derived from its prefix and nothing else:
 * `/kethira/` → `https://kethira.pkg.heroiclands.org`. There is no table of
 * packages here, and adding one is no longer a change to this repository — the
 * package's own deploy gives its hosting project this custom domain, from its
 * own workflow, alongside the project creation it already does.
 *
 * **The namespace is one this organisation owns**, which is why it is not
 * `<package>.pages.dev`. `*.pages.dev` is global across every Cloudflare
 * account: `hm3.pages.dev` is already somebody else's live project, and any of
 * the remaining names could be claimed tomorrow. Deriving into a namespace
 * nobody else can take is the difference between a convention and a race.
 */
export const PACKAGE_ORIGIN_SUFFIX = "pkg.heroiclands.org";

/**
 * The top-level path segments this site publishes itself.
 *
 * The router has to tell a package prefix from one of this site's own sections,
 * and only one of those two sets can be written down honestly. Packages are
 * open-ended and arrive from other repositories — enumerating them here is the
 * very thing issue #25 removes. This site's own top-level paths are a small,
 * closed set that lives in *this* repository (`content/`, the taxonomy, the
 * theme's static directories), so this is exactly where they are known. Adding
 * a package needs no edit here; adding a **section** does, and that edit is
 * next to the `content/` directory it comes with.
 *
 * `test/router.test.mjs` walks `content/` and the theme's `static/` and fails
 * if anything published here is missing from this list, so it cannot drift
 * silently.
 *
 * **This list stays here rather than moving into the package roster**
 * (`roster.mjs`), though the two divide one namespace between them and must
 * stay disjoint. Three reasons, and the last is the deciding one. Their
 * provenance differs: this is a fact about *this* repository's own build
 * output, already derived and checked against it, while the roster records
 * other repositories. Their lifecycle differs: this list must **not** grow when
 * a package is added, and holding it in the file that does grow then invites
 * exactly the edit #25 removed. And this list is load-bearing at runtime in the
 * deployed Worker while the roster is not read at runtime at all — merging them
 * would put a package-shaped list back into the router's bundle, in the one
 * file where "the router holds no list of packages" most needs to be true.
 * Disjointness is what actually matters, and that is a test rather than a file
 * layout: `test/roster.test.mjs` asserts no package claims a segment reserved
 * here, or a section `content/` publishes.
 *
 * A section missing from the list is not an outage in any case: its requests
 * are proxied to a `pkg.heroiclands.org` host that does not resolve, that
 * attempt comes back unusable (see `isOriginFailure`), and `src/index.js`
 * falls through to the origin — which serves the section correctly. The cost of
 * the mistake is latency, not a 404.
 */
export const SITE_SEGMENTS = new Set([
    // content/
    "author",
    "blog",
    "license",
    "projects",
    // taxonomy (hugo.toml [taxonomies])
    "tags",
    // the theme's static/
    "css",
    "fonts",
    "img",
    // not published today, but too easy to add later to leave unclaimed
    "images",
    "js",
]);

/**
 * The shape a package name may take, and therefore the shape a first path
 * segment must have before it is treated as one.
 *
 * Lower-case alphanumerics and hyphens, which is what a package id already is
 * and what a hostname label can carry. **No dot**, which is what keeps the
 * site's root files out of it without listing them: `/sitemap.xml`,
 * `/index.xml`, `/404.html` and `/robots.txt` are not package prefixes, and
 * neither is `/.well-known/`.
 */
export const PACKAGE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The statuses that mean the upstream never answered, so its "response" is not
 * a response at all.
 *
 * **Cloudflare does not throw when an origin is unreachable.** A `fetch()` to a
 * hostname that does not resolve, or to one that resolves but does not answer,
 * *resolves* — with a status the edge synthesised on the origin's behalf. 530
 * is "the origin's DNS does not resolve" (error 1016); 521–526 are the edge
 * reaching an origin that refused, timed out, or failed TLS. None of them is
 * content any origin produced, and none should be handed to a reader as though
 * it were: they are the response-shaped form of the failure the handler's
 * `try`/`catch` was written for, and keying only on a thrown error missed the
 * whole of it (heroiclands-site#28).
 *
 * Deliberately **not** here: 500, 502, 503 and every other ordinary 5xx. Those
 * an origin can and does produce itself, and a package's own error page is its
 * to serve — the router must not second-guess a host that answered.
 */
export const ORIGIN_FAILURE_STATUSES = new Set([
    521, 522, 523, 524, 525, 526, 530,
]);

/**
 * Whether a status means the attempt failed rather than that the origin
 * answered.
 *
 * @param {number} status - The status of the upstream's response.
 * @returns {boolean} `true` when nothing usable came back.
 */
export function isOriginFailure(status) {
    return ORIGIN_FAILURE_STATUSES.has(status);
}

/** Origin this site's own pages are served from, for rewriting stray redirects. */
export const SITE_ORIGIN = "https://www.heroiclands.org";

/**
 * The origin serving a package, derived from its name alone.
 *
 * @param {string} pkg - The package name.
 * @returns {string} An absolute origin with no path.
 */
export function originFor(pkg) {
    return `https://${pkg}.${PACKAGE_ORIGIN_SUFFIX}`;
}

/**
 * The package `pathname` belongs to, or `undefined` for anything this site
 * publishes itself.
 *
 * A bare prefix without its trailing slash (`/sohl`) counts too, so the
 * package's own hosting can answer it with whatever redirect it prefers rather
 * than the reader getting this site's 404 for a near-miss.
 *
 * @param {string} pathname - The request path.
 * @param {Set<string>} [siteSegments] - Segments this site publishes itself.
 * @returns {string | undefined} The package name.
 */
export function packageFor(pathname, siteSegments = SITE_SEGMENTS) {
    const segment = pathname.split("/")[1] ?? "";
    if (!PACKAGE_SEGMENT.test(segment)) return undefined;
    if (siteSegments.has(segment)) return undefined;
    return segment;
}

/**
 * The route serving `pathname`, or `undefined` for anything this site publishes
 * itself.
 *
 * The origin is derived and there is no second one to try: every package's
 * `pkg.heroiclands.org` custom domain now exists, so the migration fallback
 * this used to carry is gone (heroiclands-site#28). An origin that does not
 * answer is handled by falling through to this site's own, not by guessing at
 * another address for the package.
 *
 * @param {string} pathname - The request path.
 * @param {Set<string>} [siteSegments] - Segments this site publishes itself.
 * @returns {{package: string, prefix: string, origin: string} | undefined} The
 *   matching route.
 */
export function routeFor(pathname, siteSegments = SITE_SEGMENTS) {
    const pkg = packageFor(pathname, siteSegments);
    if (!pkg) return undefined;
    return { package: pkg, prefix: `/${pkg}/`, origin: originFor(pkg) };
}

/**
 * The upstream URL a request is proxied to: the package's origin, the request's
 * own path, and its query string, unchanged.
 *
 * **The prefix is preserved, not stripped.** Each package's deployment carries
 * its own prefix physically — `/sohl/kb/x/` is at `sohl/kb/x/` in the SoHL
 * project's upload — so proxying is a straight pass-through, and that
 * deployment behaves identically at its own hosting address. A router that
 * rewrote the path would make the two disagree, and every absolute link in the
 * proxied site would be wrong at one of them.
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
 * off `www.heroiclands.org` and onto the package's own hosting address, where
 * the address bar, the canonical URL and every subsequent link disagree with
 * the site they started on. A relative or third-party `Location` is left
 * exactly as it is.
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
 * A package's deployment marks the hosting project's own address `noindex`, so
 * that second, unadvertised address for the same pages cannot compete with the
 * canonical URL in search results (Song-of-Heroic-Lands-FoundryVTT#1469). The
 * hosting cannot tell this proxy's request apart from a reader's — it is the
 * same URL at the same address, and Pages answers both as its own host — so the
 * header arrives here too, on pages that are being served at their canonical
 * address and must be indexed. **This is the only place the two addresses are
 * distinguishable**, so removing it is the router's job.
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
