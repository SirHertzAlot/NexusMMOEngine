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

/** Slice B. */
export const BeginMigrationSchema = z
  .object({
    opId: OP_ID,
    entityId: z.string().min(1).max(128),
    fromRegion: REGION_ID,
    toRegion: REGION_ID,
  })
  .strict()
  .and(z.object({ entityState: z.unknown() }));

/** Bearer token format: 256-bit hex. */
export const BearerTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
