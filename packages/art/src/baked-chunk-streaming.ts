/**
 * Browser-safe Baked Asset Store B4 chunked delivery & on-demand streaming.
 *
 * Splits large asset bundles into a mandatory `base` chunk loaded at boot
 * plus on-demand `kit:<id>` and `region:<rx>_<rz>` chunks streamed with
 * SHA-256 hash verification and idempotent deduplication (no re-downloads).
 */

import { z } from "zod";
import { BakedChunkManifestSchema, type BakedChunkManifest } from "./baked-geometry.js";
import {
  BakedAssetProvider,
  defaultFetchBinary,
  defaultFetchJson,
  joinBakedUrl,
  sha256HexAsync,
  type BakedBinaryFetcher,
  type BakedJsonFetcher,
} from "./baked-provider.js";
import { errMessage } from "./util.js";

export const BakedStoreChunkEntrySchema = z.object({
  chunkId: z.string().min(1),
  kind: z.enum(["base", "kit", "region"]),
  chunkFile: z.string().min(1),
  manifestFile: z.string().min(1),
  chunkHash: z.string().regex(/^[0-9a-f]{64}$/),
  chunkBytes: z.number().int().nonnegative(),
  assetCount: z.number().int().nonnegative(),
  assetIds: z.array(z.string().min(1)),
});

export const BakedStoreIndexManifestSchema = z.object({
  version: z.literal(1),
  target: z.enum(["own-game", "shipped-prototype-pack"]),
  baseChunkId: z.string().min(1),
  chunks: z.array(BakedStoreChunkEntrySchema),
  assetToChunk: z.record(z.string(), z.string()),
});

export type BakedStoreChunkEntry = z.infer<typeof BakedStoreChunkEntrySchema>;
export type BakedStoreIndexManifest = z.infer<typeof BakedStoreIndexManifestSchema>;

export function chunkIdToKind(chunkId: string): "base" | "kit" | "region" {
  if (chunkId === "base") return "base";
  if (chunkId.startsWith("kit:")) return "kit";
  return "region";
}

export function chunkManifestFilename(chunkId: string): string {
  const safe = chunkId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `manifests/${safe}.baked.json`;
}

export function resolveRegionChunkId(x: number, z: number, regionSize = 128): string {
  if (!(regionSize > 0)) throw new Error(`regionSize must be positive, got ${regionSize}`);
  return `region:${Math.floor(x / regionSize)}_${Math.floor(z / regionSize)}`;
}

export interface ChunkedBakedAssetClientOptions {
  provider: BakedAssetProvider;
  baseUrl?: string;
  indexFile?: string;
  index?: BakedStoreIndexManifest;
  fetchBinary?: BakedBinaryFetcher;
  fetchJson?: BakedJsonFetcher;
  verifyHash?: boolean;
  /** Optional custom chunk mount hook (e.g. SabBakedLoader worker placement). */
  mountChunk?: (manifest: BakedChunkManifest, bytes: Uint8Array) => Promise<void> | void;
}

export class ChunkedBakedAssetClient {
  readonly provider: BakedAssetProvider;
  private readonly baseUrl: string;
  private readonly indexFile: string;
  private readonly fetchBinary: BakedBinaryFetcher;
  private readonly fetchJson: BakedJsonFetcher;
  private readonly verifyHash: boolean;
  private readonly mountChunk: (manifest: BakedChunkManifest, bytes: Uint8Array) => Promise<void> | void;

  private index: BakedStoreIndexManifest | null = null;
  private indexPromise: Promise<BakedStoreIndexManifest> | null = null;
  private readonly chunkManifests = new Map<string, BakedChunkManifest>();
  private readonly inflightChunks = new Map<string, Promise<BakedChunkManifest>>();
  private readonly failures = new Map<string, string>();
  private downloadedChunks = 0;

  constructor(options: ChunkedBakedAssetClientOptions) {
    this.provider = options.provider;
    this.baseUrl = options.baseUrl ?? "/baked/";
    this.indexFile = options.indexFile ?? "index.baked.json";
    this.fetchBinary = options.fetchBinary ?? defaultFetchBinary;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.verifyHash = options.verifyHash ?? true;
    this.mountChunk =
      options.mountChunk ?? ((manifest, bytes) => this.provider.registerBakedChunk(manifest, bytes));
    if (options.index) {
      this.index = BakedStoreIndexManifestSchema.parse(options.index);
    }
  }

  get fetchedChunkCount(): number {
    return this.downloadedChunks;
  }

  getIndex(): BakedStoreIndexManifest | null {
    return this.index;
  }

