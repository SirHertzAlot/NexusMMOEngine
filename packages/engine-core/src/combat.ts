/**
 * CombatSystem — server-authoritative combat moves (protocol combat.ts):
 * attacks and their combos, the guard, the dodge roll.
 *
 * It reads each character's PlayerIntent buttons — Attack and Dodge act
 * on the press, Block while held — runs the move the character is in (the
 * Action component), and moves it: during a move the walk is scaled down
 * (the move's moveScale) and the move's own advance (a lunge, the roll)
 * carries the character along the move's facing. Clients only play the
 * clip of the move they are told about, from its start tick.
 *
 * Combos: an attack pressed in a hit's chain window is queued; when the
 * hit lands (branchAt) the queued hit starts — facing wherever the player
 * now looks — or, with nothing queued, the hit's recovery plays. New
 * moves start only on the ground.
 *
 * Runs after IntentSystem (which sets the walking velocity) and before
 * IntegrateSystem (which moves by it).
 *
 * Stances (M3): `setStance` picks the technique a character's blows use
 * (any item can cut, thrust or bludgeon, at its own fit for it) and the
 * part they aim at; precision decides whether they land there.
 *
 * Defence (M3): with skills, a facing guard is a contest (the rules'
 * resolveDefence): the defender's Blocking or Parrying, whichever is
 * better, against the attacker's technique. A win stops the blow
 * ("blocked", nothing lands); a loss lets part of it through as a hit.
 * Without skills a guard always takes GUARD_FACTOR of the blow. A parry
 * that wins can disarm (M4): the defender knows the `disarm` technique (a
 * discipline unlocks it) and is the much better fighter; the hit says
 * `disarmed` and the gateway drops what the attacker held.
 *
 * Familiarity (M4): each blow with an item builds familiarity with its
 * family, which the rules' computeDamage turns into a little extra fit.
 *
 * Damage (M2a): an attack move strikes once, on the tick its hitAt falls
 * (relative to Action.started). Every living target with a Health inside
 * the weapon's reach and the 120-degree cone ahead of the attacker's facing
 * takes the rules' computeDamage for the held weapon (a fist when empty
 * handed), against the torso: health is whole-body for now (decision D1).
 * A guard facing the blow takes GUARD_FACTOR of it; a roll inside its
 * i-frames takes none. Health stops at 0 (DeathSystem takes it from there,
 * M2b); the dead neither fight nor are struck. Each blow leaves
 * a HitEvent for the gateway to send (`drainHits`).
 *
 * Body parts (M2): with a BodySystem, a blow aimed at the body's root
 * (the torso) lands where the rules' resolveLanding puts it (precision from
 * the attacker's skill, lowered by a weakened sword arm; a deterministic
 * stream per tick and pair), takes that part's hit multiplier, and hurts
 * that part (BodySystem.applyBlow: harm, maim, dismember). A weakened arm
 * also hits softer, and a useless one cannot attack.
 */

import { defineQuery, hasComponent } from "bitecs";
import { combatMove, IntentButton, LocomotionMode, Move, moveTravel, type CombatMove } from "@mmo-engine/protocol";
import { engineDefaults, type CombatRules, type DamageInput, type ItemBaseRules, type PartState, type RuleHooks } from "@mmo-engine/rules";
import { Action, God, Health, Locomotion, PlayerIntent, Stamina, Transform, Velocity } from "./components.js";
import { blowRng, type BodySystem } from "./body.js";
import type { StaminaSystem } from "./stats/stamina-system.js";
import type { SimSystem } from "./systems.js";
import type { SimWorld } from "./world.js";

/** What a striker swings: the rules technique, the item's physics and its reach (m). */
export interface Weapon {
  technique: string;
  item: DamageInput["item"];
  reach: number;
  /** The item family familiarity builds with (its base: "sword", "axe"); absent: none. */
  family?: string;
}

