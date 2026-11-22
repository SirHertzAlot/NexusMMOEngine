/**
 * AnimalKit — loads, caches and instantiates rigged animal models with skeletal animations.
 */

import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { createGltfLoader } from "../gltf-loader.js";
import { AnimalAnimator } from "./animal-animator.js";
import { fnv1a32 } from "../synty-props.js";
import { applyShadingToMaterial } from "../shading/shading.js";

export interface CatalogModelEntry {
  id: string;
  file: string;
  skinned?: boolean;
}

interface LoadedTemplate {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

export class AnimalKit {
  private readonly loader: ReturnType<typeof createGltfLoader>;
  private readonly templates = new Map<number, LoadedTemplate>();
  private readonly pending = new Set<number>();
  private readonly failed = new Set<number>();
  private catalog: Map<number, CatalogModelEntry> | null = null;
  private listing: Promise<void> | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly baseUrl = "/assets/",
  ) {
    this.loader = createGltfLoader();
  }

  /** Initialize catalog if not already loaded. */
  list(): void {
    if (this.listing) return;
    this.listing = fetch(`${this.baseUrl}catalog.json`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
        const body = (await res.json()) as { models: CatalogModelEntry[] };
        this.catalog = new Map();
        for (const m of body.models) {
          // Track all models from quaternius-animals or those marked skinned
          if (m.skinned || m.id.startsWith("quaternius-animals/")) {
            this.catalog.set(fnv1a32(m.id), m);
          }
        }
        this.onChange();
      })
      .catch((e: unknown) => {
        console.warn(`[animal-kit] failed to load catalog (${e instanceof Error ? e.message : e})`);
        this.catalog = new Map();
      });
  }

  isAnimalModel(assetHash: number): boolean {
    if (!this.catalog) {
      this.list();
      return false;
    }
    return this.catalog.has(assetHash);
  }

  createInstance(assetHash: number): { root: THREE.Object3D; animator: AnimalAnimator } | null {
    if (!this.catalog) {
      this.list();
      return null;
    }

    const template = this.templates.get(assetHash);
    if (template) {
      const root = skeletonClone(template.scene);
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            applyShadingToMaterial(m, "model");
          }
        }
      });
      const entry = this.catalog.get(assetHash);
      const animator = new AnimalAnimator(root, template.animations, { modelId: entry?.id });
      return { root, animator };
    }

    if (!this.pending.has(assetHash) && !this.failed.has(assetHash)) {
      const entry = this.catalog.get(assetHash);
      if (entry) {
        this.load(assetHash, entry);
      }
    }

    return null;
  }

  private load(hash: number, entry: CatalogModelEntry): void {
    this.pending.add(hash);
    const url = new URL(`${this.baseUrl}${entry.file}`, location.href).href;

    this.loader
      .loadAsync(url)
      .then((gltf) => {
        this.templates.set(hash, {
          scene: gltf.scene,
          animations: gltf.animations,
        });
        this.onChange();
      })
      .catch((e: unknown) => {
        this.failed.add(hash);
        console.warn(`[animal-kit] failed to load ${entry.id}: ${e instanceof Error ? e.message : e}`);
      })
      .finally(() => {
        this.pending.delete(hash);
      });
  }

  dispose(): void {
    this.templates.clear();
    this.pending.clear();
    this.failed.clear();
  }
}
