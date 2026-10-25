/**
 * FirstPersonRig — first-person viewmodel for the player's hands, forearms,
 * gauntlets, held main-hand / off-hand weapons, and swing arc trail.
 *
 * Designed with DoD principles:
 * - Zero heap allocations in `update()` on the per-frame render hot path.
 * - Driven by the same `FirstPersonMotionSample` (breathing, stride phase,
 *   bob weight), mouse-look inertia deltas, authoritative `ActionRow` combat
 *   moves (`SwordA`, `SwordB`, `SwordC`, `Guard`, `ShieldBash`, `Roll`), and
 *   active combat stance (`technique` + `aim` body part).
 * - Supports both async `SyntyProps` GLTF weapon meshes and immediate
 *   procedural weapon/shield geometry for every item base (`sword`,
 *   `greatsword`, `axe`, `mace`, `dagger`, `spear`, `staff`, `wand`, `bow`,
 *   `shield`), plus articulated left/right forearms, hands, fingers, and
 *   cuffs tinted from the player's `CharacterLook`.
 */

import * as THREE from "three";
import { combatMove, Move } from "@mmo-engine/protocol";
import type { FirstPersonMotionSample } from "./first-person-camera.js";
import { fnv1a32, type SyntyProps } from "./synty-props.js";

export type WeaponVisualKind =
  | "unarmed"
  | "sword"
  | "greatsword"
  | "axe"
  | "mace"
  | "dagger"
  | "spear"
  | "staff"
  | "wand"
  | "bow"
  | "shield";

export interface FirstPersonHandColors {
  skin: string;
  sleeve: string;
  cuff: string;
  metal: string;
}

export const DEFAULT_HAND_COLORS: Readonly<FirstPersonHandColors> = Object.freeze({
  skin: "#d8a984",
  sleeve: "#2f3644",
  cuff: "#6a4c32",
  metal: "#9aa3ad",
});

/**
 * Canonical Synty art pack prop models for each weapon category (matching content/rules/items.json).
 * Used as the primary high-fidelity visual asset; if unavailable or missing from the loaded catalog,
 * FirstPersonRig gracefully falls back to the clean procedural weapon mesh.
 */
export const DEFAULT_SYNTY_WEAPON_MODELS: Readonly<Partial<Record<WeaponVisualKind, string>>> = Object.freeze({
  sword: "dungeon-pack/SM_Wep_Straightsword_01",
  greatsword: "dungeon-pack/SM_Wep_GreatSword_01",
  axe: "dungeon-pack/SM_Wep_Axe_01",
  mace: "fantasy-kingdom/SM_Wep_Mace_01",
  dagger: "fantasy-kingdom/SM_Wep_Dagger_01",
  spear: "dungeon-pack/SM_Wep_Spear_01",
  staff: "fantasy-kingdom/SM_Wep_Staff_01",
  wand: "fantasy-kingdom/SM_Wep_Sceptre_01",
  shield: "dungeon-pack/SM_Wep_Shield_Bone_01",
});

/**
 * Resolve the Synty prop asset identifier for a given equipment model string or item base.
 * If the string contains an art pack path (e.g. "fantasy-kingdom/SM_Wep_Sword_02"), it is preserved.
 * Otherwise, the standard Synty prop for that weapon category is returned.
 */
export function resolveSyntyWeaponModel(
  modelOrBase: string | null | undefined,
  kind: WeaponVisualKind,
): string | null {
  if (!modelOrBase || kind === "unarmed") return null;
  if (modelOrBase.includes("/")) return modelOrBase;
  return DEFAULT_SYNTY_WEAPON_MODELS[kind] ?? null;
}

export interface FirstPersonRigUpdate {
  dt: number;
  camera: THREE.Camera;
  lookYaw: number;
  lookPitch: number;
  motion: FirstPersonMotionSample;
  /** Active Move id from authoritative Action component (`Move.None` when idle). */
  move?: number;
  /** Seconds elapsed since `Action.started`. */
  moveElapsed?: number;
  /** Chosen stance technique ("cut" | "thrust" | "bludgeon" | null). */
  technique?: string | null;
  /** Effective aimed body part ("head" | "torso" | "armUpperLeft" | "armUpperRight" | "legLeft" | "legRight"). */
  aimPart?: string | null;
}

