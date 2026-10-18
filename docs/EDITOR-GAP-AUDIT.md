# Editor coverage audit: what a designer can tune without a developer

Baseline: `origin/main` at 097679f (2026-10-17). This builds on the
prior audits: the UI shell audit (EDITOR-AUDIT.md, main at b9b74a7,
2026-10-09) and the DRY audit (editor code, 2026-10-10). It does not repeat
their shell findings. Several of those (File and Edit menus, live
bottom dock, sample-data modules) were since replaced by commits 1fbb4b7 and
5a8cb28; this audit does not re-test them in the browser.

Scope: every engine system that has a tunable value, checked against the
editor. A value is **covered** when a panel or tree node in the editor saves
it to its file. It is **raw** when it is only reachable through the generic
rules tree. It is **JSON only** when the file exists but no panel or grid
opens it. It is **code** when the value is a constant in engine source with no
file behind it.

Method: for each system, the file the engine reads (grep of `packages/` and
`apps/`), then the editor surface that saves it (grep of `apps/editor/src`
for the file name, its host route and its panel). Nothing was clicked through
in the running editor for this document; panel behaviour is inferred from the
code that saves each file. Where that matters it is marked.

## Verdict

Data-driven rules are mostly reachable. All fourteen `content/rules/*.json`
files open in the Rules tree (`apps/editor/src/ui/rules-editor.tsx`), and the
Gameplay grids give labelled forms for creatures, items, skills, spells,
species, loot, refining, reagents and prefabs. The gaps are of three kinds:

1. **Whole files with no panel.** Dungeon run rules (`content/dungeons/instances.json`,
   `entrances.json`) and most of crafting (`content/crafting/recipes.json`:
   units, fittings, rune stone) have no form. The Content browser lists the
   dungeon files, but opening them lands in the Dungeon workspace, which
   reads only the pool and the patches.
2. **Combat, movement and creature behaviour held in code.** Jump, dodge,
   swim and run costs, base speeds, gravity, breath, the guard factor, reach
   and cone, the creature alert and calm timings, and the mastery pace are
   constants in `packages/engine-core/src`. Designers cannot reach them at all.
3. **Combat and medicine are raw.** `combat.json` and `body.json` are the
   numbers behind combat and healing, and they are reachable only as an
   unlabelled tree with no ranges or help.

## Gap list, ranked by designer impact

Impact is the cost to a designer who wants to change the thing with no
developer present. Ties are ordered by how many players feel the value.

