/**
 * Import ready-made GLB packs (Poly Pizza style: a folder of .glb files and
 * a `manifest.json` of { title, publicID, licence, file?, page }) into the
 * art catalog and manifest, next to the converted FBX packs.
 *
 *   npm run import:glb -w @mmo-engine/art -- <extracted-pack-dir>... [--assets <dir>]
 *
 * Unzip each pack first (a zip is untrusted input; the importer only reads
 * a folder). Per pack it copies the GLBs to
 * `<assets>/models/glb/<slug>/<Category>/`, measures each (bounds in metres,
 * triangles, skin and animation counts), and merges them into
 * `<assets>/catalog.json` and `manifest.json` with the licence data from the
 * pack's manifest. Re-running replaces that pack's entries. Everything stays
 * under assets/ (gitignored, licensed art); nothing here names a model.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { ManifestSchema, type AssetManifest } from "../manifest.js";
import { readGlbJson, writeGlb } from "./glb-textures.js";
import { naturalSizeM } from "./natural-size.js";
import { CONVERTER_VERSION, type Catalog, type CatalogModel } from "./convert-packs.js";

/** One entry of a Poly Pizza pack manifest. */
export interface PackEntry {
  title: string;
  publicID: string;
  licence?: string;
  file?: string;
  page?: string;
}