export interface HandPose {
  px: number;
  py: number;
  pz: number;
  rx: number;
  ry: number;
  rz: number;
}

export interface EvaluatedRigPose {
  rightHand: HandPose;
  leftHand: HandPose;
  swingIntensity: number;
}

/** Infer a `WeaponVisualKind` from an item base name or art catalog model path. */
export function inferWeaponKind(baseOrModel: string | null | undefined, hand: "main" | "off" = "main"): WeaponVisualKind {
  if (!baseOrModel) return "unarmed";
  const s = baseOrModel.toLowerCase();
  if (s.includes("shield") || hand === "off" && s.includes("buckler")) return "shield";
  if (s.includes("greatsword")) return "greatsword";
  if (s.includes("dagger") || s.includes("knife")) return "dagger";
  if (s.includes("sword") || s.includes("cutlass") || s.includes("blade")) return "sword";
  if (s.includes("axe") || s.includes("hatchet")) return "axe";
  if (s.includes("mace") || s.includes("hammer") || s.includes("club")) return "mace";
  if (s.includes("spear") || s.includes("halberd") || s.includes("pike")) return "spear";
  if (s.includes("staff")) return "staff";
  if (s.includes("wand") || s.includes("sceptre")) return "wand";
  if (s.includes("bow")) return "bow";
  return hand === "off" ? "shield" : "sword";
}

/** Smooth hermite pulse on [0, 1] peaking at `peak`. */
function pulse(p: number, peak: number): number {
  if (p <= 0 || p >= 1) return 0;
  if (p < peak) {
    const u = p / peak;
    return u * u * (3 - 2 * u);
  }
  const u = (p - peak) / (1 - peak);
  return 1 - u * u * (3 - 2 * u);
}

/**
 * Pure DoD pose evaluator for the left and right hands in camera space
 * (+X right, +Y up, -Z forward along the view ray).
 * Exported so unit tests and benchmarks can verify hand/weapon trajectories
 * deterministically without a WebGL context.
 */
