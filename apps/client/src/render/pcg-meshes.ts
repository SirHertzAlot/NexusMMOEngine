/**
 * PcgMeshes — cooked PICG asset meshes for the client, fetched from the
 * region's Pcg webrpc service (engine-core pcg.ridl) and kept as three.js
 * geometry. InstancedProps asks for the model an AssetRef shows; the first
 * ask starts the fetch (asset list, mesh ref, PCGM bytes) and answers
 * null, and `onChange` fires when the geometry is ready so the props move
 * from their placeholder to the real shape.
 *
 * One geometry per (asset, variant index, revision). An asset that isn't a
 * PCG asset, or a fetch that fails, stays a placeholder (a failure is
 * retried after RETRY_MS).
 */

import * as THREE from "three";
import { decodePcgMesh, type PcgAssetInfo, type PcgRpcClient } from "@mmo-engine/picg";
import type { PropModels } from "./instanced-props.js";

const RETRY_MS = 30_000;

/** PCGM mesh -> indexed BufferGeometry (colours to linear RGB). */
export function pcgGeometry(bytes: ArrayBuffer): THREE.BufferGeometry {
  const mesh = decodePcgMesh(bytes);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  if (mesh.normals) geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  else geometry.computeVertexNormals();
  const n = mesh.positions.length / 3;
  const rgb = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    if (mesh.colors) c.setRGB(mesh.colors[i * 4], mesh.colors[i * 4 + 1], mesh.colors[i * 4 + 2], THREE.SRGBColorSpace);
    else c.setRGB(0.8, 0.8, 0.8, THREE.SRGBColorSpace);
    rgb[i * 3] = c.r;
    rgb[i * 3 + 1] = c.g;
    rgb[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
  if (mesh.uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

export class PcgMeshes implements PropModels {
  private assets: Map<number, PcgAssetInfo> | null = null;
  private listing: Promise<void> | null = null;
  private readonly ready = new Map<string, THREE.BufferGeometry>();
  private readonly pending = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly rpc: PcgRpcClient,
    private readonly onChange: () => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Geometries ready. */
  get size(): number {
    return this.ready.size;
  }

  model(assetHash: number, variant: number): { key: string; geometry: THREE.BufferGeometry } | null {
    if (this.disposed) return null;
    if (!this.assets) {
      this.list();
      return null;
    }
    const info = this.assets.get(assetHash >>> 0);
    if (!info) return null;
    const vi = (variant >>> 0) % Math.max(1, info.variants);
    const key = `${info.assetHash}:${vi}:${info.revision}`;
    const geometry = this.ready.get(key);
    if (geometry) return { key, geometry };
    this.fetchMesh(key, info.assetHash, vi);
    return null;
  }

  dispose(): void {
    this.disposed = true;
    for (const g of this.ready.values()) g.dispose();
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
        const geometry = pcgGeometry(await this.rpc.download(ref));
        if (this.disposed) {
          geometry.dispose();
          return;
        }
        this.ready.set(key, geometry);
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
