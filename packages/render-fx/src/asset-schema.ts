/**
 * Zod schema for EffectDefinition + v1 migration + $param resolution.
 * [PROPOSED, PR1] packages/render-fx/src/asset-schema.ts
 */
import { z } from "zod";
import { FX_TIERS, type EffectDefinition, type ParamValue } from "./types.js";

// ParamValue union, ordered most-specific-first:
// - exact 3-tuples are vec3 (offsets/positions in metres)
// - other finite-number arrays are ramp/curve LUT stops (1..512 entries)
const vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const lutSchema = z.array(z.number().finite()).min(1).max(512);

const paramValueSchema = z.union(
  [z.number().finite(), vec3Schema, z.string().min(1).max(256), z.number().finite().array().min(4).max(512)],
  // 1- and 2-element arrays are rejected: vec3 is exactly 3, LUTs need >= 4 stops.
);

const paramDeclSchema = z
  .object({
    type: z.enum(["float", "vec3", "color", "ramp", "curve", "enum", "int"]),
    default: paramValueSchema,
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    options: z.array(z.string().min(1).max(64)).max(64).optional(),
    units: z.enum(["s", "m", "x", "deg"]).optional(),
  })
  .strict();

const bindingSchema = z
  .object({
    kind: z.enum(["local", "world", "entity", "socket"]),
    entityId: z.string().min(1).max(64).optional(),
    socket: z.string().min(1).max(64).optional(),
    offset: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
    pos: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
    normal: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  })
  .strict();

const FX_MODULES = [
  "ShellModule",
  "RingBurstModule",
  "PoolModule",
  "TrailModule",
  "MuzzleFlashModule",
  "ShieldModule",
] as const;

const moduleDefSchema = z
  .object({
    module: z.enum(FX_MODULES),
    params: z.record(z.string().min(1).max(64), paramValueSchema),
    ramp: z.string().min(1).max(128).optional(),
    curve: z.string().min(1).max(128).optional(),
  })
  .strict();

const tierSchema = z.enum(FX_TIERS);

export const effectDefinitionSchema = z
  .object({
    assetId: z.string().min(1).max(128),
    version: z.literal(1),
    kind: z.enum(["oneshot", "persistent"]),
    params: z.record(z.string().min(1).max(64), paramDeclSchema),
    modules: z.array(moduleDefSchema).min(1).max(8),
    bindings: z.array(bindingSchema).min(1).max(8),
    timing: z
      .object({
        duration: z.number().finite(),
        loop: z.enum(["once", "loop", "pingpong"]),
        seedable: z.boolean(),
      })
      .strict(),
    quality: z
      .object({
        minTier: tierSchema,
        // Partial tiers: absent tier = no override (shield sets low: 0 to disable on Low).
        slotCaps: z.partialRecord(tierSchema, z.number().int().min(0).max(1024)).optional(),
      })
      .strict(),
    onOrphan: z.enum(["fade", "detach", "kill"]),
  })
  .strict();

export type ValidateResult = { ok: true; def: EffectDefinition } | { ok: false; issues: string[] };

export function validateAsset(json: unknown): ValidateResult {
  const parsed = effectDefinitionSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  return { ok: true, def: parsed.data as EffectDefinition };
}

/**
 * v1-only migration gate: PR1 ships version 1. Any other version is
 * rejected with a migration error (no silent coercion).
 */
export function migrateAsset(json: unknown): EffectDefinition {
  const v = (json as { version?: unknown } | null)?.version;
  if (v !== 1) {
    throw new Error(`migrateAsset: unsupported version ${String(v)} (PR1 supports version 1 only)`);
  }
  const result = validateAsset(json);
  if (!result.ok) throw new Error(`migrateAsset: invalid v1 asset: ${result.issues.join("; ")}`);
  return result.def;
}

/**
 * Resolve "$param" indirection in module params against the asset's param
 * defaults, with optional spawn-time overrides. Literals pass through.
 */
export function resolveModuleParams(
  def: EffectDefinition,
  moduleIndex: number,
  overrides: Record<string, ParamValue> = {},
): Record<string, ParamValue> {
  const mod = def.modules[moduleIndex];
  if (!mod) throw new Error(`resolveModuleParams: module index ${moduleIndex} out of range`);
  const out: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(mod.params)) {
    if (typeof value === "string" && value.startsWith("$")) {
      const name = value.slice(1);
      if (name in overrides) {
        out[key] = overrides[name];
        continue;
      }
      const decl = def.params[name];
      if (!decl) throw new Error(`resolveModuleParams: unknown param reference \"${value}\"`);
      out[key] = decl.default;
      continue;
    }
    out[key] = value;
  }
  return out;
}
