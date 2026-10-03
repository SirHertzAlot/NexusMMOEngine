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
 * Damage (M2a): an attack move strikes once, on the tick its hitAt falls
 * (relative to Action.started). Every living target with a Health inside
 * the weapon's reach and the 120-degree cone ahead of the attacker's facing
 * takes the rules' computeDamage for the held weapon (a fist when empty
 * handed), against the torso: health is whole-body for now (decision D1).
 * A guard facing the blow takes GUARD_FACTOR of it; a roll inside its
 * i-frames takes none. Health stops at 0 (DeathSystem takes it from there,
 * M2b); the dead neither fight nor are struck. Each blow leaves
 * a HitEvent for the gateway to send (`drainHits`).
 */

import { defineQuery, hasComponent } from "bitecs";
import { combatMove, IntentButton, LocomotionMode, Move, moveTravel, type CombatMove } from "@mmo-engine/protocol";
import type { DamageInput, RuleHooks } from "@mmo-engine/rules";
import { Action, Health, Locomotion, PlayerIntent, Stamina, Transform, Velocity } from "./components.js";
import { ATTACK_COST, DODGE_COST, type StaminaSystem } from "./stats/stamina-system.js";
import type { SimSystem } from "./systems.js";
import type { SimWorld } from "./world.js";

/** What a striker swings: the rules technique, the item's physics and its reach (m). */
export interface Weapon {
  technique: string;
  item: DamageInput["item"];
  reach: number;
}

/** A blow's outcome, for the gateway to tell clients. */
export interface HitEvent {
  tick: number;
  source: number;
  target: number;
  outcome: "hit" | "blocked" | "dodged";
  amount: number;
}

/** Fraction of a blow a facing guard lets through. */
export const GUARD_FACTOR = 0.25;
/** The attacking arm's own length added to the weapon's. */
export const ARM_REACH = 0.6;
/** cos(60 degrees): targets within 60 degrees either side of the facing. */
const CONE_COS = 0.5;
/** Targets further than this above or below are out of reach. */
const MAX_DY = 2;
const FIST: Weapon = { technique: "bludgeon", item: { mass: 0.5, edge: 0, point: 0, hardness: 0.3 }, reach: 0.8 };

/** Combat skills (M3c): what a character knows feeds its blows, and using it trains it. */
export interface CombatSkills {
  /** The entity's skill `id`, 0..skills.max. */
  get(e: number, id: string): number;
  /** One use of skill `id` at `difficulty` (0..1) against target `key`. */
  train(e: number, id: string, difficulty: number, key: number): void;
  /** The skill a technique runs on ("cut" -> "cutting"), if any. */
  techniqueSkill(technique: string): string | undefined;
}

/** How hard a fight is taken to be for training (proposed default; a creature-level rule later). */
export const FIGHT_DIFFICULTY = 0.5;

export interface CombatDamage {
  hooks: RuleHooks;
  /** The weapon an entity holds; null or absent means fists. */
  weaponOf?: (e: number) => Weapon | null;
  /** Skills behind power and defence; absent means skill 0 and no training. */
  skills?: CombatSkills;
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
    const w = dmg.weaponOf?.(e) ?? FIST;
    const reach = w.reach + ARM_REACH;
    const yaw = Action.yaw[e];
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const ids = this.targets(sim.ecs);
    for (let i = 0; i < ids.length; i++) {
      const t = ids[i] as number;
      if (t === e || Health.current[t] <= 0) continue;
      const dx = Transform.px[t] - Transform.px[e];
      const dz = Transform.pz[t] - Transform.pz[e];
      const d = Math.hypot(dx, dz);
      if (d > reach || Math.abs(Transform.py[t] - Transform.py[e]) > MAX_DY) continue;
      if (d > 1e-4 && (dx * fx + dz * fz) / d < CONE_COS) continue;
      let outcome: HitEvent["outcome"] = "hit";
      let amount = 0;
      const tm = hasComponent(sim.ecs, Action, t) ? combatMove(Action.move[t]) : undefined;
      const tt = tm ? (tick - Action.started[t]) / this.tickHz : 0;
      if (tm?.iframes && tt >= tm.iframes.from && tt <= tm.iframes.to) {
        outcome = "dodged";
        dmg.skills?.train(t, "evading", FIGHT_DIFFICULTY, e);
      } else {
        const sk = dmg.skills;
        const weaponSkill = sk?.techniqueSkill(w.technique);
        amount = dmg.hooks.computeDamage({ technique: w.technique, skill: weaponSkill ? sk!.get(e, weaponSkill) : 0, item: w.item, part: "torso" }).amount;
        // The guard holds only against what it faces; a landed block trains Blocking.
        if (tm?.kind === "guard" && -(dx * Math.sin(Action.yaw[t]) + dz * Math.cos(Action.yaw[t])) >= 0) {
          outcome = "blocked";
          amount *= GUARD_FACTOR;
          sk?.train(t, "blocking", FIGHT_DIFFICULTY, e);
        }
        if (weaponSkill) sk!.train(e, weaponSkill, FIGHT_DIFFICULTY, t);
        Health.current[t] = Math.max(0, Health.current[t] - amount);
        this.attackers.set(t, e);
      }
      this.hits.push({ tick, source: e, target: t, outcome, amount });
    }
  }

  private start(sim: SimWorld, e: number, id: number, yaw: number): CombatMove | undefined {
    // Stamina gate (U2): dodges and attacks spend at move start — every
    // start funnels through here, chains and recoveries included, while
    // guards stay free. A denied start fires nothing (returns undefined).
    const def = combatMove(id);
    // Entities without a pool (bots) fence nothing: gating is for stamina
    // bearers only, so bot behaviour is unchanged.
    if (def && this.stamina && hasComponent(sim.ecs, Stamina, e)) {
      const cost = def.kind === "dodge" ? DODGE_COST : def.kind === "attack" ? ATTACK_COST : 0;
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
