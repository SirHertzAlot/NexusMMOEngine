# Decision Log

Every entry: date, decision, rationale. Newest first.

- **2026-10-26 — Character Foundation: Data-Driven Archetypes, Pure Deterministic Profile Resolution, High-Throughput Profession Rescoring, and Reactive Bark Personalization.**
  To support resident identities, profession matching, psychological profiles, and reactive dialogue lines without simulation tick overhead or per-character branching logic (packages/settlement/src/character/, content/settlements/character.json):
  - **Data Schemas & Catalogs (character.json, schemas.ts, catalogs.ts):** Authored in content/settlements/character.json with 18 archetypes, 10 temperaments, 10 interests, 28 descriptors across 4 disjoint functional slots (demeanor, moral, drive, social), 38 descriptor rules with cross-reference validations, 18 backstory fragment templates, defaults, and tuning parameters (aseWeights, jitterBand = 0.15, clamp = [0.25, 2.5]). Validated strictly with Zod in schemas.ts and checkCharacterCatalogs().
  - **Pure Generation & Profile Resolution (generator.ts, esolver.ts):** generateCharacter follows a strict fixed draw sequence (archetype -> temperament -> 2 distinct interests -> 4 descriptors across slots satisfying compatibility rules -> backstory pins). esolveProfile computes 8 trait weights (openness, conscientiousness, extraversion, greeableness, euroticism, mbition, piety, physicality) via multiplicative modifiers and additive jitter, clamped to [0.25, 2.5] and quantized to 3 decimal places with positive zero normalization (+ 0). Derives scalar behavioral biases (leeBias, 	rustBias, gossipBias) and arkTone.
  - **High-Throughput Greedy Rescoring (generate.ts, scoring.ts):** Integrated into settlement bake pipeline as the character stage directly between occupancy and props. Section 11 professionScore computes fitness combining demand weights, rank discounts, archetype affinities, and mastery bonuses. For large metropolises (e.g., 2,500 population with ~1,500 job slots), candidate matching is optimized from O(M * N) naive scanning down to O(K * N log N + M) using pre-sorted candidate index pools per unique role, slashing bake latency from ~60s to ~5ms (>12,000x speedup) while guaranteeing deterministic tie-breaking. Recomputes 	ownGuild after rescoring to keep guild.master synchronized.
  - **Reactive Bark Reader Integration (arks.ts):** arkFor consumes resolved character profiles, personal descriptor barks (DESCRIPTOR_BARKS), tone-specific greetings (TONE_GREET), and personal want/flaw backstory pools (BACKSTORY_BARKS), providing rich conversational flavor while preserving 100% backward compatibility when character profiles are omitted.

- **2026-10-26 — Dungeon Player Death, Loot Forfeiture, and Open-World Gate Respawn.**
  When a player character dies inside a dungeon instance:
  - **Run Termination (`InstanceOutcome: "died"`):** In `packages/engine-core/src/dungeons/instance.ts`, player death terminates the run immediately with outcome `"died"`. All chest drops and monster loot obtained during the run are emptied (`this.loot = []`) and reported as `items: 0`.
  - **Loot Drop & Access Revocation:** In `InstanceManager.commit()`, runs ending with `"died"` skip reward item granting (`grant()`) and result persistence, ensuring players lose access to dungeon chests and instance progress on defeat.
  - **Client Feedback & UI:** The client renders an active "You Died - Respawning at the gates..." HUD overlay while dead and presents the `DungeonResult` end-card with dungeon name, red death accenting, loss notifications, and a "Respawn at dungeon gates" action.
  - **Gate Respawn:** `Gateway.respawnPlayer()` resolves the nearest open-world dungeon gate anchor (`respawnAnchors`) to teleport the player back alive with restored health.

- **2026-10-25 — First-Person Viewmodel Rig (`FirstPersonRig`), Biomechanical Skeletal Camera Coupling, and Continuous Pitch/Reticle Anatomical Strike Aiming.**
  To overhaul the game's first-person perspective from a detached, static camera into an immersive, biomechanically responsive FPS combat experience with visible viewmodel arms and weapons:
  - **Biomechanical Camera Coupling (`apps/client/src/render/first-person-camera.ts`):** Replaced static eye translation with zero-heap `FirstPersonCameraState` and `stepFirstPersonMotion()`. Incorporates Lissajous idle breathing harmonics (0.40 Hz), stride-frequency translational and rotational head-bob (walk, jog, sprint, swim) with lateral banking roll tilt, critically-damped spring-damper landing dip (`landingDip` / `landingVel`), combat move impulses (`SwordA` / `SwordB` / `SwordC` forward roll/pitch lunges, `Guard` bracing, `ShieldBash` forward thrust, `Roll` rotational impulse), and skeletal `Head` bone tracking blend. Tuned `CAMERA_NEAR` from `0.5m` to `0.08m` to prevent viewmodel weapon clipping.
  - **Visible First-Person Viewmodel Rig (`apps/client/src/render/first-person-rig.ts`):** Articulated dual-arm viewmodel rig with customizable skin, tunic sleeves, vambrace cuffs, and fingers. Features procedural weapon geometries for all 10 item categories (`sword`, `greatsword`, `axe`, `mace`, `dagger`, `spear`, `staff`, `wand`, `bow`, `shield`) with fallback to loaded Synty prop models. Includes dynamic weapon swing ribbon trails (`FirstPersonWeaponTrail`) that emit during attack windows and fade with opacity/width gradients. Pure pose evaluation (`evaluateFirstPersonPose`) ensures zero heap allocation per frame.
  - **Server-Authoritative Pitch Aiming & Dynamic Reticle HUD (`packages/engine-core/src/combat.ts`, `apps/client/src/render/entity-layer.ts`, `apps/client/src/ui/combat-hud.tsx`):** Continuous center-screen raycasting in FPS view recursively traverses `SkinnedMesh` hierarchies to target combatants and classifies 3D hit heights into anatomical parts (`classifyAimedBodyPart`). Pitch-driven aiming (`aimFromLookPitch`) derives aimed body parts (`HEAD` on high pitch < -0.22, `LEGS` on low pitch > +0.22, `TORSO` in deadzone, lateral bias for arms) when no manual stance aim override is set. Dynamic SVG crosshair indicates weapon technique (`CUT`, `THRUST`, `BLUDGEON`), strike reach range, active combo chain timing ring, guard mitigation status, hitmarker flashes, and provides a 6-zone anatomical stance HUD.

