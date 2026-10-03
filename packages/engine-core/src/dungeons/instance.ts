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
  /** Item definitions a kill may roll (the mob pool); empty: no loot. */
  lootPool?: readonly number[];
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
    const combat = new CombatSystem(30, stamina, { hooks: opts.game.hooks, weaponOf });
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
        if ((raw as { op?: unknown }).op === "state") this.pushState(p);
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
    const now = this.now();
    if (this.boss.size > 0 && this.remaining().boss === 0) this.end("cleared");
    else if (now - this.startedAt >= this.opts.rules.timeLimitMinutes * 60_000) this.end("timeout");
    else if (this.online.size === 0 && now - this.emptySince >= this.opts.rules.emptyTeardownSeconds * 1000) this.end("abandoned");
    else if (now - this.lastState >= 5000) {
      this.lastState = now;
      for (const p of this.online.values()) this.pushState(p);
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
    });
  }

  private rand(): number {
    this.rng = hash(this.rng, 0x2545f491);
    return this.rng / 4294967296;
  }
}
