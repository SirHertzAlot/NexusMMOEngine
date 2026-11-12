/**
 * AnimalAnimator — procedural skeletal animation state machine for quadruped animals.
 *
 * Implements:
 *   1. Progressive windup / inertia acceleration curve toward target speed.
 *   2. Stride-locked discrete frame playback: leaps (Gallop_Jump) and landing stops
 *      (Jump_toIdle) play through their full cycle rather than cutting mid-frame.
 *   3. Stride ground-coupling: stride length x mass scaling so legs match ground coverage.
 *   4. Autonomous procedural idle routine: fluid transitions between Grazing (Eating),
 *      Resting (Idle_Headlow), Casual Looking (Idle_2), and Alert (Idle).
 *
 * Zero heap allocations on the update hot path.
 */

import * as THREE from "three";

export interface AnimalMotionState {
  /** Horizontal movement speed in m/s (from server velocity). */
  speed: number;
  /** Whether the creature is dead. */
  dead: boolean;
  /** Attack progress (>= 0 if attacking, -1 if not). */
  attackT?: number;
  /** Damage hit flash flag. */
  hit?: boolean;
  /** Explicit living sim action from biological needs simulation. */
  livingAction?: "idle" | "sleeping" | "foraging" | "drinking" | "bathroom" | "mating_display" | "social_play";
}

export interface AnimalAnimatorOptions {
  /** Model identifier or archetype name (e.g. "quaternius-animals/Deer", "Wolf"). */
  modelId?: string;
  /** Custom acceleration rate in m/s^2 (default 3.5). */
  accelerationRate?: number;
  /** Custom deceleration rate in m/s^2 (default 5.0). */
  decelerationRate?: number;
}

export type AnimalActionState =
  | "dead"
  | "attack"
  | "hit"
  | "strideLock"
  | "gallop"
  | "walk"
  | "prowl"
  | "graze"
  | "rest"
  | "look"
  | "spurring"
  | "idle";

export class AnimalAnimator {
  readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly clipDurations = new Map<string, number>();

  private currentAction: THREE.AnimationAction | null = null;
  private currentClipName = "";
  private currentState: AnimalActionState = "idle";

  // Progressive windup / inertia state
  private currentSpeed = 0;
  private readonly accelerationRate: number;
  private readonly decelerationRate: number;

  // Stride-lock / discrete animation playback
  private inStrideLock = false;
  private strideLockElapsed = 0;
  private strideLockDuration = 0;
  private strideLockCooldown = 0;

  // Stride ground physics coupling
  private readonly naturalWalkSpeed: number;
  private readonly naturalGallopSpeed: number;

  // Autonomous idle routine
  private idleTimer = 3.0;
  private currentIdleSubstate: "idle" | "look" | "graze" | "rest" | "spurring" = "idle";
  private readonly isHerbivore: boolean;
  readonly isCanine: boolean;
  readonly isCaprine: boolean;
  readonly isBoar: boolean;
  readonly isBear: boolean;

  // Categorized clip names
  private readonly idleClip: string | null;
  private readonly lookClip: string | null;
  private readonly restClip: string | null;
  private readonly grazeClip: string | null;
  private readonly walkClip: string | null;
  private readonly gallopClip: string | null;
  private readonly jumpClip: string | null;
  private readonly landClip: string | null;
  private readonly attackClip: string | null;
  private readonly spurringClip: string | null;
  private readonly deadClip: string | null;
  private readonly hitClip: string | null;