export function evaluateFirstPersonPose(
  motion: FirstPersonMotionSample,
  move: number,
  moveElapsed: number,
  technique: string | null | undefined,
  aimPart: string | null | undefined,
  mainKind: WeaponVisualKind,
  offKind: WeaponVisualKind,
  swayYaw: number,
  swayPitch: number,
  out: EvaluatedRigPose,
): EvaluatedRigPose {
  const R = out.rightHand;
  const L = out.leftHand;

  // Base rest positions in camera space (+X right, +Y up, -Z forward)
  const armed = mainKind !== "unarmed";
  const hasShield = offKind === "shield";
  const twoHanded = mainKind === "greatsword" || mainKind === "spear" || mainKind === "staff";

  R.px = armed ? 0.25 : 0.22;
  R.py = armed ? -0.24 : -0.22;
  R.pz = armed ? -0.44 : -0.38;
  R.rx = armed ? 0.22 : 0.45;
  R.ry = armed ? -0.18 : -0.25;
  R.rz = armed ? -0.14 : -0.18;

  L.px = twoHanded ? 0.08 : hasShield ? -0.27 : -0.22;
  L.py = twoHanded ? -0.26 : hasShield ? -0.22 : -0.24;
  L.pz = twoHanded ? -0.42 : hasShield ? -0.40 : -0.38;
  L.rx = hasShield ? 0.12 : 0.42;
  L.ry = hasShield ? 0.32 : 0.25;
  L.rz = hasShield ? 0.10 : 0.18;

  // Stance technique posture adjustments (Cut / Thrust / Bludgeon)
  if (technique === "thrust") {
    // Point-in-line fencing guard: tip angled forward toward reticle center
    R.px -= 0.04;
    R.py += 0.02;
    R.pz -= 0.05;
    R.rx -= 0.42;
    R.ry += 0.12;
    R.rz += 0.08;
  } else if (technique === "bludgeon") {
    // High poised crush guard
    R.px += 0.02;
    R.py += 0.05;
    R.rx += 0.24;
    R.rz -= 0.16;
  } else if (technique === "cut") {
    // Diagonal slash guard
    R.rx += 0.08;
    R.rz -= 0.08;
  }

  // Aimed body-part elevation & lateral bias
  if (aimPart === "head") {
    R.py += 0.035;
    R.rx += 0.12;
  } else if (aimPart === "legLeft" || aimPart === "legRight") {
    R.py -= 0.035;
    R.rx -= 0.12;
  } else if (aimPart === "armUpperLeft") {
    R.px -= 0.025;
    R.ry += 0.08;
  } else if (aimPart === "armUpperRight") {
    R.px += 0.025;
    R.ry -= 0.08;
  }

  // Idle breathing sway
  const bp = motion.breathPhase;
  const breathY = Math.sin(bp) * 0.009;
  const breathX = Math.cos(bp * 0.5) * 0.005;
  R.px += breathX;
  R.py += breathY;
  L.px -= breathX;
  L.py += breathY * 0.9;

  // Stride-synchronized counter-swing during walking / jogging / sprinting
  const w = motion.bobWeight;
  const sp = motion.stridePhase;
  if (w > 0.001) {
    const swingR = Math.sin(sp) * w;
    const bounce = Math.abs(Math.cos(sp)) * w;
    R.px += swingR * 0.028;
    R.py += -bounce * 0.032 + Math.cos(sp) * 0.016 * w;
    R.pz += -swingR * 0.045;
    R.rx += swingR * 0.14;
    R.rz += -swingR * 0.08;

    L.px += swingR * 0.028;
    L.py += -bounce * 0.032 - Math.cos(sp) * 0.016 * w;
    L.pz += swingR * 0.045;
    L.rx += -swingR * 0.14;
    L.rz += -swingR * 0.08;
  }

  // Mouse-look inertia lag
  R.px += swayYaw * 0.045;
  R.py += swayPitch * 0.045;
  R.ry += swayYaw * 0.35;
  R.rx += swayPitch * 0.25;

  L.px += swayYaw * 0.04;
  L.py += swayPitch * 0.04;
  L.ry += swayYaw * 0.28;
  L.rx += swayPitch * 0.22;

  // Combat move choreography
  out.swingIntensity = 0;
  if (move !== Move.None && moveElapsed >= 0) {
    const def = combatMove(move);
    const duration = def?.duration ?? 1.0;
    const p = Math.min(1, moveElapsed / Math.max(0.05, duration));

    switch (move) {
      case Move.SwordA: {
        // Right-to-left diagonal slash (hitAt = 0.2s)
        const wind = pulse(Math.min(1, moveElapsed / 0.16), 0.7);
        const slash = pulse(Math.max(0, (moveElapsed - 0.10) / 0.38), 0.28);
        out.swingIntensity = slash;
        if (technique === "thrust") {
          // Deep forward lunge thrust toward center reticle
          R.px += wind * 0.06 - slash * 0.18;
          R.py += -wind * 0.04 + slash * 0.08;
          R.pz += wind * 0.10 - slash * 0.34;
          R.rx += wind * 0.25 - slash * 0.85;
          R.ry += -wind * 0.10 + slash * 0.28;
        } else {
          // Sweeping diagonal slash across the screen
          R.px += wind * 0.14 - slash * 0.42;
          R.py += wind * 0.14 - slash * 0.18;
          R.pz += wind * 0.06 - slash * 0.22;
          R.rx += wind * 0.45 - slash * 1.15;
          R.ry += -wind * 0.35 + slash * 1.05;
          R.rz += -wind * 0.35 + slash * 0.85;
        }
        // Left hand counter-balances
        L.px -= slash * 0.06;
        L.pz += slash * 0.06;
        break;
      }
      case Move.SwordB: {
        // Left-to-right backhand / return cleave (hitAt = 0.23s)
        const wind = pulse(Math.min(1, moveElapsed / 0.18), 0.7);
        const slash = pulse(Math.max(0, (moveElapsed - 0.12) / 0.42), 0.28);
        out.swingIntensity = slash;
        R.px += -wind * 0.32 + slash * 0.46;
        R.py += wind * 0.08 - slash * 0.14;
        R.pz += -wind * 0.06 - slash * 0.24;
        R.rx += wind * 0.30 - slash * 1.05;
        R.ry += wind * 0.75 - slash * 1.10;
        R.rz += wind * 0.55 - slash * 0.90;

        L.px -= wind * 0.05;
        L.py -= slash * 0.04;
        break;
      }
      case Move.SwordC: {
        // Heavy overhead finisher (hitAt = 0.43s)
        const wind = pulse(Math.min(1, moveElapsed / 0.34), 0.72);
        const slam = pulse(Math.max(0, (moveElapsed - 0.28) / 0.58), 0.25);
        out.swingIntensity = slam;
        R.px += -wind * 0.10 - slam * 0.16;
        R.py += wind * 0.26 - slam * 0.36;
        R.pz += wind * 0.05 - slam * 0.32;
        R.rx += wind * 0.75 - slam * 1.55;
        R.ry += wind * 0.20 + slam * 0.25;
        R.rz += wind * 0.18 + slam * 0.22;

        // Off-hand braces or joins two-handed overhead slam
        L.px += wind * 0.08 - slam * 0.04;
        L.py += wind * 0.18 - slam * 0.24;
        L.pz -= slam * 0.14;
        break;
      }
      case Move.SwordARecover:
      case Move.SwordBRecover: {
        const rec = Math.sin(p * Math.PI) * (1 - p * 0.5);
        R.px -= rec * 0.08;
        R.py -= rec * 0.06;
        R.rx -= rec * 0.25;
        break;
      }
      case Move.Guard: {
        // High defensive guard: shield raised front-and-center, or blade held diagonally across face
        const g = Math.min(1, moveElapsed / 0.12);
        const ease = g * g * (3 - 2 * g);
        if (hasShield) {
          L.px += 0.15 * ease;
          L.py += 0.14 * ease;
          L.pz -= 0.08 * ease;
          L.rx += 0.18 * ease;
          L.ry += 0.38 * ease;
          L.rz -= 0.12 * ease;

          R.px += 0.04 * ease;
          R.py += 0.06 * ease;
          R.rx += 0.25 * ease;
        } else {
          // Cross-guard parry posture
          R.px -= 0.14 * ease;
          R.py += 0.14 * ease;
          R.pz -= 0.06 * ease;
          R.rx += 0.32 * ease;
          R.ry += 0.55 * ease;
          R.rz += 0.68 * ease;

          L.px += 0.10 * ease;
          L.py += 0.12 * ease;
          L.pz -= 0.05 * ease;
          L.rx += 0.35 * ease;
        }
        break;
      }
      case Move.ShieldBash: {
        const bash = pulse(p, 0.25);
        out.swingIntensity = bash * 0.85;
        L.px += 0.18 * bash;
        L.py += 0.14 * bash;
        L.pz -= 0.32 * bash;
        L.rx -= 0.35 * bash;
        L.ry += 0.45 * bash;

        R.px += 0.06 * bash;
        R.pz += 0.05 * bash;
        break;
      }
      case Move.Roll: {
        const tuck = Math.sin(p * Math.PI);
        R.py -= 0.16 * tuck;
        R.pz += 0.08 * tuck;
        R.rx += 0.65 * tuck;
        L.py -= 0.16 * tuck;
        L.pz += 0.08 * tuck;
        L.rx += 0.65 * tuck;
        break;
      }
      default:
        break;
    }
  }

  return out;
}

