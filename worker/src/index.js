/**
 * heroiclands-router — the path-prefix routing layer for www.heroiclands.org.
 *
 * One hostname, several publishers. This site's own deploy (GitHub Pages) serves
 * everything by default; a package repository that builds and publishes its own
 * subtree gets a prefix here, and requests under it are proxied to that
 * repository's hosting project instead.
 *
 * The router holds **no content and no per-page knowledge** — one row per
 * package in `ROUTES`, and adding or removing a package is that one row. That is
 * the point: each repository stays publishable on its own, and none is required
 * for another to deploy (HeroicLands/Song-of-Heroic-Lands-FoundryVTT#1468).
 *
 * Worker routes (see wrangler.toml) decide what reaches this script at all;
 * anything else never leaves the origin, so a broken router cannot take the site
 * down — only the prefixes it claims. `ROUTES` (see src/router.js) decides where
 * a request that does reach it goes, and the two must be kept in step.
 *
 * This module exports **only** the handler: the Workers runtime treats every
 * named export of the entry module as an entrypoint, and refuses to start when
 * one is not a handler. The table and the URL handling live in src/router.js.
 */

import { routeFor, upstreamURL, rewriteLocation } from "./router.js";

export default {
    /**
     * @param {Request} request - The incoming request.
     * @returns {Promise<Response>} The upstream response, or this site's origin.
     */
    async fetch(request) {
        const { pathname } = new URL(request.url);
        const route = routeFor(pathname);

        // Belt and braces: the Worker routes should mean this never happens,
        // but a request that reaches the script with no route of its own must
        // reach the origin rather than be answered by the router.
        if (!route) return fetch(request);

        const proxied = new Request(upstreamURL(request.url, route.origin), {
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

        const response = await fetch(proxied);
        const original = response.headers.get("location");
        const location = rewriteLocation(original, route.origin);
        if (location === original) return response;

        const headers = new Headers(response.headers);
        headers.set("location", location);
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    },
};
