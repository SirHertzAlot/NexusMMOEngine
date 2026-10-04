/**
 * Mastery — use-based skill gain and deterioration (roadmap M1,
 * docs/MASTERY-AND-COMBAT.md §2).
 *
 * A SkillSheet holds one entity's skills in typed arrays indexed by the
 * rules' skill order (allocated once, so training in the tick allocates
 * nothing). Values run 0..rules.max. A use has a `difficulty` (0..1, on the
 * same scale as the skill's fraction m = value / max):
 *
 *   d    = difficulty - m;  d < trivialBelow teaches nothing, d >= fullAt full
 *   gain = base * challenge(d) * (1 - m)^topSlowdown * repeat * relearn
 *
 * `repeat` is repeatFalloff^n for n recent uses on the same target (n
 * recovers over repeatRecoverMinutes); `relearn` multiplies gains below the
 * skill's old peak. Each gain also gives its skill's `related` skills a
 * share (not cascading). Unused skills deteriorate on entry (`decay`).
 *
 * Item familiarity (M4, §2.2): each blow with an item of a family (its
 * base: sword, axe, stick) adds `familiarity.perUse`, up to 1, which
 * computeDamage turns into up to `familiarity.maxFitBonus` extra fit. It is
 * saved with the skills, under `fam:<family>` keys.
 */

import type { SkillsRules } from "@mmo-engine/rules";

export class SkillIndex {
  readonly ids: readonly string[];
  private readonly at = new Map<string, number>();
  /** Per skill: [related index, share] pairs, flattened. */
  readonly relatedIdx: readonly Int32Array[];
  readonly relatedShare: readonly Float32Array[];

  constructor(readonly rules: SkillsRules) {
    this.ids = rules.skills.map((s) => s.id);
    this.ids.forEach((id, i) => this.at.set(id, i));
    const idx: Int32Array[] = [];
    const share: Float32Array[] = [];
    for (const s of rules.skills) {
      const rel = Object.entries(s.related ?? {}).filter(([k]) => this.at.has(k));
      idx.push(Int32Array.from(rel.map(([k]) => this.at.get(k)!)));
      share.push(Float32Array.from(rel.map(([, v]) => v)));
    }
    this.relatedIdx = idx;
    this.relatedShare = share;
  }

  get size(): number {
    return this.ids.length;
  }

  /** Index of a skill id, or -1. */
  of(id: string): number {
    return this.at.get(id) ?? -1;
  }
}

/** Save keys of item families (skill ids can't hold a colon). */
export const FAMILY_KEY = "fam:";

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/** Saved form of a sheet (values in tenths, so it stays integer). */
export interface SkillSave {
  /** skill id -> [tenths, peak tenths, last-use epoch ms]; `fam:<family>` -> [thousandths, thousandths, last-use epoch ms]. */
  [id: string]: [number, number, number];
}

export class SkillSheet {
  /** Current value, 0..max. */
  readonly value: Float32Array;
  readonly peak: Float32Array;
  /** Epoch ms of the last gain (0 = never). */
  readonly lastUse: Float64Array;
  private readonly lastTarget: Int32Array;
  /** Recent uses on lastTarget (a float: it recovers over time). */
  private readonly heat: Float32Array;
  private readonly heatAt: Float64Array;
  /** Item family -> [familiarity 0..1, last use epoch ms]. */
  private readonly familiar = new Map<string, [number, number]>();

  constructor(readonly index: SkillIndex) {
    const n = index.size;
    this.value = new Float32Array(n);
    this.peak = new Float32Array(n);
    this.lastUse = new Float64Array(n);
    this.lastTarget = new Int32Array(n).fill(-1);
    this.heat = new Float32Array(n);
    this.heatAt = new Float64Array(n);
  }

  get(id: string): number {
    const i = this.index.of(id);
    return i < 0 ? 0 : this.value[i];
  }

