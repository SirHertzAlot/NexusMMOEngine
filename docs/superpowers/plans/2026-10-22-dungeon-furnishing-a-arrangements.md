# Dungeon furnishing, PR A: room arrangements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Items in a dungeon room are laid out the way that kind of room would be (rows of coffins, pews in a grid facing the altar, an anvil beside its smelter), as data on each archetype's content lines, inside the existing dressing pass.

**Architecture:** `ContentSchema` (dressing.ts) gains optional `arrange`, `faces`, `anchor`, `gap`. A new pure-geometry module `arrange.ts` turns a pattern into candidate poses over the room's distance field; `dress.ts` calls it for lines that name a pattern, keeps its own validity rules (inside the room, off doorways, clear of everything), and falls back to the existing scatter for what does not fit. Dungeon file format unchanged.

**Tech Stack:** TypeScript, `@mmo-engine/placement` (`Sdf2`, `GridSdf`, `Placed`, `normal2`, `march2`), `@mmo-engine/wfc`, zod, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-dungeon-furnishing-design.md` (this plan is PR A; PR B, art overlay and procedural meshes, gets its own plan after A merges)

## Global Constraints
- Dungeon file format does not change: `dressing.props` keeps `kind, x, y, rot, room, mount, radius, collision` (grid cells; `rot` = facing angle, `atan2(ny, nx)`).
- No arrangement named = today's behaviour, byte for byte (pinned by Task 3's test).
- Deterministic per seed: same dungeon, dressing, rank and seed dress the same.
- Arrangements are data in `dressing.ts`; the code knows patterns only, never a room type or prop kind.
- Props never block doorways, stand in basins or overlap: the existing `check()` invariants in `test/dress.test.ts` keep holding.
- Never touch `assets/`. The user's pool (`packages/engine-core/data/dungeons`) is not rebaked in this PR; verification uses a copy in the scratchpad.
- One PR (`feat/dungeon-furnishing`, base `main`): roadmap row and update-log line with it. Commit messages end with the Co-Authored-By and Claude-Session lines; the PR body ends with the Claude Code line.

## Review Focus
1. A room too small, narrow or oddly shaped for its row/grid/ring: fewer items fit; the rest fall back to scatter, then `unplaced`; nothing overlaps or leaves the room (Task 2, Task 4 tests).
2. `anchor` names a kind the room did not place (count 0 or unplaced): the line falls back to plain scatter instead of failing (Task 3 test).
3. Rows or grids sealing a room: every doorway of a room stays reachable from every other across free floor (Task 4 test, flood fill over the grid with solid props as discs).
4. A dressing file written before this change (no `arrange` anywhere) loads and dresses exactly as before (Task 1 and Task 3 tests).
5. Rebaking changes dressing only: room grids, doorways and shells of the same seed are identical before and after (Task 5 check).

---

### Task 1: Arrangement fields on content lines

**Files:**
- Modify: `packages/dungeon/src/dressing.ts` (`ContentSchema`, `Content`, `loadDressing` validation)
- Test: `packages/dungeon/test/dress.test.ts` (in "dressing data and the bake")

**Interfaces:**
- Produces: `export const ARRANGEMENTS = ["scatter", "row", "grid", "flank", "beside", "ring"] as const; export type Arrangement = (typeof ARRANGEMENTS)[number];` and on `Content`: `arrange: Arrangement` (default `"scatter"`), `faces?: "room" | "anchor" | "out"`, `anchor?: string` (a `kind` of another line of the same archetype), `gap: number` (cells between neighbours, default `0.3`, `>= 0`).

- [ ] **Step 1: Write the failing tests** in `dress.test.ts`: (a) `loadDressing` on a temp JSON file with an archetype line `{kind:"coffin", where:"wall", radius:0.6, count:[1,3], arrange:"row"}` loads with `arrange === "row"` and `gap === 0.3`; (b) a line with `arrange:"zigzag"` throws naming `archetypes.<id>.contents[<i>].arrange`; (c) a line `arrange:"flank"` with no `anchor` throws "needs an anchor"; (d) a line whose `anchor` names a kind not in the same archetype throws naming it; (e) `BUILTIN_DRESSING` lines all have `arrange` defined.
- [ ] **Step 2: Run** `npm test -w @mmo-engine/dungeon` — the new tests fail (unknown key / no field).
- [ ] **Step 3: Implement** the fields in `ContentSchema` (`z.enum(ARRANGEMENTS).default("scatter")`, `gap: z.number().min(0).default(0.3)`) and the two cross-line problems in `loadDressing`'s problems loop. `c()` in dressing.ts defaults the new fields.
- [ ] **Step 4: Run** the dungeon tests: all pass (existing 48 included).
- [ ] **Step 5: Commit** `dungeon: arrangement fields on dressing content lines`.

### Task 2: Pattern geometry (`arrange.ts`)

**Files:**
- Create: `packages/dungeon/src/arrange.ts`
- Create: `packages/dungeon/test/arrange.test.ts`
- Modify: `packages/dungeon/src/index.ts` (export the module)

**Interfaces:**
- Consumes: `Sdf2`, `Placed` from `@mmo-engine/placement` (`Placed = {x, y, rot, nx?, ny?, radius}`).
- Produces:
  ```ts
  export interface ArrangeCtx {
    sdf: Sdf2;                                   // open floor positive, solid negative
    inside: (x: number, y: number) => boolean;   // the room's own floor, off doorways (dress.ts's region.inside)
    taken: readonly Placed[];                    // what is already there
    centre: { x: number; y: number };            // the room's centre
  }
  export function layRow(ctx: ArrangeCtx, wall: Placed, radius: number, count: number, gap: number): Placed[];
  export function layGrid(ctx: ArrangeCtx, radius: number, count: number, gap: number, faceTo: { x: number; y: number } | null): Placed[];
  export function layFlank(ctx: ArrangeCtx, anchor: Placed, radius: number, count: number, gap: number, sides: 1 | 2): Placed[];
  export function layRing(ctx: ArrangeCtx, anchor: Placed, radius: number, count: number, gap: number, face: "in" | "out"): Placed[];
  ```
  Every function returns only poses that are `inside`, have `sdf.distance >= radius - 1e-6`, are clear of `taken` and of each other (centres at least `r + r'` apart), in laying order, and may return fewer than `count`. Never throws, never mutates `taken`.
  - `layRow`: from the wall pose (a wall-settled item: `nx, ny` its normal, `rot` facing out of the wall), step along the tangent `(-ny, nx)` by `2*radius + gap`, alternately `+` and `-`, same `rot` and normal for all; stops on the first invalid step on each side.
  - `layGrid`: lattice of pitch `2*radius + gap` aligned to the axes through `ctx.centre`; takes valid lattice points nearest the centre first, ordered row by row; all share one `rot`: the angle from the lattice's centre toward `faceTo` when given, else `Math.PI / 2` (facing +y).
  - `layFlank`: items along the anchor's tangent at `±(anchor.radius + radius + gap)`, `±2*...` etc., same `rot` as the anchor; `sides = 1` uses `+` only (an anvil beside its smelter), `2` alternates `+`, `-`.
  - `layRing`: equally spaced angles on a circle of `anchor.radius + radius + gap` about the anchor, `rot` = toward the anchor (`"in"`) or away (`"out"`).