/** Build an articulated procedural forearm + gauntlet cuff + palm + fingers + thumb mesh group. */
function buildHandGroup(side: "left" | "right", colors: FirstPersonHandColors): {
  root: THREE.Group;
  skinMat: THREE.MeshStandardMaterial;
  sleeveMat: THREE.MeshStandardMaterial;
  cuffMat: THREE.MeshStandardMaterial;
  socket: THREE.Group;
} {
  const sign = side === "right" ? 1 : -1;
  const root = new THREE.Group();
  root.name = `fps-hand-${side}`;

  const skinMat = new THREE.MeshStandardMaterial({ color: colors.skin, roughness: 0.65, metalness: 0.05 });
  const sleeveMat = new THREE.MeshStandardMaterial({ color: colors.sleeve, roughness: 0.8, metalness: 0.1 });
  const cuffMat = new THREE.MeshStandardMaterial({ color: colors.cuff, roughness: 0.55, metalness: 0.25 });

  // Forearm sleeve extending back toward the shoulder (+Z in camera space)
  const forearmGeo = new THREE.BoxGeometry(0.082, 0.078, 0.28);
  const forearm = new THREE.Mesh(forearmGeo, sleeveMat);
  forearm.position.set(sign * 0.01, -0.02, 0.18);
  forearm.rotation.x = -0.12;
  root.add(forearm);

  // Bracer / gauntlet cuff around wrist
  const cuffGeo = new THREE.BoxGeometry(0.092, 0.088, 0.09);
  const cuff = new THREE.Mesh(cuffGeo, cuffMat);
  cuff.position.set(sign * 0.004, -0.006, 0.055);
  root.add(cuff);

  // Palm / hand dorsum
  const palmGeo = new THREE.BoxGeometry(0.084, 0.052, 0.095);
  const palm = new THREE.Mesh(palmGeo, skinMat);
  palm.position.set(0, 0, -0.025);
  root.add(palm);

  // Curled fingers gripping forward
  const fingersGeo = new THREE.BoxGeometry(0.078, 0.044, 0.052);
  const fingers = new THREE.Mesh(fingersGeo, skinMat);
  fingers.position.set(0, -0.008, -0.082);
  fingers.rotation.x = 0.35;
  root.add(fingers);

  // Thumb on the inner side of the hand
  const thumbGeo = new THREE.BoxGeometry(0.032, 0.034, 0.062);
  const thumb = new THREE.Mesh(thumbGeo, skinMat);
  thumb.position.set(-sign * 0.046, 0.008, -0.042);
  thumb.rotation.y = sign * 0.38;
  root.add(thumb);

  // Weapon attachment socket at the grip center
  const socket = new THREE.Group();
  socket.name = `fps-socket-${side}`;
  socket.position.set(0, 0.01, -0.055);
  root.add(socket);

  return { root, skinMat, sleeveMat, cuffMat, socket };
}

