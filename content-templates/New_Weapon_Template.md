---
aliases: []
tags: []
description: ""
name:
  full:
  aliases: []
id: <% [...Array(16)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('') %>
img: "icons/sword.svg"
shortcode: ""
type: weapongear
sohl:
  durability: 0
  weight: 0 # pounds
  value: 0 # in pence
  heft: 0
  weaponType: "" # Sword | Axe | Club | Flail | Knife | Polearm | Shield | etc.
  strikeModes:
    swing:
      type: melee # melee | missile | thrown
      name: Swing
      assocSkillCode: melee
      minParts: 1
      attack:
        spread: 0
        modifier: 0
      impactBase:
        numDice: 1
        die: 6
        modifier: 0
        aspect: blunt # blunt | edged | piercing | fire
      traits:
        meleeMod: 0
        blockSLMod: 0
        durabilityMod: 0
        cxSLMod: 0
        oppDef: 0
        impTA: 0
        AR: 0
        noAttack: false
        noBlock: false
        entangle: false
        envelop: false
        couched: false
        long: false
        onlyInClose: false
        shieldMod: 0
        slow: false
        thrust: false
        swung: true
        halfSword: false
        bleed: false
        twoHndLen: 0
        shaft: false
        pommel: false
        noStrMod: false
        halfImpact: false
        lowAim: false
      lengthBase: 0
      defense:
        blockMod: 0
        counterstrikeMod: 0
folder: ""
draft: true
---

<!-- Opening paragraph: a sensory description of the weapon — its silhouette, weight in the hand, sound in use. -->

## Description

<!-- Construction, materials, regions of origin, and who typically carries it. -->

## In Use

<!-- How the weapon is wielded in combat, its strengths and weaknesses against various armors, and notable techniques. -->
