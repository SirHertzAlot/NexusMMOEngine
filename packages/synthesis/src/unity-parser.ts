/**
 * Unity Scene (.unity), Prefab (.prefab), and .unitypackage parser.
 *
 * Parses Unity YAML multi-document files directly in Node, resolves GUID maps
 * from .meta files or .unitypackage tar.gz archives, expands nested Prefab
 * hierarchies and stripped Transform parent chains, and converts Unity LH Y-up
 * transforms to MMO Engine RH Y-up coordinates via flipX.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as THREE from "three";
import type { QuatTuple, TransformData, Vec3Tuple } from "./types.js";

export interface UnityRawNode {
  partId: string;
  name: string;
  sourceGuid?: string;
  sourceAssetPath?: string;
  rootGroup: string;
  groupPath: string;
  isInteriorHint: boolean;
  transform: TransformData;
}

export interface UnityPackageIndex {
  /** Lowercase 32-char GUID -> project-relative asset path (forward slashes). */
  guidToPath: Map<string, string>;
  /** Project-relative asset path -> UTF-8 text content for .unity and .prefab files. */
  textFiles: Map<string, string>;
  /** Disk root when loaded from an extracted folder (used for lazy reads if needed). */
  diskRoot?: string;
}

interface UnityGameObject {
  fileId: string;
  name: string;
  isActive: boolean;
  prefabInstance?: string;
  correspondingSource?: { fileId: string; guid?: string };
}

interface UnityTransform {
  fileId: string;
  stripped: boolean;
  gameObject?: string;
  father: string;
  children: string[];
  localPos: Vec3Tuple;
  localRot: QuatTuple;
  localScale: Vec3Tuple;
  correspondingSource?: { fileId: string; guid?: string };
  prefabInstance?: string;
}

interface UnityPrefabMod {
  targetFileId?: string;
  targetGuid?: string;
  propertyPath: string;
  value: string;
  objectRefFileId?: string;
  objectRefGuid?: string;
}

interface UnityPrefabInstance {
  fileId: string;
  sourceFileId?: string;
  sourceGuid?: string;
  transformParent: string;
  mods: UnityPrefabMod[];
}

interface UnityDocumentParsed {
  gameObjects: Map<string, UnityGameObject>;
  transforms: Map<string, UnityTransform>;
  prefabInstances: Map<string, UnityPrefabInstance>;
  /** Mesh GUID referenced by MeshFilter if a prefab embeds its mesh directly. */
  meshGuidsByGo: Map<string, string>;
}

