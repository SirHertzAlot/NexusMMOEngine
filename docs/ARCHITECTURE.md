# Architecture

How the engine is put together, one tick at a time. If you want to run it
first, read [GETTING-STARTED.md](GETTING-STARTED.md); if you want the
reasoning behind a choice, read [DECISIONS.md](DECISIONS.md). This document
describes what exists now.

## The shape of the thing

One Node.js process is the authority. It simulates the world at a fixed rate,
persists it, and streams it to clients. Clients are mirrors: they render what
the server sends and send back what the player pressed. **No game logic runs
in the browser** — that is the load-bearing rule of the whole design.

```
                        ┌──────────────────────────────────────────┐
   browser              │            Node.js process               │
 ┌──────────┐           │                                          │
 │  client  │  intents  │  Gateway ──► intent queue                │
 │ (mirror) │ ────────► │      │                                   │
 │ three.js │           │      │        TickLoop @ 30 Hz          │
 │ + React  │ ◄──────── │      │   ┌──────────────────────────┐   │
 └──────────┘ snapshots │      └──►│ systems (see below)      │   │
              + deltas  │          │  └─ SimWorld (bitECS)    │   │
                        │          └──────────────────────────┘   │
                        │                    │                     │
                        │        ┌───────────┼───────────┐         │
                        │        ▼           ▼           ▼         │
                        │   snapshot/    persistence  native addons│
                        │   delta codec  (SQLite +    (Jolt, Recast,│
                        │                 SurrealDB)   FastNoise2,  │
                        │                              PICG, scatter)│
                        └──────────────────────────────────────────┘
                                          │
                                          ▼  (optional)
                              world server (region registry)
```

Heavy or numerics-bound work lives in C++ N-API addons compiled into the same
process — no IPC, no serialisation at the boundary beyond plain typed arrays:

| Addon | Does |
|---|---|
| `addon-physics` | Jolt: rigid bodies, terrain height fields |
| `addon-navigation` | Recast/Detour: navmesh baking and pathfinding |
| `addon-procgen` | FastNoise2: deterministic terrain heightfields |
| `addon-picg` | PCG: cooks `.pcg` node graphs into procedural meshes |
| `addon-scatter` | the scatter lattice (bit-identical to the JS reference) |
| `addon-integrate` | benchmark kernel (particle integration) |
| `addon-template` | the addon skeleton, and a toolchain smoke test |

## Locked decisions

These are recorded in [DECISIONS.md](DECISIONS.md) and are not open for
casual revision:

- **JS world (bitECS) with C++ systems** for physics, collision, pathfinding
  and procgen. The benchmark ran the same C++ kernel over a bitECS world and
  a pure C++ world: even at 10k entities, bitECS is faster at 100k, both under
  1% of the tick. See [OPEN-WORLD-PLAN.md](OPEN-WORLD-PLAN.md).
- **SQLite embedded in the Node process** for region state; **SurrealDB
  embedded** for the world-level chunk catalog.
- **FlatBuffers** is the C++ ↔ JS contract, owned by
  `packages/schema/mmo_engine.fbs`.
- **30 Hz fixed sim tick.**
- **Multiplayer from the start** — nothing assumes a single player.

## Packages and layering

Dependencies point downward; nothing here imports a browser app.

```
packages/schema      mmo_engine.fbs — the single source of truth for the wire
                     contract. Generates C++ and TypeScript (gitignored).
packages/protocol    WS envelope + message catalog (TypeScript).
packages/mirror      the mirror client: connect, fold snapshots/deltas,
                     interpolate. Shared by the game client and the editor.
packages/rules       game rules as data: loader, schemas, hook registry.
packages/art         the art contract: manifest, scanner, GLB conversion,
                     character catalogs, retargeting.
packages/scatter     the scatter plan language and its JS reference impl.
packages/picg        PCG graph handling: linked subgraphs, parameters, mesh
                     decode, the asset library index.
packages/wfc         Wave Function Collapse over an arbitrary graph.
packages/placement   formation placement (WFC decides what, this decides where).
packages/dungeon     procedural dungeon layout and bake, plus baked geometry.
packages/species     species ecology and spawn tables.
packages/compose     ranks, prefabs, loot pools at bake time.
packages/crafting    materials, recipes, tradability.
packages/engine-core the authoritative server: tick loop, world, net, persist.
packages/world-server the region registry (world-level service).
packages/channel     the edge↔core internal channel (framed TCP).
packages/nethealth   network metrics helpers shared by edge and core.
packages/bench       the tick-budget benchmark harness.
packages/addons/*    the C++ N-API addons.
apps/client          the player-facing browser game client (React 19 + React
                     Three Fiber).
apps/editor          the standalone editor companion.
apps/edge            the edge process: client WebSocket + packet router
                     (edge/core split).
```

