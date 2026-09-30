/**
 * SyntyProps — scenery models from the converted art packs, for
 * InstancedProps. A prop's AssetRef hash is fnv1a32 of its manifest id
 * (see @mmo-engine/scatter); when that id is a converted pack model, the
 * prop shows it: the GLB merged into one geometry (the converter already
 * scaled each file to metres at its root node), drawn with the pack's own
 * materials — shared between models, so a whole forest is a handful of
 * materials.
 *
 * The first ask for a model starts its load and answers null (the prop is
 * a placeholder meanwhile); `onChange` fires when it is ready. The packs'
 * atlases are big (4096²) and every model names one: each atlas is loaded
 * once and shared, never once per model file. The art is
 * served by the dev server from the ignored assets/ folder; without it the
 * catalog is missing and every prop stays as it was.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PropModels } from "./instanced-props.js";

export const DEFAULT_ART_URL = "/assets/";

// A 1x1 PNG: model files name their atlas, but SyntyProps loads each atlas once itself.
const BLANK_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

/** FNV-1a 32-bit, as @mmo-engine/scatter hashes asset ids (AssetRef.assetHash). */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface CatalogModel {
  id: string;
  file: string;
  unit: "cm" | "m";
  skinned: boolean;
}

interface Ready {
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}

export class SyntyProps implements PropModels {
  private catalog: Map<number, CatalogModel> | null = null;
  private listing: Promise<void> | null = null;
  private readonly ready = new Map<number, Ready>();
  private readonly pending = new Set<number>();
  private readonly failed = new Set<number>();
  /** Materials by name: models of one pack share its atlas materials. */
  private readonly materials = new Map<string, THREE.Material>();
  /** Atlases by URL, loaded once. */
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly loader: GLTFLoader;
  private disposed = false;

  constructor(
    private readonly onChange: () => void,
    private readonly baseUrl = DEFAULT_ART_URL,
  ) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => (/\.(png|jpe?g|webp)$/i.test(url) ? BLANK_PNG : url));
    this.loader = new GLTFLoader(manager);
  }

  /** Models ready. */
  get size(): number {
    return this.ready.size;
  }

  model(assetHash: number, _variant: number): Ready | null {
    if (!this.catalog) {
      this.list();
      return null;
    }
    const ready = this.ready.get(assetHash);
    if (ready) return ready;
    const entry = this.catalog.get(assetHash);
    if (entry && !this.pending.has(assetHash) && !this.failed.has(assetHash)) this.load(assetHash, entry);
    return null;
  }

  private list(): void {
    this.listing ??= fetch(`${this.baseUrl}catalog.json`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as { models: CatalogModel[] };
        this.catalog = new Map(body.models.filter((m) => !m.skinned).map((m) => [fnv1a32(m.id), m]));
        if (!this.disposed) this.onChange(); // props waiting on the catalog can ask again
      })
      .catch((e: unknown) => {
        this.catalog = new Map(); // no art here: every prop stays as it is
        console.info(`[props] no art pack catalog (${e instanceof Error ? e.message : e}): scenery stays placeholder`);
      });
  }

  private load(hash: number, entry: CatalogModel): void {
    this.pending.add(hash);
    const url = new URL(`${this.baseUrl}${entry.file}`, location.href).href;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const bytes = await res.arrayBuffer();
        const atlases = atlasUrls(bytes, url);
        const gltf = await this.loader.parseAsync(bytes, url.slice(0, url.lastIndexOf("/") + 1));
        if (this.disposed) return;
        this.ready.set(hash, this.merge(entry, gltf.scene, atlases));
        this.onChange();
      })
      .catch((e: unknown) => {
        this.failed.add(hash);
        console.warn(`[props] ${entry.id}: ${e instanceof Error ? e.message : e}`);
      })
      .finally(() => this.pending.delete(hash));
  }

  /** The model's meshes baked into one geometry (a group per material), in metres. */
  private merge(entry: CatalogModel, scene: THREE.Object3D, atlases: Map<string, string>): Ready {

    scene.updateMatrixWorld(true);
    const parts: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // matrixWorld includes the file's root scale (centimetre packs: 0.01).
      const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      // One part per material group (most models have one).
      const groups = g.groups.length > 0 ? g.groups : [{ start: 0, count: g.index ? g.index.count : g.attributes.position.count, materialIndex: 0 }];
      for (const grp of groups) {
        const part = groups.length === 1 ? g : subset(g, grp.start, grp.count);
        part.clearGroups();
        parts.push(stripTo(part, ["position", "normal", "uv"]));
        materials.push(this.shared(mats[grp.materialIndex ?? 0] ?? mats[0], atlases, entry.id));
      }
    });
    const geometry = mergeGeometries(parts, true);
    if (!geometry) throw new Error("meshes don't merge");
    geometry.computeBoundingSphere();
    return { key: `synty:${entry.id}`, geometry, material: materials.length === 1 ? materials[0] : materials };
  }

  private shared(m: THREE.Material, atlases: Map<string, string>, modelId: string): THREE.Material {
    const url = atlases.get(m.name) ?? null;
    // Shared by atlas and name: packs can reuse a material name for different atlases.
    // A material without an external atlas (a texture embedded in the file) stays the model's own.
    const key = sharedMaterialKey(m.name, url, modelId);
    const known = this.materials.get(key);
    if (known) return known;
    prepareMaterial(m, url, (u) => this.texture(u));
    this.materials.set(key, m);
    return m;
  }

  private texture(url: string): THREE.Texture {
    let t = this.textures.get(url);
    if (!t) {
      t = this.textureLoader.load(
        url,
        () => this.onChange(),
        undefined,
        () => console.warn(`[props] atlas failed to load: ${url} (the models using it stay untextured)`),
      );
      t.flipY = false; // glTF UVs
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.textures.set(url, t);
    }
    return t;
  }

  dispose(): void {
    this.disposed = true;
    for (const r of this.ready.values()) r.geometry.dispose();
    this.ready.clear();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
  }
}

