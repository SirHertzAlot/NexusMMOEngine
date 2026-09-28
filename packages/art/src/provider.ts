/**
 * Manifest-backed THREE.js AssetProvider with placeholder fallback.
 *
 * This module owns the `AssetProvider` contract (moved here from the
 * client's `render/assets.ts`): the renderer depends on this abstraction,
 * and this package decides how the meshes get made (SOLID: depend on the
 * abstraction, not on PlaceholderAssets or on glTF plumbing).
 *
 * Two implementations of the same idea:
 * - No art pack yet -> every mesh is a procedural placeholder (colored
 *   box/sphere for bodies, flat shaded plane for terrain). The game is
 *   fully playable with zero art.
 * - Art pack present -> `loadAssetPack()` fetches each manifest entry;
 *   `bodyMesh()` returns a clone of the cached model when the body's
 *   shape maps to a known model id, and `terrainMesh()` uses the pack's
 *   terrain texture when one loaded. Anything that fails to load stays
 *   on its placeholder — a missing/corrupt file degrades one asset,
 *   never the whole pack and never the frame loop.
 *
 * Shape-mapping rule (the only coupling between ECS data and art):
 * a manifest model may carry `forShape`, matched against
 * `String(body.shapeKind)` — e.g. `forShape: "1"` selects that model for
 * every Sphere body (`ShapeKind.Sphere === 1`). A model without `forShape`
 * still loads and shows up in `fallbackStatus()`, but `bodyMesh()` never
 * auto-selects it. Per-entity or per-class overrides are a future
 * extension; the rule stays a pure function of the BodyConfig row so the
 * mirror (which only has rows) can call it with no extra state.
 *
 * Placeholder colors are deterministic per entity: `BodyConfigRow` carries
 * the wire id (see the protocol codec), so the provider hashes it directly
 * into an HSL color — the same entity is the same color every run, which
 * makes visual debugging stable. No extra parameter is needed.
 *
 * Node note: three's FileLoader streams `fetch()` bodies through a DOM
 * `ProgressEvent`, which does not exist in Node. `loadAssetPack()` installs
 * a minimal `ProgressEvent` shim (only if absent) so pack loading also
 * works in Node-based tooling and tests. No other DOM is touched on the
 * model path; texture loading in Node falls back to the placeholder via
 * the normal failure path.
 */

import * as THREE from "three";
import { ShapeKind } from "@mmo-engine/schema/generated/js/mmo-engine.js";
import type { AssetRefRow, BodyConfigRow, ChunkRow } from "@mmo-engine/protocol";
import { ManifestSchema, type AssetManifest } from "./manifest.js";
import { errMessage } from "./util.js";

/** Per-entry load state for the asset inspector UI. */
export interface AssetLoadStatus {
  id: string;
  status: "loaded" | "fallback";
  /** Why this entry is on fallback (load error, or never attempted). */
  diagnostic?: string;
}

export interface AssetProvider {
  /** Mesh for an entity carrying a BodyConfig row (authoritative shape). */
  bodyMesh(body: BodyConfigRow): THREE.Object3D;
  /**
   * Mesh for an entity carrying an AssetRef row (PCG scatter spawn).
   * Optional: when absent (or when it returns undefined) the caller
   * falls back to bodyMesh. The placeholder provider leaves this
   * unimplemented — Joey's art pack implements it by mapping
   * assetHash (fnv1a32 of the manifest model id) to the loaded model,
   * with `variant` selecting the art variant.
   */
  assetMesh?(ref: AssetRefRow): THREE.Object3D | undefined;
  /**
   * Terrain mesh for a chunk entity. PLACEHOLDER: flat shaded plane —
   * the client does not have authoritative heights yet. Real heights
   * arrive via a future chunk-data channel; this signature already
   * takes the Chunk row so the swap is local to the implementation.
   * When the pack provides a terrain texture (see `forTerrain`), it is
   * used as the plane's albedo; otherwise the plain grass material.
   */
  terrainMesh(chunk: ChunkRow, worldSize: number): THREE.Object3D;
  /**
   * Load the art pack: fetch every model and texture in the manifest.
   * A failed entry records a diagnostic (see `fallbackStatus()`) and stays
   * on placeholder fallback — this method never throws and never rejects
   * because of a single bad asset. Safe to call again; already-loaded
   * entries are skipped, failed ones are retried. `url` overrides the
   * constructor's baseUrl for this call when non-empty.
   */
  loadAssetPack(url: string): Promise<void>;
}

