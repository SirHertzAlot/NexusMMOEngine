/**
 * Browser-safe entry for @mmo-engine/art.
 *
 * Re-exports the manifest schema/types and the manifest-backed Three.js
 * AssetProvider. Deliberately EXCLUDES ./scan.js (pack directory
 * scanning uses node:fs/node:path — server/host tooling only).
 *
 * Browser bundles (game client, editor companion) import from
 * "@mmo-engine/art/browser"; Node tooling imports the package root.
 */
export * from "./manifest.js";
export * from "./provider.js";
export * from "./character/modular-catalog.js";
export * from "./character/colour-slots.js";
export * from "./character/look.js";
export * from "./character/animations.js";
export * from "./character/clip-map.js";
export * from "./character/clip-playback.js";
export * from "./character/stand-in.js";
export { loadParticleBudgets, budgetForTier, DEFAULT_PARTICLE_BUDGETS, type ParticleBudgets, type TierBudget, type QualityTier } from "./particle-budgets.js";