`engine-core`'s build script spells this order out rather than relying on the
workspace graph: `schema → protocol → art → world-server → scatter → picg →
rules → wfc`, then `tsc`. The game client and the editor depend on
`@mmo-engine/mirror` and `protocol` — **never on `engine-core`**.

## Game rules are data

Skills, disciplines, combat, body parts, death and appearance are not code.
They live in `content/rules/*.json`, validated at boot by `@mmo-engine/rules`
(Zod schemas, engine defaults, a loader, and a hook registry). A missing file
means "use the engine defaults"; a malformed one **stops the server before the
world loads**, naming every problem by file and field:

```
[server] invalid rules:
  content/rules/body.json: parts.3.share: expected number, received string
```

Every object is a strict schema, so a misspelt key is an error rather than a
silently ignored setting. `loadGameRules` cross-checks the files against each
other (a discipline requiring a skill that does not exist, a body tree with
two roots, shares that do not sum to 1, an appearance slot naming a missing
part) and reports all of them at once.

`packages/rules` also exports the *hook registry* — `computeDamage`,
`resolveLanding`, `skillGain`, `onInjury`, `onDeath`, `onRespawn` — where each
hook has a default implementation derived from the rules and a game may
override it as `(input, base) => …`. Be aware of the current wiring: on `main`
the hooks are constructed at boot and then only the one-line summary is used,
so the mechanics behind them are **specified and tested but not yet driven by
the simulation**. [MASTERY-AND-COMBAT.md](MASTERY-AND-COMBAT.md) is the
design; [content/rules/README.md](../content/rules/README.md) documents the
files.

## The tick

`TickLoop` (packages/engine-core/src/tick-loop.ts) is a fixed-timestep
accumulator. It converts variable real-time frame deltas into a whole number
of fixed steps, so a given tick count always produces the same simulation
regardless of wall-clock jitter.

```ts
export const STEP_MS = 1000 / 30;      // 33.333... ms per tick
export const MAX_STEPS_PER_FRAME = 5;  // spiral-of-death guard
export const MAX_FRAME_DELTA_MS = 250; // clamp pathological frame gaps
```

A frame delta is clamped, and at most five catch-up steps run per frame. Any
backlog past that is **dropped and counted** (`spiralEvents`, `droppedMs`)
rather than freezing the process in unbounded catch-up. Ticks are therefore
sequential and never skipped silently.

### System order

Systems sit behind one narrow interface — `name` plus
`step(world, dt)` — and never call each other. They communicate through
component data and the world's intent queue. The order is declared in
`server.ts`:

```ts
systems: [
  streamer,                    // 1. load/unload chunks around players
  ...bots,                     // 2. bot intent (same systems as players)
  new IntentSystem(),          // 3. wish-move -> Velocity
  new CombatSystem(),          // 4. attack/guard/dodge phases
  new IntegrateSystem(),       // 5. semi-implicit Euler
  character,                   // 6. gravity, jump, grounding, swim, fly
  physics,                     // 7. Jolt: sync -> step -> copy results
  navigation,                  // 8. Recast/Detour pathfinding
]
```

Order is load-bearing:

- **The streamer runs first** so chunks it loads this tick appear in this
  tick's delta, and physics picks up their colliders in the same tick.
- **`CharacterSystem` runs after integration** so the kinematic character
  correction (gravity, grounding) lands in the same tick, before state is
  collected for the snapshot.
- **`IntegrateSystem` skips entities carrying `BodyConfig`.** Those belong to
  `PhysicsSystem`; double-stepping them would be a bug, so the split is
  explicit.

Bots are not a special case: a `BotSystem` produces intents and the bot
entities then flow through `IntentSystem`, `IntegrateSystem` and the rest
exactly as players do.

## Components

bitECS 0.3.40 stores components as struct-of-arrays: every field is a typed
array indexed by entity id, and systems walk flat arrays. There is no
per-entity allocation on the hot path.

| Id | Component | Holds |
|---|---|---|
| 0 | `Transform` | position (`px/py/pz`), rotation quaternion (`qx..qw`), scale (`sx..sz`) |
| 1 | `Velocity` | linear (`lx/ly/lz`), angular (`ax/ay/az`) |
| 2 | `PlayerIntent` | wish-move (`mx/my/mz`), look yaw/pitch, jump, buttons |
| 3 | `Chunk` | u64 `chunk_id` and seed split into hi/lo u32 pairs, `lod` |
| 4 | `Health` | current / max |
| 5 | `BodyConfig` | rigid-body description for Jolt: shape, mass, motion type, layer, friction, restitution |
| 6 | `PathRequest` | a pathfinding request |
| 7 | `PathState` | flat status + slice descriptor |
| 8 | `AssetRef` | `assetHash` (u32) + `variant` (u16) |
| 9 | `Locomotion` | swim/fly/walk state |
| 10 | `Appearance` | character look |
| 11 | `Action` | the current combat action/phase |

