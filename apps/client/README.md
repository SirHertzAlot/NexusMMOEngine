# @mmo-engine/client — the browser client

The player-facing client: a React 19 app whose 3D world is a React Three Fiber
canvas over three.js 0.186.

**The browser holds no game logic.** It mirrors authoritative ECS output
(snapshot → deltas, interpolated) and sends player intents upstream. The
server simulates; the client renders. See
[MESSAGE-CATALOG.md](../../docs/MESSAGE-CATALOG.md) for the wire protocol and
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the tick.

## Run

From the repository root:

```bash
# 1. the authoritative server (ws://localhost:7777)
npm run server

# 2. the client dev server (http://localhost:5173)
npm run client

# optional, one-time: textured ground (CC0, ~23 MB, git-ignored)
npm run surfaces:fetch
```

Create an account in the client (or seed one headlessly — see the
[root README](../../README.md#quick-start)), then log in. Session tokens live
in memory only; the **reconnect** button re-hellos with the stored token.

The character creator is reachable with no server at all, which is the fast
loop for working on looks:

```
http://localhost:5173/?preview=character
```

## Layout

```
src/
  main.tsx, App.tsx     login screen, world screen, HUD
  input/
    input.ts            keys/mouse -> PlayerIntent fields (DOM-free, tested)
  render/
    world-canvas.tsx    the R3F <Canvas>: renderer, camera, lights, fog,
                        and the frame loop that drives everything below
    terrain/            chunk meshes, the far horizon, ground materials
    water.ts            waves, reflections, depth colour, shore foam
    sky/                day sky, sun position, time of day
    character/          modular character, materials, animation, retargeting
    fx/                 weather and particles
    entity-layer.ts     meshes per wire id + batched scenery
    instanced-props.ts  static props, one InstancedMesh per shape
    follow-camera.ts    third-person rig (mouse look, wheel distance)
    assets.ts           AssetProvider — the seam the art pack plugs into
  ui/                   login, character screen, HUD, character preview
```

The mirror itself (connect, fold snapshots and deltas, interpolate, send
intents) is **not** here — it is the shared `@mmo-engine/mirror` package, used
by both this client and the editor. That is deliberate: one driver, one
protocol implementation.

## How it renders

- **State never goes through React.** Mirror state is read in the frame loop;
  React re-renders only on prop changes, so 30 Hz of deltas causes no React
  reconciliation.
- **Motion is one tick behind, interpolated** between the last two
  authoritative ticks, with no extrapolation past the authority. There is no
  client prediction; that is a later slice.
- **Static scenery is instanced**, one `InstancedMesh` per shape instead of a
  mesh each, and art-pack models move into their own batch once cooked.
- The canvas is `flat` (no tone mapping) so the picture matches plain three.js.

## Tests

```bash
npm test --workspace=@mmo-engine/client    # tsc build + node --test
```

The suites cover the render layer and input mapping without a browser: chunk
geometry and its anti-diagonal cell split, border normals when a neighbour
arrives, water surface and depth for the shader, weather over a tick, the
cursor's biome lookup, the instanced-prop batching and its dense-slot
behaviour, and the input state machine (including key hygiene and presses
shorter than a frame).

## What you see without the licensed art

The Synty packs and third-party animations are git-ignored and never in the
repository. On a machine without them:

- scenery is the engine's own procedural PICG trees instead of the art-pack
  nature set;
- characters are placeholder shapes and the creator has nothing to show.

Everything else — terrain, water, sky, weather, physics, combat, networking —
is unchanged. [ART-PIPELINE.md](../../docs/ART-PIPELINE.md) explains how the
packs are converted when you do have them.
