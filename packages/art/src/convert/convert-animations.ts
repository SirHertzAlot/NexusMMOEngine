/**
 * convert-animations — animation libraries retargeted onto the Modular
 * Fantasy Hero rig:
 *
 *   <assets>/models/glb/modular-fantasy-hero/Rigged/
 *     animations/<source>.glb   a source's clips, as tracks on the rig's bones
 *     animations.json           what each clip is (source, duration, loop, travel)
 *
 *   node dist/src/convert/convert-animations.js [--assets <dir>]
 *
 * Sources are listed in ANIMATION_SOURCES: where the library sits under
 * <assets> (one file of many clips, or a folder of one-clip files), its
 * skeleton's bone names for ours, and its licence. Missing sources are
 * skipped (each machine converts what it has); a clip name already taken
 * by an earlier source is skipped too (packs repeat their idles). Clips play in
 * place: horizontal root motion is taken out and reported as `travel`,
 * for the server to move the character itself. `_RM` (root motion)
 * duplicates of in-place clips are skipped; a clip only in root-motion form
 * (a combo's lunge) keeps its travel.
 *
 * Licences differ per source (Kevin Iglesias's may not be redistributed);
 * the files all stay under the ignored assets/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { installNodeShims, loadFbx } from "./convert-packs.js";
import { Retargeter } from "./retarget.js";
import type { AnimationClipInfo, AnimationManifest } from "../character/animations.js";

const RIG_DIR = "models/glb/modular-fantasy-hero/Rigged";

export interface AnimationSource {
  id: string;
  title: string;
  author: string;
  license: string;
  url: string;
  /** One library file holding every clip, relative to <assets>… */
  file?: string;
  /** …or a folder of one-clip files (relative paths matching `include`). */
  dir?: string;
  include?: RegExp;
  /** A clip's name in our library, from its own name and file (null leaves it out). */
  rename?: (clip: string, file: string) => string | null;
  hips: string;
  root?: string;
  /** Our bone → theirs. */
  map: Record<string, string>;
  /**
   * Long raw takes kept for reference (and for cutting moves from), not
   * loaded by the game client.
   */
  reference?: boolean;
  /** Stand the source up facing +Z (see RetargetSourceRig.rotate). */
  rotate?: [number, number, number];
  /** Clips to leave out. */
  skip?: RegExp;
}

/** A side-symmetric bone map from `[ours, theirs]` pairs with {S}/{s} side tokens. */
function sided(pairs: Array<[string, string]>, sides: { L: [string, string]; R: [string, string] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ours, theirs] of pairs) {
    if (!ours.includes("{S}")) {
      out[ours] = theirs;
      continue;
    }
    for (const side of ["L", "R"] as const) {
      out[ours.replace("{S}", side)] = theirs.replace("{s}", sides[side][1]).replace("{S}", sides[side][0]);
    }
  }
  return out;
}

/** Rigify (Blender) DEF bones — Quaternius Universal Animation Library 1. */
export const RIGIFY_MAP: Record<string, string> = {
  ...sided(
    [
      ["Hips", "DEF-hips"], ["Pelvis", "DEF-pelvis"], ["Spine_01", "DEF-spine.001"], ["Spine_02", "DEF-spine.002"], ["Spine_03", "DEF-spine.003"],
      ["Neck", "DEF-neck"], ["Head", "DEF-head"],
      ["Clavicle_{S}", "DEF-shoulder.{s}"], ["Shoulder_{S}", "DEF-upper_arm.{s}"], ["Elbow_{S}", "DEF-forearm.{s}"], ["Hand_{S}", "DEF-hand.{s}"],
      ["Thumb_01_{S}", "DEF-thumb.01.{s}"], ["Thumb_02_{S}", "DEF-thumb.02.{s}"], ["Thumb_03_{S}", "DEF-thumb.03.{s}"],
      ["IndexFinger_01_{S}", "DEF-f_index.01.{s}"], ["IndexFinger_02_{S}", "DEF-f_index.02.{s}"], ["IndexFinger_03_{S}", "DEF-f_index.03.{s}"],
      // Our rig moves middle, ring and little fingers as one.
      ["Finger_01_{S}", "DEF-f_middle.01.{s}"], ["Finger_02_{S}", "DEF-f_middle.02.{s}"], ["Finger_03_{S}", "DEF-f_middle.03.{s}"],
      ["UpperLeg_{S}", "DEF-thigh.{s}"], ["LowerLeg_{S}", "DEF-shin.{s}"], ["Ankle_{S}", "DEF-foot.{s}"], ["Ball_{S}", "DEF-toe.{s}"], ["Toes_{S}", "DEF-toe.{s}"],
      ["Wing_01_{S}", "DEF-wing.01.{s}"], ["Wing_02_{S}", "DEF-wing.02.{s}"], ["Wing_03_{S}", "DEF-wing.03.{s}"],
    ],
    { L: ["L", "L"], R: ["R", "R"] },
  ),
  Tail_01: "DEF-tail.001",
  Tail_02: "DEF-tail.002",
  Tail_03: "DEF-tail.003",
  Tail_04: "DEF-tail.004",
  Tail_05: "DEF-tail.005",
};