/** A blow's outcome, for the gateway to tell clients. */
export interface HitEvent {
  tick: number;
  source: number;
  target: number;
  outcome: "hit" | "blocked" | "dodged";
  amount: number;
  /** With bodies: the part the blow landed on, its state after it, and the parts it cut off. */
  part?: string;
  state?: PartState;
  lost?: string[];
  /** A parry took the attacker's weapon (M4): what it holds in its main hand falls. */
  disarmed?: boolean;
}

/**
 * What resolving a blow takes from the rules (EG5/EG6): combat.json's
 * `resolution` and items.json's `unarmed` (the fist). The engine defaults
 * until a CombatDamage names the game's.
 */
export interface CombatTuning {
  resolution: CombatRules["resolution"];
  unarmed: ItemBaseRules;
}
const DEFAULTS = engineDefaults();
export const DEFAULT_COMBAT_TUNING: Readonly<CombatTuning> = Object.freeze({ resolution: DEFAULTS.combat.resolution, unarmed: DEFAULTS.items.unarmed });

/** Fraction of a blow a facing guard lets through (no combat skills), by default. */
export const GUARD_FACTOR = DEFAULT_COMBAT_TUNING.resolution.guardLetsThrough;
/** The attacking arm's own length added to the weapon's, by default. */
export const ARM_REACH = DEFAULT_COMBAT_TUNING.resolution.armReachM;

/** The weapon a bare hand is (items.json `unarmed`; reach is its length). */
function fistOf(u: ItemBaseRules): Weapon {
  return { technique: u.technique, item: { mass: u.mass, edge: u.edge, point: u.point, hardness: u.hardness }, reach: u.length, family: "fist" };
}

/** Combat skills (M3c): what a character knows feeds its blows, and using it trains it. */
export interface CombatSkills {
  /** The entity's skill `id`, 0..skills.max. */
  get(e: number, id: string): number;
  /** One use of skill `id` at `difficulty` (0..1) against target `key`. */
  train(e: number, id: string, difficulty: number, key: number): void;
  /** The skill a technique runs on ("cut" -> "cutting"), if any. */
  techniqueSkill(technique: string): string | undefined;
  /** Familiarity with an item family, 0..1 (M4); absent: 0. */
  familiarity?(e: number, family: string): number;
  /** One blow with an item of `family` (M4). */
  useFamily?(e: number, family: string): void;
  /** Whether `e` can use a special technique now ("disarm"), from its disciplines (M4). */
  knows?(e: number, technique: string): boolean;
}

/** How hard a fight is taken to be for training, by default (combat.json `resolution.fightDifficulty`). */
export const FIGHT_DIFFICULTY = DEFAULT_COMBAT_TUNING.resolution.fightDifficulty;

export interface CombatDamage {
  hooks: RuleHooks;
  /** The weapon an entity holds; null or absent means fists. */
  weaponOf?: (e: number) => Weapon | null;
  /** The share of a blow the target's worn armour lets through (0..1); absent means 1. */
  armourOf?: (target: number) => number;
  /** Skills behind power and defence; absent means skill 0 and no training. */
  skills?: CombatSkills;
  /** Body parts (M2): blows land on parts; absent means whole-body Health. */
  body?: BodySystem;
  /** The rules' technique ids (a stance may name only these); absent: no stances. */
  techniques?: () => readonly string[];
  /**
   * PvP gate (duel.ts): whether `source` may hurt `target`. Absent means
   * everyone may hit everyone (the historical behaviour).
   */
  canHit?: (source: number, target: number) => boolean;
  /**
   * Damage scaler (status.ts): multiplies the final amount, e.g. from
   * buffs/debuffs. Absent means 1.
   */
  damageScale?: (source: number, target: number) => number;
  /** The rules a blow is resolved by, read each strike (a reload applies at once); absent: the engine defaults. */
  tuning?: () => CombatTuning;
}

/** How an entity strikes (M3, catalog 0x19): its own technique and aim, or the defaults. */
export interface Stance {
  technique?: string;
  aim?: string;
}

