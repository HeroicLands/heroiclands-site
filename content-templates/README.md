# Content templates

Obsidian [Templater](https://github.com/SilentVoid13/Templater) templates for
starting a new note: the frontmatter each kind of note carries, and a body
outline with the sections a finished note is expected to have. They came from
the `HeroicLands` vault's `Templates/` folder, which was the only place they
existed, when that vault was retired
(`HeroicLands/Song-of-Heroic-Lands-FoundryVTT#1448`).

They are **not** site content: nothing here is mounted into the Hugo build, and
these files render no page. The directory is deliberately outside `content/`.

`New_Blog_Post_Template.md` is the one that belongs to this repository — the
blog is authored here. The other twenty-two start a note in a **package's**
content tree, which is authored in the repository that ships that package:

| Templates | Package | Authored in |
| --- | --- | --- |
| Affliction, Armor, Attribute, Concoction, Container, Misc Gear, Mystery, Mystical Ability, Projectile, Skill, Weapon | `sohl` | `Song-of-Heroic-Lands-FoundryVTT/assets/content/` |
| Affiliation, Character, Continent, Creature, Location, Lore, People, Polity, Region, Settlement, World | `thalorna` | `sohl-thalorna/assets/content/` |

Held here so that retiring the vault loses nothing. Moving each to the
repository whose content it templates is the obvious next step, and needs the
frontmatter checked against that repository's current schema first — several
of these predate the field changes those trees have since taken.
