// Writes the stand-in rigged character kit (SG4a): a 17-bone rig, rigid box parts for the body and head,
// four mask textures, and a looped locomotion library the animator reads (idle, walk, jog, sprint, jump,
// swim). Everything is generated here: no art from any pack is read or written. The client loads it from
// apps/client/public/placeholder-character/ when the licensed kit (/assets/...) is not served.
//   node scripts/gen-placeholder-character.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";
import { Document, NodeIO } from "@gltf-transform/core";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/client/public/placeholder-character");
const CM = 0.01; // the spec is in centimetres; files are in metres
const deg = (d) => (d * Math.PI) / 180;
// The rig's mesh names for the body slots (parsePartName reads these).
const RIG_NAME = { torso: "Torso", armUpperRight: "ArmUpperRight", armUpperLeft: "ArmUpperLeft", armLowerRight: "ArmLowerRight", armLowerLeft: "ArmLowerLeft", handRight: "HandRight", handLeft: "HandLeft", hips: "Hips", legRight: "LegRight", legLeft: "LegLeft" };

// Bones: name, parent, rest position (cm, world). L is +x, R is -x; the feet stand on y = 0.
const BONES = [
  ["Hips", null, [0, 95, 0]],
  ["Spine_01", "Hips", [0, 105, 0]],
  ["Spine_02", "Spine_01", [0, 118, 0]],
  ["Neck_01", "Spine_02", [0, 150, 0]],
  ["Head_01", "Neck_01", [0, 158, 0]],
  ["UpperArm_L", "Spine_02", [18, 140, 0]],
  ["LowerArm_L", "UpperArm_L", [27, 115, 0]],
  ["Hand_L", "LowerArm_L", [30, 90, 0]],
  ["UpperArm_R", "Spine_02", [-18, 140, 0]],
  ["LowerArm_R", "UpperArm_R", [-27, 115, 0]],
  ["Hand_R", "LowerArm_R", [-30, 90, 0]],
  ["Thigh_L", "Hips", [9, 92, 0]],
  ["Shin_L", "Thigh_L", [9, 50, 0]],
  ["Foot_L", "Shin_L", [9, 6, 0]],
  ["Thigh_R", "Hips", [-9, 92, 0]],
  ["Shin_R", "Thigh_R", [-9, 50, 0]],
  ["Foot_R", "Shin_R", [-9, 6, 0]],
];
const WORLD = new Map(BONES.map(([n, , p]) => [n, p]));
const PARENT = new Map(BONES.map(([n, p]) => [n, p]));
const BONE_INDEX = new Map(BONES.map(([n], i) => [n, i]));

// Each part: rigid boxes (centre and size in cm, the bone each box follows).
const BOX = (c, s, bone) => ({ c, s, bone });
const PARTS = {
  torso: [BOX([0, 112, 0], [34, 36, 18], "Spine_02")],
  hips: [BOX([0, 92, 0], [32, 18, 18], "Hips")],
  armUpperLeft: [BOX([22, 127, 0], [10, 26, 10], "UpperArm_L")],
  armLowerLeft: [BOX([28.5, 102, 0], [9, 26, 9], "LowerArm_L")],
  handLeft: [BOX([30, 86, 0], [9, 10, 7], "Hand_L")],
  armUpperRight: [BOX([-22, 127, 0], [10, 26, 10], "UpperArm_R")],
  armLowerRight: [BOX([-28.5, 102, 0], [9, 26, 9], "LowerArm_R")],
  handRight: [BOX([-30, 86, 0], [9, 10, 7], "Hand_R")],
  legLeft: [BOX([9, 71, 0], [12, 42, 12], "Thigh_L"), BOX([9, 28, 0], [11, 44, 11], "Shin_L"), BOX([9, 4, 4], [11, 8, 22], "Foot_L")],
  legRight: [BOX([-9, 71, 0], [12, 42, 12], "Thigh_R"), BOX([-9, 28, 0], [11, 44, 11], "Shin_R"), BOX([-9, 4, 4], [11, 8, 22], "Foot_R")],
  head: [BOX([0, 160, 0], [20, 22, 20], "Head_01")],
};

/** The bones as a node tree under one unit-scale root (asBones copies the root's scale). */
function rigNodes(doc) {
  const top = doc.createNode("Rig_Root");
  const nodes = new Map();
  for (const [name, parent, world] of BONES) {
    const node = doc.createNode(name);
    const pw = parent ? WORLD.get(parent) : [0, 0, 0];
    const local = world.map((v, i) => (v - pw[i]) * CM);
    node.setTranslation(parent ? local : world.map((v) => v * CM));
    nodes.set(name, node);
  }
  for (const [name, parent] of BONES) {
    if (parent) nodes.get(parent).addChild(nodes.get(name));
    else top.addChild(nodes.get(name));
  }
  return { top, nodes };
}

