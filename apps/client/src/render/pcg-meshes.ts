/**
 * PcgMeshes — cooked PICG asset meshes for the client, fetched from the
 * region's Pcg webrpc service (engine-core pcg.ridl) and kept as three.js
 * geometry. InstancedProps asks for the model an AssetRef shows; the first
 * ask starts the fetch (asset list, mesh ref, PCGM bytes) and answers
 * null, and `onChange` fires when the geometry is ready so the props move
 * from their placeholder to the real shape.
 *
 * One geometry per (asset, variant index, revision), with the level-of-
 * detail chain the server simplified (meshoptimizer) when it has one: the
 * levels download with the full mesh, and InstancedProps switches between
 * them with distance (lod.ts). An asset that isn't a PCG asset, or a fetch
 * that fails, stays a placeholder (a failure is retried after RETRY_MS).
 */

import * as THREE from "three";
import type { PcgAssetInfo, PcgRpcClient } from "@mmo-engine/picg";
import { decodePcg } from "../workers/handlers/pcg.js";
import type { WorkerRequester } from "../workers/pool.js";
import type { PcgResultPayload } from "../workers/types.js";
import { ensureBoundsTreeAsync } from "./bvh.js";
import type { PropModels } from "./instanced-props.js";
import { lodDistance, modelScale, type LodLevel } from "./lod.js";

const RETRY_MS = 30_000;

