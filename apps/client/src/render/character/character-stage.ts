/**
 * CharacterStage — a small lit scene showing one modular character, with
 * orbit and zoom: the viewport of character creation (and the dev
 * preview). The character stands at the origin, facing the camera.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CharacterLook } from "@mmo-engine/art/browser";
import { CharacterKit, type ModularCharacter } from "./character-kit.js";

export class CharacterStage {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private character: ModularCharacter | null = null;
  private disposed = false;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly kit: CharacterKit,
    /** The stage loaded the kit itself, so it releases it. */
    private readonly ownsKit: boolean,
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
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  static async create(canvas: HTMLCanvasElement, kit?: CharacterKit): Promise<CharacterStage> {
    return kit ? new CharacterStage(canvas, kit, false) : new CharacterStage(canvas, await CharacterKit.load(), true);
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
    } else {
      await this.character.setLook(look);
    }
    return this.character;
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
    this.character?.dispose();
    this.character = null;
    if (this.ownsKit) this.kit.dispose();
    this.renderer.dispose();
  }
}
