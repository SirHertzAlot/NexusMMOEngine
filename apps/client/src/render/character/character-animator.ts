/**
 * Character animation: the retargeted clip library, and an animator per
 * character with two layers.
 *
 *  - Base: locomotion chosen from how the character moves (the server's
 *    velocity and locomotion mode) — idle, walk, jog, sprint, swimming,
 *    in the air — crossfaded, with playback scaled to the ground speed.
 *    Or, when the server sends an Animation row (EA21), the clip it names,
 *    at the rate it sets (see `update`'s plan).
 *  - Action: a clip over the base (an attack, a block, a hit), on the whole
 *    body or the upper body only (so the legs keep walking), faded in and
 *    out. It can start part-way through, to line up with the moment the
 *    server started it.
 *
 * Clips play in place; the server moves the character (see
 * AnimationClipInfo.travel). Nothing here decides gameplay.
 */

import * as THREE from "three";
import { createGltfLoader } from "../gltf-loader.js";
import { LocomotionMode } from "@mmo-engine/protocol";
import { crossfadeWeights, playhead, type AnimationClipInfo, type AnimationManifest, type ClipPlan } from "@mmo-engine/art/browser";
import { DEFAULT_KIT_URL } from "./character-kit.js";

export class AnimationLibrary {
  private constructor(
    readonly clips: ReadonlyMap<string, THREE.AnimationClip>,
    readonly info: ReadonlyMap<string, AnimationClipInfo>,
    readonly manifest: AnimationManifest,
  ) {}

  /**
   * The library next to the character kit (animations.json + a GLB per
   * source); reference takes only when asked for (the dev preview).
   */
  static async load(baseUrl = DEFAULT_KIT_URL, opts: { reference?: boolean } = {}): Promise<AnimationLibrary> {
    const res = await fetch(`${baseUrl}animations.json`);
    if (!res.ok) throw new Error(`animations: ${baseUrl}animations.json (${res.status}) — run npm run convert:animations -w @mmo-engine/art`);
    const manifest = (await res.json()) as AnimationManifest;
    if (manifest.version !== 2) throw new Error(`animations: manifest version ${manifest.version} — re-run convert:animations`);
    const loader = createGltfLoader();
    const sources = manifest.sources.filter((s) => opts.reference || !s.reference);
    const sets = await Promise.all(sources.map((s) => loader.loadAsync(`${baseUrl}${s.file}`)));
    return new AnimationLibrary(
      new Map(sets.flatMap((g) => g.animations).map((c) => [c.name, c])),
      new Map(manifest.clips.map((c) => [c.name, c])),
      manifest,
    );
  }

  static of(clips: THREE.AnimationClip[], info: AnimationClipInfo[] = []): AnimationLibrary {
    return new AnimationLibrary(
      new Map(clips.map((c) => [c.name, c])),
      new Map(info.map((c) => [c.name, c])),
      { version: 2, sources: [], clips: info },
    );
  }

  get names(): string[] {
    return [...this.clips.keys()];
  }
}

/** How a character is moving (from the server's rows). */
export interface Motion {
  /** Horizontal speed, m/s. */
  speed: number;
  /** Vertical velocity, m/s. */
  vy: number;
  /** LocomotionMode (ground, swim, fly). */
  mode: number;
}

interface Gait {
  clip: string;
  /** The clip's own ground speed (m/s): playback is scaled to the actual speed. */
  speed: number;
  /** Speeds from here up use this gait. */
  from: number;
}

// Tuned by eye against the retargeted clips.
const GROUND: Gait[] = [
  { clip: "Walk_Loop", speed: 1.4, from: 0.3 },
  { clip: "Jog_Fwd_Loop", speed: 3.6, from: 2.2 },
  { clip: "Sprint_Loop", speed: 6.2, from: 4.8 },
];
const SWIM: Gait[] = [{ clip: "Swim_Fwd_Loop", speed: 1.4, from: 0.3 }];
const FLY: Gait[] = [{ clip: "Swim_Fwd_Loop", speed: 6, from: 0.5 }];
const IDLE = { ground: "Idle_Loop", swim: "Swim_Idle_Loop", fly: "Swim_Idle_Loop", air: "Jump_Loop" };

