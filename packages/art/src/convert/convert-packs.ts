/**
 * convert-packs — turn source art packs (FBX + material lists + texture
 * atlases) into web-ready GLB models, a manifest, and an asset catalog.
 *
 *   npm run convert:packs                      convert new/changed files
 *   npm run convert:packs -- --force           reconvert everything
 *   npm run convert:packs -- --only dungeon-pack --limit 20
 *
 * Input:  <assets>/models/3d/<pack>/   (any folder with a MaterialList_*.txt)
 * Output: <assets>/models/glb/<pack>/<category>/<Name>.glb
 *         <assets>/textures/<pack>/<Atlas>.png
 *         <assets>/manifest.json   (the art-pack contract the editor/client load)
 *         <assets>/catalog.json    (per-model metadata: category, rig, size…)
 *
 * Per model: FBX -> three.js (FBXLoader) -> metres (each source folder's
 * unit is detected from a sample: headers always claim centimetres, but some
 * folders are authored in metres) ->
 * materials renamed/atlased from the pack's material list (the FBX only
 * carries DCC leftovers like "lambert1439") -> UVs flipped to glTF
 * orientation -> GLB (GLTFExporter) whose materials reference the shared
 * atlas by relative URI instead of embedding a copy per model.
 *
 * Skipped: OBJ duplicates, Unreal-rigged copies, *FixedScale* variants.
 * Everything stays under assets/, which is git-ignored (licensed art).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { ManifestSchema, type AssetManifest } from "../manifest.js";
import { withExternalTextures } from "./glb-textures.js";
import { toPng } from "./image-decode.js";
import {
  indexMeshes,
  parseMaterialList,
  primaryTexture,
  type MaterialSlot,
  type MeshMaterials,
  type PrefabMaterials,
} from "./material-list.js";

/** Bump to force a full reconvert when the output format changes. */
// 4: TGA/PSD atlases converted to PNG, atlases found in Textures subfolders.
export const CONVERTER_VERSION = 4;
/**
 * A source folder whose median model would be smaller than this many
 * centimetres is authored in metres (its FBX headers claim centimetres
 * regardless — e.g. the dungeon pack's static meshes). Folders of real
 * environment art don't have a 5 cm median.
 */
const METRES_IF_MEDIAN_UNDER_CM = 5;
/** Files sampled per folder to decide its unit. */
const UNIT_SAMPLE = 12;
const WEB_TEXTURE = /\.(png|jpe?g|webp)$/i;
/** Atlas formats the converter turns into PNG (browsers can't load them). */
const CONVERTIBLE_TEXTURE = /\.(tga|psd)$/i;

export interface CatalogModel {
  id: string;
  pack: string;
  name: string;
  category: string;
  file: string;
  skinned: boolean;
  bones: number;
  meshes: number;
  triangles: number;
  /** Bounding box in metres [x, y, z]. */
  size: [number, number, number];
  materials: Array<{ name: string; texture: string | null }>;
  /** Source unit detected for the model's folder (cm: scaled by 0.01). */
  unit: "cm" | "m";
  /** Conversion notes (unmatched material list, missing atlas), re-reported every run. */
  notes: string[];
  /** Imported GLB packs (import-glb-packs): animation clips in the file. */
  animations?: number;
  /** Imported GLB packs: who made it and under what licence, as the pack stated (name null = not stated). */
  license?: { author: string; name: string | null; page: string | null };
}

export interface Catalog {
  converterVersion: number;
  packs: Array<{ slug: string; source: string; models: number; textures: number; /** Brought in by import-glb-packs, kept across convert runs. */ imported?: true }>;
  models: CatalogModel[];
  diagnostics: string[];
}

/** "POLYGON_FantasyKingdom_SourceFiles_v3" -> "fantasy-kingdom". */
export function packSlug(folder: string): string {
  return folder
    .replace(/^POLYGON_/i, "")
    .replace(/_?Source_?Files.*$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

const safeSegment = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, "_") || "Uncategorized";
const posix = (p: string): string => p.split(path.sep).join("/");

/** Recursively list files, skipping directories rejected by `skipDir`. */
function walk(dir: string, skipDir: (name: string) => boolean, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!skipDir(e.name)) walk(full, skipDir, out);
    } else if (e.isFile()) out.push(full);
  }
  return out;
}

/**
 * GLBs under `glbRoot` that no pack model maps to. Folders other
 * converters own are never touched: any folder with its own catalog.json
 * (convert:modular's rigged character parts and convert:animations' clips,
 * in models/glb/<pack>/Rigged/). Deleting those broke characters and their
 * animations after a full pack run.
 */