const UNITY_DOC_HEADER = /^--- !u!(\d+) &(-?\d+)(\s+stripped)?/;
const QUAT_REF = /\{fileID:\s*(-?\d+)(?:,\s*guid:\s*([0-9a-fA-F]+))?/;

function parseFileRef(line: string): { fileId?: string; guid?: string } {
  const m = QUAT_REF.exec(line);
  if (!m) return {};
  return { fileId: m[1], guid: m[2]?.toLowerCase() };
}

function parseVec3Braced(line: string, fallback: Vec3Tuple): Vec3Tuple {
  const mx = /\bx:\s*([-+0-9.eE]+)/.exec(line);
  const my = /\by:\s*([-+0-9.eE]+)/.exec(line);
  const mz = /\bz:\s*([-+0-9.eE]+)/.exec(line);
  if (!mx || !my || !mz) return fallback;
  return [Number(mx[1]) || 0, Number(my[1]) || 0, Number(mz[1]) || 0];
}

function parseQuatBraced(line: string): QuatTuple {
  const mx = /\bx:\s*([-+0-9.eE]+)/.exec(line);
  const my = /\by:\s*([-+0-9.eE]+)/.exec(line);
  const mz = /\bz:\s*([-+0-9.eE]+)/.exec(line);
  const mw = /\bw:\s*([-+0-9.eE]+)/.exec(line);
  if (!mx || !my || !mz || !mw) return [0, 0, 0, 1];
  return [Number(mx[1]) || 0, Number(my[1]) || 0, Number(mz[1]) || 0, Number(mw[1]) ?? 1];
}

/** Parse raw Unity YAML scene/prefab text into GameObjects, Transforms, and PrefabInstances. */
export function parseUnityYaml(yamlText: string): UnityDocumentParsed {
  const gameObjects = new Map<string, UnityGameObject>();
  const transforms = new Map<string, UnityTransform>();
  const prefabInstances = new Map<string, UnityPrefabInstance>();
  const meshGuidsByGo = new Map<string, string>();

  const lines = yamlText.split(/\r?\n/);
  let curType = 0;
  let curId = "";
  let curStripped = false;
  let curGo: UnityGameObject | null = null;
  let curTf: UnityTransform | null = null;
  let curPi: UnityPrefabInstance | null = null;
  let curMeshGo: string | undefined;
  let inMods = false;
  let inChildren = false;
  let activeMod: UnityPrefabMod | null = null;

  const flush = (): void => {
    if (curType === 1 && curGo) gameObjects.set(curId, curGo);
    else if (curType === 4 && curTf) transforms.set(curId, curTf);
    else if (curType === 1001 && curPi) {
      if (activeMod) curPi.mods.push(activeMod);
      prefabInstances.set(curId, curPi);
    }
    curType = 0;
    curGo = null;
    curTf = null;
    curPi = null;
    curMeshGo = undefined;
    inMods = false;
    inChildren = false;
    activeMod = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("--- !u!")) {
      flush();
      const hdr = UNITY_DOC_HEADER.exec(line);
      if (!hdr) continue;
      curType = Number(hdr[1]);
      curId = hdr[2]!;
      curStripped = Boolean(hdr[3]);
      if (curType === 1) {
        curGo = { fileId: curId, name: "", isActive: true };
      } else if (curType === 4) {
        curTf = {
          fileId: curId,
          stripped: curStripped,
          father: "0",
          children: [],
          localPos: [0, 0, 0],
          localRot: [0, 0, 0, 1],
          localScale: [1, 1, 1],
        };
      } else if (curType === 1001) {
        curPi = { fileId: curId, transformParent: "0", mods: [] };
      }
      continue;
    }

    if (curType === 1 && curGo) {
      const t = line.trim();
      if (t.startsWith("m_Name:")) curGo.name = t.slice(7).trim();
      else if (t.startsWith("m_IsActive:")) curGo.isActive = t.slice(11).trim() !== "0";
      else if (t.startsWith("m_PrefabInstance:")) curGo.prefabInstance = parseFileRef(t).fileId;
      else if (t.startsWith("m_CorrespondingSourceObject:")) {
        const ref = parseFileRef(t);
        if (ref.fileId) curGo.correspondingSource = { fileId: ref.fileId, guid: ref.guid };
      }
    } else if (curType === 4 && curTf) {
      const t = line.trim();
      if (t.startsWith("m_GameObject:")) {
        inChildren = false;
        curTf.gameObject = parseFileRef(t).fileId;
      } else if (t.startsWith("m_LocalRotation:")) {
        inChildren = false;
        curTf.localRot = parseQuatBraced(t);
      } else if (t.startsWith("m_LocalPosition:")) {
        inChildren = false;
        curTf.localPos = parseVec3Braced(t, [0, 0, 0]);
      } else if (t.startsWith("m_LocalScale:")) {
        inChildren = false;
        curTf.localScale = parseVec3Braced(t, [1, 1, 1]);
      } else if (t.startsWith("m_Father:")) {
        inChildren = false;
        curTf.father = parseFileRef(t).fileId ?? "0";
      } else if (t.startsWith("m_Children:")) {
        inChildren = !t.includes("[]");
      } else if (t.startsWith("m_PrefabInstance:")) {
        inChildren = false;
        curTf.prefabInstance = parseFileRef(t).fileId;
      } else if (t.startsWith("m_CorrespondingSourceObject:")) {
        inChildren = false;
        const ref = parseFileRef(t);
        if (ref.fileId) curTf.correspondingSource = { fileId: ref.fileId, guid: ref.guid };
      } else if (inChildren && t.startsWith("- {fileID:")) {
        const ref = parseFileRef(t);
        if (ref.fileId && ref.fileId !== "0") curTf.children.push(ref.fileId);
      } else if (!line.startsWith("    ")) {
        inChildren = false;
      }
    } else if (curType === 33) {
      const t = line.trim();
      if (t.startsWith("m_GameObject:")) curMeshGo = parseFileRef(t).fileId;
      else if (t.startsWith("m_Mesh:") && curMeshGo) {
        const ref = parseFileRef(t);
        if (ref.guid) meshGuidsByGo.set(curMeshGo, ref.guid);
      }
    } else if (curType === 1001 && curPi) {
      const t = line.trim();
      if (t.startsWith("m_TransformParent:")) {
        if (activeMod) {
          curPi.mods.push(activeMod);
          activeMod = null;
        }
        inMods = false;
        curPi.transformParent = parseFileRef(t).fileId ?? "0";
      } else if (t.startsWith("m_SourcePrefab:")) {
        if (activeMod) {
          curPi.mods.push(activeMod);
          activeMod = null;
        }
        inMods = false;
        const ref = parseFileRef(t);
        curPi.sourceFileId = ref.fileId;
        curPi.sourceGuid = ref.guid;
      } else if (t.startsWith("m_Modifications:")) {
        inMods = !t.includes("[]");
      } else if (inMods && t.startsWith("- target:")) {
        if (activeMod) curPi.mods.push(activeMod);
        const ref = parseFileRef(t);
        activeMod = {
          targetFileId: ref.fileId,
          targetGuid: ref.guid,
          propertyPath: "",
          value: "",
        };
      } else if (inMods && activeMod) {
        if (t.startsWith("propertyPath:")) activeMod.propertyPath = t.slice(13).trim();
        else if (t.startsWith("value:")) activeMod.value = t.slice(6).trim();
        else if (t.startsWith("objectReference:")) {
          const ref = parseFileRef(t);
          activeMod.objectRefFileId = ref.fileId;
          activeMod.objectRefGuid = ref.guid;
        }
      }
    }
  }
  flush();

  return { gameObjects, transforms, prefabInstances, meshGuidsByGo };
}

