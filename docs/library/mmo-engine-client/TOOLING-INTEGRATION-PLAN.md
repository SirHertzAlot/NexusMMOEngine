# Tooling Integration Plan — gltfpack, gltfjsx, Leva

**Status:** Plan approved for writing 2026-10-09. Not scheduled, not
assigned. Do not push, merge, or hand to Claude without Joey's explicit
word.
**Source verdicts:** `THREEJS-TOOLING-REVIEW.md` (adopt: gltfpack,
gltfjsx, Leva dev-only) and `THREEJS-DIRECTORY-REVIEW.md` (adopt:
gltf-transform as the texture + cleanup stage, completing the
compression story gltfpack starts).
**Repo facts (verified 2026-10-09):** client is `apps/client` (R3F 9,
`meshoptimizer ^1.3.0` used for *simplification* in `src/render/lod.ts`
— no MeshoptDecoder wired for loading yet); art pipeline is
`packages/art` (`src/manifest.ts` Zod-validated, `src/convert/` scripts).
Joey's machine: Windows, Node 25.

## Conventions for the executor

- Pin every tool version in the plan's Phase 0; never float on `latest`.
- gltfpack ships as a standalone binary in meshoptimizer GitHub
  releases, including win64 — the plan must work on Joey's Windows
  machine, not just this Linux box.
- Every phase ends with a gate. No phase starts until the previous
  gate is green.
- Numbers go in the manifest. If it isn't measured, it didn't happen.

## Phase 0 — Pin versions, record baselines (no behavior change)

1. Choose and pin: gltfpack binary version (latest stable from
   meshoptimizer releases at execution time), `@gltf-transform/cli`
   npm version, `gltfjsx` npm version, `leva` npm version. Record all
   four in the plan's appendix and in `packages/art/README` (or the
   existing art docs).
2. Pick 3 baseline assets: one prop, one character-ish mesh, one baked
   vista/environment piece from the current corpus.
3. For each, record: file bytes, client load time (ms, median of 5),
   and a rendered screenshot hash. These are the before-numbers; they
   are checked into the test fixtures.
4. Verify on Windows: gltfpack binary runs (`gltfpack -h`), `npx
   gltfjsx --version` runs, and `npx @gltf-transform/cli --version`
   runs *including a trial KTX2 conversion* — the KTX2 codec path is
   the one most likely to differ on Windows, so it gets proven in
   Phase 0, not discovered in Phase 1.

**Gate:** pinned versions recorded; 3 baselines with bytes + load ms +
screenshot hashes checked in; KTX2 trial conversion green on Windows.

## Phase 1 — gltfpack encode (bake) + MeshoptDecoder (client)

Order matters: decoder first, so compressed assets always load.

**1a. Client decoder wiring.**
- In the client's GLTF loading path (the AssetProvider in
  `packages/art` / client loader setup), call
  `loader.setMeshoptDecoder(MeshoptDecoder)` from the `meshoptimizer`
  package's decoder module, serving its `.wasm` from client static
  assets.
- Test: load an existing *uncompressed* GLB — decoder present but
  idle, zero behavior change, existing tests green.

**1b. Bake encode step.**
- Add a `compress` step to `packages/art` (next to `src/convert/`):
  shell out to the pinned gltfpack binary with meshopt compression
  (`-cc`); v1 does NOT touch textures here (texture pipeline is 1d's
  job — deliberate scope cut, not an omission).
- Extend the Zod manifest schema (`packages/art/src/manifest.ts`) with
  optional fields: `compression: "meshopt"`, `rawBytes`,
  `compressedBytes`. The bake records before/after per asset.
- The binary path is config (env var or config file), never hardcoded.

**1c. Golden test.**
- The 3 baseline assets: raw → gltfpack → load in client → render.
- Assert: screenshot hash matches the Phase 0 baseline (zero visual
  delta), manifest shows `compressedBytes < rawBytes`.

**Gate:** ≥40% byte reduction on the 3-asset sample (or a written
reason per asset if one misses), zero visual delta, decoder live in
the client, manifest schema extended with tests green.

**1d. Texture + cleanup stage (gltf-transform).**
Division of labor, locked: gltfpack owns geometry, gltf-transform owns
textures and scene cleanup. This stage runs on the gltfpack output.

- **1d-i. Client transcoder first.** Wire three.js `KTX2Loader` plus
  the Basis Universal transcoder wasm into the client's texture
  loading path. Test against existing *unconverted* textures — no
  behavior change, existing tests green. (Same decoder-before-encode
  pattern as 1a/1b.)
- **1d-ii. Bake steps** (pinned `@gltf-transform/cli`, npm,
  Windows-verified in Phase 0), in order:
  1. `prune` + `dedup` — scene cleanup; always safe, always on.
  2. Texture conversion per slot config (locked v1 default; tunable
     in config, not code): baseColor → WebP; normal, occlusion,
     metallicRoughness → UASTC KTX2. Full ETC1S KTX2 is a named
     follow-up after the KTX2 eval gate, not this phase.
  3. Texture resize caps per quality tier (config).
- Extend the manifest schema: `textureCompression` (per-slot),
  `textureBytes` before/after, `cleanupRemoved` counts
  (nodes/meshes/accessors pruned).
- **Gate:** texture bytes before/after recorded per asset, VRAM
  estimate down or flat, zero visual delta on the 3 baselines,
  KTX2Loader live in the client.

## Phase 2 — gltfjsx component workflow

1. Add `gltfjsx` as a devDependency of `apps/client`.
2. Convention (locked):
   - Command: `npm run models:generate -- <baked-compressed.glb>`
     (script runs gltfjsx against the *compressed* bake output).
   - Output: `apps/client/src/models/generated/<Name>.tsx`,
     committed, with a `// @generated by gltfjsx — do not hand-edit`
     header. Regenerate, don't patch.
   - One component per asset; prop names follow existing client
     conventions.
3. Document the workflow in `apps/client/README.md`: bake →
   gltfpack → gltfjsx → import. Regeneration rule: when the baked GLB
   changes, regenerate the component (manual in v1; a stale-check
   script is a named follow-up, not this phase).
4. Wire one model end-to-end through the full chain into a dev scene.

**Gate:** one asset baked → compressed → component-generated →
rendered in a dev scene, pixel-identical to the pre-component render.

## Phase 3 — Leva dev overlay

1. Add `leva` as a **devDependency** of `apps/client` (never a
   runtime dependency).
2. Mount `<Leva>` gated behind `import.meta.env.DEV` — it must be
   impossible to render in a production build by construction, not by
   convention.
3. Seed exactly 3 control groups (concrete, not "whatever"):
   - Quality tier override (forces the 4-tier preset),
   - Post-processing master toggle + effect intensity,
   - Key light intensity / direction.
4. Prod-bundle check: build for production, assert the bundle contains
   zero `leva` bytes (grep dist or a bundle-size assertion in the
   client test suite).

**Gate:** panel works in dev, the 3 control groups drive the scene,
production bundle is leva-free (automated check, not eyeballed).

## Phase 4 — Parked (not scheduled)

- **Theatre.js:** revisit only when a cinematics/sequenced-animation
  need exists AND the AGPL-studio license question is answered.
- **Needle Inspector:** revisit after its license is verified.
- **GSAP 4:** revisit when the feature list is public and a concrete
  editor/HUD tween need exists.

## Appendix — pinned versions

(Filled in Phase 0; this section must not stay empty past Phase 0.)

- gltfpack binary: _
- @gltf-transform/cli npm: _
- gltfjsx npm: _
- leva npm: _
