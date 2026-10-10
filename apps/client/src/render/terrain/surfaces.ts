/**
 * Terrain surfaces: photo-scanned CC0 ground materials (grass, forest
 * floor, sand, mud, rock, snow…) the terrain shader blends by biome.
 *
 * `npm run surfaces:fetch` puts them in public/surfaces/ (never committed:
 * see scripts/fetch-surfaces.mjs). Each is a zlib-deflated file of RGBA8
 * levels — colour (sRGB) with height in alpha, then normal.xy (OpenGL
 * convention), roughness and ambient occlusion — at `resolution`, full
 * mip chain; only the top level is used here and the GPU makes the mips.
 * Without the files, loadSurfaces() answers null and the terrain keeps its
 * flat biome colours.
 */

import * as THREE from "three";
import type { WorldMap } from "@mmo-engine/protocol";

/** How many layers the shader's tables hold. */
export const MAX_SURFACE_LAYERS = 16;

export interface SurfaceLayer {
  id: string;
  file: string;
  resolution: number;
  levels: number;
  /** How many metres one tile of the texture covers. */
  tileMetres: number;
  /** Linear albedo multiplier. */
  tint: [number, number, number];
}

export interface SurfaceManifest {
  version: 1;
  encoding: "deflate-rgba8-mips-v1";
  layers: SurfaceLayer[];
  /** Biome id -> layer id. */
  biomes: Record<string, string>;
  /** Layer ids for steep slopes and snow. */
  rock: string;
  snow: string;
}

export interface Surfaces {
  manifest: SurfaceManifest;
  /** sRGB colour + height, one layer per material. */
  albedo: THREE.DataArrayTexture;
  /** normal.xy, roughness, AO. */
  props: THREE.DataArrayTexture;
  dispose(): void;
}

/**
 * Per-layer overrides from content/materials/materials.json (by layer id):
 * the albedo tint and tile size replace the manifest's when it loads.
 */
let surfaceMaterials: Record<string, { tint: [number, number, number]; tileMetres?: number }> = {};
export function setSurfaceMaterials(surfaces: Record<string, { tint: [number, number, number]; tileMetres?: number }>): void {
  surfaceMaterials = surfaces;
}

/** The manifest with the content's tints and tile sizes laid over its layers. */
export function withSurfaceMaterials(m: SurfaceManifest): SurfaceManifest {
  return {
    ...m,
    layers: m.layers.map((l) => {
      const o = surfaceMaterials[l.id];
      return o ? { ...l, tint: o.tint, tileMetres: o.tileMetres ?? l.tileMetres } : l;
    }),
  };
}

/** Check a manifest's shape (it is data from disk; fail loudly on a bad one). */
export function parseSurfaceManifest(json: unknown): SurfaceManifest {
  const m = json as SurfaceManifest;
  if (!m || m.version !== 1 || m.encoding !== "deflate-rgba8-mips-v1") throw new Error("surfaces: unknown manifest version or encoding");
  if (!Array.isArray(m.layers) || m.layers.length === 0 || m.layers.length > MAX_SURFACE_LAYERS) {
    throw new Error(`surfaces: need 1..${MAX_SURFACE_LAYERS} layers`);
  }
  const res = m.layers[0].resolution;
  const ids = new Set(m.layers.map((l) => l.id));
  for (const l of m.layers) if (l.resolution !== res) throw new Error("surfaces: every layer needs the same resolution");
  for (const id of [m.rock, m.snow, ...Object.values(m.biomes)]) if (!ids.has(id)) throw new Error(`surfaces: no layer "${id}"`);
  return m;
}

/** The top level of an inflated .pbr: colour (+height) and props, `res`² RGBA8 each. */
export function pbrTopLevel(inflated: Uint8Array, res: number): { color: Uint8Array; props: Uint8Array } {
  const n = res * res * 4;
  if (inflated.length < 2 * n) throw new Error(`surfaces: .pbr too short for ${res}px (${inflated.length} bytes)`);
  return { color: inflated.subarray(0, n), props: inflated.subarray(n, 2 * n) };
}

async function inflate(bytes: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Two texture arrays from each layer's top level (layer order = manifest order). */
export function buildSurfaceTextures(levels: { color: Uint8Array; props: Uint8Array }[], res: number): Pick<Surfaces, "albedo" | "props"> {
  const n = res * res * 4;
  const color = new Uint8Array(n * levels.length);
  const props = new Uint8Array(n * levels.length);
  levels.forEach((l, i) => {
    color.set(l.color, i * n);
    props.set(l.props, i * n);
  });
  const make = (data: Uint8Array, colorSpace: THREE.ColorSpace): THREE.DataArrayTexture => {
    const t = new THREE.DataArrayTexture(data, res, res, levels.length);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = colorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: make(color, THREE.SRGBColorSpace), props: make(props, THREE.NoColorSpace) };
}

/**
 * Load the surfaces from `base` (the dev server and production build serve
 * public/ at the root). Null when they were never fetched.
 */
export async function loadSurfaces(base = "/surfaces"): Promise<Surfaces | null> {
  const res = await fetch(`${base}/manifest.json`).catch(() => null);
  // Not fetched: a 404, or a dev server's index page in its place.
  if (!res || !res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
  const manifest = withSurfaceMaterials(parseSurfaceManifest(await res.json()));
  const size = manifest.layers[0].resolution;
  const levels = await Promise.all(
    manifest.layers.map(async (l) => {
      const r = await fetch(`${base}/${l.file}`);
      if (!r.ok) throw new Error(`surfaces: ${l.file}: HTTP ${r.status}`);
      return pbrTopLevel(await inflate(await r.arrayBuffer()), size);
    }),
  );
  const { albedo, props } = buildSurfaceTextures(levels, size);
  return {
    manifest,
    albedo,
    props,
    dispose: () => {
      albedo.dispose();
      props.dispose();
    },
  };
}

/**
 * The surface layer of every map cell (R8, row-major like the map): its
 * biome's layer, rivers as the mud of the swamp/lake layer when there is one.
 */
export function surfaceLayerMap(map: WorldMap, manifest: SurfaceManifest): Uint8Array<ArrayBuffer> {
  const index = new Map(manifest.layers.map((l, i) => [l.id, i]));
  const fallback = index.get(manifest.biomes.plains ?? "") ?? 0;
  const byBiome = map.biomes.map((b) => index.get(manifest.biomes[b] ?? "") ?? fallback);
  const river = index.get(manifest.biomes.lake ?? manifest.biomes.swamp ?? "");
  const out = new Uint8Array(map.width * map.depth);
  for (let i = 0; i < out.length; i++) {
    out[i] = map.river[i] && river !== undefined ? river : byBiome[map.biome[i]] ?? fallback;
  }
  return out;
}