  constructor(
    readonly root: THREE.Object3D,
    readonly clips: readonly THREE.AnimationClip[],
    opts: AnimalAnimatorOptions = {},
  ) {
    this.mixer = new THREE.AnimationMixer(root);

    const modelName = (opts.modelId ?? root.name).toLowerCase();
    this.isCanine =
      modelName.includes("wolf") ||
      modelName.includes("coyote") ||
      modelName.includes("fox") ||
      modelName.includes("husky") ||
      modelName.includes("shiba") ||
      modelName.includes("dog");

    this.isCaprine =
      modelName.includes("goat") ||
      modelName.includes("ram") ||
      modelName.includes("sheep") ||
      modelName.includes("bighorn");

    this.isBoar =
      modelName.includes("boar") ||
      modelName.includes("pig");

    this.isBear =
      modelName.includes("bear");

    this.isHerbivore =
      this.isCaprine ||
      modelName.includes("deer") ||
      modelName.includes("stag") ||
      modelName.includes("horse") ||
      modelName.includes("cow") ||
      modelName.includes("bull") ||
      modelName.includes("donkey") ||
      modelName.includes("alpaca");

    // Progressive windup tuning: lighter predators ramp faster, heavy ungulates have more inertia
    if (this.isBear || modelName.includes("cow") || modelName.includes("bull")) {
      this.accelerationRate = opts.accelerationRate ?? 2.2;
      this.decelerationRate = opts.decelerationRate ?? 3.8;
      this.naturalWalkSpeed = 1.1;
      this.naturalGallopSpeed = 3.2;
    } else if (modelName.includes("horse") || modelName.includes("donkey")) {
      this.accelerationRate = opts.accelerationRate ?? 3.0;
      this.decelerationRate = opts.decelerationRate ?? 4.8;
      this.naturalWalkSpeed = 1.3;
      this.naturalGallopSpeed = 4.2;
    } else if (modelName.includes("deer") || modelName.includes("stag")) {
      this.accelerationRate = opts.accelerationRate ?? 3.6;
      this.decelerationRate = opts.decelerationRate ?? 5.5;
      this.naturalWalkSpeed = 1.2;
      this.naturalGallopSpeed = 4.5;
    } else if (modelName.includes("fox")) {
      this.accelerationRate = opts.accelerationRate ?? 5.0;
      this.decelerationRate = opts.decelerationRate ?? 6.5;
      this.naturalWalkSpeed = 1.0;
      this.naturalGallopSpeed = 3.8;
    } else if (this.isBoar) {
      this.accelerationRate = opts.accelerationRate ?? 4.0;
      this.decelerationRate = opts.decelerationRate ?? 5.0;
      this.naturalWalkSpeed = 1.1;
      this.naturalGallopSpeed = 3.6;
    } else {
      // Wolf, Husky, ShibaInu, default quadruped
      this.accelerationRate = opts.accelerationRate ?? 4.2;
      this.decelerationRate = opts.decelerationRate ?? 5.8;
      this.naturalWalkSpeed = 1.15;
      this.naturalGallopSpeed = 4.0;
    }

    let idle: string | null = null;
    let look: string | null = null;
    let rest: string | null = null;
    let graze: string | null = null;
    let walk: string | null = null;
    let gallop: string | null = null;
    let jump: string | null = null;
    let land: string | null = null;
    let attack: string | null = null;
    let attackHeadbutt: string | null = null;
    let spurring: string | null = null;
    let dead: string | null = null;
    let hit: string | null = null;

    for (const clip of clips) {
      const act = this.mixer.clipAction(clip);
      this.actions.set(clip.name, act);
      this.clipDurations.set(clip.name, clip.duration);
      const lower = clip.name.toLowerCase();

      if (!dead && (lower.includes("death") || lower.includes("dead") || lower.includes("die"))) {
        dead = clip.name;
      } else if (lower.includes("headbutt")) {
        attackHeadbutt = clip.name;
        if (!attack) attack = clip.name;
      } else if (lower.includes("kick")) {
        spurring = clip.name;
        if (!attack) attack = clip.name;
      } else if (!attack && lower.includes("attack")) {
        attack = clip.name;
      } else if (!hit && lower.includes("hitreact")) {
        hit = clip.name;
      } else if (lower === "eating" || lower.includes("graze") || lower.startsWith("eat")) {
        graze = clip.name;
      } else if (lower.includes("headlow") || lower.includes("head_low")) {
        rest = clip.name;
      } else if (lower === "idle_2" || lower.includes("look")) {
        look = clip.name;
      } else if (!idle && lower.startsWith("idle") && !lower.includes("hitreact")) {
        idle = clip.name;
      } else if (!walk && lower.includes("walk")) {
        walk = clip.name;
      } else if (!jump && (lower.includes("gallop_jump") || lower.includes("leap") || lower === "jump")) {
        jump = clip.name;
      } else if (!land && (lower.includes("jump_toidle") || lower.includes("land"))) {
        land = clip.name;
      } else if (!gallop && (lower.includes("gallop") || lower.includes("run"))) {
        gallop = clip.name;
      }
    }

    this.idleClip = idle ?? clips[0]?.name ?? null;
    this.lookClip = look ?? this.idleClip;
    this.restClip = rest ?? this.lookClip;
    this.grazeClip = graze ?? this.restClip;
    this.walkClip = walk ?? this.idleClip;
    this.gallopClip = gallop ?? this.walkClip;
    this.jumpClip = jump;
    this.landClip = land;
    this.spurringClip = spurring;
    this.attackClip = ((this.isCaprine || this.isBoar) && attackHeadbutt) ? attackHeadbutt : (attack ?? this.idleClip);
    this.deadClip = dead;
    this.hitClip = hit;

    if (this.deadClip) {
      const deadAct = this.actions.get(this.deadClip);
      if (deadAct) {
        deadAct.setLoop(THREE.LoopOnce, 1);
        deadAct.clampWhenFinished = true;
      }
    }

    if (this.landClip) {
      const landAct = this.actions.get(this.landClip);
      if (landAct) {
        landAct.setLoop(THREE.LoopOnce, 1);
        landAct.clampWhenFinished = true;
      }
    }

    if (this.jumpClip) {
      const jumpAct = this.actions.get(this.jumpClip);
      if (jumpAct) {
        jumpAct.setLoop(THREE.LoopOnce, 1);
        jumpAct.clampWhenFinished = true;
      }
    }

    if (this.idleClip) {
      this.play(this.idleClip, 0);
    }
  }

