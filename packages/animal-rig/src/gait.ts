/**
 * Procedural quadruped gait maths: pure functions, no three.js.
 *
 * The ideas follow the procedural-animals library (MIT, see
 * docs/ART-PIPELINE.md "Animals"): a gait is a table row of touchdown phase
 * offsets per leg and a duty factor, rows are blended by speed, and speeds
 * are compared across sizes by Froude number (dynamic similarity), so a
 * wolf and a bear at the same effort use the same gait. The code is ours.
 *
 * Legs are [front-left, front-right, hind-left, hind-right]. Angles are
 * "leg swing": +1 is the foot fully forward, -1 fully back.
 */

export const GRAVITY = 9.81;

interface Row {
  /** Touchdown phase offsets (0..1) of FL, FR, HL, HR. */
  off: [number, number, number, number];
  /** Duty factor: the share of the cycle a foot is on the ground. */
  duty: number;
  /** Stride length (one full cycle of travel) in leg lengths. */
  stride: number;
  /** Swing foot lift, in leg lengths (informative: the knee flexion below lifts the foot). */
  lift: number;
  /** Body bounce, in leg lengths. */
  bob: number;
  /**
   * Peak knee flexion in swing (radians), front carpus and hind hock. Dog/horse/deer kinematics:
   * about 35 to 45 degrees at a walk, 55 to 70 at a trot, 70 to 85 at a gallop (the hock a little less).
   */
  flexF: number;
  flexH: number;
}

/** Lateral-sequence walk, diagonal trot, transverse gallop. */
export const WALK: Row = { off: [0.25, 0.75, 0, 0.5], duty: 0.65, stride: 1.4, lift: 0.1, bob: 0.015, flexF: 0.7, flexH: 0.55 };
export const TROT: Row = { off: [0, 0.5, 0.5, 0], duty: 0.5, stride: 2.6, lift: 0.16, bob: 0.03, flexF: 1.1, flexH: 0.9 };
export const GALLOP: Row = { off: [0.5, 0.6, 0, 0.1], duty: 0.36, stride: 3.6, lift: 0.2, bob: 0.05, flexF: 1.35, flexH: 1.1 };

/** Froude speeds (v / sqrt(g L)) where walk becomes trot and trot becomes gallop: [from, to]. */
export const WALK_TO_TROT: readonly [number, number] = [0.45, 0.7];
export const TROT_TO_GALLOP: readonly [number, number] = [1.1, 1.6];
/** Speeds (m/s) below MOVE_FROM are standing still; from MOVE_FULL the legs swing fully. */
export const MOVE_FROM = 0.05;
export const MOVE_FULL = 0.4;
/** Largest hip swing, radians: a faster animal skates a little rather than over-swing. */
export const MAX_SWEEP = 0.75;

