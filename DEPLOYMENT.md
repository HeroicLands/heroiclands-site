# Deployment: GitHub Pages + Cloudflare

This site is built with Hugo, deployed to GitHub Pages, and served
through Cloudflare as www.heroiclands.org.

## Architecture

```
thalorna (Obsidian vault)
    │
    │  export-hugo.ts
    ▼
heroiclands-site (Hugo project)
    │
    │  GitHub Actions: hugo --minify
    ▼
GitHub Pages
    │
    │  DNS proxy + CDN
    ▼
Cloudflare → www.heroiclands.org
```

## How it works

1. The **thalorna** repo is an Obsidian vault containing all worldbuilding
   content. Files with `publish.website: true` in their front matter are
   eligible for the public site.

2. The **export-hugo.ts** script reads the vault, transforms Obsidian
   markdown to Hugo-compatible markdown (rewriting wikilinks, stripping
   game-mechanical fields, copying images), and writes to `content/worldbuilding/`.

3. A **GitHub Actions** workflow (`.github/workflows/deploy.yml`) runs on
   every push to `main`:
   - Checks out both repos (site + vault)
   - Runs the export script
   - Builds Hugo
   - Deploys to GitHub Pages

4. **Cloudflare** sits in front as a DNS proxy and CDN.

## Initial setup

### GitHub

1. Create the `heroiclands-site` repo on GitHub (public or private).
2. Create a **Personal Access Token** (classic, with `repo` scope) that
   can read the `thalorna` repo.
3. Add it as a repository secret named `VAULT_TOKEN` in the
   `heroiclands-site` repo settings (Settings → Secrets → Actions).
4. Enable GitHub Pages: Settings → Pages → Source: **GitHub Actions**.

### Cloudflare

1. In Cloudflare DNS for heroiclands.org, add a CNAME record:
   - Name: `www`
   - Target: `<your-github-username>.github.io`
   - Proxy status: Proxied (orange cloud)
2. For the apex domain, add a CNAME or ALIAS:
   - Name: `@`
   - Target: `<your-github-username>.github.io`
   - Proxy status: Proxied
3. In the GitHub repo settings, add `heroiclands.org` and
   `www.heroiclands.org` as custom domains under Pages.
4. SSL/TLS: Set Cloudflare encryption mode to **Full** (not Full Strict,
   since GitHub Pages provides its own cert).

### Triggering a rebuild from vault changes

Option A: Add a webhook or GitHub Action in the `thalorna` repo that sends
a `repository_dispatch` event to `heroiclands-site`:

```yaml
# In thalorna/.github/workflows/notify-site.yml
name: Notify site of vault update
on:
  push:
    branches: [main]
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -X POST \
            -H "Authorization: token ${{ secrets.SITE_DISPATCH_TOKEN }}" \
            -H "Accept: application/vnd.github.v3+json" \
            https://api.github.com/repos/${{ github.repository_owner }}/heroiclands-site/dispatches \
            -d '{"event_type":"vault-updated"}'
```

Option B: Manually trigger from the Actions tab (workflow_dispatch).

## Local development

```bash
# Export vault content
npm run export

# Preview site
hugo server -D

# Dry run (see what would be exported without writing files)
npm run export:dry
```

## Environment variables

| Variable     | Default                          | Description              |
|-------------|----------------------------------|--------------------------|
| `VAULT_ROOT` | `~/dev/github/thalorna`          | Path to Obsidian vault   |
| `HUGO_ROOT`  | Parent of `scripts/` directory   | Path to Hugo project     |
