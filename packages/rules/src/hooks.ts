/**
 * Hooks: the decisions a game may want to make in code rather than data.
 * The engine ships a default for each, computed from the rules (the
 * formulas of docs/MASTERY-AND-COMBAT.md); a game replaces only what it
 * needs, and its replacement is handed the default so it can wrap it:
 *
 *   createHooks(rules, {
 *     computeDamage: (input, base) => base(input) * (input.part === "head" ? 1.1 : 1),
 *   });
 *
 * Everything here is pure: the same input gives the same answer (random
 * choices take their `rng` from the caller, seeded by tick and entities).
 */

import type { BodyPart, DamageKind, Rules } from "./schemas.js";

export type PartState = "healthy" | "harmed" | "maimed" | "dismembered";

export interface ItemProps {
  /** kg */
  mass: number;
  edge: number;
  point: number;
  hardness: number;
}

export interface DamageInput {
  /** A combat technique id ("cut", "thrust", "bludgeon" by default). */
  technique: string;
  /** The attacker's skill in that technique, 0..skills.max. */
  skill: number;
  item: ItemProps;
  /** Where the blow landed (a body part id). */
  part: string;
  /** Share of the blow that gets through armour (1 = none worn). */
  armourFactor?: number;
  /** Familiarity with this item family, 0..1 (adds up to familiarity.maxFitBonus fit). */
  familiarity?: number;
}

export interface DamageResult {
  amount: number;
  kind: DamageKind;
}

export interface LandingInput {
  /** The part aimed at. */
  aim: string;
  skill: number;
  /** 0..1 uniform, deterministic per blow. */
  rng: () => number;
  /** Parts already gone: never hit (a blow aimed there lands on the parent). */
  dismembered?: ReadonlySet<string>;
  /** Multiplies precision (e.g. 0.75 for a harmed sword arm). */
  precisionFactor?: number;
}

export interface DefenceInput {
  /** The attacker's skill in its technique, and the defender's in its defence, 0..skills.max. */
  attackSkill: number;
  defenceSkill: number;
  /** 0..1 uniform, deterministic per blow. */
  rng: () => number;
  /** The defender parries (not blocks) and knows the `disarm` technique. */
  canDisarm?: boolean;
}

export interface DefenceResult {
  /** The guard stopped the blow. */
  stopped: boolean;
  /** Share of the blow that gets through (0 when stopped). */
  letsThrough: number;
  /** The attacker loses what it holds in its main hand. */
  disarms: boolean;
}

export type TreatmentKind = "bandage" | "stump" | "set";

export interface TreatmentInput {
  kind: TreatmentKind;
  /** The healer's Medicine, 0..skills.max. */
  skill: number;
  /** 0..1 uniform, deterministic per treatment. */
  rng: () => number;
}

export interface TreatmentResult {
  /** How long the treatment takes. */
  seconds: number;
  /** Whether it works when that time is up. */
  success: boolean;
}

export interface GainInput {
  /** Current skill, 0..skills.max. */
  skill: number;
  /** The highest it has been (relearning below it is faster). */
  peak: number;
  /** How hard the task was, on the same 0..1 scale as skill/max. */
  difficulty: number;
  /** Uses on this same target within skills.gain.repeatRecoverMinutes. */
  recentUses?: number;
}

export interface InjuryInput {
  part: string;
  kind: DamageKind;
  damage: number;
  /** The part's health before the blow, and its maximum. */
  hp: number;
  maxHp: number;
  state: PartState;
}

export interface InjuryResult {
  state: PartState;
  hp: number;
}

export interface DeathInput {
  cause: "part" | "bleeding" | "other";
  /** The part whose loss killed, when cause is "part". */
  part?: string;
}

export interface DeathOutcome {
  respawnInSeconds: number;
  respawnAt: Rules["death"]["respawn"]["at"];
  keepSkills: boolean;
  items: Rules["death"]["keep"]["items"];
  itemLoss: number;
  keepInjuries: boolean;
  record: boolean;
}

export interface RespawnInput {
  outcome: DeathOutcome;
}

export interface RespawnOutcome {
  clearInjuries: boolean;
  /** Dismembered parts grow back. */
  restoreParts: boolean;
}

