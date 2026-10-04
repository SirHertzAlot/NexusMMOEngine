/**
 * BodySystem: body parts, injuries, bleeding and healing (M2,
 * docs/MASTERY-AND-COMBAT.md §4).
 *
 * Every character (Health and PlayerIntent: players, bots, creatures) gets
 * a Body the first tick it is seen: one health share per part of the
 * rules' body tree (`body.json`), each part's state (healthy, harmed,
 * maimed, dismembered), its open wound and the character's blood. Health
 * stays the one number everyone sees: it is always the parts combined,
 * `Σ share × hp × Health.max`.
 *
 * Damage comes in two ways:
 * - **On a part**: a blow (`applyBlow`, from CombatSystem) or a hard
 *   landing (`applyFall`). The rules' onInjury hook decides the part's new
 *   state; cuts and thrusts open a wound, a dismembering cut takes the part
 *   and everything below it and leaves a bleeding stump.
 * - **On the whole body**: anything else that writes Health directly
 *   (hunger, drowning, the admin console, a restored save). The change is
 *   spread over the parts: a loss scales every part down, a gain heals each
 *   part by what it is missing (never a lost part).
 *
 * Each tick, wounds bleed blood away (`bleedPerSecond`) until they clot
 * (`clotSeconds`; a stump never does), blood comes back while nothing
 * bleeds, and harmed parts that no longer bleed heal (`healPerSecond`).
 * Maimed parts wait for treatment (Medicine, M4). The character dies when a
 * part whose `atZero` is "death" reaches 0 or its blood runs out:
 * Health goes to 0 and DeathSystem takes it from there (`causeOf` says why).
 *
 * Injuries cost (`penalties`), written to the Injury component each tick:
 * a weakened leg (harmed below `harmedBelow`) slows, a useless one (maimed,
 * gone or at 0) slows more and stops jumping, two of them (or useless
 * hips) are a crawl; a weakened torso recovers stamina more slowly; the
 * arm that holds the main hand (`armFactor`) hits softer and less
 * precisely when weakened, and cannot attack when useless.
 *
 * Runs after CombatSystem and before DeathSystem, so a blow's death shows
 * the same tick.
 */

import { addComponent, defineComponent, defineQuery, hasComponent, Types } from "bitecs";
import { MAX_BODY_PARTS, type BodyRules, type DamageKind, type DeathInput, type PartState, type RespawnOutcome, type RuleHooks } from "@mmo-engine/rules";
import { Health, PlayerIntent } from "./components.js";
import type { SimSystem } from "./systems.js";
import type { SimWorld } from "./world.js";

/** Part states, as stored (2 bits each in Injury.bits). */
export const PART_STATES: readonly PartState[] = ["healthy", "harmed", "maimed", "dismembered"];
const HEALTHY = 0;
const HARMED = 1;
const MAIMED = 2;
const DISMEMBERED = 3;

/** An open wound on a part (Body.wound). */
export const Wound = { None: 0, Cut: 1, Thrust: 2, Stump: 3 } as const;

/** Injury.bits: set while any wound bleeds (above the 2 × 15 state bits). */
export const BLEEDING_BIT = 1 << 30;
/** Injury.flags: no jumping (a useless leg). */
export const NO_JUMP = 1;

/**
 * The body's state, server only (docs/MASTERY-AND-COMBAT.md §6). `hp` is
 * each part's health as a share of its own maximum (0..1), so a change of
 * Health.max (a buff) keeps every part's share. `clot` is the seconds left
 * before a part's wound stops bleeding (< 0: it never does by itself).
 * `seen` is the Health.current BodySystem last wrote: anything else is a
 * change from outside, spread over the parts.
 */
export const Body = defineComponent({
  hp: [Types.f32, MAX_BODY_PARTS],
  wound: [Types.ui8, MAX_BODY_PARTS],
  clot: [Types.f32, MAX_BODY_PARTS],
  blood: Types.f32,
  bloodMax: Types.f32,
  seen: Types.f32,
});

/**
 * What injuries show and cost. `bits`: 2 bits of state per part (part i at
 * bit 2i) and BLEEDING_BIT; `move` multiplies every speed the entity moves
 * at; `stamina` its stamina recovery; `flags` NO_JUMP.
 */
export const Injury = defineComponent({
  bits: Types.ui32,
  move: Types.f32,
  stamina: Types.f32,
  flags: Types.ui8,
});