export class CombatSystem implements SimSystem {
  readonly name = "combat";
  private readonly query = defineQuery([PlayerIntent, Velocity, Action]);
  /** Buttons held last tick, per entity (presses are the new bits). */
  private readonly held = new Map<number, number>();
  /** Entities with a follow-up attack queued. */
  private readonly queued = new Set<number>();
  private readonly targets = defineQuery([Transform, Health]);
  private hits: HitEvent[] = [];
  /** The last entity to damage each target. */
  private readonly attackers = new Map<number, number>();
  /** Chosen techniques and aims (absent: the weapon's technique, the body's root). */
  private readonly stances = new Map<number, Stance>();
  /** The fist, rebuilt when the rules' `unarmed` changes. */
  private fist: { from: ItemBaseRules; weapon: Weapon } | null = null;

  constructor(
    private readonly tickHz = 30,
    /** Stamina gate (absent in unit tests: every move fires). */
    private readonly stamina?: StaminaSystem,
    /** Damage rules (absent in some unit tests: blows land nothing). */
    private readonly damage?: CombatDamage,
  ) {}

  /** Who last hurt `e` (for death credit), if anyone. */
  lastAttacker(e: number): number | undefined {
    return this.attackers.get(e);
  }

  /**
   * Choose how `e` strikes (M3): a field left undefined is unchanged, null
   * resets it. Returns an error for an unknown technique or body part.
   */
  setStance(e: number, technique: string | null | undefined, aim: string | null | undefined): string | null {
    const known = this.damage?.techniques?.() ?? [];
    if (typeof technique === "string" && !known.includes(technique)) return `no technique "${technique}" (${known.join(", ")})`;
    const parts = this.damage?.body?.parts ?? [];
    if (typeof aim === "string" && !parts.includes(aim)) return `no body part "${aim}"`;
    const st = { ...this.stances.get(e) };
    if (technique !== undefined) st.technique = technique ?? undefined;
    if (aim !== undefined) st.aim = aim ?? undefined;
    if (st.technique === undefined && st.aim === undefined) this.stances.delete(e);
    else this.stances.set(e, st);
    return null;
  }

  /** How `e` strikes now. */
  stanceOf(e: number): Stance {
    return this.stances.get(e) ?? {};
  }

  /** The blows struck since the last call. */
  drainHits(): HitEvent[] {
    const out = this.hits;
    if (out.length > 0) this.hits = [];
    return out;
  }

  step(sim: SimWorld, dt: number): void {
    const eids = this.query(sim.ecs);
    if (this.held.size > eids.length) {
      const live = new Set<number>(eids as unknown as number[]);
      for (const e of this.held.keys()) if (!live.has(e)) this.held.delete(e);
      for (const e of this.queued) if (!live.has(e)) this.queued.delete(e);
      for (const e of this.stances.keys()) if (!live.has(e)) this.stances.delete(e);
    }
    const tick = sim.currentTick;
    for (let i = 0; i < eids.length; i++) {
      const e = eids[i] as number;
      if (hasComponent(sim.ecs, Health, e) && Health.current[e] <= 0) continue; // the dead do not fight
      const buttons = PlayerIntent.buttons[e];
      const pressed = buttons & ~(this.held.get(e) ?? 0);
      this.held.set(e, buttons);
      const look = PlayerIntent.lookYaw[e];

      let move = combatMove(Action.move[e]);
      let t = move ? (tick - Action.started[e]) / this.tickHz : 0;
      if (move) {
        if ((pressed & IntentButton.Attack) !== 0 && move.chain && t >= move.chain.from && t <= move.chain.to) {
          this.queued.add(e);
        }
        if (move.held) {
          if ((buttons & IntentButton.Block) === 0) move = this.end(e);
          else if ((pressed & IntentButton.Attack) !== 0) move = this.start(sim, e, Move.ShieldBash, look);
          else Action.yaw[e] = look; // a guard faces where you look
        } else if (move.branchAt !== undefined && t >= move.branchAt && (this.queued.has(e) || move.recovery !== undefined)) {
          move = this.queued.has(e) && move.chain
            ? this.start(sim, e, move.chain.next, look)
            : move.recovery !== undefined
              ? this.start(sim, e, move.recovery, Action.yaw[e])
              : move;
        } else if (t >= move.duration) {
          move = this.end(e);
        }
        if (move && Action.started[e] === tick) t = 0;
      }

      const grounded = !hasComponent(sim.ecs, Locomotion, e) || Locomotion.mode[e] === LocomotionMode.Ground;
      if (!move && grounded) {
        const mx = PlayerIntent.mx[e];
        const mz = PlayerIntent.mz[e];
        if ((pressed & IntentButton.Dodge) !== 0) {
          move = this.start(sim, e, Move.Roll, mx !== 0 || mz !== 0 ? Math.atan2(mx, mz) : look);
        } else if ((pressed & IntentButton.Attack) !== 0) {
          move = this.start(sim, e, Move.SwordA, look);
        } else if ((buttons & IntentButton.Block) !== 0) {
          move = this.start(sim, e, Move.Guard, look);
        }
        t = 0;
      }

      if (move && this.damage && move.hitAt !== undefined && tick === Action.started[e] + Math.round(move.hitAt * this.tickHz)) {
        this.strike(sim, e, tick);
      }

      if (move) {
        // Walking slowed to the move's allowance, plus the move's own advance
        // over this tick, along its facing.
        Velocity.lx[e] *= move.moveScale;
        Velocity.lz[e] *= move.moveScale;
        const d = moveTravel(move, t + dt) - moveTravel(move, t);
        if (d !== 0) {
          const yaw = Action.yaw[e];
          Velocity.lx[e] += (Math.sin(yaw) * d) / dt;
          Velocity.lz[e] += (Math.cos(yaw) * d) / dt;
        }
      }
    }
  }