/** Build a clean, readable procedural weapon or shield mesh for `kind`. */
export function buildProceduralWeaponMesh(kind: WeaponVisualKind, rankColor = "#cfd6df"): THREE.Group {
  const group = new THREE.Group();
  group.name = `fps-weapon-${kind}`;
  if (kind === "unarmed") return group;

  const steelMat = new THREE.MeshStandardMaterial({
    color: "#d4dce6",
    roughness: 0.28,
    metalness: 0.82,
  });
  const guardMat = new THREE.MeshStandardMaterial({
    color: "#b89648",
    roughness: 0.38,
    metalness: 0.68,
  });
  const gripMat = new THREE.MeshStandardMaterial({
    color: "#4a3020",
    roughness: 0.78,
    metalness: 0.1,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: rankColor || "#7aa2f7",
    roughness: 0.35,
    metalness: 0.5,
    emissive: new THREE.Color(rankColor || "#3b5998"),
    emissiveIntensity: 0.15,
  });

  if (kind === "shield") {
    // Heater / round-boss shield held in the left hand
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.52, 0.035), gripMat);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.55, 0.022), steelMat);
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.045, 12), guardMat);
    boss.rotation.x = Math.PI / 2;
    boss.position.z = -0.025;
    group.add(rim, body, boss);
    group.position.set(-0.04, 0.04, -0.05);
    group.rotation.set(0.1, 0.35, 0);
    return group;
  }

  // Handle / grip along local +Y
  const isLong = kind === "greatsword" || kind === "spear" || kind === "staff";
  const gripLen = isLong ? 0.28 : 0.16;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, gripLen, 8), gripMat);
  grip.position.y = 0;
  group.add(grip);

  // Pommel
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 8), guardMat);
  pommel.position.y = -gripLen * 0.5 - 0.015;
  group.add(pommel);

  if (kind === "sword" || kind === "greatsword" || kind === "dagger") {
    const bladeLen = kind === "greatsword" ? 0.78 : kind === "dagger" ? 0.28 : 0.56;
    const bladeWidth = kind === "greatsword" ? 0.062 : kind === "dagger" ? 0.034 : 0.046;
    const crossWidth = kind === "greatsword" ? 0.22 : kind === "dagger" ? 0.10 : 0.16;

    const guard = new THREE.Mesh(new THREE.BoxGeometry(crossWidth, 0.024, 0.036), guardMat);
    guard.position.y = gripLen * 0.5 + 0.01;
    group.add(guard);

    const blade = new THREE.Mesh(new THREE.BoxGeometry(bladeWidth, bladeLen, 0.012), steelMat);
    blade.position.y = gripLen * 0.5 + 0.02 + bladeLen * 0.5;
    group.add(blade);

    const fuller = new THREE.Mesh(new THREE.BoxGeometry(bladeWidth * 0.35, bladeLen * 0.75, 0.015), accentMat);
    fuller.position.y = gripLen * 0.5 + 0.02 + bladeLen * 0.42;
    group.add(fuller);
  } else if (kind === "axe") {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.02, 0.52, 8), gripMat);
    shaft.position.y = 0.18;
    group.add(shaft);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.15, 0.024), steelMat);
    head.position.set(-0.05, 0.38, 0);
    group.add(head);
  } else if (kind === "mace") {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.46, 8), gripMat);
    shaft.position.y = 0.16;
    group.add(shaft);

    const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.075, 0), steelMat);
    head.position.y = 0.42;
    group.add(head);
  } else if (kind === "spear") {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.92, 8), gripMat);
    shaft.position.y = 0.32;
    group.add(shaft);

    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.18, 6), steelMat);
    tip.position.y = 0.86;
    group.add(tip);
  } else if (kind === "staff" || kind === "wand") {
    const len = kind === "staff" ? 0.85 : 0.38;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, len, 8), gripMat);
    shaft.position.y = len * 0.35;
    group.add(shaft);

    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.045, 0), accentMat);
    gem.position.y = len * 0.85 + 0.04;
    group.add(gem);
  } else if (kind === "bow") {
    const limb = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.015, 6, 16, Math.PI * 0.85), gripMat);
    limb.rotation.z = -Math.PI * 0.42;
    limb.position.set(0, 0.12, -0.05);
    group.add(limb);
  }

  // Tilt weapon forward slightly from vertical grip so blade points up-and-forward (-Z/+Y)
  group.rotation.x = -0.58;
  return group;
}

