/**
 * A dungeon instance (roadmap D4): a small sandbox engine started from a
 * prebaked layout, apart from the open world. It is its own SimWorld and
 * Gateway on its own port, running the same engine-core systems (stats,
 * creatures, intents, combat, death, stamina, integration) with the
 * layout's walls as its collider. In-process for now; a child process
 * later (the world-server spec's deployment path).
 *
 * Players come in with a token the region asked this gateway to `admit`
 * (Gateway.admit) and land at the entrance. Every spawn point gets one
 * creature: its baked species when that has creature rules, else the
 * rules' fallback; dead creatures stay dead. All of the run's state lives
 * here: kills, deaths, and the loot each kill rolls for its killer.
 *
 * The run ends when the boss room is cleared ("cleared"), the time limit
 * passes ("timeout"), or nobody has been in it for `emptyTeardownSeconds`
 * ("abandoned"). It then sends its members `{kind:"dungeon", op:"ended"}`
 * and hands one result batch to `onEnd`; nothing it earned exists
 * anywhere else until the region commits that batch.
 */

import { hasComponent } from "bitecs";
import * as C from "../components.js";
import type { CredentialStore } from "../auth/credentials.js";
import type { CharacterStore } from "../characters/store.js";
import { CombatSystem, type Weapon } from "../combat.js";
import { CreatureSystem } from "../creatures.js";
import { DeathSystem, type LifeEvent } from "../death.js";
import type { GameRules } from "../rules/boot.js";
import { StaminaSystem } from "../stats/stamina-system.js";
import { StatsSystem } from "../stats/stats-system.js";
import { IntegrateSystem, IntentSystem, type SimSystem } from "../systems.js";
import { SimWorld } from "../world.js";
import { Gateway } from "../net/gateway.js";
import type { ExtensionPlayer, GatewayExtension } from "../net/extension.js";
import type { TransportKind } from "../net/transport.js";
import { hash } from "../procgen/ecology.js";
import type { InstanceRules } from "./content.js";
import type { InstanceLayout } from "./pool.js";
import { DungeonWallSystem } from "./walls.js";

export type InstanceOutcome = "cleared" | "timeout" | "abandoned";

export interface InstanceMember {
  characterId: number;
  username: string;
  name: string;
  look: string;
}

/** A chest placed for the run: opened once, then it stays open. */
export interface InstanceChest {
  id: string;
  x: number;
  z: number;
  opened: boolean;
}

/** A trap armed for the run: sprung once under a member, then spent. */
export interface InstanceTrap {
  id: string;
  x: number;
  z: number;
  sprung: boolean;
}

/** What a run earned, reported once at its end (DUNGEONS-AND-LOOT.md §3.4 step 5). */
export interface InstanceResult {
  instance: string;
  dungeon: string;
  entrance: string;
  outcome: InstanceOutcome;
  startedAt: number;
  endedAt: number;
  members: number[];
  /** Creatures killed, per killer character and kind. */
  kills: { characterId: number; kind: string; count: number }[];
  /** Times each character died. */
  deaths: { characterId: number; count: number }[];
  /** Item definitions granted, per character (rolled at each kill, from the mob pool). */
  loot: { characterId: number; def: number }[];
}

export interface DungeonInstanceOptions {
  id: string;
  entrance: string;
  layout: InstanceLayout;
  rules: InstanceRules;
  game: GameRules;
  members: InstanceMember[];
  credentialStore: CredentialStore;
  characterStore: CharacterStore;
  /** What a character swings (the region's items); none: fists. */
  weaponOf?: (characterId: number) => Weapon | null;
  /** The share of a blow a character's worn armour lets through; absent: 1. */
  armourOf?: (characterId: number) => number;
  /** Item definitions a kill may roll (the mob pool); empty: no loot. */
  lootPool?: readonly number[];
  /** Item definitions an opened chest may roll (the chest pool); empty: no loot. */
  chestPool?: readonly number[];
  onEnd: (result: InstanceResult) => void;
  port?: number;
  transport?: TransportKind;
  /** Wall clock, ms (timeouts). Default Date.now. */
  now?: () => number;
  /** The gateway's clock (heartbeats); tests drive both. Default: `now`. */
  clock?: () => number;
}

/** A dead creature in an instance stays down. */
const NEVER = 1e9;

