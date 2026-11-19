/**
 * Cutscene Lane — C0 bake-gate validator (CUTSCENE-LANE-SPEC.md §7 & §10).
 *
 * All six gates are hard failures on a bundle build:
 *   reproducibility · clipValidity · arrival · duration · bundleBudget · license
 */
import {
  type CinematicBundleManifest,
  type CinematicDef,
  type Pose,
  type RecordedFinalSample,
} from "./schema.js";

export const MAX_CINEMATIC_BUNDLE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_ARRIVAL_POS_TOLERANCE_M = 0.05;
export const DEFAULT_ARRIVAL_YAW_TOLERANCE_RAD = 0.1;

export interface ValidateCinematicInput {
  def: CinematicDef;
  manifest: CinematicBundleManifest;
  recording: RecordedFinalSample;
  knownVerbs?: ReadonlySet<string>;
  posToleranceM?: number;
  yawToleranceRad?: number;
}

export interface GateStatus {
  reproducibility: boolean;
  clipValidity: boolean;
  arrival: boolean;
  duration: boolean;
  bundleBudget: boolean;
  license: boolean;
}

export interface CinematicValidationReport {
  ok: boolean;
  gates: GateStatus;
  errors: string[];
}

function wrapAngleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function poseDistance(a: Pose, b: Pose): { posM: number; yawRad: number } {
  const dx = a.position[0] - b.position[0];
  const dy = a.position[1] - b.position[1];
  const dz = a.position[2] - b.position[2];
  return {
    posM: Math.hypot(dx, dy, dz),
    yawRad: wrapAngleDiff(a.yaw, b.yaw),
  };
}

/** Validate a baked cinematic bundle against all CUTSCENE-LANE-SPEC §7 bake gates. */
export function validateCinematicBundle(input: ValidateCinematicInput): CinematicValidationReport {
  const { def, manifest, recording } = input;
  const posTol = input.posToleranceM ?? DEFAULT_ARRIVAL_POS_TOLERANCE_M;
  const yawTol = input.yawToleranceRad ?? DEFAULT_ARRIVAL_YAW_TOLERANCE_RAD;
  const errors: string[] = [];

  if (manifest.id !== def.id) {
    errors.push(`manifest.id "${manifest.id}" does not match def.id "${def.id}"`);
  }

  // 1. Reproducibility gate: dual bake must hash identically.
  const reproducibility =
    manifest.secondBakeTrackHash !== undefined && manifest.secondBakeTrackHash === manifest.trackHash;
  if (!reproducibility) {
    errors.push(
      manifest.secondBakeTrackHash === undefined
        ? "reproducibility gate: secondBakeTrackHash missing (every bake must run twice)"
        : `reproducibility gate: secondBakeTrackHash (${manifest.secondBakeTrackHash}) !== trackHash (${manifest.trackHash})`,
    );
  }

  // 2. Clip validity gate: bone budget, NaN/Inf, joint limits.
  let clipValidity = true;
  if (recording.hasNonFiniteSamples) {
    clipValidity = false;
    errors.push("clipValidity gate: recording contains non-finite (NaN/Inf) samples");
  }
  if (recording.jointLimitViolations > 0) {
    clipValidity = false;
    errors.push(`clipValidity gate: ${recording.jointLimitViolations} joint-limit violation(s) flagged`);
  }
  if (recording.boneCount > recording.maxBoneBudget) {
    clipValidity = false;
    errors.push(
      `clipValidity gate: boneCount (${recording.boneCount}) exceeds budget (${recording.maxBoneBudget})`,
    );
  }

  // 3. Arrival gate: final recorded pose within tolerance of declared exitPoses.
  let arrival = true;
  for (const actor of def.actorSlots) {
    const expected = def.exitPoses[actor.slot];
    const actual = recording.actorFinalPoses[actor.slot];
    if (!actual) {
      arrival = false;
      errors.push(`arrival gate: missing final recorded pose for actor "${actor.slot}"`);
      continue;
    }
    const delta = poseDistance(actual, expected);
    if (delta.posM > posTol || delta.yawRad > yawTol) {
      arrival = false;
      errors.push(
        `arrival gate: actor "${actor.slot}" drift pos=${delta.posM.toFixed(3)}m yaw=${delta.yawRad.toFixed(3)}rad exceeds (${posTol}m, ${yawTol}rad)`,
      );
    }
  }
  for (const prop of def.props) {
    if (prop.kind !== "dynamic") continue;
    const expected = def.exitPoses[prop.prop];
    if (!expected) continue;
    const actual = recording.propFinalPoses[prop.prop];
    if (!actual) {
      arrival = false;
      errors.push(`arrival gate: missing final recorded pose for dynamic prop "${prop.prop}"`);
      continue;
    }
    const delta = poseDistance(actual, expected);
    if (delta.posM > posTol || delta.yawRad > yawTol) {
      arrival = false;
      errors.push(
        `arrival gate: dynamic prop "${prop.prop}" drift pos=${delta.posM.toFixed(3)}m yaw=${delta.yawRad.toFixed(3)}rad exceeds (${posTol}m, ${yawTol}rad)`,
      );
    }
  }

  // 4. Duration gate.
  const duration =
    manifest.durationSec <= def.durationCapSec && recording.durationSec <= def.durationCapSec;
  if (!duration) {
    errors.push(
      `duration gate: duration (${Math.max(manifest.durationSec, recording.durationSec)}s) exceeds durationCapSec (${def.durationCapSec}s)`,
    );
  }

  // 5. Bundle budget gate (<= 2 MB compressed).
  const bundleBudget = manifest.compressedBytes <= MAX_CINEMATIC_BUNDLE_BYTES;
  if (!bundleBudget) {
    errors.push(
      `bundleBudget gate: compressedBytes (${manifest.compressedBytes}) exceeds ${MAX_CINEMATIC_BUNDLE_BYTES} bytes (2 MB)`,
    );
  }

  // 6. License / provenance / verb registry check.
  const license = manifest.sourceLicenses.every((l) => !/^(unknown|unverified)$/i.test(l.trim()));
  if (!license) {
    errors.push("license gate: unverified or unknown source license in manifest.sourceLicenses");
  }
  if (input.knownVerbs) {
    for (const v of [...def.preVerbs, ...def.postVerbs]) {
      if (!input.knownVerbs.has(v.verb)) {
        errors.push(`unknown server verb "${v.verb}" referenced in cinematic`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    gates: {
      reproducibility,
      clipValidity,
      arrival,
      duration,
      bundleBudget,
      license,
    },
    errors,
  };
}
