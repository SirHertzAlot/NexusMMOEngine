# @mmo-engine/crafting

Materials and crafting, balanced backwards from top gear (`docs/DUNGEONS-AND-LOOT.md` §7).

- **Raw materials** (`BUILTIN_MATERIALS`): a tier (1–5), a kind, the gathering skill, and sources:
  - open-world biomes
  - dungeon vein kinds (the dungeon dressing's iron seams up to rune stone)
  - creature drops by kind (demon ichor, grave dust, void essence, …)
- **Recipes** are derived from composed items (`recipeFor(bundle)`):
  - the item's material, refined from raw materials in the quantity its base needs
  - fittings (leather on armour, a gold setting on jewellery)
  - reagents for every affix and ability by element, or arcane dust
  - rune stone for runes and unique abilities
  - a craft skill, and the mastery the rank needs
- **Tradability** (`TRADABILITY`): a proposal for open question 4. Materials up to tier 3 are
  commodities; tiers 4–5 are bound. Items bind at the top two ranks (epic on equip, the top rank on
  pickup).
- **Balance** (`npm run craft:report`, after `npm run loot:bake`):
  - what top-rank gear needs
  - every material reachable and every vein useful
  - the loot pool's items crafted, by rank: mean gathering hours, highest tier, share craftable from
    tradable materials, skills

  It exits 1 on problems, including a rank that doesn't cost more to gather than the rank below.
