/**
 * BakedAssetProvider — browser-safe runtime `AssetProvider` backed by baked
 * SoA binary geometry chunks and manifests (`BAKED-ASSET-STORE-SPEC.md §5 B1`).
 *
 * Swappable 1:1 with `ManifestAssetProvider` / `PlaceholderAssets` behind the
 * shared `AssetProvider` interface:
 * - Decodes SoA vertex/index columns directly into `THREE.BufferGeometry`
 *   (no GLTF/GLB runtime parsing).
 * - Deduplicates GPU `BufferGeometry` + `Material` across identical `canonicalId`
 *   entries and shares them across cloned instances.
 * - Preserves placeholder fallback per rejected or unloaded asset entry.
 */

import * as THREE from "three";
import type { AssetRefRow, BodyConfigRow, ChunkRow } from "@mmo-engine/protocol";
import {
  BakedChunkManifestSchema,
  buildObjectFromBakedRecord,
  decodeBakedGeometryRecord,
  type BakedChunkAssetEntry,
  type BakedChunkManifest,
  type BakedGeometryRecord,
} from "./baked-geometry.js";
import {
  placeholderBodyMesh,
  placeholderTerrainMesh,
  type AssetLoadStatus,
  type AssetProvider,
} from "./provider.js";
import { errMessage } from "./util.js";

export type BakedBinaryFetcher = (url: string) => Promise<Uint8Array>;
export type BakedJsonFetcher = (url: string) => Promise<unknown>;

export interface BakedAssetProviderOptions {
  /** Base URL used to resolve manifest and `.chunk` files (default `"/baked/"`). */
  baseUrl?: string;
  /** Default manifest filename relative to `baseUrl` when `manifest` is not pre-supplied. */
  manifestFile?: string;
  /** Pre-loaded validated baked chunk manifest (optional; skips manifest HTTP fetch). */
  manifest?: BakedChunkManifest;
  /** Optional pre-loaded chunk bytes paired with `manifest`. */
  chunkBytes?: Uint8Array;
  /** Custom binary fetcher (default uses `fetch()`). */
  fetchBinary?: BakedBinaryFetcher;
  /** Custom JSON fetcher (default uses `fetch()`). */
  fetchJson?: BakedJsonFetcher;
  /** Custom placeholder fallback delegate (e.g. client `PlaceholderAssets` with shading). */
  placeholder?: Pick<AssetProvider, "bodyMesh" | "terrainMesh">;
  /** Verify SHA-256 of loaded chunk bytes against `manifest.chunkHash` via WebCrypto when available. */
  verifyHash?: boolean;
}

export function joinBakedUrl(base: string, rel: string): string {
  const cleanRel = rel.replace(/^\/+/, "");
  if (!base) return cleanRel;
  return base.endsWith("/") ? base + cleanRel : base + "/" + cleanRel;
}

export async function defaultFetchBinary(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching "${url}"`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching "${url}"`);
  return res.json();
}

