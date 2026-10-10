/**
 * Engine-agnostic VFX effect definitions.
 *
 * These schemas describe particle effects using universal concepts
 * (emitters, spawn shapes, forces, curves over life) — NOT three.js,
 * three.quarks, Unity, or Unreal specifics.
 *
 * The same JSON can be converted to:
 * - three.quarks JSON for the web client (see vfx-convert.ts)
 * - C++ structs for the backend (see docs/VFX-CPP-MAPPING.md)
 *
 * This keeps VFX data portable if we ever swap the client renderer
 * or move simulation server-side.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A value that can be constant or vary over the particle's normalized life [0,1]. */
export const VfxCurvePoint = z.object({
  /** Normalized life position [0,1]. */
  t: z.number().min(0).max(1),
  /** Value at this point. */
  value: z.number(),
});
export type VfxCurvePoint = z.infer<typeof VfxCurvePoint>;

/** Piecewise-linear curve over normalized life. */
export const VfxCurve = z.object({
  points: z.array(VfxCurvePoint).min(2),
});
export type VfxCurve = z.infer<typeof VfxCurve>;

/** A scalar that's either constant or a curve. */
export const VfxScalar = z.union([z.number(), VfxCurve]);
export type VfxScalar = z.infer<typeof VfxScalar>;

export const VfxVec3 = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type VfxVec3 = z.infer<typeof VfxVec3>;

export const VfxColor = z.object({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
  a: z.number().min(0).max(1).default(1),
});
export type VfxColor = z.infer<typeof VfxColor>;

/** Color over life: gradient stops at normalized life positions. */
export const VfxColorGradient = z.object({
  stops: z.array(z.object({
    t: z.number().min(0).max(1),
    color: VfxColor,
  })).min(2),
});
export type VfxColorGradient = z.infer<typeof VfxColorGradient>;

// ---------------------------------------------------------------------------
// Spawn shapes (engine-agnostic)
// ---------------------------------------------------------------------------

export const VfxSpawnShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("point") }),
  z.object({ kind: z.literal("sphere"), radius: z.number().positive() }),
  z.object({
    kind: z.literal("box"),
    halfExtents: VfxVec3,
  }),
  z.object({
    kind: z.literal("cone"),
    /** Cone half-angle in radians. */
    angle: z.number().min(0).max(Math.PI / 2),
    radius: z.number().positive(),
    height: z.number().positive(),
  }),
  z.object({
    kind: z.literal("disc"),
    radius: z.number().positive(),
    /** Normal of the disc. */
    normal: VfxVec3.default({ x: 0, y: 1, z: 0 }),
  }),
]);
export type VfxSpawnShape = z.infer<typeof VfxSpawnShape>;

// ---------------------------------------------------------------------------
// Forces (engine-agnostic)
// ---------------------------------------------------------------------------

export const VfxForce = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("gravity"),
    /** Acceleration vector (units/s²). */
    acceleration: VfxVec3,
  }),
  z.object({
    kind: z.literal("drag"),
    /** Linear drag coefficient. */
    coefficient: z.number().min(0),
  }),
  z.object({
    kind: z.literal("turbulence"),
    /** Strength of the noise field. */
    intensity: z.number().min(0),
    /** Spatial frequency. */
    frequency: z.number().positive(),
  }),
  z.object({
    kind: z.literal("attractor"),
    /** World-space target point (relative to emitter). */
    target: VfxVec3,
    /** Attraction strength. */
    strength: z.number(),
  }),
]);
export type VfxForce = z.infer<typeof VfxForce>;

// ---------------------------------------------------------------------------
// Emitter (engine-agnostic)
// ---------------------------------------------------------------------------

export const VfxBurst = z.object({
  /** Time in seconds after emitter start. */
  time: z.number().min(0),
  /** Number of particles to spawn. */
  count: z.number().int().positive(),
  /** How many times to repeat (0 = infinite while emitter is active). */
  repeat: z.number().int().min(0).default(0),
  /** Seconds between repeats. */
  interval: z.number().positive().default(1),
});
export type VfxBurst = z.infer<typeof VfxBurst>;

export const VfxEmitter = z.object({
  /** Unique name within the effect. */
  name: z.string().min(1),
  /** Continuous emission rate (particles/second). 0 = bursts only. */
  rate: z.number().min(0).default(0),
  bursts: z.array(VfxBurst).default([]),
  /** Emitter lifetime in seconds (0 = infinite). */
  duration: z.number().min(0).default(0),
  /** Whether the emitter loops when duration expires. */
  looping: z.boolean().default(true),
  /** Maximum live particles from this emitter. */
  maxParticles: z.number().int().positive(),
  spawnShape: VfxSpawnShape,
  /** Initial speed (units/s). */
  speed: VfxScalar,
  /** Initial direction. For cone shapes this is the cone axis. */
  direction: VfxVec3.default({ x: 0, y: 1, z: 0 }),
  /** Spread angle in radians around direction. */
  spread: z.number().min(0).max(Math.PI).default(0),
  /** Particle lifetime in seconds. */
  lifetime: VfxScalar,
  /** Particle size in world units. */
  size: VfxScalar,
  /** Particle color. */
  color: z.union([VfxColor, VfxColorGradient]),
  forces: z.array(VfxForce).default([]),
  /** Local offset from the effect origin. */
  position: VfxVec3.default({ x: 0, y: 0, z: 0 }),
});
export type VfxEmitter = z.infer<typeof VfxEmitter>;

// ---------------------------------------------------------------------------
// Effect (engine-agnostic)
// ---------------------------------------------------------------------------

export const VfxBlendMode = z.enum(["normal", "additive", "multiply", "screen"]);
export type VfxBlendMode = z.infer<typeof VfxBlendMode>;

export const VfxEffect = z.object({
  /** Unique effect ID (e.g. "fireball", "heal", "muzzle-flash"). */
  id: z.string().min(1).regex(/^[a-z0-9-]+$/),
  /** Human-readable name. */
  name: z.string().min(1),
  /** Schema version for forward compatibility. */
  version: z.number().int().positive().default(1),
  emitters: z.array(VfxEmitter).min(1),
  /** How particles blend. Rendering hint, not simulation. */
  blendMode: VfxBlendMode.default("normal"),
  /**
   * Texture reference by asset ID (e.g. "vfx/soft-circle").
   * The runtime resolves this to its own texture format.
   * Omit for untextured (square) particles.
   */
  texture: z.string().optional(),
  /** Budget tier this effect was authored for. The runtime scales by the active tier. */
  authoredTier: z.enum(["low", "medium", "high", "ultra"]).default("medium"),
});
export type VfxEffect = z.infer<typeof VfxEffect>;

/**
 * Validate an unknown value as a VfxEffect. Throws on invalid.
 */
export function parseVfxEffect(data: unknown): VfxEffect {
  return VfxEffect.parse(data);
}