/**
 * First-person viewmodel rig. Added to the main scene and synchronized with
 * the active camera every frame when `view === "first"`.
 */
export class FirstPersonRig {
  readonly root = new THREE.Group();
  readonly rightHandGroup: THREE.Group;
  readonly leftHandGroup: THREE.Group;
  private readonly rightSocket: THREE.Group;
  private readonly leftSocket: THREE.Group;
  private readonly rightMaterials: {
    skin: THREE.MeshStandardMaterial;
    sleeve: THREE.MeshStandardMaterial;
    cuff: THREE.MeshStandardMaterial;
  };
  private readonly leftMaterials: {
    skin: THREE.MeshStandardMaterial;
    sleeve: THREE.MeshStandardMaterial;
    cuff: THREE.MeshStandardMaterial;
  };
  private readonly swingTrail: THREE.Mesh;
  private readonly swingTrailMat: THREE.MeshBasicMaterial;

  private mainKey: string | null = null;
  private offKey: string | null = null;
  private mainKind: WeaponVisualKind = "unarmed";
  private offKind: WeaponVisualKind = "unarmed";
  private mainModelId: string | null = null;
  private offModelId: string | null = null;
  private mainHasSynty = false;
  private offHasSynty = false;

  private prevLookYaw = 0;
  private prevLookPitch = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  private hasPrevLook = false;