| # | System | Tunables with no editor access | Where it lives | Editor status | Impact |
|---|---|---|---|---|---|
| 1 | Dungeon runs and entrances | Party size range, time limit, re-entry, teardown seconds, max instances, fallback creature, loot rolls per kill and per boss, chests per run and their roll counts, open radius, traps per run, trap harm, trigger radius, commit mode; entrance placement | `content/dungeons/instances.json`, `entrances.json` (read by `engine-core/src/dungeons/content.ts`) | **JSON only.** Tree opens the Dungeon workspace, which reads only `pool` and `patch` files (`dungeon-host.ts`). | High |
| 2 | Movement, stamina, jumping, drowning | Base walk speed 6, swim 3, fly 12, jump speed 8, gravity 22, breath 30 s, drown 10 per s, flight ceiling 250, snap and head height, capsule size and mass; dodge cost 20, attack cost 10, jump cost 8, swim drain 10, run drain 6, regen delay 30 ticks, built-in regen 12 (`systems.ts`, `stats/stamina-system.ts`) | Code. Only `stats.json` drives (`moveSpeed`, `maxStamina`) and `MMO_PLAYER_ABILITIES` are data or env. | **Code.** | High |
| 3 | Combat resolution | Guard factor 0.25, arm reach 0.6, 60-degree cone, max height difference 2, fight difficulty 0.5, the fist weapon's mass, reach and hardness (`combat.ts`) | Code. `combat.json` covers techniques, fit, power, damage, precision and defence coefficients. | **Code** for these; the rest is raw (row 7). | High |
| 4 | Creature AI timing and ranges | Alert radius 40, hurt radius 20, calm 6 s, flee calm 1.5, territory give-up 1.6, flank offset 8, close-in 6, home radius 1.5, scan every 15 ticks, give-up every 10, asleep and ambush notice (0.25, 0.5), min water 0.8, look-ahead 2, reach margin 0.3, raid scoring weights (`creatures.ts`) | Code. `creatures.json` covers temperament, notice radius, telegraph, flee speed, tactics, activity, habitat, size and raid. | **Code** for timing; the per-kind behaviour is covered. | High |
| 5 | Crafting units, fittings, rune stone | Units per base by tag, default units, fittings a base adds by tag (hide straps, gold), rune stone and its count, default skill and skill map | `content/crafting/recipes.json` (read by `packages/crafting/src/rules.ts`, server `MMO_CRAFTING`) | **JSON only.** Gameplay grids cover `refining` and `reagents` only; the Content browser has no crafting entry. | Medium-high |
| 6 | Combat and body tables | Techniques (property, damage kind, skill), fit, power curve, damage base and mass power, precision, defence margins; body parts and shares, hit multipliers, severities, bleeding and clotting, healing, penalties, fall damage, medicine treatment durations and success rates | `content/rules/combat.json`, `content/rules/body.json` | **Raw.** Rules tree shows JSON keys, no labels, ranges, units or help. No form. | High |
| 7 | Skill pacing and medicine training | Mastery use interval 5 s, swimming difficulty 0.4, athletics difficulty 0.3, medicine training threshold 0.3, failed-treatment teach share 0.1, wound treatment order (stump 4, thrust 3, bandage 2) (`stats/mastery-system.ts`, `body.ts`) | Code. `skills.json` covers gain, familiarity and decay. | **Code** for these. | Medium |
| 8 | Town generator rules | 14 top-level sections (demographics, layout, farming, watch, mastery, industry, props, worship, architecture, …) in one 28 KB file | `content/settlements/rules.json` | **Raw.** Editable since 06451f1 through the generic `NodeEditor`, with no per-section forms or help. | Medium |
| 9 | Gathering internals | Regrow check cadence (every 30 ticks), hour unit for regrow (`gathering/gathering.ts`) | Code. Reach, cooldown, pouch cap and training are in `gathering.json` (editable since 3506914); per-node stock and `regrowHours` are the `Resource node` component in `packages/scene`. | Covered at the file level; the cadence is **code**. | Low-medium |
| 10 | Social and character limits | Party max 6, party invite 60 s, offline party 5 min, guild max 500, guild invite 60 s, guild message max 200, guild log 200, say range 30 m, chat text max 500, block list 200, character slots 8, character payload 4096 bytes (`party.ts`, `guild.ts`, `chat.ts`, `characters/rules.ts`) | Code. The character slot count can be set on the gateway, not in data. | **Code.** | Medium |
| 11 | Dungeon geometry and bots | Dungeon cell size 2 m, body radius 0.4, max step 8 (`dungeons/pool.ts`, `dungeons/walls.ts`); bot wander pace, stuck threshold, spar range 1.9 (`bots.ts`) | Code | **Code.** Cell size must match baked dungeons, so it is a developer value. | Low |
| 12 | Persistence cadence and query limits | Save every 300 ticks (10 s), keep 6 snapshots, WAL limit 4 MB, query row caps 500 and 5000, query timeout 2 s (`persist/store.ts`, `persist/persistence-core.ts`) | Code. Some are operator env. | **Code.** Operator concern, not design. | Low |
| 13 | World, time and tick | Tick rate fixed at 30 Hz (`tick-loop.ts`); day length and offset, world seed, chunk size, spawn radius, stream radius, terrain amplitude and frequency, bake radius; bot count and home | Env (`MMO_*`, see `docs/CONFIGURATION.md`) | **Env only.** Designers cannot change these without a developer; they are operator settings. | Low for design (fixed by the bake) |
| 14 | VFX tier budgets | Max emitters and particles per tier (`content/vfx/budgets.json`) | `packages/art/src/particle-budgets.ts` has the same numbers as code defaults and no reader of the file was found in `packages/` or `apps/`. | **Unclear.** The file may be dead data; the code default is what runs. Needs a decision: wire it or delete it. | Low (but a silent divergence risk) |

## Feature matrix

What each engine system reads and where the editor shows it. "Covered" means
a panel or grid saves the value; the depth of each form was not reviewed.