/** Deterministic placeholder color per entity (HSL from wire id hash). */
export function placeholderColor(wireId: bigint): THREE.Color {
  let h = 0n;
  let x = wireId === 0n ? 0x9e3779b97f4a7c15n : wireId;
  for (let i = 0; i < 4; i++) {
    h ^= x & 0xffffn;
    x >>= 16n;
  }
  return new THREE.Color().setHSL(Number(h % 360n) / 360, 0.55, 0.5);
}

/** Decode chunk (cx, cz) from the chunkId u64 (see spawnChunk/chunkIdFor). */
function chunkCoords(chunkId: bigint): { cx: number; cz: number } {
  const u = (v: bigint): number => {
    const n = Number(v & 0xffffffffn);
    return n >= 0x80000000 ? n - 0x100000000 : n;
  };
  return { cx: u(chunkId >> 32n), cz: u(chunkId) };
}

/** Procedural stand-in for a body: sphere for Sphere, box otherwise. */
function placeholderBodyMesh(body: BodyConfigRow): THREE.Mesh {
  const geometry: THREE.BufferGeometry =
    body.shapeKind === ShapeKind.Sphere
      ? new THREE.SphereGeometry(Math.max(body.radius, 0.05), 24, 18)
      : new THREE.BoxGeometry(
          Math.max(body.halfX * 2, 0.05),
          Math.max(body.halfY * 2, 0.05),
          Math.max(body.halfZ * 2, 0.05),
        );
  const material = new THREE.MeshStandardMaterial({
    color: placeholderColor(body.wireId),
    roughness: 0.7,
    metalness: 0.1,
  });
  return new THREE.Mesh(geometry, material);
}

/**
 * three's FileLoader builds a DOM ProgressEvent while streaming. Install a
 * minimal shim when running where it doesn't exist (Node) so pack loading
 * works outside the browser. Guarded: never overrides a real implementation.
 */
