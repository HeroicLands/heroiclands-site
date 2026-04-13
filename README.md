# heroiclands.org

The Heroic Lands website — worldbuilding resources, Foundry VTT systems and modules, and occasional blog posts.

Built with [Hugo](https://gohugo.io/) and deployed to [Cloudflare Pages](https://pages.cloudflare.com/).

## Local Development

```bash
# Install Hugo (macOS)
brew install hugo

# Run dev server
hugo server -D

# Build for production
hugo
```

The site will be available at `http://localhost:1313/`.

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
