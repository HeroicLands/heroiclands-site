# Deployment

`www.heroiclands.org` is one hostname published by **three repositories**. Each
builds and deploys its own part of it; nothing assembles them. The domain
composes their deploys at the edge, by path prefix.

| Path            | Built and deployed by             | Hosting                                 | Workflow            |
| --------------- | --------------------------------- | --------------------------------------- | ------------------- |
| `/sohl/*`       | `Song-of-Heroic-Lands-FoundryVTT` | Cloudflare Pages, `sohl-site`           | `deploy-sohl.yml`   |
| `/thalorna/*`   | `sohl-thalorna`                   | Cloudflare Pages, `sohl-thalorna`       | `deploy-site.yml`   |
| everything else | this repository                   | GitHub Pages                            | `deploy.yml`        |
| the composition | this repository, `worker/`        | Cloudflare Worker, `heroiclands-router` | `deploy-worker.yml` |

**No repository is required for another to publish.** There is no dispatch
between them, no cross-repository checkout, no shared branch and no ordering:
each holds credentials scoped to its own hosting project, deploys on its own
pushes, and its pages are live when its own workflow finishes. A package repository
can be re-deployed, broken, or taken away without touching the others.

That independence is the requirement the architecture was designed against
(`HeroicLands/Song-of-Heroic-Lands-FoundryVTT#1444`): a successor inheriting one
package repository — and nothing else — must be able to publish it. See
[Moving a package elsewhere](#moving-a-package-elsewhere), which is that
requirement written as a procedure. If it ever stops being a short list, the
design has stopped meeting it.

## What this repository publishes

Everything outside a package prefix: the home page, `/blog/`, `/projects/`,
`/tags/`, `/license/` and `/author/`. It publishes **no package content** — no
`sohl` note, no `thalorna` note — and holds none.

```
heroiclands-site (Hugo project + shared theme, an npm dependency)
    │  content/  — authored here, in this repository
    │  .github/workflows/deploy.yml — hugo --minify
    ▼
GitHub Pages  (custom domain: www.heroiclands.org)
    │
    ▼
Cloudflare  — DNS, CDN, the apex → www redirect, and the routing Worker
```

`deploy.yml` runs on every push to `main` and on `workflow_dispatch`. It checks
this repository out, installs the shared theme with `npm ci`, builds with Hugo,
and publishes the artifact to GitHub Pages. **That is the whole build** — no
content generation step and no other repository checked out: Hugo reads
`content/` as it stands, and the one install is the theme, which is an npm
dependency rather than a submodule
(`Song-of-Heroic-Lands-FoundryVTT#1642`).

Nothing rebuilds this site when a package changes, because a package's pages are
not built here. Its own workflow publishes them.

**The content is authored, not exported.** It was generated until
`Song-of-Heroic-Lands-FoundryVTT#1448`, by a script that read the `HeroicLands`
Obsidian vault — which is why `content/` was once gitignored, and why an edit
made to a page here used to be reverted without a word. Both are over: the
markdown under `content/` is the source, edited here like any other file. The
vault, the exporter, and the `vault-updated` dispatch that rebuilt the site from
it are gone.

`content-templates/` holds the note templates that vault carried. They are not
mounted into the build and render no page; see its README.

## What a pull request is checked against

On this repository **merging is deploying** — both `deploy.yml` and
`deploy-worker.yml` trigger on push to `main` — so anything that only runs on
that trigger reports after the decision it exists to inform. Two checks run on
the pull request instead (heroiclands-site#27):

| Workflow          | Runs when a pull request touches                 | What it proves                                                            |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| `worker-test.yml` | `worker/`, `content/`, `hugo.toml`, the lockfile | The router's suite passes, drift check included, with the theme installed |
| `site-build.yml`  | `content/`, `static/`, `hugo.toml`, the lockfile | `hugo --minify` still builds the site, on the Hugo the deploy uses        |

`worker-test.yml` runs on more than `worker/` because the suite checks more than
`worker/`: its drift check walks `content/`, `hugo.toml`'s taxonomies and the
theme's `static/` and fails when a top-level path this site publishes is missing
from the router's reserved list. A new section arrives through `content/`, not
through an edit to the router, so that is where the check has to be armed.

The two are not equally urgent, and the difference is worth keeping in view. A
Hugo build that fails simply fails the deploy, and Pages goes on serving the
previous one — a broken deploy, not a broken site. The Worker has no such
backstop: since #25 gave it a wildcard route it sees every request to the
hostname, so a bad router deploys successfully and takes the whole hostname with
it, which is what happened in #28.

`site-build.yml` duplicates `deploy.yml`'s Node and Hugo pins rather than
sharing them. **They have to move together**: a gate that builds on a different
Hugo than the deploy is a gate that can pass for a deploy that will fail.

Neither check is listed in the repository's ruleset as a **required status
check**, so today each turns a pull request red without blocking its merge
button. Adding them there is what makes them gates rather than reports.

## The routing layer

`worker/` is a Cloudflare Worker (`heroiclands-router`) holding **no content, no
per-page knowledge, and no list of packages**. A request under a package prefix
is proxied to that package's hosting project; everything else is served by this
repository's own deploy.

**Adding a package is no change here at all** (`heroiclands-site#25`). The origin
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
runtime *throws* where the edge answers with a synthesised 530, so the router
that served raw 530s across the site (#28) passes a local smoke test. A check
that is green on the failure it is meant to catch is worse than none. What such
a run would genuinely have added — that the entry module exports only its
handler, since the runtime treats every named export as an entrypoint — is
asserted in the suite instead, for the cost of a module import.

Four properties are worth understanding before changing it.

**The path is preserved, not rewritten.** Each package's deployment carries its
own prefix physically: `/sohl/kb/x/` is at `sohl/kb/x/` inside the SoHL project's
upload. So the proxy is a straight pass-through, and the same deployment behaves
identically at its own `*.pages.dev` address — which is how a package repository
verifies a release before anything here points at it. A router that stripped the
prefix would make those two disagree, and every absolute link in the proxied site
would be wrong at one of them.

**The Worker sees every request, and a fault falls through to the origin.** The
route in `wrangler.toml` is a single wildcard, because a route per package would
be a list of packages in this repository — the thing the derivation removes. What
used to keep a broken router off the rest of the site was that narrowness; what
keeps it off now is the handler's `try`/`catch`, which answers any fault with
`fetch(request)`. That covers strictly more than the narrow routes did, since it
also catches a fault on a prefix the router *does* claim.

**A failure is not always a thrown one, and that distinction cost an outage.**
Cloudflare does **not** throw when an origin hostname does not resolve or does
not answer: `fetch()` *resolves*, with a status the edge synthesised — 530 for
"origin DNS error", 521–526 for an origin that refused, timed out, or failed TLS.
A guard keyed on a thrown error alone therefore never fires for the commonest
failure there is, which is how `/sohl/` and `/thalorna/` served raw 530s to
readers for the life of an outage (`heroiclands-site#28`). So the router treats
those statuses as a failure alongside an exception (`isOriginFailure` in
`worker/src/router.js`), and both fall through. Ordinary 5xx are deliberately
**not** in that set: a package's own 500 or 503 is a page it produced and is its
to serve.

**A package prefix whose origin is unreachable gets this site's 404, not an
"unavailable" page.** That is a decision, not an oversight. The router holds no
list of packages, so a first segment it cannot reach is equally "a package whose
host is down" and "no such package at all" — and by volume it is overwhelmingly
the second, since *every* mistyped top-level path derives an origin that has
never existed. A page asserting the first would be a guess, and wrong most of the
time it was shown. "No such page here" is true either way, is this site's own
maintained 404, and keeps one code path on the whole domain's critical path. The
distinction a reader cannot be told is written to the Worker's log instead, where
an operator can see it; the way to tell the two apart is to ask the upstream
directly (`curl -sSI https://<package>.pkg.heroiclands.org/<package>/`).

**`wrangler dev` cannot reproduce this failure**, so do not treat a local pass as
evidence for it. The local runtime *throws* for a hostname that does not resolve,
where the edge resolves with a 530 — the local check exercises the path that
already worked. The test that covers it stubs `fetch` **resolving** with a 530
(`worker/test/router.test.mjs`); that stub, not the local run, is the guard.

**Which prefixes are packages is decided by exclusion.** The router reserves this
site's own top-level segments — `blog`, `projects`, `tags`, `author`, `license`
and the theme's asset directories — and treats any other first segment as a
package. Only one of the two sets can be written down honestly: packages are
open-ended and arrive from other repositories, while this site's sections live
here. So **adding a section to this site is an edit to `SITE_SEGMENTS`**
(`worker/src/router.js`), next to the `content/` directory it comes with; a test
walks `content/`, the theme's `static/` and the taxonomies and fails if anything
published here is missing from it. Forgetting is not an outage in any case: the
section is proxied to a host that does not resolve, that attempt comes back
unusable, and the fallthrough serves it from the origin correctly — the cost is
latency, not a 404.

**Two response headers name the upstream's own address, and both are rewritten
here** (`canonicalHeaders`). `Location`, because a redirect Pages issues on its
own account — a directory missing its trailing slash, an `.html` path served
extensionless — would otherwise walk the reader onto `*.pages.dev`. And
`X-Robots-Tag`, because a package's deployment marks its host-assigned address
`noindex` so that second address for the same pages cannot compete with the
canonical URL in search results (`Song-of-Heroic-Lands-FoundryVTT#1469`). The
hosting cannot tell this proxy's request apart from a reader's — same URL, same
address — so that header arrives here too, on pages that are canonical and must
be indexed; this is the only place the two addresses are distinguishable. A
package wanting a page indexed nowhere says so in the document
(`<meta name="robots">`), which passes through untouched.

### Every package is on a derived origin

`sohl` and `thalorna` predated the derivation and were live at `*.pages.dev`
names it could not reach — `/sohl/` was served by `sohl-kb`, because a Cloudflare
Pages project keeps the subdomain it was created with and that project was
renamed to `sohl-site` long after. Their `pkg.heroiclands.org` custom domains
were a manual Cloudflare step, and while it was outstanding `LEGACY_ORIGINS` in
`worker/src/router.js` named the two projects as a fallback.

**That migration is finished.** Both custom domains exist, both answer, and
`LEGACY_ORIGINS` and its tests are gone (`heroiclands-site#28`). There is no
second address for a package and no retry against one: the router derives one
origin and asks for it, and an origin that does not answer falls through to this
site's own. Adding a package remains no change here at all.

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

`@heroiclands/hugo-theme` is an npm dependency shared by every site in the
family, and it holds **no address of its own**
(`Song-of-Heroic-Lands-FoundryVTT#1464`). Each consumer supplies its own, so a
site can move without the theme knowing:

- `baseURL` — the one place this site's address is written down.
- The navigation — the theme renders whatever `.Site.Menus.main` holds. Here
  that comes from `config/_default/menus.toml`, generated from `roster.mjs`
  (see the README); another consumer may declare `[menu]` directly.
- `params.cdnBaseURL` — where images resolve from (`cdn.heroiclands.org`). With
  it unset the theme falls back to `relURL`, which yields a working-looking but
  wrong path rather than a build failure, so the config is the guard.
- `params.brand`, `params.home`, `params.notfound` — logo, licence and Discord
  links, the home page's hero and cards, and the 404 page's wording and routes
  back.

A change to the theme is a change to every site that pins it; bump the version
here deliberately, and check a page of each kind before pushing.

## Moving a package elsewhere

The succession case, in full. To take `/thalorna/` (say) off this domain and
publish it at `thalorna.example`:

1. **In the package repository**, set the new address: `baseURL` in
   `site/hugo.toml`, and the directory the build publishes into, which carries
   the path prefix physically. At a domain root there is no prefix to carry.
2. **Point the new address at its hosting project** — a custom domain on the
   existing Cloudflare Pages project, or any static host: the build's output is
   a plain directory tree. Its deploy credentials are already the package's own.
3. **Remove its `pkg.heroiclands.org` custom domain** from its hosting project.
   That is the whole of the disconnection, and it happens in the package's own
   Cloudflare project — **nothing changes in this repository**, which has never
   known the package exists.
4. **Update the consumers' link bases.** Cross-package links resolve through
   each package's published link manifest, which records addresses _relative to
   its own package base_ (`Song-of-Heroic-Lands-FoundryVTT#1465`), so a consumer
   changes one base per package rather than rewriting links.

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
own regression check: its first segment derives an origin that has never existed,
so before `heroiclands-site#28` it answered Cloudflare's raw `530 Origin DNS
error` page. It must answer `404` with this site's own page.

Two more things worth checking after a routing or hosting change:

- **The canonical address stays indexable.** `curl -sI` a package page at
  `www.heroiclands.org` and at its `*.pages.dev` address: the host-assigned one
  carries `X-Robots-Tag: noindex`, the canonical one carries no such header.
- **No proxied page leaks the upstream host.** A redirect issued by the package's
  hosting must come back naming `www.heroiclands.org`.

## Hostnames

| Hostname              | What it does                                                       |
| --------------------- | ------------------------------------------------------------------ |
| `www.heroiclands.org` | **Canonical.** Everything is served here.                          |
| `heroiclands.org`     | 301s to `www`, path and query preserved (Cloudflare rule).         |
| `cdn.heroiclands.org` | Images and shared assets (`params.cdnBaseURL`).                    |
| `*.pkg.heroiclands.org` | Where the router proxies a package prefix. A custom domain on the package's own hosting project, set by that package's deploy. |
| `*.pages.dev`         | Each package project's own address. Real, unadvertised, `noindex`. |

`kb.heroiclands.org` and `api.heroiclands.org` are **retired**: their DNS records
are deleted and they resolve to nothing. The knowledgebase and the API
documentation live at `/sohl/kb/` and `/sohl/api/`. Links to the old hostnames
are dead by decision, including from releases of the game system already
installed — see `Song-of-Heroic-Lands-FoundryVTT#1444`.

## Wiring, if any of it has to be rebuilt

**GitHub Pages.** Settings → Pages → Source: **GitHub Actions**; custom domain
`www.heroiclands.org`. The workflow publishes with `actions/deploy-pages`.

**Cloudflare DNS** for `heroiclands.org`: `www` → `<owner>.github.io`, proxied;
the apex proxied likewise, with a redirect rule sending `heroiclands.org/*` to
`https://www.heroiclands.org/$1` (301). SSL/TLS mode **Full** — GitHub Pages
serves its own certificate.

**Repository secrets.** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, for
the Worker — and nothing else. The Pages build needs no credential of its own,
and this repository holds none belonging to another: each package repository
keeps its own Cloudflare credentials, scoped to its own project.

**Rebuilding by hand** is the **Run workflow** button on the Actions tab (the
**Deploy to GitHub Pages** workflow). Nothing else triggers a build.

## Local development

Hugo builds the site; the one thing to install first is the shared theme, which
is an npm dependency.

```bash
npm ci               # once, for the theme
hugo server -D       # preview, drafts included
hugo --minify        # what CI publishes, into public/
```

The routing Worker is separate and testable on its own — `cd worker && npm test`
runs the table and URL handling as plain `node:test` functions, no runtime
required. It has no dependencies of its own, but run the root `npm ci` first if
you want the drift check to see the theme's `static/` directories too.
