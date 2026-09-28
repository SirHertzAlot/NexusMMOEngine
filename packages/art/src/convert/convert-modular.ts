/**
 * convert-modular — the Modular Fantasy Hero rig, ready for characters:
 *
 *   <assets>/models/glb/modular-fantasy-hero/Rigged/
 *     rig.glb             the skeleton (52 bones, metres)
 *     parts/<name>.glb    one skinned part each, bound to that skeleton
 *     catalog.json        what each part is (see character/modular-catalog)
 *
 *   node dist/src/convert/convert-modular.js [--assets <dir>]
 *
 * three.js's FBXLoader gives each of the 720 parts its own copy of the
 * skeleton (3,513 bones), nested inside the real one. Every copy has the
 * same rest pose, and the file's current pose is its bind pose, so the
 * converter builds ONE skeleton and binds each part to it afresh. A bone
 * is known by its path from the top (copies, nested inside the bone they
 * copy, collapse onto it): the pack names both hands' fingers alike
 * (Thumb_01 …), so those get a side (Thumb_01_L, Thumb_01_R) to keep
 * every bone name unique. Each part file carries that skeleton; the
 * client binds the parts of a character to one shared rig by bone name.
 *
 * Units: the FBX is in centimetres; every output file has a 0.01 root.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { buildCatalog, type RiggedCatalog } from "../character/modular-catalog.js";
import { installNodeShims, loadFbx } from "./convert-packs.js";
import { withExternalTextures } from "./glb-textures.js";

const SOURCE = "models/3d/POLYGON_Modular_Fantasy_Hero_SourceFiles_v2/Source_Files/FBX/ModularCharacters.fbx";
const OUT_DIR = "models/glb/modular-fantasy-hero/Rigged";
const TEXTURE_DIR = "textures/modular-fantasy-hero";
const BASE_TEXTURE = "PolygonFantasyHero_Texture_01_A.png";
const MASK_TEXTURES = [1, 2, 3, 4].map((n) => `PolygonFantasyHero_Texture_Mask_0${n}.png`);

/**
 * A bone's identity: the names from the top bone down to it, with a bone
 * nested directly inside a namesake (a skeleton copy) collapsed onto it.
 */
export function bonePath(bone: THREE.Object3D): string {
  const names: string[] = [];
  for (let b: THREE.Object3D | null = bone; b && (b as THREE.Bone).isBone; b = b.parent) {
    if (names[names.length - 1] !== b.name) names.push(b.name);
  }
  return names.reverse().join("/");
}

/**
 * A unique name per bone path: the bone's own name, or — when two paths
 * end in the same name (both hands' fingers) — the name with the side of
 * its nearest sided ancestor (Hand_L → Thumb_01_L).
 */
function uniqueBoneNames(paths: Iterable<string>): Map<string, string> {
  const byLeaf = new Map<string, string[]>();
  for (const p of paths) {
    const leaf = p.slice(p.lastIndexOf("/") + 1);
    byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), p]);
  }
  const out = new Map<string, string>();
  for (const [leaf, group] of byLeaf) {
    if (group.length === 1) {
      out.set(group[0], leaf);
      continue;
    }
    const taken = new Set<string>();
    for (const p of group) {
      const side = p.split("/").reverse().map((n) => /_(L|R)$/.exec(n)?.[1]).find((s) => s !== undefined);
      const name = side ? `${leaf}_${side}` : leaf;
      if (taken.has(name)) throw new Error(`modular rig: can't tell ${p} from another ${leaf}`);
      taken.add(name);
      out.set(p, name);
    }
  }
  return out;
}

/**
 * One skeleton from the skins of `meshes`: a bone per distinct path (see
 * bonePath), uniquely named, posed like the source (world matrices
 * relative to `space`). `nameOf` maps a source bone to its rig name.
 */