export function staleGlbs(glbRoot: string, keep: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!fs.existsSync(path.join(full, "catalog.json")) && e.name !== "Rigged") visit(full);
      } else if (e.isFile() && full.endsWith(".glb") && !keep.has(full)) out.push(full);
    }
  };
  visit(glbRoot);
  return out;
}

const skipSourceDir = (name: string): boolean =>
  /^(obj|bonusobj)$/i.test(name) || /unreal/i.test(name) || name.startsWith(".");

interface Pack {
  slug: string;
  dir: string;
  materials: Map<string, PrefabMaterials>;
  meshIndex: Map<string, MeshMaterials>;
  defaultTexture: string | null;
  /**
   * The pack's atlases by lower-case name (no extension): the best source
   * file for each, from any Textures folder (subfolders too). A web format
   * wins over TGA, TGA over PSD, a shallower file over a deeper one.
   */
  textures: Map<string, string>;
  fbx: string[];
}

const TEXTURE_RANK = (f: string): number => (WEB_TEXTURE.test(f) ? 0 : /\.tga$/i.test(f) ? 1 : 2);

/** Every atlas under the pack's Textures folders, best source per name. */
export function packTextures(files: readonly string[], packDir: string): Map<string, string> {
  const best = new Map<string, string>();
  for (const f of files) {
    if (!WEB_TEXTURE.test(f) && !CONVERTIBLE_TEXTURE.test(f)) continue;
    const rel = path.relative(packDir, f).split(path.sep);
    if (!rel.slice(0, -1).some((seg) => /^_?textures?$/i.test(seg))) continue;
    const key = path.basename(f, path.extname(f)).toLowerCase();
    const prev = best.get(key);
    const depth = (x: string): number => path.relative(packDir, x).split(path.sep).length;
    if (!prev || TEXTURE_RANK(f) < TEXTURE_RANK(prev) || (TEXTURE_RANK(f) === TEXTURE_RANK(prev) && depth(f) < depth(prev))) best.set(key, f);
  }
  return best;
}

export function discoverPacks(sourceRoot: string): Pack[] {
  if (!fs.existsSync(sourceRoot)) return [];
  const packs: Pack[] = [];
  for (const e of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(sourceRoot, e.name);
    const files = walk(dir, (n) => n.startsWith("."));
    const list = files.find((f) => /^MaterialList_.*\.txt$/i.test(path.basename(f)));
    if (!list) continue;
    const materials = parseMaterialList(fs.readFileSync(list, "utf8"));
    packs.push({
      slug: packSlug(e.name),
      dir,
      materials,
      meshIndex: indexMeshes(materials),
      defaultTexture: primaryTexture(materials),
      textures: packTextures(files, dir),
      fbx: walk(dir, skipSourceDir)
        .filter((f) => /\.fbx$/i.test(f) && !/fixedscale/i.test(path.basename(f)))
        // Main folders before Bonus* ones, so duplicate names keep the main file.
        .sort((a, b) => Number(/bonus/i.test(a)) - Number(/bonus/i.test(b)) || a.localeCompare(b)),
    });
  }
  return packs;
}

/** Headless three.js: no image decoding, and GLTFExporter's binary path needs FileReader. */
export function installNodeShims(): void {
  THREE.TextureLoader.prototype.load = function load(): THREE.Texture<HTMLImageElement> {
    return new THREE.Texture() as THREE.Texture<HTMLImageElement>;
  };
  const g = globalThis as { FileReader?: unknown };
  g.FileReader ??= class {
    result: ArrayBuffer | string | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then((r) => {
        this.result = r;
        this.onloadend?.();
      });
    }
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer().then((r) => {
        this.result = `data:application/octet-stream;base64,${Buffer.from(r).toString("base64")}`;
        this.onloadend?.();
      });
    }
  };
}

/** A mesh's material slots: its own prefab entry, else any prefab's mesh of that name. */
function slotsFor(
  prefab: PrefabMaterials | undefined,
  meshIndex: Map<string, MeshMaterials>,
  meshName: string,
): { slots: MaterialSlot[]; folder: string | null } {
  const own = prefab?.meshes.get(meshName);
  if (own && prefab) return { slots: own, folder: prefab.folder };
  const indexed = meshIndex.get(meshName);
  if (indexed) return { slots: indexed.slots, folder: indexed.folder };
  if (prefab) return { slots: prefab.meshes.values().next().value ?? [], folder: prefab.folder };
  return { slots: [], folder: null };
}

interface Converted {
  glb: Uint8Array;
  stats: Omit<CatalogModel, "id" | "pack" | "name" | "category" | "file" | "notes">;
  /** Material-list folder of the first matched mesh (null: nothing matched). */
  folder: string | null;
}

