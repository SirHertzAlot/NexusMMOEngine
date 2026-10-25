/**
 * First-person camera: the sibling of followCamera, with DoD biomechanical
 * and skeletal head-coupled motion.
 *
 * Same yaw/pitch convention as the third-person follow camera —
 * yaw 0 faces +Z, and positive pitch (from mouse-up) looks down —
 * so toggling views never inverts the controls. The camera sits at the
 * eye point, couples to the character's locomotion, breathing, landing
 * spring, skeletal Head bone displacement, and combat move impulses, and
 * looks along the view direction while movement stays server-authoritative.
 */

import { combatMove, LocomotionMode, Move } from "@mmo-engine/protocol";
import type * as THREE from "three";

/** Eye height above the avatar's feet, metres. */
export const EYE_HEIGHT = 1.6;

/** Breathing cycle frequency at rest (Hz, ~19 breaths/min). */
export const BREATH_HZ = 0.32;
/** Vertical breathing amplitude at rest (metres). */
export const BREATH_UP_M = 0.015;
/** Pitch micro-nod amplitude during idle breathing (radians). */
export const BREATH_PITCH_RAD = 0.004;

/** Maximum horizontal speed used to normalize stride bobbing (m/s). */
const REF_RUN_SPEED = 6.0;
/** Vertically critically-damped landing spring constants. */
const LAND_SPRING_K = 150;
const LAND_SPRING_DAMP = 20;

/**
 * Flat, allocation-free state for the first-person biomechanical camera rig.
 * Stored once per client session and updated in-place every frame (DoD).
 */
export interface FirstPersonCameraState {
  breathPhase: number;
  stridePhase: number;
  bobWeight: number;
  exertion: number;
  landOffset: number;
  landVel: number;
  prevVy: number;
  wasGrounded: boolean;
  smoothRight: number;
  smoothUp: number;
  smoothForward: number;
  smoothPitch: number;
  smoothYaw: number;
  smoothRoll: number;
}

/** Input sample fed into `stepFirstPersonMotion` each render frame. */
export interface FirstPersonMotionInput {
  dt: number;
  vx?: number;
  vy?: number;
  vz?: number;
  mode?: number;
  grounded?: boolean;
  move?: number;
  moveElapsed?: number;
  /** Optional local-space displacement of the character's animated Head bone from rest. */
  headBoneOffset?: { readonly x: number; readonly y: number; readonly z: number } | null;
}

/** Evaluated camera-space offset and angular impulses applied by `firstPersonCamera`. */
export interface FirstPersonMotionSample {
  /** Camera-local right offset (metres). */
  right: number;
  /** World vertical offset added to EYE_HEIGHT (metres). */
  up: number;
  /** Camera-local horizontal forward offset (metres). */
  forward: number;
  /** Pitch offset added to lookPitch (radians; positive looks down). */
  pitch: number;
  /** Yaw offset added to lookYaw (radians). */
  yaw: number;
  /** Roll tilt around view forward axis (radians). */
  roll: number;
  /** Current normalized stride phase (radians) for synchronizing viewmodel hands. */
  stridePhase: number;
  /** Current smoothed locomotion bob weight (0..1.5) for viewmodel hand swing. */
  bobWeight: number;
  /** Current breathing phase (radians) for viewmodel idle sway. */
  breathPhase: number;
}

/** Create a zeroed `FirstPersonCameraState` struct. */
export function createFirstPersonCameraState(): FirstPersonCameraState {
  return {
    breathPhase: 0,
    stridePhase: 0,
    bobWeight: 0,
    exertion: 0,
    landOffset: 0,
    landVel: 0,
    prevVy: 0,
    wasGrounded: true,
    smoothRight: 0,
    smoothUp: 0,
    smoothForward: 0,
    smoothPitch: 0,
    smoothYaw: 0,
    smoothRoll: 0,
  };
}

/** Smooth hermite pulse on [0, 1] peaking at `peak` (0 < peak < 1) and returning to 0 at 1. */
function pulseWindow(p: number, peak: number): number {
  if (p <= 0 || p >= 1) return 0;
  if (p < peak) {
    const u = p / peak;
    return u * u * (3 - 2 * u);
  }
  const u = (p - peak) / (1 - peak);
  return 1 - u * u * (3 - 2 * u);
}

