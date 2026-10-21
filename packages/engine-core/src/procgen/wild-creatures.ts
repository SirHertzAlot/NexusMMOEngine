/**
 * WildCreatures: the open world's packs, from the biome registry's creature
 * tables (open-world plan, Phase 5).
 *
 * Each chunk's packs are planned by `planChunkPacks` (pure: the same chunk
 * always holds the same packs). When a chunk loads, its packs spawn through
 * the CreatureSystem; when it unloads, the packs it spawned are removed,
 * wherever they have wandered. Creatures aren't written to chunk rows (they
 * carry PlayerIntent, which the streamer leaves alone), so a chunk's packs
 * come back fresh, at home and at full health, the next time it loads.
 *
 * It is the streamer's `contents` hook: `load` runs after a chunk's terrain
 * and scatter are in, `unload` before its entities are collected.
 */

import { entityExists } from "bitecs";
import type { ChunkContentsHook } from "../streaming/chunk-streamer.js";
import type { SimWorld } from "../world.js";
import { planChunkPacks, type BiomeRegistry, type PlannedPack } from "./biome-registry.js";
import { packChunk } from "../streaming/chunk-streamer.js";

/** The CreatureSystem methods WildCreatures uses. */
export interface PackSpawner {
  has(kind: string): boolean;
  spawnPack(sim: SimWorld, kind: string, x: number, z: number, size?: readonly [number, number]): number[];
  /** Still one of its creatures (an id freed by an admin despawn may be reused). */
  isCreature(e: number): boolean;
}

export interface WildCreaturesOptions {
  registry: BiomeRegistry;
  spawner: PackSpawner;
  /** 32-bit world seed (see ecologySeed32). */
  seed: number;
  chunkWorldSize: number;
  biomeAt: (x: number, z: number) => string | null;
  /** Packs whose centre is here are skipped: in water, or anywhere else creatures can't stand. Default: none. */
  blocked?: (x: number, z: number, aquatic: boolean) => boolean;
  /** More packs from another planner (the wildlife table, wildlife-table.ts), added to the registry's. */
  extraPlan?: (cx: number, cz: number) => PlannedPack[];
  /** One line per pack spawned (MMO_WILDLIFE_LOG=1). */
  log?: (line: string) => void;
}

export interface WildCreaturesStats {
  /** Packs alive now, and the creatures in them. */
  packs: number;
  creatures: number;
  /** Packs spawned and removed since start. */
  spawned: number;
  removed: number;
}

export class WildCreatures implements ChunkContentsHook {
  private readonly byChunk = new Map<number, number[]>();
  private readonly counters = { spawned: 0, removed: 0 };

  constructor(private readonly opts: WildCreaturesOptions) {}

  /** The packs chunk (cx, cz) holds, whether or not their kinds can spawn yet. */
  plan(cx: number, cz: number): PlannedPack[] {
    return [...planChunkPacks(this.opts.registry, {
      seed: this.opts.seed,
      cx,
      cz,
      chunkWorldSize: this.opts.chunkWorldSize,
      biomeAt: this.opts.biomeAt,
      spawnable: (k) => this.opts.spawner.has(k),
    }), ...(this.opts.extraPlan?.(cx, cz) ?? [])];
  }

  load(sim: SimWorld, cx: number, cz: number): void {
    const key = packChunk(cx, cz);
    if (this.byChunk.has(key)) return;
    const ids: number[] = [];
    for (const p of this.plan(cx, cz)) {
      if (this.opts.blocked?.(p.x, p.z, p.aquatic === true)) continue;
      const made = this.opts.spawner.spawnPack(sim, p.kind, p.x, p.z, p.pack);
      ids.push(...made);
      this.counters.spawned++;
      this.opts.log?.(`[wildlife] ${p.kind} x${made.length} at ${p.x.toFixed(0)}, ${p.z.toFixed(0)} (${p.biome}${p.aquatic ? ", water" : ""})`);
    }
    if (ids.length > 0) this.byChunk.set(key, ids);
  }

  unload(sim: SimWorld, cx: number, cz: number): void {
    const key = packChunk(cx, cz);
    const ids = this.byChunk.get(key);
    if (!ids) return;
    for (const e of ids) if (entityExists(sim.ecs, e) && this.opts.spawner.isCreature(e)) sim.despawn(e);
    this.byChunk.delete(key);
    this.counters.removed++;
  }

  stats(): WildCreaturesStats {
    let creatures = 0;
    for (const ids of this.byChunk.values()) creatures += ids.length;
    return { packs: this.byChunk.size, creatures, ...this.counters };
  }
}