/** "poly-pizza-farm-animals" -> "farm-animals". */
export function importSlug(folder: string): string {
  return folder.replace(/^poly-pizza-/i, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

/** The GLB of an entry: its `file`, else the one named `<Title>_<publicID>.glb` (some packs omit `file`). */
export function entryFile(e: PackEntry, glbs: readonly string[]): string | undefined {
  if (e.file && glbs.includes(e.file)) return e.file;
  return glbs.find((g) => g.endsWith(`_${e.publicID}.glb`));
}

export interface GlbStats {
  size: [number, number, number];
  /** Box corners before any fitting. */
  min: [number, number, number];
  max: [number, number, number];
  triangles: number;
  meshes: number;
  skinned: boolean;
  bones: number;
  animations: number;
  materials: string[];
}

type Acc = { count?: number; min?: number[]; max?: number[] };
type Node = { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] };

/** Bounds (node transforms applied), triangle count, rig and animation counts from a GLB's JSON; no geometry is decoded. */
export function glbStats(glb: Uint8Array): GlbStats {
  const { json } = readGlbJson(glb);
  const g = json as { nodes?: Node[]; meshes?: Array<{ primitives: Array<{ attributes: { POSITION?: number }; indices?: number }> }>; accessors?: Acc[]; scene?: number; scenes?: Array<{ nodes?: number[] }>; skins?: Array<{ joints: number[] }>; animations?: unknown[]; materials?: Array<{ name?: string }> };
  const nodes = g.nodes ?? [];
  const acc = g.accessors ?? [];
  const box = new THREE.Box3();
  let triangles = 0;
  let meshes = 0;
  const visit = (i: number, parent: THREE.Matrix4): void => {
    const n = nodes[i];
    if (!n) return;
    const local = new THREE.Matrix4();
    if (n.matrix) local.fromArray(n.matrix);
    else local.compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
    const world = parent.clone().multiply(local);
    if (n.mesh !== undefined) {
      meshes++;
      for (const p of g.meshes?.[n.mesh]?.primitives ?? []) {
        const pos = acc[p.attributes.POSITION ?? -1];
        if (pos?.min && pos.max) box.union(new THREE.Box3(new THREE.Vector3(...(pos.min as [number, number, number])), new THREE.Vector3(...(pos.max as [number, number, number]))).applyMatrix4(world));
        triangles += Math.floor(((p.indices !== undefined ? acc[p.indices]?.count : pos?.count) ?? 0) / 3);
      }
    }
    for (const c of n.children ?? []) visit(c, world);
  };
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  for (const r of roots) visit(r, new THREE.Matrix4());
  const s = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    size: [r3(s.x), r3(s.y), r3(s.z)],
    min: box.isEmpty() ? [0, 0, 0] : [box.min.x, box.min.y, box.min.z],
    max: box.isEmpty() ? [0, 0, 0] : [box.max.x, box.max.y, box.max.z],
    triangles,
    meshes,
    skinned: (g.skins?.length ?? 0) > 0,
    bones: (g.skins ?? []).reduce((a, k) => a + k.joints.length, 0),
    animations: g.animations?.length ?? 0,
    materials: (g.materials ?? []).map((m) => m.name ?? ""),
  };
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "Model";

/**
 * The GLB with its scene wrapped in one node that scales it so the longest side is `targetM` and sets it
 * down with its base centre at the origin. Only the node list changes; geometry and textures are untouched.
 */
export function fitGlb(glb: Uint8Array, st: GlbStats, targetM: number): { glb: Uint8Array; size: [number, number, number] } {
  const maxDim = Math.max(...st.size);
  if (!(maxDim > 0)) return { glb, size: st.size };
  const k = targetM / maxDim;
  const { json, bin } = readGlbJson(glb);
  const g = json as unknown as { nodes?: unknown[]; scene?: number; scenes?: Array<{ nodes?: number[] }> };
  const nodes = (g.nodes ??= []);
  const scene = (g.scenes ??= [{}])[g.scene ?? 0]!;
  const roots = scene.nodes ?? nodes.map((_, i) => i);
  nodes.push({ name: "fit", children: roots, scale: [k, k, k], translation: [-((st.min[0] + st.max[0]) / 2) * k, -st.min[1] * k, -((st.min[2] + st.max[2]) / 2) * k] });
  scene.nodes = [nodes.length - 1];
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  return { glb: writeGlb(json as Parameters<typeof writeGlb>[0], bin), size: [r3(st.size[0] * k), r3(st.size[1] * k), r3(st.size[2] * k)] };
}

export interface ImportOptions {
  assetsRoot: string;
  /** Extracted pack folders (each with a manifest.json and its .glb files). */
  packDirs: string[];
  log?: (line: string) => void;
}

export interface ImportSummary {
  slug: string;
  models: number;
  skinned: number;
  animated: number;
  licences: Record<string, number>;
}

export function importGlbPacks(opts: ImportOptions): ImportSummary[] {
  const log = opts.log ?? ((l: string) => console.log(l));
  const assets = path.resolve(opts.assetsRoot);
  const catalogPath = path.join(assets, "catalog.json");
  const catalog: Catalog = fs.existsSync(catalogPath)
    ? (JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Catalog)
    : { converterVersion: CONVERTER_VERSION, packs: [], models: [], diagnostics: [] };
  const summaries: ImportSummary[] = [];

  for (const dir of opts.packDirs) {
    const slug = importSlug(path.basename(path.resolve(dir)));
    const entries = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as PackEntry[];
    const glbs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".glb"));
    catalog.models = catalog.models.filter((m) => m.pack !== slug);
    catalog.packs = catalog.packs.filter((p) => p.slug !== slug);
    fs.rmSync(path.join(assets, "models", "glb", slug), { recursive: true, force: true });
    const category = slug.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("_");
    const seen = new Set<string>();
    const sum: ImportSummary = { slug, models: 0, skinned: 0, animated: 0, licences: {} };
    for (const e of entries) {
      const f = entryFile(e, glbs);
      if (!f) { catalog.diagnostics.push(`${slug}: "${e.title}" (${e.publicID}) has no GLB in the pack, skipped`); continue; }
      const name = safe(e.title);
      const stem = safe(path.basename(f, ".glb"));
      const id = `${slug}/${stem}`;
      if (seen.has(id)) continue;
      seen.add(id);
      let bytes: Uint8Array = new Uint8Array(fs.readFileSync(path.join(dir, f)));
      let st: GlbStats;
      try { st = glbStats(bytes); } catch (err) { catalog.diagnostics.push(`${id}: unreadable GLB, skipped (${err instanceof Error ? err.message : String(err)})`); continue; }
      const target = naturalSizeM(slug, name);
      if (target) { const fit = fitGlb(bytes, st, target); bytes = fit.glb; st = { ...st, size: fit.size }; }
      else catalog.diagnostics.push(`${id}: no natural size known, left in the pack's own units`);
      const rel = `models/glb/${slug}/${category}/${stem}.glb`;
      fs.mkdirSync(path.dirname(path.join(assets, rel)), { recursive: true });
      fs.writeFileSync(path.join(assets, rel), bytes);
      const licence = e.licence ?? null;
      const model: CatalogModel = {
        id, pack: slug, name, category, file: rel, skinned: st.skinned, bones: st.bones, meshes: st.meshes, triangles: st.triangles,
        size: st.size, materials: st.materials.map((n) => ({ name: n, texture: null })), unit: "m", notes: [],
        animations: st.animations, license: { author: "Poly by Google", name: licence, page: e.page ?? null },
      };
      catalog.models.push(model);
      sum.models++;
      if (st.skinned) sum.skinned++;
      if (st.animations > 0) sum.animated++;
      sum.licences[licence ?? "unstated"] = (sum.licences[licence ?? "unstated"] ?? 0) + 1;
    }
    catalog.packs.push({ slug, source: `imports/${slug}`, models: sum.models, textures: 0, imported: true });
    summaries.push(sum);
    log(`[import] ${slug}: ${sum.models} models (${sum.skinned} skinned, ${sum.animated} animated)`);
  }

  const manifestPath = path.join(assets, "manifest.json");
  const old = fs.existsSync(manifestPath) ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as AssetManifest) : null;
  const importedModels = catalog.models.filter((m) => packsImported(catalog, m.pack));
  const imported = new Set(importedModels.map((m) => m.id));
  const manifest: AssetManifest = {
    name: "converted-packs",
    version: old?.version ?? `${CONVERTER_VERSION}.0.0`,
    models: [...(old?.models ?? []).filter((m) => !imported.has(m.id)), ...importedModels.map((m) => ({ id: m.id, file: m.file }))],
    textures: old?.textures ?? [],
  };
  ManifestSchema.parse(manifest);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  return summaries;
}

const packsImported = (c: Catalog, slug: string): boolean => c.packs.some((p) => p.slug === slug && p.imported);

// ------------------------------------------------------------------- CLI

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const ai = args.indexOf("--assets");
  const defaultAssets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../assets");
  const assetsRoot = ai >= 0 ? args[ai + 1]! : defaultAssets;
  const dirs = args.filter((a, i) => a !== "--assets" && args[i - 1] !== "--assets");
  if (dirs.length === 0) { console.error("usage: import:glb <extracted-pack-dir>... [--assets <dir>]"); process.exit(1); }
  importGlbPacks({ assetsRoot, packDirs: dirs });
}
