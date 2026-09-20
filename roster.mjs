/**
 * The package roster — the one place this repository writes down which packages
 * HeroicLands publishes, and what each one is.
 *
 * ## What this is not
 *
 * **It is not a routing table, and the router does not read it.** Adding a
 * package must not be a change to this repository (heroiclands-site#25), so the
 * Worker derives a package's origin from its prefix alone
 * (`/<package>/` → `https://<package>.pkg.heroiclands.org`) and holds no list.
 * `wrangler.toml` names no package either — one wildcard route, and the handler
 * decides. Issue #23 was written when both of those *were* lists that had to
 * agree; #26 removed them, so there is nothing left here to generate a route
 * from, and re-deriving routes from this file would put the list back in the
 * one place the design says it must never be.
 *
 * What survives, and is why this file exists, is the second purpose: a package
 * homepage should link to the packages that build on it — `/sohl/` naming the
 * modules that ship SoHL content, `/hm3/` naming HM3's. **No package declares
 * its own dependents and none should have to**, so the reverse index has to be
 * held somewhere neither end of the edge owns. That is here.
 *
 * The relationship to the router is therefore *checked, not driven*:
 * `worker/test/roster.test.mjs` asserts that every package named here is one the
 * router already resolves, and that no package claims a top-level path this site
 * publishes itself. A roster entry the router cannot reach is a page that 404s,
 * and it is the only way the two can now disagree.
 *
 * ## The trap this file exists to keep out of everything else
 *
 * **A package's address is its `contentPackage`, not its repository name.** Four
 * of the six differ, so deriving a prefix from the repository would be wrong
 * more often than right:
 *
 * | address          | repository                       |
 * | ---------------- | -------------------------------- |
 * | `thalorna`       | `sohl-thalorna`                  |
 * | `kethira`        | `sohl-kethira-basic`             |
 * | `harnensemble`   | `harn-ensemble`                  |
 * | `harnadventures` | `harn-adventures`                |
 *
 * Both are recorded on every entry, and the test pins the divergences, so a
 * later tidy-up that "corrects" one to the other fails rather than silently
 * unpublishing four packages.
 *
 * ## Why `systems` is authored here rather than read from a manifest
 *
 * Foundry's `supportsSystem` check *drops* a module from any world running a
 * system it does not name, so `relationships.systems` in a package's manifest is
 * a **restriction, not a declaration** (HeroicLands/package-build#48). A module
 * that ships for two systems, or for none in particular, therefore declares
 * nothing on purpose — `harn-ensemble` and `harn-adventures` are exactly that
 * case, and package-build#43 already made `stats.systemId` optional for them.
 * The packages whose homepages most need a "works with" link are the ones the
 * manifest cannot answer for, so waiting on a `_stats` redesign would block the
 * link on the wrong dependency. It is authored, and it is authored here.
 *
 * ## The header navigation is derived from here too
 *
 * `nav` places an entry in the header: `top` for one that gets its own entry,
 * `modules` for one listed under "Other Modules". Roster order is menu order.
 * `utils/build-roster.mjs` writes the menu three ways from the same list —
 * `config/_default/menus.toml` for this site's own header,
 * `static/nav.json` for the package sites' toolchain to read, and
 * `data/roster.json` unchanged, for the cross-link projection below. Nothing
 * authors a menu anywhere else; `hugo.toml` carries no `[menu]` block.
 *
 * ## Adding a package
 *
 * One entry below, then `npm run roster` to regenerate the three derived files
 * (`data/roster.json`, `config/_default/menus.toml`, `static/nav.json` — see
 * `utils/build-roster.mjs`). Nothing else in this repository, and nothing in
 * the Worker.
 */

/**
 * A package HeroicLands publishes at `https://www.heroiclands.org/<id>/`.
 *
 * @typedef {object} Package
 * @property {string} id - The `contentPackage`, which is also the address
 *   segment. **Not** the repository name.
 * @property {string} title - What the package's own homepage calls itself, so a
 *   cross-link names it the way a reader will find it.
 * @property {string} [navName] - The header's label for this entry, when the
 *   header wants something shorter than `title` calls itself on its own
 *   homepage. Absent when `title` is already the right length for a menu.
 * @property {string} repository - The GitHub repository under `HeroicLands`,
 *   recorded so nobody has to guess it from the address, and so the test can pin
 *   the two apart.
 * @property {"system" | "module"} kind - Whether it is a game system or a module
 *   that installs into a world already running one.
 * @property {string[]} systems - The `id`s of the systems this package's content
 *   is for; empty for a system, and empty for a module that is genuinely
 *   system-agnostic. This is the edge the dependents index is built from.
 * @property {"content" | "homepage"} publishes - The package's `publish.site`
 *   mode. `content` publishes its homepage *and* every page its content tree
 *   compiles to; `homepage` publishes that one page and fences the rest off. A
 *   cross-link uses it to decide whether there is anything below `/<id>/` worth
 *   linking to.
 * @property {"top" | "modules"} nav - Where the header places this package:
 *   its own top-level entry, or a child under "Other Modules".
 */

