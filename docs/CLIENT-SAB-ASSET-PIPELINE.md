# Client SAB Asset Pipeline (SAB Phase 6)

Web Workers decode assets into a SharedArrayBuffer (SAB); the main thread
reads the decoded bytes without copying them. Goal: faster load times even
in poor compute environments — parallel decode + zero-copy handoff, no
main-thread blocking.

**SAB is local only.** Nothing is shared between server and client — the
browser cannot read server memory. The server-side SAB phases (component
storage, physics boundary, wire encoding, worker sharing) are a separate
track. This phase shares only the *idea*: one buffer, produced in one
thread, consumed in another, with no copies on the hot path.

## Asset type

**Meshopt-compressed GLB geometry** (`EXT_meshopt_compression`, gltfpack
`-cc`) — the format the bake pipeline produces and the client already
reads via `MeshoptDecoder` (`render/gltf-loader.ts`). Uncompressed GLBs
decode through the same code. Scope is **geometry only**: mesh primitives
(attributes + index + material index). Materials, textures, skins, and
animations stay on the `GLTFLoader` path — they are THREE object graphs
that cannot live in a SAB.

## Pipeline

```
fetch GLB (main thread — auth/caching unchanged)
  -> SabAssetLoader.decodeGlbBytes()
    -> SAB path (when usable): allocate SAB sized exactly to the decoded
       payload (estimateSabPayloadBytes, from JSON accessor metadata —
       no decode needed) -> worker decodes into the SAB
       (assetDecode handler: GLB parse + meshopt WASM + accessor gather)
       -> main thread builds BufferGeometry attributes as typed-array
       views over the SAME SAB — zero copy of the vertex data
    -> fallback (no SAB / no workers / worker failure / overflow retry
       exhausted): decodeGlb() on the main thread via the SAME core.
       Same geometry out, just decoded locally.
```

Both paths run the same pure core (`assets/glb-meshopt.ts`), so the SAB
path and the fallback produce byte-identical geometry (tested).

Files:

| File | Role |
| --- | --- |
| `apps/client/src/assets/sab-support.ts` | Capability probe (SAB + `crossOriginIsolated` + Worker) |
| `apps/client/src/assets/sab-arena.ts` | SAB arena: header + Atomics state machine + bump allocator |
| `apps/client/src/assets/glb-meshopt.ts` | GLB parse + meshopt decode + accessor gather (pure core) |
| `apps/client/src/assets/sab-asset-loader.ts` | Main-thread orchestrator: SAB path, overflow retry, fallback |
| `apps/client/src/workers/handlers/asset-decode.ts` | Worker handler (`assetDecode`) |
| `apps/client/src/workers/runtime.ts` | `getTransferables` fix: SABs are shared, never transferred |
| `apps/client/src/workers/index.ts` + `types.ts` | Handler registration + `assetDecode` task types |
| `apps/client/vite.config.ts` | COOP/COEP headers for dev + preview servers |
| `apps/client/test/sab-asset-pipeline.test.ts` | Tests |
| `apps/client/scripts/bench-sab-assets.mjs` | Benchmark gate (`npm run bench:sab-assets`) |

### SAB arena protocol

One arena per decode job, single producer (worker) / single consumer
(main thread). Header (first 64 bytes, Int32Array): magic, version,
state, capacity, used, alloc count, needed-bytes. State machine:

```
EMPTY -> WRITING -> READY -> CONSUMED
                  \-> ERROR (overflow: neededBytes tells the caller
                              how big the retry arena must be)
```

Payload is bump-allocated, 8-byte aligned, so any TypedArray view over it
is alignment-valid. The main thread polls `awaitReady()` — `Atomics.wait`
is illegal on the main thread. The loader retries once on overflow, then
falls back to main-thread decode; a load never fails because the fast
path failed.

The compressed GLB bytes are *copied* per worker attempt: the worker
runtime transfers the payload's ArrayBuffer (zero-copy handoff), which
detaches the sender's copy — sending the caller's buffer would destroy
the bytes needed for a retry or the fallback.

## ⚠️ Deployment: COOP/COEP headers (REQUIRED for SAB)

**SharedArrayBuffer only exists in cross-origin isolated pages.** If the
deployment does not serve these headers, `crossOriginIsolated` is false,
the probe reports unusable, and the client **silently falls back to
main-thread decode** — correct geometry, no crash, but none of the
Phase 6 benefit. There is no console error; check the probe / dev
overlay when verifying a deployment.

Serve on **every** document response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Consequences to plan for:

- `require-corp` blocks cross-origin subresources that do not opt in.
  Every cross-origin `<script>`, `<img>`, font, fetch, and iframe needs
  either `crossorigin="anonymous"` + a `Cross-Origin-Resource-Policy:
  same-site | same-origin | cross-origin` header from its server, or
  must move same-origin. A third-party CDN asset without CORP **will
  break** under these headers — audit all cross-origin loads before
  turning this on in production.
- Same-origin assets (including the Basis transcoder served from
  `/basis/`) are unaffected.
- The Vite dev and preview servers already send both headers
  (`apps/client/vite.config.ts`). **Production must serve the same
  headers from its own server config** (nginx/Cloudflare/whatever serves
  `dist-app`) — the Vite config does not travel with the build.
- `Cross-Origin-Opener-Policy: same-origin` also isolates the page from
  other origins' popups (`window.opener` is cut). Any OAuth popup /
  cross-origin `postMessage` flow must be re-tested under isolation.

## Benchmark gate

`npm run bench:sab-assets` — 256×256-cell grid (66,049 verts, 393,216
indices, POSITION + NORMAL + TEXCOORD_0, meshopt-compressed), median of
5 runs after warmup. Three runs on this machine (shared with sibling
agents' native builds — absolute times move with load, the blocking
reduction is consistent):

| Run | Baseline main-thread blocking | SAB main-thread blocking | SAB total wall |
| --- | --- | --- | --- |
| 1 (heavy contention) | 111.60 ms | 0.84 ms (−99.2%) | 165.61 ms |
| 2 | 11.63 ms | 1.72 ms (−85.2%) | 53.12 ms |
| 3 | 17.04 ms | 1.12 ms (−93.4%) | 33.46 ms |

Gate: main-thread blocking must drop. It does in every run (85–99%).
Isolated total wall is higher (thread handoff + scheduling a second
thread) — reported as an observed tradeoff, not hidden: in production
the worker decode overlaps main-thread frame work instead of
serializing behind it, so blocking — not isolated wall — is the
user-visible cost. Decode correctness is byte-identical (tests).

## Limitations (by design)

- Geometry only — no materials/textures/skins/animations via SAB.
- Sparse accessors, MAT* attributes, and multi-buffer GLBs throw
  `GlbDecodeError` so the caller falls back to `GLTFLoader`.
- One arena per job (bump allocator, no reuse); SABs are capped by
  `maxSabBytes` (default 256 MiB) — larger assets decode on the main
  thread.
- The worker holds transient decoded copies before writing them into
  the SAB (one extra copy, in worker memory, not on the main thread).
  The zero-copy guarantee is on the main-thread consume side.
- No determinism risk: decode is a pure function of the GLB bytes.
  The sim never sees this code — it only feeds render geometry.
