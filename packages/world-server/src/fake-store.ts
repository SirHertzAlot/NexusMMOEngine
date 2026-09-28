/**
 * In-memory WorldStore. Used by unit tests and by `WORLD_DB_URL=mem:`
 * dev runs. Production uses SurrealWorldStore (src/surreal-store.ts).
 */
import type { RegionRecord, WorldStore } from "./types.js";

export class MemoryWorldStore implements WorldStore {
  private regions = new Map<string, RegionRecord>();
  private ops = new Map<string, unknown>();
  private registryVersion = 0;

  async upsertRegion(r: RegionRecord): Promise<void> {
    this.regions.set(r.regionId, { ...r });
  }

  async getRegion(regionId: string): Promise<RegionRecord | null> {
    const r = this.regions.get(regionId);
    return r ? { ...r } : null;
  }

  async getRegionByTokenHash(tokenHash: string): Promise<RegionRecord | null> {
    for (const r of this.regions.values()) {
      if (r.tokenHash === tokenHash) return { ...r };
    }
    return null;
  }

  async listRegions(): Promise<RegionRecord[]> {
    return [...this.regions.values()].map((r) => ({ ...r }));
  }

  async deleteRegion(regionId: string): Promise<void> {
    this.regions.delete(regionId);
  }

  async reapStaleRegions(cutoffMs: number): Promise<string[]> {
    const reaped: string[] = [];
    for (const [id, r] of this.regions) {
      if (r.lastHeartbeat < cutoffMs) {
        this.regions.delete(id);
        reaped.push(id);
      }
    }
    return reaped;
  }

  async getOpResult(opId: string): Promise<unknown | null> {
    return this.ops.has(opId) ? this.ops.get(opId) : null;
  }

  async storeOpResult(opId: string, result: unknown): Promise<void> {
    this.ops.set(opId, result);
  }

  async getRegistryVersion(): Promise<number> {
    return this.registryVersion;
  }

  async bumpRegistryVersion(): Promise<void> {
    this.registryVersion += 1;
  }
}
