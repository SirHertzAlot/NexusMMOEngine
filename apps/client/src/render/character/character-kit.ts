/**
 * Modular characters in the client: the kit (rig, catalog, textures —
 * loaded once) and the characters built from it.
 *
 * A character is one copy of the rig with its parts' meshes bound to that
 * copy by bone name, so every part moves with one skeleton (one animation
 * mixer drives the whole character). Part files are fetched once and
 * shared: a character instance reuses their geometry and bind data.
 *
 * The art comes from <repo>/assets via the dev server (see
 * vite-local-assets); it is never bundled.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { effectiveColours, resolveLook, type CharacterLook, type RiggedCatalog } from "@mmo-engine/art/browser";
import { CharacterMaterial, type CharacterTextures } from "./character-material.js";

export const DEFAULT_KIT_URL = "/assets/models/glb/modular-fantasy-hero/Rigged/";

// A 1x1 PNG: part files reference the atlas, but the kit loads it once itself.
const BLANK_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

interface PartTemplate {
  mesh: THREE.SkinnedMesh;
}

/**
 * The rig file's skeleton as real bones. GLTFLoader only makes Bones of
 * nodes a skin references, and the rig file has no skin: its nodes load
 * as plain objects. Everything below the scaled root node is a bone.
 */
function asBones(scene: THREE.Object3D): THREE.Object3D {
  const top = scene.children[0];
  if (!top) throw new Error("character kit: rig file is empty");
  const convert = (node: THREE.Object3D): THREE.Bone => {
    const bone = new THREE.Bone();
    bone.name = node.name;
    bone.position.copy(node.position);
    bone.quaternion.copy(node.quaternion);
    bone.scale.copy(node.scale);
    for (const child of node.children) bone.add(convert(child));
    return bone;
  };
  const root = new THREE.Group();
  root.name = top.name;
  root.position.copy(top.position);
  root.quaternion.copy(top.quaternion);
  root.scale.copy(top.scale); // the 0.01 centimetres-to-metres root
  for (const child of top.children) root.add(convert(child));
  return root;
}

export class CharacterKit {
  private readonly parts = new Map<string, Promise<PartTemplate>>();
  private readonly loader: GLTFLoader;

  private constructor(
    readonly baseUrl: string,
    readonly catalog: RiggedCatalog,
    private readonly rig: THREE.Object3D,
    readonly textures: CharacterTextures,
  ) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => (/\.(png|jpe?g|webp)$/i.test(url) ? BLANK_PNG : url));
    this.loader = new GLTFLoader(manager);
  }

  static async load(baseUrl = DEFAULT_KIT_URL): Promise<CharacterKit> {
    const res = await fetch(`${baseUrl}catalog.json`);
    if (!res.ok) throw new Error(`character kit: ${baseUrl}catalog.json (${res.status}) — run npm run convert:modular -w @mmo-engine/art`);
    const catalog = (await res.json()) as RiggedCatalog;
    const rig = asBones((await new GLTFLoader().loadAsync(`${baseUrl}${catalog.rig}`)).scene);
    const textureLoader = new THREE.TextureLoader();
    const load = async (rel: string, colour: boolean): Promise<THREE.Texture> => {
      const t = await textureLoader.loadAsync(new URL(rel, new URL(baseUrl, location.href)).href);
      t.flipY = false; // glTF UV convention, like the parts
      t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    };
    const [base, ...masks] = await Promise.all([
      load(catalog.textures.base, true),
      ...catalog.textures.masks.map((m) => load(m, false)),
    ]);
    return new CharacterKit(baseUrl, catalog, rig, { base, masks });
  }

  /** A part's template, fetched once. */
  private part(name: string): Promise<PartTemplate> {
    let p = this.parts.get(name);
    if (!p) {
      const file = this.catalog.files[name];
      if (!file) return Promise.reject(new Error(`character kit: no part ${name}`));
      p = this.loader.loadAsync(`${this.baseUrl}${file}`).then((gltf) => {
        let mesh: THREE.SkinnedMesh | null = null;
        gltf.scene.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
        });
        if (!mesh) throw new Error(`character kit: ${file} has no skinned mesh`);
        const m = mesh as THREE.SkinnedMesh;
        // The file's own material (a stand-in for the atlas) is never used.
        (m.material as THREE.MeshStandardMaterial).map?.dispose();
        (m.material as THREE.Material).dispose();
        return { mesh: m };
      });
      this.parts.set(name, p);
    }
    return p;
  }

  /** Fetch every part a look shows (e.g. before building several characters). */
  preload(look: CharacterLook): Promise<unknown> {
    return Promise.all(resolveLook(this.catalog, look).map((p) => this.part(p.name)));
  }

  /** A new character wearing `look`. */
  async build(look: CharacterLook): Promise<ModularCharacter> {
    const character = this.create(look);
    await character.setLook(look);
    return character;
  }

  /**
   * A new character at once (its root can go in the scene now); its parts
   * appear as they load. Load failures are reported, not thrown.
   */
  create(look: CharacterLook): ModularCharacter {
    const character = new ModularCharacter(this, this.rig.clone(true), new CharacterMaterial(this.textures, effectiveColours(look)));
    character.setLook(look).catch((e: unknown) => console.warn(`[character] ${e instanceof Error ? e.message : e}`));
    return character;
  }

  /** @internal a part's template for ModularCharacter. */
  templateOf(name: string): Promise<PartTemplate> {
    return this.part(name);
  }

  /** Release the textures and part geometry (after every character built from the kit is gone). */
  dispose(): void {
    this.textures.base.dispose();
    for (const m of this.textures.masks) m.dispose();
    for (const p of this.parts.values()) {
      p.then((t) => t.mesh.geometry.dispose()).catch(() => {});
    }
    this.parts.clear();
  }
}