  private readonly poseScratch: EvaluatedRigPose = {
    rightHand: { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
    leftHand: { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
    swingIntensity: 0,
  };

  constructor(private readonly props?: SyntyProps) {
    this.root.name = "first-person-rig";
    this.root.visible = false;

    const right = buildHandGroup("right", DEFAULT_HAND_COLORS);
    const left = buildHandGroup("left", DEFAULT_HAND_COLORS);
    this.rightHandGroup = right.root;
    this.leftHandGroup = left.root;
    this.rightSocket = right.socket;
    this.leftSocket = left.socket;
    this.rightMaterials = { skin: right.skinMat, sleeve: right.sleeveMat, cuff: right.cuffMat };
    this.leftMaterials = { skin: left.skinMat, sleeve: left.sleeveMat, cuff: left.cuffMat };

    // Dynamic weapon slash arc ribbon mounted on the right hand socket
    const trailGeo = new THREE.RingGeometry(0.22, 0.58, 16, 1, -Math.PI * 0.35, Math.PI * 0.7);
    this.swingTrailMat = new THREE.MeshBasicMaterial({
      color: 0xe8f1ff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.swingTrail = new THREE.Mesh(trailGeo, this.swingTrailMat);
    this.swingTrail.name = "fps-swing-trail";
    this.swingTrail.position.set(0, 0.25, -0.05);
    this.swingTrail.rotation.y = Math.PI * 0.5;
    this.rightSocket.add(this.swingTrail);

    this.root.add(this.rightHandGroup, this.leftHandGroup);
  }

  /** Show or hide the first-person hands & weapon viewmodel. */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
    if (!visible) {
      this.hasPrevLook = false;
      this.swayYaw = 0;
      this.swayPitch = 0;
    }
  }

  /** Tint skin, sleeve, and cuff materials to match the player's `CharacterLook`. */
  setColors(colors: Partial<FirstPersonHandColors>): void {
    if (colors.skin) {
      this.rightMaterials.skin.color.set(colors.skin);
      this.leftMaterials.skin.color.set(colors.skin);
    }
    if (colors.sleeve) {
      this.rightMaterials.sleeve.color.set(colors.sleeve);
      this.leftMaterials.sleeve.color.set(colors.sleeve);
    }
    if (colors.cuff) {
      this.rightMaterials.cuff.color.set(colors.cuff);
      this.leftMaterials.cuff.color.set(colors.cuff);
    }
  }

  /**
   * Synchronize equipped main-hand and off-hand items.
   * Renders procedural weapon geometry immediately and upgrades to the
   * `SyntyProps` GLB model when available.
   */
  setEquipment(
    mainModelOrBase: string | null | undefined,
    offModelOrBase: string | null | undefined,
    mainColor?: string,
  ): void {
    const nextMain = mainModelOrBase || null;
    const nextOff = offModelOrBase || null;

    if (nextMain !== this.mainKey) {
      this.mainKey = nextMain;
      this.mainKind = inferWeaponKind(nextMain, "main");
      this.attachSlot("main", nextMain, this.mainKind, mainColor);
    }
    if (nextOff !== this.offKey) {
      this.offKey = nextOff;
      this.offKind = inferWeaponKind(nextOff, "off");
      this.attachSlot("off", nextOff, this.offKind, mainColor);
    }
  }

  private clearSocket(socket: THREE.Group): void {
    for (let i = socket.children.length - 1; i >= 0; i--) {
      const child = socket.children[i]!;
      if (child === this.swingTrail) continue;
      socket.remove(child);
    }
  }

  private tryAttachSyntyProp(hand: "main" | "off"): boolean {
    if (!this.props) return false;
    const modelId = hand === "main" ? this.mainModelId : this.offModelId;
    if (!modelId) return false;
    const ready = this.props.model(fnv1a32(modelId), 0);
    if (!ready) return false;

    const socket = hand === "main" ? this.rightSocket : this.leftSocket;
    this.clearSocket(socket);
    const mesh = new THREE.Mesh(ready.geometry, ready.material);
    mesh.name = `fps-synty-${hand}`;
    if (hand === "main") {
      mesh.rotation.x = -0.58;
    } else {
      mesh.position.set(-0.04, 0.04, -0.05);
      mesh.rotation.set(0.1, 0.35, 0);
    }
    socket.add(mesh);
    if (hand === "main") this.mainHasSynty = true;
    else this.offHasSynty = true;
    return true;
  }

  private attachSlot(
    hand: "main" | "off",
    modelOrBase: string | null,
    kind: WeaponVisualKind,
    rankColor?: string,
  ): void {
    const socket = hand === "main" ? this.rightSocket : this.leftSocket;
    this.clearSocket(socket);
    if (hand === "main") {
      this.mainHasSynty = false;
      this.mainModelId = resolveSyntyWeaponModel(modelOrBase, kind);
    } else {
      this.offHasSynty = false;
      this.offModelId = resolveSyntyWeaponModel(modelOrBase, kind);
    }
    if (!modelOrBase || kind === "unarmed") return;

    // 1. Immediate procedural weapon/shield mesh so the hand is never empty while loading
    const fallback = buildProceduralWeaponMesh(kind, rankColor);
    socket.add(fallback);

    // 2. Try loading Synty prop model immediately if already available
    this.tryAttachSyntyProp(hand);
  }

  /** Current main-hand weapon visual family. */
  get mainWeaponKind(): WeaponVisualKind {
    return this.mainKind;
  }

  /** Current off-hand visual family. */
  get offWeaponKind(): WeaponVisualKind {
    return this.offKind;
  }

  /** Whether the main-hand slot is currently showing a loaded Synty prop mesh. */
  get hasMainSyntyMesh(): boolean {
    return this.mainHasSynty;
  }

  /** Whether the off-hand slot is currently showing a loaded Synty prop mesh. */
  get hasOffSyntyMesh(): boolean {
    return this.offHasSynty;
  }

  /**
   * Per-frame update: locks the rig root to the active first-person camera
   * and evaluates hand/weapon poses without heap allocations.
   */
  update(u: FirstPersonRigUpdate): EvaluatedRigPose {
    const dt = Math.max(0, Math.min(0.1, u.dt));

    // Align rig root with camera world transform
    this.root.position.copy(u.camera.position);
    this.root.quaternion.copy(u.camera.quaternion);

    // Smooth mouse-look inertia sway
    if (!this.hasPrevLook) {
      this.prevLookYaw = u.lookYaw;
      this.prevLookPitch = u.lookPitch;
      this.hasPrevLook = true;
    }
    let dyaw = u.lookYaw - this.prevLookYaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const dpitch = u.lookPitch - this.prevLookPitch;
    this.prevLookYaw = u.lookYaw;
    this.prevLookPitch = u.lookPitch;

    const decay = Math.exp(-dt * 14);
    this.swayYaw = Math.max(-0.8, Math.min(0.8, this.swayYaw * decay + dyaw * 2.2));
    this.swayPitch = Math.max(-0.8, Math.min(0.8, this.swayPitch * decay + dpitch * 2.2));

    const pose = evaluateFirstPersonPose(
      u.motion,
      u.move ?? Move.None,
      u.moveElapsed ?? 0,
      u.technique,
      u.aimPart,
      this.mainKind,
      this.offKind,
      this.swayYaw,
      this.swayPitch,
      this.poseScratch,
    );

    this.rightHandGroup.position.set(pose.rightHand.px, pose.rightHand.py, pose.rightHand.pz);
    this.rightHandGroup.rotation.set(pose.rightHand.rx, pose.rightHand.ry, pose.rightHand.rz);

    this.leftHandGroup.position.set(pose.leftHand.px, pose.leftHand.py, pose.leftHand.pz);
    this.leftHandGroup.rotation.set(pose.leftHand.rx, pose.leftHand.ry, pose.leftHand.rz);

    // Weapon swing arc ribbon visibility & opacity during active strikes
    const trailAlpha = pose.swingIntensity * (this.mainKind === "unarmed" ? 0.22 : 0.48);
    this.swingTrailMat.opacity = trailAlpha;
    this.swingTrail.visible = trailAlpha > 0.02;

    // Seamlessly swap pending Synty weapon/shield models once ready from asset stream
    if (this.props) {
      if (this.mainModelId && !this.mainHasSynty) {
        this.tryAttachSyntyProp("main");
      }
      if (this.offModelId && !this.offHasSynty) {
        this.tryAttachSyntyProp("off");
      }
    }

    return pose;
  }
}