  private strike(sim: SimWorld, e: number, tick: number): void {
    const dmg = this.damage!;
    const tuning = dmg.tuning?.() ?? DEFAULT_COMBAT_TUNING;
    const res = tuning.resolution;
    const fightDifficulty = res.fightDifficulty;
    const holding = dmg.weaponOf?.(e) ?? null;
    if (this.fist?.from !== tuning.unarmed) this.fist = { from: tuning.unarmed, weapon: fistOf(tuning.unarmed) };
    const held = holding ?? this.fist.weapon;
    // A chosen technique (M3): any item can be swung any way; its fit for it is the item's.
    const stance = this.stances.get(e);
    const w = stance?.technique ? { ...held, technique: stance.technique } : held;
    const reach = w.reach + res.armReachM;
    const coneCos = Math.cos((res.coneDegrees * Math.PI) / 180);
    const yaw = Action.yaw[e];
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const ids = this.targets(sim.ecs);
    for (let i = 0; i < ids.length; i++) {
      const t = ids[i] as number;
      if (t === e || Health.current[t] <= 0) continue;
      if (dmg.canHit && !dmg.canHit(e, t)) continue; // PvP gate: duels and hostile pairs only
      const dx = Transform.px[t] - Transform.px[e];
      const dz = Transform.pz[t] - Transform.pz[e];
      const d = Math.hypot(dx, dz);
      if (d > reach || Math.abs(Transform.py[t] - Transform.py[e]) > res.maxHeightDifferenceM) continue;
      if (d > 1e-4 && (dx * fx + dz * fz) / d < coneCos) continue;
      let outcome: HitEvent["outcome"] = "hit";
      let amount = 0;
      let part: string | undefined;
      let state: PartState | undefined;
      let lost: string[] | undefined;
      let disarmed = false;
      const tm = hasComponent(sim.ecs, Action, t) ? combatMove(Action.move[t]) : undefined;
      const tt = tm ? (tick - Action.started[t]) / this.tickHz : 0;
      if (tm?.iframes && tt >= tm.iframes.from && tt <= tm.iframes.to) {
        outcome = "dodged";
        dmg.skills?.train(t, "evading", fightDifficulty, e);
      } else {
        const sk = dmg.skills;
        const weaponSkill = sk?.techniqueSkill(w.technique);
        const skill = weaponSkill ? sk!.get(e, weaponSkill) : 0;
        const body = dmg.body;
        const arm = body ? body.armFactor(sim, e) : 1;
        part = body
          ? dmg.hooks.resolveLanding({ aim: stance?.aim ?? body.root, skill, rng: blowRng(tick, e, t), dismembered: body.dismembered(t), precisionFactor: arm })
          : "torso";
        const familiarity = w.family && sk?.familiarity ? sk.familiarity(e, w.family) : 0;
        const armourFactor = dmg.armourOf?.(t) ?? 1;
        const blow = dmg.hooks.computeDamage({ technique: w.technique, skill, item: w.item, part, armourFactor, familiarity });
        if (w.family) sk?.useFamily?.(e, w.family);
        amount = blow.amount * arm;
        // The guard holds only against what it faces; a landed block trains Blocking.
        if (tm?.kind === "guard" && -(dx * Math.sin(Action.yaw[t]) + dz * Math.cos(Action.yaw[t])) >= 0) {
          if (sk) {
            // A contest (M3): the defender's better of Blocking and Parrying
            // against the attacker's technique; a win stops the blow, a loss
            // softens it. Either way the defence is used for real and trains.
            const guard = sk.get(t, "parrying") > sk.get(t, "blocking") ? "parrying" : "blocking";
            const canDisarm = guard === "parrying" && holding !== null && (sk.knows?.(t, "disarm") ?? false);
            const d = dmg.hooks.resolveDefence({ attackSkill: skill, defenceSkill: sk.get(t, guard), rng: blowRng(tick, t, e), canDisarm });
            if (d.stopped) outcome = "blocked";
            if (d.disarms && canDisarm) disarmed = true;
            amount *= d.letsThrough;
            sk.train(t, guard, fightDifficulty, e);
          } else {
            outcome = "blocked";
            amount *= res.guardLetsThrough;
          }
        }
        if (weaponSkill) sk!.train(e, weaponSkill, fightDifficulty, t);
        // Status effects (status.ts): buffs/debuffs scale the landed blow.
        amount *= dmg.damageScale?.(e, t) ?? 1;
        if (body && amount > 0) {
          const r = body.applyBlow(sim, t, part, blow.kind, amount);
          part = r.part;
          state = r.state;
          if (r.lost.length > 0) lost = r.lost;
        } else if (!body) {
          if (!hasComponent(sim.ecs, God, t)) Health.current[t] = Math.max(0, Health.current[t] - amount);
        }
        this.attackers.set(t, e);
      }
      const hit: HitEvent = { tick, source: e, target: t, outcome, amount };
      if (this.damage?.body && part !== undefined && state !== undefined) {
        hit.part = part;
        hit.state = state;
        if (lost) hit.lost = lost;
      }
      if (disarmed) hit.disarmed = true;
      this.hits.push(hit);
    }
  }