export function canonicalSkeleton(
  meshes: readonly THREE.SkinnedMesh[],
  space: THREE.Object3D,
): { root: THREE.Bone; byName: Map<string, THREE.Bone>; nameOf(bone: THREE.Object3D): string } {
  space.updateMatrixWorld(true);
  const toSpace = space.matrixWorld.clone().invert();
  const source = new Map<string, THREE.Bone>();
  const visit = (b: THREE.Object3D): void => {
    if (!(b as THREE.Bone).isBone) return;
    const key = bonePath(b);
    if (source.has(key)) return;
    source.set(key, b as THREE.Bone);
    if (b.parent) visit(b.parent); // ancestors no skin references (Root)
  };
  for (const m of meshes) for (const b of m.skeleton.bones) visit(b);
  const names = uniqueBoneNames(source.keys());
  const nameOf = (b: THREE.Object3D): string => {
    const name = names.get(bonePath(b));
    if (name === undefined) throw new Error(`modular rig: unknown bone ${bonePath(b)}`);
    return name;
  };

  const byPath = new Map<string, THREE.Bone>();
  const byName = new Map<string, THREE.Bone>();
  for (const key of source.keys()) {
    const bone = new THREE.Bone();
    bone.name = names.get(key)!;
    byPath.set(key, bone);
    byName.set(bone.name, bone);
  }
  let root: THREE.Bone | null = null;
  const local = new THREE.Matrix4();
  for (const [key, src] of source) {
    const bone = byPath.get(key)!;
    const parentKey = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : null;
    const world = toSpace.clone().multiply(src.matrixWorld);
    if (parentKey) {
      byPath.get(parentKey)!.add(bone);
      local.copy(toSpace.clone().multiply(source.get(parentKey)!.matrixWorld)).invert().multiply(world);
    } else {
      if (root) throw new Error(`modular rig: two root bones (${root.name}, ${bone.name})`);
      root = bone;
      local.copy(world);
    }
    local.decompose(bone.position, bone.quaternion, bone.scale);
  }
  if (!root) throw new Error("modular rig: no bones");
  return { root, byName, nameOf };
}

/** A copy of a bone hierarchy (names and rest transforms). */
export function cloneBones(root: THREE.Bone): { root: THREE.Bone; byName: Map<string, THREE.Bone> } {
  const byName = new Map<string, THREE.Bone>();
  const copy = (src: THREE.Bone): THREE.Bone => {
    const b = new THREE.Bone();
    b.name = src.name;
    b.position.copy(src.position);
    b.quaternion.copy(src.quaternion);
    b.scale.copy(src.scale);
    byName.set(b.name, b);
    for (const c of src.children) if ((c as THREE.Bone).isBone) b.add(copy(c as THREE.Bone));
    return b;
  };
  return { root: copy(root), byName };
}

/**
 * A part as its own scene: `scale` root, a copy of the rig, and the mesh
 * where it sits in the source, bound to the copy at rest.
 */
export function partScene(
  src: THREE.SkinnedMesh,
  rig: THREE.Bone,
  space: THREE.Object3D,
  material: THREE.Material,
  scale: number,
  nameOf: (bone: THREE.Object3D) => string = (b) => b.name,
): THREE.Group {
  const scene = new THREE.Group();
  scene.name = src.name;
  scene.scale.setScalar(scale);
  const { root, byName } = cloneBones(rig);
  scene.add(root);
  const mesh = new THREE.SkinnedMesh(src.geometry, material);
  mesh.name = src.name;
  space.updateMatrixWorld(true);
  space.matrixWorld.clone().invert().multiply(src.matrixWorld).decompose(mesh.position, mesh.quaternion, mesh.scale);
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  const bones = src.skeleton.bones.map((b) => {
    const bone = byName.get(nameOf(b));
    if (!bone) throw new Error(`modular rig: ${src.name} uses unknown bone ${b.name}`);
    return bone;
  });
  // Fresh inverses at the rest pose (the source's current pose is its bind pose).
  mesh.bind(new THREE.Skeleton(bones));
  return scene;
}

