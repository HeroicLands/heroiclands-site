/**
 * heroiclands-router — the path-prefix routing layer for www.heroiclands.org.
 *
 * One hostname, several publishers. This site's own deploy (GitHub Pages) serves
 * everything by default; a package repository that builds and publishes its own
 * subtree is reached under `/<package>/`, and requests there are proxied to that
 * repository's hosting project instead.
 *
 * The router holds **no content, no per-page knowledge, and no list of
 * packages**. A package's origin is derived from its prefix
 * (`/<package>/` → `https://<package>.pkg.heroiclands.org`), so a package
 * becomes publishable here entirely from its own repository and this one is
 * never edited for it (heroiclands-site#25). That is the point: each repository
 * stays publishable on its own, and none is required for another to deploy
 * (HeroicLands/Song-of-Heroic-Lands-FoundryVTT#1468).
 *
 * **Every request to the hostname reaches this script** — the Worker route is a
 * wildcard, because narrow per-package routes would be a list of packages in
 * `wrangler.toml`. What used to keep a broken router off the rest of the site is
 * now the `try`/`catch` below: any fault, anywhere, falls through to
 * `fetch(request)` and the origin answers. That covers strictly more than the
 * narrow routes did, since it also catches a fault on a prefix the router *does*
 * claim.
 *
 * This module exports **only** the handler: the Workers runtime treats every
 * named export of the entry module as an entrypoint, and refuses to start when
 * one is not a handler. The routing decisions and the URL handling live in
 * src/router.js.
 */

import { routeFor, upstreamURL, canonicalHeaders } from "./router.js";

/**
 * Proxy a request to a package's origin and answer as this site.
 *
 * @param {Request} request - The incoming request.
 * @param {string} origin - The origin to proxy to.
 * @returns {Promise<Response>} The upstream response, re-headed for this site.
 */
async function proxy(request, origin) {
    const proxied = new Request(upstreamURL(request.url, origin), {
        method: request.method,
        headers: request.headers,
        body:
            request.method === "GET" || request.method === "HEAD" ?
                undefined
            :   request.body,
        // Hand the upstream's own redirects back to the reader rather than
        // resolving them here, so a redirect stays visible as a redirect.
        redirect: "manual",
    });

    // The upstream answers as its own hosting project — naming itself in
    // redirects, and marking itself `noindex` — and this is where those
    // answers become this site's. See `canonicalHeaders`.
    const response = await fetch(proxied);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: canonicalHeaders(response.headers, origin),
    });
}

export default {
    /**
     * @param {Request} request - The incoming request.
     * @returns {Promise<Response>} The upstream response, or this site's origin.
     */
    async fetch(request) {
        try {
            const route = routeFor(new URL(request.url).pathname);

            // No route: this site publishes the path itself, and the router has
            // no business answering — fall through, as it always has.
            if (route) {
                try {
                    return await proxy(request, route.origin);
                } catch (error) {
                    // A package whose derived custom domain does not exist yet.
                    // Only for a body-less method: a retry cannot re-read a
                    // body the first attempt may already have consumed, and the
                    // packages this applies to serve static pages anyway. See
                    // `LEGACY_ORIGINS`.
                    const retryable =
                        request.method === "GET" || request.method === "HEAD";
                    if (!route.fallbackOrigin || !retryable) throw error;
                    return await proxy(request, route.fallbackOrigin);
                }
            }
        } catch (error) {
            // The wildcard Worker route means a fault here is the whole site,
            // not one prefix — so nothing is allowed to escape as a 5xx. The
            // origin serves this repository's own pages correctly, and answers
            // a package prefix with a 404: a bad page rather than a dead site.
            console.error(
                "heroiclands-router: falling through to the origin",
                error,
            );
        }

        return fetch(request);
    },
};
