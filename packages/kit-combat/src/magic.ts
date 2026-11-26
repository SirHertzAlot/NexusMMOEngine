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

import { addComponent, defineQuery, hasComponent, Types } from "bitecs";
import { Action, BodyConfig, CharacterRef, Health, Locomotion, type MagicCreatureInfo, type MagicSystemHooks, Mana, PlayerIntent, type SimSystem, type SimWorld, type SpellEvent, Stamina, type SystemAccess, Transform, Velocity } from "@mmo-engine/engine-core";
import type { Spell, SpellsRules } from "@mmo-engine/rules";

const COLD_BIOMES = new Set(["mountains", "tundra", "snow", "alpine", "glacier", "arctic"]);
const COLD_KINDS = /(mountain|alpine|frost|ice|snow|yeti|glacier|blizzard)/i;
const ICE_VULNERABLE_KINDS = /(imp|fiend|infernal|pit-lord|flame|fire|magma|lava|orc|goblin|spider|swamp|slime)/i;

interface Casting {
  spell: Spell;
  target: number;
  left: number;
  path?: Array<[number, number, number]>;
}

/**
 * Clamp client-proposed spline waypoints inside `[origin]`'s authoritative spell
 * reach and bounded polyline arc length (never trusts client coordinates blindly).
 */
export function clampSpellPath(
  origin: readonly [number, number, number],
  rawPath: ReadonlyArray<readonly [number, number, number]>,
  maxReachM: number,
): Array<[number, number, number]> {
  const maxR = Math.max(1, maxReachM);
  const maxArc = maxR * 2.25;
  const out: Array<[number, number, number]> = [];
  let accArc = 0;

  for (let i = 0; i < rawPath.length && out.length < 16; i++) {
    const pt = rawPath[i]!;
    let x = Number.isFinite(pt[0]) ? pt[0] : origin[0];
    let y = Number.isFinite(pt[1]) ? pt[1] : origin[1];
    let z = Number.isFinite(pt[2]) ? pt[2] : origin[2];

    const dx = x - origin[0];
    const dy = y - origin[1];
    const dz = z - origin[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxR) {
      const s = maxR / dist;
      x = origin[0] + dx * s;
      y = origin[1] + dy * s;
      z = origin[2] + dz * s;
    }

    if (out.length > 0) {
      const prev = out[out.length - 1]!;
      const seg = Math.hypot(x - prev[0], y - prev[1], z - prev[2]);
      if (seg < 0.05) continue;
      if (accArc + seg > maxArc) {
        const rem = Math.max(0, maxArc - accArc);
        if (rem > 0.05) {
          const s = rem / seg;
          out.push([prev[0] + (x - prev[0]) * s, prev[1] + (y - prev[1]) * s, prev[2] + (z - prev[2]) * s]);
        }
        break;
      }
      accArc += seg;
    }
    out.push([x, y, z]);
  }

  if (out.length === 0) {
    out.push([origin[0], origin[1] + 0.5, origin[2]], [origin[0], origin[1] + 0.5, origin[2] + 2]);
  } else if (out.length === 1) {
    const p = out[0]!;
    out.push([p[0], p[1], p[2] + 1]);
  }
  return out;
}

export interface ActiveShield {
  spell: string;
  current: number;
  max: number;
  left: number;
}

export interface ActiveIceRing {
  caster: number;
  target: number;
  cx: number;
  cz: number;
  radius: number;
  hp: number;
  maxHp: number;
  left: number;
  wasAttacking: boolean;
}

interface ActiveFireHazard {
  caster: number;
  spell: string;
  x: number;
  z: number;
  radius: number;
  tickDamage: number;
  left: number;
  tickCarry: number;
  exposureTicks: Map<number, number>;
}

interface ActiveWaveHazard {
  caster: number;
  spell: string;
  path: Array<[number, number, number]>;
  elapsed: number;
  duration: number;
  radius: number;
  tickDamage: number;
  tickCarry: number;
  hitEntities: Set<number>;
}

interface ActiveIgnite {
  caster: number;
  dps: number;
  left: number;
  carry: number;
}