/** Unreal-mannequin-style bones — Quaternius Universal Animation Library 2. */
export const MANNEQUIN_MAP: Record<string, string> = {
  ...sided(
    [
      ["Hips", "pelvis"], ["Pelvis", "pelvis"], ["Spine_01", "spine_01"], ["Spine_02", "spine_02"], ["Spine_03", "spine_03"],
      ["Neck", "neck_01"], ["Head", "Head"],
      ["Clavicle_{S}", "clavicle_{s}"], ["Shoulder_{S}", "upperarm_{s}"], ["Elbow_{S}", "lowerarm_{s}"], ["Hand_{S}", "hand_{s}"],
      ["Thumb_01_{S}", "thumb_01_{s}"], ["Thumb_02_{S}", "thumb_02_{s}"], ["Thumb_03_{S}", "thumb_03_{s}"],
      ["IndexFinger_01_{S}", "index_01_{s}"], ["IndexFinger_02_{S}", "index_02_{s}"], ["IndexFinger_03_{S}", "index_03_{s}"],
      ["Finger_01_{S}", "middle_01_{s}"], ["Finger_02_{S}", "middle_02_{s}"], ["Finger_03_{S}", "middle_03_{s}"],
      ["UpperLeg_{S}", "thigh_{s}"], ["LowerLeg_{S}", "calf_{s}"], ["Ankle_{S}", "foot_{s}"], ["Ball_{S}", "ball_{s}"], ["Toes_{S}", "ball_{s}"],
      ["Wing_01_{S}", "wing_01_{s}"], ["Wing_02_{S}", "wing_02_{s}"], ["Wing_03_{S}", "wing_03_{s}"],
    ],
    { L: ["L", "l"], R: ["R", "r"] },
  ),
  Tail_01: "tail_01",
  Tail_02: "tail_02",
  Tail_03: "tail_03",
  Tail_04: "tail_04",
  Tail_05: "tail_05",
};

/** Kevin Iglesias's rig (B- bones; one spine and a chest). */
export const KEVIN_MAP: Record<string, string> = {
  ...sided(
    [
      ["Hips", "B-hips"], ["Pelvis", "B-hips"], ["Spine_01", "B-spine"], ["Spine_02", "B-spine02"], ["Spine_03", "B-chest"], ["Neck", "B-neck"], ["Head", "B-head"],
      ["Clavicle_{S}", "B-shoulder{S}"], ["Shoulder_{S}", "B-upperArm{S}"], ["Elbow_{S}", "B-forearm{S}"], ["Hand_{S}", "B-hand{S}"],
      ["Thumb_01_{S}", "B-thumb01{S}"], ["Thumb_02_{S}", "B-thumb02{S}"], ["Thumb_03_{S}", "B-thumb03{S}"],
      ["IndexFinger_01_{S}", "B-indexFinger01{S}"], ["IndexFinger_02_{S}", "B-indexFinger02{S}"], ["IndexFinger_03_{S}", "B-indexFinger03{S}"],
      ["Finger_01_{S}", "B-middleFinger01{S}"], ["Finger_02_{S}", "B-middleFinger02{S}"], ["Finger_03_{S}", "B-middleFinger03{S}"],
      ["UpperLeg_{S}", "B-thigh{S}"], ["LowerLeg_{S}", "B-shin{S}"], ["Ankle_{S}", "B-foot{S}"], ["Ball_{S}", "B-toe{S}"], ["Toes_{S}", "B-toe{S}"],
    ],
    { L: ["L", "L"], R: ["R", "R"] },
  ),
};

/** CMU mocap in cgspeed's DAZ-friendly skeleton (RancidMilk's FBX conversion). */
export const CMU_MAP: Record<string, string> = {
  ...sided(
    [
      ["Hips", "hip"], ["Pelvis", "hip"], ["Spine_01", "abdomen"], ["Spine_03", "chest"], ["Neck", "neck"], ["Head", "head"],
      ["Clavicle_{S}", "{s}Collar"], ["Shoulder_{S}", "{s}Shldr"], ["Elbow_{S}", "{s}ForeArm"], ["Hand_{S}", "{s}Hand"],
      ["Thumb_01_{S}", "{s}Thumb1"], ["Thumb_02_{S}", "{s}Thumb2"], ["Thumb_03_{S}", "{s}Thumb3"],
      ["IndexFinger_01_{S}", "{s}Index1"], ["IndexFinger_02_{S}", "{s}Index2"], ["IndexFinger_03_{S}", "{s}Index3"],
      ["Finger_01_{S}", "{s}Mid1"], ["Finger_02_{S}", "{s}Mid2"], ["Finger_03_{S}", "{s}Mid3"],
      ["UpperLeg_{S}", "{s}Thigh"], ["LowerLeg_{S}", "{s}Shin"], ["Ankle_{S}", "{s}Foot"], ["Ball_{S}", "{s}Foot"], ["Toes_{S}", "{s}Foot"],
    ],
    { L: ["L", "l"], R: ["R", "r"] },
  ),
};

