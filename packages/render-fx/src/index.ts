/**
 * packages/render-fx/src/index.ts — PR1 public surface (schema + contracts only).
 */
export type {
  FxTier,
  ParamType,
  ParamDecl,
  ParamValue,
  BindingKind,
  EffectBinding,
  OrphanRule,
  FxModuleName,
  EffectModuleDef,
  EffectTiming,
  EffectDefinition,
  InstanceState,
  EffectInstance,
  EffectRuntime,
} from "./types.js";
export { FX_TIERS } from "./types.js";
export { effectDefinitionSchema, validateAsset, migrateAsset, resolveModuleParams } from "./asset-schema.js";
export { FX_WARP_GLSL, REQUIRED_NOISE_SYMBOLS, REQUIRED_WARP_SYMBOLS } from "./primitives-glsl.js";
export {
  FRAME_GRAPH_ORDER,
  KUWAHARA_TIER_TABLE,
  passOrderIndex,
  validateFrameGraph,
} from "./post-contracts.js";
export type { PassKind, PassContract, FrameGraphValidation } from "./post-contracts.js";
export {
  ManagedEffectRuntime,
  createEffectRuntime,
  type EffectRendererHooks,
  type EffectRuntimeOptions,
  type FxWireKill,
  type FxWireMessage,
  type FxWireSpawn,
  type FxWireUpdate,
  type LiveEffectState,
} from "./runtime.js";
export {
  clampSplineToRange,
  sampleSpline,
  splineLength,
  type SplineSample,
  type Vec3Point,
} from "./spline.js";
