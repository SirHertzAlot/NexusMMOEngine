// Writes the settlement's stand-in models (SG4a): one plain box GLB per structure kind, and the catalog
// the client reads from apps/client/public/placeholder-art/. Run after building settlement:
//   npm run build -w @mmo-engine/settlement && node scripts/gen-placeholder-art.mjs
// The boxes are generated here, not taken from any art pack; the licensed catalog is never read.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { PLACEHOLDER_ART, placeholderCatalog } from "../packages/settlement/dist/src/placeholder-art.js";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/client/public/placeholder-art");
const PALETTE = [[0.62, 0.55, 0.46], [0.5, 0.52, 0.56], [0.58, 0.5, 0.42], [0.55, 0.6, 0.5], [0.66, 0.6, 0.52], [0.48, 0.45, 0.42]];

/** A box standing on the ground: w by h by d, flat-shaded (a normal per face). */
function boxTriangles([w, h, d]) {
  const x = w / 2, z = d / 2;
  const v = {
    a: [-x, 0, -z], b: [x, 0, -z], c: [x, 0, z], e: [-x, 0, z],
    f: [-x, h, -z], g: [x, h, -z], k: [x, h, z], m: [-x, h, z],
  };
  const quads = [
    [v.f, v.g, v.k, v.m, [0, 1, 0]], // top
    [v.a, v.b, v.g, v.f, [0, 0, -1]], // -z side
    [v.b, v.c, v.k, v.g, [1, 0, 0]], // +x side
    [v.c, v.e, v.m, v.k, [0, 0, 1]], // +z side
    [v.e, v.a, v.f, v.m, [-1, 0, 0]], // -x side
  ];
  const pos = [];
  const nrm = [];
  for (const [p, q, r, s, n] of quads) {
    for (const t of [p, q, r, p, r, s]) {
      pos.push(...t);
      nrm.push(...n);
    }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm) };
}

async function writeModel(io, entry, index) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const { pos, nrm } = boxTriangles(entry.size);
  const material = doc.createMaterial(entry.name).setBaseColorFactor([...PALETTE[index % PALETTE.length], 1]).setRoughnessFactor(0.9).setMetallicFactor(0);
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(pos).setBuffer(buffer))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(nrm).setBuffer(buffer))
    .setMaterial(material);
  const node = doc.createNode(entry.name).setMesh(doc.createMesh(entry.name).addPrimitive(prim));
  doc.createScene(entry.name).addChild(node);
  await io.write(resolve(OUT, `${entry.name}.glb`), doc);
}

/**
 * Stand-in quadrupeds (no licensed art): a body, head, tail and four legs, as plain boxes.
 * Each id is the server's model path (content/wildlife/flora-fauna-models.json), so the
 * client's catalog lookup finds it by the same hash; the name's word picks the rig (quadruped).
 */
const ANIMALS = [
  { id: "models/glb/forest-creatures/Forest_Creatures/Wolf_6K9M8f0j1P.glb", name: "StandIn_Animal_Wolf" },
  { id: "models/glb/forest-creatures/Forest_Creatures/Bear_0PXWfxfb0Hu.glb", name: "StandIn_Animal_Bear" },
  { id: "models/glb/forest-creatures/Forest_Creatures/Boar_57fSWum6F1P.glb", name: "StandIn_Animal_Boar" },
];

/** The quadruped's boxes: [size, centre x, base y, centre z]. */
const QUADRUPED = [
  [[0.7, 0.55, 1.2], 0, 0.75, 0], // body
  [[0.4, 0.4, 0.45], 0, 1.0, 0.85], // head
  [[0.1, 0.1, 0.45], 0, 0.9, -0.75], // tail
  [[0.16, 0.7, 0.16], -0.25, 0, 0.4], // front legs
  [[0.16, 0.7, 0.16], 0.25, 0, 0.4],
  [[0.16, 0.7, 0.16], -0.25, 0, -0.4], // back legs
  [[0.16, 0.7, 0.16], 0.25, 0, -0.4],
];

function quadrupedTriangles() {
  const pos = [];
  const nrm = [];
  for (const [size, cx, y, cz] of QUADRUPED) {
    const box = boxTriangles(size);
    for (let i = 0; i < box.pos.length; i += 3) {
      pos.push(box.pos[i] + cx, box.pos[i + 1] + y, box.pos[i + 2] + cz);
    }
    nrm.push(...box.nrm);
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm) };
}

async function writeAnimal(io, entry, index) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const { pos, nrm } = quadrupedTriangles();
  const material = doc.createMaterial(entry.name).setBaseColorFactor([...PALETTE[index % PALETTE.length], 1]).setRoughnessFactor(0.9).setMetallicFactor(0);
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(pos).setBuffer(buffer))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(nrm).setBuffer(buffer))
    .setMaterial(material);
  const node = doc.createNode(entry.name).setMesh(doc.createMesh(entry.name).addPrimitive(prim));
  doc.createScene(entry.name).addChild(node);
  await io.write(resolve(OUT, `${entry.name}.glb`), doc);
}

mkdirSync(OUT, { recursive: true });
const io = new NodeIO();
for (let i = 0; i < PLACEHOLDER_ART.length; i++) await writeModel(io, PLACEHOLDER_ART[i], i);
for (let i = 0; i < ANIMALS.length; i++) await writeAnimal(io, ANIMALS[i], i);
const catalog = [
  ...placeholderCatalog().models.map((m) => ({ ...m, file: `${m.name}.glb` })),
  ...ANIMALS.map((a) => ({ id: a.id, name: a.name, skinned: false, size: [1, 1.5, 2], file: `${a.name}.glb` })),
];
writeFileSync(resolve(OUT, "catalog.json"), JSON.stringify({ models: catalog }, null, 2) + "\n");
console.log(`wrote ${PLACEHOLDER_ART.length} placeholder models and ${ANIMALS.length} stand-in animals to ${OUT}`);