/**
 * Pure helper: evaluate combat move camera displacement and angular impulse
 * at `moveElapsed` seconds into `move`.
 */
export function computeCombatCameraImpulse(
  move: number,
  moveElapsed: number,
  out: { right: number; up: number; forward: number; pitch: number; yaw: number; roll: number } = {
    right: 0,
    up: 0,
    forward: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
  },
): { right: number; up: number; forward: number; pitch: number; yaw: number; roll: number } {
  out.right = 0;
  out.up = 0;
  out.forward = 0;
  out.pitch = 0;
  out.yaw = 0;
  out.roll = 0;
  if (move === Move.None || moveElapsed < 0) return out;

  const def = combatMove(move);
  const duration = def?.duration ?? 1.0;
  const p = Math.min(1, moveElapsed / Math.max(0.05, duration));

  switch (move) {
    case Move.SwordA: {
      // Right-to-left diagonal slash: wind-up coil then forward lunge at hitAt (0.2s)
      const windup = pulseWindow(Math.min(1, moveElapsed / 0.18), 0.65);
      const strike = pulseWindow(Math.max(0, (moveElapsed - 0.12) / 0.42), 0.25);
      out.right = windup * 0.045 - strike * 0.065;
      out.up = windup * 0.018 - strike * 0.028;
      out.forward = -windup * 0.04 + strike * 0.12;
      out.pitch = -windup * 0.015 + strike * 0.028;
      out.yaw = -windup * 0.025 + strike * 0.035;
      out.roll = -windup * 0.025 + strike * 0.038;
      break;
    }
    case Move.SwordB: {
      // Left-to-right return slash: left coil then right-leaning cleave at hitAt (0.23s)
      const windup = pulseWindow(Math.min(1, moveElapsed / 0.2), 0.65);
      const strike = pulseWindow(Math.max(0, (moveElapsed - 0.14) / 0.46), 0.25);
      out.right = -windup * 0.048 + strike * 0.072;
      out.up = windup * 0.015 - strike * 0.03;
      out.forward = -windup * 0.035 + strike * 0.135;
      out.pitch = -windup * 0.012 + strike * 0.024;
      out.yaw = windup * 0.028 - strike * 0.038;
      out.roll = windup * 0.028 - strike * 0.042;
      break;
    }
    case Move.SwordC: {
      // Heavy overhead finisher: high lift then powerful downward slam at hitAt (0.43s)
      const windup = pulseWindow(Math.min(1, moveElapsed / 0.36), 0.7);
      const slam = pulseWindow(Math.max(0, (moveElapsed - 0.3) / 0.65), 0.22);
      out.right = -slam * 0.02;
      out.up = windup * 0.075 - slam * 0.125;
      out.forward = -windup * 0.055 + slam * 0.17;
      out.pitch = -windup * 0.045 + slam * 0.075;
      out.yaw = -windup * 0.015 + slam * 0.018;
      out.roll = -windup * 0.018 + slam * 0.032;
      break;
    }
    case Move.SwordARecover:
    case Move.SwordBRecover: {
      const settle = Math.sin(p * Math.PI) * (1 - p);
      out.forward = settle * 0.03;
      out.up = -settle * 0.015;
      out.pitch = settle * 0.01;
      break;
    }
    case Move.Guard: {
      // Braced defensive stance: slightly lowered eye and tucked chin
      const brace = Math.min(1, moveElapsed / 0.14);
      const ease = brace * brace * (3 - 2 * brace);
      out.right = -0.022 * ease;
      out.up = -0.055 * ease;
      out.forward = -0.025 * ease;
      out.pitch = 0.016 * ease;
      out.roll = -0.018 * ease;
      break;
    }
    case Move.ShieldBash: {
      const bash = pulseWindow(p, 0.25);
      out.right = 0.03 * bash;
      out.up = -0.045 * bash;
      out.forward = 0.16 * bash;
      out.pitch = 0.042 * bash;
      out.roll = -0.035 * bash;
      break;
    }
    case Move.Roll: {
      // Dodge roll tuck: smooth dip in eye height and forward surge without nauseating 360 spin
      const tuck = Math.sin(p * Math.PI);
      out.up = -0.52 * tuck;
      out.forward = 0.18 * tuck;
      out.pitch = 0.28 * tuck;
      out.roll = 0.09 * Math.sin(p * Math.PI * 2);
      break;
    }
    default:
      break;
  }
  return out;
}

