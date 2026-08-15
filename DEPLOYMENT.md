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
    │  DNS proxy + CDN
    ▼
Cloudflare → www.heroiclands.org
```

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

## Retired: SoHL content at /sohl/

This site no longer publishes the `sohl` package. The same vault notes are
published to **kb.heroiclands.org/{type}/{slug}/** by the
`Song-of-Heroic-Lands-FoundryVTT` repository, which generates them with the
same code that compiles them into the game's compendium packs — so that copy
cannot drift from the system, and this one always could. It had: `/sohl/`
still carried `corpus` and `trait` pages after the system retired both
concepts.

`RETIRED_PACKAGES` in `scripts/export-hugo.ts` is what stops the export. The
notes are still read and indexed, so cross-references from other content
resolve; they are simply not routed to a page here. The export reports the
count it skipped.

**The redirect is a Cloudflare rule, not a repository change.** GitHub Pages
serves static files and cannot issue a 301, and the site is proxied through
Cloudflare, so the redirect belongs at the edge:

> **Rules → Redirect Rules → Create rule**
> Name: `sohl to knowledgebase`
> When: `URI Path` `starts with` `/sohl/`
> Then: **Dynamic** redirect, status **301**, preserve query string
> Expression: `concat("https://kb.heroiclands.org", substring(http.request.uri.path, 5))`

`substring(..., 5)` strips the leading `/sohl`, leaving `/{type}/{slug}/`.
Coverage was measured against the two sitemaps at the time of the change: of
the 918 published `/sohl/*` URLs, **910 resolve on the knowledgebase** at the
identical `/{type}/{slug}/` path — 904 as canonical pages, and 6 more through
the knowledgebase's own generated aliases (the items whose slug changed
upstream when item URLs began deriving from the name).

The remaining **8 name pages that no longer exist anywhere**, so redirecting
them loses nothing: `/sohl/trait/` (a concept the system retired);
`/sohl/concoctiongear/` and `/sohl/mystery/`, type-index pages this site
published with no items under them; and 5 `containergear` jar pages
(`jar-glass-large`, `jar-glass-small`, `jar-lidded-large`, `jar-lidded-medium`,
`jar-lidded-small`) left over from before those items were renamed to their
volumes — the current items are `jar-glass-1-pt`, `jar-lidded-1-gallon`, and so
on, all of which the knowledgebase serves.

> **Verify a knowledgebase URL by its content, not its status code.**
> kb.heroiclands.org is a Cloudflare Pages project with no `404.html`, so an
> unknown path returns **HTTP 200 carrying the landing page**. A `curl -o
> /dev/null -w '%{http_code}'` check therefore reports every URL as present.
> Compare `<title>` instead: the landing page's is exactly
> `SoHL Knowledgebase`.

⚠️ **Order matters.** Add the Cloudflare rule *before* deploying the export
change. The rule intercepts at the edge whether or not the origin still has
the pages, so with the rule in place first there is no window in which the
published URLs 404.

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
