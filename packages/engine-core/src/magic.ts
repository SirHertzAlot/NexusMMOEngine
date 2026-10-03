/**
 * MagicSystem: mana and the spells that spend it (roadmap: mana and its
 * first spender; rules in `spells.json`).
 *
 * Every character (Health and PlayerIntent) gets a Mana pool the first
 * tick it is seen, full. Its maximum is the stat bound to the `maxMana`
 * drive (`stats.json`; else `spells.json` defaultMax), and current keeps
 * its share when the maximum changes. It comes back at the `manaRegen`
 * stat (else defaultRegen) per second while no cast is under way.
 *
 * `cast` starts a spell on the caster or on a character within the
 * spell's reach. The cast takes `castSeconds` and holds while the caster
 * stands still, keeps out of a fight and the target stays alive and in
 * reach; the mana is spent when it completes (a stopped cast costs
 * nothing), then the spell's cooldown starts. Effects:
 * - `heal`: Health back by `amount` × the caster's `spellPower` stat
 *   (BodySystem spreads it over the parts: it heals what is harmed, but
 *   neither sets a maimed part nor stops bleeding: that is Medicine).
 *
 * Casters and targets hear how each cast goes (`drainEvents`). The pool is
 * not saved: a character enters the world with it full.
 *
 * Runs after CombatSystem (a move started this tick stops a cast) and
 * before BodySystem (which spreads a heal over the parts that tick).
 */

import { addComponent, defineComponent, defineQuery, hasComponent, Types } from "bitecs";
import type { Spell, SpellsRules } from "@mmo-engine/rules";
import { Action, Health, PlayerIntent, Transform } from "./components.js";
import type { SimSystem } from "./systems.js";
import type { SimWorld } from "./world.js";

/** The mana pool, server only (the owner hears it as the 0x1c `mana` message). */
export const Mana = defineComponent({
  current: Types.f32,
  max: Types.f32,
});

/** A cast's progress, for the caster and the target. */
export interface SpellEvent {
  caster: number;
  target: number;
  spell: string;
  state: "started" | "done" | "stopped";
  /** Seconds it takes (started). */
  seconds?: number;
  /** Health restored (done, heal). */
  amount?: number;
}

interface Casting {
  spell: Spell;
  target: number;
  left: number;
}

export class MagicSystem implements SimSystem {
  readonly name = "magic";
  private readonly query = defineQuery([Health, PlayerIntent]);
  private byId = new Map<string, Spell>();
  private readonly casting = new Map<number, Casting>();
  /** Caster -> spell id -> tick it can be cast again. */
  private readonly cooldowns = new Map<number, Map<string, number>>();
  /** Stats version each pool's maximum was last read at. */
  private readonly synced = new Map<number, number>();
  private events: SpellEvent[] = [];

  constructor(
    private rules: SpellsRules,
    private readonly tickHz = 30,
  ) {
    this.setRules(rules);
  }

  /** New spells (rules hot reload); casts under way stop. */
  setRules(rules: SpellsRules): void {
    this.rules = rules;
    this.byId = new Map(rules.spells.map((s) => [s.id, s]));
    for (const caster of [...this.casting.keys()]) this.stop(caster);
    this.synced.clear();
  }

  /** The spells the rules know, in order. */
  get spells(): readonly Spell[] {
    return this.rules.spells;
  }

  has(sim: SimWorld, e: number): boolean {
    return hasComponent(sim.ecs, Mana, e);
  }

  /** Give `e` a full pool now (otherwise it gets one on the next step). */
  ensure(sim: SimWorld, e: number): void {
    if (hasComponent(sim.ecs, Mana, e)) return;
    addComponent(sim.ecs, Mana, e);
    const max = this.maxOf(sim, e);
    Mana.max[e] = max;
    Mana.current[e] = max;
    this.synced.set(e, sim.stats.version(e));
  }

  /** Fill `e`'s pool (the admin heal). */
  refill(sim: SimWorld, e: number): void {
    this.ensure(sim, e);
    Mana.current[e] = Mana.max[e];
  }

  /** Seconds before `caster` can cast `spell` again (0: now). */
  cooldownOf(sim: SimWorld, caster: number, spell: string): number {
    const at = this.cooldowns.get(caster)?.get(spell) ?? 0;
    return Math.max(0, (at - sim.currentTick) / this.tickHz);
  }

  /**
   * `caster` starts casting `spell` on `target` (itself when absent).
   * Replaces a cast under way. Returns why it can't, or null.
   */
  cast(sim: SimWorld, caster: number, spellId: string, target = caster): string | null {
    const spell = this.byId.get(spellId);
    if (!spell) return `no spell "${spellId}"`;
    if (!hasComponent(sim.ecs, Health, caster) || Health.current[caster] <= 0) return "you can't cast now";
    if (!hasComponent(sim.ecs, Health, target) || Health.current[target] <= 0) return "no one to cast on";
    if (spell.target === "self" && target !== caster) return `${spell.name} is cast on yourself only`;
    if (target !== caster && this.distance(caster, target) > spell.reach) return "too far away";
    if (spell.effect.kind === "heal" && Health.current[target] >= Health.max[target]) return target === caster ? "you are unhurt" : "they are unhurt";
    const wait = this.cooldownOf(sim, caster, spell.id);
    if (wait > 0) return `${spell.name} is ready in ${Math.ceil(wait)} s`;
    this.ensure(sim, caster);
    if (Mana.current[caster] < spell.mana) return "not enough mana";
    this.stop(caster);
    this.events.push({ caster, target, spell: spell.id, state: "started", seconds: spell.castSeconds });
    if (spell.castSeconds <= 0) this.complete(sim, caster, { spell, target, left: 0 });
    else this.casting.set(caster, { spell, target, left: spell.castSeconds });
    return null;
  }