function readTarGzEntries(buf: Uint8Array): Map<string, Uint8Array> {
  const raw = zlib.gunzipSync(buf);
  const out = new Map<string, Uint8Array>();
  let off = 0;
  while (off + 512 <= raw.length) {
    const hdr = raw.subarray(off, off + 512);
    let empty = true;
    for (let i = 0; i < 512; i++) {
      if (hdr[i] !== 0) {
        empty = false;
        break;
      }
    }
    if (empty) break;
    const rawName = Buffer.from(hdr.subarray(0, 100)).toString("utf8").replace(/\0.*$/, "");
    const prefix = Buffer.from(hdr.subarray(345, 500)).toString("utf8").replace(/\0.*$/, "");
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeStr = Buffer.from(hdr.subarray(124, 136)).toString("utf8").replace(/\0.*$/, "").trim();
    const size = sizeStr ? parseInt(sizeStr, 8) || 0 : 0;
    const typeFlag = hdr[156];
    off += 512;
    if (size > 0 && typeFlag !== 53 /* '5' directory */) {
      out.set(name, raw.subarray(off, off + size));
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

/**
 * Load a Unity GUID index + scene/prefab text cache from either:
 * - an extracted folder (containing `.unity`, `.prefab`, `.meta`, and optional `guid_map.json`), or
 * - a `.unitypackage` archive directly.
 */
export function loadUnityIndex(sourcePath: string): UnityPackageIndex {
  const guidToPath = new Map<string, string>();
  const textFiles = new Map<string, string>();
  const stat = fs.statSync(sourcePath);

  if (stat.isFile()) {
    const entries = readTarGzEntries(fs.readFileSync(sourcePath));
    const buckets = new Map<string, { pathname?: string; asset?: Uint8Array }>();
    for (const [entryName, data] of entries.entries()) {
      const parts = entryName.replace(/^\.\//, "").split("/");
      if (parts.length < 2) continue;
      const guid = parts[0]!.toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(guid)) continue;
      const leaf = parts[parts.length - 1]!;
      const bucket = buckets.get(guid) ?? {};
      if (leaf === "pathname") bucket.pathname = Buffer.from(data).toString("utf8").split(/\r?\n/)[0]!.trim();
      else if (leaf === "asset") bucket.asset = data;
      buckets.set(guid, bucket);
    }
    for (const [guid, b] of buckets.entries()) {
      if (!b.pathname) continue;
      const cleanPath = b.pathname.replace(/\\/g, "/");
      guidToPath.set(guid, cleanPath);
      if (b.asset && (cleanPath.endsWith(".unity") || cleanPath.endsWith(".prefab"))) {
        textFiles.set(cleanPath, Buffer.from(b.asset).toString("utf8"));
      }
    }
    return { guidToPath, textFiles };
  }

  const guidMapFile = path.join(sourcePath, "guid_map.json");
  if (fs.existsSync(guidMapFile)) {
    const raw = JSON.parse(fs.readFileSync(guidMapFile, "utf8")) as Record<string, string>;
    for (const [g, p] of Object.entries(raw)) {
      guidToPath.set(g.toLowerCase(), p.replace(/\\/g, "/"));
    }
  }

  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        if (ent.name.endsWith(".meta")) {
          const content = fs.readFileSync(full, "utf8");
          const m = /^guid:\s*([0-9a-fA-F]{32})/m.exec(content);
          if (m) {
            const rel = path.relative(sourcePath, full.slice(0, -5)).replace(/\\/g, "/");
            guidToPath.set(m[1]!.toLowerCase(), rel);
          }
        } else if (ent.name.endsWith(".unity") || ent.name.endsWith(".prefab")) {
          const rel = path.relative(sourcePath, full).replace(/\\/g, "/");
          textFiles.set(rel, fs.readFileSync(full, "utf8"));
        }
      }
    }
  };
  walk(sourcePath);

  return { guidToPath, textFiles, diskRoot: sourcePath };
}

