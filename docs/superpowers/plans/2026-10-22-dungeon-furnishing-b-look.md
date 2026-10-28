# Dungeon furnishing, PR B: props that look like what they are — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every dungeon prop kind shows a recognisable model in the run: the licensed catalog's model where a local overlay names one, else a procedural mesh built from primitives.

**Architecture:** A prop's `AssetRef` hash is `fnv1a32(asset id)`. `props.json` (committed) keeps `dungeon:<kind>`; the client already draws a pack model when the id is a catalog model (`SyntyProps`) and falls through to the instance's Pcg library otherwise (`PcgMeshes`, shell-style `addPrebaked`). So: (1) the server mounts one procedural PCGM per kind used in a run into the instance's library; (2) a git-ignored overlay `content/dungeons/props.local.json` remaps kinds to catalog model ids; (3) a CLI generates the overlay from `assets/catalog.json` by conservative name patterns; (4) `looks.json` palettes gain the prop material slots. No client code changes.

**Tech Stack:** TypeScript, `@mmo-engine/picg` (`encodePcgMesh`, `decodePcgMesh`, `fnv1a32`), zod, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-dungeon-furnishing-design.md` (PR B; PR A, arrangements, is #346). One change from the spec: the recipes live in `packages/engine-core/src/dungeons/prop-mesh.ts` (the server mounts them; engine-core already depends on picg), not in `packages/dungeon`.

## Global Constraints
- **Never commit, push or copy anything from `assets/`**, nor any file derived from the catalog (names, ids, sizes). The overlay `content/dungeons/props.local.json` is git-ignored; the generator CLI and its name patterns (generic words like `weapon.?rack`, no catalog data) are committed.
- `props.json` is unchanged: kinds stay `dungeon:<kind>`; collision boxes unchanged.
- No overlay file = every kind procedural; an overlay naming a kind the table lacks, or an invalid overlay, fails loud naming the file.
- Procedural meshes: metres, Y up, standing kinds rest on y = 0 (the entity stands on the floor), mounted kinds (`torch`, `banner`) are centred on their origin (the entity hangs at `lift`); front of a prop is +Z (the dressing's facing `rot` becomes the entity yaw as it does today). Hard-edged (a vertex per face corner), one material slot name per part from `PROP_SLOTS`.
- Matching by name is conservative: a false hit (cage→Ribcage, urn→Minetrack_Turn, desk→speakers) is worse than a procedural prop.
- One PR (`feat/dungeon-furnishing-look`, stacked on PR A's branch until #346 merges), roadmap row DF2 and an update-log line. Media (PNG, GIF) stays out of the repo.

## Review Focus
1. A kind in the baked dungeons that `props.json` has no entry for, or no recipe for: nothing spawns / no mesh, never a crash (Task 2).
2. The overlay remaps a light emitter (`dungeon:torch`): the run's `look` must list the new id too, or the torches go dark (Task 4).
3. Two runs in one process, or a prop kind used by many entities: assets are mounted once per instance, hashes never collide (Task 2).
4. The art is not served (overlay present, no `/assets`): the prop must not vanish silently from the plan's view — documented behaviour is "stand-in box"; the CLI warns that the overlay needs the art served (Task 5).
5. A theme palette missing a prop slot: the slot falls back to stone grey, and a test pins every slot in every theme (Task 3).

---

### Task 1: Procedural meshes (`prop-mesh.ts`)

**Files:**
- Create: `packages/engine-core/src/dungeons/prop-mesh.ts`
- Test: `packages/engine-core/test/dungeons/prop-mesh.test.ts`

**Interfaces:**
- Consumes: `encodePcgMesh`, `decodePcgMesh` from `@mmo-engine/picg`.
- Produces:
  ```ts
  export const PROP_SLOTS = ["stone", "wood", "metal", "cloth", "gold", "bone", "fire", "ice", "moss", "earth", "glass"] as const;
  export type PropSlot = (typeof PROP_SLOTS)[number];
  export const PROP_KINDS: readonly string[];   // every kind with a recipe (without the "dungeon:" prefix)
  export function propMesh(kind: string): Uint8Array | null;  // PCGM bytes, null for an unknown kind
  ```
  Recipes use private primitives `box(slot, cx, cy, cz, sx, sy, sz, yaw?)`, `cyl(slot, cx, cy, cz, rBottom, h, rTop?, segments?)`, each part a hard-edged triangle set. Recipes exist for every key of `content/dungeons/props.json` (39 kinds): pillar, brazier, banner, shrineCrystal, ring, bossCrystal, grave, sarcophagus, candle, iceShard, torch, anvil, armour-stand, barrel, bedroll, bookshelf, cage, candles, chest, coffin, coin-pile, crate, desk, frozen-body, gilded-chest, ice-pillar, mushrooms, pew, reliquary, ritual-circle, root-knot, rubble, sack, smelter, statue, table, throne, urn, weapon-rack. Heights follow `props.json`'s `halfExtents[1]` for standing kinds (the box's full height above the floor, ±25%); each recipe has at least two parts or slots so it reads as an object (a barrel is staves and hoops; a sarcophagus a plinth, a lid and a carved band; an anvil a base, a waist and a horned top).

- [ ] **Step 1: Write failing tests.** (a) `PROP_KINDS` equals the keys of `content/dungeons/props.json` with `dungeon:` stripped (read the file in the test). (b) For every kind: `propMesh(kind)` decodes (`decodePcgMesh`), has ≥ 12 triangles and ≤ 4000, every index in range, every material slot name in `PROP_SLOTS`, `triangleMaterials` length = triangles; its bounding box has `minY ≥ -1e-6` for standing kinds (all but `torch`, `banner`) and its height within ±25% of the table's `halfExtents[1]` for those; footprint (max of x and z extent) between 0.1 m and 4 m. (c) Determinism: two calls give identical bytes. (d) `propMesh("nope")` is `null`. (e) Every part's normals/winding point outward: for each recipe, the signed volume of the mesh is positive (outward winding).
- [ ] **Step 2: Run** `node --test dist/test/dungeons/prop-mesh.test.js` after build in `packages/engine-core`: fails (module missing).
- [ ] **Step 3: Implement** the primitives and the 39 recipes. Box/cylinder generators emit counter-clockwise outward triangles with a vertex per face corner; `propMesh` merges a recipe's parts into one mesh with `materials` = the slot names used and `triangleMaterials` per triangle, then `encodePcgMesh`. Keep each recipe a few lines of part calls in metres.
- [ ] **Step 4: Run** the engine-core dungeon tests: pass.
- [ ] **Step 5: Commit** `dungeons: procedural meshes for every prop kind`.

### Task 2: Mount the meshes in the run

**Files:**
- Modify: `packages/engine-core/src/dungeons/instance.ts` (replace `mountShell()` with `mountAssets()`)
- Test: `packages/engine-core/test/dungeons/dungeons.test.ts`

**Interfaces:**
- Consumes: `propMesh`, `PROP_KINDS` (Task 1), `PcgAssetLibrary.empty()`, `addPrebaked(id, bytes, displayName)`, `mountPcgService(gateway, library)`, `fnv1a32`.
- Produces: in a run, the instance's Pcg library lists the shell (as today, when the layout has one) and, once each, `dungeon:<kind>` for every distinct kind among `layout.props` whose table asset id is exactly `dungeon:<kind>` and that has a recipe. The Pcg service is mounted whenever the library is non-empty (a dungeon with no shell but with props gets it too). A kind with no table entry or no recipe is skipped (the existing `unspawnedProps` count stays for the first).

- [ ] **Step 1: Write failing tests** in `dungeons.test.ts` (use the existing shell test's setup for a layout and an instance): the library the instance serves lists `dungeon:coffin` and `dungeon:throne` when the layout holds a coffin and a throne, lists each once when there are ten coffins, lists no kind the layout lacks, still lists the shell id; a layout with props and no shell still serves its props; a layout whose only prop kind has no table entry serves nothing and spawns nothing without throwing; the entity spawned for a coffin carries `AssetRef.assetHash === fnv1a32("dungeon:coffin")`.
- [ ] **Step 2: Run:** the new tests fail.
- [ ] **Step 3: Implement** `mountAssets()` (called where `mountShell()` is, before `spawnProps()`): one library, the shell if any, the procedural kinds; `mountPcgService` once if the library lists anything; the shell entity code unchanged.
- [ ] **Step 4: Run** the dungeon tests: pass (the 3 `content-absent` failures are pre-existing).
- [ ] **Step 5: Commit** `dungeons: serve the props' meshes from the run's Pcg library`.

### Task 3: Prop material slots in the looks

**Files:**
- Modify: `content/dungeons/looks.json` (each theme's `palette`), `packages/engine-core/src/dungeons/content.ts` (nothing if the schema stays open; see below)
- Test: `packages/engine-core/test/dungeons/dungeons.test.ts`

**Interfaces:** Consumes `PROP_SLOTS`. Produces: every theme in `looks.json` has a `palette` entry for every `PROP_SLOTS` name (matte colours tinted to the theme: stone greys; wood warm browns; metal dark steel; cloth muted reds/greys; gold dull ochre; bone off-white; fire `#c8641e`; ice pale blue; moss dull green; earth brown; glass pale). The schema (`palette: z.record(...)`) already accepts extra keys.