export interface RuleHooks {
  computeDamage(input: DamageInput): DamageResult;
  resolveLanding(input: LandingInput): string;
  resolveDefence(input: DefenceInput): DefenceResult;
  resolveTreatment(input: TreatmentInput): TreatmentResult;
  skillGain(input: GainInput): number;
  onInjury(input: InjuryInput): InjuryResult;
  onDeath(input: DeathInput): DeathOutcome;
  onRespawn(input: RespawnInput): RespawnOutcome;
}

export type HookOverrides = {
  [K in keyof RuleHooks]?: (input: Parameters<RuleHooks[K]>[0], base: RuleHooks[K]) => ReturnType<RuleHooks[K]>;
};

// ------------------------------------------------------------- formulas

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** fit_eff = fit + (1 - fit) × closes × m^power: mastery overcomes a poor tool. */
export function effectiveFit(rules: Rules, fit: number, m: number): number {
  const f = rules.combat.fit;
  const base = clamp01(fit);
  return base + (1 - base) * f.closes * Math.pow(clamp01(m), f.masteryPower);
}

/** power = novice + masterBonus × m^curve. */
export function masteryPower(rules: Rules, m: number): number {
  const p = rules.combat.power;
  return p.novice + p.masterBonus * Math.pow(clamp01(m), p.curve);
}

/** Chance the blow lands where it was aimed. */
export function precision(rules: Rules, m: number, factor = 1): number {
  const p = rules.combat.precision;
  return clamp01((p.novice + p.masterBonus * clamp01(m)) * factor);
}

/** Chance a facing guard stops a blow: base + perSkill × (m_defence − m_attack), within [min, max]. */
export function defenceChance(rules: Rules, defence: number, attack: number): number {
  const d = rules.combat.defence;
  return Math.max(d.min, Math.min(d.max, d.base + d.perSkill * (clamp01(defence) - clamp01(attack))));
}

/** Chance a treatment of `kind` by a healer at Medicine fraction `m` works. */
export function treatmentChance(rules: Rules, kind: TreatmentKind, m: number): number {
  const t = rules.body.treatment;
  return Math.max(t.chance.min, Math.min(1, t.chance.base + t.chance.perSkill * clamp01(m) - t[kind].difficulty));
}

/** Seconds a treatment of `kind` takes a healer at Medicine fraction `m`. */
export function treatmentSeconds(rules: Rules, kind: TreatmentKind, m: number): number {
  const t = rules.body.treatment;
  return t[kind].seconds * (1 - t.fasterPerSkill * clamp01(m));
}

/**
 * A skill after `idleDays` without use: unchanged through the grace,
 * then `ratePerWeek` of the current value a week, never below
 * `floorOfPeak` of the peak (nor above where it was).
 */
export function decaySkill(rules: Rules, skill: number, peak: number, idleDays: number): number {
  const d = rules.skills.decay;
  if (idleDays <= d.graceDays || d.ratePerWeek === 0) return skill;
  const weeks = (idleDays - d.graceDays) / 7;
  const decayed = skill * Math.pow(1 - d.ratePerWeek, weeks);
  return Math.min(skill, Math.max(decayed, peak * d.floorOfPeak));
}

/** The part and every part below it in the body tree. */
export function partAndBelow(rules: Rules, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const p of rules.body.parts) if (p.parent === out[i]) out.push(p.id);
  }
  return out;
}

function part(rules: Rules, id: string): BodyPart {
  const p = rules.body.parts.find((x) => x.id === id);
  if (!p) throw new Error(`rules: no body part "${id}"`);
  return p;
}

// ------------------------------------------------------------- defaults