/**
 * Find matching scene paths in a Unity index (case-insensitive substring or exact path match).
 */
export function findUnityScenes(index: UnityPackageIndex, filter?: string): string[] {
  const scenes = [...index.textFiles.keys()].filter((k) => k.endsWith(".unity")).sort();
  if (!filter) return scenes;
  const low = filter.toLowerCase().replace(/\\/g, "/");
  return scenes.filter((s) => s.toLowerCase() === low || s.toLowerCase().endsWith(`/${low}`) || path.posix.basename(s).toLowerCase() === low);
}

/**
 * Convert Unity LH (X-right, Y-up, Z-forward) local/world TRS to Engine RH (X-left->mirrored? X -> -X):
 * `pos = [-px, py, pz]`, `quat = [qx, -qy, -qz, qw]`, `scale = [sx, sy, sz]`.
 *
 * Additionally canonicalizes symmetric double-axis negative scale flips (det > 0 rigid rotations)
 * into clean positive scales + 180° rotation so downstream systems keep det > 0 whenever possible.
 */
export function unityTrsToEngine(pos: Vec3Tuple, rot: QuatTuple, scl: Vec3Tuple): TransformData {
  const q = new THREE.Quaternion(rot[0], -rot[1], -rot[2], rot[3]).normalize();
  let sx = scl[0];
  let sy = scl[1];
  let sz = scl[2];

  // Two negative axes = det > 0 rigid 180° rotation around the remaining axis!
  if (sx < 0 && sz < 0 && sy > 0) {
    sx = -sx;
    sz = -sz;
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  } else if (sy < 0 && sz < 0 && sx > 0) {
    sy = -sy;
    sz = -sz;
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
  } else if (sx < 0 && sy < 0 && sz > 0) {
    sx = -sx;
    sy = -sy;
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
  }

  return {
    pos: [roundMm(-pos[0]), roundMm(pos[1]), roundMm(pos[2])],
    rot: [roundQ(q.x), roundQ(q.y), roundQ(q.z), roundQ(q.w)],
    scale: [roundScale(sx), roundScale(sy), roundScale(sz)],
  };
}

const roundMm = (v: number): number => Math.round(v * 1000) / 1000 + 0;
const roundQ = (v: number): number => Math.round(v * 10000) / 10000 + 0;
const roundScale = (v: number): number => Math.round(v * 1000) / 1000 + 0;

function composeUnityMat(pos: Vec3Tuple, rot: QuatTuple, scl: Vec3Tuple): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    new THREE.Quaternion(rot[0], rot[1], rot[2], rot[3]).normalize(),
    new THREE.Vector3(scl[0], scl[1], scl[2]),
  );
}

function decomposeUnityMat(mat: THREE.Matrix4): { pos: Vec3Tuple; rot: QuatTuple; scl: Vec3Tuple } {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  mat.decompose(p, q, s);
  return { pos: [p.x, p.y, p.z], rot: [q.x, q.y, q.z, q.w], scl: [s.x, s.y, s.z] };
}