export async function sha256HexAsync(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class BakedAssetProvider implements AssetProvider {
  private readonly baseUrl: string;
  private readonly manifestFile: string;
  private readonly fetchBinary: BakedBinaryFetcher;
  private readonly fetchJson: BakedJsonFetcher;
  private readonly placeholder?: Pick<AssetProvider, "bodyMesh" | "terrainMesh">;
  private readonly verifyHash: boolean;

  private manifest: BakedChunkManifest | null = null;
  private readonly manifests = new Map<string, BakedChunkManifest>();
  private readonly mountedChunks = new Set<string>();
  private readonly templatesByCanonical = new Map<string, THREE.Mesh>();
  private readonly meshByAssetHash = new Map<number, THREE.Mesh>();
  private readonly meshByShape = new Map<string, THREE.Mesh>();
  private readonly loadedIds = new Set<string>();
  private readonly failures = new Map<string, string>();
  private readonly sharedMaterials = new Map<string, THREE.MeshStandardMaterial>();

  constructor(options: BakedAssetProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? "/baked/";
    this.manifestFile = options.manifestFile ?? "baked.json";
    this.fetchBinary = options.fetchBinary ?? defaultFetchBinary;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.placeholder = options.placeholder;
    this.verifyHash = options.verifyHash ?? true;

    if (options.manifest) {
      this.setManifest(options.manifest);
      if (options.chunkBytes) {
        this.registerBakedChunk(this.manifest!, options.chunkBytes);
      }
    }
  }

  private setManifest(raw: BakedChunkManifest): BakedChunkManifest {
    const parsed = BakedChunkManifestSchema.parse(raw);
    if (!this.manifest) this.manifest = parsed;
    this.manifests.set(parsed.chunkId, parsed);
    for (const r of parsed.rejected) {
      this.failures.set(r.id, `bake rejected "${r.id}": ${r.reason}`);
    }
    return parsed;
  }

  hasChunk(chunkId: string): boolean {
    return this.mountedChunks.has(chunkId);
  }

  get loadedChunkIds(): string[] {
    return [...this.mountedChunks];
  }

  private bindBakedRecord(entry: BakedChunkAssetEntry, record: BakedGeometryRecord): void {
    let template = this.templatesByCanonical.get(entry.canonicalId);
    if (!template) {
      template = buildObjectFromBakedRecord(record, this.sharedMaterials);
      template.name = entry.canonicalId;
      this.templatesByCanonical.set(entry.canonicalId, template);
    }
    this.meshByAssetHash.set(entry.assetHash >>> 0, template);
    if (entry.forShape !== undefined) {
      this.meshByShape.set(entry.forShape, template);
    }
    this.loadedIds.add(entry.id);
    this.failures.delete(entry.id);
  }

  /** Synchronously decode and bind all non-rejected entries from one loaded chunk buffer. */
  registerBakedChunk(rawManifest: BakedChunkManifest, chunkBytes: Uint8Array): void {
    const manifest = this.setManifest(rawManifest);
    if (chunkBytes.byteLength !== manifest.chunkBytes) {
      const msg = `chunk "${manifest.chunkId}" byte length ${chunkBytes.byteLength} != expected ${manifest.chunkBytes}`;
      for (const a of manifest.assets) this.failures.set(a.id, msg);
      return;
    }

    for (const entry of manifest.assets) {
      try {
        const record = decodeBakedGeometryRecord(chunkBytes, entry.byteOffset, entry.byteLength);
        this.bindBakedRecord(entry, record);
      } catch (err) {
        this.failures.set(entry.id, `decode "${entry.id}": ${errMessage(err)}`);
      }
    }
    this.mountedChunks.add(manifest.chunkId);
  }

  /**
   * Bind pre-decoded SoA geometry records (such as zero-copy SharedArrayBuffer
   * views placed by the B3 worker pipeline) directly into this provider.
   */
  registerBakedRecords(
    rawManifest: BakedChunkManifest,
    records: ReadonlyMap<string, BakedGeometryRecord>,
  ): void {
    const manifest = this.setManifest(rawManifest);
    for (const entry of manifest.assets) {
      try {
        const rec = records.get(entry.id) ?? records.get(entry.canonicalId);
        if (!rec) {
          this.failures.set(entry.id, `missing pre-decoded record for "${entry.id}" in chunk "${manifest.chunkId}"`);
          continue;
        }
        this.bindBakedRecord(entry, rec);
      } catch (err) {
        this.failures.set(entry.id, `bind "${entry.id}": ${errMessage(err)}`);
      }
    }
    this.mountedChunks.add(manifest.chunkId);
  }

  /**
   * Fetch and register the baked kit manifest + `.chunk` payload.
   * Never throws on missing/corrupt chunk or rejected entry: degraded assets
   * fall back to procedural placeholders with diagnostics recorded in `fallbackStatus()`.
   */
  async loadAssetPack(url: string): Promise<void> {
    const base = url.length > 0 ? url : this.baseUrl;
    let activeManifest: BakedChunkManifest | null = this.manifest;
    try {
      activeManifest = this.manifest ?? this.setManifest(
        BakedChunkManifestSchema.parse(await this.fetchJson(joinBakedUrl(base, this.manifestFile))),
      );
      if (activeManifest.assets.every((a) => this.loadedIds.has(a.id))) {
        this.mountedChunks.add(activeManifest.chunkId);
        return;
      }

      const bytes = await this.fetchBinary(joinBakedUrl(base, activeManifest.chunkFile));
      if (this.verifyHash) {
        const actualHash = await sha256HexAsync(bytes);
        if (actualHash && actualHash !== activeManifest.chunkHash) {
          throw new Error(`chunk SHA-256 mismatch: got ${actualHash}, expected ${activeManifest.chunkHash}`);
        }
      }
      this.registerBakedChunk(activeManifest, bytes);
    } catch (err) {
      const msg = errMessage(err);
      if (activeManifest) {
        for (const entry of activeManifest.assets) {
          if (!this.loadedIds.has(entry.id)) this.failures.set(entry.id, msg);
        }
      } else {
        this.failures.set(this.manifestFile, msg);
      }
    }
  }

  assetMesh(ref: AssetRefRow): THREE.Object3D | undefined {
    const template = this.meshByAssetHash.get(ref.assetHash >>> 0);
    return template ? template.clone(false) : undefined;
  }

  bodyMesh(body: BodyConfigRow): THREE.Object3D {
    const template = this.meshByShape.get(String(body.shapeKind));
    if (template) return template.clone(false);
    return this.placeholder ? this.placeholder.bodyMesh(body) : placeholderBodyMesh(body);
  }

  terrainMesh(chunk: ChunkRow, worldSize: number): THREE.Object3D {
    return this.placeholder ? this.placeholder.terrainMesh(chunk, worldSize) : placeholderTerrainMesh(chunk, worldSize);
  }

  fallbackStatus(): AssetLoadStatus[] {
    const out: AssetLoadStatus[] = [];
    const seen = new Set<string>();
    if (this.manifests.size > 0) {
      for (const manifest of this.manifests.values()) {
        for (const a of manifest.assets) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          if (this.loadedIds.has(a.id)) {
            out.push({ id: a.id, status: "loaded" });
          } else {
            out.push({
              id: a.id,
              status: "fallback",
              diagnostic: this.failures.get(a.id) ?? `baked asset "${a.id}" not loaded yet`,
            });
          }
        }
        for (const r of manifest.rejected) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          out.push({
            id: r.id,
            status: "fallback",
            diagnostic: this.failures.get(r.id) ?? r.reason,
          });
        }
      }
    } else if (this.failures.size > 0) {
      for (const [id, diagnostic] of this.failures) {
        out.push({ id, status: "fallback", diagnostic });
      }
    }
    return out;
  }

  dispose(): void {
    const seenGeo = new Set<THREE.BufferGeometry>();
    for (const mesh of this.templatesByCanonical.values()) {
      if (!seenGeo.has(mesh.geometry)) {
        seenGeo.add(mesh.geometry);
        mesh.geometry.dispose();
      }
    }
    this.templatesByCanonical.clear();
    this.meshByAssetHash.clear();
    this.meshByShape.clear();
    this.loadedIds.clear();
    for (const mat of this.sharedMaterials.values()) mat.dispose();
    this.sharedMaterials.clear();
  }
}