| System | Data file(s) | Editor surface | Status |
|---|---|---|---|
| Rules (all 14 files) | `content/rules/*.json` | Rules tree, generic | Reachable, raw |
| Skills, spells, creatures, items, loot, species | `content/rules/*`, `content/species/species.json` | Gameplay data grids | Covered |
| Refining, reagents, prefabs | `content/crafting/recipes.json` (refining, reagents), `content/prefabs` | Gameplay data grids | Covered |
| Crafting units, fittings, rune stone | `content/crafting/recipes.json` (rest) | none | JSON only |
| Dungeon runs, entrances | `content/dungeons/instances.json`, `entrances.json` | none (Dungeon workspace does not read them) | JSON only |
| Dungeon pool and patches | `content/dungeons/*` (pool, patch) | Dungeon workspace | Covered |
| PICG graphs | `content/pcg/*` | PICG Graphs view | Covered |
| Town generator | `content/settlements/rules.json` | Towns view, generic node editor | Raw |
| Quests, steps, NPCs, dialogs | `content/quests/*` | Story workspace (quests, dialogs, NPCs) | Covered; steps not checked |
| Strings and languages | `content/strings/<lang>.json` | Strings panel (multi-language host) | Covered |
| Audio events and buses | `content/audio/events.json` | Audio panel (events, bus gain and voices) | Covered |
| Combat moves and locomotion | `content/combat/moves.json`, `content/animation/*` | Animation panel | Covered |
| Materials | `content/materials/*` | Materials panel | Covered |
| VFX effects | `content/vfx/effects/*` | Particle panel | Covered |
| VFX tier budgets | `content/vfx/budgets.json` | none found | Unclear (row 14) |
| HUD layout | `content/ui/hud.json` | HUD editor (widget placement) | Partly checked; widget properties not verified |
| Scale | `content/scale.json` | Scale view | Covered |
| Edge routes | `content/edge/routes.json` | Network routes (validated and saved) | Covered |
| Modules | `content/modules.json` | Modules panel | Covered |
| Play setups | `content/play/setups.json` | Play menu | Covered |
| Playtests | `content/playtests/*` | Playtests panel | Covered |
| Build profiles | `content/build/profiles/*` | Release pipeline | Covered |
| Database functions and caches | `content/db/*` | Database workspace | Covered |
| Scenes and resource nodes | `content/scenes/*.scene.json` | Scenes workspace; component fields from the scene schema | Covered by schema (not clicked through) |

## Plan

Each step below
is one PR, per CLAUDE.md.

**Phase 1: forms over existing data (no engine change).** These are the
designer-critical items the engine already reads from files.

1. Dungeon run rules and entrances: a labelled form in the Dungeon workspace
   for `instances.json` and `entrances.json`. Fixes row 1 and the misleading
   Content browser link.
2. Combat and body forms: labelled panels for `combat.json` (techniques, power,
   damage, precision, defence) and `body.json` (parts, healing, penalties,
   treatment), with ranges and help, reusing `Field`, `DataTable` and the
   rules validation. Fixes rows 3 (data part) and 6.
3. Crafting form: units, fittings, rune stone, default skill and skill map in
   `recipes.json`, beside the existing refining and reagents grids. Fixes row 5.
4. Town rules: sectioned forms in place of the single node tree. Fixes row 8.

**Phase 2: move code constants into data, then add forms.** Each needs an
engine change first (schema, default, boot check), then the form. Each is a
separate PR, and the engine default stays so an absent key changes nothing.

5. Movement and stamina as rules (a new `content/rules/movement.json`). Fixes row 2.
6. Combat resolution constants into `combat.json`. Fixes row 3 (code part).
7. Creature timing and ranges into `creatures.json` behaviour. Fixes row 4.
8. Skill pacing and medicine thresholds into `skills.json` and `body.json`. Fixes row 7.
9. Social and character limits as rules (a new `content/rules/social.json`).
   Fixes row 10.

**Phase 3: the remaining rows.**

10. VFX budgets: read `content/vfx/budgets.json` and make it editable. Row 14.
11. Gathering regrow cadence into `gathering.json`. Row 9.
12. Dungeon walls and bot pacing as data. Row 11. The dungeon cell size stays
    fixed, because baked dungeons depend on it.
13. Persistence cadence and query limits as server settings with a form. Row 12.
14. World and time settings (day length and offset, bots) in a settings
    file with a form, env still overriding. Row 13. The seed, chunk size and
    radii must match the bake, so the editor shows them read-only.

Decided 2026-10-18: all fourteen rows are in scope, as roadmap items EG1 to
EG14 (section 1g).

## Roadmap rows

Added to `docs/ROADMAP.md` as section 1g, EG1 to EG14.
