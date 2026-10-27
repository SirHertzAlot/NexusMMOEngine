# MMO Engine — Developer Handoff: Slice 4 Closeout & Slice 5 Roadmap

**Date:** 2026-09-28
**Current HEAD:** `674c551` (after `38766e5` seamless tiling fix)
**Archive:** `mmo-engine-full-v3.zip` (verified clean: extract → `npm install` → `npm run bake:world` → `npm test`, all green)
**Author:** Arlo (AI builder) → handing off to incoming developer

---

## 1. Project Context

Authoritative Node.js MMO region server (Express + WebSocket + bitECS, 30Hz fixed tick, SQLite per-region persistence) with a three.js mirror client that renders authoritative state only. C++ N-API addons for physics (Jolt), navigation (Recast/Detour), and procgen (FastNoise2). FlatBuffers gameplay data plane, JSON+Zod control plane. PCG (procedural content generation) is built in slices on top of a `.pcg.json` graph runtime (`@mmo-engine/scatter`).

**Locked architecture decisions** (do not revisit without Joey):
- Server is authoritative for all simulation; client never predicts physics.
- three.js mirrors only — no client-side gameplay logic.
- C++ generates and simulates; JS orchestrates.
- FlatBuffers for the 30Hz data plane (single `.fbs` → C++ and TS bindings).
- SQLite embedded per region; world server uses SurrealDB (separate slice, not this handoff).
- Camera convention: `forward = (sin yaw, 0, cos yaw)`, `right = (-cos yaw, 0, sin yaw)`. At yaw 0, W → world +Z, D → world −X (camera-right). **Do not change.**

**Toolchain (do not downgrade):** Node 25.9.0, npm 11.12.1, VS Build Tools 2026, node-gyp 12.4.0. The repo was modernized for this — never propose version downgrades.

---

## 2. Slice 4 Goal (this slice — what "done" means)

1. **Terrain heightfield channel:** server generates a deterministic 16×16 heightfield per chunk (FastNoise2 Simplex), attaches it to per-tick deltas / periodic snapshots / initial snapshots, and the client displaces all 256 terrain vertices. Heights are network-only, never persisted in SQLite.
2. **Server-authoritative jumping:** rising-edge jump detection, server-side gravity (GRAVITY=22, JUMP_SPEED=8), terrain-based grounding, same-tick landing correction. Client sends `my: 0`; vertical motion is server-owned.
3. **Production input hardening:** movement-key whitelist, blur clears keys, no dirty-spam, cached √2 diagonal normalization, `+0` normalization (never serialize `-0`).
4. **Seamless chunk tiling:** 16 height samples span the full 16-unit chunk (`i * 16/15`), mesh centered at `cx*16+8`, server grounding uses the inverse lookup. No 1-unit voids between chunks.

---

## 3. Accomplished (all committed, all tested)

| Work | Commit | Verification |
|---|---|---|
| Terrain-height channel (schema `Chunk.heights`, codec, server attach, client + shared art-provider displacement) | `160816e` | Live WS: 9/9 chunks arrived with heights, ranges e.g. −0.73…0.26 |
| Unaligned `Float32Array` decoder crash fix (copies via indexed accessor) + regression test at buffer offset %4==3 | `357df6e` | 6/6 height tests pass |
| Server-authoritative jump + terrain grounding (`CharacterSystem` owns vertical; `IntentSystem` owns horizontal only) | `160816e` | Live WS: ground −0.816 → apex 0.773 → landed −0.816, JUMP-OK; 6/6 char tests |
| A/D strafe inversion fix | `f5db635` | Visual direction confirmed correct |
| Input hardening (whitelist, blur-clear, dirty-spam, √2 cache, +0 norm) | `84cf3a8` | 10/10 client input tests |
| Seamless tiling (16-sample → 16-unit mapping, server + client + tests) | `38766e5` | Wireframe screenshot: gaps gone; 25/25 art-provider tests |
| Clean-archive verification | — | 1876 files, 0 dist dirs, `npm install` exit 0, `bake:world` → 9 chunks/42 scattered/51 entities, root `npm test` exit 0 (15 suites, 0 failures) |

**Test inventory (all green at handoff):** client input 10/10, terrain-height 6/6, character/jump 6/6, shared art provider 25/25, engine-core 182 pass / 1 flaky perf-budget (see §5), full root suite exit 0.