/**
 * Every package HeroicLands publishes, systems first.
 *
 * Order is the order a list of them should be shown in, and it is the order the
 * generated data file carries.
 *
 * Every field is verified against the package's own
 * `package-build.config.yaml` (`contentPackage`, `packageKind`, `publish.site`)
 * and its published homepage's title.
 *
 * @type {Package[]}
 */
export const PACKAGES = [
    {
        id: "sohl",
        title: "Song of Heroic Lands",
        repository: "Song-of-Heroic-Lands-FoundryVTT",
        kind: "system",
        systems: [],
        publishes: "content",
        nav: "top",
    },
    {
        id: "hm3",
        title: "HârnMaster 3 for Foundry VTT",
        navName: "HârnMaster 3",
        repository: "HarnMaster-3-FoundryVTT",
        kind: "system",
        systems: [],
        publishes: "homepage",
        nav: "top",
    },
    {
        id: "thalorna",
        title: "The World of Thalorna",
        navName: "Thalorna",
        repository: "sohl-thalorna",
        kind: "module",
        systems: ["sohl"],
        publishes: "content",
        nav: "top",
    },
    {
        id: "kethira",
        title: "HârnMaster Kethira Basic",
        repository: "sohl-kethira-basic",
        kind: "module",
        systems: ["sohl"],
        publishes: "homepage",
        nav: "modules",
    },
    {
        id: "thalornaaltart",
        title: "Thalorna Alternative Art",
        repository: "thalornaaltart",
        kind: "module",
        systems: ["sohl"],
        publishes: "homepage",
        nav: "modules",
    },
    {
        // Two systems, and the reason `systems` is authored rather than read:
        // its manifest names neither, because naming them would hide the module
        // from every other system. Its pack list is what says so — `actors-hm3`
        // and `actors-sohl`, one Actor pack per system.
        id: "harnensemble",
        title: "Ensemble of Hârn NPCs",
        repository: "harn-ensemble",
        kind: "module",
        systems: ["hm3", "sohl"],
        publishes: "homepage",
        nav: "modules",
    },
    {
        // Recorded as the maintainer scoped it in heroiclands-site#23: HM3.
        // Its own configuration is less decisive and deliberately so — it ships
        // one Adventure pack declaring no system, and its homepage says the
        // documents "carry no system data, so they import into a world running
        // any game system", while the configuration's comment names "the two
        // systems it targets", hm3 and sohl. That is an editorial call about
        // which homepages should list it, not a fact a manifest can settle, so
        // it is written here where it can be changed in one edit.
        id: "harnadventures",
        title: "Hârn Adventures",
        repository: "harn-adventures",
        kind: "module",
        systems: ["hm3"],
        publishes: "homepage",
        nav: "modules",
    },
];

/**
 * The top-level path a package is published at.
 *
 * Derived, never authored: the address *is* the id, and a second copy of it on
 * every entry would be a second thing to get wrong.
 *
 * @param {string} id - The package id.
 * @returns {string} The path prefix, with both slashes.
 */
export function prefixFor(id) {
    return `/${id}/`;
}

/**
 * The packages that build on `id` — the reverse of `systems`.
 *
 * This is the index no package can hold for itself: a module names the systems
 * it is for, and a system cannot know what was written for it.
 *
 * @param {string} id - The package id to find dependents of.
 * @param {Package[]} [packages] - The roster to search.
 * @returns {Package[]} The packages naming `id` in their `systems`, in roster
 *   order.
 */
export function dependentsOf(id, packages = PACKAGES) {
    return packages.filter((pkg) => pkg.systems.includes(id));
}

/**
 * A package by id.
 *
 * @param {string} id - The package id.
 * @param {Package[]} [packages] - The roster to search.
 * @returns {Package | undefined} The entry, if there is one.
 */
export function packageById(id, packages = PACKAGES) {
    return packages.find((pkg) => pkg.id === id);
}

/**
 * The roster as the data file Hugo reads, with everything derivable resolved.
 *
 * The generated copy is a **projection, not a transcription**: it adds the
 * `prefix` and the `dependents` list, so a template renders a cross-link without
 * doing a reverse lookup in Go templates. That is also why the direction of
 * generation is this way round — this module can carry the reasoning above and a
 * `.json` cannot, while Hugo reads `data/*.json` natively and cannot read this.
 *
 * @param {Package[]} [packages] - The roster to render.
 * @returns {object} The structure written to `data/roster.json`.
 */