const _combatScratch = { right: 0, up: 0, forward: 0, pitch: 0, yaw: 0, roll: 0 };

/**
 * Advance `state` by `input.dt` and write the resulting camera-space offsets
 * into `out` (zero heap allocations on hot path when `out` is reused).
 */
export function stepFirstPersonMotion(
  state: FirstPersonCameraState,
  input: FirstPersonMotionInput,
  out: FirstPersonMotionSample = {
    right: 0,
    up: 0,
    forward: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    stridePhase: 0,
    bobWeight: 0,
    breathPhase: 0,
  },
): FirstPersonMotionSample {
  const dt = Math.max(0, Math.min(0.1, input.dt));
  const vx = input.vx ?? 0;
  const vy = input.vy ?? 0;
  const vz = input.vz ?? 0;
  const mode = input.mode ?? LocomotionMode.Ground;
  const grounded = input.grounded ?? (mode === LocomotionMode.Ground && Math.abs(vy) < 0.05);
  const move = input.move ?? Move.None;
  const moveElapsed = input.moveElapsed ?? 0;

  const horizSpeed = Math.hypot(vx, vz);
  const normSpeed = Math.min(1.5, horizSpeed / REF_RUN_SPEED);

  // Exertion rises with movement and combat, accelerating breathing slightly.
  const targetExertion = Math.min(1, normSpeed * 0.7 + (move !== Move.None ? 0.5 : 0));
  const blendFast = 1 - Math.exp(-dt * 10);
  const blendMed = 1 - Math.exp(-dt * 14);
  state.exertion += (targetExertion - state.exertion) * (1 - Math.exp(-dt * 2.5));

  // 1. Idle & exertion breathing harmonic
  const breathHz = BREATH_HZ * (1 + state.exertion * 0.85);
  state.breathPhase = (state.breathPhase + dt * breathHz * Math.PI * 2) % (Math.PI * 2);
  const breathScale = 1 + state.exertion * 0.45;
  const breathUp =
    (Math.sin(state.breathPhase) * BREATH_UP_M + Math.sin(state.breathPhase * 2) * (BREATH_UP_M * 0.25)) *
    breathScale;
  const breathPitch = Math.cos(state.breathPhase) * BREATH_PITCH_RAD * breathScale;
  const breathRight = Math.cos(state.breathPhase * 0.5) * 0.004 * breathScale;

  // 2. Stride-synchronized Lissajous head-bob (figure-8)
  const isGroundMoving = grounded && mode === LocomotionMode.Ground && horizSpeed > 0.15;
  const targetBob = isGroundMoving ? normSpeed : 0;
  state.bobWeight += (targetBob - state.bobWeight) * blendFast;

  if (state.bobWeight > 0.001) {
    const strideHz = 1.65 + 0.95 * normSpeed;
    state.stridePhase = (state.stridePhase + dt * strideHz * Math.PI * 2) % (Math.PI * 2);
  }

  let bobRight = 0;
  let bobUp = 0;
  let bobForward = 0;
  let bobRoll = 0;
  let bobPitch = 0;

  if (mode === LocomotionMode.Swim) {
    // Buoyant water wave motion
    bobUp = Math.sin(state.breathPhase * 1.5) * 0.038;
    bobRight = Math.cos(state.breathPhase * 0.75) * 0.022;
    bobRoll = Math.sin(state.breathPhase * 0.75) * 0.012;
  } else {
    const w = state.bobWeight;
    const sp = state.stridePhase;
    // Lateral sway at 1x stride frequency; vertical footfall bounce at 2x stride frequency
    bobRight = Math.sin(sp) * 0.036 * w;
    bobUp = Math.sin(sp * 2 - Math.PI * 0.5) * 0.044 * w;
    bobForward = Math.cos(sp * 2) * 0.018 * w;
    bobRoll = -Math.sin(sp) * 0.018 * w;
    bobPitch = Math.sin(sp * 2) * 0.009 * w + Math.min(1, horizSpeed / 7.0) * 0.016;
  }

  // 3. Jump & landing vertical spring-damper impulse
  if (grounded && !state.wasGrounded && state.prevVy < -0.8) {
    state.landVel += Math.max(-3.5, state.prevVy * 0.42);
  }
  state.wasGrounded = grounded;
  state.prevVy = vy;

  const springForce = -LAND_SPRING_K * state.landOffset - LAND_SPRING_DAMP * state.landVel;
  state.landVel += springForce * dt;
  state.landOffset = Math.max(-0.28, Math.min(0.12, state.landOffset + state.landVel * dt));
  const airPitch = !grounded ? Math.max(-0.04, Math.min(0.04, -vy * 0.006)) : 0;

  // 4. Combat move camera choreography
  const combat = computeCombatCameraImpulse(move, moveElapsed, _combatScratch);

  // 5. Optional skeletal Head bone offset from CharacterAnimator
  let skelRight = 0;
  let skelUp = 0;
  let skelForward = 0;
  if (input.headBoneOffset) {
    skelRight = Math.max(-0.18, Math.min(0.18, input.headBoneOffset.x * 0.45));
    skelUp = Math.max(-0.25, Math.min(0.2, input.headBoneOffset.y * 0.45));
    skelForward = Math.max(-0.22, Math.min(0.22, input.headBoneOffset.z * 0.45));
  }

  const targetRight = breathRight + bobRight + combat.right + skelRight;
  const targetUp = breathUp + bobUp + state.landOffset + combat.up + skelUp;
  const targetForward = bobForward + combat.forward + skelForward;
  const targetPitch = breathPitch + bobPitch + airPitch + state.landOffset * -0.18 + combat.pitch;
  const targetYaw = combat.yaw;
  const targetRoll = bobRoll + combat.roll;

  if (dt <= 0) {
    state.smoothRight = targetRight;
    state.smoothUp = targetUp;
    state.smoothForward = targetForward;
    state.smoothPitch = targetPitch;
    state.smoothYaw = targetYaw;
    state.smoothRoll = targetRoll;
  } else {
    state.smoothRight += (targetRight - state.smoothRight) * blendMed;
    state.smoothUp += (targetUp - state.smoothUp) * blendMed;
    state.smoothForward += (targetForward - state.smoothForward) * blendMed;
    state.smoothPitch += (targetPitch - state.smoothPitch) * blendMed;
    state.smoothYaw += (targetYaw - state.smoothYaw) * blendMed;
    state.smoothRoll += (targetRoll - state.smoothRoll) * blendMed;
  }

  out.right = state.smoothRight;
  out.up = state.smoothUp;
  out.forward = state.smoothForward;
  out.pitch = state.smoothPitch;
  out.yaw = state.smoothYaw;
  out.roll = state.smoothRoll;
  out.stridePhase = state.stridePhase;
  out.bobWeight = state.bobWeight;
  out.breathPhase = state.breathPhase;
  return out;
}