export interface GaitParams {
  /** Cycles per second. */
  freq: number;
  duty: number;
  /** Hip swing amplitude (radians), already scaled by how much the animal is moving. */
  sweep: number;
  /** Swing foot lift (metres). */
  lift: number;
  /** Body bounce amplitude (metres). */
  bob: number;
  /** Peak knee flexion in swing, radians: front carpus, hind hock (scaled by how much it moves). */
  flexF: number;
  flexH: number;
  offsets: [number, number, number, number];
  /** 0 standing, 1 moving (smooth). */
  moveW: number;
  /** 0 walk .. 1 trot .. 2 gallop (continuous). */
  gait: number;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function newGait(): GaitParams {
  return { freq: 0, duty: 0.65, sweep: 0, lift: 0, bob: 0, flexF: 0, flexH: 0, offsets: [0, 0, 0, 0], moveW: 0, gait: 0 };
}

/** The gait for a speed (m/s) and a leg length (m); fills `out` (reuse one per animal: no allocation). */
export function gaitAt(speed: number, legLen: number, out: GaitParams = newGait()): GaitParams {
  const L = Math.max(legLen, 1e-3);
  const fr = speed / Math.sqrt(GRAVITY * L);
  const t = smoothstep(WALK_TO_TROT[0], WALK_TO_TROT[1], fr);
  const g = smoothstep(TROT_TO_GALLOP[0], TROT_TO_GALLOP[1], fr);
  const mix = (a: number, b: number, c: number): number => (a * (1 - t) + b * t) * (1 - g) + c * g;
  const stride = mix(WALK.stride, TROT.stride, GALLOP.stride) * L;
  out.duty = mix(WALK.duty, TROT.duty, GALLOP.duty);
  out.lift = mix(WALK.lift, TROT.lift, GALLOP.lift) * L;
  out.bob = mix(WALK.bob, TROT.bob, GALLOP.bob) * L;
  out.moveW = smoothstep(MOVE_FROM, MOVE_FULL, speed);
  out.flexF = mix(WALK.flexF, TROT.flexF, GALLOP.flexF) * out.moveW;
  out.flexH = mix(WALK.flexH, TROT.flexH, GALLOP.flexH) * out.moveW;
  for (let i = 0; i < 4; i++) out.offsets[i] = mix(WALK.off[i], TROT.off[i], GALLOP.off[i]);
  out.freq = speed > 1e-3 ? speed / stride : 0;
  // A foot on the ground goes back by speed x stance time = stride x duty; the hip swings it.
  const sweep = Math.asin(Math.min(0.95, (stride * out.duty) / (2 * L)));
  out.sweep = Math.min(MAX_SWEEP, sweep) * out.moveW;
  out.gait = t + g;
  return out;
}

/** A phase advanced by `dt` seconds at `freq` cycles per second, kept in [0, 1). */
export function advancePhase(phase: number, freq: number, dt: number): number {
  const p = (phase + freq * dt) % 1;
  return p < 0 ? p + 1 : p;
}

const ease = (x: number): number => x * x * (3 - 2 * x);

/**
 * One leg's swing angle (+1 forward .. -1 back) and lift (0..1) at a cycle
 * phase (the leg's own offset already added). Stance moves the foot back
 * at a steady rate (so it does not slide); swing brings it forward.
 * `flex` (0..1) is the knee flexion: zero in stance, peaking a little before
 * mid-swing (the foot clears the ground early, then reaches forward straight).
 * Writes into `out` (no allocation).
 */
export function legCurve(phase: number, duty: number, out: { angle: number; lift: number; flex: number }): void {
  const p = ((phase % 1) + 1) % 1;
  if (p < duty) {
    out.angle = 1 - 2 * (p / duty);
    out.lift = 0;
    out.flex = 0;
    return;
  }
  const q = (p - duty) / (1 - duty);
  out.angle = -1 + 2 * ease(q);
  out.lift = Math.sin(Math.PI * q);
  out.flex = Math.sin(Math.PI * Math.pow(q, 0.75));
}

/** Seconds a strike takes to snap out after the hit frame. */
export const STRIKE_RISE = 0.1;

/**
 * An attack `t` seconds in (writes `out`): it winds up until `hitAt` (the
 * telegraph the player reads: crouch, head down), snaps out over STRIKE_RISE
 * seconds, then recovers by `duration`.
 */
export function attackPose(t: number, hitAt: number, duration: number, out: { windup: number; strike: number }): void {
  out.windup = 0;
  out.strike = 0;
  if (t <= 0 || t >= duration) return;
  const hit = Math.min(Math.max(hitAt, 0.05), duration * 0.9);
  if (t < hit) {
    out.windup = ease(Math.min(1, t / (hit * 0.8)));
    return;
  }
  const rise = ease(Math.min(1, (t - hit) / STRIKE_RISE));
  out.windup = 1 - rise;
  const rest = Math.max(1e-3, duration - hit - STRIKE_RISE);
  out.strike = t - hit < STRIKE_RISE ? rise : 1 - ease(Math.min(1, (t - hit - STRIKE_RISE) / rest));
}

/** Death fall: 0 standing .. 1 down, over `seconds`. */
export function deathProgress(t: number, seconds = 0.9): number {
  return ease(Math.min(1, Math.max(0, t / seconds)));
}

/** Avian flapping and gliding solver. In flight (speed > 1.5), wings flap with harmonic roll & pitch. */
export function avianFlightCurve(
  phase: number,
  speed: number,
  out: { wingRoll: number; wingPitch: number; headBob: number }
): void {
  const isMoving = smoothstep(0.1, 1.0, speed);
  const flap = Math.sin(2 * Math.PI * phase);
  out.wingRoll = flap * 0.65 * isMoving;
  out.wingPitch = Math.cos(2 * Math.PI * phase) * 0.25 * isMoving;
  out.headBob = Math.sin(4 * Math.PI * phase) * 0.08 * isMoving;
}

/** Serpentine travelling wave solver: calculates lateral yaw angles along sequential vertebrae. */
export function serpentineWave(
  phase: number,
  speed: number,
  numBones: number,
  outAngles: Float32Array
): void {
  const isMoving = smoothstep(0.05, 0.5, speed);
  const waveFreq = 2 * Math.PI;
  const spatialLag = (2 * Math.PI) / Math.max(1, numBones - 1);
  for (let i = 0; i < numBones; i++) {
    // Amplitude increases slightly toward the tail
    const amp = (0.2 + 0.35 * (i / Math.max(1, numBones - 1))) * (0.3 + 0.7 * isMoving);
    outAngles[i] = Math.sin(waveFreq * phase - i * spatialLag) * amp;
  }
}

/** Aquatic swimming solver: sinusoidal tail swish and pectoral fin stabilization. */
export function aquaticWave(
  phase: number,
  speed: number,
  out: { tailYaw: number; finPitch: number; dorsalRoll: number }
): void {
  const isMoving = smoothstep(0.05, 0.8, speed);
  const swish = Math.sin(2 * Math.PI * phase);
  out.tailYaw = swish * 0.45 * (0.2 + 0.8 * isMoving);
  out.finPitch = Math.cos(2 * Math.PI * phase) * 0.2 * isMoving;
  out.dorsalRoll = swish * 0.05 * isMoving;
}

/** Arachnid alternating tripod / tetrapod scurrying gait solver. */
export function arachnidGait(
  phase: number,
  speed: number,
  outAngles: Float32Array
): void {
  const isMoving = smoothstep(0.05, 0.5, speed);
  // 4 leg pairs = 8 legs [leg1L, leg1R, leg2L, leg2R, leg3L, leg3R, leg4L, leg4R]
  // Tripod group A: 1L, 2R, 3L, 4R
  // Tripod group B: 1R, 2L, 3R, 4L
  const swingA = Math.sin(2 * Math.PI * phase) * 0.4 * isMoving;
  const swingB = Math.sin(2 * Math.PI * phase + Math.PI) * 0.4 * isMoving;

  outAngles[0] = swingA;
  outAngles[1] = swingB;
  outAngles[2] = swingB;
  outAngles[3] = swingA;
  outAngles[4] = swingA;
  outAngles[5] = swingB;
  outAngles[6] = swingB;
  outAngles[7] = swingA;
}

/** Flora ambient wind sway and harmonic oscillation solver. */
export function floraSway(
  clock: number,
  out: { swayX: number; swayZ: number; flutter: number }
): void {
  // Low-frequency wind gusts + higher-frequency foliage vibration
  out.swayX = Math.sin(clock * 1.2) * 0.05 + Math.sin(clock * 2.8) * 0.02;
  out.swayZ = Math.cos(clock * 0.9) * 0.06 + Math.cos(clock * 2.1) * 0.025;
  out.flutter = Math.sin(clock * 4.5) * 0.04;
}