export class MagicSystem implements SimSystem {
  readonly name = "magic";
  readonly access: SystemAccess = {
    system: "magic",
    reads: [
      { component: "Action", fields: ["move"] },
      { component: "Health", fields: ["current", "max"] },
      { component: "Locomotion", fields: ["breath"] },
      { component: "Mana", fields: ["current", "max"] },
      { component: "PlayerIntent", fields: ["mx", "mz"] },
      { component: "Stamina", fields: ["current"] },
      { component: "Transform", fields: ["px", "py", "pz"] },
      { component: "Velocity", fields: ["lx", "lz"] },
    ],
    writes: [
      { component: "Health", fields: ["current"] },
      { component: "Locomotion", fields: ["breath"] },
      { component: "Mana", fields: ["current", "max"] },
      { component: "PlayerIntent", fields: ["mx", "mz"] },
      { component: "Stamina", fields: ["current"] },
      { component: "Transform", fields: ["px", "py", "pz"] },
      { component: "Velocity", fields: ["lx", "lz"] },
    ],
  };
  private readonly query = defineQuery([Health, PlayerIntent]);
  private readonly targetQuery = defineQuery([Health, Transform]);
  private byId = new Map<string, Spell>();
  private readonly casting = new Map<number, Casting>();
  /** Target entity -> active magical shield ward. */
  private readonly shields = new Map<number, ActiveShield>();
  /** Target entity -> destructible circular ice ring trap. */
  private readonly iceRings = new Map<number, ActiveIceRing>();
  /** Active burning inferno zones (Blaze Path pillars). */
  private readonly fireHazards: ActiveFireHazard[] = [];
  /** Active sweeping tidal surge waves. */
  private readonly waveHazards: ActiveWaveHazard[] = [];
  /** Active ignited burn DoTs: target -> burn state. */
  private readonly ignited = new Map<number, ActiveIgnite>();
  /** Active frost slow timers: target -> remaining seconds. */
  private readonly chilledUntil = new Map<number, number>();
  /** Caster -> spell id -> tick it can be cast again. */
  private readonly cooldowns = new Map<number, Map<string, number>>();
  /** Stats version each pool's maximum was last read at. */
  private readonly synced = new Map<number, number>();
  private events: SpellEvent[] = [];
  private hooks: MagicSystemHooks;

  constructor(
    private rules: SpellsRules,
    private readonly tickHz = 30,
    hooks: MagicSystemHooks = {},
  ) {
    this.hooks = hooks;
    this.setRules(rules);
  }