- [ ] **Step 1: Write the failing test:** `loadDungeonContent()` on the repo's `content/dungeons` gives, for each of the five themes, a palette containing every `PROP_SLOTS` name as `#rrggbb`.
- [ ] **Step 2: Run:** fails (slots missing).
- [ ] **Step 3: Edit** `looks.json` (keep each theme's existing floor/wall/ceiling/basin).
- [ ] **Step 4: Run:** pass.
- [ ] **Step 5: Commit** `dungeons: the looks colour the props' material slots`.

### Task 4: The art overlay

**Files:**
- Modify: `packages/engine-core/src/dungeons/content.ts` (`loadDungeonContent`, `parseDungeonContent`, `DungeonContent`), `packages/engine-core/src/dungeons/instance.ts` (`pushLook`), `.gitignore`
- Test: `packages/engine-core/test/dungeons/dungeons.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PropArtSchema = z.strictObject({ version: z.literal(1), assets: z.record(z.string().regex(/^[a-z][A-Za-z0-9-]*$/), z.string().min(1)) }); // kind -> catalog model id
  export function parseDungeonContent(rules, entrances, props?, looks?, art?: unknown): DungeonContent;
  ```
  `loadDungeonContent(dir)` reads `props.local.json` from `dir` when present and passes it as `art`. The returned `props.archetypes["dungeon:<kind>"].asset` is the overlay's id for each kind it names (collision untouched). A kind that is not a key of the props table is an error: `props.local.json: assets.<kind>: no such prop kind`. `DungeonContent` also carries `artAssets: Record<string, string>` (the overlay's map, `{}` without one). `pushLook` sends `emitters` = `looks.emitters` plus the overlay id of each emitter whose kind is remapped (`dungeon:torch` → `artAssets.torch`), without duplicates.