  private start(sim: SimWorld, e: number, id: number, yaw: number): CombatMove | undefined {
    // Stamina gate (U2): dodges and attacks spend at move start — every
    // start funnels through here, chains and recoveries included, while
    // guards stay free. A denied start fires nothing (returns undefined).
    const def = combatMove(id);
    // A useless sword arm (maimed, gone) cannot attack.
    if (def?.kind === "attack" && this.damage?.body && this.damage.body.armFactor(sim, e) === 0) return undefined;
    // Entities without a pool (bots) fence nothing: gating is for stamina
    // bearers only, so bot behaviour is unchanged.
    if (def && this.stamina && hasComponent(sim.ecs, Stamina, e)) {
      const costs = sim.movement.stamina;
      const cost = def.kind === "dodge" ? costs.dodgeCost : def.kind === "attack" ? costs.attackCost : 0;
      if (cost > 0 && !this.stamina.spend(sim, e, cost)) return undefined;
    }
    Action.move[e] = id;
    Action.started[e] = sim.currentTick;
    Action.seq[e] = (Action.seq[e] + 1) & 0xff;
    Action.yaw[e] = yaw;
    this.queued.delete(e);
    return combatMove(id);
  }

  private end(e: number): undefined {
    Action.move[e] = Move.None;
    this.queued.delete(e);
    return undefined;
  }
}
