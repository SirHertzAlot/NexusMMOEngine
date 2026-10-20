/**
 * VFX Module - Three.js ShaderMaterial-based effects.
 *
 * Materials:
 * - FlowMaterial: fire, smoke, water, energy (two-phase flow)
 * - WorldFlowMaterial: ground dust, water ripples, magic circles (world-position flow)
 * - PolarFlowMaterial: portals, vortices, magic circles (polar flow)
 * - DissolveMaterial: death, burning, teleportation
 * - ColorRampMaterial: fire, smoke, magic, portal, dust, healing, poison, rain
 *
 * Adapter:
 * - VFXAdapter: bridges semantic events to existing systems (ParticleFx, QuarksFx, EntityFxSystem)
 */
export * from "./materials/index.js";
export * from "./VFXAdapter.js";