Field names mirror the FlatBuffers schema so the mapping between SoA rows and
wire tables is mechanical. Two details worth knowing:

- **`Chunk`'s u64 is split into hi/lo u32.** bitECS has no u64 store, and f64
  would lose precision above 2⁵³.
- **`COMPONENT_IDS` is currently documentation, not wire format.** The
  snapshot and delta framing carries one block per component, so ids are not
  on the wire yet.

## Entity identity

Wire ids are u64 and server-issued; a client never mints one.

```
wire id = (generation << 32) | slot
```

The bitECS eid doubles as the slot index. **The generation bumps every time a
slot is reused**, so a client cannot confuse a new entity with a despawned one
— the ABA guard. `SimWorld` sets bitECS's recycle threshold to `0` for eager
slot reuse, because a long-lived authority wants a bounded eid space. That is
process-global bitECS configuration and is safe only because one process runs
exactly one world.

Per-tick change lists (spawned and despawned wire ids) accumulate between
delta builds; `endTick()` is called after the delta is built and the tracker
committed.

## Replication

FlatBuffers framing in `packages/schema/mmo_engine.fbs`, codecs in
`snapshot.ts`.

**Snapshot** (0x03): `tick` plus one entity-ID-aligned block per component.
Each block is parallel `entity_ids[]` and `entries[]` arrays. This is the
full state, sent on join and on resync.

**Delta** (0x04): `tick`, `base_tick`, `spawned[]`, `despawned[]`, plus the
same blocks carrying **only changed or spawned entities**. `DeltaTracker`
keeps a Float64 copy of every tracked field, diffs against it each tick, and
commits the new baseline after the delta is built.

The invariant the design is built around, and which the test suite asserts
directly: **applying the delta chain to a snapshot reproduces the next state
exactly.** The headless `npm run sim` proves it from disk by replaying 300
deltas onto snapshot 0 and comparing to snapshot 300 field by field.

Entities spawned this tick are always included in full — their baseline is
empty by construction.

Terrain heights ride a separate channel: the gateway attaches authoritative
16×16 heights to chunk rows on network snapshots and deltas. The persistence
path never sees them, because `SnapshotStore` collects separately.

## Networking and sessions

`packages/protocol` defines the envelope and the message catalog:

| Id | Message | Direction |
|---|---|---|
| `0x01` | Hello | client → server |
| `0x02` | Welcome | server → client |
| `0x03` | Snapshot | server → client |
| `0x04` | Delta | server → client |
| `0x05` | Intent | client → server |
| `0x06` / `0x07` | Ping / Pong | both |
| `0x08` | Error | server → client |
| `0x09` | Bye | both |
| `0x0a` | Debug | client → server (editor tooling) |
| `0x0b` | Register | client → server |
| `0x0c` | Account | server → client |
| `0x0d` | CreateCharacter | client → server |
| `0x0e` | EnterWorld | client → server |

`MESSAGE-CATALOG.md` has the payloads; the envelope and precise fields are in
the `.fbs`.

Session lifecycle:

1. The client connects and sends `hello` — either credentials (username and
   password) or a session token for a reconnect.
2. The gateway validates and answers `welcome`, which carries the tick, the
   spawn point, the world map for the far horizon, the day clock, and a
   session token.
3. The gateway sends a full `snapshot`, then one `delta` per tick.
4. `ping`/`pong` keep the connection honest; a client that misses enough
   heartbeats is dropped and swept.
5. On a token reconnect inside the grace period the same player entity is
   re-attached; after it expires, a fresh entity is spawned.

A full snapshot is also broadcast to **everyone** every 300 ticks
(`snapshotEveryTicks`), and to a single session on demand. A session whose
outbound queue grows past `MAX_QUEUED_DELTAS` (300 deltas, 10 s at 30 Hz)
drops the backlog and sets `needsResync`, so the next tick sends it a full
snapshot instead of replaying deltas. **There is no client-to-server delta
acknowledgement and no `base_tick` validation** — `lastAckedTick` is set on
send and delivery is implicitly acked by the next delta. That is a
simplification worth knowing before building on the delta stream.

The gateway is deliberately thin — a pure event translator. Inbound `intent`
messages become sim events drained at tick start, and the sim's state changes
are batched into per-tick deltas the gateway fans out. No game logic lives in
the gateway. It also owns an HTTP surface on the same port for the PCG asset
service (`/rpc/Pcg`), authenticated by the same session tokens.

**Phase 1 broadcasts the same delta stream to every client**; interest
management is explicitly deferred until load demands it.

## Persistence

Everything a server writes lives in its `MMO_DATA_DIR` (default `./data`,
which resolves inside `packages/engine-core` when run through the npm
scripts). All of it is gitignored.

