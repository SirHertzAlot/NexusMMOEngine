/**
 * In-memory WorldStore. Used by unit tests and by `WORLD_DB_URL=mem:`
 * dev runs. Production uses SurrealWorldStore (src/surreal-store.ts).
 */
import type { MigrationRecord, MigrationState, RegionRecord, StoredDungeonRun, WorldStore } from "./types.js";

export class MemoryWorldStore implements WorldStore {
  private regions = new Map<string, RegionRecord>();
  private ops = new Map<string, unknown>();
  private registryVersion = 0;
  private migrations = new Map<string, MigrationRecord>();

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

  async createMigration(m: MigrationRecord): Promise<void> {
    this.migrations.set(m.migrationId, { ...m });
  }

  async getMigration(migrationId: string): Promise<MigrationRecord | null> {
    const m = this.migrations.get(migrationId);
    return m ? { ...m } : null;
  }

  async getBegunMigrationForEntity(entityId: string): Promise<MigrationRecord | null> {
    for (const m of this.migrations.values()) {
      if (m.entityId === entityId && m.state === "begun") return { ...m };
    }
    return null;
  }

  async resolveMigration(migrationId: string, to: Exclude<MigrationState, "begun">, reason: string, now: number): Promise<MigrationRecord | null> {
    const m = this.migrations.get(migrationId);
    if (!m || m.state !== "begun") return null;
    m.state = to;
    m.reason = reason;
    m.updatedAt = now;
    return { ...m };
  }

  async listMigrationsForRegion(regionId: string, sinceMs: number): Promise<MigrationRecord[]> {
    return [...this.migrations.values()]
      .filter((m) => (m.fromRegion === regionId || m.toRegion === regionId) && (m.state === "begun" || m.updatedAt >= sinceMs))
      .map((m) => ({ ...m }));
  }

  async listBegunBefore(cutoffMs: number): Promise<string[]> {
    return [...this.migrations.values()].filter((m) => m.state === "begun" && m.createdAt < cutoffMs).map((m) => m.migrationId);
  }

  async pruneMigrations(cutoffMs: number): Promise<number> {
    let n = 0;
    for (const [id, m] of this.migrations) {
      if (m.state !== "begun" && m.updatedAt < cutoffMs) { this.migrations.delete(id); n++; }
    }
    return n;
  }

  private dungeonRuns = new Map<string, StoredDungeonRun>();

  async recordDungeonRun(run: StoredDungeonRun): Promise<boolean> {
    if (this.dungeonRuns.has(run.instance)) return false;
    this.dungeonRuns.set(run.instance, { ...run });
    return true;
  }

  async listDungeonRuns(regionId?: string): Promise<StoredDungeonRun[]> {
    return [...this.dungeonRuns.values()]
      .filter((r) => regionId === undefined || r.regionId === regionId)
      .map((r) => ({ ...r }));
  }
}
