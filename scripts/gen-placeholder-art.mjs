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

mkdirSync(OUT, { recursive: true });
const io = new NodeIO();
for (let i = 0; i < PLACEHOLDER_ART.length; i++) await writeModel(io, PLACEHOLDER_ART[i], i);
const catalog = placeholderCatalog().models.map((m) => ({ ...m, file: `${m.name}.glb` }));
writeFileSync(resolve(OUT, "catalog.json"), JSON.stringify({ models: catalog }, null, 2) + "\n");
console.log(`wrote ${PLACEHOLDER_ART.length} placeholder models to ${OUT}`);