function ensureLoaderDomShim(): void {
  const g = globalThis as unknown as { ProgressEvent?: unknown };
  if (typeof g.ProgressEvent !== "undefined") return;
  class ProgressEventShim extends Event {
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;
    constructor(
      type: string,
      init: { lengthComputable?: boolean; loaded?: number; total?: number } & EventInit = {},
    ) {
      super(type, init);
      this.lengthComputable = init.lengthComputable ?? false;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  }
  g.ProgressEvent = ProgressEventShim;
}

function joinUrl(base: string, file: string): string {
  // `file` is a validated relative POSIX path (ManifestSchema), so plain
  // concatenation cannot escape the base.
  return base.endsWith("/") ? base + file : base + "/" + file;
}

export interface ManifestAssetProviderOptions {
  /** Base URL the pack is served from (manifest `file` paths are relative to it). */
  baseUrl: string;
  /** The pack manifest. Re-validated: a hand-built object can't smuggle an unsafe path. */
  manifest: AssetManifest;
}

export class ManifestAssetProvider implements AssetProvider {
  private readonly baseUrl: string;
  private readonly manifest: AssetManifest;
  private readonly models = new Map<string, THREE.Object3D>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly failures = new Map<string, string>();

  constructor(options: ManifestAssetProviderOptions) {
    this.manifest = ManifestSchema.parse(options.manifest);
    this.baseUrl = options.baseUrl;
  }

  async loadAssetPack(url: string): Promise<void> {
    ensureLoaderDomShim();
    const base = url.length > 0 ? url : this.baseUrl;
    // Lazy: GLTFLoader is only imported when a pack actually loads, so
    // Node tooling/tests that never call this pay nothing.
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const modelLoader = new GLTFLoader();
    const textureLoader = new THREE.TextureLoader();

    for (const entry of this.manifest.models) {
      if (this.models.has(entry.id)) continue;
      try {
        const gltf = await modelLoader.loadAsync(joinUrl(base, entry.file));
        this.models.set(entry.id, gltf.scene);
        this.failures.delete(entry.id);
      } catch (err) {
        this.failures.set(
          entry.id,
          `model "${entry.id}": failed to load "${entry.file}": ${errMessage(err)}`,
        );
      }
    }
    for (const entry of this.manifest.textures) {
      if (this.textures.has(entry.id)) continue;
      try {
        const texture = await textureLoader.loadAsync(joinUrl(base, entry.file));
        texture.colorSpace = THREE.SRGBColorSpace;
        this.textures.set(entry.id, texture);
        this.failures.delete(entry.id);
      } catch (err) {
        this.failures.set(
          entry.id,
          `texture "${entry.id}": failed to load "${entry.file}": ${errMessage(err)}`,
        );
      }
    }
  }

  bodyMesh(body: BodyConfigRow): THREE.Object3D {
    const entry = this.manifest.models.find(
      (m) => m.forShape !== undefined && m.forShape === String(body.shapeKind),
    );
    const cached = entry !== undefined ? this.models.get(entry.id) : undefined;
    // clone(true): fresh node graph per entity, shared geometry/material (DOD:
    // one GPU upload per model no matter how many entities use it).
    if (cached !== undefined) return cached.clone(true);
    return placeholderBodyMesh(body);
  }

  terrainMesh(chunk: ChunkRow, worldSize: number): THREE.Object3D {
    const { cx, cz } = chunkCoords(chunk.chunkId);
    // Heightfield-displaced terrain (slice 4.1): see the client's
    // ClientAssetProvider.terrainMesh for the vertex↔sample mapping.
    // The 16 samples span the full 16-unit chunk (no gaps between tiles).
    const S = 16;
    const size = worldSize;
    const geometry = new THREE.PlaneGeometry(size, size, S - 1, S - 1);
    geometry.rotateX(-Math.PI / 2);
    const h = chunk.heights;
    if (h !== null && h.length === S * S) {
      const pos = geometry.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < S * S; v++) pos.setY(v, h[v]);
      pos.needsUpdate = true;
      geometry.computeVertexNormals();
    }
    const map = this.terrainTexture();
    const material = new THREE.MeshStandardMaterial({
      ...(map !== undefined ? { map } : { color: new THREE.Color(0x3d6b35) }),
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cx * worldSize + size / 2, 0, cz * worldSize + size / 2);
    return mesh;
  }

  /**
   * Load state of every manifest entry for the asset inspector UI:
   * models first, then textures. A "fallback" entry carries the reason —
   * either the load error or "never attempted" when loadAssetPack() hasn't
   * run (or hasn't succeeded) yet.
   */
  fallbackStatus(): AssetLoadStatus[] {
    const out: AssetLoadStatus[] = [];
    for (const entry of this.manifest.models) {
      out.push(this.statusOf(this.models.has(entry.id), `model "${entry.id}"`, entry.id));
    }
    for (const entry of this.manifest.textures) {
      out.push(this.statusOf(this.textures.has(entry.id), `texture "${entry.id}"`, entry.id));
    }
    return out;
  }

  private statusOf(loaded: boolean, label: string, id: string): AssetLoadStatus {
    if (loaded) return { id, status: "loaded" };
    return {
      id,
      status: "fallback",
      diagnostic:
        this.failures.get(id) ?? `${label} has not loaded (loadAssetPack not called or not yet successful)`,
    };
  }

  /** The pack's terrain texture: `forTerrain: true` wins, else an id of "terrain". */
  private terrainTexture(): THREE.Texture | undefined {
    const entry =
      this.manifest.textures.find((t) => t.forTerrain === true) ??
      this.manifest.textures.find((t) => t.id === "terrain");
    return entry !== undefined ? this.textures.get(entry.id) : undefined;
  }
}
