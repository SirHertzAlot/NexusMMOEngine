# Decision Log

Every entry: date, decision, rationale. Newest first.

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
