---
aliases: []
tags: []
title: ""
description: ""
name:
  full:
  aliases: []
id: <% [...Array(16)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('') %>
shortcode: "" # alphanumeric, <16 chars, unique in the vault
img: ""
draft: true
type: affiliation
package: thalorna
sohl:
  subType: "" # divine (a religion or church) | arcane (a school of magic)
  #          | spirit (a shamanic, totemic, or ancestor tradition)
  #          | social (a guild, bank, syndicate, house, or military unit)
  society: null
  office: null
  title: null
  level: null
  relation: {} # shortcode -> aligned | unaligned | rival | nemesis
# ── Deity-facing bodies only — omit these keys entirely otherwise ──
# pantheon: ""       # shortcode of the pantheon this body belongs to
# deity: ""          # the deity's name
# epithet: ""        # e.g. "The All-Father"
# domain: ""         # e.g. "Knowledge and Wisdom"
# symbol: ""         # prose description of the iconographic symbol
---

<!-- What this body is, who belongs to it, and what belonging to it means. -->

## Organization

<!-- How it is structured and governed: offices, ranks, and who holds authority.
     A character's rank is the `level` on their own copy of this affiliation. -->

## Membership

<!-- Who joins, how they are admitted, and what is expected of them. -->

## History

<!-- Origins, how it spread, schisms, and its relationship to political power. -->

## Relations

<!-- Standing toward other affiliations — mirror each one in `sohl.relation`. -->

## See Also

- <!-- [[affiliation-shortcode|Related body]] — Description -->
