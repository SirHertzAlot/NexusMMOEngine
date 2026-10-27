# Engine ↔ Game Coupling Audit

Read-only audit of `~/workspace/nexus-engine`, 2026-10-17. No repo files modified.
Question: where does engine **code** assume specific game **content** exists?

Method: harvested 324 candidate content IDs from `content/**/*.json` (dict keys and
`id` fields), cross-referenced every quoted occurrence in `packages/engine-core/src`,
`packages/*/src`, `modules/*/server.js` (tests excluded), then hand-classified each
hit. Separately traced the boot path in `packages/engine-core/src/server.ts` for
required-vs-optional content.

---

## 1. TRUE COUPLING (engine breaks or silently misbehaves without the content)

### C1. A full game bestiary hard-coded in engine source — SEVERE

`packages/species/src/species.ts:81` — the comment is candid: `/** Our game's roster. */`

```ts
export const BUILTIN_SPECIES: Roster = {
  goblin: s({ name: "Goblin", kind: "organic", ... }),   // :83
  orc: ..., troll: ..., ogre: ...,
  wolf: ..., bear: ..., boar: ..., "giant-spider": ...,  // + more (file: 202 lines)
```

Why it's coupling, not a default:
- `loadSpecies` merges file content **over** the builtins — `packages/species/src/species.ts:172`:
  `const roster = { ...BUILTIN_SPECIES, ...parsed.data }`. A game pack can add or
  override species, but **can never remove goblin**. The builtins are irremovable.
- `loadServerRoster` falls back to the builtins when no species file exists —
  `packages/engine-core/src/species-roster.ts:33-35`.
- `content/species/` **does not exist in the repo** (verified: `ls content/species`
  → no such directory), so `DEFAULT_SPECIES_FILE`
  (`packages/engine-core/src/species-roster.ts:22`) dangles and the engine **currently
  boots on its hard-coded bestiary**. This is not a fallback path — it is the live path.

Fix: move the roster into a content pack (`content/species/species.json`), make the
engine's fallback an empty roster (or a clearly-marked 1-creature sample), and let a
game with no species file mean "no species", not "goblins".

### C2. Quest + dungeon content dirs are REQUIRED at boot — STRUCTURAL

- `modules/quests/server.js:19` calls `loadQuestContent(config.questDir)` during
  module assembly. `loadQuestContent`
  (`packages/engine-core/src/quests/content.ts:219-221`) does bare `readFileSync` on
  `steps.json`, `quests.json`, `npcs.json`, `dialogs.json` — no existence check.
  Missing dir/files → throw → boot fails.
- Same for dungeons: `modules/dungeons/server.js:22` →
  `loadDungeonContent` (`packages/engine-core/src/dungeons/content.ts:92-93`),
  bare `readFileSync` → throw on missing.

Consequence: the engine cannot boot "game-less" with these modules enabled — quest
and dialog content must exist. Escape hatch exists: `readEnabledSet`
(`packages/modules/src/...`:321-322) returns `["core"]` when `modules.json` is
missing, so disabling the quests/dungeons modules avoids the requirement. But the
default `content/modules.json` enables them, so the default boot requires game content.

Fix: make the loaders tolerate absence (empty quest set / no dungeons = valid state),
matching how `loadCombatContent` already returns `null` on a missing file
(`packages/engine-core/src/combat-content.ts:17-18`).

### C3. Crafting rules file REQUIRED at boot

`packages/engine-core/src/server.ts:265` — `loadCraftingRules` inside try/catch →
`process.exit(1)` on failure. `loadCraftingRules`
(`packages/crafting/src/rules.ts:104-105`) throws `"no such file"` when
`content/crafting/recipes.json` (or `MMO_CRAFTING`) is absent. A game with no
crafting cannot boot without shipping a (possibly empty) recipes file.

Fix: same as C2 — absent file should mean "no crafting", not a fatal error
(validate the file *if present*).

### C4. Implicit skill-ID contract — SILENT DEGRADATION

Engine systems hard-code skill IDs that are defined in **content**
(`content/rules/skills.json` → `['athletics','blocking','bludgeoning','cutting',
'endurance','evading','exposure','fishing','foraging','grappling','medicine',
'mining','parrying','striking','swimming','throwing','thrusting','woodcutting']`):

