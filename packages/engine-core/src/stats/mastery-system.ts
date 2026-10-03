/**
 * MasterySystem — skills grow with use (M1).
 *
 * Holds a SkillSheet per player entity (made on first sight, dropped with
 * `forget`). While an entity swims it trains Swimming, while it moves on
 * foot it trains Athletics, once per `USE_EVERY_SECONDS` of effort. Both
 * are plain-ground uses of fixed difficulty (no target, so no repeat
 * falloff); the numbers are proposed defaults. Exposure has no weather to
 * train against yet. Not persisted or on the wire yet (U9 character sheet
 * waits on a flatc regen).
 */

import { defineQuery, hasComponent } from "bitecs";
import { LocomotionMode } from "@mmo-engine/protocol";
import type { SkillsRules } from "@mmo-engine/rules";
import { Health, Locomotion, PlayerIntent } from "../components.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";
import { SkillIndex, SkillSheet } from "./mastery.js";

/** Seconds of effort that make one training use. */
export const USE_EVERY_SECONDS = 5;
export const SWIM_DIFFICULTY = 0.4;
export const ATHLETICS_DIFFICULTY = 0.3;

export class MasterySystem implements SimSystem {
  readonly name = "mastery";
  readonly index: SkillIndex;
  private readonly query = defineQuery([PlayerIntent, Health]);
  private readonly sheets = new Map<number, SkillSheet>();
  private readonly effort = new Map<number, number>();
  private readonly swim: number;
  private readonly athletics: number;

  constructor(rules: SkillsRules, private readonly clock: () => number = Date.now) {
    this.index = new SkillIndex(rules);
    this.swim = this.index.of("swimming");
    this.athletics = this.index.of("athletics");
  }

  /** The entity's skills (made empty on first ask). */
  sheetOf(eid: number): SkillSheet {
    let s = this.sheets.get(eid);
    if (!s) {
      s = new SkillSheet(this.index);
      this.sheets.set(eid, s);
    }
    return s;
  }

  forget(eid: number): void {
    this.sheets.delete(eid);
    this.effort.delete(eid);
  }

  step(sim: SimWorld, dtSeconds: number): void {
    const eids = this.query(sim.ecs);
    for (let i = 0; i < eids.length; i++) {
      const e = eids[i] as number;
      if (Health.current[e] <= 0) continue;
      const swimming = hasComponent(sim.ecs, Locomotion, e) && Locomotion.mode[e] === LocomotionMode.Swim;
      const moving = swimming
        ? PlayerIntent.mx[e] !== 0 || PlayerIntent.my[e] !== 0 || PlayerIntent.mz[e] !== 0
        : PlayerIntent.mx[e] !== 0 || PlayerIntent.mz[e] !== 0;
      if (!moving) continue;
      const t = (this.effort.get(e) ?? 0) + dtSeconds;
      if (t < USE_EVERY_SECONDS) {
        this.effort.set(e, t);
        continue;
      }
      this.effort.set(e, t - USE_EVERY_SECONDS);
      const skill = swimming ? this.swim : this.athletics;
      if (skill >= 0) this.sheetOf(e).train(skill, swimming ? SWIM_DIFFICULTY : ATHLETICS_DIFFICULTY, -1, this.clock());
    }
  }
}