- [ ] **Step 1: Write failing tests:** no overlay → archetype assets unchanged and `artAssets` `{}`; an overlay `{version:1, assets:{coffin:"SomeCoffinModel"}}` → `archetypes["dungeon:coffin"].asset === "SomeCoffinModel"` and the others unchanged; an overlay naming `"nope"` throws a message containing `props.local.json` and `nope`; invalid JSON shape throws naming the file; a look sent for a run whose overlay remaps `torch` lists both `dungeon:torch` and the new id in `emitters`; the entity spawned for a remapped kind carries `AssetRef.assetHash === fnv1a32("SomeCoffinModel")`.
- [ ] **Step 2: Run:** fail.
- [ ] **Step 3: Implement** the schema, the merge in `parseDungeonContent` (after the props parse), the file read in `loadDungeonContent`, the emitter mapping in `pushLook`, and add `content/dungeons/props.local.json` to `.gitignore`.
- [ ] **Step 4: Run:** pass.
- [ ] **Step 5: Commit** `dungeons: a local art overlay remaps prop kinds to catalog models`.

### Task 5: The overlay generator (`dungeon:art`)

**Files:**
- Create: `packages/dungeon/src/art-cli.ts`, `packages/dungeon/src/art.ts` (pure matching), `packages/dungeon/test/art.test.ts`
- Modify: `packages/dungeon/package.json` (script `dungeon:art`), `packages/dungeon/src/index.ts` (export)

