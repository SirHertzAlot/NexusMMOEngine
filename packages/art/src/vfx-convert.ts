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
  FrameOverLife,
  Gradient,
  IntervalValue,
  Noise,
  ParticleSystem,
  PiecewiseBezier,
  PointEmitter,
  SphereEmitter,
  RectangleEmitter,
  SizeOverLife,
  ApplyForce,
  Vector3,
  type EmitterShape,
} from "three.quarks";
import {
  resolveEmitterRenderSettings,
  resolveFlipbookFrames,
  type VfxEffect,
  type VfxEmitter,
  type VfxFlipbook,
  type VfxScalar,
  type VfxSpawnShape,
  type VfxForce,
  type VfxColor,
  type VfxColorGradient,
} from "./vfx-schema.js";

// ---------------------------------------------------------------------------
// Scalar / curve conversion
// ---------------------------------------------------------------------------

function toQuarksScalar(s: VfxScalar) {
  if (typeof s === "number") {
    return new ConstantValue(s);
  }
  // PiecewiseBezier from our curve points
  const beziers: [Bezier, number][] = s.points.map((p, i) => {
    const next = s.points[Math.min(i + 1, s.points.length - 1)];
    // Approximate each segment as a bezier with matching endpoints
    return [new Bezier(p.value, p.value, next.value, next.value), p.t];
  });
  return new PiecewiseBezier(beziers);
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
      return new RectangleEmitter({
        width: shape.halfExtents.x * 2,
        height: shape.halfExtents.y * 2,
      });
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
    const colors: [Vector3, number][] = [];
    const alphas: [number, number][] = [];
    for (const stop of color.stops) {
      colors.push([new Vector3(stop.color.r, stop.color.g, stop.color.b), stop.t]);
      alphas.push([stop.color.a, stop.t]);
    }
    system.addBehavior(new ColorOverLife(new Gradient(colors, alphas)));
  } else {
    // Constant color: wrap in a gradient with two identical stops
    const v = new Vector3(color.r, color.g, color.b);
    system.addBehavior(new ColorOverLife(new Gradient([[v, 0], [v, 1]], [[color.a, 0], [color.a, 1]])));
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
          new Vector3(force.acceleration.x, force.acceleration.y, force.acceleration.z).normalize(),
          new ConstantValue(new Vector3(force.acceleration.x, force.acceleration.y, force.acceleration.z).length())
        )
      );
      break;
    case "drag":
      // three.quarks doesn't have a direct drag behavior; approximate via
      // a custom force would go here. For now, document the gap.
      // TODO: implement DragForce or use damping behavior if available.
      break;
    case "turbulence":
      system.addBehavior(
        new Noise(new ConstantValue(force.frequency), new ConstantValue(force.intensity)),
      );
      break;
    case "attractor":
      // TODO: implement attractor as a custom ApplyForce
      break;
  }
}

// ---------------------------------------------------------------------------
// Emitter conversion
// ---------------------------------------------------------------------------

function buildFlipbookBehavior(flipbook: VfxFlipbook, lifetime: VfxScalar): FrameOverLife {
  const frames = resolveFlipbookFrames(flipbook);
  if (frames.length <= 1) {
    const f = frames[0] ?? 0;
    return new FrameOverLife(new PiecewiseBezier([[new Bezier(f, f, f, f), 0]]));
  }
  const lifeSeconds =
    typeof lifetime === "number"
      ? lifetime
      : lifetime.points.reduce((sum, p) => sum + p.value, 0) / lifetime.points.length;
  const playDuration = frames.length / flipbook.fps;
  const segments: [Bezier, number][] = [];

  if (flipbook.loop === "loop" && lifeSeconds > 0) {
    const totalFrames = Math.max(frames.length, Math.round(lifeSeconds * flipbook.fps));
    const maxSegments = Math.min(totalFrames, 64);
    for (let i = 0; i < maxSegments; i++) {
      const frame = frames[i % frames.length];
      segments.push([new Bezier(frame, frame, frame, frame), i / maxSegments]);
    }
  } else {
    const span = lifeSeconds > 0 ? Math.min(1, playDuration / lifeSeconds) : 1;
    const step = span / frames.length;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      segments.push([new Bezier(frame, frame, frame, frame), i * step]);
    }
  }

  return new FrameOverLife(new PiecewiseBezier(segments));
}

function toQuarksEmitter(emitter: VfxEmitter, effect?: VfxEffect): ParticleSystem {
  const flipbook = emitter.flipbook;
  const flipbookFrames = flipbook ? resolveFlipbookFrames(flipbook) : undefined;
  const startTile = flipbookFrames?.[0] ?? 0;

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
    uTileCount: flipbook?.columns ?? 1,
    vTileCount: flipbook?.rows ?? 1,
    startTileIndex: new ConstantValue(startTile),
    emissionBursts: emitter.bursts.map((b) => ({
      time: b.time,
      count: new ConstantValue(b.count),
      cycle: b.repeat,
      interval: b.interval,
    })) as never,
  } as never);

  const meta = system.emitter as unknown as {
    userData: Record<string, unknown>;
  };
  (system as unknown as { emitterName: string }).emitterName = emitter.name;
  if (effect && meta?.userData) {
    meta.userData.vfxRender = resolveEmitterRenderSettings(effect, emitter);
  }

  // Flipbook UV frame playback
  if (flipbook) {
    system.addBehavior(buildFlipbookBehavior(flipbook, emitter.lifetime));
  }

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
  return effect.emitters.map((emitter) => toQuarksEmitter(emitter, effect));
}

/**
 * Serialize an agnostic effect to the three.quarks JSON format
 * (for QuarksLoader, if needed).
 */
export function vfxToQuarksJson(effect: VfxEffect): unknown[] {
  const meta = { geometries: {}, materials: {}, textures: {}, images: {}, shapes: {}, skeletons: {}, animations: {}, nodes: {} };
  return vfxToQuarks(effect).map((s) => s.toJSON(meta));
}
