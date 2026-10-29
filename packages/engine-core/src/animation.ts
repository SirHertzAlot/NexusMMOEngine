/**
 * EA21 AnimationSystem: the server's clip decisions.
 *
 * Each tick, for every entity with an Animation component:
 * - a dead entity (Health <= 0) → death fall;
 * - a combat move (Action.move) → the move's clip (attack, block, hit, creature bite/claw/pounce/stomp);
 * - otherwise, locomotion from velocity and locomotion mode → idle, walk, trot, jog, gallop, sprint, swim, fly.
 *
 * The clip is only (re)started when it changes; the client blends and
 * renders from (clipId, startTick, rate, layerMask). Nothing here touches
 * bones — that's the client's job.
 */
import { addComponent, defineQuery, hasComponent } from "bitecs";
import { ClipId, Move, LocomotionMode } from "@mmo-engine/protocol";
import * as C from "./components.js";
import type { SimWorld } from "./world.js";
import type { SimSystem } from "./systems.js";

/** Combat move → clip. */
export const MOVE_CLIPS: Record<number, number> = {
  [Move.SwordA]: ClipId.AttackSwordA,
  [Move.SwordB]: ClipId.AttackSwordB,
  [Move.SwordC]: ClipId.AttackSwordC,
  [Move.Guard]: ClipId.Block,
  [Move.Roll]: ClipId.Roll,
  [Move.ShieldBash]: ClipId.ShieldBash,
  [Move.Bite]: ClipId.Bite,
  [Move.Claw]: ClipId.Claw,
  [Move.Pounce]: ClipId.Pounce,
  [Move.Roar]: ClipId.Roar,
  [Move.Breath]: ClipId.Breath,
  [Move.TailWhip]: ClipId.TailWhip,
  [Move.Stomp]: ClipId.Stomp,
  [Move.WingBuffet]: ClipId.WingBuffet,
  [Move.Sting]: ClipId.Sting,
  [Move.Cleave]: ClipId.Cleave,
};

/** Layer: attacks play over the base (upper body), locomotion is full body. */
const LAYER_BASE = 1;
const LAYER_UPPER = 2;

const animated = defineQuery([C.Animation]);

export class AnimationSystem implements SimSystem {
  readonly name = "AnimationSystem";

  step(world: SimWorld, _dt: number): void {
    const tick = world.currentTick;
    for (const eid of animated(world.ecs)) {
      // Death takes highest priority: dead bodies do not locomote or swing.
      if (hasComponent(world.ecs, C.Health, eid) && C.Health.current[eid] <= 0) {
        this.setClip(world, eid, ClipId.DeathFall, tick, 1, LAYER_BASE);
        continue;
      }

      // Combat moves take priority.
      let clip = 0;
      let layer = LAYER_BASE;
      let rate = 1;
      if (hasComponent(world.ecs, C.Action, eid)) {
        const move = C.Action.move[eid];
        if (move !== 0 && move !== Move.None) {
          const mapped = MOVE_CLIPS[move];
          if (mapped !== undefined) {
            clip = mapped;
            layer = LAYER_UPPER;
            // Match the clip to the move's start tick so the client lines up.
            this.setClip(world, eid, clip, C.Action.started[eid], rate, layer, true);
            continue;
          }
        }
      }

      // Locomotion mode and velocity fallback.
      const mode = hasComponent(world.ecs, C.Locomotion, eid) ? C.Locomotion.mode[eid] : LocomotionMode.Ground;
      if (mode === LocomotionMode.Swim) {
        clip = ClipId.Swim;
      } else if (mode === LocomotionMode.Fly) {
        clip = ClipId.Fly;
      } else if (hasComponent(world.ecs, C.Velocity, eid)) {
        const vx = C.Velocity.lx[eid] ?? 0;
        const vz = C.Velocity.lz[eid] ?? 0;
        const speed = Math.hypot(vx, vz);
        if (speed > 6) clip = ClipId.Sprint;
        else if (speed > 3.5) clip = ClipId.Jog;
        else if (speed > 0.5) clip = ClipId.Walk;
        else clip = ClipId.Idle;
        // Scale playback to ground speed for walk/jog/sprint.
        if (clip === ClipId.Walk) rate = Math.max(0.5, speed / 2);
        else if (clip === ClipId.Jog) rate = Math.max(0.5, speed / 4);
        else if (clip === ClipId.Sprint) rate = Math.max(0.5, speed / 7);
      } else {
        clip = ClipId.Idle;
      }
      this.setClip(world, eid, clip, tick, rate, layer);
    }
  }

  /**
   * Set the clip, but don't restart it if it's already playing. A combat
   * move restarts when its start tick changed (the same attack twice).
   */
  private setClip(
    world: SimWorld,
    eid: number,
    clip: number,
    startTick: number,
    rate: number,
    layer: number,
    restart = false,
  ): void {
    if (C.Animation.clipId[eid] === clip && !(restart && C.Animation.startTick[eid] !== startTick)) return;
    C.Animation.clipId[eid] = clip;
    C.Animation.startTick[eid] = startTick;
    C.Animation.rate[eid] = rate;
    C.Animation.layerMask[eid] = layer;
  }
}

/** Attach the Animation component to an entity (idempotent). */
export function ensureAnimation(world: SimWorld, eid: number): void {
  if (!hasComponent(world.ecs, C.Animation, eid)) {
    addComponent(world.ecs, C.Animation, eid);
    C.Animation.clipId[eid] = ClipId.None;
    C.Animation.startTick[eid] = 0;
    C.Animation.rate[eid] = 1;
    C.Animation.layerMask[eid] = LAYER_BASE;
  }
}
