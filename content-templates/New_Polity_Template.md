---
aliases: []
tags: []
description: ""
type: doc
category: polity
name:
  full:
  aliases: []
id: <% [...Array(16)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('') %>
shortcode: ""
img: ""
draft: true
# ── Polity identity ─────────────────────────────────────────────
subType:
  "" # required — canonical values:
  #   empire          — polity of sub-polities (kingdoms,
  #                     provinces, etc.)
  #   kingdom         — any monarchy, regardless of the
  #                     ruler's title (king, sultan,
  #                     matriarch, high jarl…) or whether
  #                     clergy formally advise the crown
  #   province        — subordinate region of an empire
  #   republic        — rule by elected/appointed senate,
  #                     council, or assembly
  #   oligarchy       — rule by a narrow class (mages,
  #                     merchant-princes, etc.)
  #   city-state      — self-governing single-city polity
  #   confederation   — league of roughly-peer polities
  #                     (tribes, jarldoms, merchant
  #                     cities, city-states…)
  #   cultural-region — loose shared-culture zone, not a
  #                     formal polity (use sparingly)
demonym: "" # e.g., Vylarian, Nordmal, Tarvénan
capital: "" # shortcode of the capital settlement (optional)
ruler:
  title: "" # e.g., King, Emperor, Sultan, Matriarch, High Jarl
  name: "" # optional: the sitting ruler's name
government:
  type:
    "" # structural form — mirrors subType in most cases
    # (empire, monarchy, republic, oligarchy, city-state,
    # confederation, province). Use government.summary to
    # capture flavor (divine ruler, clerical advisors,
    # matriarchal succession, mage synod, etc.).
  summary: "" # one-line description of how governance actually works
# ── Identity — people, tongues, faiths ─────────────────────────
languages: [] # shortcode(s) of the primary language(s)
pantheons: [] # shortcode(s) of the primary pantheon(s)
peoples: [] # slug(s) of the dominant people(s); default: [human]
# ── Hierarchy ──────────────────────────────────────────────────
parent:
  polity: "" # shortcode of parent polity, if this polity is subordinate
regions: [] # shortcode(s) of the region(s) this polity occupies
continents: [] # fallback when the polity sits directly under a
  # continent with no intermediate region note
# ── Miscellany ─────────────────────────────────────────────────
terran_analog: "" # optional real-world cultural/geographic analog
---

## Overview

<!-- Geographic location, defining characteristics, and role in the wider world. What makes this realm distinct? -->

## Character

<!-- The culture, values, and temperament of the people. What are the dominant social forces? How does religion, law, or tradition shape daily life? -->

## Economy

<!-- Primary industries, trade goods, and economic relationships with neighboring realms. -->

## Government

<!-- How the realm is actually governed day-to-day, who holds power, and how disputes are adjudicated. Only needed if more detail than government.summary is useful. -->

## Relations

<!-- Diplomatic relationships, rivalries, alliances, and conflicts with neighboring realms and major institutions. -->

## Notable Features

<!-- Key landmarks, institutions, cities, or unique elements that define this realm. -->

## See Also

- <!-- _(related realm or region)_ — Description -->
