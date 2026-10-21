/**
 * heroiclands-router — the path-prefix routing layer for www.heroiclands.org.
 *
 * One hostname, several publishers. This site's own deploy — its Cloudflare
 * Pages project, at `SITE_HOSTING_ORIGIN` — serves everything by default; a
 * package repository that builds and publishes its own subtree is reached
 * under `/<package>/`, and requests there are proxied to that repository's
 * hosting project instead.
 *
 * The router holds **no content, no per-page knowledge, and no list of
 * packages**. A package's origin is derived from its prefix
 * (`/<package>/` → `https://<package>.pkg.heroiclands.org`), so a package
 * becomes publishable here entirely from its own repository and this one is
 * never edited for it. That is the point: each repository
 * stays publishable on its own, and none is required for another to deploy.
 *
 * **Every request to the hostname reaches this script** — the Worker route is a
 * wildcard, because narrow per-package routes would be a list of packages in
 * `wrangler.toml`. What keeps a broken route off the rest of the site is the
 * `try`/`catch` below: any fault on a package prefix falls through to this
 * site's own origin, which answers. That covers strictly more than narrow
 * routes would, since it also catches a fault on a prefix the router *does*
 * claim.
 *
 * **A failure is not always a thrown one.** Cloudflare answers an unreachable
 * origin with a 530 (or a 52x) rather than rejecting, so a guard keyed on a
 * thrown error alone never fires for the commonest failure there is. Both an
 * exception and an unusable response are faults here, and both fall through.
 *
 * This module exports **only** the handler: the Workers runtime treats every
 * named export of the entry module as an entrypoint, and refuses to start when
 * one is not a handler. The routing decisions and the URL handling live in
 * src/router.js.
 */

import {
    SITE_HOSTING_ORIGIN,
    canonicalHeaders,
    isOriginFailure,
    routeFor,
    upstreamURL,
} from "./router.js";

/**
 * Proxy a request to an origin and answer as this site.
 *
 * Throws when the origin did not answer at all, so the caller's `catch` handles
 * an unreachable origin and a thrown fault by one path. That is not a
 * refinement: **Cloudflare resolves with a 530 rather than throwing** when a
 * hostname does not resolve, so the guard below is reachable for that failure
 * only through this check. The last resort, this site's own origin, passes its
 * answer on whatever it is: there is no origin behind it to fall through to.
 *
 * @param {Request} request - The incoming request.
 * @param {string} origin - The origin to proxy to.
 * @param {object} [options] - Options.
 * @param {boolean} [options.lastResort] - Pass a did-not-answer status on
 *   rather than throwing.
 * @returns {Promise<Response>} The upstream response, re-headed for this site.
 * @throws {Error} When the upstream never answered — see `isOriginFailure` —
 *   and it is not the last resort.
 */
async function proxy(request, origin, { lastResort = false } = {}) {
    const proxied = new Request(upstreamURL(request.url, origin), {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        // Hand the upstream's own redirects back to the reader rather than
        // resolving them here, so a redirect stays visible as a redirect.
        redirect: "manual",
    });

    // The upstream answers as its own hosting project — naming itself in
    // redirects, and marking itself `noindex` — and this is where those
    // answers become this site's. See `canonicalHeaders`.
    const response = await fetch(proxied);
    if (!lastResort && isOriginFailure(response.status)) {
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

            // No route: this site publishes the path itself, and its own
            // origin answers it below.
            if (route) return await proxy(request, route.origin);
        } catch (error) {
            // The wildcard Worker route means a fault here is the whole site,
            // not one prefix — so nothing is allowed to escape as a 5xx. The
            // origin serves this repository's own pages correctly, and answers
            // a package prefix with a 404: a bad page rather than a dead site.
            //
            // **A package prefix gets that 404 too, deliberately, and not a
            // "this package is unavailable" page.** The router holds no list of
            // packages — that is the whole point — so a first
            // segment it cannot reach is equally "a package whose host is down"
            // and "no such package at all", and by volume it is overwhelmingly
            // the second: every mistyped top-level path derives an origin that
            // has never existed. A page asserting the first would be a guess,
            // and wrong most of the time it was shown. "No such page here" is
            // true either way, is this site's own maintained 404, and keeps one
            // code path on the whole domain's critical path. The distinction
            // the reader cannot be told is recorded here instead, where an
            // operator can see it.
            console.error("heroiclands-router: falling through to the origin", error);
        }

        return proxy(request, SITE_HOSTING_ORIGIN, { lastResort: true });
    },
};