/** Where a prop material is shared: by atlas and name, or (embedded texture, no atlas) per model. */
export function sharedMaterialKey(name: string, atlasUrl: string | null, modelId: string): string {
  return atlasUrl ? `${atlasUrl}|${name}` : `${modelId}|${name}`;
}

/**
 * Ready a model's material for the merged, instanced prop:
 * - its atlas: the shared one when the file names an external atlas (the
 *   file's own map is only a blank stand-in then); otherwise the file's
 *   embedded texture is kept, never dropped
 * - no vertex colours: the merge keeps position, normal and uv only, and a
 *   material still asking for colours would read the missing attribute as
 *   black
 * - matte, as the packs are painted
 */
export function prepareMaterial(m: THREE.Material, atlasUrl: string | null, texture: (url: string) => THREE.Texture): void {
  const std = m as THREE.MeshStandardMaterial;
  std.vertexColors = false;
  if ("roughness" in std) {
    std.roughness = 0.9;
    std.metalness = 0;
    if (atlasUrl) {
      std.map?.dispose();
      std.map = texture(atlasUrl);
    }
    // A textured material shows its atlas unmodified.
    if (std.map) std.color.set(0xffffff);
  }
  std.needsUpdate = true;
}

/** Material name → absolute atlas URL, read from a GLB's own JSON chunk. */
function atlasUrls(glb: ArrayBuffer, fileUrl: string): Map<string, string> {
  const out = new Map<string, string>();
  const view = new DataView(glb);
  if (view.getUint32(0, true) !== 0x46546c67) return out; // "glTF"
  const len = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, len))) as {
    materials?: Array<{ name?: string; pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }>;
    textures?: Array<{ source?: number }>;
    images?: Array<{ uri?: string }>;
  };
  for (const m of json.materials ?? []) {
    const tex = m.pbrMetallicRoughness?.baseColorTexture?.index;
    const img = tex === undefined ? undefined : json.textures?.[tex]?.source;
    const uri = img === undefined ? undefined : json.images?.[img]?.uri;
    if (m.name && uri && !uri.startsWith("data:")) out.set(m.name, new URL(uri, fileUrl).href);
  }
  return out;
}

/** A draw range of an indexed geometry as its own geometry. */
function subset(g: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = g.clone();
  if (g.index) out.setIndex(Array.from(g.index.array.slice(start, start + count)));
  return out;
}

/** Keep only the attributes the merge needs (every part must carry the same ones). */
function stripTo(g: THREE.BufferGeometry, keep: string[]): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
  return g;
}

/** The first source with a model for the prop wins (the art packs, then PICG). */
export class ChainedPropModels implements PropModels {
  constructor(private readonly sources: PropModels[]) {}

  model(assetHash: number, variant: number): ReturnType<PropModels["model"]> {
    for (const s of this.sources) {
      const m = s.model(assetHash, variant);
      if (m) return m;
    }
    return null;
  }
}