| Engine code | Hard-coded IDs | Degradation if content renames/removes |
|---|---|---|
| `packages/engine-core/src/body.ts:468,594` | `"medicine"` | `?? 0` — treatment difficulty silently computed at skill 0 |
| `packages/engine-core/src/stats/mastery-system.ts:56-57` | `"swimming"`, `"athletics"` | `SkillIndex.of` returns -1 (`mastery.ts:52-53`); swim/athletics bonuses silently off |
| `packages/engine-core/src/combat.ts:305` | `"evading"` (dodge training) | `train` on unknown id — silently no-ops or mis-indexes |
| `packages/engine-core/src/combat.ts:326` | `"parrying"`, `"blocking"` (guard contest) | guard resolution silently uses skill 0 |
| `packages/engine-core/src/combat.ts:327` | `"disarm"` (via `knows`) | discipline technique never known |

The failure mode is the problem: nothing throws, behavior just quietly changes. There
is no declared contract — the rules cross-checker (`packages/rules/src/load.ts`)
validates references *within* content, but nothing states "the engine requires skill
IDs {medicine, swimming, athletics, evading, parrying, blocking}". A game pack that
renames `medicine` → `first-aid` gets silently broken treatment math.

Fix: declare the engine's required skill IDs as a validated contract (boot error
naming the missing IDs, like the rules cross-checker already does for body parts),
or remove the hard-coded lookups in favor of content-declared mappings.

### C5. `starterBase` default `"sword"` — SOFT

`packages/engine-core/src/items/item-service.ts:71`:
`this.starterBase = o.starterBase === undefined ? "sword" : o.starterBase;`
Injectable via `ItemServiceOptions` (and `server.ts` passes config through), so this
is a default, not a requirement. But the default names a content-defined item base;
without a `sword` base, `defs.starter()` returns -1 and new characters silently get
no starter weapon. Fix: default `null` (no starter weapon) and let the game pack
opt in — or keep `"sword"` but document it as "the sample pack's contract".

---

## 2. CLEARED — suspected but correctly separated

- **Quest / NPC / dialog / entrance / loot-table IDs** (`goblin-trouble`,
  `standing-stones`, `warden`, `barrow-gate`, `goblin-spoils`): **zero references**
  in engine source. The data-driven content (quests, dungeons, loot) is clean —
  engine code never names a specific quest, NPC, entrance, or table. (Grep hits for
  `goblin` were doc comments — `scene-spawn.ts:8,18`, `biome-registry.ts:198` — and
  editor placeholder strings like `"e.g. camps/goblin"`
  (`apps/editor/src/ui/scenes-panel.tsx:546`). Cosmetic, not functional.)
- **`ARMOUR_SLOTS`** (`packages/engine-core/src/items/item-store.ts:34`:
  `["head","chest","hands","legs","ring","amulet"]`, mirrored in the admin schema at
  `packages/engine-core/src/admin/items.ts:20`): engine-defined vocabulary (wear
  locations). Content's item bases declare slots conforming to it — correct
  direction (engine declares the contract, content fills it).
- **`NeedKind = "hunger" | "thirst"`** (`packages/engine-core/src/stats/needs-system.ts:21`):
  engine type; `content/rules/needs.json` provides the values. Correct direction.
- **Rank ladder** (`packages/compose/src/ranks.ts:24-31`): canonical inferred names
  (`common`…`legendary`…); engine vocabulary, games tune shares/counts. Correct.
- **`HOSTILE_KINDS`** (`packages/species/src/species.ts:68-72`): kind *categories*
  (`organic`/`demon`/`undead`/`beast`) — engine vocabulary, not species IDs. Correct.
- **`MMO_PLAYER_ABILITIES`** (`packages/engine-core/src/server.ts:205-213`):
  `"swim"`/`"fly"` are engine-defined ability words. Correct.
- **Combat moves** (`loadCombatContent`, `combat-content.ts:17-18`): optional —
  missing file returns `null`, boot continues. Correct pattern (C2/C3 should match it).
- **Vendor templates**: runtime-registered via `VendorSystem.define`
  (`packages/engine-core/src/economy/vendor.ts:81-88`); no hard-coded templates in
  `server.ts` (the `server.ts:638` comment "Templates are defined here" is stale —
  nothing is defined there). Correct.
- **`FIST` fallback weapon** (`packages/engine-core/src/combat.ts:95`):
  `technique: "bludgeon"`, `family: "fist"` — engine-internal unarmed fallback;
  `techniqueSkill` returns `undefined` for unknown techniques → skill 0, graceful.
  Acceptable, though `"bludgeon"` would ideally resolve through content.
- **Treatment kinds** (`"bandage"`/`"stump"`/`"set"`, `body.ts:428-433`):
  engine `TreatmentKind` vocabulary. Correct.

