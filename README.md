# heroiclands.org

The Heroic Lands website — worldbuilding resources, Foundry VTT systems and modules, and occasional blog posts.

Built with [Hugo](https://gohugo.io/) and deployed to [GitHub Pages](https://pages.github.com/),
served through Cloudflare as `www.heroiclands.org`. This repository publishes
everything outside a package prefix; `/sohl/` and `/thalorna/` are built and
deployed by their own repositories and composed onto the same hostname by the
routing Worker in `worker/`. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Prerequisites

**Hugo** — and nothing else. The site's content is authored in this repository,
so the build is a single `hugo` run with no generation step ahead of it.

The pinned-in-CI Hugo version is **0.163.3 extended**
(see `.github/workflows/deploy.yml`). The minimum supported version is **0.156.0**
— layouts use the `hugo.Data` API that was introduced in 0.156. Install it
whichever way fits your OS:

| OS | Install command |
|---|---|
| macOS | `brew install hugo` |
| Ubuntu / Debian | `sudo apt install hugo` (older repos may ship an out-of-date version — prefer the release below) |
| Arch | `sudo pacman -S hugo` |
| Windows | `scoop install hugo-extended` or `choco install hugo-extended` |
| Any platform | Download the `_extended_` binary from [github.com/gohugoio/hugo/releases](https://github.com/gohugoio/hugo/releases) and place it on `PATH` |

Verify with `hugo version` — it should report `+extended`.

Node.js is needed only to run the routing Worker's tests (`cd worker && npm
test`), never for the site build.

## Local Development

```bash
npm ci            # once, for the shared theme
hugo server -D    # preview, drafts included
```

The site will be available at `http://localhost:1313/`.

To do a production build into `public/`, exactly as CI does it:

```bash
hugo --minify
```

## Checking the assets a build asks for

Hugo emits image addresses; it never fetches them. A page can name an image
that was never uploaded and nothing fails — the page simply renders with a dead
URL behind it, which for a hero banner is a full-height blank band under the
title. Three separate sources feed those addresses: a page's own
`banner:` / `img:` front matter, the hero the shared theme derives from a
page's `type:`, and the image URLs `hugo.toml` hands the theme (the home cards,
the brand logo, the 404 hero).

`npm run check:assets` reads the answer off the built site — every
`params.cdnBaseURL` address the rendered HTML and CSS actually request — and
fetches each one, failing on any non-200 and naming the page that asked for it:

```bash
hugo --minify && npm run check:assets
```

It takes a build directory (default `public`) and `--base` / `ASSET_BASE_URL`
for the host.

The shared theme runs a complementary check of its own (`lint:banners`), but
the two answer different questions: the theme verifies the banner inventory it
declares, which it must do without knowing what any consumer's content or
config asks for.

## Content Structure

```
content/
  blog/              # Occasional posts, filed by /YYYY/MM/
  projects/          # Landing pages: SoHL, HârnMaster 3, modules, reference
  author.md          # /author/
  license.md         # /license/
content-templates/   # Note templates. Not content — nothing here is published.
worker/              # The routing Worker (its own package.json and tests)
```

Setting and game-system pages are **not** here: `/sohl/` is published by
[Song-of-Heroic-Lands-FoundryVTT](https://github.com/HeroicLands/Song-of-Heroic-Lands-FoundryVTT)
and `/thalorna/` by [sohl-thalorna](https://github.com/HeroicLands/sohl-thalorna),
each onto the same hostname through the routing Worker.

## The package roster and the header navigation

`roster.mjs` is the one authored list of packages HeroicLands publishes — what
each is, which system it is for, and where the header places it. `npm run
roster` projects it into three derived files, each checked against the roster
by `npm run check:roster`:

- `data/roster.json` — the cross-link projection, resolving each package's
  prefix and the packages that depend on it.
- `config/_default/menus.toml` — this site's own header menu. `hugo.toml`
  carries no `[menu]` block; Hugo reads the menu from here instead.
- `static/nav.json` — the same menu, published at
  `https://www.heroiclands.org/nav.json` for the package sites' own build
  toolchain to read.

Adding a package is one entry in `roster.mjs` and a `npm run roster` run —
nothing else in this repository, and nothing in the Worker.

## Adding Content

Create a Markdown file in the appropriate `content/` directory with front matter:

```yaml
---
title: "Page Title"
description: "Brief description"
tags: ["tag1", "tag2"]
draft: false
---

Your content here.
```

Pages with `draft: true` won't appear in production builds (but will show with `hugo server -D`).

## Deployment

Push to `main` → GitHub Actions builds with Hugo and publishes to GitHub Pages.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the whole picture: the three repositories
that publish `www.heroiclands.org`, the routing layer that composes them, and
how to move a package elsewhere.