/**
 * Place the camera at `eye` (plus optional biomechanical/skeletal `motion`
 * offsets) and aim it along `(lookYaw, lookPitch)`.
 * A null eye leaves the camera untouched (the caller falls back to the
 * follow camera's idle target).
 */
export function firstPersonCamera(
  camera: THREE.Camera,
  eye: THREE.Vector3 | null,
  lookYaw: number,
  lookPitch: number,
  motion?: FirstPersonMotionSample | null,
): void {
  if (!eye) return;

  if (!motion) {
    const cp = Math.cos(lookPitch);
    camera.position.copy(eye);
    camera.lookAt(
      eye.x + Math.sin(lookYaw) * cp,
      eye.y - Math.sin(lookPitch),
      eye.z + Math.cos(lookYaw) * cp,
    );
    return;
  }

  // Forward = (sin(yaw), 0, cos(yaw)); Right = (-cos(yaw), 0, sin(yaw))
  const sinY = Math.sin(lookYaw);
  const cosY = Math.cos(lookYaw);
  const rx = -cosY;
  const rz = sinY;

  const ex = eye.x + rx * motion.right + sinY * motion.forward;
  const ey = eye.y + motion.up;
  const ez = eye.z + rz * motion.right + cosY * motion.forward;

  const effYaw = lookYaw + motion.yaw;
  const effPitch = Math.max(-1.35, Math.min(1.35, lookPitch + motion.pitch));
  const cp = Math.cos(effPitch);

  camera.position.set(ex, ey, ez);
  camera.lookAt(
    ex + Math.sin(effYaw) * cp,
    ey - Math.sin(effPitch),
    ez + Math.cos(effYaw) * cp,
  );
  if (Math.abs(motion.roll) > 1e-6) {
    camera.rotateZ(motion.roll);
  }
}