---

## 4. Known Issues & Performance Bugs (for the incoming developer)

### P0 — Terrain appears flat on Joey's Windows PC
- **Symptom:** Screenshot from Joey's machine shows flat wireframe terrain, fps 3. Arlo's local screenshots (same seed 1234, same code) show displaced terrain.
- **Suspects:** (a) Joey may be running the pre-v3 archive (confirm he extracted `mmo-engine-full-v3.zip`, SHA256 `6bc637ca…bc35db`); (b) real amplitude is subtle (±0.7 world units) and may read as flat at his camera angle; (c) fps 3 on a real GPU suggests a WebGL/rendering problem, not just subtle hills.
- **Next step:** Confirm v3 on his PC. If still flat, profile the render loop; check whether `updateTerrainGeometry` is actually writing positions (add a debug log of min/max displaced Y per chunk).

### P0 — Client FPS unacceptably low (3–4)
- Arlo measured fps 4 under headless SwiftShader (software GL — expected to be slow, not a real benchmark).
- Joey measured fps 3 on real hardware — this is the real signal. **Profile before optimizing.** Prime suspects: per-frame allocations in the render loop, `updateTerrainGeometry` running every frame instead of on chunk-arrival, wireframe material with transparency, unbounded entity interpolation buffers.
- **Do not** "optimize" by degrading visual quality without profiling data.

### P1 — Terrain amplitude too subtle for the vision
- Native Simplex output is ~1 world unit tall. Joey wants dramatic, explorable terrain.
- **Fix:** increase noise gain / add octaves in the procgen heightfield sampler. One-line-ish change, but re-verify server grounding and scatter Y-placement after (both consume the same heightfield — they stay consistent automatically if they share the sampler).

### P1 — `p95 persist latency` budget test is flaky
- Failed once at 6.39ms vs 5ms budget; passed in isolation immediately after. Timing-sensitive, unrelated to terrain changes.
- **Fix options:** run it with warmup iterations, raise the budget with justification, or quarantine it to a dedicated perf job. Do not weaken the production requirement silently.

### P2 — Scatter Y-placement depends on terrain sampler
- Scatter (`@mmo-engine/scatter` cooker + native `addon-scatter`) snaps Y to the heightfield. Any amplitude change must be validated against scatter placement (there is a test: `gridSampler` snaps y; missing `heightAt` throws).

### P2 — Old Windows `mmo-engine` directory (broken backup)
- Joey keeps `C:\Users\user\Downloads\mmo-engine` (old, broken) untouched as backup. New work goes in `C:\Users\user\Downloads\mmo-engine-full`. Do not touch the old directory.

---

## 5. Remaining Work to Close Slice 4

1. **Resolve P0 flat-terrain on Windows** (§4). Definition of done: Joey confirms visible terrain relief in the client on his PC, with a screenshot.
2. **Tune terrain amplitude** (P1). Definition of done: hills/valleys unmistakable at the default camera; server grounding and scatter placement re-verified.
3. **Profile and fix client FPS** (P0). Definition of done: sustained 60fps on Joey's hardware in the 3×3 baked world; document what the bottleneck was.
4. **Stabilize the persist-latency test** (P1). Definition of done: root `npm test` green 3 consecutive runs.
5. **Re-verify the full loop on Joey's PC:** `npm install` → `npm run bake:world` → `npm run server` → client login → move (WASD), jump (Space), confirm no gaps, correct A/D direction, terrain relief, scatter on terrain, restart server (SQLite restore, no duplicate scatter), reconnect (heights resend).

---

## 6. Slice 5+ Roadmap: The Editable World (multi-slice arc)

