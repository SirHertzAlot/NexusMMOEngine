/**
 * CharacterStage — a small lit scene showing one modular character, with
 * orbit and zoom: the viewport of character creation (and the dev
 * preview). The character stands at the origin, facing the camera, idling
 * when the animation library is there.
 *
 * The editor's Animation panel (EA21) reuses it to preview clips: with the
 * licensed kit installed it shows a real character, without it a procedural
 * stand-in rig (`createStandIn`), and `drive` plays the server's clip plan
 * on either — the same animator the game uses.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildStandIn, buildStandInClips, standInClipInfo, type CharacterLook, type ClipPlan } from "@mmo-engine/art/browser";
import { CharacterKit, type ModularCharacter } from "./character-kit.js";
import { AnimationLibrary, CharacterAnimator } from "./character-animator.js";

const STILL = { speed: 0, vy: 0, mode: 0 };

export class CharacterStage {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private character: ModularCharacter | null = null;
  /** A model that is not a kit character (the stand-in rig). */
  private model: THREE.Object3D | null = null;
  private _animator: CharacterAnimator | null = null;
  private driver: (() => ClipPlan | null) | null = null;
  /** Hold the pose (the preview's pause). */
  paused = false;
  private readonly clock = new THREE.Clock();
  private disposed = false;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly _kit: CharacterKit | null,
    /** The stage loaded the kit itself, so it releases it. */
    private readonly ownsKit: boolean,
    /** Clips to animate the character with (null: it stands still). */
    readonly animations: AnimationLibrary | null,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x1b2130);
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3028, 1.3));
    const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
    key.position.set(1.5, 3, 2.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb8ff, 1.2);
    rim.position.set(-2, 2, -2);
    this.scene.add(rim);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x2a3244, roughness: 1 }),
    );
    this.scene.add(floor);

    this.camera.position.set(0, 1.4, 3.6);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 1.0, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 6;
    this.controls.maxPolarAngle = Math.PI * 0.55;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      const dt = Math.min(0.1, this.clock.getDelta());
      this.animator?.update(this.paused ? 0 : dt, STILL, this.driver?.() ?? null);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  static async create(canvas: HTMLCanvasElement, kit?: CharacterKit, opts: { referenceClips?: boolean } = {}): Promise<CharacterStage> {
    const animations = AnimationLibrary.load(undefined, { reference: opts.referenceClips }).catch((e: unknown) => {
      console.info(`[character] no animations: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    return kit
      ? new CharacterStage(canvas, kit, false, await animations)
      : new CharacterStage(canvas, await CharacterKit.load(), true, await animations);
  }

  /** A stage with no kit: the procedural stand-in rig and clips (no art installed). */
  static createStandIn(canvas: HTMLCanvasElement): CharacterStage {
    const clips = buildStandInClips();
    const stage = new CharacterStage(canvas, null, false, AnimationLibrary.of(clips, standInClipInfo(clips)));
    const { root } = buildStandIn();
    stage.showModel(root);
    return stage;
  }

  /** The kit this stage builds characters from (a stand-in stage has none). */
  get kit(): CharacterKit {
    if (!this._kit) throw new Error("character stage: this stage has no kit (it shows the stand-in rig)");
    return this._kit;
  }

  get hasKit(): boolean {
    return this._kit !== null;
  }

  /** The animator of the character on show (null until one is). */
  get animator(): CharacterAnimator | null {
    return this._animator;
  }

  /** Show a rigged model that is not a kit character; the animator drives its bones. */
  showModel(root: THREE.Object3D): void {
    this.model = root;
    this.scene.add(root);
    if (this.animations) this._animator = new CharacterAnimator(root, this.animations);
  }

  /** Play what `plan` says each frame (the server's clip, EA21); null removes the driver. */
  drive(plan: (() => ClipPlan | null) | null): void {
    this.driver = plan;
  }

  /** Show `look` (the first call builds the character; later calls restyle it). */
  async show(look: CharacterLook): Promise<ModularCharacter> {
    if (!this.character) {
      const character = await this.kit.build(look);
      if (this.disposed) {
        character.dispose();
        throw new Error("character stage: disposed");
      }
      character.relaxArms();
      this.character = character;
      this.scene.add(character.root);
      if (this.animations) this._animator = new CharacterAnimator(character.root, this.animations);
    } else {
      await this.character.setLook(look);
    }
    return this.character;
  }

  /** Play a clip over the idle, repeating (dev preview); null goes back to idling. */
  playClip(name: string | null): void {
    if (!this._animator) return;
    if (name === null) this._animator.stop();
    else this._animator.play(name, { loop: true });
  }

  /** Frame the head (closer) or the whole body. */
  focus(on: "body" | "head"): void {
    if (on === "head") {
      this.controls.target.set(0, 1.7, 0);
      this.camera.position.set(0, 1.74, 1.5);
    } else {
      this.controls.target.set(0, 1.0, 0);
      this.camera.position.set(0, 1.4, 3.6);
    }
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this._animator?.dispose();
    this._animator = null;
    this.character?.dispose();
    this.character = null;
    this.model?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    });
    this.model = null;
    if (this.ownsKit) this._kit?.dispose();
    this.renderer.dispose();
  }
}