| Path | Holds |
|---|---|
| `world.db` | SQLite: world snapshots, terrain tiles, the climate/biome survey maps, unloaded chunk contents, world metadata |
| `navmesh/` | the navmesh tile cache: content-addressed blobs (`sha256` names) and `navmesh.db` |
| `characters.db` | SQLite: each account's characters (name and look) |
| `users.csv` | accounts: username and argon2id hash, written mode `0600` |
| `surreal/` | the embedded SurrealDB chunk catalog (region, biome, height range, river) |

Snapshots are written every 300 ticks and on shutdown, keeping the newest 6,
and the heavy work runs off the tick thread through a checkpoint worker so
SQLite can rewind the WAL without stalling the sim. `events` exists in the
schema but is never written. Several `store.ts` comments claim persistence
reuses the broadcast snapshot bytes; on `main` it does not — the gateway and
`SnapshotStore` encode independently.

**Sessions are in memory only.** A restart logs everyone out; accounts,
characters and the world survive. On boot the server restores the latest
snapshot and resumes ticking from `restoredTick + 1`.

## Streaming

`ChunkStreamer` is the first system of every tick. Chunks within
`MMO_STREAM_RADIUS` (8, so a 17×17 ring) of any player load nearest-first
inside a per-tick time budget; chunks beyond the unload radius unload. The
3×3 spawn area is pinned and always loaded.

- **Scatter is placed once and then persisted.** When a chunk unloads, its
  entities are written to their row in `world.db` before any despawn (an
  emptied chunk gets an empty row), and come back from it. Only a chunk that
  has never unloaded is scattered. After a restart, chunks in the snapshot are
  adopted and their stale rows ignored — this is what stops duplication.
- **Navmesh tiles follow chunks**, baked on a worker thread on first visit
  and cached in the registry afterwards. Cliff chunks with no walkable surface
  have no tile.
- **Physics colliders follow chunks**: a static Jolt height field per loaded
  chunk, so bodies rest on the surface characters walk on and clients render.
- **An entity budget** stops loading at 90,000 live entities (bitECS holds
  100,000) and warns, rather than failing mid-tick.

## Determinism

Determinism is a design property, not an accident, and the test suite pins it:

- **Terrain is a pure function of the global sample.** Chunk seams are exact
  by construction, and tests assert that *every* chunk meets its neighbours
  and that adjacent chunks share border samples bit-for-bit — in JS and in
  the native addon.
- **The scatter lattice has golden vectors** that lock the cross-language
  contract between the JS reference and the C++ addon.
- **The physics and navigation addons are fingerprinted** across three fresh
  processes.
- **Codegen is reproducible**: CI regenerates the FlatBuffers bindings twice
  and diffs them.
- **The replication invariant** (delta chain reproduces state exactly) is
  asserted every run.

Within one machine, the same seed and the same spec produce the same bytes.
The world bake only needs to be reproducible on one platform, not identical
across platforms; cross-machine floating-point bit-identity is not currently
claimed.

## Time of day

The server owns a world clock: `MMO_DAY_SECONDS` real seconds per game day
and `MMO_DAY_OFFSET` for the starting time. The clock rides the `welcome`, so
every client shares it, and the client derives sun position, sky, water
reflections and weather from it.

## The optional world server

`packages/world-server` is a separate service and an HTTP/webrpc region
registry. A game server becomes a *region* of a larger world when `WORLD_URL`
is set: it registers, heartbeats, and reports snapshots. **All of that runs
off the tick loop**, because a slow or absent world server must never stall
the simulation. Without `WORLD_URL` the game server runs standalone, which is
the normal development setup. See [WORLD-SERVER-SPEC.md](WORLD-SERVER-SPEC.md).

## Where to look next

| I want to understand… | Read |
|---|---|
| the wire protocol in detail | [MESSAGE-CATALOG.md](MESSAGE-CATALOG.md), `packages/schema/mmo_engine.fbs` |
| movement, combat, bots | [GAMEPLAY.md](GAMEPLAY.md) |
| terrain, biomes, scenery | [WORLD-BUILDING.md](WORLD-BUILDING.md) |
| the art packs and conversion | [ART-PIPELINE.md](ART-PIPELINE.md) |
| the areas and dungeons | [PCG-SPEC.md](PCG-SPEC.md), [DUNGEONS-AND-LOOT.md](DUNGEONS-AND-LOOT.md) |
| why any of this was chosen | [DECISIONS.md](DECISIONS.md) |
| what is planned | [OPEN-WORLD-PLAN.md](OPEN-WORLD-PLAN.md), [MASTERY-AND-COMBAT.md](MASTERY-AND-COMBAT.md), [CHARACTERS-AND-SOCIAL.md](CHARACTERS-AND-SOCIAL.md) |