export function loadFbx(file: string): THREE.Group {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new FBXLoader().parse(ab, `${path.dirname(file)}/`);
}

/** Largest bounding-box dimension of an FBX in its own raw units. */
function rawLargestDimension(file: string): number {
  const model = loadFbx(file);
  model.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  model.traverse((o) => {
    (o as THREE.Mesh).geometry?.dispose();
    const m = (o as THREE.Mesh).material;
    if (m) (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
  });
  return Math.max(size.x, size.y, size.z);
}

/**
 * Decide a folder's unit from a sample of its files: FBX headers claim
 * centimetres everywhere, but some folders are authored in metres.
 */
function detectUnit(files: readonly string[]): { unit: "cm" | "m"; medianCm: number } {
  const step = Math.max(1, Math.floor(files.length / UNIT_SAMPLE));
  const sizes: number[] = [];
  for (let i = 0; i < files.length && sizes.length < UNIT_SAMPLE; i += step) {
    try {
      const d = rawLargestDimension(files[i]);
      if (d > 0) sizes.push(d);
    } catch {
      /* unreadable sample: skip it */
    }
  }
  sizes.sort((a, b) => a - b);
  const medianCm = sizes.length > 0 ? sizes[sizes.length >> 1] : Infinity;
  return { unit: medianCm < METRES_IF_MEDIAN_UNDER_CM ? "m" : "cm", medianCm };
}

async function convertOne(
  file: string,
  prefab: PrefabMaterials | undefined,
  meshIndex: Map<string, MeshMaterials>,
  textureUri: (texture: string) => string | null,
  defaultTexture: string | null,
  unit: "cm" | "m",
): Promise<Converted> {
  const model = loadFbx(file);

  const root = new THREE.Group();
  root.name = path.basename(file, path.extname(file));
  root.scale.setScalar(unit === "cm" ? 0.01 : 1);
  root.add(model);

  const byName = new Map<string, THREE.MeshStandardMaterial>();
  const uriByMaterial = new Map<string, string>();
  const flipped = new Set<THREE.BufferGeometry>();
  const materialsOut: Array<{ name: string; texture: string | null }> = [];
  let meshes = 0;
  let skinned = 0;
  let bones = 0;
  let triangles = 0;
  let folder: string | null = null;

  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones++;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned++;
    const geo = mesh.geometry;
    triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    // three's FBX UVs assume flipY textures; glTF samples unflipped.
    const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
    if (uv && !flipped.has(geo)) {
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      flipped.add(geo);
    }
    const match = slotsFor(prefab, meshIndex, mesh.name);
    const slots = match.slots;
    folder ??= match.folder;
    const convert = (src: THREE.Material, i: number): THREE.Material => {
      const slot = slots[i] ?? slots[0];
      const name = slot?.material ?? src.name ?? `material_${i}`;
      let out = byName.get(name);
      if (!out) {
        // Custom-shader slots (e.g. the modular hero colour-mask shader)
        // fall back to the pack's main atlas until that shader exists.
        const texture = slot?.texture ?? defaultTexture;
        const uri = texture ? textureUri(texture) : null;
        const s = src as THREE.MeshPhongMaterial;
        out = new THREE.MeshStandardMaterial({
          name,
          color: uri ? new THREE.Color(1, 1, 1) : s.color ?? new THREE.Color(0.7, 0.7, 0.7),
          vertexColors: s.vertexColors,
          transparent: s.transparent || s.opacity < 1,
          opacity: s.opacity,
          side: s.side,
          roughness: 1,
          metalness: 0,
        });
        byName.set(name, out);
        if (uri) uriByMaterial.set(name, uri);
        materialsOut.push({ name, texture: uri ? texture : null });
      }
      src.dispose();
      return out;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(convert)
      : convert(mesh.material, 0);
  });

  root.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  const glb = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;

  // Free CPU-side buffers now: thousands of models run in one process.
  root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  for (const m of byName.values()) m.dispose();

  return {
    glb: withExternalTextures(new Uint8Array(glb), uriByMaterial),
    stats: {
      skinned: skinned > 0,
      bones,
      meshes,
      triangles: Math.round(triangles),
      size: [round3(size.x), round3(size.y), round3(size.z)],
      materials: materialsOut,
      unit,
    },
    folder,
  };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface ConvertOptions {
  assetsRoot: string;
  sourceRoot?: string;
  force?: boolean;
  only?: string;
  limit?: number;
  log?: (line: string) => void;
}

export async function convertPacks(opts: ConvertOptions): Promise<Catalog> {
  installNodeShims();
  const log = opts.log ?? ((l: string) => console.log(l));
  const assetsRoot = path.resolve(opts.assetsRoot);
  const sourceRoot = path.resolve(opts.sourceRoot ?? path.join(assetsRoot, "models", "3d"));
  const catalogPath = path.join(assetsRoot, "catalog.json");
  const previous = readCatalog(catalogPath);
  const previousById = new Map(
    previous?.converterVersion === CONVERTER_VERSION ? previous.models.map((m) => [m.id, m]) : [],
  );

  const catalog: Catalog = { converterVersion: CONVERTER_VERSION, packs: [], models: [], diagnostics: [] };

  // FBXLoader chatters about every unsupported FBX feature; count instead.
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => void warnings++;
  try {
    for (const pack of discoverPacks(sourceRoot)) {
      if (opts.only && pack.slug !== opts.only) continue;
      const texOut = path.join(assetsRoot, "textures", pack.slug);
      fs.mkdirSync(texOut, { recursive: true });

      // Copy the pack's atlases (a few dozen files per pack); TGA and PSD
      // ones, which browsers can't load, become PNG.
      const available = new Set<string>();
      const outByName = new Map<string, string>();
      let texCount = 0;
      let texConverted = 0;
      for (const [key, src] of pack.textures) {
        const web = WEB_TEXTURE.test(src);
        const dst = path.join(texOut, web ? path.basename(src) : `${path.basename(src, path.extname(src))}.png`);
        try {
          if (opts.force || !isFresh(dst, src)) {
            if (web) fs.copyFileSync(src, dst);
            else {
              fs.writeFileSync(dst, toPng(src, new Uint8Array(fs.readFileSync(src))));
              texConverted++;
            }
          }
        } catch (err) {
          catalog.diagnostics.push(`${pack.slug}: atlas ${posix(path.relative(pack.dir, src))} couldn't be made web-loadable: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        available.add(key);
        outByName.set(key, dst);
        texCount++;
      }
      if (texConverted > 0) log(`[convert]   ${pack.slug}: ${texConverted} TGA/PSD atlas(es) converted to PNG`);
      const textureFile = (name: string): string | null => outByName.get(name.toLowerCase()) ?? null;
      const textureCache = new Map<string, string | null>();

      let converted = 0;
      let reused = 0;
      const seen = new Set<string>();
      const files = opts.limit ? pack.fbx.slice(0, opts.limit) : pack.fbx;
      log(`[convert] ${pack.slug}: ${files.length} FBX -> GLB`);
      // One unit decision per source folder, logged so it can be checked.
      const unitByDir = new Map<string, "cm" | "m">();
      const byDir = new Map<string, string[]>();
      for (const f of files) byDir.set(path.dirname(f), [...(byDir.get(path.dirname(f)) ?? []), f]);
      for (const [dir, group] of byDir) {
        const { unit, medianCm } = detectUnit(group);
        unitByDir.set(dir, unit);
        if (unit === "m") {
          log(`[convert]   ${posix(path.relative(pack.dir, dir))}: median model ${medianCm.toFixed(1)} "cm" -> authored in metres, not scaled`);
        }
      }
      for (const file of files) {
        const name = path.basename(file, path.extname(file));
        const id = `${pack.slug}/${name}`;
        if (seen.has(id)) {
          catalog.diagnostics.push(`${id}: duplicate name, kept the first (${posix(path.relative(pack.dir, file))} skipped)`);
          continue;
        }
        seen.add(id);
        const prefab = pack.materials.get(name);
        const prev = previousById.get(id);
        let entry: CatalogModel;
        const unit = unitByDir.get(path.dirname(file)) ?? "cm";
        if (!opts.force && prev && prev.unit === unit && isFresh(path.join(assetsRoot, prev.file), file)) {
          if (prev.meshes === 0) {
            catalog.diagnostics.push(`${id}: no geometry in the FBX, skipped`);
            continue;
          }
          entry = prev;
          reused++;
        } else {
          // Every GLB sits at models/glb/<pack>/<category>/, so atlas URIs
          // are the same for any category (decided after loading the FBX).
          const glbDir = path.join(assetsRoot, "models", "glb", pack.slug, "_");
          const notes: string[] = [];
          const uriFor = (texture: string): string | null => {
            if (!textureCache.has(texture)) textureCache.set(texture, textureFile(texture));
            const abs = textureCache.get(texture) ?? null;
            if (!abs) {
              const note = `atlas "${texture}" has no image in the pack's Textures folders (.png/.jpg/.webp/.tga/.psd)`;
              if (!available.has(texture.toLowerCase()) && !notes.includes(note)) notes.push(note);
              return null;
            }
            return posix(path.relative(glbDir, abs));
          };
          try {
            const r = await convertOne(file, prefab, pack.meshIndex, uriFor, pack.defaultTexture, unit);
            if (r.stats.meshes === 0) {
              // DCC leftovers (locators, empty groups): nothing to render.
              catalog.diagnostics.push(`${id}: no geometry in the FBX, skipped`);
              continue;
            }
            const relDir = path.basename(path.dirname(file));
            const category = safeSegment(
              r.folder ?? (/^(fbx|source_?files)$/i.test(relDir) ? "Uncategorized" : relDir),
            );
            const out = path.join(assetsRoot, "models", "glb", pack.slug, category, `${name}.glb`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, r.glb);
            if (r.folder === null) notes.push("no prefab or mesh match in the pack's material list (used the default atlas)");
            entry = { id, pack: pack.slug, name, category, file: posix(path.relative(assetsRoot, out)), ...r.stats, notes };
            converted++;
            if (converted % 100 === 0) log(`[convert]   ${pack.slug}: ${converted} converted…`);
          } catch (err) {
            catalog.diagnostics.push(`${id}: conversion failed: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
        for (const note of entry.notes) catalog.diagnostics.push(`${id}: ${note}`);
        catalog.models.push(entry);
      }
      catalog.packs.push({ slug: pack.slug, source: posix(path.relative(assetsRoot, pack.dir)), models: converted + reused, textures: texCount });
      log(`[convert] ${pack.slug}: ${converted} converted, ${reused} unchanged, ${texCount} textures`);
    }
  } finally {
    console.warn = warn;
  }

  // --only converts one pack: keep every other pack from the last run.
  if (opts.only && previous?.converterVersion === CONVERTER_VERSION) {
    catalog.packs.unshift(...previous.packs.filter((p) => p.slug !== opts.only));
    catalog.models.unshift(...previous.models.filter((m) => m.pack !== opts.only));
  }
  // Imported GLB packs have no FBX source: keep them whatever this run converted.
  if (previous) {
    for (const p of previous.packs.filter((p) => p.imported && !catalog.packs.some((c) => c.slug === p.slug))) {
      catalog.packs.push(p);
      catalog.models.push(...previous.models.filter((m) => m.pack === p.slug));
    }
  }
  // The manifest is derived from the catalog, so the two never disagree.
  const manifest: AssetManifest = {
    name: "converted-packs",
    version: `${CONVERTER_VERSION}.0.0`,
    models: catalog.models.map((m) => ({ id: m.id, file: m.file })),
    textures: catalog.packs.flatMap((p) => {
      const dir = path.join(assetsRoot, "textures", p.slug);
      return fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => WEB_TEXTURE.test(f)).map((f) => ({
            id: `${p.slug}/${path.basename(f, path.extname(f))}`,
            file: posix(path.relative(assetsRoot, path.join(dir, f))),
          }))
        : [];
    }),
  };
  // Never write a manifest the editor/client would reject.
  ManifestSchema.parse(manifest);

  // A full run owns the pack GLBs: drop those no model maps to any more (a
  // model that changed category, a duplicate now won by another file).
  if (!opts.only && !opts.limit) {
    const glbRoot = path.join(assetsRoot, "models", "glb");
    const keep = new Set(catalog.models.map((m) => path.join(assetsRoot, m.file)));
    let removed = 0;
    if (fs.existsSync(glbRoot)) {
      for (const f of staleGlbs(glbRoot, keep)) {
        fs.rmSync(f);
        removed++;
      }
    }
    if (removed > 0) log(`[convert] removed ${removed} stale GLB(s)`);
  }
  fs.writeFileSync(path.join(assetsRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  log(`[convert] done: ${catalog.models.length} models, ${manifest.textures.length} textures, ` +
    `${catalog.diagnostics.length} diagnostic(s), ${warnings} FBX loader warning(s) -> assets/catalog.json`);
  return catalog;
}

/** Output exists and is at least as new as its source. */
function isFresh(out: string, src: string): boolean {
  try {
    return fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs;
  } catch {
    return false;
  }
}

function readCatalog(file: string): Catalog | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Catalog;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- CLI

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // dist/src/convert/convert-packs.js -> repo root/assets
  const defaultAssets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../assets");
  convertPacks({
    assetsRoot: flag("--assets") ?? defaultAssets,
    sourceRoot: flag("--source"),
    force: args.includes("--force"),
    only: flag("--only"),
    limit: flag("--limit") ? Number(flag("--limit")) : undefined,
  }).catch((err: unknown) => {
    console.error(`[convert] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
