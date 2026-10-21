# heroiclands.org

The Heroic Lands website — worldbuilding resources, Foundry VTT systems and modules, and occasional blog posts.

Built with [`@heroiclands/package-build`](https://www.npmjs.com/package/@heroiclands/package-build)
and deployed to Cloudflare Pages, served through Cloudflare as
`www.heroiclands.org`. This repository publishes everything outside a package
prefix; `/sohl/`, `/thalorna/` and the other package sites are built and
deployed by their own repositories and composed onto the same hostname by the
routing Worker in `worker/`. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Prerequisites

Node.js **24 or newer** (see `package.json`'s `engines` field) and npm. The
site's content is authored in this repository and built by `package-build`,
which `npm ci` installs; nothing else is needed. The routing Worker's tests run
with Node alone (`cd worker && npm test`).

`npm ci` activates the tracked `.githooks` hooks. The commit-message check also
uses Node 24 or newer and rejects supported assistant credits while allowing
human coauthors and explanatory prose. The shared No Attribution workflow checks
PR titles, bodies and commit messages.

## Local Development

```bash
npm ci            # once
npm run serve     # preview at http://127.0.0.1:1313/, rebuilt and reloaded as you edit
```

To do a production build into `build/site/`, exactly as CI does it:

```bash
npm run build
```

The build renders every note, writes the blog's Atom feed, the tag pages, the
sitemap, the sitemap index and `robots.txt` naming every package site's
sitemap, and the search index, and copies `static/nav.json` beside them.

The search box searches this site and every package site whose index
`site.mergeIndexes` names. Each of those is read from `/<package>/pagefind/` on
the same origin, so the merged search works at `www.heroiclands.org`, where the
routing Worker serves every site on one hostname; `npm run serve` serves this
site alone, and its search finds this site's pages.

## Checking the assets a build asks for

The site build emits image addresses; it never fetches them. A page can name an
image that was never uploaded and nothing fails — the page simply renders with
a dead URL behind it, which for a hero banner is a full-height blank band under
the title. Separate sources feed those addresses: a note's own art, the hero
the shared theme derives from a page's `type:`, and the image addresses
`package-build.config.yaml` hands the theme (the 404 hero) beside the brand
logo.

`npm run check:assets` reads the answer off the built site — every
`site.assets` address the rendered HTML and CSS actually request — and fetches
each one, failing on any non-200 and naming the page that asked for it:

```bash
npm run build && npm run check:assets
```

It takes a build directory (default `build/site`) and `--base` /
`ASSET_BASE_URL` for the host.

The shared theme runs a complementary check of its own (`lint:banners`), but
the two answer different questions: the theme verifies the banner inventory it
declares, which it must do without knowing what any consumer's content or
config asks for.

## Content Structure

```
content/
  homepage.md        # the home page, /
  blog/              # the blog: its page (/blog/) and its posts
  projects/          # the projects page (/projects/) and each project's page
  author.md          # /author/
  license.md         # /license/
content-templates/   # Note templates. Not content — nothing here is published.
worker/              # The routing Worker (its own package.json and tests)
```

Every page is a note in package-build's format, published at
`/<type>-<shortcode>/` — `/doc-welcome/` is the `doc` note whose `shortcode` is
`welcome`. `site.sections` in `package-build.config.yaml` publishes a note at a
single-segment address of its own instead: `doc-blog` at `/blog/`, `doc-projects`
at `/projects/`, `doc-author` at `/author/`, `doc-license` at `/license/`,
`doc-sohl` at `/songofheroiclands/`, `doc-harnmaster3` at `/harnmaster3/`,
`doc-modules` at `/modules/` and `doc-reference` at `/reference/`. A section is
one segment, so the project pages cannot sit under `/projects/`, and a name that
is a package's (`sohl`, `hm3`) is never used. Each section name is also listed in
`SITE_SEGMENTS` in `worker/src/router.js`.

Setting and game-system pages are **not** here: `/sohl/` is published by
[Song-of-Heroic-Lands-FoundryVTT](https://github.com/HeroicLands/Song-of-Heroic-Lands-FoundryVTT)
and `/thalorna/` by [sohl-thalorna](https://github.com/HeroicLands/sohl-thalorna),
each onto the same hostname through the routing Worker.

## The package roster and the header navigation

`roster.mjs` is the one authored list of packages HeroicLands publishes — what
each is, which system it is for, and where the header places it. `npm run
roster` projects it into two derived files, each checked against the roster
by `npm run check:roster`:

- `data/roster.json` — the cross-link projection, resolving each package's
  prefix and the packages that depend on it.
- `static/nav.json` — the header menu. This site's own header is drawn from it,
  and it is published at `https://www.heroiclands.org/nav.json` for the package
  sites' own build toolchain to read.

Adding a package is one entry in `roster.mjs`, a `npm run roster` run, and the
package's name in `site.sitemaps` in `package-build.config.yaml` — and in
`site.mergeIndexes` too when its site has a search. The Worker needs nothing;
its suite checks that `site.sitemaps` lists the roster.

## Adding Content

A page is a note: a Markdown file anywhere under `content/`, with front matter
in package-build's format.

```yaml
---
type: doc
shortcode: example
name:
  full: Page Title
description: Brief description
tags: [tag1, tag2]
---
Your content here. Link another page by its address: [[doc-license|the license]].
```

A blog post is a `doc` of `subType: post` with the day it is published; see
`content-templates/New_Blog_Post_Template.md`:

```yaml
---
type: doc
subType: post
shortcode: newpost
name:
  full: A New Post
description: What it is about.
tags: [announcements]
data:
  date: 2026-05-01
---
```

A post names its writer in `data.author`, or carries the site's byline. A note
tagged `draft` still publishes, marked as unfinished.

## Deployment

Push to `main` → the Gitea workflow `deploy-site.yml` builds the site and
publishes it to the Cloudflare Pages project `heroiclands-site`.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the whole picture: the repositories that
publish `www.heroiclands.org`, the routing layer that composes them, and how to
move a package elsewhere.