export class DungeonInstance {
  readonly id: string;
  readonly world = new SimWorld();
  readonly gateway: Gateway;
  /** Chests placed for the run, in room-id order (`chest-0`, …). */
  readonly chests: InstanceChest[] = [];
  /** Traps armed for the run, in room-id order (`trap-0`, …). */
  readonly traps: InstanceTrap[] = [];
  readonly creatures: CreatureSystem;
  readonly startedAt: number;
  private readonly members = new Map<number, InstanceMember>();
  private readonly online = new Map<number, ExtensionPlayer>();
  private readonly kills = new Map<string, number>();
  private readonly deaths = new Map<number, number>();
  private readonly loot: { characterId: number; def: number }[] = [];
  private readonly boss = new Set<number>();
  private readonly spawned = new Set<number>();
  private readonly fallen = new Set<number>();
  /** Avatars already put at the entrance (a reconnect keeps its place). */
  private readonly placed = new Set<number>();
  private readonly now: () => number;
  private emptySince: number;
  private rng: number;
  private outcome: InstanceOutcome | null = null;
  private lastState = 0;

  constructor(private readonly opts: DungeonInstanceOptions) {
    this.id = opts.id;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.emptySince = this.startedAt;
    this.rng = hash(opts.id.length, ...[...opts.id].map((c) => c.charCodeAt(0)));
    for (const m of opts.members) this.members.set(m.characterId, m);
    const rules = opts.game.rules;
    this.creatures = new CreatureSystem({ creatures: rules.creatures.creatures, bases: rules.items.bases, groundHeightAt: () => 0 });
    const stamina = new StaminaSystem();
    const weaponOf = (e: number): Weapon | null =>
      hasComponent(this.world.ecs, C.CharacterRef, e)
        ? (opts.weaponOf?.(C.CharacterRef.idHi[e] * 4294967296 + C.CharacterRef.idLo[e]) ?? null)
        : this.creatures.weaponOf(e);
    const armourOf = (e: number): number =>
      hasComponent(this.world.ecs, C.CharacterRef, e)
        ? (opts.armourOf?.(C.CharacterRef.idHi[e] * 4294967296 + C.CharacterRef.idLo[e]) ?? 1)
        : 1;
    const combat = new CombatSystem(30, stamina, { hooks: opts.game.hooks, weaponOf, armourOf });
    const death: DeathSystem = new DeathSystem(
      opts.game.hooks,
      30,
      (e) => combat.lastAttacker(e),
      (s, e) => this.creatures.isCreature(e) || this.gateway.respawnPlayer(s, e),
      (e) => (this.creatures.isCreature(e) ? NEVER : undefined),
      (s, ev) => this.onDeath(s, ev),
    );
    const director: SimSystem = { name: "dungeon-director", step: () => this.direct() };
    // Its position, health and stamina here are the run's, never the character's saved state.
    const store: CharacterStore = {
      list: (u) => opts.characterStore.list(u),
      get: (u, id) => opts.characterStore.get(u, id),
      create: () => Promise.reject(new Error("characters are made in the open world")),
      loadSkills: opts.characterStore.loadSkills?.bind(opts.characterStore),
    };
    const extension: GatewayExtension = {
      kind: "dungeon",
      onEnter: (p) => this.enter(p),
      onLeave: (p) => {
        if (p.characterId !== null) this.online.delete(p.characterId);
        if (this.online.size === 0) this.emptySince = this.now();
      },
      onMessage: (p, raw) => {
        const op = (raw as { op?: unknown }).op;
        if (op === "state") this.pushState(p);
        else if (op === "open") this.openFor(p);
        else p.send({ kind: "chat", channel: "system", text: "malformed dungeon op", from: "", entity: "" });
      },
    };
    this.gateway = new Gateway({
      port: opts.port ?? 0,
      world: this.world,
      systems: [new StatsSystem(), this.creatures, new IntentSystem(), combat, death, stamina, new IntegrateSystem(), new DungeonWallSystem(opts.layout), director],
      credentialStore: opts.credentialStore,
      characterStore: store,
      spawnPoint: opts.layout.entrance,
      groundHeightAt: () => 0,
      allowRegister: false,
      creatures: {
        has: (k) => k in rules.creatures.creatures,
        spawnPack: (w, k, x, z) => this.creatures.spawnPack(w, k, x, z),
        nameOf: (e) => this.creatures.nameOf(e),
        entities: () => this.creatures.entities(),
      },
      extensions: [extension],
      ...(opts.clock ? { clock: opts.clock } : opts.now ? { clock: opts.now } : {}),
      ...(opts.transport ? { transport: opts.transport } : {}),
    });
    this.populate();
  }

  /** Bind the port and start the tick. Returns the port. */
  async start(): Promise<number> {
    const port = await this.gateway.listen();
    this.gateway.startTicking();
    return port;
  }

