# Dungeon furnishing, PR C: dense, realistic rooms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rooms hold realistic quantities, laid out as the real thing: dozens of coffins, rows of bunks with footlockers, racks of different arms, rows of shelves and tables, pews facing an altar under a huge statue with paintings, cells in a jail.

**Architecture:** Extend part A's pattern vocabulary (`line`, `before`, mounted `row`, an item's `reach` along its facing), give archetypes a `fill`, add ~30 prop kinds (props.json collision boxes + part B procedural recipes) and two archetypes (`jail`, `messhall`), then rewrite the built-in dressing with dense inventories. Dungeon file format unchanged.

**Tech Stack:** TypeScript, `@mmo-engine/placement`, `@mmo-engine/wfc`, zod, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-dungeon-furnishing-density-design.md` (stacked on part B, #347; part A is #346).

## Global Constraints
- Dungeon file format unchanged; scatter-only dressing stays byte-identical (part A's pinned hashes must still pass).
- Every doorway of a room stays reachable (part A's guard and its test); a per-dungeon ceiling of 700 spawned props in the shipped builtin dressing at ranks 1 to 5.
- A prop kind needs a `props.json` entry and a procedural recipe: the existing prop-mesh test pins the two lists equal.
- Arrangements stay data in `dressing.ts`; no room-type special cases in code.
- No licensed art, catalog names or art-derived files in the repo; pictures for GitHub use procedural props only (the art sweeps stay local).
- Commits end with the Co-Authored-By and Claude-Session lines.

## Review Focus
1. A `before` line whose anchor kind placed nothing, or placed more items than fit in front: no failure, the extras are skipped (Task 2).
2. A dense room is never sealed: the doorway guard holds for every archetype at every rank, with the new `fill` (Task 4 invariant test).
3. A mounted row on a short or doored wall: stops at the door gap, never hangs in the doorway (Task 1).
4. The prop ceiling: a large dungeon at rank 5 stays under 700 spawned props (Task 4).
5. An old dressing file (no `reach`, `at`, `fill`) loads and dresses exactly as before (Task 1 and part A's pinned test).

---

### Task 1: Pattern geometry for density (`arrange.ts`)

**Files:** Modify `packages/dungeon/src/arrange.ts`, `packages/dungeon/test/arrange.test.ts`.

**Interfaces:**
- `ArrangeCtx` gains `extent: { w: number; h: number }` (the room's size in cells; `line` runs along the longer side).
- Every `lay*` function gains a last parameter `o: { reach?: number; mounted?: boolean } = {}`: `reach` (cells, default `radius`) is the item's half-length along its facing: its centre stands `reach` from the wall and the next item in front is `reach*2 + gap` away; `radius` stays the lateral half-width and the clearance between neighbours. `mounted` poses hang on the wall (distance ~0.01 from it, clearance only from other mounted poses in `ctx.taken`).
- `layLine(ctx, radius, count, gap, at, o): Placed[]` — items down the room's long axis through the centre (`at` cells across it), spaced `2*radius + gap` (`2*reach+gap` is not used: the line is along the axis), `rot` along the axis.
- `layBefore(ctx, anchors: readonly Placed[], radius, gap, o): Placed[]` — one pose in front of each anchor (at `anchor.reach + reach + gap` along the anchor's facing), same `rot`; skips ones that do not fit; at most one per anchor.

- [ ] **Step 1: Write failing tests** (hand-made `room()` as in the existing file): `layLine` of 5 in a 24×16 room is collinear on `y = 8`, evenly spaced, `rot` along +x; in a 16×24 room it runs along y; with `at = 2` it is 2 cells off the centreline; `layBefore` of three beds on the north wall gives three poses one `reach*2+gap` in front of each, same `rot`, none when the front is blocked; `layRow` with `reach: 0.9, radius: 0.3` puts the first item 0.9 from the wall and neighbours `0.6 + gap` apart; `layRow` with `mounted: true` hangs items 0.01 from the wall, ignoring a floor item in `taken` marked by being far from the wall? (taken is only mounted poses for mounted calls: assert a mounted pose is not blocked by a floor pose that is 1 cell from the wall); a mounted row skips a doorway gap (`inside` false there).
- [ ] **Step 2: Run:** fail (functions/params missing).
- [ ] **Step 3: Implement** `layLine`, `layBefore`, and the `reach`/`mounted` options in the existing functions (`fits` takes a wall clearance separate from the lateral radius; for `mounted` the wall clearance is 0 and the hug distance 0.01).
- [ ] **Step 4: Run** the dungeon tests: pass (existing arrange tests unchanged by defaults).
- [ ] **Step 5: Commit** `dungeon: line and before patterns, item reach, mounted rows`.

### Task 2: Schema fields and `dress.ts`

**Files:** Modify `packages/dungeon/src/dressing.ts`, `packages/dungeon/src/dress.ts`, tests in `packages/dungeon/test/dress.test.ts`.

**Interfaces:**
- `ARRANGEMENTS` adds `"line"` and `"before"`. `ContentSchema` gains `reach: z.number().positive().optional()`, `at: z.number().default(0)`. `ArchetypeSchema` gains `fill: z.number().min(0.1).max(0.9).default(0.6)`. `loadDressing` rules: `before` needs an anchor; `line` needs none; a mounted line may be `row` only (other patterns still reject it); `reach` must be ≥ nothing else.
- `dress.ts`: the inventory area budget is `floor * arch.fill`; the footprint cost of a line with `reach` is `n * π * radius * reach * 4` (a line without `reach` keeps today's formula, so old dressings are unchanged); `DressedProp.radius` is `max(radius, reach)` (the collision footprint). A `row` line may run up to 8 passes; `line` is laid with `layLine`; `before` lines are laid after their anchor's line: the number of items is the number of anchor items placed (the WFC count for a `before` line is ignored), laid with `layBefore`; mounted `row` lines use `ctx.taken` of the room's other mounted props and keep the doorway guard off (collision none).

- [ ] **Step 1: Write failing tests** with custom dressings (as part A's `tomb()` helper): a `row` of 12 coffins with `radius 0.2, reach 0.5` fills at least 2 walls with every coffin facing in and heads 0.5 cells from the wall; a `line` of pillars is collinear along the room's long axis; a `before` line of footlockers has exactly as many items as the bunk line placed, each in front of its bunk; a mounted `row` of paintings hangs along a wall at distance ~0.01 from it and not in a doorway; `fill: 0.8` lets a room take more items than `fill: 0.3` (same seed); old dressings (no new fields) produce the part A pinned hashes; `loadDressing` rejects `before` without an anchor and a mounted `grid`.
- [ ] **Step 2: Run:** fail.
- [ ] **Step 3: Implement** the schema fields and validation, then the `dress.ts` changes above.
- [ ] **Step 4: Run** the dungeon tests: pass, including part A's pinned hashes and doorway tests.
- [ ] **Step 5: Commit** `dungeon: dress.ts lays lines, per-anchor items, mounted rows; archetypes have a fill`.

### Task 3: New prop kinds

**Files:** Modify `content/dungeons/props.json`, `packages/engine-core/src/dungeons/prop-mesh.ts`, `content/dungeons/looks.json` only if a new slot is needed (it is not).

**Interfaces:** New keys `dungeon:<kind>` in props.json (asset id the same, `category: "prop"`, a static box `collision.halfExtents [hx, hy, hz]` with `hy` the full height of a standing kind) and `lift` for the mounted ones; a recipe per kind in `RECIPES`. Kinds (and heights): `bunk-bed` 1.7, `footlocker` 0.5, `gear-locker` 2.0, `sword-rack` 1.6, `spear-rack` 2.2, `bow-rack` 1.6, `shield-rack` 1.4, `workbench` 1.0, `lectern` 1.3, `scroll-rack` 1.6, `bench` 0.5, `reading-table` 0.9, `long-table` 0.9, `candle-stand` 1.5, `altar` 1.1, `statue-large` 5.0, `painting` mounted (1.6 high, lift 2.0), `shield-wall` mounted (1.2, lift 2.2), `jail-cell` 2.4, `stocks` 1.4, `guard-desk` 1.0, `key-rack` mounted (0.6, lift 1.6), `hearth` 2.0, `cauldron` 1.2, `bone-pile` 0.5, `skull-shelf` 1.8, `carpet` 0.03 (a flat runner), `pulpit` 1.5, `quench-trough` 0.8, `coal-bin` 0.9, `tool-rack` 1.8, `serving-counter` 1.1, `bookshelf-tall` 2.8. Mounted kinds are centred on their origin like the banner and torch.

- [ ] **Step 1: Failing test:** the existing prop-mesh test (kinds equal, sound mesh, floor, height ±25% of the table, winding) fails once props.json has the new keys without recipes: add the keys first.
- [ ] **Step 2: Run:** `prop-mesh.test.js` fails listing the missing recipes.
- [ ] **Step 3: Implement** the recipes (a few primitives each: a bunk-bed is posts, two mattress boxes and a ladder; a jail-cell is bars on three sides, a floor slab and a door gap; an altar a stone slab on two plinths with a cloth runner and a gold cross; statue-large a tall plinth and a robed figure with raised arms; a painting a wooden frame, a canvas and a gold plaque).
- [ ] **Step 4: Run** engine-core dungeon tests: pass.
- [ ] **Step 5: Commit** `dungeons: thirty more prop kinds with meshes`.

### Task 4: The dense built-in dressing

**Files:** Modify `packages/dungeon/src/dressing.ts` (`BUILTIN_DRESSING`), `packages/dungeon/test/dress.test.ts`.

**Interfaces:** The spec's "Rooms" section as data: new archetypes `jail` (role combat/elite, minSize 8, `fill` 0.7) and `messhall` (combat, minSize 8); denser `crypt` (coffins `row` 10 to 24 `radius 0.2 reach 0.5`; sarcophagus `line` 2 to 5; candle-stand `beside`; urns corner; bone-pile corner; statue at the far wall), `barracks` (bunk-bed `row` 8 to 16, footlocker `before` bunk-bed, gear-locker `row` 3 to 6, weapon rack, armour stand, long-table with `bench` `before`), `armoury`, `library`, `chapel` (statue-large wall focal; altar `before` statue-large; candle-stand `flank` altar; pews `grid` `faces anchor altar` 10 to 24; paintings mounted `row`), `vault`, `forge`, throne hall (`line` carpet, two `line` pillar lines at `at ±2`, statues flank, braziers, banners mounted row), `ritual`, `storeroom`; `grotto`, `icehall`, `hall` modestly more. Counts, radii, `reach` and `fill` chosen so a typical room fills 40 to 70% of its floor.

- [ ] **Step 1: Write failing tests** over the standard cases (all themes, ranks 1, 3, 5): (a) a `crypt` room places at least 8 coffins in at least 70% of crypt rooms ≥ 9×9; a barracks room has at least 6 bunk-beds and as many footlockers; a library room at least 8 shelves; a chapel with an altar has at least 8 pews all facing it and at least 2 paintings; a jail has at least 6 cells; (b) every archetype id in the dressing is placeable in some theme at rank 5 (each archetype appears at least once over the cases); (c) the part A invariants (in room, floor, off doorway, clearance, no overlap) and doorway reachability hold; (d) a dungeon's total props ≤ 700 at ranks 1 to 5 over the cases; (e) the unplaced total is within 1.5× of part A's.
- [ ] **Step 2: Run:** fail.
- [ ] **Step 3: Implement** the data; tune counts until the invariants and the ceiling hold (lower counts or raise `gap`; never loosen a test).
- [ ] **Step 4: Run** the dungeon tests and the engine-core dungeon tests: pass.
- [ ] **Step 5: Commit** `dungeon: dense built-in rooms (crypt, barracks, armoury, library, chapel, jail, mess hall...)`.

### Task 5: See it, document, open the PR

**Files:** `docs/ROADMAP.md` (DF3), `docs/DUNGEONS-AND-LOOT.md`; scratch pictures outside the repo.

- [ ] **Step 1: Top-down renders** before/after for each room type (outside the repo) and fix what reads wrongly.
- [ ] **Step 2: In the running client** (scratch pool of this branch, scratch ports, as part B): a 360° sweep per room type with procedural props (for GitHub) and, locally only, with the art; send the files to the user.
- [ ] **Step 3: Full checks:** dungeon tests, engine-core dungeon tests, prop count per dungeon from a 30-dungeon scratch bake.
- [ ] **Step 4: Docs and roadmap**, commit; push; open the PR (base: part B's branch while #347 is open); do not merge.