/** Decoded PCGM arrays (decodePcg, here or in a worker) -> indexed BufferGeometry (colours to linear RGB). */
export function buildPcgGeometry(mesh: PcgResultPayload): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.position, 3));
  // A mesh with material slots (a dungeon shell) draws as one group per slot, the triangles sorted so each slot's are
  // contiguous: the material array is indexed by slot, and the slot names ride along for the caller to pick materials by.
  if (mesh.materials && mesh.materials.length > 1 && mesh.triangleMaterial && mesh.triangleMaterial.length * 3 === mesh.index.length) {
    const slots = mesh.materials.length;
    const counts = new Uint32Array(slots);
    for (const s of mesh.triangleMaterial) counts[s]++;
    const starts = new Uint32Array(slots);
    for (let s = 1; s < slots; s++) starts[s] = starts[s - 1] + counts[s - 1] * 3;
    const fill = starts.slice();
    const sorted = new Uint32Array(mesh.index.length);
    for (let t = 0; t < mesh.triangleMaterial.length; t++) {
      const s = mesh.triangleMaterial[t];
      sorted.set(mesh.index.subarray(t * 3, t * 3 + 3), fill[s]);
      fill[s] += 3;
    }
    geometry.setIndex(new THREE.BufferAttribute(sorted, 1));
    for (let s = 0; s < slots; s++) if (counts[s] > 0) geometry.addGroup(starts[s], counts[s] * 3, s);
    geometry.userData.slots = mesh.materials;
  } else geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
  if (mesh.normal) geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normal, 3));
  else geometry.computeVertexNormals();
  const n = mesh.position.length / 3;
  const rgb = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    if (mesh.color) c.setRGB(mesh.color[i * 3], mesh.color[i * 3 + 1], mesh.color[i * 3 + 2], THREE.SRGBColorSpace);
    else c.setRGB(0.8, 0.8, 0.8, THREE.SRGBColorSpace);
    rgb[i * 3] = c.r;
    rgb[i * 3 + 1] = c.g;
    rgb[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
  if (mesh.uv) geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uv, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

/** PCGM bytes -> geometry, decoded on this thread. */
export const pcgGeometry = (bytes: ArrayBuffer): THREE.BufferGeometry => buildPcgGeometry(decodePcg(bytes));

export class PcgMeshes implements PropModels {
  private assets: Map<number, PcgAssetInfo> | null = null;
  private listing: Promise<void> | null = null;
  private readonly ready = new Map<string, { geometry: THREE.BufferGeometry; lods: LodLevel[] }>();
  private readonly pending = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly rpc: PcgRpcClient,
    private readonly onChange: () => void,
    private readonly now: () => number = () => performance.now(),
    /** Decode meshes and build their BVHs off the main thread. */
    private readonly workers?: WorkerRequester,
    /** Materials for a mesh with material slots, by slot name (a dungeon shell's palette); absent: its vertex colours. */
    private readonly materialFor?: (slots: readonly string[]) => THREE.Material[] | undefined,
  ) {}

  /** Download, decode (worker or inline) and, with workers, give it a BVH. */
  private async load(ref: Parameters<PcgRpcClient["download"]>[0]): Promise<THREE.BufferGeometry> {
    const bytes = await this.rpc.download(ref);
    if (!this.workers) return pcgGeometry(bytes);
    const geometry = buildPcgGeometry(await this.workers.request("pcg", { bytes }));
    await ensureBoundsTreeAsync(geometry, this.workers);
    return geometry;
  }

  /** Geometries ready. */
  get size(): number {
    return this.ready.size;
  }

  /** Meshes requested and still downloading or decoding (LS1's load gate waits on these). */
  get pendingCount(): number {
    return this.pending.size;
  }

  model(assetHash: number, variant: number): { key: string; geometry: THREE.BufferGeometry; material?: THREE.Material[]; lods: LodLevel[] } | null {
    if (this.disposed) return null;
    if (!this.assets) {
      this.list();
      return null;
    }
    const info = this.assets.get(assetHash >>> 0);
    if (!info) return null;
    const vi = (variant >>> 0) % Math.max(1, info.variants);
    const key = `${info.assetHash}:${vi}:${info.revision}`;
    const ready = this.ready.get(key);
    if (ready) {
      const slots = ready.geometry.userData.slots as string[] | undefined;
      const material = slots ? this.materialFor?.(slots) : undefined;
      return { key, ...ready, ...(material ? { material } : {}) };
    }
    this.fetchMesh(key, info.assetHash, vi);
    return null;
  }

  dispose(): void {
    this.disposed = true;
    for (const r of this.ready.values()) {
      r.geometry.dispose();
      for (const l of r.lods) l.geometry.dispose();
    }
    this.ready.clear();
  }

  private list(): void {
    if (this.listing) return;
    this.listing = this.rpc
      .listAssets()
      .then((assets) => {
        this.assets = new Map(assets.map((a) => [a.assetHash >>> 0, a]));
        if (!this.disposed) this.onChange();
      })
      .catch((err: unknown) => {
        console.warn("[pcg] asset list unavailable; props stay placeholders:", (err as Error).message);
        setTimeout(() => (this.listing = null), RETRY_MS);
      });
  }

  private fetchMesh(key: string, assetHash: number, vi: number): void {
    if (this.pending.has(key)) return;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.now() - failed < RETRY_MS) return;
    this.pending.add(key);
    void (async () => {
      try {
        const ref = await this.rpc.getAssetMesh(assetHash, vi);
        if (!ref.url) throw new Error("the server has no mesh for it (no cooker?)");
        const geometry = await this.load(ref);
        // The LOD chain, most detailed first; its errors are relative to the model's size.
        const scale = modelScale(geometry);
        const lods = await Promise.all(
          (ref.lods ?? []).map(async (l, i): Promise<LodLevel> => ({
            geometry: await this.load(l),
            distance: lodDistance(l.error * scale, i + 1),
            error: l.error * scale,
          })),
        );
        if (this.disposed) {
          geometry.dispose();
          for (const l of lods) l.geometry.dispose();
          return;
        }
        this.ready.set(key, { geometry, lods });
        this.failedAt.delete(key);
        this.onChange();
      } catch (err) {
        this.failedAt.set(key, this.now());
        console.warn(`[pcg] mesh ${key} unavailable:`, (err as Error).message);
      } finally {
        this.pending.delete(key);
      }
    })();
  }
}
