/**
 * Zod schemas for every world-server op. This is the validation
 * boundary: adapters parse the raw transport payload through these
 * (strict, bounded) and hand the *parsed* value to the core — never
 * the raw payload. Same discipline as the gateway's hello/register.
 */
import { z } from "zod";

const REGION_ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const OP_ID = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const ENDPOINT = z.string().min(1).max(256);
const DIGEST = z.string().min(1).max(128).regex(/^[A-Za-z0-9+/=_-]+$/);

export const ChunkRangeSchema = z
  .object({
    x0: z.number().int().min(-1_000_000).max(1_000_000),
    x1: z.number().int().min(-1_000_000).max(1_000_000),
    z0: z.number().int().min(-1_000_000).max(1_000_000),
    z1: z.number().int().min(-1_000_000).max(1_000_000),
  })
  .strict()
  .refine((r) => r.x1 > r.x0 && r.z1 > r.z0, {
    message: "chunk range must have positive area",
  });

export const RegisterRegionSchema = z
  .object({
    regionId: REGION_ID,
    chunkRange: ChunkRangeSchema,
    endpoint: ENDPOINT,
    capacity: z.number().int().min(1).max(1_000_000),
    apiKey: z.string().min(8).max(256),
    opId: OP_ID,
  })
  .strict();

export const HeartbeatSchema = z
  .object({
    regionId: REGION_ID,
    load: z.number().min(0).max(1_000_000),
    tickJitterMs: z.number().min(0).max(60_000),
    entityCount: z.number().int().min(0).max(10_000_000),
  })
  .strict();

export const DeregisterSchema = z
  .object({ regionId: REGION_ID, opId: OP_ID })
  .strict();

export const SnapshotReportSchema = z
  .object({
    regionId: REGION_ID,
    tick: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    entityCount: z.number().int().min(0).max(10_000_000),
    digest: DIGEST,
  })
  .strict();

/** Serialized entity state cap: what one ECS entity can reasonably carry. */
export const MAX_ENTITY_STATE_BYTES = 64 * 1024;
const MIGRATION_ID = z.string().regex(/^mig-[0-9a-f]{24}$/);

export const BeginMigrationSchema = z
  .object({
    opId: OP_ID,
    entityId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_.-]+$/),
    fromRegion: REGION_ID,
    toRegion: REGION_ID,
    // An object (or null), bounded in size; its shape is the region's business.
    entityState: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict()
  .refine((m) => Buffer.byteLength(JSON.stringify(m.entityState)) <= MAX_ENTITY_STATE_BYTES, {
    message: `entityState over ${MAX_ENTITY_STATE_BYTES} bytes`,
    path: ["entityState"],
  });

export const CommitMigrationSchema = z
  .object({ migrationId: MIGRATION_ID, opId: OP_ID })
  .strict();

export const AbortMigrationSchema = z
  .object({ migrationId: MIGRATION_ID, opId: OP_ID, reason: z.string().max(200) })
  .strict();

export const GetMigrationSchema = z.object({ migrationId: MIGRATION_ID }).strict();

/** Bearer token format: 256-bit hex. */
export const BearerTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