/** Mixamo standard skeleton rig. */
export const MIXAMO_MAP: Record<string, string> = {
  ...sided(
    [
      ["Hips", "mixamorig:Hips"], ["Pelvis", "mixamorig:Hips"],
      ["Spine_01", "mixamorig:Spine"], ["Spine_02", "mixamorig:Spine1"], ["Spine_03", "mixamorig:Spine2"],
      ["Neck", "mixamorig:Neck"], ["Head", "mixamorig:Head"],
      ["Clavicle_{S}", "mixamorig:{S}Shoulder"], ["Shoulder_{S}", "mixamorig:{S}Arm"],
      ["Elbow_{S}", "mixamorig:{S}ForeArm"], ["Hand_{S}", "mixamorig:{S}Hand"],
      ["Thumb_01_{S}", "mixamorig:{S}HandThumb1"], ["Thumb_02_{S}", "mixamorig:{S}HandThumb2"], ["Thumb_03_{S}", "mixamorig:{S}HandThumb3"],
      ["IndexFinger_01_{S}", "mixamorig:{S}HandIndex1"], ["IndexFinger_02_{S}", "mixamorig:{S}HandIndex2"], ["IndexFinger_03_{S}", "mixamorig:{S}HandIndex3"],
      ["Finger_01_{S}", "mixamorig:{S}HandMiddle1"], ["Finger_02_{S}", "mixamorig:{S}HandMiddle2"], ["Finger_03_{S}", "mixamorig:{S}HandMiddle3"],
      ["UpperLeg_{S}", "mixamorig:{S}UpLeg"], ["LowerLeg_{S}", "mixamorig:{S}Leg"],
      ["Ankle_{S}", "mixamorig:{S}Foot"], ["Ball_{S}", "mixamorig:{S}ToeBase"], ["Toes_{S}", "mixamorig:{S}ToeBase"],
    ],
    { L: ["Left", "Left"], R: ["Right", "Right"] },
  ),
};

/** Synty Studios modular humanoid and creature skeleton rig. */
export const SYNTY_MAP: Record<string, string> = {
  ...sided(
    [
      ["Hips", "Root"], ["Pelvis", "Pelvis"],
      ["Spine_01", "Spine_01"], ["Spine_02", "Spine_02"], ["Spine_03", "Spine_03"],
      ["Neck", "Neck"], ["Head", "Head"],
      ["Clavicle_{S}", "Clavicle_{S}"], ["Shoulder_{S}", "UpperArm_{S}"],
      ["Elbow_{S}", "LowerArm_{S}"], ["Hand_{S}", "Hand_{S}"],
      ["Thumb_01_{S}", "Thumb_01_{S}"], ["Thumb_02_{S}", "Thumb_02_{S}"], ["Thumb_03_{S}", "Thumb_03_{S}"],
      ["IndexFinger_01_{S}", "IndexFinger_01_{S}"], ["IndexFinger_02_{S}", "IndexFinger_02_{S}"], ["IndexFinger_03_{S}", "IndexFinger_03_{S}"],
      ["Finger_01_{S}", "Finger_01_{S}"], ["Finger_02_{S}", "Finger_02_{S}"], ["Finger_03_{S}", "Finger_03_{S}"],
      ["UpperLeg_{S}", "Thigh_{S}"], ["LowerLeg_{S}", "Calf_{S}"],
      ["Ankle_{S}", "Foot_{S}"], ["Ball_{S}", "Toe_{S}"], ["Toes_{S}", "Toe_{S}"],
      ["Wing_01_{S}", "Wing_01_{S}"], ["Wing_02_{S}", "Wing_02_{S}"], ["Wing_03_{S}", "Wing_03_{S}"],
    ],
    { L: ["L", "L"], R: ["R", "R"] },
  ),
  Tail_01: "Tail_01",
  Tail_02: "Tail_02",
  Tail_03: "Tail_03",
  Tail_04: "Tail_04",
  Tail_05: "Tail_05",
};

/** Canonical bone definition for the engine animation pipeline. */
export interface CanonicalBone {
  canonical: string;
  category: "root" | "spine" | "head" | "arm" | "hand" | "finger" | "leg" | "foot" | "wing" | "tail" | "accessory";
  side?: "L" | "R" | "C";
  aliases: string[];
}