/** Vertical speed that means the feet left the ground. */
const AIRBORNE_VY = 1.5;
/** Crossfade between base clips, seconds. */
const BASE_FADE = 0.2;

/** Bones of the upper body (spine up): an upper-body action leaves the legs to the base. */
function isUpperBody(bone: THREE.Object3D): boolean {
  for (let b: THREE.Object3D | null = bone; b; b = b.parent) if (b.name === "Spine_01") return true;
  return false;
}

export type ActionMask = "full" | "upper";

export interface PlayOptions {
  /** Start this many seconds into the clip. */
  offset?: number;
  /** Repeat until stopped (a held guard); otherwise it plays once and fades out. */
  loop?: boolean;
  mask?: ActionMask;
  /** Seconds to fade in / out. */
  fadeIn?: number;
  fadeOut?: number;
  /** Playback rate. */
  timeScale?: number;
}

class ActionLayer {
  readonly mixer: THREE.AnimationMixer;
  readonly action: THREE.AnimationAction;
  private readonly saved: THREE.Quaternion[];
  private readonly savedHips = new THREE.Vector3();
  private readonly tmp = new THREE.Quaternion();
  weight = 0;
  stopping = false;

  constructor(
    root: THREE.Object3D,
    readonly name: string,
    clip: THREE.AnimationClip,
    private readonly bones: THREE.Object3D[],
    private readonly hips: THREE.Object3D | null,
    readonly opts: Required<PlayOptions>,
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    this.action = this.mixer.clipAction(clip);
    this.action.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    this.action.clampWhenFinished = true;
    this.action.timeScale = opts.timeScale;
    this.action.play();
    this.action.time = Math.min(opts.offset, clip.duration);
    this.saved = bones.map(() => new THREE.Quaternion());
    // Already under way (a late join): no fade in.
    if (opts.offset > opts.fadeIn) this.weight = 1;
  }

  get time(): number {
    return this.action.time;
  }

  get done(): boolean {
    return this.stopping ? this.weight <= 0 : false;
  }

  /** Blend the action over the pose the base just set. */
  apply(dt: number): void {
    const clip = this.action.getClip();
    if (!this.opts.loop && !this.stopping && this.action.time >= clip.duration - this.opts.fadeOut) this.stopping = true;
    this.weight = this.stopping
      ? Math.max(0, this.weight - dt / Math.max(1e-3, this.opts.fadeOut))
      : Math.min(1, this.weight + dt / Math.max(1e-3, this.opts.fadeIn));
    for (let i = 0; i < this.bones.length; i++) this.saved[i].copy(this.bones[i].quaternion);
    if (this.hips) this.savedHips.copy(this.hips.position);
    this.mixer.update(dt);
    if (this.weight >= 1) return;
    for (let i = 0; i < this.bones.length; i++) {
      const q = this.bones[i].quaternion;
      this.tmp.copy(q);
      q.copy(this.saved[i]).slerp(this.tmp, this.weight);
    }
    if (this.hips) this.hips.position.lerpVectors(this.savedHips, this.hips.position.clone(), this.weight);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }
}

export class CharacterAnimator {
  private readonly mixer: THREE.AnimationMixer;
  private base: { name: string; action: THREE.AnimationAction } | null = null;
  /** The base clip being left, fading out while the new one fades in. */
  private leaving: { action: THREE.AnimationAction; elapsed: number; duration: number } | null = null;
  /** The base clip the server asked for (EA21); null: choose from the motion. */
  private serverBase: { name: string; timeScale: number; fade: number } | null = null;
  /** The server clip (by plan key) the action layer is playing, and that layer (a later `play` replaces it). */
  private planKey: string | null = null;
  private planLayer: ActionLayer | null = null;
  private layer: ActionLayer | null = null;
  private readonly bones: THREE.Object3D[] = [];
  private readonly hips: THREE.Object3D | null;
  private readonly masked = new Map<string, THREE.AnimationClip>();
  private airTime = 0;
  private readonly female: boolean;

