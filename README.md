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
git submodule update --init --recursive   # once, for the shared theme
hugo server -D                            # preview, drafts included
```

The site will be available at `http://localhost:1313/`.

To do a production build into `public/`, exactly as CI does it:

```bash
hugo --minify
```

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