/** Full canonical bone ontology spanning humanoid, creature, and avian/serpentine joints. */
export const CANONICAL_BONE_ONTOLOGY: readonly CanonicalBone[] = [
  { canonical: "Hips", category: "root", side: "C", aliases: ["hips", "pelvis", "root", "hip", "b-hips", "def-hips", "mixamorig:hips"] },
  { canonical: "Pelvis", category: "root", side: "C", aliases: ["pelvis", "b-pelvis", "def-pelvis", "root"] },
  { canonical: "Spine_01", category: "spine", side: "C", aliases: ["spine", "spine_01", "def-spine.001", "b-spine", "abdomen", "mixamorig:spine"] },
  { canonical: "Spine_02", category: "spine", side: "C", aliases: ["spine_02", "spine.002", "def-spine.002", "b-spine02", "spine1", "mixamorig:spine1"] },
  { canonical: "Spine_03", category: "spine", side: "C", aliases: ["chest", "spine_03", "spine.003", "def-spine.003", "b-chest", "mixamorig:spine2"] },
  { canonical: "Neck", category: "head", side: "C", aliases: ["neck", "neck_01", "def-neck", "b-neck", "mixamorig:neck"] },
  { canonical: "Head", category: "head", side: "C", aliases: ["head", "def-head", "b-head", "mixamorig:head"] },
  { canonical: "Clavicle_L", category: "arm", side: "L", aliases: ["clavicle_l", "shoulder_l", "def-shoulder.l", "b-shoulderl", "lcollar", "mixamorig:leftshoulder"] },
  { canonical: "Clavicle_R", category: "arm", side: "R", aliases: ["clavicle_r", "shoulder_r", "def-shoulder.r", "b-shoulderr", "rcollar", "mixamorig:rightshoulder"] },
  { canonical: "Shoulder_L", category: "arm", side: "L", aliases: ["upperarm_l", "shoulder_l", "upper_arm.l", "def-upper_arm.l", "b-upperarml", "lshldr", "mixamorig:leftarm"] },
  { canonical: "Shoulder_R", category: "arm", side: "R", aliases: ["upperarm_r", "shoulder_r", "upper_arm.r", "def-upper_arm.r", "b-upperarmr", "rshldr", "mixamorig:rightarm"] },
  { canonical: "Elbow_L", category: "arm", side: "L", aliases: ["lowerarm_l", "forearm_l", "forearm.l", "def-forearm.l", "b-forearml", "lforearm", "mixamorig:leftforearm"] },
  { canonical: "Elbow_R", category: "arm", side: "R", aliases: ["lowerarm_r", "forearm_r", "forearm.r", "def-forearm.r", "b-forearmr", "rforearm", "mixamorig:rightforearm"] },
  { canonical: "Hand_L", category: "hand", side: "L", aliases: ["hand_l", "hand.l", "def-hand.l", "b-handl", "lhand", "mixamorig:lefthand"] },
  { canonical: "Hand_R", category: "hand", side: "R", aliases: ["hand_r", "hand.r", "def-hand.r", "b-handr", "rhand", "mixamorig:righthand"] },
  { canonical: "Thumb_01_L", category: "finger", side: "L", aliases: ["thumb_01_l", "thumb.01.l", "def-thumb.01.l", "b-thumb01l", "lthumb1", "mixamorig:lefthandthumb1"] },
  { canonical: "Thumb_02_L", category: "finger", side: "L", aliases: ["thumb_02_l", "thumb.02.l", "def-thumb.02.l", "b-thumb02l", "lthumb2", "mixamorig:lefthandthumb2"] },
  { canonical: "Thumb_03_L", category: "finger", side: "L", aliases: ["thumb_03_l", "thumb.03.l", "def-thumb.03.l", "b-thumb03l", "lthumb3", "mixamorig:lefthandthumb3"] },
  { canonical: "Thumb_01_R", category: "finger", side: "R", aliases: ["thumb_01_r", "thumb.01.r", "def-thumb.01.r", "b-thumb01r", "rthumb1", "mixamorig:righthandthumb1"] },
  { canonical: "Thumb_02_R", category: "finger", side: "R", aliases: ["thumb_02_r", "thumb.02.r", "def-thumb.02.r", "b-thumb02r", "rthumb2", "mixamorig:righthandthumb2"] },
  { canonical: "Thumb_03_R", category: "finger", side: "R", aliases: ["thumb_03_r", "thumb.03.r", "def-thumb.03.r", "b-thumb03r", "rthumb3", "mixamorig:righthandthumb3"] },
  { canonical: "IndexFinger_01_L", category: "finger", side: "L", aliases: ["indexfinger_01_l", "index_01_l", "f_index.01.l", "def-f_index.01.l", "b-indexfinger01l", "lindex1", "mixamorig:lefthandindex1"] },
  { canonical: "IndexFinger_02_L", category: "finger", side: "L", aliases: ["indexfinger_02_l", "index_02_l", "f_index.02.l", "def-f_index.02.l", "b-indexfinger02l", "lindex2", "mixamorig:lefthandindex2"] },
  { canonical: "IndexFinger_03_L", category: "finger", side: "L", aliases: ["indexfinger_03_l", "index_03_l", "f_index.03.l", "def-f_index.03.l", "b-indexfinger03l", "lindex3", "mixamorig:lefthandindex3"] },
  { canonical: "IndexFinger_01_R", category: "finger", side: "R", aliases: ["indexfinger_01_r", "index_01_r", "f_index.01.r", "def-f_index.01.r", "b-indexfinger01r", "rindex1", "mixamorig:righthandindex1"] },
  { canonical: "IndexFinger_02_R", category: "finger", side: "R", aliases: ["indexfinger_02_r", "index_02_r", "f_index.02.r", "def-f_index.02.r", "b-indexfinger02r", "rindex2", "mixamorig:righthandindex2"] },
  { canonical: "IndexFinger_03_R", category: "finger", side: "R", aliases: ["indexfinger_03_r", "index_03_r", "f_index.03.r", "def-f_index.03.r", "b-indexfinger03r", "rindex3", "mixamorig:righthandindex3"] },
  { canonical: "Finger_01_L", category: "finger", side: "L", aliases: ["finger_01_l", "middle_01_l", "f_middle.01.l", "def-f_middle.01.l", "b-middlefinger01l", "lmid1", "mixamorig:lefthandmiddle1"] },
  { canonical: "Finger_02_L", category: "finger", side: "L", aliases: ["finger_02_l", "middle_02_l", "f_middle.02.l", "def-f_middle.02.l", "b-middlefinger02l", "lmid2", "mixamorig:lefthandmiddle2"] },
  { canonical: "Finger_03_L", category: "finger", side: "L", aliases: ["finger_03_l", "middle_03_l", "f_middle.03.l", "def-f_middle.03.l", "b-middlefinger03l", "lmid3", "mixamorig:lefthandmiddle3"] },
  { canonical: "Finger_01_R", category: "finger", side: "R", aliases: ["finger_01_r", "middle_01_r", "f_middle.01.r", "def-f_middle.01.r", "b-middlefinger01r", "rmid1", "mixamorig:righthandmiddle1"] },
  { canonical: "Finger_02_R", category: "finger", side: "R", aliases: ["finger_02_r", "middle_02_r", "f_middle.02.r", "def-f_middle.02.r", "b-middlefinger02r", "rmid2", "mixamorig:righthandmiddle2"] },
  { canonical: "Finger_03_R", category: "finger", side: "R", aliases: ["finger_03_r", "middle_03_r", "f_middle.03.r", "def-f_middle.03.r", "b-middlefinger03r", "rmid3", "mixamorig:righthandmiddle3"] },
  { canonical: "UpperLeg_L", category: "leg", side: "L", aliases: ["thigh_l", "upperleg_l", "def-thigh.l", "b-thighl", "lthigh", "mixamorig:leftupleg"] },
  { canonical: "UpperLeg_R", category: "leg", side: "R", aliases: ["thigh_r", "upperleg_r", "def-thigh.r", "b-thighr", "rthigh", "mixamorig:rightupleg"] },
  { canonical: "LowerLeg_L", category: "leg", side: "L", aliases: ["calf_l", "shin_l", "lowerleg_l", "def-shin.l", "b-shinl", "lshin", "mixamorig:leftleg"] },
  { canonical: "LowerLeg_R", category: "leg", side: "R", aliases: ["calf_r", "shin_r", "lowerleg_r", "def-shin.r", "b-shinr", "rshin", "mixamorig:rightleg"] },
  { canonical: "Ankle_L", category: "foot", side: "L", aliases: ["foot_l", "ankle_l", "def-foot.l", "b-footl", "lfoot", "mixamorig:leftfoot"] },
  { canonical: "Ankle_R", category: "foot", side: "R", aliases: ["foot_r", "ankle_r", "def-foot.r", "b-footr", "rfoot", "mixamorig:rightfoot"] },
  { canonical: "Ball_L", category: "foot", side: "L", aliases: ["ball_l", "toe_l", "def-toe.l", "b-toel", "mixamorig:lefttoebase"] },
  { canonical: "Ball_R", category: "foot", side: "R", aliases: ["ball_r", "toe_r", "def-toe.r", "b-toer", "mixamorig:righttoebase"] },
  { canonical: "Toes_L", category: "foot", side: "L", aliases: ["toes_l", "toe_l", "ball_l", "def-toe.l", "b-toel", "mixamorig:lefttoebase"] },
  { canonical: "Toes_R", category: "foot", side: "R", aliases: ["toes_r", "toe_r", "ball_r", "def-toe.r", "b-toer", "mixamorig:righttoebase"] },
  { canonical: "Wing_01_L", category: "wing", side: "L", aliases: ["wing_01_l", "wing.01.l", "def-wing.01.l"] },
  { canonical: "Wing_02_L", category: "wing", side: "L", aliases: ["wing_02_l", "wing.02.l", "def-wing.02.l"] },
  { canonical: "Wing_03_L", category: "wing", side: "L", aliases: ["wing_03_l", "wing.03.l", "def-wing.03.l"] },
  { canonical: "Wing_01_R", category: "wing", side: "R", aliases: ["wing_01_r", "wing.01.r", "def-wing.01.r"] },
  { canonical: "Wing_02_R", category: "wing", side: "R", aliases: ["wing_02_r", "wing.02.r", "def-wing.02.r"] },
  { canonical: "Wing_03_R", category: "wing", side: "R", aliases: ["wing_03_r", "wing.03.r", "def-wing.03.r"] },
  { canonical: "Tail_01", category: "tail", side: "C", aliases: ["tail_01", "tail.001", "def-tail.001", "tail1"] },
  { canonical: "Tail_02", category: "tail", side: "C", aliases: ["tail_02", "tail.002", "def-tail.002", "tail2"] },
  { canonical: "Tail_03", category: "tail", side: "C", aliases: ["tail_03", "tail.003", "def-tail.003", "tail3"] },
  { canonical: "Tail_04", category: "tail", side: "C", aliases: ["tail_04", "tail.004", "def-tail.004", "tail4"] },
  { canonical: "Tail_05", category: "tail", side: "C", aliases: ["tail_05", "tail.005", "def-tail.005", "tail5"] },
];