function readPiTrs(mods: UnityPrefabMod[]): {
  isActive: boolean;
  name?: string;
  pos: Vec3Tuple;
  rot: QuatTuple;
  scl: Vec3Tuple;
} {
  let isActive = true;
  let name: string | undefined;
  const pos: Vec3Tuple = [0, 0, 0];
  const rot: QuatTuple = [0, 0, 0, 1];
  const scl: Vec3Tuple = [1, 1, 1];

  for (const m of mods) {
    const v = Number(m.value);
    switch (m.propertyPath) {
      case "m_IsActive":
        isActive = m.value.trim() !== "0";
        break;
      case "m_Name":
        name = m.value.trim();
        break;
      case "m_LocalPosition.x":
        if (Number.isFinite(v)) pos[0] = v;
        break;
      case "m_LocalPosition.y":
        if (Number.isFinite(v)) pos[1] = v;
        break;
      case "m_LocalPosition.z":
        if (Number.isFinite(v)) pos[2] = v;
        break;
      case "m_LocalRotation.x":
        if (Number.isFinite(v)) rot[0] = v;
        break;
      case "m_LocalRotation.y":
        if (Number.isFinite(v)) rot[1] = v;
        break;
      case "m_LocalRotation.z":
        if (Number.isFinite(v)) rot[2] = v;
        break;
      case "m_LocalRotation.w":
        if (Number.isFinite(v)) rot[3] = v;
        break;
      case "m_LocalScale.x":
        if (Number.isFinite(v)) scl[0] = v;
        break;
      case "m_LocalScale.y":
        if (Number.isFinite(v)) scl[1] = v;
        break;
      case "m_LocalScale.z":
        if (Number.isFinite(v)) scl[2] = v;
        break;
    }
  }
  return { isActive, name, pos, rot, scl };
}

/** Clean Unity instance name suffix like "SM_Bld_Wall_01 (12)" -> "SM_Bld_Wall_01". */
export function canonicalPartId(raw: string): string {
  return raw
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s+Variant$/i, "")
    .trim();
}

export interface ExtractUnitySceneOptions {
  /** Skip parts whose name or path matches any of these substrings (e.g. ["Volume", "Plane", "Camera"]). */
  ignoreNames?: readonly string[];
  /** Include nested .prefab hierarchies such as Props/Preset/*.prefab (default true). */
  expandNestedPrefabs?: boolean;
}

const DEFAULT_IGNORE = ["global volume", "directional light", "reflection probe", "main camera"];

/**
 * Parse a Unity scene file and extract every placed geometry instance in Engine coordinates,
 * retaining full group hierarchy context (`rootGroup`, `groupPath`, `isInteriorHint`).
 */
