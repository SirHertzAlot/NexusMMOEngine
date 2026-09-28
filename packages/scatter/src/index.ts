/**
 * `@mmo-engine/scatter` — UE-style PCG authoring/cooking for the engine.
 *
 * Cooking only. Nothing here runs in the region process or on the tick
 * path. The runtime authority is the C++ scatter addon (PCG slice 3);
 * this package produces the validated, hashed ScatterPlans it executes,
 * plus an authoring-time reference evaluator that generates the golden
 * vectors the C++ implementation must match.
 */
export * from "./schema.js";
export * from "./nodes.js";
export * from "./points.js";
export * from "./cooker.js";
export * from "./spawn-table.js";
export {
  hashU32,
  hash01,
  deriveChunkSeed,
  evaluatePlan,
  SCATTER_CHUNK_SIZE,
  type EvalContext,
  type SpawnRecord,
} from "./reference.js";