/**
 * Resolves a bone mapping from arbitrary source bones to our canonical bone layout.
 * Detects known presets (Mixamo, Synty, Rigify, Mannequin, Kevin, CMU) or falls back
 * to ontology matching based on aliases and normalized token comparisons.
 */
export function resolveBoneMapping(sourceBones: string[]): Record<string, string> {
  const boneSet = new Set(sourceBones);
  const lowerMap = new Map<string, string>();
  for (const b of sourceBones) lowerMap.set(b.toLowerCase(), b);

  // Check known presets by characteristic bones
  if (sourceBones.some((b) => b.startsWith("mixamorig:"))) {
    const map: Record<string, string> = {};
    for (const [canonical, src] of Object.entries(MIXAMO_MAP)) {
      if (boneSet.has(src)) map[canonical] = src;
      else if (lowerMap.has(src.toLowerCase())) map[canonical] = lowerMap.get(src.toLowerCase())!;
    }
    return map;
  }
  if (sourceBones.some((b) => b.startsWith("DEF-"))) {
    const map: Record<string, string> = {};
    for (const [canonical, src] of Object.entries(RIGIFY_MAP)) {
      if (boneSet.has(src)) map[canonical] = src;
      else if (lowerMap.has(src.toLowerCase())) map[canonical] = lowerMap.get(src.toLowerCase())!;
    }
    return map;
  }
  if (sourceBones.some((b) => b.startsWith("B-"))) {
    const map: Record<string, string> = {};
    for (const [canonical, src] of Object.entries(KEVIN_MAP)) {
      if (boneSet.has(src)) map[canonical] = src;
      else if (lowerMap.has(src.toLowerCase())) map[canonical] = lowerMap.get(src.toLowerCase())!;
    }
    return map;
  }
  if (boneSet.has("pelvis") && (boneSet.has("upperarm_l") || boneSet.has("thigh_l"))) {
    const map: Record<string, string> = {};
    for (const [canonical, src] of Object.entries(MANNEQUIN_MAP)) {
      if (boneSet.has(src)) map[canonical] = src;
      else if (lowerMap.has(src.toLowerCase())) map[canonical] = lowerMap.get(src.toLowerCase())!;
    }
    return map;
  }
  if (boneSet.has("hip") && boneSet.has("abdomen") && boneSet.has("lShldr")) {
    const map: Record<string, string> = {};
    for (const [canonical, src] of Object.entries(CMU_MAP)) {
      if (boneSet.has(src)) map[canonical] = src;
      else if (lowerMap.has(src.toLowerCase())) map[canonical] = lowerMap.get(src.toLowerCase())!;
    }
    return map;
  }
  if (boneSet.has("UpperArm_L") || (boneSet.has("Thigh_L") && boneSet.has("Spine_01"))) {
    const map: Record<string, string> = {};
    for (const [canonical, src] of Object.entries(SYNTY_MAP)) {
      if (boneSet.has(src)) map[canonical] = src;
      else if (lowerMap.has(src.toLowerCase())) map[canonical] = lowerMap.get(src.toLowerCase())!;
    }
    return map;
  }

  // General ontology matching
  const map: Record<string, string> = {};
  for (const def of CANONICAL_BONE_ONTOLOGY) {
    for (const alias of def.aliases) {
      if (lowerMap.has(alias)) {
        map[def.canonical] = lowerMap.get(alias)!;
        break;
      }
    }
  }
  return map;
}