export function extractUnitySceneNodes(
  index: UnityPackageIndex,
  scenePath: string,
  opts: ExtractUnitySceneOptions = {},
): UnityRawNode[] {
  const yaml = index.textFiles.get(scenePath);
  if (!yaml) throw new Error(`Unity scene not found in index: ${scenePath}`);
  const doc = parseUnityYaml(yaml);
  const expandNested = opts.expandNestedPrefabs ?? true;
  const ignore = (opts.ignoreNames ?? DEFAULT_IGNORE).map((s) => s.toLowerCase());

  const prefabCache = new Map<string, UnityDocumentParsed>();
  const getPrefabDoc = (assetPath: string): UnityDocumentParsed | undefined => {
    let parsed = prefabCache.get(assetPath);
    if (parsed) return parsed;
    const text = index.textFiles.get(assetPath);
    if (!text) return undefined;
    parsed = parseUnityYaml(text);
    prefabCache.set(assetPath, parsed);
    return parsed;
  };

  // Resolve active state and names along Transform chain
  const isTfActive = (tfId: string, d: UnityDocumentParsed): boolean => {
    let cur: string | undefined = tfId;
    const visited = new Set<string>();
    while (cur && cur !== "0" && !visited.has(cur)) {
      visited.add(cur);
      const tf = d.transforms.get(cur);
      if (!tf) break;
      if (tf.gameObject) {
        const go = d.gameObjects.get(tf.gameObject);
        if (go && !go.isActive) return false;
      }
      cur = tf.father;
    }
    return true;
  };

  // Compute world matrix in Unity LH space for any Transform (including stripped ones)
  const worldMatCache = new Map<string, THREE.Matrix4>();
  const getWorldMatrix = (tfId: string, d: UnityDocumentParsed, keyPrefix = ""): THREE.Matrix4 => {
    const cacheKey = `${keyPrefix}${tfId}`;
    const hit = worldMatCache.get(cacheKey);
    if (hit) return hit;

    const m = new THREE.Matrix4();
    if (!tfId || tfId === "0") {
      worldMatCache.set(cacheKey, m);
      return m;
    }
    const tf = d.transforms.get(tfId);
    if (!tf) {
      worldMatCache.set(cacheKey, m);
      return m;
    }

    if (tf.stripped && tf.prefabInstance && tf.correspondingSource?.fileId) {
      // Tracestripped Transform: its PrefabInstance's transformParent * local matrix inside the prefab + any mods
      const pi = d.prefabInstances.get(tf.prefabInstance);
      const parentMat = pi ? getWorldMatrix(pi.transformParent, d, keyPrefix) : new THREE.Matrix4();
      const piTrs = pi ? readPiTrs(pi.mods) : { pos: [0, 0, 0] as Vec3Tuple, rot: [0, 0, 0, 1] as QuatTuple, scl: [1, 1, 1] as Vec3Tuple };
      const piMat = composeUnityMat(piTrs.pos, piTrs.rot, piTrs.scl);

      let subMat = new THREE.Matrix4();
      const srcPath = pi?.sourceGuid ? index.guidToPath.get(pi.sourceGuid) : undefined;
      const srcDoc = srcPath ? getPrefabDoc(srcPath) : undefined;
      if (srcDoc) {
        const subTfId = tf.correspondingSource.fileId;
        subMat = getWorldMatrix(subTfId, srcDoc, `${srcPath}:`);
      }
      m.copy(parentMat).multiply(piMat).multiply(subMat);
      worldMatCache.set(cacheKey, m);
      return m;
    }

    const parentMat = tf.father && tf.father !== "0" ? getWorldMatrix(tf.father, d, keyPrefix) : new THREE.Matrix4();
    const localMat = composeUnityMat(tf.localPos, tf.localRot, tf.localScale);
    m.copy(parentMat).multiply(localMat);
    worldMatCache.set(cacheKey, m);
    return m;
  };

  const getHierarchyMeta = (tfId: string, d: UnityDocumentParsed): { rootGroup: string; groupPath: string; isInteriorHint: boolean } => {
    const names: string[] = [];
    let cur: string | undefined = tfId;
    const seen = new Set<string>();
    while (cur && cur !== "0" && !seen.has(cur)) {
      seen.add(cur);
      const tf = d.transforms.get(cur);
      if (!tf) break;
      const goName = tf.gameObject ? d.gameObjects.get(tf.gameObject)?.name : undefined;
      if (goName) names.push(goName);
      if (tf.stripped && tf.prefabInstance) {
        const pi = d.prefabInstances.get(tf.prefabInstance);
        cur = pi?.transformParent ?? "0";
      } else {
        cur = tf.father;
      }
    }
    names.reverse();
    const rootGroup = names[0] ?? "SceneRoot";
    const groupPath = names.join("/");
    const isInteriorHint = /interior/i.test(groupPath);
    return { rootGroup, groupPath, isInteriorHint };
  };

  const out: UnityRawNode[] = [];

  const emitPrefabInstance = (
    pi: UnityPrefabInstance,
    d: UnityDocumentParsed,
    parentWorldMat: THREE.Matrix4,
    meta: { rootGroup: string; groupPath: string; isInteriorHint: boolean },
    depth: number,
  ): void => {
    const trs = readPiTrs(pi.mods);
    if (!trs.isActive) return;

    const srcPath = pi.sourceGuid ? index.guidToPath.get(pi.sourceGuid) : undefined;
    if (!srcPath) return;

    const piLocalMat = composeUnityMat(trs.pos, trs.rot, trs.scl);
    const piWorldMat = new THREE.Matrix4().copy(parentWorldMat).multiply(piLocalMat);

    // If this points directly to a model/FBX asset or non-prefab asset, or nested prefab expansion is disabled
    if (!srcPath.endsWith(".prefab")) {
      const base = canonicalPartId(path.posix.basename(srcPath, path.posix.extname(srcPath)));
      if (ignore.some((ig) => base.toLowerCase().includes(ig))) return;
      const dec = decomposeUnityMat(piWorldMat);
      out.push({
        partId: base,
        name: trs.name ?? base,
        sourceGuid: pi.sourceGuid,
        sourceAssetPath: srcPath,
        rootGroup: meta.rootGroup,
        groupPath: meta.groupPath,
        isInteriorHint: meta.isInteriorHint,
        transform: unityTrsToEngine(dec.pos, dec.rot, dec.scl),
      });
      return;
    }

    // Check whether this .prefab is a leaf wrapper around a single mesh/SM_*, or a composite prefab (like Props/Preset/*.prefab)
    const prefabDoc = getPrefabDoc(srcPath);
    const baseName = canonicalPartId(path.posix.basename(srcPath, ".prefab"));

    if (!expandNested || depth > 4 || !prefabDoc || (prefabDoc.prefabInstances.size === 0 && prefabDoc.transforms.size <= 1)) {
      if (ignore.some((ig) => baseName.toLowerCase().includes(ig))) return;
      const dec = decomposeUnityMat(piWorldMat);
      out.push({
        partId: baseName,
        name: trs.name ?? baseName,
        sourceGuid: pi.sourceGuid,
        sourceAssetPath: srcPath,
        rootGroup: meta.rootGroup,
        groupPath: meta.groupPath,
        isInteriorHint: meta.isInteriorHint,
        transform: unityTrsToEngine(dec.pos, dec.rot, dec.scl),
      });
      return;
    }

    // Composite .prefab: emit its direct MeshFilter/GameObjects AND its child PrefabInstances!
    // Check root transforms inside the prefab
    const subWorld = (tfId: string): THREE.Matrix4 => {
      if (!tfId || tfId === "0") return new THREE.Matrix4();
      const tf = prefabDoc.transforms.get(tfId);
      if (!tf) return new THREE.Matrix4();
      const p = tf.father && tf.father !== "0" ? subWorld(tf.father) : new THREE.Matrix4();
      return p.multiply(composeUnityMat(tf.localPos, tf.localRot, tf.localScale));
    };

    const childPath = `${meta.groupPath}/${baseName}`;
    const childMeta = {
      rootGroup: meta.rootGroup,
      groupPath: childPath,
      isInteriorHint: meta.isInteriorHint || /interior/i.test(baseName),
    };

    // Child PrefabInstances inside the .prefab
    for (const childPi of prefabDoc.prefabInstances.values()) {
      const pMat = subWorld(childPi.transformParent);
      const comb = new THREE.Matrix4().copy(piWorldMat).multiply(pMat);
      emitPrefabInstance(childPi, prefabDoc, comb, childMeta, depth + 1);
    }

    // Any direct mesh GOs inside the .prefab that are not just empty parent containers
    for (const tf of prefabDoc.transforms.values()) {
      if (!tf.gameObject || tf.stripped) continue;
      const meshGuid = prefabDoc.meshGuidsByGo.get(tf.gameObject);
      const meshPath = meshGuid ? index.guidToPath.get(meshGuid) : undefined;
      const go = prefabDoc.gameObjects.get(tf.gameObject);
      if (!go || !go.isActive) continue;
      if (meshPath) {
        const meshPart = canonicalPartId(path.posix.basename(meshPath, path.posix.extname(meshPath)));
        if (ignore.some((ig) => meshPart.toLowerCase().includes(ig))) continue;
        const comb = new THREE.Matrix4().copy(piWorldMat).multiply(subWorld(tf.fileId));
        const dec = decomposeUnityMat(comb);
        out.push({
          partId: meshPart,
          name: go.name || meshPart,
          sourceGuid: meshGuid,
          sourceAssetPath: meshPath,
          rootGroup: meta.rootGroup,
          groupPath: childPath,
          isInteriorHint: childMeta.isInteriorHint,
          transform: unityTrsToEngine(dec.pos, dec.rot, dec.scl),
        });
      }
    }
  };

  for (const pi of doc.prefabInstances.values()) {
    if (pi.transformParent !== "0" && !isTfActive(pi.transformParent, doc)) continue;
    const parentWorld = getWorldMatrix(pi.transformParent, doc);
    const meta = pi.transformParent !== "0"
      ? getHierarchyMeta(pi.transformParent, doc)
      : { rootGroup: "SceneRoot", groupPath: "SceneRoot", isInteriorHint: false };
    emitPrefabInstance(pi, doc, parentWorld, meta, 0);
  }

  return out;
}