export interface ModularConvertReport {
  parts: number;
  unknown: string[];
  bones: number;
  bytes: number;
  ms: number;
}

export async function convertModular(assetsRoot: string, log: (line: string) => void = () => {}): Promise<ModularConvertReport> {
  const t0 = performance.now();
  installNodeShims();
  const sourceFile = path.join(assetsRoot, SOURCE);
  if (!fs.existsSync(sourceFile)) throw new Error(`convert-modular: ${sourceFile} not found`);
  const fbx = loadFbx(sourceFile);
  const meshes: THREE.SkinnedMesh[] = [];
  fbx.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  const rig = canonicalSkeleton(meshes, fbx);
  log(`[modular] ${meshes.length} skinned parts, one ${rig.byName.size}-bone skeleton`);

  const outDir = path.join(assetsRoot, OUT_DIR);
  const partsDir = path.join(outDir, "parts");
  fs.mkdirSync(partsDir, { recursive: true });
  const textureUri = (from: string, file: string): string =>
    path.relative(from, path.join(assetsRoot, TEXTURE_DIR, file)).split(path.sep).join("/");

  const material = new THREE.MeshStandardMaterial({ name: "FantasyHero", roughness: 1, metalness: 0 });
  const uris = new Map([["FantasyHero", textureUri(partsDir, BASE_TEXTURE)]]);
  const files: Record<string, string> = {};
  let bytes = 0;
  const flipped = new Set<THREE.BufferGeometry>();
  for (const src of meshes) {
    // three's FBX UVs assume flipY textures; glTF samples unflipped.
    const uv = src.geometry.attributes.uv as THREE.BufferAttribute | undefined;
    if (uv && !flipped.has(src.geometry)) {
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      flipped.add(src.geometry);
    }
    const scene = partScene(src, rig.root, fbx, material, 0.01, rig.nameOf);
    const glb = withExternalTextures(
      new Uint8Array((await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer),
      uris,
    );
    const file = `parts/${src.name}.glb`;
    fs.writeFileSync(path.join(outDir, file), glb);
    files[src.name] = file;
    bytes += glb.byteLength;
  }

  // The skeleton alone: the rig every character's parts bind to.
  const rigScene = new THREE.Group();
  rigScene.name = "ModularRig";
  rigScene.scale.setScalar(0.01);
  rigScene.add(cloneBones(rig.root).root);
  const rigGlb = new Uint8Array((await new GLTFExporter().parseAsync(rigScene, { binary: true })) as ArrayBuffer);
  fs.writeFileSync(path.join(outDir, "rig.glb"), rigGlb);

  const { catalog, unknown } = buildCatalog(meshes.map((m) => m.name));
  const rigged: RiggedCatalog = {
    ...catalog,
    rig: "rig.glb",
    files,
    textures: {
      base: textureUri(outDir, BASE_TEXTURE),
      masks: MASK_TEXTURES.map((f) => textureUri(outDir, f)),
    },
  };
  fs.writeFileSync(path.join(outDir, "catalog.json"), `${JSON.stringify(rigged, null, 1)}\n`);
  for (const m of meshes) m.geometry.dispose();
  material.dispose();
  const report = {
    parts: catalog.parts.length,
    unknown,
    bones: rig.byName.size,
    bytes: bytes + rigGlb.byteLength,
    ms: performance.now() - t0,
  };
  log(
    `[modular] wrote ${meshes.length} part files + rig + catalog (${(report.bytes / 1e6).toFixed(1)} MB) in ${(report.ms / 1000).toFixed(1)} s` +
      (unknown.length > 0 ? `; ${unknown.length} unrecognised part name(s): ${unknown.slice(0, 5).join(", ")}` : ""),
  );
  return report;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--assets");
  const assets = at >= 0 ? path.resolve(args[at + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../assets");
  convertModular(assets, (l) => console.log(l)).catch((err) => {
    console.error(`[modular] failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
