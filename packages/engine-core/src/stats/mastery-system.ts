/**
 * MasterySystem — skills grow with use (M1).
 *
 * Holds a SkillSheet per player entity (made on first sight, dropped with
 * `forget`). While an entity swims it trains Swimming, while it moves on
 * foot it trains Athletics, once per `USE_EVERY_SECONDS` of effort. Both
 * are plain-ground uses of fixed difficulty (no target, so no repeat
 * falloff); the numbers are proposed defaults. Exposure has no weather to
 * train against yet. Saved with the character (M1b, in the gateway), and
 * sent to its player as the 0x1b `skills` message (M4).
 *
 * Disciplines (M4, §2.4): a character has earned a discipline once every
 * skill it requires has reached its level (by peak: a title is kept), and
 * can use what it unlocks while the skills are there now (by value).
 */

import { defineQuery, hasComponent } from "bitecs";
import { LocomotionMode } from "@mmo-engine/protocol";
import type { Discipline, SkillsRules } from "@mmo-engine/rules";
import { Health, Locomotion, PlayerIntent } from "../components.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";
import { SkillIndex, SkillSheet } from "./mastery.js";

/** Seconds of effort that make one training use, and how hard each counts: the engine defaults (skills.json `pacing`). */
export const USE_EVERY_SECONDS = 5;
export const SWIM_DIFFICULTY = 0.4;
export const ATHLETICS_DIFFICULTY = 0.3;

type Pacing = SkillsRules["pacing"];

/** A discipline as one character has it. */
export interface DisciplineView {
  id: string;
  name: string;
  /** The skills are at its levels now: what it unlocks can be used. */
  active: boolean;
  /** Special techniques it unlocks. */
  unlocks: readonly string[];
}

export class MasterySystem implements SimSystem {
  readonly name = "mastery";
  readonly index: SkillIndex;
  private readonly query = defineQuery([PlayerIntent, Health]);
  private readonly sheets = new Map<number, SkillSheet>();
  private readonly effort = new Map<number, number>();
  private readonly swim: number;
  private readonly athletics: number;
  /** Training from moving (skills.json `pacing`); a rules reload swaps it. */
  private pacing: Readonly<Pacing>;

  constructor(
    rules: SkillsRules,
    private readonly clock: () => number = Date.now,
    /** The rules' disciplines (disciplines.json); absent: none. */
    private disciplines: readonly Discipline[] = [],
  ) {
    this.index = new SkillIndex(rules);
    this.swim = this.index.of("swimming");
    this.athletics = this.index.of("athletics");
    this.pacing = rules.pacing ?? { useEverySeconds: USE_EVERY_SECONDS, swimmingDifficulty: SWIM_DIFFICULTY, athleticsDifficulty: ATHLETICS_DIFFICULTY };
  }

  /** New training pace (rules hot reload). */
  setPacing(pacing: Readonly<Pacing>): void {
    this.pacing = pacing;
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

  /** New disciplines (rules hot reload). */
  setDisciplines(disciplines: readonly Discipline[]): void {
    this.disciplines = disciplines;
  }

  /** The disciplines `eid` has earned, in rules order. */
  disciplinesOf(eid: number): DisciplineView[] {
    const sheet = this.sheets.get(eid);
    if (!sheet) return [];
    const out: DisciplineView[] = [];
    for (const d of this.disciplines) {
      let earned = true;
      let active = true;
      for (const [id, level] of Object.entries(d.requires)) {
        const i = this.index.of(id);
        const peak = i < 0 ? 0 : sheet.peak[i];
        const now = i < 0 ? 0 : sheet.value[i];
        if (peak < level) earned = false;
        if (now < level) active = false;
      }
      if (earned) out.push({ id: d.id, name: d.name, active, unlocks: d.unlocks });
    }
    return out;
  }

  /** The disciplines `eid` hasn't earned yet, in rules order: what the character sheet shows the way to. */
  goalsOf(eid: number): Discipline[] {
    const earned = new Set(this.disciplinesOf(eid).map((d) => d.id));
    return this.disciplines.filter((d) => !earned.has(d.id));
  }

  /** The rules' discipline `id`, or undefined. */
  discipline(id: string): Discipline | undefined {
    return this.disciplines.find((d) => d.id === id);
  }

  /** Whether `eid` can use `technique` now: an active discipline of its unlocks it. */
  knows(eid: number, technique: string): boolean {
    if (!this.sheets.has(eid)) return false;
    return this.disciplinesOf(eid).some((v) => v.active && v.unlocks.includes(technique));
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
      const p = this.pacing;
      const t = (this.effort.get(e) ?? 0) + dtSeconds;
      if (t < p.useEverySeconds) {
        this.effort.set(e, t);
        continue;
      }
      this.effort.set(e, t - p.useEverySeconds);
      const skill = swimming ? this.swim : this.athletics;
      if (skill >= 0) this.sheetOf(e).train(skill, swimming ? p.swimmingDifficulty : p.athleticsDifficulty, -1, this.clock());
    }
  }
}