export class ModularCharacter {
  /** Add this to the scene; place and rotate it like any object. */
  readonly root = new THREE.Group();
  readonly bones = new Map<string, THREE.Bone>();
  private readonly meshes = new Map<string, THREE.SkinnedMesh>();
  private look: CharacterLook | null = null;
  private generation = 0;

  constructor(
    private readonly kit: CharacterKit,
    private readonly rig: THREE.Object3D,
    readonly material: CharacterMaterial,
  ) {
    this.root.name = "character";
    this.root.add(rig);
    rig.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone);
    });
  }

  get currentLook(): CharacterLook | null {
    return this.look;
  }

  /** Show `look`: parts are swapped in place, colours updated. */
  async setLook(look: CharacterLook): Promise<void> {
    const generation = ++this.generation;
    this.look = look;
    this.material.setColours(effectiveColours(look));
    const wanted = resolveLook(this.kit.catalog, look).map((p) => p.name);
    const templates = await Promise.all(wanted.map((n) => this.kit.templateOf(n)));
    // A newer setLook started while these loaded: it wins.
    if (generation !== this.generation) return;
    const keep = new Set(wanted);
    for (const [name, mesh] of this.meshes) {
      if (keep.has(name)) continue;
      this.rig.remove(mesh);
      mesh.skeleton.dispose();
      this.meshes.delete(name);
    }
    wanted.forEach((name, i) => {
      if (this.meshes.has(name)) return;
      const template = templates[i].mesh;
      const mesh = new THREE.SkinnedMesh(template.geometry, this.material);
      mesh.name = name;
      mesh.position.copy(template.position);
      mesh.quaternion.copy(template.quaternion);
      mesh.scale.copy(template.scale);
      // Parts are bound in their own file to an identical copy of the rig:
      // same bone names, same rest pose, so their bind data carries over.
      const bones = template.skeleton.bones.map((b) => {
        const bone = this.bones.get(b.name);
        if (!bone) throw new Error(`character: ${name} needs bone ${b.name}`);
        return bone;
      });
      mesh.bind(new THREE.Skeleton(bones, template.skeleton.boneInverses), template.bindMatrix);
      mesh.frustumCulled = false; // skinned bounds don't follow the pose
      this.rig.add(mesh);
      this.meshes.set(name, mesh);
    });
  }

  /**
   * Lower the arms from the rig's T-pose to hang at the sides (the rest
   * pose until animation drives the skeleton). Call once, before the
   * character is placed or turned.
   */
  relaxArms(degrees = 72): void {
    this.root.updateMatrixWorld(true);
    const parent = new THREE.Quaternion();
    const turn = new THREE.Quaternion();
    for (const [side, sign] of [["L", -1], ["R", 1]] as const) {
      const shoulder = this.bones.get(`Shoulder_${side}`);
      if (!shoulder?.parent) continue;
      // The turn is about the body's forward axis, in the root's frame:
      // local' = parent^-1 * turn * parent * local.
      shoulder.parent.getWorldQuaternion(parent);
      turn.setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(degrees * sign));
      shoulder.quaternion.premultiply(parent.clone().invert().multiply(turn).multiply(parent));
    }
    this.root.updateMatrixWorld(true);
  }

  /** Part names on show (tests, UI). */
  get partNames(): string[] {
    return [...this.meshes.keys()];
  }

  dispose(): void {
    this.generation++;
    for (const mesh of this.meshes.values()) mesh.skeleton.dispose();
    this.meshes.clear();
    this.root.removeFromParent();
    this.material.dispose();
  }
}