/** The CMU takes we use (subject_trial → what it is, from mocap.cs.cmu.edu). */
const CMU_TAKES: Record<string, string> = {
  "02_05": "PunchStrike", "02_07": "Swordplay", "02_08": "Swordplay", "02_09": "Swordplay",
  "13_17": "Boxing", "13_18": "Boxing", "14_01": "Boxing", "14_02": "Boxing", "14_03": "Boxing",
  "74_03": "Kick", "74_04": "Kick", "74_05": "Kick", "74_06": "Kick",
  "76_01": "BackOffThenPunch", "76_02": "FeintThenAttack", "76_03": "AvoidAttacker", "76_04": "DefensiveGuard",
  "77_09": "DuckFlyingObject", "86_01": "JumpsKicksPunches", "87_01": "JumpSpinKick", "88_06": "JumpSpinKick",
  "90_05": "JumpKick", "90_06": "JumpKick", "90_07": "JumpKick", "111_19": "PunchKick", "113_13": "PunchKick",
  "134_01": "DuckUnder", "135_04": "KarateFrontKick", "135_05": "KarateDownBlock", "135_07": "KarateRoundhouseKick",
  "135_09": "KaratePunch", "135_10": "KarateKnifeBlock", "135_11": "KarateSideKick", "139_09": "Ducking",
  "141_14": "PunchKick", "143_23": "Punching", "143_24": "Kicking",
  "144_05": "FrontKicks", "144_06": "FrontKicks", "144_07": "LeftBlocks", "144_08": "LeftBlocks",
  "144_09": "LeftFrontKicks", "144_10": "LeftFrontKicks", "144_11": "LeftLunges", "144_12": "LeftLunges",
  "144_13": "LeftPunches", "144_14": "LeftPunches", "144_17": "Lunges", "144_18": "Lunges",
  "144_20": "Punches", "144_21": "Punches", "144_26": "RightBlocks", "144_27": "RightBlocks",
};