  loadedChunkIds(): string[] {
    return this.provider.loadedChunkIds;
  }

  failedChunks(): ReadonlyMap<string, string> {
    return this.failures;
  }

  /** Fetch and validate the root index manifest once. */
  async loadIndex(): Promise<BakedStoreIndexManifest> {
    if (this.index) return this.index;
    if (this.indexPromise) return this.indexPromise;
    this.indexPromise = (async () => {
      const raw = await this.fetchJson(joinBakedUrl(this.baseUrl, this.indexFile));
      const parsed = BakedStoreIndexManifestSchema.parse(raw);
      this.index = parsed;
      return parsed;
    })();
    try {
      return await this.indexPromise;
    } finally {
      this.indexPromise = null;
    }
  }

  /** Boot-time load: fetches ONLY the index and mandatory `base` chunk. */
  async boot(): Promise<BakedChunkManifest> {
    const idx = await this.loadIndex();
    return this.ensureChunk(idx.baseChunkId);
  }

  /**
   * Stream and mount one chunk on demand, deduplicating inflight downloads and
   * never re-downloading already mounted chunks. Rejects fail-closed on hash
   * or length mismatch without mounting tampered bytes.
   */
  async ensureChunk(chunkId: string): Promise<BakedChunkManifest> {
    const existing = this.chunkManifests.get(chunkId);
    if (existing && this.provider.hasChunk(chunkId)) return existing;

    const inflight = this.inflightChunks.get(chunkId);
    if (inflight) return inflight;

    const promise = (async () => {
      const idx = await this.loadIndex();
      const entry = idx.chunks.find((c) => c.chunkId === chunkId);
      if (!entry) {
        throw new Error(`unknown baked chunk "${chunkId}" in index`);
      }
      try {
        const rawManifest = await this.fetchJson(joinBakedUrl(this.baseUrl, entry.manifestFile));
        const manifest = BakedChunkManifestSchema.parse(rawManifest);
        if (manifest.chunkId !== entry.chunkId) {
          throw new Error(
            `chunk manifest id mismatch: expected "${entry.chunkId}", got "${manifest.chunkId}"`,
          );
        }
        if (manifest.chunkHash !== entry.chunkHash) {
          throw new Error(
            `chunk manifest hash mismatch for "${chunkId}": expected ${entry.chunkHash}, got ${manifest.chunkHash}`,
          );
        }

        const bytes = await this.fetchBinary(joinBakedUrl(this.baseUrl, entry.chunkFile));
        if (bytes.byteLength !== entry.chunkBytes || manifest.chunkBytes !== bytes.byteLength) {
          throw new Error(
            `chunk "${chunkId}" byte length mismatch: got ${bytes.byteLength}, expected ${entry.chunkBytes}`,
          );
        }
        if (this.verifyHash) {
          const actualHash = await sha256HexAsync(bytes);
          if (!actualHash) {
            throw new Error(`SHA-256 verification unavailable in runtime for chunk "${chunkId}"`);
          }
          if (actualHash !== entry.chunkHash) {
            throw new Error(
              `chunk "${chunkId}" SHA-256 mismatch: got ${actualHash}, expected ${entry.chunkHash}`,
            );
          }
        }

        await this.mountChunk(manifest, bytes);
        this.downloadedChunks++;
        this.chunkManifests.set(chunkId, manifest);
        this.failures.delete(chunkId);
        return manifest;
      } catch (err) {
        const msg = errMessage(err);
        this.failures.set(chunkId, msg);
        throw err;
      } finally {
        this.inflightChunks.delete(chunkId);
      }
    })();

    this.inflightChunks.set(chunkId, promise);
    return promise;
  }

  /** Stream a region chunk (`region:<id>`) on entry if not already loaded. */
  async ensureRegion(regionId: string): Promise<BakedChunkManifest> {
    return this.ensureChunk(regionId.startsWith("region:") ? regionId : `region:${regionId}`);
  }

  /** Stream a kit chunk (`kit:<id>`) on demand if not already loaded. */
  async ensureKit(kitId: string): Promise<BakedChunkManifest> {
    return this.ensureChunk(kitId.startsWith("kit:") ? kitId : `kit:${kitId}`);
  }

  /** Stream the chunk owning `assetId` if present in `index.assetToChunk`. */
  async ensureAsset(assetId: string): Promise<string | null> {
    const idx = await this.loadIndex();
    const chunkId = idx.assetToChunk[assetId];
    if (!chunkId) return null;
    await this.ensureChunk(chunkId);
    return chunkId;
  }
}