  /** Attach or update integration hooks (status, alliances, creature climate/biome). */
  setHooks(hooks: MagicSystemHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /** Active circular ice ring confining `e`, if any. */
  iceRingOf(e: number): Readonly<ActiveIceRing> | null {
    return this.iceRings.get(e) ?? null;
  }

  /** True if `e` is currently ignited from sustained fire exposure. */
  isIgnited(e: number): boolean {
    return this.ignited.has(e);
  }

  /** Remaining frost chill slow duration on `e`, seconds. */
  chillRemaining(e: number): number {
    return this.chilledUntil.get(e) ?? 0;
  }

  /** Apply damage to a target's circular Ice Ring prison, shattering it at 0 HP. */
  damageIceRing(target: number, damage: number): boolean {
    const ring = this.iceRings.get(target);
    if (!ring || damage <= 0) return false;
    ring.hp = Math.max(0, ring.hp - damage);
    if (ring.hp <= 0) {
      this.iceRings.delete(target);
      this.events.push({ caster: ring.caster, target, spell: "glacialSpike", state: "ice-ring-break" });
      return true;
    }
    return false;
  }

  /** New spells (rules hot reload); casts under way stop. */
  setRules(rules: SpellsRules): void {
    this.rules = rules;
    this.byId = new Map(rules.spells.map((s) => [s.id, s]));
    for (const caster of [...this.casting.keys()]) this.stop(caster);
    this.synced.clear();
  }

  /** Look up a spell definition by id. */
  spellOf(id: string): Spell | undefined {
    return this.byId.get(id);
  }

  /** Active magical shield on `e`, if any. */
  shieldOf(e: number): Readonly<ActiveShield> | null {
    return this.shields.get(e) ?? null;
  }

  /**
   * Absorb incoming damage against `target`'s active magical shield, if any.
   * Emits `shield-hit` (and `shield-expired` when depleted) and returns unabsorbed damage.
   */
  absorbDamage(sim: SimWorld, target: number, rawDamage: number, attacker?: number): number {
    if (rawDamage <= 0) return 0;
    const sh = this.shields.get(target);
    if (!sh || sh.current <= 0) return rawDamage;
    const absorbed = Math.min(sh.current, rawDamage);
    sh.current = Math.max(0, sh.current - absorbed);
    const hp01 = sh.max > 0 ? sh.current / sh.max : 0;
    let hitPos: [number, number, number] = [0, 1.0, 1.0];
    if (attacker !== undefined && hasComponent(sim.ecs, Transform, attacker) && hasComponent(sim.ecs, Transform, target)) {
      const dx = Transform.px[attacker] - Transform.px[target];
      const dz = Transform.pz[attacker] - Transform.pz[target];
      const len = Math.hypot(dx, dz) || 1;
      hitPos = [(dx / len) * 1.2, 1.0, (dz / len) * 1.2];
    }
    this.events.push({
      caster: attacker ?? target,
      target,
      spell: sh.spell,
      state: "shield-hit",
      amount: absorbed,
      hp01,
      hitPos,
    });
    if (sh.current <= 0) {
      this.shields.delete(target);
      this.events.push({ caster: target, target, spell: sh.spell, state: "shield-expired" });
    }
    return rawDamage - absorbed;
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
   * `caster` starts casting `spell` on `target` (itself when absent), optionally
   * along a client-proposed world-space spline `path`.
   * Replaces a cast under way. Returns why it can't, or null.
   */
  cast(
    sim: SimWorld,
    caster: number,
    spellId: string,
    target = caster,
    path?: ReadonlyArray<readonly [number, number, number]>,
  ): string | null {
    const spell = this.byId.get(spellId);
    if (!spell) return `no spell "${spellId}"`;
    if (!hasComponent(sim.ecs, Health, caster) || Health.current[caster] <= 0) return "you can't cast now";
    const origin: [number, number, number] = [
      Transform.px[caster]!,
      Transform.py[caster]!,
      Transform.pz[caster]!,
    ];
    let clampedPath: Array<[number, number, number]> | undefined;
    if (spell.target === "spline" || (path && path.length > 0)) {
      if (spell.target === "self") return `${spell.name} is cast on yourself only`;
      clampedPath = path && path.length > 0
        ? clampSpellPath(origin, path, spell.reach)
        : clampSpellPath(origin, [[origin[0], origin[1] + 0.6, origin[2]], [origin[0], origin[1] + 0.6, origin[2] + Math.min(6, spell.reach)]], spell.reach);
    } else {
      if (!hasComponent(sim.ecs, Health, target) || Health.current[target] <= 0) return "no one to cast on";
      if (spell.target === "self" && target !== caster) return `${spell.name} is cast on yourself only`;
      if (spell.effect.kind === "damage" && target === caster) return `you cannot cast ${spell.name} on yourself`;
      if (target !== caster && this.distance(caster, target) > spell.reach) return "too far away";
      if (spell.effect.kind === "heal" && Health.current[target] >= Health.max[target]) return target === caster ? "you are unhurt" : "they are unhurt";
    }
    const wait = this.cooldownOf(sim, caster, spell.id);
    if (wait > 0) return `${spell.name} is ready in ${Math.ceil(wait)} s`;
    this.ensure(sim, caster);
    if (Mana.current[caster] < spell.mana) return "not enough mana";
    this.stop(caster);
    this.events.push({
      caster,
      target,
      spell: spell.id,
      state: "started",
      seconds: spell.castSeconds,
      ...(clampedPath ? { path: clampedPath } : {}),
    });
    if (spell.castSeconds <= 0) this.complete(sim, caster, { spell, target, left: 0, ...(clampedPath ? { path: clampedPath } : {}) });
    else this.casting.set(caster, { spell, target, left: spell.castSeconds, ...(clampedPath ? { path: clampedPath } : {}) });
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
    if (this.shields.size > 0) {
      for (const [target, sh] of [...this.shields]) {
        if (!hasComponent(sim.ecs, Health, target) || Health.current[target] <= 0) {
          this.shields.delete(target);
          this.events.push({ caster: target, target, spell: sh.spell, state: "shield-expired" });
          continue;
        }
        sh.left -= dt;
        if (sh.left <= 0) {
          this.shields.delete(target);
          this.events.push({ caster: target, target, spell: sh.spell, state: "shield-expired" });
        }
      }
    }
    this.stepHazards(sim, dt);
    this.stepIceRings(sim, dt);
    this.stepChillsAndIgnite(sim, dt);
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
    const endPt = c.path && c.path.length > 0 ? c.path[c.path.length - 1]! : undefined;
    const ev: SpellEvent = {
      caster,
      target: c.target,
      spell: c.spell.id,
      state: "done",
      ...(c.path ? { path: c.path } : {}),
      ...(endPt ? { detonateAt: endPt } : {}),
    };
    const effect = c.spell.effect;
    const power = sim.stats.get(caster, "spellPower") ?? 1;
    if (effect.kind === "heal") {
      const t = c.target;
      const before = Health.current[t];
      Health.current[t] = Math.min(Health.max[t], before + effect.amount * power);
      ev.amount = Health.current[t] - before;
    } else if (effect.kind === "damage") {
      const raw = effect.amount * power;
      const element = effect.element ?? "fire";
      if (endPt) {
        const baseRadius = effect.radiusM ?? 3.5;
        let maxTargetRadius = 0.6;
        const candidates = this.targetQuery(sim.ecs);
        for (let k = 0; k < candidates.length; k++) {
          const eid = candidates[k] as number;
          if (eid === caster || Health.current[eid]! <= 0) continue;
          const dist = Math.hypot(Transform.px[eid]! - endPt[0], Transform.pz[eid]! - endPt[2]);
          if (dist <= baseRadius) {
            maxTargetRadius = Math.max(maxTargetRadius, this.entityRadius(sim, eid));
          }
        }
        // Fire Inferno Pillar uses radius at least 2x target radius; frost checks immunities & rings.
        const effectiveRadius = element === "fire" ? Math.max(baseRadius, maxTargetRadius * 2.0) : baseRadius;
        ev.radiusM = effectiveRadius;

        let totalDealt = 0;
        if (element === "water" && c.path && c.path.length >= 2) {
          this.waveHazards.push({
            caster,
            spell: c.spell.id,
            path: c.path,
            elapsed: 0,
            duration: 0.75,
            radius: Math.max(3.6, effectiveRadius),
            tickDamage: raw * 0.45,
            tickCarry: 0.25,
            hitEntities: new Set<number>(),
          });
          totalDealt += this.applyWaveSweepStep(sim, this.waveHazards[this.waveHazards.length - 1]!, 0.05);
        } else {
          for (let k = 0; k < candidates.length; k++) {
            const eid = candidates[k] as number;
            if (eid === caster || Health.current[eid]! <= 0) continue;
            const dist = Math.hypot(Transform.px[eid]! - endPt[0], Transform.pz[eid]! - endPt[2]);
            if (dist > effectiveRadius) continue;

            if (element === "frost") {
              const mult = this.frostMultiplier(sim, eid, caster);
              if (mult <= 0) continue; // Allies, other players & alpine/mountain creatures are immune
              const afterShield = this.absorbDamage(sim, eid, raw * mult, caster);
              const before = Health.current[eid]!;
              Health.current[eid] = Math.max(0, before - afterShield);
              totalDealt += before - Health.current[eid]!;
              this.applyFlashFreeze(sim, eid, caster, mult);
              continue;
            }

            if (this.hooks.areAllies?.(caster, eid)) continue;
            const afterShield = this.absorbDamage(sim, eid, raw, caster);
            const before = Health.current[eid]!;
            Health.current[eid] = Math.max(0, before - afterShield);
            totalDealt += before - Health.current[eid]!;
            if (element === "fire" && Health.current[eid]! > 0) {
              this.spawnFirePillarAt(sim, caster, c.spell.id, Transform.px[eid]!, Transform.pz[eid]!, Math.max(2.0, this.entityRadius(sim, eid) * 2.0), raw * 0.22);
            }
          }
          if (element === "fire") {
            this.spawnFirePillarAt(sim, caster, c.spell.id, endPt[0], endPt[2], effectiveRadius, raw * 0.22);
          }
        }
        ev.amount = totalDealt;
      } else {
        const t = c.target;
        const mult = element === "frost" ? this.frostMultiplier(sim, t, caster) : 1;
        if (mult > 0) {
          const afterShield = this.absorbDamage(sim, t, raw * mult, caster);
          const before = Health.current[t];
          Health.current[t] = Math.max(0, before - afterShield);
          ev.amount = before - Health.current[t];
          if (element === "frost") this.applyFlashFreeze(sim, t, caster, mult);
        } else {
          ev.amount = 0;
        }
      }
    } else if (effect.kind === "shield") {
      const t = c.target;
      const cap = effect.absorb * power;
      this.shields.set(t, { spell: c.spell.id, current: cap, max: cap, left: effect.durationSeconds });
      ev.amount = cap;
      ev.hp01 = 1;
    } else if (effect.kind === "airSphere") {
      // Rideable wind sphere launch: propel/teleport caster cleanly to the spline endpoint.
      if (endPt) {
        Transform.px[caster] = endPt[0];
        Transform.py[caster] = Math.max(0, endPt[1]);
        Transform.pz[caster] = endPt[2];
      }
      ev.amount = Math.round((effect.radiusM ?? 2.5) * 10) / 10;
    }
    this.events.push(ev);
  }

  private maxOf(sim: SimWorld, e: number): number {
    return sim.stats.drive(e, "maxMana") ?? this.rules.defaultMax;
  }

  private distance(a: number, b: number): number {
    return Math.hypot(Transform.px[a] - Transform.px[b], Transform.pz[a] - Transform.pz[b]);
  }

  private entityRadius(sim: SimWorld, e: number): number {
    if (hasComponent(sim.ecs, BodyConfig, e)) {
      const r = BodyConfig.radius[e] || BodyConfig.halfX[e] || 0.6;
      if (Number.isFinite(r) && r > 0) return r;
    }
    return 0.65;
  }

  private isPlayerEntity(sim: SimWorld, e: number): boolean {
    return this.hooks.isPlayer ? this.hooks.isPlayer(e) : hasComponent(sim.ecs, CharacterRef, e);
  }

  private frostMultiplier(sim: SimWorld, target: number, caster: number): number {
    if (target === caster) return 0;
    // Friendly / party / guild mates and all other players remain unaffected by Ice attacks.
    if (this.isPlayerEntity(sim, target) || this.hooks.areAllies?.(caster, target)) {
      return 0;
    }
    const info = this.hooks.creatureInfo?.(target);
    if (info) {
      const biome = info.biome?.toLowerCase() ?? "";
      const kind = info.kind?.toLowerCase() ?? "";
      if (info.coldImmune || COLD_BIOMES.has(biome) || COLD_KINDS.test(kind)) {
        return 0;
      }
      if (info.iceVulnerable || ICE_VULNERABLE_KINDS.test(kind)) {
        return 1.75;
      }
    }
    return 1.0;
  }

  private spawnFirePillarAt(
    _sim: SimWorld,
    caster: number,
    spell: string,
    x: number,
    z: number,
    radius: number,
    tickDamage: number,
  ): void {
    this.fireHazards.push({
      caster,
      spell,
      x,
      z,
      radius,
      tickDamage,
      left: 3.5,
      tickCarry: 0,
      exposureTicks: new Map(),
    });
  }

  private applyFlashFreeze(sim: SimWorld, target: number, caster: number, mult: number): void {
    if (Health.current[target]! <= 0) return;
    if (hasComponent(sim.ecs, Stamina, target)) {
      const drain = 26 * mult;
      Stamina.current[target] = Math.max(0, Stamina.current[target]! - drain);
    }
    this.chilledUntil.set(target, 4.5 * Math.max(1, mult * 0.85));
    this.hooks.applyStatus?.(target, "frostbite", caster, sim.currentTick);

    if (!this.iceRings.has(target)) {
      const r = Math.max(1.25, this.entityRadius(sim, target) * 2.0);
      const px = Transform.px[target]!;
      const py = Transform.py[target]!;
      const pz = Transform.pz[target]!;
      this.iceRings.set(target, {
        caster,
        target,
        cx: px,
        cz: pz,
        radius: r,
        hp: 55,
        maxHp: 55,
        left: 6.0,
        wasAttacking: false,
      });
      this.events.push({
        caster,
        target,
        spell: "glacialSpike",
        state: "ice-ring-spawn",
        amount: r,
        detonateAt: [px, py, pz],
      });
    }
  }

  private stepHazards(sim: SimWorld, dt: number): void {
    const candidates = this.targetQuery(sim.ecs);
    // 1) Fire Inferno Pillars: escalating burn stacks until ignited
    for (let i = this.fireHazards.length - 1; i >= 0; i--) {
      const h = this.fireHazards[i]!;
      h.left -= dt;
      if (h.left <= 0) {
        this.fireHazards.splice(i, 1);
        continue;
      }
      h.tickCarry += dt;
      while (h.tickCarry >= 0.25) {
        h.tickCarry -= 0.25;
        for (let k = 0; k < candidates.length; k++) {
          const eid = candidates[k] as number;
          if (eid === h.caster || Health.current[eid]! <= 0) continue;
          if (this.hooks.areAllies?.(h.caster, eid)) continue;
          const dist = Math.hypot(Transform.px[eid]! - h.x, Transform.pz[eid]! - h.z);
          if (dist > h.radius) continue;
          const prevStacks = h.exposureTicks.get(eid) ?? 0;
          const nextStacks = prevStacks + 1;
          h.exposureTicks.set(eid, nextStacks);
          const dmg = h.tickDamage * (1 + nextStacks * 0.35);
          const after = this.absorbDamage(sim, eid, dmg, h.caster);
          Health.current[eid] = Math.max(0, Health.current[eid]! - after);
          if (nextStacks >= 3 && Health.current[eid]! > 0) {
            this.ignited.set(eid, { caster: h.caster, dps: Math.max(4, h.tickDamage * 1.4), left: 4.0, carry: 0 });
            this.hooks.applyStatus?.(eid, "ignite", h.caster, sim.currentTick);
          }
        }
      }
    }

    // 2) Sweeping Tidal Surge Waves: push targets + drowning breath/stamina drain
    for (let i = this.waveHazards.length - 1; i >= 0; i--) {
      const w = this.waveHazards[i]!;
      this.applyWaveSweepStep(sim, w, dt);
      if (w.elapsed >= w.duration) {
        this.waveHazards.splice(i, 1);
      }
    }
  }

  private applyWaveSweepStep(sim: SimWorld, w: ActiveWaveHazard, dt: number): number {
    w.elapsed += dt;
    w.tickCarry += dt;
    const t = Math.min(1, w.elapsed / Math.max(0.05, w.duration));
    const idxFloat = t * (w.path.length - 1);
    const i0 = Math.min(w.path.length - 2, Math.floor(idxFloat));
    const frac = idxFloat - i0;
    const p0 = w.path[i0]!;
    const p1 = w.path[i0 + 1]!;
    const wx = p0[0] + (p1[0] - p0[0]) * frac;
    const wz = p0[2] + (p1[2] - p0[2]) * frac;
    const dx = p1[0] - p0[0];
    const dz = p1[2] - p0[2];
    const dLen = Math.hypot(dx, dz) || 1;
    const dirX = dx / dLen;
    const dirZ = dz / dLen;

    let dealt = 0;
    const candidates = this.targetQuery(sim.ecs);
    const doTick = w.tickCarry >= 0.15;
    if (doTick) w.tickCarry -= 0.15;

    for (let k = 0; k < candidates.length; k++) {
      const eid = candidates[k] as number;
      if (eid === w.caster || Health.current[eid]! <= 0) continue;
      if (this.hooks.areAllies?.(w.caster, eid)) continue;
      const dist = Math.hypot(Transform.px[eid]! - wx, Transform.pz[eid]! - wz);
      if (dist > w.radius) continue;

      // Push caught target along wave velocity
      Transform.px[eid] = Transform.px[eid]! + dirX * (7.5 * dt);
      Transform.pz[eid] = Transform.pz[eid]! + dirZ * (7.5 * dt);
      if (hasComponent(sim.ecs, Velocity, eid)) {
        Velocity.lx[eid] = dirX * 9.5;
        Velocity.lz[eid] = dirZ * 9.5;
      }
      if (doTick || !w.hitEntities.has(eid)) {
        w.hitEntities.add(eid);
        if (hasComponent(sim.ecs, Locomotion, eid)) {
          Locomotion.breath[eid] = Math.max(0, Locomotion.breath[eid]! - 0.35);
        }
        if (hasComponent(sim.ecs, Stamina, eid)) {
          Stamina.current[eid] = Math.max(0, Stamina.current[eid]! - 12);
        }
        const drownBonus = hasComponent(sim.ecs, Locomotion, eid) && Locomotion.breath[eid]! <= 0.15 ? 1.5 : 1.0;
        const after = this.absorbDamage(sim, eid, w.tickDamage * drownBonus, w.caster);
        const before = Health.current[eid]!;
        Health.current[eid] = Math.max(0, before - after);
        dealt += before - Health.current[eid]!;
      }
    }
    return dealt;
  }

  private stepIceRings(sim: SimWorld, dt: number): void {
    for (const [eid, ring] of [...this.iceRings]) {
      if (!hasComponent(sim.ecs, Health, eid) || Health.current[eid]! <= 0) {
        this.iceRings.delete(eid);
        this.events.push({ caster: ring.caster, target: eid, spell: "glacialSpike", state: "ice-ring-break" });
        continue;
      }
      ring.left -= dt;
      if (ring.left <= 0) {
        this.iceRings.delete(eid);
        this.events.push({ caster: ring.caster, target: eid, spell: "glacialSpike", state: "ice-ring-break" });
        continue;
      }
      // Confine trapped entity inside circular Ice Ring perimeter
      const dx = Transform.px[eid]! - ring.cx;
      const dz = Transform.pz[eid]! - ring.cz;
      const dist = Math.hypot(dx, dz);
      const maxR = Math.max(0.4, ring.radius * 0.78);
      if (dist > maxR && dist > 1e-5) {
        const s = maxR / dist;
        Transform.px[eid] = ring.cx + dx * s;
        Transform.pz[eid] = ring.cz + dz * s;
        if (hasComponent(sim.ecs, Velocity, eid)) {
          Velocity.lx[eid] = 0;
          Velocity.lz[eid] = 0;
        }
      }
      // Trapped target attacking breaks away at the ring
      if (hasComponent(sim.ecs, Action, eid)) {
        const attacking = Action.move[eid]! !== 0;
        if (attacking && !ring.wasAttacking) {
          this.damageIceRing(eid, 20);
        }
        if (this.iceRings.has(eid)) ring.wasAttacking = attacking;
      }
    }
  }

  private stepChillsAndIgnite(sim: SimWorld, dt: number): void {
    for (const [eid, left] of [...this.chilledUntil]) {
      if (!hasComponent(sim.ecs, Health, eid) || Health.current[eid]! <= 0) {
        this.chilledUntil.delete(eid);
        continue;
      }
      const next = left - dt;
      if (next <= 0) {
        this.chilledUntil.delete(eid);
      } else {
        this.chilledUntil.set(eid, next);
        if (hasComponent(sim.ecs, Velocity, eid)) {
          Velocity.lx[eid] = Velocity.lx[eid]! * 0.45;
          Velocity.lz[eid] = Velocity.lz[eid]! * 0.45;
        }
        if (hasComponent(sim.ecs, PlayerIntent, eid)) {
          PlayerIntent.mx[eid] = PlayerIntent.mx[eid]! * 0.45;
          PlayerIntent.mz[eid] = PlayerIntent.mz[eid]! * 0.45;
        }
      }
    }

    for (const [eid, ign] of [...this.ignited]) {
      if (!hasComponent(sim.ecs, Health, eid) || Health.current[eid]! <= 0) {
        this.ignited.delete(eid);
        continue;
      }
      ign.left -= dt;
      if (ign.left <= 0) {
        this.ignited.delete(eid);
        continue;
      }
      ign.carry += dt;
      if (ign.carry >= 0.5) {
        ign.carry -= 0.5;
        const after = this.absorbDamage(sim, eid, ign.dps * 0.5, ign.caster);
        Health.current[eid] = Math.max(0, Health.current[eid]! - after);
      }
    }
  }
}

// Shared vocabulary, not this system's own (ES5f); re-exported for its importers.
export type { MagicCreatureInfo, MagicSystemHooks, SpellEvent } from "@mmo-engine/engine-core";