const QUATERNIUS = { author: "Quaternius", license: "CC0 1.0" };

/** Kevin Iglesias's free packs: one clip per FBX, a male and a female take of each. */
function kevinIglesias(id: string, slug: string, title: string): AnimationSource {
  return {
    id,
    title,
    author: "Kevin Iglesias",
    license: "Standard Unity Asset Store EULA: royalty-free in games, no redistribution",
    url: `https://kevdev.itch.io/${slug}`,
    // Unpacked as <slug>/Animations or <slug>/<title>/Animations.
    dir: `animations/kevin-iglesias/${slug}`,
    include: /(^|\/)Animations\/.+\.fbx$/i,
    // KI_<clip>, female takes .F (the animator picks them for women).
    rename: (_clip, file) => {
      if (/RootMotion|\[RM\]/.test(file)) return null;
      const m = /Human([MF]?)@([^/]+)\.fbx$/i.exec(file);
      return m ? `KI_${m[2].replace(/\s*-\s*/g, "_").replace(/\s+/g, "")}${m[1] === "F" ? ".F" : ""}` : null;
    },
    hips: "B-hips",
    root: "B-root",
    map: KEVIN_MAP,
  };
}

export const ANIMATION_SOURCES: AnimationSource[] = [
  {
    id: "ual1",
    title: "Universal Animation Library (Standard)",
    ...QUATERNIUS,
    url: "https://quaternius.com/packs/universalanimationlibrary.html",
    file: "animations/quaternius/universal_animation_librarystandard/Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb",
    hips: "DEF-hips",
    root: "root",
    map: RIGIFY_MAP,
    skip: /^A_TPose$|^Pistol_|^Driving_/,
  },
  {
    id: "ual2",
    title: "Universal Animation Library 2 (Standard)",
    ...QUATERNIUS,
    url: "https://quaternius.com/packs/universalanimationlibrary2.html",
    file: "animations/quaternius/universal_animation_library_2standard/Universal Animation Library 2 [Standard]/Unreal-Godot/UAL2_Standard.glb",
    hips: "pelvis",
    root: "root",
    map: MANNEQUIN_MAP,
    skip: /^A_TPose$|TalkingPhone/,
  },
  kevinIglesias("ki-melee", "human-melee-animatons-free", "Human Melee Animations FREE"),
  kevinIglesias("ki-basic", "basic-motions-free", "Human Basic Motions FREE"),
  kevinIglesias("ki-spell", "human-spellcasting-animations-free", "Human Spellcasting Animations FREE"),
  kevinIglesias("ki-archer", "human-archer-animations-free", "Human Archer Animations FREE"),
  kevinIglesias("ki-throwing", "human-throwing-animations-free", "Human Throwing Animations FREE"),
  {
    id: "cmu-combat",
    title: "CMU motion capture: combat takes (RancidMilk's FBX conversion)",
    author: "CMU Graphics Lab (mocap.cs.cmu.edu); FBX by RancidMilk",
    license: "CMU: free in commercial products, not to be sold as animations; credit mocap.cs.cmu.edu (NSF EIA-0196217)",
    url: "https://rancidmilk.itch.io/free-character-animations",
    // Unzipped from Anims_Only_FBX_V1: the combat trials (see CMU_TAKES).
    dir: "animations/rancidmilk/combat",
    include: /\.fbx$/i,
    rename: (_clip, file) => {
      const trial = /(\d+_\d+)\.fbx$/.exec(file)?.[1];
      return trial && CMU_TAKES[trial] ? `CMU_${trial}_${CMU_TAKES[trial]}` : null;
    },
    hips: "hip",
    map: CMU_MAP,
    reference: true,
  },
];

/** Files under `dir` (relative, forward slashes) matching `include`. */
function listFiles(dir: string, include: RegExp): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (include.test(r)) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

async function loadScene(file: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  if (/\.fbx$/i.test(file)) {
    const fbx = loadFbx(file);
    return { scene: fbx, animations: fbx.animations };
  }
  const b = fs.readFileSync(file);
  const gltf = await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, "");
  return { scene: gltf.scene, animations: gltf.animations };
}

const isLoop = (name: string): boolean =>
  /_Loop$|Idle|_Hold(\.F)?$|(Run|Walk|Sprint|Strafe|Crouch)\w*0\d/i.test(name);

