# Deployment

`www.heroiclands.org` is one hostname published by **three repositories**. Each
builds and deploys its own part of it; nothing assembles them. The domain
composes their deploys at the edge, by path prefix.

| Path            | Built and deployed by             | Hosting                                 | Workflow            |
| --------------- | --------------------------------- | --------------------------------------- | ------------------- |
| `/sohl/*`       | `Song-of-Heroic-Lands-FoundryVTT` | Cloudflare Pages, `sohl-site`           | `deploy-sohl.yml`   |
| `/thalorna/*`   | `sohl-thalorna`                   | Cloudflare Pages, `sohl-thalorna`       | `deploy-site.yml`   |
| everything else | this repository                   | Cloudflare Pages, `heroiclands-site`    | `deploy-site.yml`   |
| the composition | this repository, `worker/`        | Cloudflare Worker, `heroiclands-router` | `deploy-worker.yml` |

**No repository is required for another to publish.** There is no dispatch
between them, no cross-repository checkout, no shared branch and no ordering:
each holds credentials scoped to its own hosting project, deploys on its own
pushes, and its pages are live when its own workflow finishes. A package repository
can be re-deployed, broken, or taken away without touching the others.

That independence is the requirement the architecture is designed to meet: a
successor inheriting one package repository — and nothing else — must be able
to publish it. See [Moving a package elsewhere](#moving-a-package-elsewhere),
which is that requirement written as a procedure. If it ever stops being a
short list, the design has stopped meeting it.

## What this repository publishes

Everything outside a package prefix: the home page, `/blog/`, `/projects/`,
`/tags/`, `/license/`, `/author/`, the project pages (`/songofheroiclands/`,
`/harnmaster3/`, `/modules/`, `/reference/`), every other page at
`/<type>-<shortcode>/` (each post) — the sitemap index,
`robots.txt` and `/nav.json`. It publishes **no package content** — no `sohl`
note, no `thalorna` note — and holds none.

```
site (package-build content tree)
    │  content/  — authored here, in this repository
    │  .gitea/workflows/deploy-site.yml — npm run build
    ▼
Cloudflare Pages, project heroiclands-site  (custom domain: www.pkg.heroiclands.org)
    │
    ▼
Cloudflare  — DNS, CDN, the apex → www redirect, and the routing Worker,
              which proxies every path outside a package prefix to the project
```

`deploy-site.yml` runs on every push to `main` and on `workflow_dispatch`, on
Gitea. It checks this repository out, installs `@heroiclands/package-build`
with `npm ci`, builds with `npm run build`, checks the assets the pages ask for
and that the tree is a complete site, and publishes `build/site/` to the
Pages project. **That is the whole build** — no content generation step and no
other repository checked out: `package-build site build` reads `content/` as it
stands.

The build writes the sitemap index and `robots.txt` from `site.sitemaps` in
`package-build.config.yaml`, which names every package in the roster, and
merges into its search the indexes `site.mergeIndexes` names, each read from
`/<package>/pagefind/` on this hostname. Nothing rebuilds this site when a
package changes, because a package's pages are not built here: its own workflow
publishes them, and its sitemap and search index with them.

**The content is authored, not exported.** The notes under `content/` are the
source, edited here like any other file.

`content-templates/` holds note templates. They are not read by the build and
render no page; see its README.

## What a pull request is checked against

On this repository **merging is deploying** — both `deploy-site.yml` and
`deploy-worker.yml` trigger on push to `main` — so anything that only runs on
that trigger reports after the decision it exists to inform. Two checks run on
the pull request instead:

| Workflow          | Runs when a pull request touches                                 | What it proves                                                            |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `worker-test.yml` | `worker/`, `package-build.config.yaml`, the roster, the lockfile | The router's suite passes, drift check included, with the theme installed |
| `site-build.yml`  | `content/`, `static/`, `package-build.config.yaml`, the lockfile | `npm run build` still builds the site, and its assets are published       |

`worker-test.yml` runs on more than `worker/` because the suite checks more than
`worker/`: its drift check reads `package-build.config.yaml`'s sections and the
theme's `static/` and fails when a top-level path this site publishes is missing
from the router's reserved list, and its roster check fails when `site.sitemaps`
does not list the roster. A new section arrives through
`package-build.config.yaml`, not through an edit to the router, so that is where
the check has to be armed.

The two are not equally urgent, and the difference is worth keeping in view. A
site build that fails simply fails the deploy, and Pages goes on serving the
previous one — a broken deploy, not a broken site. The Worker has no such
backstop: its wildcard route means it sees every request to the hostname, so a
bad router deploys successfully and takes the whole hostname with it.

`site-build.yml` builds with the same Node and the same `npm run build` as
`deploy-site.yml`. **They have to move together**: a gate that builds
differently from the deploy is a gate that can pass for a deploy that will fail.

Neither check is listed in the repository's ruleset as a **required status
check**, so today each turns a pull request red without blocking its merge
button. Adding them there is what makes them gates rather than reports.

## The routing layer

`worker/` is a Cloudflare Worker (`heroiclands-router`) holding **no content, no
per-page knowledge, and no list of packages**. A request under a package prefix
is proxied to that package's hosting project; everything else is proxied to this
repository's own Pages project, at `www.pkg.heroiclands.org`.

**Adding a package is no change here at all.** The origin
is derived from the prefix:

```
/<package>/  →  https://<package>.pkg.heroiclands.org
```

so a package becomes publishable on this domain entirely from its own
repository. What that repository does is give its hosting project the matching
custom domain, from the workflow that already creates the project. Removing a
package is removing that custom domain; nothing here knows it existed.

The namespace is deliberately one this organisation owns rather than
`<package>.pages.dev`: `*.pages.dev` is global across every Cloudflare account,
`hm3.pages.dev` is already somebody else's live project, and any other name
could be claimed tomorrow.

`worker/test/` covers the derivation and the URL handling as ordinary functions,
plus the handler itself against a stubbed `fetch`: `cd worker && npm test`. It
runs on a pull request that touches the router as well as on the deploy — see
[What a pull request is checked against](#what-a-pull-request-is-checked-against).

**There is no `wrangler dev` smoke check, deliberately.** Driving the real paths
locally is a useful thing to do by hand, but it is not evidence: the local
runtime _throws_ where the edge answers with a synthesised 530, so a router
serving raw 530s across the site still passes a local smoke test. A check that
is green on the failure it is meant to catch is worse than none. What such a
run would genuinely add — that the entry module exports only its handler,
since the runtime treats every named export as an entrypoint — is asserted in
the suite instead, for the cost of a module import.

Four properties are worth understanding before changing it.

**The path is preserved, not rewritten.** Each package's deployment carries its
own prefix physically: `/sohl/kb/x/` is at `sohl/kb/x/` inside the SoHL project's
upload. So the proxy is a straight pass-through, and the same deployment behaves
identically at its own `*.pages.dev` address — which is how a package repository
verifies a release before anything here points at it. A router that stripped the
prefix would make those two disagree, and every absolute link in the proxied site
would be wrong at one of them.

**The Worker sees every request, and a fault falls through to this site's
origin.** The route in `wrangler.toml` is a single wildcard, because a route per
package would be a list of packages in this repository — the thing the
derivation removes. What keeps a broken package origin off the rest of the site
is the handler's `try`/`catch`, which answers any fault on a prefix by
proxying the request to this site's own Pages project — including a fault on a
prefix the router _does_ claim. That origin is the last resort, so its own
answer is passed on whatever it is.

**A failure is not always a thrown one.** Cloudflare does **not** throw when an
origin hostname does not resolve or does not answer: `fetch()` _resolves_, with
a status the edge synthesised — 530 for "origin DNS error", 521–526 for an
origin that refused, timed out, or failed TLS. A guard keyed on a thrown error
alone therefore never fires for the commonest failure there is. So the router
treats those statuses as a failure alongside an exception (`isOriginFailure` in
`worker/src/router.js`), and both fall through. Ordinary 5xx are deliberately
**not** in that set: a package's own 500 or 503 is a page it produced and is its
to serve.

**A package prefix whose origin is unreachable gets this site's 404, not an
"unavailable" page.** That is a decision, not an oversight. The router holds no
list of packages, so a first segment it cannot reach is equally "a package whose
host is down" and "no such package at all" — and by volume it is overwhelmingly
the second, since _every_ mistyped top-level path derives an origin that has
never existed. A page asserting the first would be a guess, and wrong most of the
time it was shown. "No such page here" is true either way, is this site's own
maintained 404, and keeps one code path on the whole domain's critical path. The
distinction a reader cannot be told is written to the Worker's log instead, where
an operator can see it; the way to tell the two apart is to ask the upstream
directly (`curl -sSI https://<package>.pkg.heroiclands.org/<package>/`).

**`wrangler dev` cannot reproduce this failure**, so do not treat a local pass as
evidence for it. The local runtime _throws_ for a hostname that does not resolve,
where the edge resolves with a 530 — the local check exercises the path that
already worked. The test that covers it stubs `fetch` **resolving** with a 530
(`worker/test/router.test.mjs`); that stub, not the local run, is the guard.

**Which prefixes are packages is decided by exclusion.** A package's name is its
`contentPackage`, lowercase letters and digits, so a first segment holding a
hyphen is never one: every page of this site is at `/<type>-<shortcode>/` and
needs no reserving. The router reserves this site's other top-level segments —
`blog`, `projects`, `tags`, `pagefind` and the theme's asset directories — and
treats any other first segment as a package. Only one of the two sets can be
written down honestly: packages are open-ended and arrive from other
repositories, while this site's sections live here. So **adding a section to
this site is an edit to `SITE_SEGMENTS`** (`worker/src/router.js`), beside the
`site.sections` entry it comes with; a test reads `site.sections`, `site.feed`,
`site.tags` and the theme's `static/` and fails if anything published here is
missing from it. Forgetting is not an outage in any case: the section is
proxied to a host that does not resolve, that attempt comes back unusable, and
the fallthrough serves it from this site's origin correctly — the cost is
latency, not a 404.

**Two response headers name the upstream's own address, and both are rewritten
here** (`canonicalHeaders`). `Location`, because a redirect Pages issues on its
own account — a directory missing its trailing slash, an `.html` path served
extensionless — would otherwise walk the reader onto `*.pages.dev`. And
`X-Robots-Tag`, because a package's deployment marks its host-assigned address
`noindex` so that second address for the same pages cannot compete with the
canonical URL in search results. The hosting cannot tell this proxy's request
apart from a reader's — same URL, same address — so that header arrives here
too, on pages that are canonical and must be indexed; this is the only place
the two addresses are distinguishable. A package wanting a page indexed
nowhere says so in the document (`<meta name="robots">`), which passes through
untouched.

### Every package is on a derived origin

There is no second address for a package and no retry against one: the router
derives one origin and asks for it, and an origin that does not answer falls
through to this site's own. Adding a package remains no change here at all.

Verify at the upstreams directly if a package prefix ever misbehaves — that is
the check that tells "the package's host is down" apart from "no such package",
which the router itself cannot:

```bash
curl -sSI https://sohl.pkg.heroiclands.org/sohl/kb/     | head -1
curl -sSI https://thalorna.pkg.heroiclands.org/thalorna/ | head -1
```

Deploying the Worker needs two repository secrets: `CLOUDFLARE_API_TOKEN` (with
**Workers Scripts: Edit**, **Workers Routes: Edit** and **Zone: Read** on
`heroiclands.org`) and `CLOUDFLARE_ACCOUNT_ID`. The **Deploy the routing
Worker** workflow runs on any push touching `worker/`, and by hand from the
Actions tab.

## The shared theme carries layout, not addresses

The theme every site in the family is drawn with ships inside
`@heroiclands/package-build`, and it holds **no address of its own**. Each
consumer supplies its own, so a site can move without the theme knowing:

- `package.json`'s `homepage` — the one place this site's address is written
  down, with `site.base: /` saying it is the root of its origin.
- The navigation — the theme renders whatever navigation the build caches.
  Here that is `static/nav.json`, generated from `roster.mjs` (see the README)
  and cached by `npm run build` before the site build reads it; a package site
  caches the copy this site publishes with `package-build deps fetch`.
- `site.assets` — where images resolve from (`cdn.heroiclands.org`).
- `site.notfound` — the 404 page's wording and routes back.

A change to the theme is a change to every site that pins package-build; bump
the version here deliberately, and check a page of each kind before pushing.

## Moving a package elsewhere

The succession case, in full. To take `/thalorna/` (say) off this domain and
publish it at `thalorna.example`:

1. **In the package repository**, set the new address: `homepage` in its
   `package.json`, and at a domain root `site.base: /` in its
   `package-build.config.yaml`, so the build writes the site at the root of
   the deployed tree rather than under its prefix.
2. **Point the new address at its hosting project** — a custom domain on the
   existing Cloudflare Pages project, or any static host: the build's output is
   a plain directory tree. Its deploy credentials are already the package's own.
3. **Remove its `pkg.heroiclands.org` custom domain** from its hosting project.
   That is the whole of the disconnection, and it happens in the package's own
   Cloudflare project — **nothing changes in this repository**, which has never
   known the package exists.
4. **Update the consumers' link bases.** Cross-package links resolve through
   each package's published link manifest, which records addresses _relative to
   its own package base_, so a consumer changes one base per package rather
   than rewriting links.

Nothing above needs this repository's credentials, a coordinated release, or a
window in which both sides are updated together — steps 1–2 and step 3 can happen
in either order, at the cost of a brief 404 or a brief stale copy.

## Checking a deploy

**A Cloudflare Pages project with no `404.html` answers HTTP 200 for unknown
paths, carrying the landing page.** That soft-404 reads as success to every
"does this URL resolve?" check, and it lets search engines index retired content
as live. With three projects instead of one, the trap applies three times over.
So when checking URLs, **compare the page's `<title>`, not the status code** —
and prove each prefix answers a real 404:

```bash
for u in / /blog/ /projects/ \
         /sohl/ /sohl/kb/ /sohl/api/ \
         /thalorna/ /thalorna/world/thalorna/ \
         /nope/ /sohl/nope/ /thalorna/nope/; do
    printf '%-34s %s\n' "$u" \
      "$(curl -sS -o /dev/null -w '%{http_code}' "https://www.heroiclands.org$u")"
done
```

Each package's build asserts its own `404.html` exists before uploading, because
its absence is invisible until someone mistypes a URL in production.

**No line of that output may be a 5xx.** `/nope/` in particular is the router's
own regression check: its first segment derives an origin that has never
existed. It must answer `404` with this site's own page, never Cloudflare's raw
`530 Origin DNS error`.

Two more things worth checking after a routing or hosting change:

- **The canonical address stays indexable.** `curl -sI` a package page at
  `www.heroiclands.org` and at its `*.pages.dev` address: the host-assigned one
  carries `X-Robots-Tag: noindex`, the canonical one carries no such header.
- **No proxied page leaks the upstream host.** A redirect issued by the package's
  hosting must come back naming `www.heroiclands.org`.

## Hostnames

| Hostname                  | What it does                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `www.heroiclands.org`     | **Canonical.** Everything is served here.                                                                                      |
| `heroiclands.org`         | 301s to `www`, path and query preserved (Cloudflare rule).                                                                     |
| `cdn.heroiclands.org`     | Images and shared assets (`params.cdnBaseURL`).                                                                                |
| `*.pkg.heroiclands.org`   | Where the router proxies a package prefix. A custom domain on the package's own hosting project, set by that package's deploy. |
| `www.pkg.heroiclands.org` | Where the router proxies every other path: the custom domain of this site's Pages project, set by `deploy-site.yml`.           |
| `*.pages.dev`             | Each project's own address, this site's included. Real, unadvertised, `noindex`.                                               |

`kb.heroiclands.org` and `api.heroiclands.org` are **retired**: their DNS records
are deleted and they resolve to nothing. The knowledgebase and the API
documentation live at `/sohl/kb/` and `/sohl/api/`. Links to the old hostnames
are dead by decision, including from releases of the game system already
installed.

## Wiring, if any of it has to be rebuilt

**Cloudflare Pages.** The project `heroiclands-site`, production branch
`main`, with the custom domain `www.pkg.heroiclands.org` and its proxied CNAME
to `heroiclands-site.pages.dev`. `deploy-site.yml` creates any of the three
that is missing, so a rebuild is a run of that workflow.

**Cloudflare DNS** for `heroiclands.org`: `www` proxied, so the Worker's route
receives it — the Worker answers every request, so the record's own target is
never fetched; the apex proxied likewise, with a redirect rule sending
`heroiclands.org/*` to `https://www.heroiclands.org/$1` (301).

**Repository secrets and variables.** `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, shared by the Worker deploy and the site deploy, so the
token carries **Workers Scripts: Edit**, **Workers Routes: Edit**, **Account →
Cloudflare Pages: Edit** and **Zone → DNS: Edit** on `heroiclands.org`; and the
variable `HL_DEPLOY_ENABLED`, `true`, which gates both deploys. This repository
holds no credential belonging to another: each package repository keeps its own
Cloudflare credentials, scoped to its own project.