  /**
   * One use of skill `i` against `targetKey` (any int naming the target; -1
   * for none) at `difficulty` (0..1). Returns the points gained (0..max).
   */
  train(i: number, difficulty: number, targetKey: number, nowMs: number): number {
    const r = this.index.rules;
    const g = r.gain;
    const m = this.value[i] / r.max;
    const d = difficulty - m;
    if (d < g.trivialBelow) return 0;
    const span = g.fullAt - g.trivialBelow;
    const challenge = span <= 0 ? 1 : Math.min(1, (d - g.trivialBelow) / span);

    let repeat = 1;
    if (targetKey >= 0 && this.lastTarget[i] === targetKey) {
      // Repeats recover linearly: the heat is gone after repeatRecoverMinutes idle.
      const recoverMs = g.repeatRecoverMinutes * MS_PER_MINUTE;
      const heat = recoverMs > 0 ? this.heat[i] * Math.max(0, 1 - (nowMs - this.heatAt[i]) / recoverMs) : 0;
      repeat = Math.pow(g.repeatFalloff, heat);
      this.heat[i] = heat + 1;
    } else {
      this.lastTarget[i] = targetKey;
      this.heat[i] = targetKey >= 0 ? 1 : 0;
    }
    this.heatAt[i] = nowMs;

    const relearn = this.value[i] < this.peak[i] ? r.decay.relearnMultiplier : 1;
    const gain = g.base * challenge * Math.pow(1 - m, g.topSlowdown) * repeat * relearn;
    this.add(i, gain, nowMs);
    const ri = this.index.relatedIdx[i];
    const rs = this.index.relatedShare[i];
    for (let k = 0; k < ri.length; k++) this.add(ri[k], gain * rs[k], nowMs);
    return gain;
  }

  /** Familiarity with an item family, 0..1. */
  familiarity(family: string): number {
    return this.familiar.get(family)?.[0] ?? 0;
  }

  /** Every family used, with its familiarity. */
  families(): [family: string, familiarity: number][] {
    return [...this.familiar].map(([f, [v]]) => [f, v]);
  }

  /** One use of an item of `family`. Returns the familiarity after it. */
  useFamily(family: string, nowMs: number): number {
    const f = Math.min(1, this.familiarity(family) + this.index.rules.familiarity.perUse);
    this.familiar.set(family, [f, nowMs]);
    return f;
  }

  private add(i: number, points: number, nowMs: number): void {
    const max = this.index.rules.max;
    const v = Math.min(max, this.value[i] + points);
    this.value[i] = v;
    if (v > this.peak[i]) this.peak[i] = v;
    this.lastUse[i] = nowMs;
  }

  /** Deteriorate unused skills as of `nowMs` (call on entering the world). */
  applyDecay(nowMs: number): void {
    const d = this.index.rules.decay;
    if (d.ratePerWeek <= 0) return;
    for (let i = 0; i < this.value.length; i++) {
      if (this.lastUse[i] <= 0 || this.value[i] <= 0) continue;
      const idleDays = (nowMs - this.lastUse[i]) / MS_PER_DAY;
      if (idleDays <= d.graceDays) continue;
      const weeks = (idleDays - d.graceDays) / 7;
      const floor = this.peak[i] * d.floorOfPeak;
      this.value[i] = Math.max(Math.min(this.value[i], floor), this.value[i] * Math.pow(1 - d.ratePerWeek, weeks));
      // Decay is applied once: count the idle time as spent.
      this.lastUse[i] = nowMs - d.graceDays * MS_PER_DAY;
    }
  }

  save(): SkillSave {
    const out: SkillSave = {};
    for (let i = 0; i < this.value.length; i++) {
      if (this.peak[i] <= 0) continue;
      out[this.index.ids[i]] = [Math.round(this.value[i] * 10), Math.round(this.peak[i] * 10), this.lastUse[i]];
    }
    for (const [family, [f, at]] of this.familiar) {
      const k = Math.round(f * 1000);
      if (k > 0) out[FAMILY_KEY + family] = [k, k, at];
    }
    return out;
  }

  load(s: SkillSave): void {
    for (const [id, [v, p, t]] of Object.entries(s)) {
      if (id.startsWith(FAMILY_KEY)) {
        this.familiar.set(id.slice(FAMILY_KEY.length), [Math.min(1, Math.max(0, v / 1000)), t]);
        continue;
      }
      const i = this.index.of(id);
      if (i < 0) continue;
      this.value[i] = v / 10;
      this.peak[i] = Math.max(p, v) / 10;
      this.lastUse[i] = t;
    }
  }
}