  get state(): AnimalActionState {
    return this.currentState;
  }

  get speed(): number {
    return this.currentSpeed;
  }

  update(dt: number, state: AnimalMotionState): void {
    if (state.dead) {
      if (this.currentState !== "dead" && this.deadClip) {
        this.currentState = "dead";
        this.inStrideLock = false;
        this.play(this.deadClip, 0.2);
      }
      this.mixer.update(dt);
      return;
    }

    if (this.currentState === "dead") {
      this.currentState = "idle";
    }

    // High-priority combat overrides
    if (state.attackT !== undefined && state.attackT >= 0 && this.attackClip) {
      this.currentState = "attack";
      this.inStrideLock = false;
      this.play(this.attackClip, 0.1);
      this.mixer.update(dt);
      return;
    }

    if (state.hit && this.hitClip) {
      this.currentState = "hit";
      this.inStrideLock = false;
      this.play(this.hitClip, 0.05);
      this.mixer.update(dt);
      return;
    }

    // Explicit biological living sim action override when stationary
    if (state.livingAction && state.livingAction !== "idle" && (!state.speed || state.speed < 0.2)) {
      this.inStrideLock = false;
      switch (state.livingAction) {
        case "sleeping":
          this.currentState = "rest";
          if (this.restClip) this.play(this.restClip, 0.4);
          this.mixer.update(dt);
          return;
        case "foraging":
        case "drinking":
          this.currentState = "graze";
          if (this.grazeClip) this.play(this.grazeClip, 0.4);
          else if (this.restClip) this.play(this.restClip, 0.4);
          this.mixer.update(dt);
          return;
        case "bathroom":
          this.currentState = "rest";
          if (this.restClip) this.play(this.restClip, 0.3);
          this.mixer.update(dt);
          return;
        case "mating_display":
          this.currentState = "spurring";
          if (this.spurringClip) this.play(this.spurringClip, 0.2);
          else if (this.attackClip) this.play(this.attackClip, 0.2);
          this.mixer.update(dt);
          return;
        case "social_play":
          this.currentState = "look";
          if (this.lookClip) this.play(this.lookClip, 0.3);
          this.mixer.update(dt);
          return;
      }
    }

    // 1. Progressive windup / inertia acceleration curve toward target speed
    const targetSpeed = Math.max(0, state.speed);
    if (targetSpeed > this.currentSpeed) {
      this.currentSpeed = Math.min(targetSpeed, this.currentSpeed + this.accelerationRate * dt);
    } else if (targetSpeed < this.currentSpeed) {
      this.currentSpeed = Math.max(targetSpeed, this.currentSpeed - this.decelerationRate * dt);
    }

    if (this.strideLockCooldown > 0) {
      this.strideLockCooldown -= dt;
    }

    // 2. Discrete stride execution: playthrough the full frames of active leap/stride
    if (this.inStrideLock) {
      const timeScale = this.currentAction?.timeScale ?? 1.0;
      this.strideLockElapsed += dt * Math.max(0.5, timeScale);

      if (this.strideLockElapsed < this.strideLockDuration) {
        this.mixer.update(dt);
        return;
      }
      // Stride finished its full cycle
      this.inStrideLock = false;
      this.strideLockCooldown = 2.5; // Cooldown before next leap
    }

    // 3. Movement gait selection with stride ground coupling
    if (this.currentSpeed > 0.08) {
      // Exiting stationary state: reset idle substate
      this.idleTimer = 3.0;

      // High-speed bounding leap trigger (deer, stag, wolf bounding across terrain)
      if (this.currentSpeed > 3.2 && this.jumpClip && this.strideLockCooldown <= 0 && Math.random() < 0.08) {
        this.currentState = "strideLock";
        this.inStrideLock = true;
        this.strideLockElapsed = 0;
        this.strideLockDuration = this.clipDurations.get(this.jumpClip) ?? 1.4;
        const act = this.play(this.jumpClip, 0.15);
        if (act) {
          act.reset();
          act.timeScale = THREE.MathUtils.clamp(this.currentSpeed / this.naturalGallopSpeed, 0.8, 1.4);
        }
        this.mixer.update(dt);
        return;
      }

      // Fast gallop
      if (this.currentSpeed > 2.0 && this.gallopClip) {
        this.currentState = "gallop";
        const act = this.play(this.gallopClip, 0.2);
        if (act) {
          act.timeScale = THREE.MathUtils.clamp(this.currentSpeed / this.naturalGallopSpeed, 0.7, 1.7);
        }
      } else if (this.isCanine && this.currentSpeed <= 1.4 && this.walkClip) {
        // Canine stalking prowl: deliberate low stalking cadence
        this.currentState = "prowl";
        const act = this.play(this.walkClip, 0.3);
        if (act) {
          act.timeScale = THREE.MathUtils.clamp(this.currentSpeed / this.naturalWalkSpeed, 0.5, 1.15);
        }
      } else if (this.walkClip) {
        // Slow walk
        this.currentState = "walk";
        const act = this.play(this.walkClip, 0.25);
        if (act) {
          act.timeScale = THREE.MathUtils.clamp(this.currentSpeed / this.naturalWalkSpeed, 0.6, 1.5);
        }
      }

      this.mixer.update(dt);
      return;
    }

    // 4. Landing stop transition when decelerating from sprint to standstill
    if (targetSpeed <= 0.05 && this.currentSpeed <= 0.2 && this.currentState === "gallop" && this.landClip) {
      this.currentState = "strideLock";
      this.inStrideLock = true;
      this.strideLockElapsed = 0;
      this.strideLockDuration = this.clipDurations.get(this.landClip) ?? 1.2;
      const act = this.play(this.landClip, 0.15);
      if (act) {
        act.reset();
        act.timeScale = 1.0;
      }
      this.mixer.update(dt);
      return;
    }

    // 5. Autonomous procedural idle state machine (Grazing, Resting, Looking, Spurring, Alert)
    this.idleTimer -= dt;
    if (this.idleTimer <= 0) {
      this.cycleNextIdleSubstate();
    }

    this.mixer.update(dt);
  }

