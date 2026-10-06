# @mmo-engine/client — three.js mirror client (Phase 3)

Browser client for the MMO engine. **The browser holds no game logic**:
it mirrors authoritative ECS output (snapshot → deltas, interpolated)
and sends player intents upstream. The server simulates; the client
renders. See `docs/MESSAGE-CATALOG.md` for the wire protocol and
`~/workspace/skills/mmo-engine/SKILL.md` operating rule 1.

## Run

```sh
# 1. one-time: create a login (password via env only — never CLI args)
cd ~/workspace/mmo-engine/repo
MMO_DEV_PASSWORD=<redacted> npm run seed:user --workspace=@mmo-engine/engine-core -- joey

# 2. start the authoritative server (ws://localhost:7777)
npm run server --workspace=@mmo-engine/engine-core

# 3. start the client (http://localhost:5173): the player's client ...
npm run client
#    ... or, from the repo root, the server and editor together
#    (instead of steps 2 and 3)
npm run dev

# optional, one-time: textured ground (CC0, ~23 MB, git-ignored)
npm run surfaces:fetch
```

Log in with the seeded credentials. The player's client shows the world
and a settings menu (graphics quality, controls, audio, UI scale, leave
the world). The editor's Play Mode is the developer surface: it owns the
server it launches and hosts the debugger panels, performance graphs,
admin console, wireframe terrain, and FX showcase.

## Layout

```
src/
  mirror/        protocol driver — no game logic, no DOM
    client.ts    MirrorClient: hello→welcome→snapshot→deltas, intents up
    state.ts     MirrorState: snapshot replace / delta fold (in place)
    interpolate.ts  tick interpolation (lerp + nlerp, no extrapolation)
    socket.ts    SocketLike (browser WebSocket adapter; fake in tests)
  input/
    input.ts     WASD/mouse-look → PlayerIntent fields (DOM-free, tested)
  render/
    world-canvas.tsx  React Three Fiber <Canvas>: renderer, camera, lights,
                 fog, and the frame loop that drives the pieces below
    entity-layer.ts  lazy meshes per wire id, batched scenery, FX (plain three.js)
    toon/        toon shading for characters and creatures (cel bands with
                 day/night ramps, light maps, SDF face shadows, rim light)
                 and inverted-hull outlines; on by default in CharacterKit
    effects/     screen effects: underwater, the Gran Turismo tone curve
    quality.ts   quality presets (low/medium/high/ultra) from the GPU's tier
                 (@pmndrs/detect-gpu, benchmark data served by this app)
                 and the frame-rate governor (drei PerformanceMonitor)
    bvh.ts       BVH raycasting (three-mesh-bvh) for hover picking
    vfx/         three.quarks effects: the entity composer's particles and
                 auras, weapon trails
    sky/physical-sky.ts  high presets' sky: precomputed atmospheric
                 scattering and aerial perspective (@takram/three-atmosphere)
    follow-camera.ts  third-person camera rig (mouse look + wheel distance)
    assets.ts    AssetProvider — THE seam for Joey's future art pipeline
    perf-stats.ts  once-a-second performance samples for the editor's
                 debugger (frame time, draw calls, triangles over every
                 pass, GPU memory, props by level of detail, network
                 rates, heap), a minute kept
  ui/
    components.tsx shadcn-style Button/Input/Card/Label (no CLI scaffold)
    debug.ts       shared debugger exports, mounted only by the editor
    dev-panels.tsx dockable debugger panel shell; the editor owns its layout
    perf-hud.tsx   performance panel: a sparkline per measure with one
                 crosshair across all of them, and the props' LOD split
  App.tsx        login screen + world screen (WorldCanvas) + the player's
                 settings menu (ui/settings-menu.tsx)
```

## Tests

```sh
npm test --workspace=@mmo-engine/client   # tsc build + node --test
```

- `test/mirror-state.test.ts` — snapshot replace, delta upsert/despawn
- `test/interpolate.test.ts` — alpha 0/0.5/1, clamping, quaternion nlerp
- `test/mirror-client.test.ts` — hello variants, welcome, snapshot/delta
  folding, ping→pong, intent encoding, error/close (fake socket)
- `test/input.test.ts` — WASD vector math, yaw rotation, normalization
- `test/entity-layer.test.ts` — mirror state to meshes, batching, chunks,
  despawn, hover, and the follow camera
- `test/graphics.test.ts` — quality presets and governor steps, BVH hits
  matching three's raycast, the quarks effects, the physical sky's frame
- `test/toon.test.ts` — the toon patch and its variants, the ramp, the
  day/night fade, outline normals and skinning, the tone curve

## Placeholder visuals (Joey's Phase 3 choice)

- Entities: box or sphere per authoritative `BodyConfig.shapeKind`,
  colored deterministically from the wire id; the local player is
  highlighted.
- Terrain: flat shaded plane per `Chunk` entity — **not authoritative
  heights**. The client cannot run the native FastNoise2 addon, and the
  protocol carries chunk metadata, not height samples. A chunk-data
  channel (server-served heights) is the follow-up; `AssetProvider`
  is already the seam it plugs into.
- `PlaceholderAssets.loadAssetPack()` is a stub — Joey's real art pack
  (glTF/texture manifest) lands there without touching the render loop.

## No client prediction (yet)

Motion renders one tick interval behind the server, interpolated between
the last two authoritative ticks. Prediction/rollback is a later slice
(architecture brief §5, open question 4).
