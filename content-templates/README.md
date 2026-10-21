# Content templates

Obsidian [Templater](https://github.com/SilentVoid13/Templater) templates for
starting a new note: the frontmatter each kind of note carries, and a body
outline with the sections a finished note is expected to have.

They are **not** site content: the site build reads `content/` and nothing
else, and these files render no page. The directory is deliberately outside
`content/`.

`New_Blog_Post_Template.md` is the one that belongs to this repository — the
blog is authored here. A post is a `doc` note of `subType: post`: it states the
day it is published in `data.date` and may name its writer in `data.author`,
and a post naming none carries the site's byline. Its `shortcode` is its
address, so the post publishes at `/doc-<shortcode>/`. The other twenty-two start a note
in a **package's** content tree, which is authored in the repository that ships
that package:

| Templates                                                                                                            | Package    | Authored in                                       |
| -------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------- |
| Affliction, Armor, Attribute, Concoction, Container, Misc Gear, Mystery, Mystical Ability, Projectile, Skill, Weapon | `sohl`     | `Song-of-Heroic-Lands-FoundryVTT/assets/content/` |
| Affiliation, Character, Continent, Creature, Location, Lore, People, Polity, Region, Settlement, World               | `thalorna` | `thalorna/assets/content/`                        |

Those twenty-two are held to the note format `@heroiclands/package-build`
defines, and `docs/content-format.md` in that package is the authority on every
key they write. A note marks itself unfinished with the `draft` **tag**, which
keeps it compiling, publishing and resolving while a link into it renders
marked; a being is `type: being`, with `subType: npc`, `subType: character`,
or `subType: creature` identifying its kind; and the facts describing a
subject live under `data:`, the closed container each note type declares its
keys in.

Moving each template to the repository whose content it templates is the
obvious next step, and needs the frontmatter checked against that repository's
schema first.