  async close(): Promise<void> {
    await this.gateway.close();
  }

  get layoutName(): string {
    return this.opts.layout.name;
  }

  get ended(): boolean {
    return this.outcome !== null;
  }

  isMember(characterId: number): boolean {
    return this.members.has(characterId);
  }

  get memberCount(): number {
    return this.members.size;
  }

  /** A token `member` says hello with to come in (adds them if new). */
  admit(member: InstanceMember): string {
    this.members.set(member.characterId, member);
    return this.gateway.admit(member.username, { id: member.characterId, name: member.name, look: member.look });
  }

  /** Creatures still standing, and those in the boss room. */
  remaining(): { creatures: number; boss: number } {
    let creatures = 0;
    let boss = 0;
    for (const e of this.spawned) {
      if (this.fallen.has(e)) continue;
      creatures++;
      if (this.boss.has(e)) boss++;
    }
    return { creatures, boss };
  }

  /** End the run now (the region shutting down, a test). */
  end(outcome: InstanceOutcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    const result: InstanceResult = {
      instance: this.id,
      dungeon: this.opts.layout.id,
      entrance: this.opts.entrance,
      outcome,
      startedAt: this.startedAt,
      endedAt: this.now(),
      members: [...this.members.keys()],
      kills: [...this.kills].map(([k, count]) => {
        const i = k.indexOf(":");
        return { characterId: Number(k.slice(0, i)), kind: k.slice(i + 1), count };
      }),
      deaths: [...this.deaths].map(([characterId, count]) => ({ characterId, count })),
      loot: this.loot.slice(),
    };
    for (const p of this.online.values()) {
      const mine = result.loot.filter((l) => l.characterId === p.characterId).length;
      p.send({ kind: "dungeon", op: "ended", outcome, items: mine });
    }
    this.opts.onEnd(result);
  }

  // ------------------------------------------------------------- inside

  private populate(): void {
    const trapRooms = this.opts.layout.rooms
      .filter((r) => r.id !== this.opts.layout.entranceRoom)
      .sort((a, b) => a.id - b.id)
      .slice(0, Math.max(0, this.opts.rules.trapsPerRun));
    trapRooms.forEach((r, i) => this.traps.push({ id: `trap-${i}`, x: r.x, z: r.z, sprung: false }));
    const chestRooms = this.opts.layout.rooms
      .filter((r) => r.id !== this.opts.layout.entranceRoom)
      .sort((a, b) => a.id - b.id)
      .slice(0, Math.max(0, this.opts.rules.chestsPerRun));
    chestRooms.forEach((r, i) => this.chests.push({ id: `chest-${i}`, x: r.x, z: r.z, opened: false }));
    const rules = this.opts.game.rules.creatures.creatures;
    const fallback = this.opts.rules.fallbackCreature;
    for (const sp of this.opts.layout.spawns) {
      const kind = sp.species && sp.species in rules ? sp.species : fallback;
      if (!(kind in rules)) continue;
      const e = this.creatures.spawn(this.world, kind, sp.x, sp.z);
      this.spawned.add(e);
      if (sp.room === this.opts.layout.bossRoom) this.boss.add(e);
    }
  }

  private enter(p: ExtensionPlayer): void {
    if (p.characterId === null || !this.members.has(p.characterId)) return;
    this.online.set(p.characterId, p);
    // The gateway spreads new avatars on a grid around its spawn point, into the rock here.
    const e = p.entity();
    if (e >= 0 && !this.placed.has(e)) {
      this.placed.add(e);
      C.Transform.px[e] = this.opts.layout.entrance.x;
      C.Transform.pz[e] = this.opts.layout.entrance.z;
      C.Transform.py[e] = 0;
    }
    this.pushState(p);
  }

  private onDeath(sim: SimWorld, ev: LifeEvent): void {
    if (ev.state !== "dead") return;
    const victim = ev.target;
    if (hasComponent(sim.ecs, C.CharacterRef, victim)) {
      const id = C.CharacterRef.idHi[victim] * 4294967296 + C.CharacterRef.idLo[victim];
      this.deaths.set(id, (this.deaths.get(id) ?? 0) + 1);
      return;
    }
    if (!this.spawned.has(victim) || this.fallen.has(victim)) return;
    this.fallen.add(victim);
    const killer = ev.killer;
    if (killer === undefined || !hasComponent(sim.ecs, C.CharacterRef, killer)) return;
    const id = C.CharacterRef.idHi[killer] * 4294967296 + C.CharacterRef.idLo[killer];
    const kind = this.creatures.kindOf(victim) ?? "creature";
    this.kills.set(`${id}:${kind}`, (this.kills.get(`${id}:${kind}`) ?? 0) + 1);
    const pool = this.opts.lootPool ?? [];
    if (pool.length > 0) {
      const [lo, hi] = this.boss.has(victim) ? this.opts.rules.bossLootRolls : this.opts.rules.lootRollsPerKill;
      const rolls = lo + Math.floor(this.rand() * (hi - lo + 1));
      for (let i = 0; i < rolls; i++) this.loot.push({ characterId: id, def: pool[Math.floor(this.rand() * pool.length)] });
    }
  }