  constructor(
    private readonly root: THREE.Object3D,
    readonly library: AnimationLibrary,
    opts: { female?: boolean } = {},
  ) {
    this.female = opts.female ?? false;
    this.mixer = new THREE.AnimationMixer(root);
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone || o.name === "Hips") this.bones.push(o);
    });
    this.hips = root.getObjectByName("Hips") ?? null;
  }

  /** The action on show (null: locomotion only). */
  get action(): string | null {
    return this.layer && !this.layer.stopping ? this.layer.name : null;
  }

  /** The base crossfade in progress (null: settled): the clip being left, the one coming in, and how far in (0..1). */
  get fading(): { from: string; to: string; progress: number } | null {
    const f = this.leaving;
    if (!f || !this.base) return null;
    return { from: f.action.getClip().name, to: this.base.name, progress: crossfadeWeights(f.elapsed, f.duration).to };
  }

  /** The base clip on show. */
  get baseClip(): string | null {
    return this.base?.name ?? null;
  }

  /** A clip's take for this character: the female take (`name.F`) for women, when there is one. */
  resolve(name: string): string {
    return this.female && this.library.clips.has(`${name}.F`) ? `${name}.F` : name;
  }

  /** Play `name` over the base. Returns false when the library has no such clip. */
  play(name: string, opts: PlayOptions = {}): boolean {
    name = this.resolve(name);
    const full = this.library.clips.get(name);
    if (!full) return false;
    const o: Required<PlayOptions> = {
      offset: opts.offset ?? 0,
      loop: opts.loop ?? false,
      mask: opts.mask ?? "full",
      fadeIn: opts.fadeIn ?? 0.12,
      fadeOut: opts.fadeOut ?? 0.2,
      timeScale: opts.timeScale ?? 1,
    };
    const clip = o.mask === "upper" ? this.upperBody(name, full) : full;
    const bones = this.bones.filter((b) => o.mask === "full" || isUpperBody(b));
    this.layer?.dispose();
    this.layer = new ActionLayer(this.root, name, clip, bones, o.mask === "full" ? this.hips : null, o);
    return true;
  }

  /** Fade the action out (a released guard). */
  stop(fadeOut?: number): void {
    if (!this.layer) return;
    if (fadeOut !== undefined) this.layer.opts.fadeOut = fadeOut;
    this.layer.stopping = true;
  }

  /**
   * Advance by `dt` seconds with the character moving as `motion`.
   *
   * `plan` is the server's Animation row planned for this tick (art
   * `planClip`): a looping clip on the base layer becomes the base clip, an
   * upper-body clip plays as the action over the legs' locomotion, and a
   * one-shot on the base plays whole-body over it. No plan (undefined or
   * null): the base follows the motion, and `play`/`stop` drive the action.
   */
  update(dt: number, motion: Motion, plan?: ClipPlan | null): void {
    this.follow(plan ?? null);
    if (this.layer?.done) {
      this.layer.dispose();
      this.layer = null;
    }
    this.chooseBase(motion, dt);
    this.fadeBase(dt);
    this.mixer.update(dt);
    this.layer?.apply(dt);
  }

  /** Take the server's clip: the base for a gait, the action layer for the rest. */
  private follow(plan: ClipPlan | null): void {
    if (!plan || (plan.layers.base && plan.loop && !plan.layers.upper)) {
      this.serverBase = plan && { name: plan.clip, timeScale: plan.timeScale, fade: plan.fade };
      // Release the server's action, but never an action the game started itself (a roll).
      if (this.planKey !== null && this.layer === this.planLayer) this.stop(plan?.fade);
      this.planKey = null;
      this.planLayer = null;
      return;
    }
    this.serverBase = null;
    if (plan.key === this.planKey) return;
    this.planKey = plan.key;
    const clip = this.library.clips.get(this.resolve(plan.clip));
    // The clip may already be under way (a late join, a tick of lag): start where it would be.
    this.play(plan.clip, {
      offset: clip ? playhead(plan.elapsed, plan.timeScale, clip.duration, plan.loop) : 0,
      loop: plan.loop,
      mask: plan.layers.upper ? "upper" : "full",
      fadeIn: plan.fade,
      fadeOut: plan.fade,
      timeScale: plan.timeScale,
    });
    this.planLayer = this.layer;
  }

  private chooseBase(m: Motion, dt: number): void {
    let name: string;
    let timeScale = 1;
    let fade = BASE_FADE;
    const gait = (gaits: Gait[], idle: string): void => {
      const g = [...gaits].reverse().find((x) => m.speed >= x.from);
      name = g ? g.clip : idle;
      if (g) timeScale = THREE.MathUtils.clamp(m.speed / g.speed, 0.6, 1.6);
    };
    this.airTime = Math.abs(m.vy) > AIRBORNE_VY ? this.airTime + dt : 0;
    const grounded = m.mode !== LocomotionMode.Swim && m.mode !== LocomotionMode.Fly && this.airTime <= 0.05;
    if (this.serverBase && grounded) {
      // The server's gait and rate; it never sends swimming or airborne, so those stay with the motion.
      ({ name, timeScale, fade } = this.serverBase);
    } else if (m.mode === LocomotionMode.Swim) gait(SWIM, IDLE.swim);
    else if (m.mode === LocomotionMode.Fly) gait(FLY, IDLE.fly);
    else if (this.airTime > 0.05) name = IDLE.air;
    else gait(GROUND, IDLE.ground);
    name = this.resolve(this.library.clips.has(name!) ? name! : IDLE.ground);
    this.setBase(name, timeScale, fade);
  }

  /** Make `name` the base clip: the old one fades out as this one fades in. */
  private setBase(name: string, timeScale: number, fade: number): void {
    if (this.base?.name === name) {
      this.base.action.timeScale = timeScale;
      return;
    }
    const clip = this.library.clips.get(name);
    if (!clip) return;
    const next = this.mixer.clipAction(clip);
    next.reset();
    next.timeScale = timeScale;
    next.play();
    if (this.base) {
      // Keep the feet in step: start the new gait at the same phase.
      const prev = this.base.action;
      next.time = (prev.time / prev.getClip().duration) * clip.duration;
      // A fade in progress is cut short: the clip it was leaving is gone.
      this.leaving?.action.stop();
      this.leaving = { action: prev, elapsed: 0, duration: fade };
    }
    this.base = { name, action: next };
    this.fadeBase(0);
  }

  /** The base crossfade, on art's eased weights (they add to 1: the pose never dips). */
  private fadeBase(dt: number): void {
    const leaving = this.leaving;
    if (!leaving || !this.base) return;
    leaving.elapsed += dt;
    const w = crossfadeWeights(leaving.elapsed, leaving.duration);
    this.base.action.setEffectiveWeight(w.to);
    leaving.action.setEffectiveWeight(w.from);
    if (leaving.elapsed >= leaving.duration) {
      leaving.action.stop();
      this.leaving = null;
    }
  }

  private upperBody(name: string, clip: THREE.AnimationClip): THREE.AnimationClip {
    let c = this.masked.get(name);
    if (!c) {
      const upper = new Set(this.bones.filter(isUpperBody).map((b) => b.name));
      c = new THREE.AnimationClip(`${name}#upper`, clip.duration, clip.tracks.filter((t) => upper.has(t.name.split(".")[0])));
      this.masked.set(name, c);
    }
    return c;
  }

  dispose(): void {
    this.layer?.dispose();
    this.layer = null;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}
