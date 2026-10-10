/**
 * Convert engine-agnostic VfxEffect definitions to three.quarks objects
 * for the web client.
 *
 * This is a one-way converter: the agnostic format is the source of truth.
 * The C++ backend gets its own converter (see docs/VFX-CPP-MAPPING.md).
 */
import {
  BatchedRenderer,
  Bezier,
  ColorOverLife,
  ColorRange,
  ConeEmitter,
  ConstantColor,
  ConstantValue,
  DonutEmitter,
  Gradient,
  IntervalValue,
  ParticleSystem,
  PiecewiseBezier,
  PointEmitter,
  SphereEmitter,
  BoxEmitter,
  SizeOverLife,
  ApplyForce,
  GravityForce,
  type EmitterShape,
} from "three.quarks";
import type {
  VfxEffect,
  VfxEmitter,
  VfxScalar,
  VfxSpawnShape,
  VfxForce,
  VfxColor,
  VfxColorGradient,
} from "./vfx-schema.js";

// ---------------------------------------------------------------------------
// Scalar / curve conversion
// ---------------------------------------------------------------------------

function toQuarksScalar(s: VfxScalar) {
  if (typeof s === "number") {
    return new ConstantValue(s);
  }
  // PiecewiseBezier from our curve points
  const beziers = s.points.map((p, i) => {
    const next = s.points[Math.min(i + 1, s.points.length - 1)];
    // Approximate each segment as a bezier with matching endpoints
    return [new Bezier(p.value, p.value, next.value, next.value), p.t] as const;
  });
  return new PiecewiseBezier([beziers.map(([b, t]) => [b, t] as [Bezier, number])]);
}

// ---------------------------------------------------------------------------
// Spawn shape conversion
// ---------------------------------------------------------------------------

function toQuarksShape(shape: VfxSpawnShape): EmitterShape {
  switch (shape.kind) {
    case "point":
      return new PointEmitter();
    case "sphere":
      return new SphereEmitter({
        radius: shape.radius,
        thickness: 1, // surface emission; use 0 for volume
        arc: Math.PI * 2,
      } as never);
    case "box":
      return new BoxEmitter({
        width: shape.halfExtents.x * 2,
        height: shape.halfExtents.y * 2,
        depth: shape.halfExtents.z * 2,
      } as never);
    case "cone":
      return new ConeEmitter({
        radius: shape.radius,
        height: shape.height,
        angle: shape.angle,
        arc: Math.PI * 2,
      } as never);
    case "disc":
      return new DonutEmitter({
        radius: shape.radius,
        donutRadius: 0,
        arc: Math.PI * 2,
      } as never);
  }
}

// ---------------------------------------------------------------------------
// Color conversion
// ---------------------------------------------------------------------------

function toQuarksColor(color: VfxColor | VfxColorGradient, system: ParticleSystem) {
  if ("stops" in color) {
    const gradient = new Gradient();
    for (const stop of color.stops) {
      gradient.addPoint(
        stop.t,
        new ConstantColor({
          x: stop.color.r,
          y: stop.color.g,
          z: stop.color.b,
          w: stop.color.a,
        } as never)
      );
    }
    system.addBehavior(new ColorOverLife(gradient));
  } else {
    system.addBehavior(
      new ColorOverLife(
        new ColorRange(
          { x: color.r, y: color.g, z: color.b, w: color.a } as never,
          { x: color.r, y: color.g, z: color.b, w: color.a } as never
        )
      )
    );
  }
}

// ---------------------------------------------------------------------------
// Force conversion
// ---------------------------------------------------------------------------

function toQuarksForce(force: VfxForce, system: ParticleSystem) {
  switch (force.kind) {
    case "gravity":
      system.addBehavior(
        new ApplyForce(
          new GravityForce(force.acceleration.x, force.acceleration.y, force.acceleration.z),
          1
        )
      );
      break;
    case "drag":
      // three.quarks doesn't have a direct drag behavior; approximate via
      // a custom force would go here. For now, document the gap.
      // TODO: implement DragForce or use damping behavior if available.
      break;
    case "turbulence":
      // three.quarks Noise behavior approximates turbulence
      // TODO: map intensity/frequency to Noise parameters
      break;
    case "attractor":
      // TODO: implement attractor as a custom ApplyForce
      break;
  }
}

// ---------------------------------------------------------------------------
// Emitter conversion
// ---------------------------------------------------------------------------

function toQuarksEmitter(emitter: VfxEmitter): ParticleSystem {
  const system = new ParticleSystem({
    duration: emitter.duration,
    looping: emitter.looping,
    startLife: toQuarksScalar(emitter.lifetime) as never,
    startSpeed: toQuarksScalar(emitter.speed) as never,
    startSize: toQuarksScalar(emitter.size) as never,
    startColor: undefined, // handled via ColorOverLife below
    emissionOverTime: new ConstantValue(emitter.rate),
    shape: toQuarksShape(emitter.spawnShape),
    maxParticle: emitter.maxParticles,
    emissionBursts: emitter.bursts.map((b) => ({
      time: b.time,
      count: new ConstantValue(b.count),
      cycle: b.repeat,
      interval: b.interval,
    })) as never,
  } as never);

  system.emitterName = emitter.name;

  // Direction and spread
  // (three.quarks uses shape orientation; direction is applied via rotation)

  // Color
  toQuarksColor(emitter.color, system);

  // Forces
  for (const force of emitter.forces) {
    toQuarksForce(force, system);
  }

  // Size over life (if it's a curve, add the behavior)
  if (typeof emitter.size !== "number") {
    system.addBehavior(new SizeOverLife(toQuarksScalar(emitter.size) as never));
  }

  return system;
}

// ---------------------------------------------------------------------------
// Effect conversion
// ---------------------------------------------------------------------------

/**
 * Convert an engine-agnostic VfxEffect to three.quarks ParticleSystems.
 * The caller adds them to a BatchedRenderer and the scene.
 */
export function vfxToQuarks(effect: VfxEffect): ParticleSystem[] {
  return effect.emitters.map(toQuarksEmitter);
}

/**
 * Serialize an agnostic effect to the three.quarks JSON format
 * (for QuarksLoader, if needed).
 */
export function vfxToQuarksJson(effect: VfxEffect): unknown[] {
  return vfxToQuarks(effect).map((s) => s.toJSON());
}