**The vision (Joey's):** the editor becomes a real authoring environment — visual PCG graph UI, the baker running live inside the editor, terrain sculpting and mesh editing, click-any-object component editing. The entire game world editable, with the procedural base underneath. **None of this is built yet.** Today: PCG graphs drive scatter only (terrain bypasses them via direct FastNoise2 calls); the baker is a CLI script; the editor is inspector + play-mode launcher + art browser (read-only).

**Slice 5 — Graph-driven terrain & biomes (runtime foundation):**
1. **Terrain nodes in the PCG graph registry** — noise, heightfield ops, biome selectors as `.pcg.json` nodes so graphs author terrain, not just scatter.
2. **Hierarchical biome survey** — temperature/moisture/elevation fields → per-chunk biome IDs.
3. **Multi-pass graph execution** — landform → biome → habitat → resource passes, deterministic ordering.
4. **WFC / constraint solving** — coherent landform transitions; border rows shared/stitched deterministically (adjacent chunks must agree on edge heights exactly).
5. **Nested selection** — biome → landform → habitat → resource, server-authoritative, seeded per chunk coordinate.
6. **Chunk streaming + frustum culling** — client loads chunks by camera radius; server sends heights only for relevant chunks. (Current: all 9 chunks always.)
7. **LOD** — distant chunks at reduced vertex density (16×16 is the near LOD).

**Slice 6 — Baker in the editor:** baker moves from CLI (`npm run bake:world`) to an editor-invokable service. Bake from the UI, progress reporting, preview the baked world without server restart.

**Slice 7 — Visual PCG graph UI:** node-based editor (React Flow or similar) for authoring `.pcg.json` graphs visually — the "PCG graphing UI." Round-trips to the Zod-validated schema; the reference evaluator stays the golden source.

**Slice 8 — Mesh editing foundations:** terrain sculpting (raise/lower/smooth/paint-biome brushes) + object transform gizmos. **Architectural crux:** edits are stored as a non-destructive override layer on top of the procedural base — re-baking never wipes hand edits. Get this wrong and edits fight the baker forever.

**Slice 9 — Per-object editing:** click any entity → full component inspector with write-back to SQLite/authoring overrides.

**Constraints across all slices:**
- Determinism: same seed + chunk coordinate → same terrain on every server, every run. Required for authoritative multiplayer.
- Heights stay network-only (not persisted); SQLite persists entities/scatter, never heightfields. Edit overrides are the exception — persisted separately from base terrain.
- Server remains the only writer of terrain truth; client displacement is pure rendering; editor edits go through the server, never around it.

---

## 7. Developer Setup (Windows)

```
:: Fresh dir (delete contents first if re-extracting)
cd C:\Users\user\Downloads\mmo-engine-full
:: Extract mmo-engine-full-v3.zip FLAT into this dir (no wrapper folder)

npm install
npm run bake:world        :: bakes 3x3 world, seed 1234
npm run server            :: ws://localhost:17777
:: second terminal:
npm run dev --workspace=@mmo-engine/client   :: http://localhost:18080
```

In the client: use the **Create account** tab (in-client registration, protocol v4), then log in. WASD move, mouse-look (click canvas), wheel zoom, Space jump.

**Key files:**
- Terrain sampling (server): `packages/engine-core/src/` — search `heightsArray`, `sampleHeight`
- Height codec: `packages/schema/` (.fbs) + `packages/schema/generated/` (committed in archive; gitignored in repo — run `npm run codegen` on Linux only; Windows uses the shipped bindings)
- Client displacement: `apps/client/src/render/assets.ts` — `updateTerrainGeometry`
- Jump/grounding: `packages/engine-core/src/systems/CharacterSystem.ts`
- Input: `apps/client/src/input.ts`
- PCG graphs: `packages/scatter/` (`.pcg.json` schemas, cooker, reference evaluator)
- Native procgen: `packages/addon-scatter/` (C++17, strict-FP)

**Tests:** `npm test` at root (all workspaces). Focused: `npm test --workspace=@mmo-engine/client`, `--workspace=@mmo-engine/engine-core`, `--workspace=@mmo-engine/scatter`.

---

## 8. Definition of "Slice 4 Closed"

- [ ] Visible terrain relief confirmed on Joey's PC (screenshot)
- [ ] 60fps sustained on Joey's hardware (3×3 world)
- [ ] Jump: Space → rise → land on terrain height, no fall-through
- [ ] No chunk gaps; A/D direction correct; scatter sits on terrain
- [ ] Server restart restores from SQLite without duplicating scatter; heights resend on reconnect
- [ ] Root `npm test` green 3× consecutive
- [ ] No version-downgrade proposals; repo stays on the modern toolchain

**Do not start Slice 5 until Joey reviews and signs off on Slice 4.**
**Slices 6–9 (editor arc) are scoped but unscheduled — Joey prioritizes them after the runtime slices land.**