- **2026-10-25 — Paperclip Improvement Crawler (`scripts/improvement-crawler.mjs`) & Academic Data/Memory Management Patches (`patches/PATCH-01..PATCH-05`).**
  To continuously optimize the Hybrid Data Plane and bitECS architecture with peer-reviewed systems research and university theses, `npm run crawler:improvements` (`scripts/improvement-crawler.mjs` + `patches/paperclip-crawler-routine.json`) queries OpenAlex and curated game-engine theses, writes `patches/research-corpus.json` and `patches/paperclip-handoff.json`, maintains five direct implementation specs in `patches/`, and hands off execution to **Gemini** (via Paperclip Control Plane `/api/companies/:companyId/issues` + `/documents` and subagent delegation):
  - **`PATCH-01` (`PATCH-01-avx2-fma-hierarchical-bitset-simd.md`):** 8-wide AVX2 FMA3 (`_mm256_fmadd_ps`) + 64-bit `aliveBitset` (`uint64_t`) zero-word skipping in `packages/addons/integrate/src/integrate.cc` (`stepSimulationSoABitset`), saving 4,096 bytes (64 cache lines) of memory traffic per empty 64-entity block.
  - **`PATCH-02` (`PATCH-02-morton-z-order-spatial-cache-locality.md`):** SWAR 32-bit 2D Morton Z-order curve encoding (`encodeMorton2D`, `decodeMorton2D`) + 4-pass 8-bit LSD radix sort (`MortonSpatialIndex`) in `packages/engine-core/src/sab-store.ts` for zero-GC $O(\log N)$ spatial radius queries.
  - **`PATCH-03` (`PATCH-03-vyukov-mpsc-cacheline-coalesced-ring.md`):** Dmitry Vyukov bounded lock-free MPSC queue (`AtomicMPSCQueue`) in `packages/engine-core/src/lockless-ring.ts` with per-slot sequence numbers and 64-byte cache-line isolation between `enqueuePos` and `dequeuePos`.
  - **`PATCH-04` (`PATCH-04-dirty-bitset-group-commit-surreal-ledger.md`):** 320-word dirty-bitset checkpoint deduplication and vectorized SurrealQL group-commit batching in `packages/engine-core/src/persist-worker.ts`.
  - **`PATCH-05` (`PATCH-05-generational-slab-arena-zero-gc-handles.md`):** 32-bit packed generational handle (`[16-bit gen | 16-bit index]`) and $O(1)$ bitset-freelist slab allocator (`GenerationalSlabAllocator`) in `packages/engine-core/src/sab-store.ts` eliminating ABA stale-slot corruption.

- **2026-10-25 — Zero-Copy Hybrid Engine Data Plane: Master Ingestion Gateway + 30Hz C++ SIMD Simulation Worker + Embedded SurrealDB Persistence Worker over SharedArrayBuffer and Lockless SPSC Rings.**
  To eliminate JSON serialization overhead, V8 garbage-collection pauses, OS mutex context switches, and network roundtrips on the authoritative tick loop, the engine provides a dedicated Zero-Copy Hybrid Data Plane (`packages/engine-core/src/{sab-store,lockless-ring,sim-worker,persist-worker,data-plane-server}.ts`, `packages/addons/integrate/src/integrate.cc`, `packages/engine-core/src/persist/schema.surrealql`):
  - **Memory Arena (`sab-store.ts`):** `createSharedMemoryPlane()` allocates a single page-aligned `SharedArrayBuffer` divided into a 32-byte-strided entity matrix (`SOA_LAYOUT`, 8 words per entity: `POSITION_X..Z`, `VELOCITY_X..Z`, `HEALTH`, `INTENT_BIT`), 64-byte cache-line padded lockless rings (`OFFSETS.RINGS`, `OFFSETS.PERSIST_RING`), atomic telemetry counters (`OFFSETS.TELEMETRY`), and 64-byte-aligned Planar SoA columns (`attachSharedMemoryPlane`) for branchless SIMD vectorization. Existing bitECS `defineSABComponent` / `SAB_ENTITY_CAPACITY = 100_000` stores remain 100% preserved.
  - **Lockless Synchronization (`lockless-ring.ts`):** `AtomicSPSCQueue` separates `head`, `tail`, and `buffer` by 64-byte cache lines (`SPSC_CACHE_LINE_BYTES = 64`) to prevent CPU false sharing, pairs power-of-2 bitmask indexing with Rigtorp shadow index caching (`cachedHead`/`cachedTail`) to avoid redundant cross-core cache invalidations, and adds zero-allocation single-fence batch operations (`enqueueBatch`, `drainTo`) plus `AtomicSPSCTransactionQueue` for the secondary persistence channel.
  - **Zero-Copy C++ Simulation Core (`packages/addons/integrate` / `engine_kernel.node`):** Exposes `stepSimulation` (strided matrix matrix pointer walk skipping `HEALTH <= 0`), `applyIntentsAndStep` (fused intent-bit decode + Euler step in one L1 cache pass), and `stepSimulationSoA` (4-wide SSE2 branchless SIMD using `_mm_cmpgt_epi32` masks and bitwise blends to eliminate branch mispredictions under arbitrary alive/dead entity entropy).
  - **3-Thread Topology (`data-plane-server.ts`, `sim-worker.ts`, `persist-worker.ts`):** The Master Thread (`uWebSockets.js` on `/ws/sim`) ingests raw 4-byte binary frames (`[Uint16 entityIndex (LE), Uint16 actionCode (LE)]`), packs a 32-bit command token, and enqueues it into `AtomicSPSCQueue`. The 30Hz Simulation Worker drains the queue, updates `INTENT_BIT`, steps the C++ kernel, and enqueues ACID checkpoint/inventory transactions onto the secondary SPSC ring for the Persistence Worker running embedded SurrealDB (`@surrealdb/node`, `schema.surrealql` with `SCHEMAFULL` `entity`, `inventory_slot`, and `owns` graph relations).

