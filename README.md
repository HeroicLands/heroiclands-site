# heroiclands.org

The Heroic Lands website — worldbuilding resources, Foundry VTT systems and modules, and occasional blog posts.

Built with [Hugo](https://gohugo.io/) and deployed to [Cloudflare Pages](https://pages.cloudflare.com/).

## Prerequisites

The build has two external dependencies: **Node.js** (to run the TypeScript export
script that converts the Obsidian vault into Hugo-ready markdown) and **Hugo**
(the static-site generator itself). Both must be installed and on `PATH` before
running any of the npm scripts.

The pinned-in-CI Hugo version is **0.160.1 extended**
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

Node.js 20+ is what CI uses. Any recent LTS will work.

## Local Development

```bash
npm install            # one-time, installs TypeScript / ts-node / etc.
npm run dev            # exports content from the vault and starts hugo server
```

The site will be available at `http://localhost:1313/`.

To do a full production build (clean + export + compile to `public/`):

```bash
npm run build
```

### Troubleshooting `ENOENT spawn hugo-bin/vendor/hugo`

If `npm run build` fails with an error mentioning `hugo-bin/vendor/hugo`,
your `node_modules` contains a stale symlink from a previous dependency
setup. Clear it with:

```bash
rm -rf node_modules package-lock.json
npm install
```

After that `npm run build` will call whatever `hugo` is on your `PATH`.

## Content Structure

```
content/
  worldbuilding/     # Thalorna lore, cultures, creatures, etc.
  projects/          # Foundry VTT systems and modules
  blog/              # Occasional posts
```

## Adding Content

Create a new page:

```bash
hugo new worldbuilding/my-page.md
```

Or just create a Markdown file in the appropriate `content/` directory with front matter:

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

Push to `main` branch → Cloudflare Pages auto-builds and deploys.

See [DEPLOYMENT.md](DEPLOYMENT.md) for setup details.