function defaultHooks(rules: Rules): RuleHooks {
  return {
    computeDamage({ technique, skill, item, part: partId, armourFactor = 1, familiarity = 0 }) {
      const t = rules.combat.techniques[technique];
      if (!t) throw new Error(`rules: no technique "${technique}"`);
      const m = skill / rules.skills.max;
      const fit = Math.min(1, item[t.property] + rules.skills.familiarity.maxFitBonus * clamp01(familiarity));
      const d = rules.combat.damage;
      const amount =
        d.base *
        Math.pow(Math.max(0, item.mass), d.massPower) *
        effectiveFit(rules, fit, m) *
        masteryPower(rules, m) *
        part(rules, partId).hitMultiplier *
        clamp01(armourFactor);
      return { amount, kind: t.damageKind };
    },

    resolveLanding({ aim, skill, rng, dismembered = new Set(), precisionFactor = 1 }) {
      // A blow aimed at a missing part goes for what it hung from.
      let target = part(rules, aim);
      while (dismembered.has(target.id) && target.parent !== null) target = part(rules, target.parent);
      if (rng() < precision(rules, skill / rules.skills.max, precisionFactor)) return target.id;
      // Missed the aim: a neighbour in the tree (parent or child), by size.
      const neighbours = rules.body.parts.filter(
        (p) => !dismembered.has(p.id) && (p.id === target.parent || p.parent === target.id),
      );
      if (neighbours.length === 0) return target.id;
      const total = neighbours.reduce((s, p) => s + p.share, 0);
      let pick = rng() * total;
      for (const p of neighbours) {
        pick -= p.share;
        if (pick < 0) return p.id;
      }
      return neighbours[neighbours.length - 1].id;
    },

    resolveDefence({ attackSkill, defenceSkill, rng, canDisarm = false }) {
      const max = rules.skills.max;
      const d = rules.combat.defence;
      if (rng() < defenceChance(rules, defenceSkill / max, attackSkill / max)) {
        return { stopped: true, letsThrough: 0, disarms: canDisarm && (defenceSkill - attackSkill) / max >= d.disarmMargin };
      }
      return { stopped: false, letsThrough: d.failedLetsThrough, disarms: false };
    },

    resolveTreatment({ kind, skill, rng }) {
      const m = skill / rules.skills.max;
      return { seconds: treatmentSeconds(rules, kind, m), success: rng() < treatmentChance(rules, kind, m) };
    },

    skillGain({ skill, peak, difficulty, recentUses = 0 }) {
      const g = rules.skills.gain;
      const m = clamp01(skill / rules.skills.max);
      const challenge = clamp01((difficulty - m - g.trivialBelow) / (g.fullAt - g.trivialBelow));
      if (challenge === 0) return 0;
      let gain = g.base * challenge * Math.pow(1 - m, g.topSlowdown) * Math.pow(g.repeatFalloff, Math.max(0, recentUses));
      if (skill < peak) gain = Math.min(gain * rules.skills.decay.relearnMultiplier, peak - skill + gain);
      return gain;
    },

    onInjury({ kind, damage, hp, maxHp, state }) {
      if (state === "dismembered") return { state, hp: 0 };
      const s = rules.body.severity[kind];
      const blow = maxHp > 0 ? damage / maxHp : 1;
      const after = Math.max(0, hp - damage);
      if (s.dismember !== null && (blow >= s.dismember || (state === "maimed" && s.dismemberMaimed !== null && blow >= s.dismemberMaimed))) {
        return { state: "dismembered", hp: 0 };
      }
      if (state === "maimed" || after <= 0 || (s.maim !== null && blow >= s.maim)) return { state: "maimed", hp: after };
      return { state: damage > 0 ? "harmed" : state, hp: after };
    },

    onDeath() {
      const d = rules.death;
      return {
        respawnInSeconds: d.respawn.delaySeconds,
        respawnAt: d.respawn.at,
        keepSkills: d.keep.skills,
        items: d.keep.items,
        itemLoss: d.keep.items === "partial" ? d.keep.partialLoss : d.keep.items === "drop" ? 1 : 0,
        keepInjuries: d.keep.injuries,
        record: d.recordDeaths,
      };
    },

    onRespawn({ outcome }) {
      return { clearInjuries: !outcome.keepInjuries, restoreParts: !outcome.keepInjuries };
    },
  };
}

/** The hooks for a rule set: the engine's defaults, with a game's overrides wrapped around them. */
export function createHooks(rules: Rules, overrides: HookOverrides = {}): RuleHooks {
  const base = defaultHooks(rules);
  const hooks = { ...base } as Record<keyof RuleHooks, unknown>;
  for (const name of Object.keys(overrides) as (keyof RuleHooks)[]) {
    const override = overrides[name] as ((input: unknown, base: unknown) => unknown) | undefined;
    if (!override) continue;
    const fallback = base[name].bind(base) as unknown;
    hooks[name] = (input: unknown) => override(input, fallback);
  }
  return hooks as RuleHooks;
}