  private cycleNextIdleSubstate(): void {
    const roll = Math.random();

    if (this.isCanine) {
      // Canine predator idle: 45% ground sniffing / low prowl rest (Idle_2_HeadLow),
      // 35% vigilant perked-ear horizon scanning (Idle_2), 20% alert standing
      if (this.currentIdleSubstate === "rest") {
        this.currentIdleSubstate = roll < 0.6 ? "look" : "idle";
        this.idleTimer = 3.0 + Math.random() * 2.5;
      } else if (roll < 0.45 && this.restClip) {
        this.currentIdleSubstate = "rest";
        this.idleTimer = 3.5 + Math.random() * 3.0;
      } else if (roll < 0.8 && this.lookClip) {
        this.currentIdleSubstate = "look";
        this.idleTimer = 2.5 + Math.random() * 2.5;
      } else {
        this.currentIdleSubstate = "idle";
        this.idleTimer = 2.0 + Math.random() * 2.5;
      }
    } else if (this.isBoar) {
      // Boar idle: 50% ground rooting / tusking (Eating), 30% low rest, 20% alert
      if (roll < 0.5 && this.grazeClip) {
        this.currentIdleSubstate = "graze";
        this.idleTimer = 4.0 + Math.random() * 3.5;
      } else if (roll < 0.8 && this.restClip) {
        this.currentIdleSubstate = "rest";
        this.idleTimer = 3.0 + Math.random() * 3.0;
      } else {
        this.currentIdleSubstate = "idle";
        this.idleTimer = 2.0 + Math.random() * 2.5;
      }
    } else if (this.isCaprine && this.spurringClip && roll < 0.25) {
      // Caprine trademark behavior: ground spurring / hoof-stamping before charge
      this.currentIdleSubstate = "spurring";
      this.idleTimer = 1.5 + Math.random() * 1.0;
    } else if (this.isHerbivore) {
      // Herbivore idle weighting: 45% Grazing (Eating), 25% Relaxed resting, 15% Looking, 15% Alert
      if (this.currentIdleSubstate === "graze") {
        this.currentIdleSubstate = roll < 0.5 ? "rest" : "look";
        this.idleTimer = 3.0 + Math.random() * 3.0;
      } else if (roll < 0.45 && this.grazeClip) {
        this.currentIdleSubstate = "graze";
        this.idleTimer = 4.5 + Math.random() * 4.5;
      } else if (roll < 0.7 && this.restClip) {
        this.currentIdleSubstate = "rest";
        this.idleTimer = 3.5 + Math.random() * 3.0;
      } else if (roll < 0.85 && this.lookClip) {
        this.currentIdleSubstate = "look";
        this.idleTimer = 2.5 + Math.random() * 2.5;
      } else {
        this.currentIdleSubstate = "idle";
        this.idleTimer = 2.0 + Math.random() * 3.0;
      }
    } else {
      // Default quadruped / predator
      if (this.currentIdleSubstate === "graze") {
        this.currentIdleSubstate = "rest";
        this.idleTimer = 3.0 + Math.random() * 3.0;
      } else if (roll < 0.2 && this.grazeClip) {
        this.currentIdleSubstate = "graze";
        this.idleTimer = 2.5 + Math.random() * 2.5;
      } else if (roll < 0.55 && this.restClip) {
        this.currentIdleSubstate = "rest";
        this.idleTimer = 3.5 + Math.random() * 3.5;
      } else if (roll < 0.8 && this.lookClip) {
        this.currentIdleSubstate = "look";
        this.idleTimer = 2.5 + Math.random() * 2.5;
      } else {
        this.currentIdleSubstate = "idle";
        this.idleTimer = 2.0 + Math.random() * 3.0;
      }
    }

    switch (this.currentIdleSubstate) {
      case "spurring":
        if (this.spurringClip) {
          this.currentState = "spurring";
          this.play(this.spurringClip, 0.25);
        }
        break;
      case "graze":
        if (this.grazeClip) {
          this.currentState = "graze";
          this.play(this.grazeClip, 0.6);
        }
        break;
      case "rest":
        if (this.restClip) {
          this.currentState = "rest";
          this.play(this.restClip, 0.5);
        }
        break;
      case "look":
        if (this.lookClip) {
          this.currentState = "look";
          this.play(this.lookClip, 0.4);
        }
        break;
      default:
        if (this.idleClip) {
          this.currentState = "idle";
          this.play(this.idleClip, 0.4);
        }
        break;
    }
  }

  private play(name: string, fadeDuration: number): THREE.AnimationAction | null {
    if (this.currentClipName === name && this.currentAction) {
      return this.currentAction;
    }

    const next = this.actions.get(name);
    if (!next) return null;

    if (this.currentAction && fadeDuration > 0) {
      this.currentAction.fadeOut(fadeDuration);
      next.reset().fadeIn(fadeDuration).play();
    } else {
      if (this.currentAction) this.currentAction.stop();
      next.reset().play();
    }

    this.currentAction = next;
    this.currentClipName = name;
    return next;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.actions.clear();
    this.clipDurations.clear();
  }
}