- [ ] **Step 1: Write failing tests** in `arrange.test.ts` on a hand-made `GridSdf` (a 24×16 open room, 1-cell solid border; `GridSdf(width, height, isSolid)`): `layRow` along the north wall for 5 items of radius 0.6 returns 5 poses with equal `y` (collinear), consecutive spacing `2*0.6+0.3` within `1e-9`, all `rot` equal to the wall's; `layRow` in a 4-wide room asks for 9 and returns fewer and none overlap; `layGrid` of 6 returns 6 poses on a lattice (distinct x steps and y steps equal to the pitch) with one shared `rot`; `layFlank` sides 2, count 2 puts one item at each side of the anchor, mirrored; sides 1, count 2 puts both on the `+` side; `layRing` count 4 puts 4 items equidistant from the anchor with `rot` pointing at it for `"in"`; every result respects `inside`, clearance and `taken` (add a blocker in the way and assert the row stops short); empty input (`count: 0`) returns `[]`.
- [ ] **Step 2: Run** `node --test dist/test/arrange.test.js` after build — fails (module missing).
- [ ] **Step 3: Implement** the four functions and a shared private `fits(ctx, placed, p, r)` validity check. Approach: build poses analytically from the anchor/lattice, then filter through `fits`.
- [ ] **Step 4: Run** the dungeon tests: pass.
- [ ] **Step 5: Commit** `dungeon: row, grid, flank and ring pattern geometry`.