**Interfaces:**
- Produces:
  ```ts
  export const DUNGEON_ART_PATTERNS: Record<string, { match: RegExp; avoid?: RegExp }>; // by prop kind, generic words only
  export interface CatalogModel { id: string; name: string; skinned?: boolean; triangles?: number; size?: [number, number, number] }
  export function matchProps(models: readonly CatalogModel[], kinds: readonly string[]): { assets: Record<string, string>; unmatched: string[]; contact: { kind: string; model: string; candidates: number }[] };
  ```
  `matchProps` skips skinned models; per kind takes models whose `name` matches `match` and not `avoid`, sorted by name then id, and picks the first (deterministic); kinds with none are `unmatched`. Patterns: weapon-rack `weapon.?rack`, barrel `\bbarrel`, chest `chest` (avoid `lid|chestplate|armou?r`), gilded-chest none, crate `crate`, statue `statue`, brazier `brazier`, throne `throne`, anvil `anvil`, coffin `coffin`, torch `torch` (avoid `ornate_.*lid`), pillar `pillar`, rubble `rubble`, table `table` (avoid `skeleton|speaker`), candles `candles?` (avoid `particle`), sack `\bsack`, pew `pew`; the other kinds have no pattern (procedural). CLI `npm run dungeon:art -- --catalog <assets/catalog.json> --props content/dungeons/props.json --out content/dungeons/props.local.json`: writes the overlay, prints the contact list (kind → model, how many candidates, triangles) and the unmatched kinds, and warns that the overlay needs the art served.

- [ ] **Step 1: Write failing tests** with a synthetic catalog (made-up names, not real catalog data): `weapon_rack_01` matches weapon-rack; `Ribcage` does not match `cage` (no pattern) ; `Chest_Lid`/`ChestPlate` are avoided for chest and `Chest_01` wins; a skinned `Barrel` is skipped; picking is deterministic across input orders; kinds with no pattern are unmatched; the written overlay parses with `PropArtSchema`.
- [ ] **Step 2: Run:** fail.
- [ ] **Step 3: Implement** `art.ts` and `art-cli.ts` (read catalog JSON `{ models: [...] }`, write `{ version: 1, assets }`).
- [ ] **Step 4: Run** the dungeon tests: pass.
- [ ] **Step 5: Commit** `dungeon: dungeon:art generates the local art overlay from the catalog`.

### Task 6: See it; document; open the PR

**Files:**
- Modify: `docs/ROADMAP.md` (DF2 to 🚧 with the branch, an update-log line), `docs/DUNGEONS-AND-LOOT.md` (a short "Prop looks" section)
- Scratch (not committed): PNG and GIF renders in the scratchpad.

- [ ] **Step 1: Meshes at a glance.** Render every procedural prop as a turntable (PNG contact sheet and a GIF) outside the repo; fix any that read wrongly.
- [ ] **Step 2: In the running client.** Bake a scratch pool (`dungeon:bake`, arrangements from PR A), run the core and client on spare ports per the handoff recipe (`docs/HANDOFF-2026-10-20.md`), enter a dungeon with Playwright and screenshot a crypt, armoury, chapel and throne room; record a GIF walk-through. Do it without the overlay (procedural everywhere) and, with `assets/` served through a directory junction and a generated overlay, with the art. Nothing from `assets/` is committed.
- [ ] **Step 3: Full checks.** `npm test -w @mmo-engine/dungeon`; engine-core dungeon tests (only the 3 known failures); client dungeon-look tests.
- [ ] **Step 4: Docs and roadmap**, commit `docs: dungeon furnishing B`.
- [ ] **Step 5: Push and open the PR** (base: PR A's branch while #346 is open, else `main`), body listing what the screenshots show; do not merge.
