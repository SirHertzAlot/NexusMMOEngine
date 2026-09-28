/**
 * Spawn table — maps mesh asset ids to ECS spawn archetypes.
 *
 * The scatter pipeline ends at SpawnRecords (reference.ts); the spawn
 * table resolves them into EntitySpawns: the exact handoff shape region
 * integration (PCG slice 4) consumes to create entities. The table is
 * authored alongside the graph and validated at cook time, so an asset
 * id typo fails the cook — never the region.
 *
 * Asset identity: the manifest (`packages/art`) names models by string
 * id. The ECS AssetRef component stores `fnv1a32(assetId)` (u32) +
 * variant (u16) — flat and DOD-friendly, no strings in SoA. fnv1a32 is
 * specified here once so JS, C++, and tests agree.
 */
import { z } from "zod";
import type { SpawnRecord } from "./reference.js";

/** FNV-1a 32-bit. Portable: trivially reproducible in C++. */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const CollisionSchema = z.object({
  shape: z.enum(["box", "sphere", "none"]),
  halfExtents: z.tuple([z.number(), z.number(), z.number()]).optional(),
  radius: z.number().positive().optional(),
  motion: z.enum(["static", "kinematic", "dynamic"]).default("static"),
});

export const SpawnArchetypeSchema = z.object({
  /** Manifest model id (mirrors the record key; kept for readability). */
  asset: z.string().min(1),
  /** Optional rigid-body config → BodyConfig component at spawn. */
  collision: CollisionSchema.optional(),
  /** Optional health → Health component at spawn. */
  health: z.object({ max: z.number().positive() }).optional(),
});
export type SpawnArchetype = z.infer<typeof SpawnArchetypeSchema>;

export const SpawnTableSchema = z.object({
  version: z.literal(1, "unsupported spawn-table version"),
  /** asset id -> archetype. */
  archetypes: z.record(z.string(), SpawnArchetypeSchema),
});
export type SpawnTable = z.infer<typeof SpawnTableSchema>;

export function parseSpawnTableJSON(json: unknown): SpawnTable {
  return SpawnTableSchema.parse(json);
}

/**
 * Entity spawn descriptor — the slice-4 handoff. One per spawn record,
 * with the asset id resolved to its u32 hash and the archetype attached.
 */
export interface EntitySpawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  sx: number;
  sy: number;
  sz: number;
  /** Manifest model id. */
  assetId: string;
  /** fnv1a32(assetId) — the ECS AssetRef.assetHash value. */
  assetHash: number;
  /** u16 variant selector for the art provider. */
  variant: number;
  /** u32 point seed (stable identity). */
  seed: number;
  archetype: SpawnArchetype;
}

/**
 * Resolve spawn records against the table. Throws on any asset id
 * missing from the table — cook-time failure, not region-time.
 */
export function resolveSpawns(
  records: SpawnRecord[],
  table: SpawnTable,
): EntitySpawn[] {
  return records.map((r) => {
    const archetype = table.archetypes[r.asset];
    if (!archetype) {
      throw new Error(
        `spawn record references unknown asset "${r.asset}" (not in spawn table)`,
      );
    }
    return {
      x: r.x,
      y: r.y,
      z: r.z,
      yaw: r.yaw,
      pitch: r.pitch,
      roll: r.roll,
      sx: r.sx,
      sy: r.sy,
      sz: r.sz,
      assetId: r.asset,
      assetHash: fnv1a32(r.asset),
      variant: (r.variantSeed >>> 16) & 0xffff,
      seed: r.seed,
      archetype,
    };
  });
}
