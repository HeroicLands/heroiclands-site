# Deployment: GitHub Pages + Cloudflare

This site is built with Hugo, deployed to GitHub Pages, and served
through Cloudflare as www.heroiclands.org.

## Architecture

```
HeroicLands (Obsidian vault)
    │
    │  export-hugo.ts
    ▼
heroiclands-site (Hugo project)
    │
    │  GitHub Actions: hugo --minify
    ▼
GitHub Pages
    │
    │  DNS proxy + CDN, and the routing Worker (worker/),
    │  which proxies each package prefix to its own hosting
    ▼
Cloudflare → www.heroiclands.org
```

`www` is the canonical hostname; the apex redirects to it. Everything outside a
package prefix is served by the GitHub Pages deploy above.

## How it works

1. The **HeroicLands** repo is an Obsidian vault containing all worldbuilding
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
   can read the `HeroicLands` repo.
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

Option A: Add a webhook or GitHub Action in the `HeroicLands` repo that sends
a `repository_dispatch` event to `heroiclands-site`:

```yaml
# In HeroicLands/.github/workflows/notify-site.yml
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

## Packages under their own prefixes: the routing Worker

`www.heroiclands.org` is one hostname with more than one publisher. This
repository's GitHub Pages deploy serves the site; a package repository that
builds and publishes its own subtree gets a **path prefix**, and requests under
it are proxied to that repository's own hosting project.

| Prefix    | Served by                             | Hosting                      |
| --------- | ------------------------------------- | ---------------------------- |
| `/sohl/*` | `Song-of-Heroic-Lands-FoundryVTT`     | Cloudflare Pages, `sohl-site` |
| `/*`      | this repository                       | GitHub Pages                 |

That is what `worker/` is: a Cloudflare Worker holding **no content and no
per-page knowledge**, one row per package. Adding a package is a row in `ROUTES`
(`worker/src/router.js`) and a route in `worker/wrangler.toml`; removing one is
deleting them. `worker/test/` covers the table and the URL handling as ordinary
functions — `cd worker && npm test`.

Two properties are worth understanding before changing it.

**The path is preserved, not rewritten.** Each package's deployment carries its
own prefix physically: `/sohl/kb/x/` is at `sohl/kb/x/` inside the SoHL project's
upload. So the proxy is a straight pass-through, and the same deployment behaves
identically at its own `*.pages.dev` address — which is how a package repository
verifies a release before anything here points at it. A router that stripped the
prefix would make those two disagree.

**The Worker only sees what its routes claim.** Everything outside the prefixes
in `wrangler.toml` never reaches the script, so a broken router cannot take the
site down — only the prefixes it claims.

Deploying it needs two repository secrets, `CLOUDFLARE_API_TOKEN` (a token with
**Workers Scripts: Edit**, **Workers Routes: Edit** and **Zone: Read** on
`heroiclands.org`) and `CLOUDFLARE_ACCOUNT_ID`. The
**Deploy the routing Worker** workflow runs on any push touching `worker/`, and
by hand from the Actions tab.

> **A note on the SoHL package.** This site does not publish it:
> `RETIRED_PACKAGES` in `scripts/export-hugo.ts` skips the export, though the
> notes are still read and indexed so cross-references from other content
> resolve. The pages come from `Song-of-Heroic-Lands-FoundryVTT`, generated by
> the same code that compiles them into the game's compendium packs, so that copy
> cannot drift from the system — and this one always could.

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
|--------------|----------------------------------|--------------------------|
| `VAULT_ROOT` | `~/dev/github/HeroicLands`       | Path to Obsidian vault   |
| `HUGO_ROOT`  | Parent of `scripts/` directory   | Path to Hugo project     |
