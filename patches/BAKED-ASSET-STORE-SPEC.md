# Baked Asset Store — SoA asset pipeline + SQLite index

**Status: DRAFT, 2026-11-13.** Written without Joey's word on the offer to
write it (offered 2026-11-12 ~17:44 ET, no answer recorded). Nothing here is
implemented, pushed, or merged. It is a spec for his approval, change, or
rejection — not a build order.

**Origin:** Joey's idea, 2026-11-12: bake the entire asset library into the
client and backend engine using Data Oriented Design and DOTS-like
performance paradigms to speed up load times dramatically and make the game
much lighter overall, possibly in a light SQLite store/db.

## 0. Problem, in one paragraph

The world is already data-oriented (ECS, SoA tick, shared wire codec). The
asset library is still file-oriented: GLBs parsed, decoded, and re-laid-out
at load, per file, per client. Baking closes that gap — convert once at
build time into engine-native binary, index it in SQLite, and let the
runtime read columns instead of parsing files. Load time collapses because
there is nothing left to parse; the SAB worker design (below) mostly places
columns instead of decoding.

## 1. What exists today (grounding — read before building)

- **AssetProvider contract:** `packages/art/src/provider.ts` — `bodyMesh /
  assetMesh / terrainMesh / loadAssetPack`, with `ManifestAssetProvider`
  (GLTFLoader per manifest entry, placeholder fallback per failed entry)
  and a procedural placeholder provider. The baked store is a **new
  implementation behind this same interface**, never a replacement of it.
  Swappable by design, per the modularity law.
- **Manifest contract:** `packages/art/src/manifest.ts` — Zod
  `ManifestSchema` (`models[]` with `id/file/forShape/compression`,
  `textures[]`), path-traversal rejection, duplicate-id rejection,
  `checkManifestFiles`. The bake's input gate reuses this validation; the
  baked index extends it, it does not fork it.
- **Client SAB design:** client-side SAB is LOCAL only, never
  server→client sharing — Web Workers decode assets into a shared SAB the
  main thread reads without copy (Joey, 2026-10-14). With baked data there
  is barely any decode left: workers place columns.
- **First consumer already named:** `CMU-IMPLEMENTATION-MAP.md` §2 step 6 —
  baked clips land in the Baked Asset Store: SoA keyframe streams, indexed
  in the SQLite asset DB with family, verb, licence lane, and hash.
  ClipIds on the wire stay as they are.
- **Scale of the input (measured 2026-11-12):** Polyfork pull — full
  3,291-asset metadata index, 421 GLBs on disk, **798 MB** (410/411
  downloaded; one 404). The full 3,291 would be several GB raw.
- **Animation audit context:** `mmo-engine-animation/ANIMATION-PIPELINE-
  AUDIT.md` — clip validation unimplemented, bytes unmeasured, two
  retargeters diverge. The bake is where validation and measurement land.

## 2. The three layers

### 2.1 Bake (build-time, where the art pipeline already lives)

Every source asset — GLB, clip, Polyfork knob table, VFX recipe — converts
once into engine-native binary:

- **Geometry as SoA column buffers:** positions, normals, UVs, indices as
  typed arrays. No JSON, no parse at load.
- **Animation clips as SoA keyframe streams:** per-bone channels in
  column form, sampled in bulk. Root-motion handling follows the CMU map:
  stripped to in-place for locomotion, converted to a sim-owned
  displacement profile for traversal.
- **Palettes / materials as shared tables:** one vertex-coloured material
  per Polyfork kit palette, not one material per asset.
- **Textures pre-mipped** (KTX2/UASTC where the manifest already records
  it — see `textureCompression` in `manifest.ts`).
- **Dedupe by content hash at bake:** Polyfork variant listings share
  meshes; hashing collapses them to one stored copy. A variant is a knob
  row + a mesh reference, not a second mesh.
- **Bake gates (fail the bake, never warn-and-ship):** manifest validation
  (reuse `ManifestSchema` + `checkManifestFiles`); `validateClip` for
  every clip (bone set, loop seams, foot-skate estimate, displacement
  profile where required); licence lane present per asset (§4); hash
  recorded per stored blob.

### 2.2 Store (SQLite index + memory-mappable chunk files)

- **SQLite is the index and manifest, not the payload store:** assets,
  variants, knob definitions, dependencies, which chunk each asset lives
  in, hashes, licence lane per asset — all queryable, tiny, exactly what
  SQLite is good at.
- **Heavy payloads live beside the DB as binary chunk files**, content-
  addressed (`sha256` in the filename / index), read-only and versioned.
  The client maps a chunk and reads columns zero-copy instead of
  round-tripping megabytes through SQL.
- **Proposed tables (draft — schema review is a B0 task):**

```sql
assets(id TEXT PRIMARY KEY, kind TEXT, source TEXT, hash TEXT,
       chunk_id TEXT, byte_offset INTEGER, byte_length INTEGER,
       licence_lane TEXT NOT NULL, credit TEXT);
variants(asset_id TEXT, knob_json TEXT, mesh_asset_id TEXT,
         PRIMARY KEY(asset_id, knob_json));
chunks(id TEXT PRIMARY KEY, hash TEXT, bytes INTEGER, kind TEXT);
-- kind: 'base' | 'kit:<kit-id>' | 'region:<region-id>'
clips(id TEXT PRIMARY KEY, asset_id TEXT, family TEXT, verb TEXT,
      licence_lane TEXT NOT NULL, hash TEXT, frames INTEGER, rate REAL);
knobs(asset_id TEXT, knob TEXT, type TEXT, min REAL, max REAL, def REAL);
```