export async function convertAnimations(
  assetsRoot: string,
  log: (line: string) => void = () => {},
  sources: AnimationSource[] = ANIMATION_SOURCES,
): Promise<AnimationManifest> {
  installNodeShims();
  const rigDir = path.join(assetsRoot, RIG_DIR);
  const rigFile = path.join(rigDir, "rig.glb");
  if (!fs.existsSync(rigFile)) throw new Error(`convert-animations: ${rigFile} missing — run convert:modular first`);
  const rig = await loadScene(rigFile);

  const infos: AnimationClipInfo[] = [];
  const used: AnimationManifest["sources"] = [];
  const names = new Set<string>();
  const outDir = path.join(rigDir, "animations");
  fs.mkdirSync(outDir, { recursive: true });
  let bytes = 0;
  for (const src of sources) {
    // [file, a clip name to keep (null: every clip)]
    const files: Array<{ file: string; rel: string }> = [];
    if (src.file) {
      files.push({ file: path.join(assetsRoot, src.file), rel: src.file });
    } else if (src.dir && fs.existsSync(path.join(assetsRoot, src.dir))) {
      for (const rel of listFiles(path.join(assetsRoot, src.dir), src.include ?? /\.(fbx|glb|gltf)$/i)) {
        files.push({ file: path.join(assetsRoot, src.dir, rel), rel });
      }
    }
    if (files.length === 0 || !fs.existsSync(files[0].file)) {
      log(`[animations] ${src.id}: not found (${src.file ?? src.dir}) — skipped`);
      continue;
    }
    const clips: THREE.AnimationClip[] = [];
    let missingNoted = false;
    let scale = 0;
    for (const { file, rel } of files) {
      const named = (clip: string): string | null => (src.rename ? src.rename(clip, rel) : clip.replace(/_RM$/, ""));
      // Skip what isn't wanted before loading (a folder source is one clip per file).
      if (!src.file && named("") === null) continue;
      let lib: Awaited<ReturnType<typeof loadScene>>;
      try {
        lib = await loadScene(file);
      } catch (err) {
        log(`[animations] ${src.id}: can't read ${rel} (${(err as Error).message}) — skipped`);
        continue;
      }
      const retargeter = new Retargeter(
        // A one-clip file: its rest pose takes the root from the clip (see rootFrom).
        { scene: lib.scene, hips: src.hips, root: src.root, map: src.map, rotate: src.rotate, rootFrom: src.file ? undefined : lib.animations[0] },
        { scene: rig.scene, hips: "Hips" },
      );
      scale = retargeter.scale;
      if (retargeter.missing.length > 0 && !missingNoted) {
        log(`[animations] ${src.id}: no source bone for ${retargeter.missing.join(", ")}`);
        missingNoted = true;
      }
      const all = new Set(lib.animations.map((c) => c.name));
      for (const clip of lib.animations) {
        if (src.skip?.test(clip.name)) continue;
        // A root-motion copy of an in-place clip adds nothing once root motion is taken out.
        if (/_RM$/.test(clip.name) && all.has(clip.name.replace(/_RM$/, ""))) continue;
        const name = named(clip.name);
        if (name === null || names.has(name)) continue;
        names.add(name);
        const out = retargeter.retarget(clip);
        out.clip.name = name;
        out.clip.optimize();
        clips.push(out.clip);
        infos.push({
          name,
          source: src.id,
          duration: +clip.duration.toFixed(4),
          loop: isLoop(name),
          travel: [+out.travel[0].toFixed(3), +out.travel[1].toFixed(3)],
        });
        if (isLoop(name) && Math.hypot(out.travel[0], out.travel[1]) > 0.05) {
          log(`[animations] ${src.id}: loop ${name} travels ${out.travel.map((v) => v.toFixed(2))}`);
        }
      }
    }
    if (clips.length === 0) continue;
    const glb = new Uint8Array(
      (await new GLTFExporter().parseAsync(rig.scene, { binary: true, animations: clips })) as ArrayBuffer,
    );
    const file = `animations/${src.id}.glb`;
    fs.writeFileSync(path.join(rigDir, file), glb);
    bytes += glb.byteLength;
    used.push({ id: src.id, title: src.title, author: src.author, license: src.license, url: src.url, file, ...(src.reference ? { reference: true } : {}) });
    log(`[animations] ${src.id}: ${clips.length} clips, ${(glb.byteLength / 1e6).toFixed(1)} MB (hip scale ${scale.toPrecision(3)})`);
  }

  const manifest: AnimationManifest = { version: 2, sources: used, clips: infos };
  fs.writeFileSync(path.join(rigDir, "animations.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  fs.rmSync(path.join(rigDir, "animations.glb"), { force: true }); // the old single file
  log(`[animations] wrote ${infos.length} clips from ${used.length} sources (${(bytes / 1e6).toFixed(1)} MB)`);
  return manifest;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--assets");
  const assets = at >= 0 ? path.resolve(args[at + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../assets");
  convertAnimations(assets, (l) => console.log(l)).catch((err) => {
    console.error(`[animations] failed: ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