/** One rigid part: every box's 24 vertices (flat normals) follow their bone, in rest-pose metres. */
function partGeometry(boxes) {
  const pos = [], nrm = [], uv = [], joints = [], weights = [], idx = [];
  for (const { c, s, bone } of boxes) {
    const [cx, cy, cz] = c.map((v) => v * CM);
    const [hx, hy, hz] = s.map((v) => (v * CM) / 2);
    const faces = [
      [[0, 1, 0], [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]],
      [[0, -1, 0], [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]]],
      [[1, 0, 0], [[1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]]],
      [[-1, 0, 0], [[-1, -1, 1], [-1, -1, -1], [-1, 1, -1], [-1, 1, 1]]],
      [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
      [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    ];
    for (const [n, corners] of faces) {
      const base = pos.length / 3;
      for (let k = 0; k < 4; k++) {
        const [sx, sy, sz] = corners[k];
        pos.push(cx + sx * hx, cy + sy * hy, cz + sz * hz);
        nrm.push(...n);
        uv.push(0.5, 0.5);
        joints.push(BONE_INDEX.get(bone), 0, 0, 0);
        weights.push(1, 0, 0, 0);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return { pos, nrm, uv, joints, weights, idx };
}

/** Inverse bind matrix of each bone: translate by minus its rest position (metres, column-major). */
function inverseBinds() {
  const out = [];
  for (const [name, , world] of BONES) {
    const [x, y, z] = world.map((v) => -v * CM);
    void name;
    out.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1);
  }
  return new Float32Array(out);
}

async function writePart(io, file, boxes) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const { top, nodes } = rigNodes(doc);
  const g = partGeometry(boxes);
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", acc("VEC3", new Float32Array(g.pos)))
    .setAttribute("NORMAL", acc("VEC3", new Float32Array(g.nrm)))
    .setAttribute("TEXCOORD_0", acc("VEC2", new Float32Array(g.uv)))
    .setAttribute("JOINTS_0", acc("VEC4", new Uint16Array(g.joints)))
    .setAttribute("WEIGHTS_0", acc("VEC4", new Float32Array(g.weights)))
    .setIndices(acc("SCALAR", new Uint16Array(g.idx)));
  const skin = doc.createSkin("Skin").setInverseBindMatrices(acc("MAT4", inverseBinds()));
  for (const [name] of BONES) skin.addJoint(nodes.get(name));
  const mesh = doc.createNode("Body").setMesh(doc.createMesh(file).addPrimitive(prim)).setSkin(skin);
  doc.createScene("Scene").addChild(top).addChild(mesh);
  await io.write(resolve(OUT, file), doc);
}

async function writeRig(io) {
  const doc = new Document();
  const { top } = rigNodes(doc);
  doc.createScene("Scene").addChild(top);
  await io.write(resolve(OUT, "rig.glb"), doc);
}

// Clips: a looped pose over one cycle, each limb's rotation about x (radians), and the travel per loop.
const LOCO = {
  Idle_Loop: { dur: 2.0, travel: 0, pose: (p) => ({ Spine_02: 2 * Math.sin(p), UpperArm_L: deg(-3), UpperArm_R: deg(-3) }) },
  Walk_Loop: { dur: 1.0, travel: 1.4, pose: (p) => gait(25, 18, p) },
  Jog_Fwd_Loop: { dur: 0.7, travel: 3.6 * 0.7, pose: (p) => gait(35, 30, p) },
  Sprint_Loop: { dur: 0.5, travel: 6.2 * 0.5, pose: (p) => gait(45, 40, p) },
  Jump_Loop: { dur: 1.0, travel: 0, pose: () => ({ UpperArm_L: deg(-120), UpperArm_R: deg(-120), Shin_L: deg(30), Shin_R: deg(30) }) },
  Swim_Idle_Loop: { dur: 2.0, travel: 0, pose: (p) => ({ UpperArm_L: deg(-100 + 6 * Math.sin(p)), UpperArm_R: deg(-100 - 6 * Math.sin(p)) }) },
  Swim_Fwd_Loop: { dur: 1.2, travel: 1.4 * 1.2, pose: (p) => ({ ...gait(15, 70, p), Spine_02: deg(-10) }) },
};

/** A stride: legs swing against each other, arms against the legs, the knee bends on the way through. */
function gait(legDeg, armDeg, p) {
  const s = Math.sin(p);
  return {
    Thigh_L: deg(legDeg) * s,
    Thigh_R: -deg(legDeg) * s,
    Shin_L: deg(legDeg * 0.3) * (1 + Math.cos(p)) / 2,
    Shin_R: deg(legDeg * 0.3) * (1 - Math.cos(p)) / 2,
    UpperArm_L: -deg(armDeg) * s,
    UpperArm_R: deg(armDeg) * s,
    LowerArm_L: deg(-15),
    LowerArm_R: deg(-15),
  };
}

const quat = (a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];

async function writeAnimations(io) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const { top, nodes } = rigNodes(doc);
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const SAMPLES = 24;
  for (const [name, clip] of Object.entries(LOCO)) {
    const anim = doc.createAnimation(name);
    const times = new Float32Array(SAMPLES + 1);
    for (let i = 0; i <= SAMPLES; i++) times[i] = (clip.dur * i) / SAMPLES;
    const input = acc("SCALAR", times);
    for (const [bone] of BONES) {
      const out = [];
      for (let i = 0; i <= SAMPLES; i++) {
        const p = (2 * Math.PI * i) / SAMPLES;
        const a = clip.pose(p)[bone] ?? 0;
        out.push(...quat(a));
      }
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(acc("VEC4", new Float32Array(out))).setInterpolation("LINEAR");
      const channel = doc.createAnimationChannel().setTargetNode(nodes.get(bone)).setTargetPath("rotation").setSampler(sampler);
      anim.addSampler(sampler).addChannel(channel);
    }
  }
  doc.createScene("Scene").addChild(top);
  await io.write(resolve(OUT, "placeholder-anims.glb"), doc);
}

// Mask and base textures: solid PNGs (no art). Mask 0 is the skin region, the rest are empty.
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function main() {
  mkdirSync(resolve(OUT, "parts"), { recursive: true });
  mkdirSync(resolve(OUT, "textures"), { recursive: true });
  const io = new NodeIO();
  await writeRig(io);
  for (const [slot, boxes] of Object.entries(PARTS)) {
    const file = slot === "head" ? "Chr_Head_Male_01" : `Chr_${RIG_NAME[slot]}_Male_01`;
    await writePart(io, `parts/${file}.glb`, boxes);
  }
  await writeAnimations(io);
  writeFileSync(resolve(OUT, "textures/base.png"), png(64, 64, [190, 160, 135]));
  const masks = [[255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  masks.forEach((m, i) => writeFileSync(resolve(OUT, `textures/mask${i}.png`), png(64, 64, m)));

  // The catalog: body slots and head, male set 01 (the starter), female reusing the same files.
  const parts = [];
  const files = {};
  const bodySlots = ["torso", "armUpperRight", "armUpperLeft", "armLowerRight", "armLowerLeft", "handRight", "handLeft", "hips", "legRight", "legLeft"];
  for (const slot of [...bodySlots, "head"]) {
    const male = slot === "head" ? "Chr_Head_Male_01" : `Chr_${RIG_NAME[slot]}_Male_01`;
    const fileOf = `parts/${male}.glb`;
    if (slot === "head") {
      parts.push({ name: male, slot: "head", gender: "male", index: 1 }, { name: "Chr_Head_Female_01", slot: "head", gender: "female", index: 1 });
      files[male] = fileOf;
      files["Chr_Head_Female_01"] = fileOf;
    } else {
      const female = `Chr_${RIG_NAME[slot]}_Female_01`;
      parts.push({ name: male, slot, gender: "male", index: 1 }, { name: female, slot, gender: "female", index: 1 });
      files[male] = fileOf;
      files[female] = fileOf;
    }
  }
  const catalog = {
    version: 1,
    parts,
    rig: "rig.glb",
    files,
    textures: { base: "textures/base.png", masks: ["textures/mask0.png", "textures/mask1.png", "textures/mask2.png", "textures/mask3.png"] },
  };
  writeFileSync(resolve(OUT, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");

  const clips = Object.entries(LOCO).map(([name, c]) => ({ name, source: "placeholder", duration: c.dur, loop: true, travel: [0, c.travel] }));
  const manifest = {
    version: 2,
    sources: [{ id: "placeholder", title: "Stand-in locomotion (generated)", author: "scripts/gen-placeholder-character.mjs", license: "generated; no third-party art", url: "", file: "placeholder-anims.glb" }],
    clips,
  };
  writeFileSync(resolve(OUT, "animations.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote the stand-in character kit to ${OUT}: ${parts.length} part entries, ${Object.keys(LOCO).length} clips`);
}

await main();
