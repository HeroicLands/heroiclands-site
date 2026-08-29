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
 * **A failure is not always a thrown one.** Cloudflare answers an unreachable
 * origin with a 530 (or a 52x) rather than rejecting, so a guard keyed on a
 * thrown error alone never fires for the commonest failure there is — which is
 * how `/sohl/` and `/thalorna/` served raw 530s for the life of an outage
 * (heroiclands-site#28). Both an exception and an unusable response are faults
 * here, and both fall through.
 *
 * This module exports **only** the handler: the Workers runtime treats every
 * named export of the entry module as an entrypoint, and refuses to start when
 * one is not a handler. The routing decisions and the URL handling live in
 * src/router.js.
 */

import {
    routeFor,
    upstreamURL,
    canonicalHeaders,
    isOriginFailure,
} from "./router.js";

/**
 * Proxy a request to a package's origin and answer as this site.
 *
 * Throws when the origin did not answer at all, so the caller's `catch` handles
 * an unreachable origin and a thrown fault by one path. That is not a
 * refinement: **Cloudflare resolves with a 530 rather than throwing** when a
 * hostname does not resolve, so before this check the guard below existed
 * without ever being reachable for the failure it was written for, and readers
 * were served raw 530s (heroiclands-site#28).
 *
 * @param {Request} request - The incoming request.
 * @param {string} origin - The origin to proxy to.
 * @returns {Promise<Response>} The upstream response, re-headed for this site.
 * @throws {Error} When the upstream never answered — see `isOriginFailure`.
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
    if (isOriginFailure(response.status)) {
        // Release the edge's error page rather than leaving the stream open;
        // it is not being served, and nothing else will read it.
        try {
            await response.body?.cancel();
        } catch {
            // Already discarded — there is nothing to release.
        }
        throw new Error(`${origin} did not answer (${response.status})`);
    }

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
            if (route) return await proxy(request, route.origin);
        } catch (error) {
            // The wildcard Worker route means a fault here is the whole site,
            // not one prefix — so nothing is allowed to escape as a 5xx. The
            // origin serves this repository's own pages correctly, and answers
            // a package prefix with a 404: a bad page rather than a dead site.
            //
            // **A package prefix gets that 404 too, deliberately, and not a
            // "this package is unavailable" page.** The router holds no list of
            // packages — that is the whole of heroiclands-site#25 — so a first
            // segment it cannot reach is equally "a package whose host is down"
            // and "no such package at all", and by volume it is overwhelmingly
            // the second: every mistyped top-level path derives an origin that
            // has never existed. A page asserting the first would be a guess,
            // and wrong most of the time it was shown. "No such page here" is
            // true either way, is this site's own maintained 404, and keeps one
            // code path on the whole domain's critical path. The distinction
            // the reader cannot be told is recorded here instead, where an
            // operator can see it.
            console.error(
                "heroiclands-router: falling through to the origin",
                error,
            );
        }

        return fetch(request);
    },
};