/** One part, for the owner's `body` message. */
export interface PartView {
  id: string;
  name: string;
  /** Share of the part's health left, 0..1. */
  hp: number;
  state: PartState;
  bleeding: boolean;
}

export interface BodyView {
  parts: PartView[];
  blood: number;
  bloodMax: number;
}

/** What a blow did to the part it landed on. */
export interface BlowResult {
  part: string;
  state: PartState;
  /** Parts lost to this blow (the part and everything below it), when it dismembered. */
  lost: string[];
}

/** Parts the main and off hands are held by, and the arm above each. */
interface Layout {
  ids: string[];
  share: Float64Array;
  atZero: string[];
  /** Part index -> its parent's index (-1: the root). */
  parent: Int32Array;
  legs: number[];
  root: number;
  arms: Record<"main" | "off", number[]>;
  index: Map<string, number>;
}

function layoutOf(rules: BodyRules): Layout {
  const ids = rules.parts.map((p) => p.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const parent = Int32Array.from(rules.parts.map((p) => (p.parent === null ? -1 : index.get(p.parent)!)));
  const root = parent.indexOf(-1);
  const arm = (hand: "main" | "off"): number[] => {
    const out: number[] = [];
    for (let i = rules.parts.findIndex((p) => p.holds === hand); i >= 0 && i !== root; i = parent[i]) out.push(i);
    return out;
  };
  return {
    ids,
    share: Float64Array.from(rules.parts.map((p) => p.share)),
    atZero: rules.parts.map((p) => p.atZero),
    parent,
    legs: rules.parts.flatMap((p, i) => (p.atZero === "cannotStand" ? [i] : [])),
    root,
    arms: { main: arm("main"), off: arm("off") },
    index,
  };
}

/**
 * Make a body whole: every part healthy at full health, no wounds, full
 * blood (the admin `heal`). Health is the caller's to fill.
 */
export function restoreBody(sim: SimWorld, e: number): void {
  if (!hasComponent(sim.ecs, Body, e)) return;
  Body.hp[e].fill(1);
  Body.wound[e].fill(Wound.None);
  Body.blood[e] = Body.bloodMax[e];
  Injury.bits[e] = 0;
  Injury.move[e] = 1;
  Injury.stamina[e] = 1;
  Injury.flags[e] = 0;
}

/** Deterministic 0..1 stream for one blow (mulberry32 over tick and the two entities). */
export function blowRng(tick: number, a: number, b: number): () => number {
  let s = (Math.imul(tick ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 1, 0xc2b2ae35) ^ Math.imul(b + 7, 0x27d4eb2f)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class BodySystem implements SimSystem {
  readonly name = "body";
  private readonly query = defineQuery([Health, PlayerIntent]);
  private layout: Layout;
  /** Hands that became useless since the last drainDropped (what they hold falls). */
  private dropped: { e: number; hand: "main" | "off" }[] = [];
  /** Why each entity that died of its body did (cleared on reset). */
  private readonly causes = new Map<number, DeathInput>();

  constructor(
    private rules: BodyRules,
    private readonly hooks: RuleHooks,
  ) {
    this.layout = layoutOf(rules);
  }

  /** New body rules (hot reload): every body starts over, whole, at its current Health share. */
  setRules(sim: SimWorld, rules: BodyRules): void {
    this.rules = rules;
    this.layout = layoutOf(rules);
    const ids = this.query(sim.ecs);
    for (let i = 0; i < ids.length; i++) {
      const e = ids[i] as number;
      if (hasComponent(sim.ecs, Body, e)) this.init(e);
    }
  }

  /** The body part ids, in rules order. */
  get parts(): readonly string[] {
    return this.layout.ids;
  }

  /** The root part's id (where a blow with no aim goes). */
  get root(): string {
    return this.layout.ids[this.layout.root];
  }

  has(sim: SimWorld, e: number): boolean {
    return hasComponent(sim.ecs, Body, e);
  }

  /** Give `e` a body now (otherwise it gets one on the next step). */
  ensure(sim: SimWorld, e: number): void {
    if (hasComponent(sim.ecs, Body, e)) return;
    addComponent(sim.ecs, Body, e);
    addComponent(sim.ecs, Injury, e);
    this.init(e);
  }

  /** A part's state. */
  stateOf(e: number, part: string): PartState {
    const i = this.layout.index.get(part);
    return i === undefined ? "healthy" : PART_STATES[this.state(e, i)];
  }

  /** The parts that are gone. */
  dismembered(e: number): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < this.layout.ids.length; i++) if (this.state(e, i) === DISMEMBERED) out.add(this.layout.ids[i]);
    return out;
  }

  /**
   * How well the arm holding `hand` fights: 1 whole, `penalties.weakArm`
   * weakened, 0 useless (it cannot attack). A body with no such hand: 1.
   */
  armFactor(sim: SimWorld, e: number, hand: "main" | "off" = "main"): number {
    if (!hasComponent(sim.ecs, Body, e)) return 1;
    let f = 1;
    for (const i of this.layout.arms[hand]) {
      if (this.useless(e, i)) return 0;
      if (this.weak(e, i)) f = this.rules.penalties.weakArm;
    }
    return f;
  }

  /**
   * The hands that became useless (maimed, gone) since the last call: what
   * they hold should fall (the part's `atZero: "drop"`, §4.1).
   */
  drainDropped(): { e: number; hand: "main" | "off" }[] {
    const out = this.dropped;
    if (out.length > 0) this.dropped = [];
    return out;
  }

  /** Why `e`'s body killed it (for the rules' onDeath), if it did. */
  causeOf(e: number): DeathInput {
    return this.causes.get(e) ?? { cause: "other" };
  }

  /** Respawned: injuries cleared (and lost parts back) as the rules' onRespawn says. */
  respawned(sim: SimWorld, e: number, outcome: RespawnOutcome): void {
    if (!hasComponent(sim.ecs, Body, e)) return;
    this.causes.delete(e);
    const n = this.layout.ids.length;
    for (let i = 0; i < n; i++) {
      const s = this.state(e, i);
      if (outcome.clearInjuries || (outcome.restoreParts && s === DISMEMBERED)) {
        Body.hp[e][i] = 1;
        Body.wound[e][i] = Wound.None;
        this.setState(e, i, HEALTHY);
      }
    }
    if (outcome.clearInjuries) Body.blood[e] = Body.bloodMax[e];
    this.write(e);
  }

  /**
   * A blow of `amount` health points of `kind` lands on `part`. The rules'
   * onInjury decides the part's state; Health is updated now.
   */
  applyBlow(sim: SimWorld, e: number, part: string, kind: DamageKind, amount: number): BlowResult {
    this.ensure(sim, e);
    this.sync(e);
    const L = this.layout;
    let i = L.index.get(part) ?? L.root;
    // A part that is gone can't be struck: the blow lands on what it hung from.
    while (this.state(e, i) === DISMEMBERED && L.parent[i] >= 0) i = L.parent[i];
    const max = L.share[i] * Health.max[e];
    const before = this.state(e, i);
    const handsBefore = [this.armFactor(sim, e, "main"), this.armFactor(sim, e, "off")];
    const r = this.hooks.onInjury({ part: L.ids[i], kind, damage: amount, hp: Body.hp[e][i] * max, maxHp: max, state: PART_STATES[before] });
    const lost: string[] = [];
    if (r.state === "dismembered" && before !== DISMEMBERED) {
      for (const j of this.below(i)) {
        const id = L.ids[j];
        Body.hp[e][j] = 0;
        Body.wound[e][j] = Wound.None;
        this.setState(e, j, DISMEMBERED);
        lost.push(id);
      }
      Body.wound[e][i] = Wound.Stump;
      Body.clot[e][i] = -1;
    } else {
      Body.hp[e][i] = max > 0 ? Math.max(0, Math.min(1, r.hp / max)) : 0;
      this.setState(e, i, PART_STATES.indexOf(r.state));
      if (amount > 0 && (kind === "cut" || kind === "thrust")) this.openWound(e, i, kind);
    }
    if (!this.checkDeath(e)) this.write(e);
    if (handsBefore[0] > 0 && this.armFactor(sim, e, "main") === 0) this.dropped.push({ e, hand: "main" });
    if (handsBefore[1] > 0 && this.armFactor(sim, e, "off") === 0) this.dropped.push({ e, hand: "off" });
    return { part: L.ids[i], state: PART_STATES[this.state(e, i)], lost };
  }

  /** A landing at `speed` m/s: blunt damage above the safe speed, shared over the rules' fall parts. */
  applyFall(sim: SimWorld, e: number, speed: number): number {
    const f = this.rules.fall;
    if (speed <= f.safeSpeed || f.damagePerSpeed === 0 || !hasComponent(sim.ecs, Health, e) || Health.current[e] <= 0) return 0;
    const damage = (speed - f.safeSpeed) * f.damagePerSpeed;
    const split = Object.keys(f.parts).length > 0 ? Object.entries(f.parts) : this.layout.ids.map((id, i) => [id, this.layout.share[i]] as const);
    const total = split.reduce((s, [, w]) => s + w, 0);
    for (const [id, w] of split) {
      if (Health.current[e] <= 0) break;
      this.applyBlow(sim, e, id, "blunt", (damage * w) / total);
    }
    return damage;
  }

  /** The owner's view of the body (the `body` message). */
  view(e: number): BodyView {
    const L = this.layout;
    return {
      parts: L.ids.map((id, i) => ({
        id,
        name: this.rules.parts[i].name,
        hp: Body.hp[e][i],
        state: PART_STATES[this.state(e, i)],
        bleeding: this.bleeds(e, i),
      })),
      blood: Body.blood[e],
      bloodMax: Body.bloodMax[e],
    };
  }

  step(sim: SimWorld, dt: number): void {
    const ids = this.query(sim.ecs);
    if (this.causes.size > ids.length) {
      const live = new Set<number>(ids as unknown as number[]);
      for (const e of this.causes.keys()) if (!live.has(e)) this.causes.delete(e);
    }
    const L = this.layout;
    const n = L.ids.length;
    const { bleedPerSecond, regenPerSecond } = this.rules.blood;
    for (let k = 0; k < ids.length; k++) {
      const e = ids[k] as number;
      if (!hasComponent(sim.ecs, Body, e)) this.ensure(sim, e);
      if (Health.current[e] <= 0) {
        Body.seen[e] = Health.current[e];
        continue;
      }
      this.sync(e);

      // Wounds bleed until they clot; blood comes back once none do.
      let bleed = 0;
      for (let i = 0; i < n; i++) {
        const w = Body.wound[e][i];
        if (w === Wound.None) continue;
        bleed += w === Wound.Cut ? bleedPerSecond.cut : w === Wound.Thrust ? bleedPerSecond.thrust : bleedPerSecond.dismember;
        if (Body.clot[e][i] >= 0) {
          Body.clot[e][i] -= dt;
          if (Body.clot[e][i] <= 0) Body.wound[e][i] = Wound.None;
        }
      }
      if (bleed > 0) Body.blood[e] = Math.max(0, Body.blood[e] - bleed * dt);
      else Body.blood[e] = Math.min(Body.bloodMax[e], Body.blood[e] + regenPerSecond * dt);
      if (bleed > 0) Injury.bits[e] |= BLEEDING_BIT;
      else Injury.bits[e] &= ~BLEEDING_BIT;

      // Harmed parts that no longer bleed heal; healed through, they are healthy.
      const heal = this.rules.healPerSecond * dt;
      if (heal > 0) {
        for (let i = 0; i < n; i++) {
          if (this.state(e, i) !== HARMED || Body.wound[e][i] !== Wound.None) continue;
          Body.hp[e][i] = Math.min(1, Body.hp[e][i] + heal);
          if (Body.hp[e][i] >= 1) this.setState(e, i, HEALTHY);
        }
      }
      if (Body.blood[e] <= 0) {
        this.causes.set(e, { cause: "bleeding" });
        this.kill(e);
        continue;
      }
      if (this.checkDeath(e)) continue;
      this.write(e);
      this.penalise(e);
    }
  }

  // ------------------------------------------------------------ internals

  private state(e: number, i: number): number {
    return (Injury.bits[e] >>> (2 * i)) & 3;
  }

  private setState(e: number, i: number, s: number): void {
    Injury.bits[e] = ((Injury.bits[e] & ~(3 << (2 * i))) | (s << (2 * i))) >>> 0;
  }

  private bleeds(e: number, i: number): boolean {
    return Body.wound[e][i] !== Wound.None;
  }

  private weak(e: number, i: number): boolean {
    return Body.hp[e][i] < this.rules.harmedBelow;
  }

  private useless(e: number, i: number): boolean {
    const s = this.state(e, i);
    return s === MAIMED || s === DISMEMBERED || Body.hp[e][i] <= 0;
  }

  /** Part i and every part below it in the tree. */
  private below(i: number): number[] {
    const out = [i];
    const parent = this.layout.parent;
    for (let k = 0; k < out.length; k++) for (let j = 0; j < parent.length; j++) if (parent[j] === out[k]) out.push(j);
    return out;
  }

  private openWound(e: number, i: number, kind: "cut" | "thrust"): void {
    const w = kind === "cut" ? Wound.Cut : Wound.Thrust;
    if (Body.wound[e][i] === Wound.Stump) return;
    Body.wound[e][i] = Math.max(Body.wound[e][i], w);
    const clot = this.rules.blood.clotSeconds[Body.wound[e][i] === Wound.Thrust ? "thrust" : "cut"];
    Body.clot[e][i] = clot ?? -1;
  }

  /** Whole, at its current Health share: every part at that share, nothing bleeding. */
  private init(e: number): void {
    const n = this.layout.ids.length;
    const share = Health.max[e] > 0 ? Math.max(0, Math.min(1, Health.current[e] / Health.max[e])) : 1;
    Injury.bits[e] = 0;
    for (let i = 0; i < MAX_BODY_PARTS; i++) {
      Body.hp[e][i] = i < n ? share : 0;
      Body.wound[e][i] = Wound.None;
      Body.clot[e][i] = 0;
      if (i < n && share < 1) this.setState(e, i, HARMED);
    }
    Body.bloodMax[e] = this.rules.blood.max;
    Body.blood[e] = this.rules.blood.max;
    Injury.move[e] = 1;
    Injury.stamina[e] = 1;
    Injury.flags[e] = 0;
    this.causes.delete(e);
    this.write(e);
  }

  private total(e: number): number {
    let t = 0;
    const L = this.layout;
    for (let i = 0; i < L.ids.length; i++) t += L.share[i] * Body.hp[e][i];
    return t * Health.max[e];
  }

  /** Health = the parts combined. */
  private write(e: number): void {
    Health.current[e] = this.total(e);
    Body.seen[e] = Health.current[e];
  }

  /** Spread a Health change made elsewhere over the parts. */
  private sync(e: number): void {
    const target = Health.current[e];
    if (target === Body.seen[e]) return;
    const n = this.layout.ids.length;
    const now = this.total(e);
    if (Math.abs(target - now) <= 1e-4 * Math.max(1, Health.max[e])) {
      this.write(e);
      return;
    }
    if (target < now) {
      const k = now > 0 ? Math.max(0, target) / now : 0;
      for (let i = 0; i < n; i++) {
        if (this.state(e, i) === DISMEMBERED) continue;
        Body.hp[e][i] *= k;
        if (this.state(e, i) === HEALTHY && Body.hp[e][i] < 1) this.setState(e, i, HARMED);
      }
    } else {
      let missing = 0;
      for (let i = 0; i < n; i++) if (this.state(e, i) !== DISMEMBERED) missing += this.layout.share[i] * (1 - Body.hp[e][i]);
      const k = missing > 0 ? Math.min(1, (target - now) / (missing * Health.max[e])) : 0;
      for (let i = 0; i < n; i++) {
        if (this.state(e, i) === DISMEMBERED) continue;
        Body.hp[e][i] += (1 - Body.hp[e][i]) * k;
        if (k >= 1) Body.hp[e][i] = 1;
        if (this.state(e, i) === HARMED && Body.hp[e][i] >= 1) this.setState(e, i, HEALTHY);
      }
    }
    if (!this.checkDeath(e)) this.write(e);
  }

  /** A vital part at 0 (or gone) kills: Health to 0, the cause kept for DeathSystem. */
  private checkDeath(e: number): boolean {
    const L = this.layout;
    for (let i = 0; i < L.ids.length; i++) {
      if (L.atZero[i] !== "death") continue;
      if (Body.hp[e][i] <= 0 || this.state(e, i) === DISMEMBERED) {
        this.causes.set(e, { cause: "part", part: L.ids[i] });
        this.kill(e);
        return true;
      }
    }
    return false;
  }

  private kill(e: number): void {
    Health.current[e] = 0;
    Body.seen[e] = 0;
  }

  private penalise(e: number): void {
    const L = this.layout;
    const p = this.rules.penalties;
    let useless = 0;
    let weak = false;
    let crawl = false;
    for (const i of L.legs) {
      if (this.useless(e, i)) {
        useless++;
        // A useless part with legs hanging from it (the hips) is a crawl on its own.
        if (L.legs.some((j) => j !== i && L.parent[j] === i)) crawl = true;
      } else if (this.weak(e, i)) weak = true;
    }
    let move = 1;
    if (crawl || useless >= 2) move = p.crawl;
    else if (useless === 1) move = p.uselessLeg;
    else if (weak) move = p.weakLeg;
    Injury.move[e] = move;
    Injury.flags[e] = useless > 0 ? NO_JUMP : 0;
    Injury.stamina[e] = L.root >= 0 && this.weak(e, L.root) ? p.weakTorsoStamina : 1;
  }
}