- **2026-10-20 — Road vertical profile is terrain-conformant A* routing over the heightfield, owned by engine-core.**
  A straight spline between two junctions will cut through a lake or carve a
  mountainside. The road router (`packages/engine-core/src/terrain/road-router.ts`)
  walks each edge with A* over a heightfield grid, mirroring the route walker in
  `@mmo-engine/settlement`'s `planPlaces` (`walkRoute`): cells at or below the water
  level (or flagged wet) are blocked, and steps steeper than a cart grade (`maxGrade`,
  default 8%) are avoided so a road bends around a water body or ridge instead of
  through it, and falls back to the straight spine only when no gradeable route exists
  within the detour budget. The grid is corridor-bounded and coarsened per edge so the
  search stays bounded on 16–32 km worlds; 8-connected with no cutting past a blocked
  cell, Douglas-Peucker simplified. The terrain version (survey hash) is part of the
  content key, so a re-baked terrain invalidates cached draped ribbons. Water, sea level,
  cart grade and detour are `RouteOptions` (data-driven), so a world's rules tune grades
  without code. `splineRoads` (the smooth spine, PR #326) stays for the gradeable case.

- **2026-10-19 — Road alignment is a content-addressed Catmull-Rom spline spine over the junction graph, owned by engine-core.**
  Settlement roads ship as mm junctions + edges (`roads.nodes`/`edges`); SG2b
  computes their horizontal alignment in `packages/engine-core/src/terrain/roads.ts`
  (not in the slab baker): `buildPaths` chains the graph into runs between degree-2
  junctions, `catmullRom` smooths each spine (tension 0 = uniform), `splineRoads`
  drapes the centerline and left/right rails onto a `heightAt(x,z)` surface, and
  `canonicalRoads` + `roadNetworkHash` reuse the repo's sha256 content-addressed
  cache-key pattern (`TerrainCache`/`heightsFingerprint`) so splines recompute only
  when geometry or render density changes. mm units are preserved and scaled at
  spawn like `Structure` nodes. Client rendering and wiring settlements into
  scenes is a separate follow-up, deliberately out of `world-bake.ts` to avoid
  conflicting with `feat/terrain-lazy-cache`.

- **2026-10-15 — The bake materializes the world; the tiles are a cache, and the survey is the only global pass (WX2).**
  `npm run bake:world` writes the whole world up front: 4 km is 103 MB, 16 km
  ~1.5 GB, 32 km ~6 GB, linear in area, and 80% of it is `terrain_tiles` — one
  float32 heightmap per 16 m chunk. The fix is not compression but
  *not baking what is derived*: the tiles are a cache, not a bake output.
  Three things already in the tree make this safe — `makeTileChunkSource`
  falls back to procgen when a tile is absent, so the server runs with no tiles;
  navmesh tiles are already version-keyed, content-addressed blobs; and
  `heightsFingerprint()` already hashes a heightfield. So: the survey is
  content-addressed by a hash of the spec and skipped when the spec is
  unchanged; tiles are keyed by `(seed, cx, cz, lod, terrainVersion,
  surveyHash)` in a `terrain_tile_keys` table; `bake:world` gains `--region
  rx,rz` and `--survey-only`; and the per-chunk tile loop — already independent
  per chunk — runs across worker threads. `regionsPerSide` already partitions
  the world square. What does NOT get cheaper is the survey: erosion is global
  and iterative, so a spec change re-runs it. The win is that the tiles no
  longer have to be rewritten for free — only the affected regions. Spec:
  `docs/INCREMENTAL-BAKE.md`.

- **2026-10-15 — Cell shading is a client-side component whose carrier is content, not a replicated ECS component.**
  Cell shading was hardcoded per renderer: the character kit patched its own
  material, and props, art-pack models and stand-in shapes each got an
  `applyToon` call sprinkled where they were built. "Enabling it should be as
  simple as adding a component" now holds: the client's `render/shading/`
  holds named shading components (`toon`, the cel look; `standard`, three's own
  PBR) and applies whichever one a *kind of thing* carries, and which kind
  carries what is content (`content/materials/materials.json` -> `shading`,
  validated in `packages/art`), so it is turned on and off from data and no
  renderer knows about it. Kinds are render paths, not entity classes:
  `model` (an art-pack or PICG model's own material), `placeholder` (a stand-in
  shape), `prefab` (a composed entity). Not a replicated component and not a
  wire field: the server has no business knowing how a surface is lit, and a
  per-entity flag would ride every snapshot to say something the client alone
  decides — the same reasoning that keeps the toon look itself in content. The
  cost is granularity: shading is per kind, not per entity, because the shared
  prop and atlas materials are what there is to patch (per-model shading would
  mean splitting those materials, and waits until something needs it).
  Modular characters are deliberately outside it: the character kit owns its
  own style and outlines, and folding it in changes a public interface for no
  behaviour change. `applyToon` also stopped assuming the material already has
  an `onBeforeCompile` patch, so a plain `MeshStandardMaterial` can be shaded.

- **2026-10-15 — Flat land is made by the terrain, not found by loosening the rules; a stranded flat is not a site.**
  Site selection (3 m of relief over the whole town footprint) found no site
  on the default world for 100, 300 or 600 people: erosion and the biome
  surface left the low ground as one rolling ramp. We could have relaxed
  `maxReliefM`, but the rule is the right one (a town on a slope is wrong), so
  the terrain changed instead: an opt-in `plains` pass (`plains.ts`) cuts the
  low ground into long flat treads between short risers (a strictly
  increasing remap, so water still runs downhill), adds river and shore flats
  and a few metres of rolling undulation, and fades out before the mountains,
  which stay exactly as the erosion pass shaped them. It is switchable and
  tunable in the world spec, off by default (old worlds bake byte-identically,
  checked against the previous commit), and on in the default world (re-bake).
  The second half is reachability: a flat ringed by cliffs is a stranded
  object, so `selectSites` rejects a candidate that is not walkable (steps up
  to `walkSlopeDeg`, water blocking) from the spawn, or the largest land. Not
  done, by choice: terraces follow contours, so the risers are wide arcs
  around the massif rather than walls; crazy placements (a keep on a crag)
  can come later with their own constraints.
- **2026-10-15 — New terrain relief passes are opt-in in the schema, on in the default world.**
  The new passes (`ranges.crest`, `erosion.incision`, `erosion.rockTalusDeg`,
  `volcano.gullies`) default to off, so any world file that does not name
  them bakes byte-identical heights to before (checked: the default world
  with the new keys removed hashes the same as the old code). The
  checked-in `default.world.json` turns them on, because it is what the
  user looked at: its mountains were rounded domes (a quartic cross-section
  with a flat crown; the ridge noise only scaled their height), the river
  cuts were capped near 24 m against ~300 m of relief, thermal erosion had
  one angle for soil and rock, and the volcano was left a perfectly smooth
  cone. The cost is that every baked default world must be re-baked and the
  settlement site selection moves with the new slopes and water. Incision is
  the implicit stream-power step (stable for any strength, no per-cell
  objects), re-routed every three passes.

- **2026-10-06 — Developer tooling mounts only in the editor's Play Mode
  (ROADMAP E5).** The player client no longer has a `devtools` mode or mounts
  the debugger panels. `npm run dev` starts the server and editor instead.
  The debugger's shared components remain available to the editor, which
  owns its panel layout, admin console, renderer controls and performance
  views. This closes the temporary dual-surface period without duplicating
  debugger code.
- **2026-10-04 — Codegen is a Node script with flatc vendored for Linux,
  Windows and macOS.** `npm start` failed on Windows at its first build:
  `scripts/codegen.sh` (run by `npm run codegen` and by the schema
  package's `prebuild`, so by every server and client start) needed bash,
  and the vendored flatc was a Linux binary. `scripts/codegen.mjs` does the
  same work in Node and picks `third_party/flatc/flatc`, `flatc.exe` or
  `flatc-macos`, all the official 25.12.19 release, so every platform
  writes the same bindings; a system flatc on PATH stays the fallback.
  Same reasoning as the 2026-09-27 node-gyp decision: a clone needs Node,
  Python and a C++ compiler, nothing Unix-only. `npm start` also
  reinstalls a pre-`npm start` install when the lockfile is newer than
  npm's record of it, instead of trusting it.

- **2026-10-04 — Players cross region borders with a one-time ticket, not
  a world-scoped session (WORLD-SERVER-SPEC slice B2).**
  - **How a player crosses.** The source region begins the migration, then
    sends the client `bye` with a redirect: the target's endpoint, the
    migration id and a 32-byte ticket. Only the ticket's SHA-256 goes into
    the migration record. The target checks the ticket against that hash
    before spawning the player, commits, and hands out its own session
    token. If the target refuses, the client goes back to the source with
    its old token, and the source still has the player.
  - **Why a ticket.** The spec's world-scoped tokens need the world server
    to issue and revoke sessions. That is a bigger change, and each region
    keeping its own sessions works for one hand-off at a time. A ticket
    can't be reused, and it never sits in the world's store or logs in a
    form anyone can present.
  - **What the hand-off doesn't carry yet.** Bags, parties and guilds stay
    in the region that made them until regions share persistence.

- **2026-10-04 — Plan on 16 regions per 4-core box; the world server is
  not the bottleneck (WORLD-SERVER-SPEC slice D).** The stress harness
  (`npm run stress:world`) runs one world process and N region processes.
  Each region is a real gateway at 30 Hz, with 500 entities and 100
  players crossing borders. With 16 regions every hand-off committed, at
  a p99 of 15 ms, while the world server used 15% of one core. At 24
  regions the region ticks overran a 30 Hz frame. So a box's region count
  is set by region CPU, about 4 regions per core. The world server should
  serve far more regions spread over several boxes. Hand-off payloads
  aren't a bottleneck, so the direct A→B transfer (slice B+) waits.
  Numbers: `docs/WORLD-STRESS-RESULTS.md`.
- **2026-10-01 — Items on the ground are ordinary entities; the item
  itself lives in the ItemService (roadmap M3a).** A ground item is a
  Transform and an AssetRef (its model; variant `GROUND_ITEM_VARIANT`,
  0xffff) plus a server-only `WorldItem` row, so it streams to clients
  like any prop, is drawn by the instanced props, and needed no
  FlatBuffers change. What it is (name, rank, colour) rides the JSON
  drops message (0x15) before the state that first shows it, like
  character names. Item instances and bags sit in preallocated columns
  in the ItemService, in memory until the item ledger (P2a): a restart
  clears ground items with nothing behind them, and chunk unloads leave
  ground items alone (they expire instead). Definitions are the baked
  loot pool joined with each item base's physics from
  `content/rules/items.json`; damage will read those columns, never
  objects. Ownership (30 s), despawn (5 min) and key-press pickup are
  the user's alpha decisions D2 and D3, in `content/rules/loot.json`.

- **2026-09-29 — The client is React all the way down: React Three Fiber
  for the 3D world (Joey's decision).** The HUD and menus stay React DOM;
  the world is a React Three Fiber `<Canvas>` in the same React tree, so
  UI and scene share state and components (nameplates, the character
  creator's preview, editor viewports, selection cards). React 19 and
  three 0.186 are the base (R3F 9 needs React 19; Spark needs three
  >= 0.180; postprocessing supports < 0.187). The existing renderers are
  wrapped, not rewritten: R3F owns the WebGL renderer, camera, resizing
  and frame loop; TerrainRenderer, WaterRenderer and EntityLayer stay
  plain three.js classes driven from one `useFrame`, created and disposed
  in the same effect (StrictMode-safe). Mirror state never goes through
  React state; it is read in the frame loop, and React re-renders only on
  prop changes. Canvas is `flat` (no tone mapping) so the picture matches
  plain three.js. New 3D UI is written as R3F components from the start.

- **2026-09-29 — Characters and social systems (Joey's decisions; spec:
  docs/CHARACTERS-AND-SOCIAL.md, docs/MASTERY-AND-COMBAT.md).** Classless
  mastery: characters improve at what they do by doing it. Skill belongs
  to the technique, not the item, so anything can be used as any kind of
  weapon and a master with a stick beats a novice with a sword; items
  keep physical properties (mass, edge, point, hardness) instead of damage
  numbers. Characters are made of body parts that take damage separately
  (harmed, maimed or dismembered by severity and kind of damage; the parts
  are the modular character's body pieces). Unused skills deteriorate
  slowly, with no hard cap. Characters respawn, as part of the lore.
  Every one of these rules is data plus hooks the game can change: the
  engine ships defaults, and our game is one rule set. Several characters per
  account, names unique world-wide. First social release: say/yell/whisper
  chat, parties, friends with presence, guilds. Characters, names, friends,
  blocks and guilds live on the world server; say and yell stay on the
  region; parties and presence are world-server memory. Clients still talk
  only to their region, which forwards social traffic over a new
  region-facing event stream. Characters are built before social.

- **2026-09-27 — Editor customization slice: standalone companion + public
  Rogue bridge (Joey's decision: all three surfaces).** The Rogue Engine
  Editor customization ships as three inspectors — read-only ECS inspector,
  local authoritative-server play mode, art asset pipeline — each with its
  own inspector view, in a standalone Vite+React companion app
  (`apps/editor/`), NOT as panels inside the Rogue editor.
  - **Rogue integration:** no stable public API exists for custom dockable
    editor panels, so depending on private editor internals would break on
    the next Rogue update. Instead: a project-local package
    `rogue-packages/sirhertzalot/mmo-editor/` uses only documented public
    surfaces (`RE.Component`, `RE.registerComponent`, `@RE.props.*`
    decorators, `SceneController.onPlay`/`onStop`, `App.sceneController`,
    `App.currentScene`, `RE.Model.fetch`/`instantiate`). The bridge
    component announces Rogue play/stop over a `BroadcastChannel`
    (`"mmo-editor-bridge"`) so the companion can reflect play state.
    Pinned to Rogue docs commit
    `cf383bd80623ff082aff2c4e95f92f043f26d983`; upgrade checklist in the
    package's `COMPATIBILITY.md`.
  - **ECS inspector is read-only by construction.** The view-model
    (`apps/editor/src/inspectors/ecs.ts`) exposes no mutation APIs and
    ships an explicit read-only notice: direct edits would bypass
    validation, ownership, event ordering, and the authoritative
    simulation. The editor inspects mirror state and sends existing
    intents; it never writes ECS state.
  - **Play mode owns exactly one local server.** The dev host
    (`apps/editor/src/host.ts`, dev-only) spawns `npm run server` as a
    detached process group and kills the group on stop — killing only
    the npm wrapper would orphan the real server. One-session random
    credentials are seeded BEFORE server start (the gateway's CSV store
    loads once at boot) under one explicit `MMO_DATA_DIR`; only the
    argon2id hash is persisted, plaintext is never logged. Pre-play
    editor state is restored after normal stop, launch failure, or
    cleanup failure.
  - **Art pipeline contract:** `@mmo-engine/art` (Zod manifest schema,
    path-traversal-safe scanner, manifest-backed Three.js provider with
    per-asset placeholder fallback + diagnostics). Folder convention:
    `assets/{manifest.json,models/,textures/}`. The game client now
    consumes the same package (DRY); placeholders remain until Joey
    supplies real art. An optional Node script imports a pack into a
    Rogue project's `Assets/Models/mmo/`.
  - Rationale: Joey's "all three" decision; DRY (one art contract, one
    mirror package), SOLID (injected server/client/debug-source seams),
    DOD (bulk/SoA preserved), EDA (gateway is a pure event translator;
    debug answers flow through the narrow injected `DebugSource`
    interface, never `instanceof` system-hunting in the gateway).
- **2026-09-27 — Protocol v3: read-only editor debug channel (0x0a).**
  `DebugQuery`/`DebugResponse` carry `tiles` (loaded navmesh tile bounds)
  and `waypoints` (per-entity path peek) for the editor's play-mode
  overlays. Authenticated/welcomed sessions only; malformed/unknown
  queries get 4003. Gateway refactor: the previous implementation read
  `PathState`/`WaypointStore` directly and found `NavigationSystem` via
  `instanceof` — now the gateway is a pure translator and all sim
  knowledge lives behind the injected read-only `DebugSource`
  (`makeDebugSource` composes it from SimWorld + NavigationSystem +
  loaded-tile bookkeeping in `server.ts`; tile bounds reflect actually
  loaded tiles, not every registry key). Rationale: debug tooling needs
  live answers the delta stream intentionally omits (waypoints never ride
  the wire), without weakening the gateway/sim boundary.
- **2026-09-27 — Shared `@mmo-engine/mirror` package.** The client's
  mirror (socket, state, interpolation) moved from `apps/client/src/mirror/`
  to `packages/mirror/` so the game client and the editor companion share
  one implementation (DRY). Both apps depend on it as a workspace package.

- **2026-09-27 — Auth slice (1.4-auth).** Real authentication replaces the
  dev-token stub (protocol bumped to v2):
  - **Account store:** CSV file (`./data/users.csv`, mode `0600`,
    gitignored) holding `username,passwordHash` — hashes only, never
    plaintext. Swappable `CredentialStore` interface; SQLite is the
    planned durable account store behind the same interface. No
    ScyllaDB/SurrealDB in this slice.
  - **Hashing:** argon2id via the `argon2` package. Unknown usernames
    verify against a fixed dummy hash so wrong-user and wrong-password
    failures take similar time and return the same generic 4002.
  - **Hello validation:** strict Zod schemas accept exactly one variant —
    credentials `{protocol, client, want_snapshot, username, password}` or
    token `{protocol, client, want_snapshot, token}`. Zod is input-shape
    validation only; it does not authenticate.
  - **Sessions:** in-memory `SessionManager`, opaque 256-bit tokens
    (`randomBytes(32)` hex), default TTL 24 h, lazy expiry on read plus
    periodic sweep. Sessions die with the process (accounts durable,
    sessions not). Token TTL (24 h) and player reconnect grace (30 s) are
    separate concepts: a valid token re-attaches the same entity inside
    grace, spawns fresh after grace, and an expired token forces a fresh
    credentials login.
  - **Rate limiting:** per-IP sliding window (default 5 failures / 60 s);
    success clears the record; exhaustion closes the connection with a
    generic "too many attempts" 4002.
  - **Provisioning:** no public self-registration endpoint. Accounts are
    created server-side via `npm run seed:user`
    (`MMO_DEV_PASSWORD='<password>'`), which never prints the password or
    hash. Never log credentials, hashes, or tokens.
  - Rationale: Joey's CSV-now decision with the minimal real-auth shape —
    argon2id + opaque tokens + rate limiting — behind swappable interfaces
    so the SQLite account store lands without touching the gateway.
- **2026-09-27 — Gateway reconnect semantics (slice 1.3).** The dev token
  doubles as the client identity: same-token reconnect inside the
  disconnect grace period (default 30 s, configurable) re-attaches the
  SAME player entity with a fresh welcome + snapshot; after the grace
  period the entity is despawned and the token spawns fresh. A token that
  connects while its session is live takes over (last connection wins,
  old socket superseded). Rationale: seamless brief-drop recovery with
  zero client-side state repair, and deterministic, testable session
  lifecycle before real auth exists.
- **2026-09-27 — Gateway is a pure event translator (slice 1.3).** All game
  logic lives in the sim; the gateway owns sockets, protocol, sessions,
  heartbeat, and queues, and translates: inbound intents → queued sim
  events, outbound state → per-tick broadcasts. Authority is enforced at
  the boundary (foreign-entity intents rejected 4003, stale intents
  dropped). Rationale: operating rule 1 / EDA — the sim never sees
  sessions, the gateway never touches components.
- **2026-09-27 — No interest management in Phase 1 (slice 1.3).** Every
  tick's delta is broadcast to every connected client; per-client queues
  and a resync flag exist for slow consumers. Rationale: keeps the
  multiplayer slice thin; interest filtering is the documented future
  scaling lever, not a day-one feature.
- **2026-09-27 — Fixed two slice-1.1 package entry bugs.** `protocol` and
  `engine-core` declared `main: dist/index.js`, but their tsconfigs emit
  `dist/src/*` + `dist/test/*`; corrected to `dist/src/index.js`. Also
  relaxed `WelcomeMessage.tick_hz` / `snapshot_every` from literal types
  to `number` (the values 30/300 remain the documented contract) so the
  gateway can configure the snapshot cadence.
- **2026-09-27 — Multiplayer from the start.** Phase 1 targets a
  multi-client authoritative server: the gateway serves N clients with
  per-client session state (last acked tick, per-client delta stream).
  Interest management stays out of Phase 1 (broadcast deltas); auth stays
  a dev-token stub in Phase 1.
- **2026-09-27 — Engineering constraints (standing).** All engine code:
  works (tested), documented, maintainable; DRY / SOLID / data-oriented
  design / event-driven architecture.
- **2026-09-27 — node-gyp over CMake.js** for our addon builds (npm-bundled,
  least to hold in the head); CMake quarantined to third-party library
  builds (e.g. Jolt) if a vendored lib demands it.
- **2026-09-27 — Persistence: hybrid.** Periodic full FlatBuffers snapshots
  (same bytes as the wire — DRY) every 300 ticks + on shutdown via
  better-sqlite3 (WAL); append-only `events` table created now, writer
  deferred.
- **2026-09-27 — First addon: procgen (FastNoise2).** Pure-function
  boundary (no native lifetimes) de-risks the N-API toolchain before Jolt;
  feeds the `Chunk` component directly. Full library evaluation (license,
  build, determinism) is Phase 2 work.
- **2026-09-27 — Tick model: 30 Hz fixed sim tick**, deltas per tick, full
  snapshot on connect + every 300 ticks; client interpolates between the
  two newest states.
- **2026-09-27 — Entity identity: u64 wire id** (high 32 bits generation,
  low 32 slot index), server-issued, generation bumped on slot reuse;
  `spawned`/`despawned` lists ride in snapshot/delta.
- **2026-09-27 — Serialization: FlatBuffers.** One `.fbs` schema generates
  C++ and JS (DRY); zero-copy reads; SoA wire framing (one entity-id-aligned
  array per component).
- **2026-09-27 — Seed component set (slice 1):** Transform, Velocity,
  PlayerIntent, Chunk, Health → ComponentId 0–4.
- **2026-09-27 — ECS world lives in JS (bitECS)** with C++ addons for the
  heavy systems. Physics/collision/pathfinding dominate tick time and stay
  in C++ either way, so the perf gap is single-digit percent on
  orchestration; JS wins iteration speed and debuggability. Validation
  benchmark (slice 1.5) captures real numbers; reopen if harness A exceeds
  50% of tick budget at 10k entities.
- **2026-09-27 — Authoritative Node.js server; C++ in-process via N-API**
  (node-addon-api); SQLite embedded; three.js mirror over WebSockets;
  one shared ECS data model (the critical contract).
- **2026-09-27 — Slice 1.4 persistence tuning.** `synchronous=NORMAL`
  under WAL (only the latest snapshot at risk on power loss; every save
  is a full snapshot so worst case is restoring the previous one) plus
  `wal_checkpoint(PASSIVE)` after each save (keeps WAL tiny, avoids the
  ~33-save autocheckpoint latency spike). Production persist path
  (`saveSnapshotBytes`, reusing gateway broadcast bytes) measures p95
  0.3 ms at 1,000 entities; the full `saveWorld` (collect+encode+persist)
  is for shutdown/tests only.
- **2026-09-27 — Intent queue drains before save.** `saveWorld` calls
  `sim.beginTick()` to materialize pending intents into PlayerIntent
  components; otherwise a reboot loses the last tick's intents and the
  simulation diverges from an uninterrupted run.
- **2026-09-27 — Single-world-per-process.** bitECS entity globals
  (cursor, recycled pools) are process-wide; `restoreFromState` requires
  dense eids from 0, which holds for one world per process (production
  and the reboot child-process test). In-process tests use the explicit
  `SimWorld.resetEntityCursorForTesting()` boundary between source and
  restored worlds — documented, never for production use.
- **2026-09-27 — O(1) live-entity count.** `SimWorld` maintains
  `liveCount` on spawn/despawn/restore (exact, unlike
  `maxSlot+1-freed.size` which breaks with a polluted cursor);
  `saveWorld` uses it instead of a Set scan.
- **2026-09-27 — Slice 1.6: FastNoise2 (+ FastSIMD) vendored, not fetched.**
  FastNoise2 needs its FastSIMD sibling (runtime SIMD dispatch compiled per
  ISA via CMake/CPM). Vendored both at pinned commits under
  `packages/addons/procgen/third_party/` (FastNoise2
  `06969a19`, FastSIMD `16450dae` — the exact commit FastNoise2's CPM pins;
  both MIT, verified against upstream LICENSE files). A gyp action runs
  `scripts/build-fastnoise.sh`, which uses FastSIMD's own supported
  `fastsimd_create_dispatch_library` (the same call FastNoise2's build makes)
  into one static archive — no reimplemented multi-ISA build, no network at
  install time. New toolchain requirement: `cmake >= 3.10` (+ C++17).
- **2026-09-27 — Procgen boundary is pure-function.** `generateChunk(seed,
  cx, cz, lod, out)` writes 16x16 heights into a caller-provided
  Float32Array (zero-copy); no native state escapes. Chunk data is never
  persisted — it regenerates deterministically from (seed, cx, cz, lod).
- **2026-09-27 — RELAXED floating-point kept (upstream default).**
  Determinism is bit-exact on one machine/binary (asserted in-process and
  across process restarts), but cross-machine bit-identity is NOT
  guaranteed under RELAXED when CPUs pick different SIMD feature sets.
  Phase 2: evaluate `FASTNOISE2_STRICT_FP=ON` if cross-machine bit-identity
  is required (re-measure perf).
- **2026-09-27 — Phase 2, slice 2.1: Recast/Detour navigation addon.**
  Vendored RecastNavigation at evaluated commit `9f4ce64458dfae86e1239c525ddc219c4e9e06f1`
  (zlib-style license, © 2009 Mikko Mononen) under
  `packages/addons/navigation/third_party/`; compiled directly as
  node-gyp sources (no CMake), so `npm install` builds offline.
- **2026-09-27 — NavService owns dtNavMesh + one dtNavMeshQuery per agent
  profile.** Tile loading identifies the agent profile; baked tiles are
  profile-specific. Bulk `loadTiles`/`unloadTiles`, SoA `findPaths` with
  caller-owned arenas, loud validation asserts (0 spans/contours/polys
  throw — bad winding never bakes silently).
- **2026-09-27 — Server bakes, at chunk-gen/load, never per tick.**
  Canonical bake pipeline (heightfield → compact → regions → contours →
  polymesh → detail → `dtCreateNavMeshData`) in the native addon; chunk
  mesh built from the same `ChunkDataSource` heightmap the world streams.
  `dtTileCache`/local avoidance for dynamic obstacles is future work.
- **2026-09-27 — Nav tiles are versioned deterministic build artifacts.**
  Content-addressed filesystem blobs (sha256 filename) + SQLite
  `navmesh_tiles` registry keyed by (worldSeed, chunkX, chunkZ,
  terrainVersion, agentProfile, bakeConfigHash). Never in world snapshots.
  Same inputs → byte-identical blob, asserted in-process and across 3
  fresh processes; no `frand()` use (the shim has no reference to it —
  the only randomness in the pipeline is the caller-supplied callback).
- **2026-09-27 — `PathState { status, waypoints }` as DOD layout.**
  `PathState` component holds flat status + slice descriptor
  (offset/count); waypoints live in the engine-side `WaypointStore` arena
  (fixed slot per entity id). Steering stays JS-side (future slice).
- **2026-09-27 — Phase 3: mirror client with placeholder visuals (Joey's
  choice).** `apps/client/`: React + shadcn-style + Tailwind shell (login,
  server URL, HUD), three.js canvas. The browser holds no game logic —
  it connects/authenticates, applies snapshot → deltas into a MirrorState,
  interpolates between the last two authoritative ticks (lerp + quaternion
  nlerp, alpha clamped, no extrapolation), and sends WASD/mouse-look
  intents upstream. No client prediction yet (architecture brief §5,
  open question 4 stays open).
- **2026-09-27 — Wire codec lives in @mmo-engine/protocol, shared by
  server and client (DRY).** Snapshot/Delta encode + decode moved out of
  engine-core into `packages/protocol/src/codec.ts` (plain
  `CollectedState` rows in, FlatBuffers bytes out — no bitECS dependency).
  engine-core re-exports them and owns collection/commit only. The mirror
  client builds fixtures and parses through the same codec; the schema
  (.fbs) remains the single source of truth.
- **2026-09-27 — Client terrain is a documented placeholder, not procgen
  heights.** The protocol carries `Chunk` metadata, not height samples,
  and the client cannot run the native FastNoise2 addon — so chunk meshes
  render as flat shaded planes (wireframe toggle in HUD). A server-served
  chunk-data channel (authoritative heights) is the follow-up; the
  `AssetProvider` interface (`apps/client/src/render/assets.ts`) is the
  seam it plugs into. Joey supplies real art later via
  `loadAssetPack()` without touching the render loop.
- **2026-09-27 — Production server entry `packages/engine-core/src/server.ts`
  (`npm run server`).** One Node process: SimWorld + Intent/Integrate
  systems + Jolt PhysicsSystem + Recast NavigationSystem, procgen chunk
  (0,0) spawned on fresh boot, navmesh tile baked at boot through the
  content-addressed NavmeshTileRegistry (reloaded from the stored blob,
  never re-baked), SQLite persistence (save every 300 ticks + shutdown
  hook), CSV auth at `<MMO_DATA_DIR>/users.csv`. Env: `MMO_PORT` (7777),
  `MMO_DATA_DIR` (./data), `MMO_WORLD_SEED` (1234), `MMO_CHUNK_SIZE` (16).
- **2026-09-27 — Wire protocol stays FlatBuffers; no protobuf/webrpc
  migration.** Joey raised protobufs + webrpc for the API layer; after
  review he confirmed keeping the current design unchanged. FlatBuffers
  remains the shared contract (single `.fbs` generates C++ and JS/TS
  bindings, zero-copy reads on the 30 Hz data plane); the control plane
  stays JSON + Zod. webrpc was not adopted (Go-server-first codegen does
  not fit the Node server).
- **2026-09-27 — Native builds: drop CMake/bash, compile everything directly
  in node-gyp.** The physics (Jolt) and procgen (FastNoise2+FastSIMD) addons
  previously shelled out to CMake via bash scripts during `npm install`,
  which broke on Windows (no bash, no cmake, no `ls`/`find` for the gyp
  shell expansions). All three native addons now compile their vendored
  sources directly as node-gyp `sources` with explicit file lists — the
  only requirement is a C++17 compiler, which node-gyp already locates.
  Jolt: 149 TUs extracted from its own Jolt.cmake (minus the Windows-only
  DX12 backend); baseline ISA (no JPH_USE_* defines) — correct everywhere,
  AVX2 opt-in documented in binding.gyp. FastSIMD: the multi-ISA dispatch
  is replicated as a single SSE2 dispatch TU (generated/
  FastSIMD_FastNoise_SSE2.cpp + config header) instead of CMake's
  per-ISA compilation; output is correct, runtime dispatch just finds no
  higher ISA. FastNoise2 needs C++ RTTI (dynamic_cast in Metadata), so
  procgen re-enables it (`cflags_cc!` / `GCC_ENABLE_CPP_RTTI` /
  `RuntimeTypeInfo`). Deleted: physics/cmake, procgen/cmake,
  scripts/build-jolt.sh, scripts/build-fastnoise.sh, and the `build:jolt`
  package script. Validated: full clean `npm install` + entire test suite
  green with the direct builds.
- **2026-09-27 — In-client account creation (protocol v4, 0x0b `register`).**
  Seeding users via the `seed:user` CLI (env-var password, per-workspace
  CWD) was too hostile for first-run, so the login screen gained a
  "Create account" mode. Wire: new `MessageType.Register = 0x0b` with a
  JSON control payload `{protocol, client, username, password}` (no `kind`
  field — the envelope type discriminates, like hello); protocol bumped
  v3 → v4. Server: `RegisterSchema` (Zod, strict, same username/password
  rules as the credentials hello), argon2id hash before the credential
  store sees it, then the *same* join path as hello via the extracted
  `Gateway.joinWithSession()` (welcome + snapshot + entity spawn) — no
  divergent join semantics. Registration attempts share the per-IP auth
  rate-limit budget; taken username → 4002 + close; the concurrent-
  register race (findUser → createUser TOCTOU) maps "already exists" to
  the same 4002. The endpoint is a dev convenience: `MMO_ALLOW_REGISTER=0`
  (default enabled) or the `allowRegister` gateway option disables it —
  must be disabled before any public deployment. MirrorClient gained a
  `register()` method sharing the socket/welcome handshake plumbing with
  `connect()` (`openAndHandshake`). `seed:user` stays for headless/CI
  provisioning.
- **2026-09-27 — Region/world split (spec: docs/WORLD-SERVER-SPEC.md).**
  Each engine instance becomes a region/shard owning its chunk range,
  30 Hz tick, entities, and clients; SQLite stays as the region-local
  store. Above them sits one world server: a small, durable,
  separately-deployable Express service with SurrealDB (server binary
  over ws://; in-memory store for dev/stress) as the system of record for the region registry, migration
  arbitration, accounts (moved from CSV in a later slice), and future
  global services. The core rule is transport-agnostic ingestion — the
  `WorldCore` interface knows nothing about transports; webrpc-over-HTTP
  (hand-authored to the webrpc JSON wire protocol with world.ridl as the
  contract source of truth; webrpc's Go SDK noted but not used) is
  the first adapter, with queue-consumer and embedded-stub adapters
  possible later without core changes. Every adapter sanitizes and
  validates at the edge (Zod strict, region API-key auth, per-region
  rate limits). The world server is never in the tick hot path; regions
  report asynchronously. Border handoff: origin region retains
  authority until the world marks the migration committed; world-scoped
  session tokens let clients reconnect across regions (also fixing
  sessions dying with the server process). Acceptance is a stress
  harness reporting how many regions one micro server holds before p99
  migration latency or tick jitter degrades.
- **2026-09-30 — uWebSockets.js serves the game port (ws stays as the
  fallback).** The gateway talks to a small `Transport` interface
  (`packages/engine-core/src/net/transport.ts`): a `WireSocket` per
  connection and transport-neutral HTTP requests, so webrpc and binary
  downloads share the port either way. uWebSockets.js (C++ event loop,
  HTTP parser and framing) is the default whenever its prebuilt binary
  loads; `ws` on node:http is the fallback and the reference. It is an
  optional dependency pinned to a release tag over git+https (the project
  isn't on npm); `MMO_TRANSPORT=uws|ws|auto` or the gateway's `transport`
  option picks. Measured with `npm run bench:transport` (30 Hz, 1.2 KB
  deltas out, 48 B intents in, transport alone): 25–35% less server CPU
  at 100–2000 clients and a faster median fan-out; at 2000 clients ws
  saturated a core and fell behind (57k of 60k messages/s) while uWS held
  at 69%. uWS writes to the kernel inside the send loop where ws defers,
  so its p99 loop time reads a little higher at 1000+; CPU is the fair
  measure. Constraints it brings: a closed uWS socket must never be
  touched (the adapter guards every call), message buffers are only valid
  inside the callback (the adapter copies), and a uWS listener can't
  rebind its own port in the same process after dropping live
  connections (a restarted process can).
- **2026-09-30 — DetourCrowd steers characters; the simulation stays the
  authority.** The navigation addon now compiles `DetourCrowd` (vendored
  since Phase 2) and exposes a crowd per service, agents keyed by wire id,
  bulk calls only (`crowdAdd/crowdTarget/crowdRemove/crowdStep`). The crowd
  is a steering service, not a movement authority: every `crowdStep` snaps
  agents to the simulation's positions, runs `dtCrowd::update`, and hands
  back each agent's move for the tick (steering plus the separation push
  dtCrowd applies to positions) as a velocity. Engine side, every
  character (Transform + Locomotion) is an agent, so the ones that steer
  keep clear of players and each other; characters with the server-only
  `NavAgent` component steer, and `CrowdSystem` (after brains, before
  IntentSystem) turns the crowd's velocity into `PlayerIntent`, so
  locomotion, swimming, grounding and combat treat them exactly like a
  player. Bots' wanderers walk this way (straight at the target where no
  navmesh is loaded; a new target when stuck, which the crowd leaves to
  its caller). `dtTileCache` (dynamic obstacles) is the next, separate
  change: it changes how tiles are baked and stored.
- **2026-09-30 — Navmesh tiles come from a tile cache; every static body
  is an obstacle.** The navigation addon compiles `DetourTileCache`. The
  server's service is made with a tile cache (0.25 m cells, so a 16 m
  chunk is exactly 64; one layer per tile, since a heightmap never
  overhangs; 8192 tiles x 512 polys to stay within 32-bit poly refs).
  Chunks are baked to heightfield layers from the chunk and its eight
  neighbours, which also ends the eroded seams between chunk tiles; the
  registry keeps them under a `:tc1` config key, so old whole-tile blobs
  are never loaded as layers (the first boot after this change re-bakes
  every tile once). `NavObstacleSystem` makes every static physics body
  (trees, rocks, walls: whatever ColliderSystem or an archetype gave a
  still collider) a cache obstacle, grown by the agent radius, turned by
  the body's yaw; it re-adds obstacles when their tile loads later (the
  cache only applies an obstacle to tiles present when it is added), and
  budgets adds (48) and tile rebuilds (4) per tick. So pathfinding and
  the crowd now go round props instead of through them. Moving bodies
  aren't obstacles yet (a pushable crate would need its obstacle moved).
- **2026-09-30 — meshoptimizer optimises cooked meshes and gives every
  prop a level-of-detail chain.** The PICG addon vendors meshoptimizer
  (v1.3, MIT) and exposes `optimizeMesh(pcgm, { lods, maxError })`: welds
  vertices, orders each material group's triangles for the vertex cache
  and overdraw and vertices for fetch, and simplifies each group (borders
  locked) to 50 / 25 / 10 % of its triangles within 5 % of the mesh's
  size. The asset library runs it on every cooked variant (about 1 ms a
  tree; vertex-shader runs per triangle 1.3 → 0.7) and the Pcg service
  serves each level at the mesh URL plus `/<level>`. Art-pack models are
  simplified in the client when they load, with meshoptimizer's
  WebAssembly build, since their files only exist on artists' machines;
  those levels share the model's vertex buffers. InstancedProps keeps one
  InstancedMesh per level and moves each prop to the level where its
  simplification error projects to at most 4 px (never nearer than 18 m
  per level), with 10 % hysteresis; one draw call per level in use.
- **2026-09-30 — The developer client measures what costs frames, in
  panels you arrange.** `npm run dev` runs the server and the client in
  Vite mode `devtools`; only then does the client show its developer
  panels (`npm run client` is the player's client and has none). The
  performance panel: a sparkline a measure for the last minute (fps,
  mean and worst frame time, draw calls and triangles a frame, the
  props' share, network in and out, JS heap), a bar of props by level of
  detail with the triangles LOD saves, and what the GPU holds
  (geometries, textures, shader programs). Draw calls and triangles are
  summed over every pass of a frame (`renderer.info.autoReset` off, reset
  by the frame loop), since the screen effects render several; the
  network rates come from byte counters on MirrorClient. Every panel
  (status, performance, tools, controls) can be dragged, resized, faded,
  folded or closed, and ` hides them all; the layout is per browser
  (localStorage). This is interim: the panels move to the editor's play
  mode with its game view (ROADMAP E4, E5).
- **2026-09-30 — The client is for players; developer tools live in the
  editor.** The game client shows the world and the player's interface
  (resource bars, chat, parties, quests, inventory, character sheet,
  settings) and nothing else. Every developer tool, including the
  runtime debugger (performance graphs, draw calls and triangles, LOD
  views, network traffic, wireframe, effect showcases), lives in the
  editor, where play mode gains an embedded game view to host it. The
  debug overlays still in the client move there and are removed. The
  work is tracked in `docs/ROADMAP.md`, which every PR updates.
- **2026-09-30 — Dungeon shells are carved with manifold and Clipper2, and
  prebaked.** A new addon, `@mmo-engine/addon-geometry`, vendors manifold
  (v3.5.4, Apache-2.0) and Clipper2 (2.0.1, BSL-1.0), manifold using
  Clipper2 for its 2D cross-sections, built by node-gyp without TBB. It
  exposes cell outlines, polygon Booleans and offsets, and one-call CSG
  trees whose leaves' tags follow their faces through the Booleans.
  PICG's own Blender-style Booleans stay as they are (they cook graphs
  well); the engine's gap was dungeon geometry. `dungeonShell` merges
  the walkable cells into polygons, extrudes them (corridors 4 m, rooms
  5 / 6 / 8 m by size, basins 1.2 m deep), subtracts them from a block of
  rock and keeps the closed inside surface, tagged floor, wall, ceiling
  or basin. `dungeon:bake` writes it next to each layout as PCGM (a new
  `encodePcgMesh` in `@mmo-engine/picg`), so an instance, a sandbox
  apart from the world that players are moved into and whose results go
  back through its region to the world server, loads its geometry as one
  buffer. A cell is 2 m.
- **2026-09-30 — Valgrind checks the addons and measures the engine.**
  `npm run valgrind:memcheck` runs every native addon's tests under
  memcheck, in the valgrind process itself (`node --test` otherwise runs
  them in children valgrind doesn't follow), and fails only on errors
  and definite leaks whose faulting frame is in our binaries: Node's and
  V8's own reports (the garbage collector) are left out rather than kept
  in a suppression list. Its first run found two real bugs in the
  navigation addon: every tile bake leaked its detail mesh
  (`rcPolyMeshDetail` has no destructor; now freed), and Recast's tile
  cache overflowed a region's 16-entry neighbour list when obstacles cut
  a tile into many regions (patched in the vendored source, see its
  VENDORING.md). `npm run valgrind:perf` measures instructions per
  operation for headless workloads with callgrind, between marks a small
  addon sets from JS (`addon-perf-probe`, callgrind client requests), with
  Node single-threaded so counts don't depend on scheduling; the counts
  are committed as a baseline (`perf/callgrind-baseline.json`) that
  changes, the gateway split first, are measured against.
- **2026-10-26 — Universal Procedural Multi-Rig Engine, Bone Ontology & Creature Catalog.**
  The animation pipeline was constrained by quadruped-only segmentation and hardcoded humanoid sword attacks.
  We established:
  1. Canonical Bone Ontology (`CANONICAL_BONE_ONTOLOGY`) with complete finger chains, creature appendages, wings, and tails, supporting preset mappings for Mixamo, Synty, Rigify, Mannequin, Kevin Iglesias, and CMU, plus automated preset detection and synonym resolution (`resolveBoneMapping`).
  2. Protocol & Animation expansion: 10 creature natural attacks (`Move.Bite`, `Move.Claw`, `Move.Pounce`, `Move.Roar`, `Move.Breath`, `Move.TailWhip`, `Move.Stomp`, `Move.WingBuffet`, `Move.Sting`, `Move.Cleave`), locomotion clips (`Trot`, `Gallop`, `Fly`), and creature behaviors (`Graze`, `Sleep`, `Threaten`, `DeathFall`).
  3. Dynamic Weapon-to-Move Resolution in `CombatSystem`: Attacks resolve combat moves dynamically from the attacker's weapon/natural base (`family: "bite" -> Move.Bite`, `"claw" -> Move.Claw`, `"tusk" / "horn" -> Move.Pounce`, etc.) rather than forcing `Move.SwordA`.
  4. Universal Multi-Rig Classification & Segmentation (`apps/client/src/render/animal/`): Added `segmentAvian`, `segmentSerpentine`, `segmentAquatic`, `segmentArachnid`, and `segmentFlora`, driven by geometric proportions and name patterns, while preserving `segmentQuadruped` backwards compatibility.
  5. Multi-Rig Motion Solvers in `gait.ts`: Harmonic wing flapping and gliding, sinusoidal serpentine travelling waves, aquatic caudal/pectoral fin undulation, arachnid alternating tripod scurrying, and flora wind sway, updating scratch buffers with zero allocation in tick loops.
  6. Comprehensive Creature & Loot Catalog: Complete rules for all 19 species in `content/rules/creatures.json`, monster loot tables in `content/rules/loot.json`, and model mapping catalog in `content/wildlife/flora-fauna-models.json`.