  private direct(): void {
    if (this.outcome) return;
    this.springTraps();
    const now = this.now();
    if (this.boss.size > 0 && this.remaining().boss === 0) this.end("cleared");
    else if (now - this.startedAt >= this.opts.rules.timeLimitMinutes * 60_000) this.end("timeout");
    else if (this.online.size === 0 && now - this.emptySince >= this.opts.rules.emptyTeardownSeconds * 1000) this.end("abandoned");
    else if (now - this.lastState >= 5000) {
      this.lastState = now;
      for (const p of this.online.values()) this.pushState(p);
    }
  }

  /**
   * Open the nearest unopened chest in reach of a member. Its rolls join
   * the run's loot for the opener; an opened chest stays open, so opening
   * twice (or with nothing left) finds it empty.
   */
  private openFor(p: ExtensionPlayer): void {
    if (p.characterId === null || !this.members.has(p.characterId)) return;
    const e = p.entity();
    if (e < 0) return this.notice(p, "you must be inside to open that");
    const radius2 = this.opts.rules.chestOpenRadiusM ** 2;
    let best: InstanceChest | null = null;
    let bestD2 = Infinity;
    for (const c of this.chests) {
      if (c.opened) continue;
      const d2 = (C.Transform.px[e] - c.x) ** 2 + (C.Transform.pz[e] - c.z) ** 2;
      if (d2 < bestD2) {
        best = c;
        bestD2 = d2;
      }
    }
    if (best === null) return this.notice(p, "the chests here are empty");
    if (bestD2 > radius2) return this.notice(p, "no unopened chest in reach");
    best.opened = true;
    const pool = this.opts.chestPool ?? [];
    if (pool.length > 0) {
      const [lo, hi] = this.opts.rules.chestLootRolls;
      const rolls = lo + Math.floor(this.rand() * (hi - lo + 1));
      for (let i = 0; i < rolls; i++) this.loot.push({ characterId: p.characterId, def: pool[Math.floor(this.rand() * pool.length)] });
    }
    this.pushState(p);
  }

  private notice(p: ExtensionPlayer, text: string): void {
    p.send({ kind: "chat", channel: "system", text, from: "", entity: "" });
  }

  /**
   * Spring every armed trap a member stands on. A trap takes the rules
   * harm once (direct Health damage, like hunger at zero: DeathSystem
   * below handles the kill) and is spent; the party hears it go off.
   */
  private springTraps(): void {
    const r2 = this.opts.rules.trapTriggerRadiusM ** 2;
    for (const t of this.traps) {
      if (t.sprung) continue;
      for (const p of this.online.values()) {
        const e = p.entity();
        if (e < 0 || !hasComponent(this.world.ecs, C.Health, e)) continue;
        if ((C.Transform.px[e] - t.x) ** 2 + (C.Transform.pz[e] - t.z) ** 2 > r2) continue;
        t.sprung = true;
        if (!hasComponent(this.world.ecs, C.God, e)) C.Health.current[e] = Math.max(0, C.Health.current[e] - this.opts.rules.trapHarm);
        for (const o of this.online.values()) {
          this.notice(o, "a trap springs shut!");
          this.pushState(o);
        }
        break;
      }
    }
  }

  private pushState(p: ExtensionPlayer): void {
    const left = this.remaining();
    p.send({
      kind: "dungeon",
      op: "state",
      dungeon: this.opts.layout.name,
      secondsLeft: Math.max(0, Math.round((this.startedAt + this.opts.rules.timeLimitMinutes * 60_000 - this.now()) / 1000)),
      creaturesLeft: left.creatures,
      bossLeft: left.boss,
      chests: this.chests.map((c) => ({ id: c.id, opened: c.opened })),
      traps: this.traps.map((t) => ({ id: t.id, sprung: t.sprung })),
    });
  }

  private rand(): number {
    this.rng = hash(this.rng, 0x2545f491);
    return this.rng / 4294967296;
  }
}