---

## 3. Boot-without-content check

What the boot path (`packages/engine-core/src/server.ts`) demands:

| Content | Required? | Behavior if absent | Path |
|---|---|---|---|
| Rules **dir** (`MMO_RULES` \|\| `content/rules`) | Dir must exist; files optional | Dir missing → `RulesError: rules folder not found` (`packages/rules/src/load.ts:124`); missing files → engine defaults | `rules/boot.ts:23`, `server.ts:251` |
| `content/crafting/recipes.json` | **YES** | Throw → `process.exit(1)` | `server.ts:265`, `packages/crafting/src/rules.ts:104-105` |
| `content/quests/` (4 JSON files) | **YES** if quests module enabled | Throw in module assembly | `modules/quests/server.js:19`, `quests/content.ts:219-221` |
| `content/dungeons/` | **YES** if dungeons module enabled | Throw in module assembly | `modules/dungeons/server.js:22`, `dungeons/content.ts:92-93` |
| `content/species/species.json` | No (falls back) | → **C1**: boots on hard-coded `BUILTIN_SPECIES` | `species-roster.ts:33-35` |
| `content/combat/moves.json` | No | Skipped silently | `combat-content.ts:17-18` |
| `content/modules.json` | No | Defaults to `["core"]` only | `packages/modules/src/*:321-322` |
| `content/scenes/*.scene.json` | No | Only loaded if `MMO_SCENE` set | `server.ts:740` |

**Verdict: the engine cannot boot content-free today.** Minimum viable boot needs:
a rules dir (may be empty), a crafting file, and quest + dungeon content (or those
modules disabled). Every one of these has an `MMO_*` env override
(`MMO_RULES`, `MMO_CRAFTING`, `MMO_QUESTS`, `MMO_DUNGEONS`, `MMO_COMBAT`,
`MMO_SPECIES`, `MMO_MODULES`, `MMO_SCENE`, `MMO_PCG_ASSETS`, `MMO_BIOMES`,
`MMO_ECOLOGY`) — the seams exist, but every default points into the repo's
`content/`.

---

## 4. Packaging map — what `content/` holds today

**Engine-needs-this-to-boot** (structural, even if the *values* are game content):
- `content/rules/` — dir must exist (files optional; missing = engine defaults)
- `content/crafting/recipes.json` — file must exist and validate
- `content/quests/` — required with modules enabled (default on)
- `content/dungeons/` — required with modules enabled (default on)
- `content/modules.json` — optional (missing = core only), but ships the default set

**Pure game content** (data, correctly shaped — the problem is only that it ships
*as* the engine):
- `content/rules/*.json` — skills, creatures, items, loot, body, combat, death,
  stats, needs, disciplines, spells, appearance, ingress
- `content/combat/moves.json`, `content/crafting/recipes.json`
- `content/quests/`, `content/dungeons/`
- `content/pcg/`, `content/animation/`, `content/audio/`, `content/vfx/`,
  `content/materials/`, `content/strings/`, `content/ui/`, `content/edge/`,
  `content/db/`, `content/flow/`, `content/build/`

**Engine-bundled game content in code** (the real violation — not data, but source):
- `packages/species/src/species.ts:81-201` — `BUILTIN_SPECIES` ("Our game's roster")

**Sample/test only** (fine as-is):
- `content/scenes/test-arena.scene.json` — only loaded via `MMO_SCENE`
- `content/playtests/` — test fixtures (out of scope per instructions)

---

## 5. What the split requires (synthesis)

In increasing order of invasiveness:

1. **C2/C3**: make `loadQuestContent`, `loadDungeonContent`, `loadCraftingRules`
   tolerate absence (empty = valid), matching `loadCombatContent`'s existing
   null-on-missing pattern. Small, mechanical.
2. **C1**: extract `BUILTIN_SPECIES` to `content/species/species.json` (which
   doesn't exist today); engine fallback becomes an empty roster or a marked
   sample. The `MMO_SPECIES` seam already exists.
3. **C4**: declare the engine's required skill IDs as a boot-validated contract
   (fail loud naming the missing IDs) instead of silent `-1`/`0` degradation.
4. **C5**: default `starterBase` to `null`; the game pack opts into `"sword"`.
5. **Packaging**: with 1–4 done, `content/` becomes the *sample* game pack and a
   real game ships its own content dir via the `MMO_*` env seams — no repo changes
   needed per game.

*End of audit. Every claim above carries a file path and line number. Read-only —
no repo state was modified.*