export function toDataFile(packages = PACKAGES) {
    return {
        generatedBy:
            "utils/build-roster.mjs — do not edit; change roster.mjs and run `npm run roster`",
        packages: packages.map((pkg) => ({
            id: pkg.id,
            prefix: prefixFor(pkg.id),
            title: pkg.title,
            repository: pkg.repository,
            kind: pkg.kind,
            systems: [...pkg.systems],
            publishes: pkg.publishes,
            dependents: dependentsOf(pkg.id, packages).map((dep) => dep.id),
        })),
    };
}

/**
 * The exact bytes `data/roster.json` must hold, so the check and the writer
 * cannot disagree about formatting.
 *
 * @param {Package[]} [packages] - The roster to render.
 * @returns {string} The file's contents, newline-terminated.
 */
export function renderDataFile(packages = PACKAGES) {
    return `${JSON.stringify(toDataFile(packages), null, 4)}\n`;
}

/** The origin every menu URL in the roster is built against. */
const SITE_ORIGIN = "https://www.heroiclands.org";

/**
 * The header menu as a tree — "Home", "Other Modules" and "License" are the
 * three entries no package declares, filled in around the roster. Roster
 * order is menu order; `nav` decides placement.
 *
 * @param {Package[]} [packages] - The roster to render.
 * @returns {{name: string, url: string, children?: {name: string, url: string}[]}[]}
 *   The menu, in order.
 */
export function menuTree(packages = PACKAGES) {
    const entryFor = (pkg) => ({
        name: pkg.navName ?? pkg.title,
        url: `${SITE_ORIGIN}${prefixFor(pkg.id)}`,
    });
    return [
        { name: "Home", url: `${SITE_ORIGIN}/` },
        ...packages.filter((pkg) => pkg.nav === "top").map(entryFor),
        {
            name: "Other Modules",
            url: `${SITE_ORIGIN}/projects/modules/`,
            children: packages
                .filter((pkg) => pkg.nav === "modules")
                .map(entryFor),
        },
        { name: "License", url: `${SITE_ORIGIN}/license/` },
    ];
}

/**
 * A TOML basic string, quoted and escaped.
 *
 * @param {string} value - The value to quote.
 * @returns {string} The value as a TOML basic string.
 */
function tomlString(value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The exact bytes `config/_default/menus.toml` must hold.
 *
 * Hugo reads a dedicated `menus.toml` config file with the menu's own name as
 * the top-level array — `[[main]]`, not `[[menu.main]]` as `hugo.toml` would
 * carry it — and its entries take over that menu entirely rather than merging
 * with a `[menu]` block in the root config, which is why `hugo.toml` carries
 * no `[menu]` block at all: the two would not combine, and only this file
 * would render.
 *
 * @param {Package[]} [packages] - The roster to render.
 * @returns {string} The file's contents, newline-terminated.
 */
export function renderMenusFile(packages = PACKAGES) {
    const blocks = [];
    const tree = menuTree(packages);
    tree.forEach((entry, topIndex) => {
        const isModules = entry.name === "Other Modules";
        const weight = topIndex + 1;
        blocks.push(
            [
                "[[main]]",
                `  name = ${tomlString(entry.name)}`,
                `  url = ${tomlString(entry.url)}`,
                `  weight = ${weight}`,
                ...(isModules ? ['  identifier = "modules"'] : []),
            ].join("\n"),
        );
        entry.children?.forEach((child, i) => {
            blocks.push(
                [
                    "[[main]]",
                    `  name = ${tomlString(child.name)}`,
                    `  url = ${tomlString(child.url)}`,
                    `  weight = ${i + 1}`,
                    '  parent = "modules"',
                ].join("\n"),
            );
        });
    });
    return (
        "# The header nav, generated by utils/build-roster.mjs — do not edit;\n" +
        "# change roster.mjs and run `npm run roster`. Every package entry links\n" +
        "# to its own landing; \"Other Modules\" is the only dropdown.\n\n" +
        `${blocks.join("\n\n")}\n`
    );
}

/**
 * The exact bytes `static/nav.json` must hold, published at
 * `https://www.heroiclands.org/nav.json` for the package sites' build
 * toolchain to read.
 *
 * @param {Package[]} [packages] - The roster to render.
 * @returns {string} The file's contents, newline-terminated.
 */
export function renderNavFile(packages = PACKAGES) {
    return `${JSON.stringify(menuTree(packages), null, 4)}\n`;
}