- **Separate from the world-state DB.** The world tier stays mutable
  SurrealKV/SurrealDB. The asset store is read-only, versioned, and
  content-addressed. Never mix the two in one file, one connection, or
  one migration.

### 2.3 Runtime (asset IDs, not file paths)

- Components reference **asset IDs — indices into the baked tables**.
  One geometry buffer, ten thousand instances as transform columns.
- Clips sampled in bulk from SoA streams; LOD tiers by distance (full
  rate near, half-rate mid, held-pose far — the CMU map's A3 benchmark
  is the first measurement of this).
- The client SAB workers place columns into the shared buffer; the main
  thread reads without copy. Server side, the same store feeds the bake
  and validation tooling; the authoritative tick never reads asset
  bytes (Jolt owns the tick, untouched by this spec).

## 3. The honest caveat, carried into the design

**Baked ≠ small to distribute.** 798 MB raw for 421 assets; the full
library is several GB. Baking makes the game dramatically lighter *at
runtime*, not smaller to download. The DOD answer is chunking, and it is
part of the spec, not an afterthought:

- Bake the whole library into the store format once.
- Ship a **base chunk** (player, common NPCs, starter terrain/props).
- Stream **kit / region chunks on demand** from the same content-
  addressed store — a chunk is fetched by hash, verified on arrival,
  mapped, and never re-downloaded.
- Chunk boundaries follow the catalogue's own structure (kits share one
  palette/scale/grid) and the world's region/chunk grid, so a region
  load and an asset-chunk load are the same trip where possible.

## 4. Licence lanes survive baking

Baking does not change any licence. The SQLite index carries
`licence_lane` per asset, and the bake enforces it:

- **Own game:** Polyfork GLB geometry, CMU clips retargeted onto our
  rigs, KayKit CC0 — fine, baked or not.
- **Shipped prototype pack:** CC BY 4.0 GLB-derived geometry only, with
  CREDITS.md; **nothing derived from Polyfork .mjs source**; no raw CMU
  library; no HD editions; no Quaternius/Mixamo raw files.
- A baked blob whose source licence forbids redistribution **fails the
  bake for the pack target** instead of shipping by accident. Pack
  target and game target are separate bake outputs from the same index.

## 5. Phasing (each lands green before the next starts)

- **B0 — Index + manifest prototype (no binary yet).** SQLite schema
  above against the real Polyfork catalogue (3,291 index rows, 421 GLBs
  on disk); dedupe report (how many variant listings collapse to one
  mesh); licence-lane coverage report (every row has a lane or the bake
  refuses it). Exit: the index answers "which chunk holds asset X, what
  licence, what hash" for the whole pull.
- **B1 — Geometry bake.** One kit (medieval/town first, per the Polyfork
  note) to SoA columns + chunk file; a `BakedAssetProvider` behind the
  existing `AssetProvider` interface; placeholder fallback preserved for
  any entry the bake rejects. Golden-hash tests: same input → same chunk
  bytes. Exit: the kit loads from the store in a headless client run.
- **B2 — Clips.** CMU shortlist first (climb/jump/obstacle, once the
  hosted files land — P0 is blocked on that, not on this spec);
  `validateClip` enforced at bake; ACL compression measured per clip.
  Exit: baked clips play through the existing animation intake.
- **B3 — Client SAB placement.** Workers place baked columns into the
  shared buffer; load-time benchmark before/after on the same kit
  (cold load, warm load). Exit: measured numbers, not a claim — the
  perf-push rule (chart + metrics doc) applies.
- **B4 — Chunked delivery.** Base + kit/region chunks, hash-verified
  fetch, on-demand streaming. Exit: a fresh client loads base only,
  then streams one kit chunk on entering its region.

## 6. Open decisions (Joey's — none block B0)

1. Chunk granularity: per-kit, per-region, or both (spec assumes both;
   B0 measures the kit/region overlap first).
2. Browser-side SQLite: server-side index only, or a client copy via
   OPFS / sql.js — B0 stays server/tooling-side; client reads chunk
   files + a shipped JSON manifest slice until this is decided.
3. Whether the baked store also absorbs VFX recipes and terrain masks
   (dungeon-detail bake Phase 2) or stays geometry+clips in v1.
4. Pack target: does the shipped prototype pack bake from the same
   store with a licence filter, or keep its own GLB pipeline?

## 7. What this spec does not do

- No change to the authoritative tick, Jolt, the wire codec, or
  SurrealKV world state.
- No new dependency on the client render path until B1; the placeholder
  provider keeps working throughout.
- No claim about load-time improvement until B3 measures it.
- No push to `patches/` or any repo branch — this file lives in
  `your_files/mmo-engine-arch-docs/` as a draft until Joey says otherwise.
