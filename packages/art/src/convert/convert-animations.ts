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
import { installNodeShims, loadFbxTolerant } from "./convert-packs.js";
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
const RIGIFY_MAP = sided(
  [
    ["Hips", "DEF-hips"], ["Spine_01", "DEF-spine.001"], ["Spine_02", "DEF-spine.002"], ["Spine_03", "DEF-spine.003"],
    ["Neck", "DEF-neck"], ["Head", "DEF-head"],
    ["Clavicle_{S}", "DEF-shoulder.{s}"], ["Shoulder_{S}", "DEF-upper_arm.{s}"], ["Elbow_{S}", "DEF-forearm.{s}"], ["Hand_{S}", "DEF-hand.{s}"],
    ["Thumb_01_{S}", "DEF-thumb.01.{s}"], ["Thumb_02_{S}", "DEF-thumb.02.{s}"], ["Thumb_03_{S}", "DEF-thumb.03.{s}"],
    ["IndexFinger_01_{S}", "DEF-f_index.01.{s}"], ["IndexFinger_02_{S}", "DEF-f_index.02.{s}"], ["IndexFinger_03_{S}", "DEF-f_index.03.{s}"],
    // Our rig moves middle, ring and little fingers as one.
    ["Finger_01_{S}", "DEF-f_middle.01.{s}"], ["Finger_02_{S}", "DEF-f_middle.02.{s}"], ["Finger_03_{S}", "DEF-f_middle.03.{s}"],
    ["UpperLeg_{S}", "DEF-thigh.{s}"], ["LowerLeg_{S}", "DEF-shin.{s}"], ["Ankle_{S}", "DEF-foot.{s}"], ["Ball_{S}", "DEF-toe.{s}"],
  ],
  { L: ["L", "L"], R: ["R", "R"] },
);

/** Unreal-mannequin-style bones — Quaternius Universal Animation Library 2. */
const MANNEQUIN_MAP = sided(
  [
    ["Hips", "pelvis"], ["Spine_01", "spine_01"], ["Spine_02", "spine_02"], ["Spine_03", "spine_03"],
    ["Neck", "neck_01"], ["Head", "Head"],
    ["Clavicle_{S}", "clavicle_{s}"], ["Shoulder_{S}", "upperarm_{s}"], ["Elbow_{S}", "lowerarm_{s}"], ["Hand_{S}", "hand_{s}"],
    ["Thumb_01_{S}", "thumb_01_{s}"], ["Thumb_02_{S}", "thumb_02_{s}"], ["Thumb_03_{S}", "thumb_03_{s}"],
    ["IndexFinger_01_{S}", "index_01_{s}"], ["IndexFinger_02_{S}", "index_02_{s}"], ["IndexFinger_03_{S}", "index_03_{s}"],
    ["Finger_01_{S}", "middle_01_{s}"], ["Finger_02_{S}", "middle_02_{s}"], ["Finger_03_{S}", "middle_03_{s}"],
    ["UpperLeg_{S}", "thigh_{s}"], ["LowerLeg_{S}", "calf_{s}"], ["Ankle_{S}", "foot_{s}"], ["Ball_{S}", "ball_{s}"],
  ],
  { L: ["L", "l"], R: ["R", "r"] },
);

/** Kevin Iglesias's rig (B- bones; one spine and a chest). */
const KEVIN_MAP = sided(
  [
    ["Hips", "B-hips"], ["Spine_01", "B-spine"], ["Spine_03", "B-chest"], ["Neck", "B-neck"], ["Head", "B-head"],
    ["Clavicle_{S}", "B-shoulder{S}"], ["Shoulder_{S}", "B-upperArm{S}"], ["Elbow_{S}", "B-forearm{S}"], ["Hand_{S}", "B-hand{S}"],
    ["Thumb_01_{S}", "B-thumb01{S}"], ["Thumb_02_{S}", "B-thumb02{S}"], ["Thumb_03_{S}", "B-thumb03{S}"],
    ["IndexFinger_01_{S}", "B-indexFinger01{S}"], ["IndexFinger_02_{S}", "B-indexFinger02{S}"], ["IndexFinger_03_{S}", "B-indexFinger03{S}"],
    ["Finger_01_{S}", "B-middleFinger01{S}"], ["Finger_02_{S}", "B-middleFinger02{S}"], ["Finger_03_{S}", "B-middleFinger03{S}"],
    ["UpperLeg_{S}", "B-thigh{S}"], ["LowerLeg_{S}", "B-shin{S}"], ["Ankle_{S}", "B-foot{S}"], ["Ball_{S}", "B-toe{S}"],
  ],
  { L: ["L", "L"], R: ["R", "R"] },
);

/** CMU mocap in cgspeed's DAZ-friendly skeleton (RancidMilk's FBX conversion). */
const CMU_MAP = sided(
  [
    ["Hips", "hip"], ["Spine_01", "abdomen"], ["Spine_03", "chest"], ["Neck", "neck"], ["Head", "head"],
    ["Clavicle_{S}", "{s}Collar"], ["Shoulder_{S}", "{s}Shldr"], ["Elbow_{S}", "{s}ForeArm"], ["Hand_{S}", "{s}Hand"],
    ["Thumb_01_{S}", "{s}Thumb1"], ["Thumb_02_{S}", "{s}Thumb2"],
    ["IndexFinger_01_{S}", "{s}Index1"], ["IndexFinger_02_{S}", "{s}Index2"],
    ["Finger_01_{S}", "{s}Mid1"], ["Finger_02_{S}", "{s}Mid2"],
    ["UpperLeg_{S}", "{s}Thigh"], ["LowerLeg_{S}", "{s}Shin"], ["Ankle_{S}", "{s}Foot"],
  ],
  { L: ["L", "l"], R: ["R", "r"] },
);

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
    const fbx = await loadFbxTolerant(file);
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