### Task 3: Use the patterns in `dress.ts`

**Files:**
- Modify: `packages/dungeon/src/dress.ts` (the per-room placement block)
- Test: `packages/dungeon/test/dress.test.ts`

**Interfaces:**
- Consumes: Task 1 fields, Task 2 functions, `placeInRegion` (unchanged).
- Produces: `DressedProp` unchanged. Behaviour: for each room, lines are expanded to items as today; a line with `arrange !== "scatter"` is laid by its pattern over `{ sdf, inside: region.inside, taken: layoutTaken[r], centre: {room.cx, room.cy} }`: `row` seeds `layRow` from one wall-settled item (`placeInRegion` with `where: "wall"` for that line, first spot); `grid` calls `layGrid` with `faceTo` = the anchor item's position when `anchor` is set, else `null`; `flank`/`beside` call `layFlank` (sides 2 / 1) round the anchor's first placed item; `ring` calls `layRing` (`face` from `faces`: `"out"` → `"out"`, otherwise `"in"`). Lines named as anchors are placed before the lines that use them, then centre lines, then larger radius first (today's order otherwise). Items a pattern could not fit go through the existing scatter in the same room; whatever still fails counts in `unplaced`. A line with a missing `anchor` placement is scattered.

- [ ] **Step 1: Pin the old behaviour first.** With the current code (before editing `dress.ts`), compute `sha256(JSON.stringify(dressDungeon(d, dressingWithAllScatter, rank).props))` for three of the existing `cases` and write them into a new test "scatter-only dressing dresses as before" as literal constants (`dressingWithAllScatter` = `BUILTIN_DRESSING` as it is now, every line `arrange: "scatter"`). Run: PASS on current code.
- [ ] **Step 2: Write the failing tests**: (a) a custom dressing with one archetype `crypt-test` (role combat, `minSize: 6`) holding `{coffin, wall, row, count [3,3]}` and `{sarcophagus, centre, count [1,1]}`: in at least 80% of 20 seeded dungeons that place all three coffins, the coffins are collinear (equal distance to a common wall line within `1e-6`) and equally spaced; (b) a line `flank` anchored on a kind the room never placed (`count: [0,0]`) still places its items by scatter and sets no error; (c) arranged items pass the existing `check()` (in room, floor, off doorway, clearance, clear of spawns).
- [ ] **Step 3: Run** — (b) and (c) may already pass, (a) fails.
- [ ] **Step 4: Implement** in the placement block of `dress.ts`; keep `placeInRegion` for scatter and the wall seed. Do not change the stage seeds (`STAGE`, `deriveSeed` arguments) for scatter-only lines.
- [ ] **Step 5: Run** the dungeon tests: the pinned-hash test still passes, all pass.
- [ ] **Step 6: Commit** `dungeon: dress.ts lays content lines by their arrangement`.

### Task 4: Arrangements for the built-in rooms, with invariants

**Files:**
- Modify: `packages/dungeon/src/dressing.ts` (`BUILTIN_DRESSING`)
- Test: `packages/dungeon/test/dress.test.ts`

**Interfaces:** Consumes Tasks 1 to 3. Produces the built-in dressing the spec's "Rooms" section describes, as data: crypt (sarcophagus centre; coffins `row`; urns corner), armoury (weapon-rack `row`; armour-stand `flank` anchored on weapon-rack; crate corner), barracks (bedroll `grid` anchored on table; table centre; barrel corner), storeroom (crate and barrel `row`; sack floor), library (bookshelf `row`; desk centre; candles corner), ritual (circle centre; candles `ring` anchored on ritual-circle; cage `row`), forge (smelter wall; anvil `beside` anchored on smelter; crate corner), vault (chest `row`; coin-pile `beside` anchored on chest), chapel (pew `grid` `faces: "anchor"` anchored on reliquary, else wall facing; candles corner), throne (throne wall; statue `flank` anchored on throne; brazier `flank`), gatehall (statue `flank`, brazier corner). grotto, icehall, hall stay `scatter`. Counts, radii, themes unchanged.

- [ ] **Step 1: Write failing tests** over the existing `cases` (all themes, ranks 1, 3, 5): (a) a room dressed `crypt` with at least 2 coffins has them within one row (collinear and evenly spaced, tolerance `1e-6`) in at least 60% of such rooms; same for `armoury` weapon racks; (b) every pew of a chapel room shares one `rot`; (c) for each room, all its doorway cells are mutually reachable across free floor (flood fill over the room's floor cells, treating each solid prop as a disc of its `radius`); (d) `unplaced` summed over the cases is at most 1.25 times its value with every line forced to `scatter`; (e) the existing `check()` holds for all; (f) `relaxed` stays empty for archetypes.
- [ ] **Step 2: Run** — (a), (b) fail.
- [ ] **Step 3: Implement** the data edits in `BUILTIN_DRESSING`. If (c) or (d) fails, lower counts or raise `gap` for the offending line rather than loosening the test.
- [ ] **Step 4: Run** the dungeon tests: pass.
- [ ] **Step 5: Commit** `dungeon: built-in rooms are arranged (rows, grids, flanks, rings)`.

### Task 5: Verify on a scratch pool, document, open the PR

**Files:**
- Modify: `docs/ROADMAP.md` (new row `D4f` in the dungeon section: "Dungeon furnishing A: rooms arranged by archetype" status 🚧 → ✅ at merge, and an update-log line), `docs/DUNGEONS-AND-LOOT.md` (a short "Arrangements" section: the fields and patterns)
- Scratch (not committed): a copy of the pool at `<scratchpad>/pool`, PNGs in `<scratchpad>`.

- [ ] **Step 1: Layouts unchanged.** Bake 5 dungeons with the old code (checkout of `main`, `--seed 1`) and with this branch into two scratch dirs; assert per dungeon that `grids`, `rooms`, `corridors`, `entrance`, `boss` and the shell file bytes are identical and only `dressing`, `hash` and `id` differ.
- [ ] **Step 2: Look at it.** `npm run dungeon:bake -- --n 6 --seed 1 --png --out <scratch>/pool`; view the preview PNGs (`preview.ts`) of a crypt, armoury, barracks, chapel, throne and forge room and confirm rows, grids and flanks read as intended; save the PNGs outside the repo.
- [ ] **Step 3: In the running client.** With the scratch pool, run the core and client per the dungeon verification recipe (scratch data dir, spare ports, Playwright from the scratchpad) and screenshot a crypt and an armoury; the props are still boxes (PR B) but stand in rows. Note in the PR what the screenshots show.
- [ ] **Step 4: Full checks.** `npm test -w @mmo-engine/dungeon` and `npm test -w @mmo-engine/engine-core -- dungeons` pass; `npm run build` for dungeon and engine-core exits 0.
- [ ] **Step 5: Roadmap and docs**, then commit `docs: dungeon furnishing A`.
- [ ] **Step 6: Push and open the PR** against `main` (`gh` at `C:\Program Files\GitHub CLI\gh.exe`): describe the fields, the patterns, the rebake note (existing pool unchanged until rebaked), the screenshots; do not merge (assistant merges are the user's call).
