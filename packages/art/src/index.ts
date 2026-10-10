/**
 * @mmo-engine/art — the art asset pipeline contract.
 *
 * - `manifest.ts`: the `assets/manifest.json` schema, validation, and
 *   pack-completeness checking (`parseManifestJSON`, `checkManifestFiles`).
 * - `scan.ts`: derive a manifest from a pack folder on disk (`scanAssetDir`).
 * - `provider.ts`: the `AssetProvider` interface the renderer consumes, plus
 *   `ManifestAssetProvider` — manifest-backed THREE.js meshes with
 *   placeholder fallback for anything missing or unloadable.
 */

export * from "./manifest.js";
export * from "./scan.js";
export * from "./provider.js";
export * from "./compress-gltfpack.js";
export * from "./character/modular-catalog.js";
export * from "./character/colour-slots.js";
export * from "./character/look.js";
export * from "./character/animations.js";
export { loadMaterial, type Material } from "./materials.js";
export * from "./character/clip-map.js";
export * from "./character/clip-playback.js";
export * from "./character/stand-in.js";
export { loadParticleBudgets, budgetForTier, DEFAULT_PARTICLE_BUDGETS, type ParticleBudgets, type TierBudget, type QualityTier } from "./particle-budgets.js";