  /** What `caster` is casting, if anything. */
  castingOf(caster: number): { spell: string; target: number; left: number } | null {
    const c = this.casting.get(caster);
    return c ? { spell: c.spell.id, target: c.target, left: c.left } : null;
  }

  /** Stop `caster`'s cast, if any (told as "stopped"; nothing is spent). */
  stop(caster: number): void {
    const c = this.casting.get(caster);
    if (!c) return;
    this.casting.delete(caster);
    this.events.push({ caster, target: c.target, spell: c.spell.id, state: "stopped" });
  }

  /** Casts started, completed and stopped since the last call. */
  drainEvents(): SpellEvent[] {
    const out = this.events;
    if (out.length > 0) this.events = [];
    return out;
  }

  step(sim: SimWorld, dt: number): void {
    const ids = this.query(sim.ecs);
    if (this.synced.size > ids.length || this.cooldowns.size > ids.length) {
      const live = new Set<number>(ids as unknown as number[]);
      for (const e of this.synced.keys()) if (!live.has(e)) this.synced.delete(e);
      for (const e of this.cooldowns.keys()) if (!live.has(e)) this.cooldowns.delete(e);
    }
    if (this.casting.size > 0) this.progress(sim, dt);
    for (let k = 0; k < ids.length; k++) {
      const e = ids[k] as number;
      if (!hasComponent(sim.ecs, Mana, e)) this.ensure(sim, e);
      // The maximum follows the stat; current keeps its share.
      const version = sim.stats.version(e);
      if (this.synced.get(e) !== version) {
        this.synced.set(e, version);
        const max = this.maxOf(sim, e);
        const old = Mana.max[e];
        Mana.current[e] = old > 0 ? (Mana.current[e] / old) * max : max;
        Mana.max[e] = max;
      }
      if (Health.current[e] <= 0 || this.casting.has(e) || Mana.current[e] >= Mana.max[e]) continue;
      const regen = sim.stats.get(e, "manaRegen") ?? this.rules.defaultRegen;
      Mana.current[e] = Math.min(Mana.max[e], Mana.current[e] + regen * dt);
    }
  }

  // ------------------------------------------------------------ internals

  private progress(sim: SimWorld, dt: number): void {
    for (const [caster, c] of [...this.casting]) {
      const t = c.target;
      const busy =
        (hasComponent(sim.ecs, PlayerIntent, caster) && (PlayerIntent.mx[caster] !== 0 || PlayerIntent.mz[caster] !== 0)) ||
        (hasComponent(sim.ecs, Action, caster) && Action.move[caster] !== 0);
      const gone = !hasComponent(sim.ecs, Health, caster) || Health.current[caster] <= 0 || !hasComponent(sim.ecs, Health, t) || Health.current[t] <= 0;
      if (gone || busy || (t !== caster && this.distance(caster, t) > c.spell.reach)) {
        this.stop(caster);
        continue;
      }
      c.left -= dt;
      if (c.left > 0) continue;
      this.casting.delete(caster);
      this.complete(sim, caster, c);
    }
  }

  private complete(sim: SimWorld, caster: number, c: Casting): void {
    // The mana may have gone meanwhile (a spell that drains it, later): then nothing happens.
    if (Mana.current[caster] < c.spell.mana) {
      this.events.push({ caster, target: c.target, spell: c.spell.id, state: "stopped" });
      return;
    }
    Mana.current[caster] -= c.spell.mana;
    let cd = this.cooldowns.get(caster);
    if (!cd) this.cooldowns.set(caster, (cd = new Map()));
    cd.set(c.spell.id, sim.currentTick + Math.round(c.spell.cooldownSeconds * this.tickHz));
    const ev: SpellEvent = { caster, target: c.target, spell: c.spell.id, state: "done" };
    const effect = c.spell.effect;
    if (effect.kind === "heal") {
      const t = c.target;
      const before = Health.current[t];
      Health.current[t] = Math.min(Health.max[t], before + effect.amount * (sim.stats.get(caster, "spellPower") ?? 1));
      ev.amount = Health.current[t] - before;
    }
    this.events.push(ev);
  }

  private maxOf(sim: SimWorld, e: number): number {
    return sim.stats.drive(e, "maxMana") ?? this.rules.defaultMax;
  }

  private distance(a: number, b: number): number {
    return Math.hypot(Transform.px[a] - Transform.px[b], Transform.pz[a] - Transform.pz[b]);
  }
}
