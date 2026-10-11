/**
 * InstanceManager (roadmap D4): the region side of dungeon instances.
 *
 * It is the region gateway's `dungeon` extension. Each player entering
 * the world is told where the entrances are (`{kind:"dungeon",
 * op:"entrances", entrances}`). A party asks at an
 * entrance (`{kind:"dungeon", op:"enter", entrance}` from a member standing
 * within its radius); the manager picks a pool layout that fits the
 * entrance's rank and themes, starts a DungeonInstance, and sends each
 * party member online `{kind:"dungeon", op:"transfer", endpoint, token,
 * dungeon}`: the client says hello to `endpoint` with that token and plays
 * there. Its avatar here stands at the entrance until the region's grace
 * period takes it, and its saved position stays the entrance, so coming
 * back (to the region, with the region's own token) puts it there.
 *
 * A member who asks again while their party's run lasts is let back in
 * (`reentry`). When a run ends the manager commits its result: loot into
 * the members' bags, the batch recorded in `instances.db` for the world
 * server's report, and `onCommitted` for anything else that counts kills.
 * Only then does any of it exist ("on-report": a run that crashes before
 * reporting didn't happen).
 */

import type { CredentialStore } from "../auth/credentials.js";
import type { CharacterStore } from "../characters/store.js";
import { FIGHT_DIFFICULTY, type Weapon } from "../combat.js";
import type { GameRules } from "../rules/boot.js";
import type { ExtensionPlayer, GatewayExtension } from "../net/extension.js";
import type { TransportKind } from "../net/transport.js";
import * as C from "../components.js";
import type { DungeonContent } from "./content.js";
import { DungeonInstance, type InstanceMember, type InstanceResult } from "./instance.js";
import type { DungeonPool } from "./pool.js";
import type { InstanceResultStore } from "./results.js";

export interface InstanceManagerOptions {
  content: DungeonContent;
  pool: DungeonPool;
  game: () => GameRules;
  credentialStore: CredentialStore;
  characterStore: CharacterStore;
  /** Character names in a character's party, itself included. */
  partyOf: (name: string) => string[];
  weaponOf?: (characterId: number) => Weapon | null;
  /** The share of a blow a character's worn armour lets through. */
  armourOf?: (characterId: number) => number;
  lootPool?: () => readonly number[];
  chestPool?: () => readonly number[];
  /** Put item definition `def` in a character's bag; false when it couldn't. */
  grant: (characterId: number, def: number) => boolean;
  /**
   * Train one use of a skill for a character (dungeon skill gains).
   * The manager calls it once per kill for the killer's weapon skill;
   * absent: runs grant loot but train nothing.
   */
  train?: (characterId: number, skill: string, difficulty: number, key: number) => void;
  /** The address clients reach an instance's port at. */
  endpoint: (port: number) => string;
  results: InstanceResultStore;
  onCommitted?: (result: InstanceResult) => void;
  transport?: TransportKind;
  now?: () => number;
  log?: (line: string) => void;
}

interface Running {
  instance: DungeonInstance;
  port: number;
  endpoint: string;
}

export class InstanceManager implements GatewayExtension {
  readonly kind = "dungeon";
  private readonly online = new Map<number, ExtensionPlayer>();
  private readonly running = new Map<string, Running>();
  private readonly starting = new Set<number>();
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly opts: InstanceManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  onEnter(p: ExtensionPlayer): void {
    if (p.characterId !== null) this.online.set(p.characterId, p);
    // Where runs start, so the client can draw the entrances and ask at one.
    const entrances = Object.entries(this.opts.content.entrances).map(([id, e]) => ({ id, name: e.name, x: e.x, z: e.z, radius: e.radius }));
    p.send({ kind: "dungeon", op: "entrances", entrances });
  }

  onLeave(p: ExtensionPlayer): void {
    if (p.characterId !== null) this.online.delete(p.characterId);
  }

  onMessage(p: ExtensionPlayer, raw: unknown): void {
    const m = raw as { op?: unknown; entrance?: unknown };
    if (m.op === "enter" && typeof m.entrance === "string" && m.entrance.length <= 64) {
      void this.enter(p, m.entrance).catch((err: unknown) => {
        this.opts.log?.(`[dungeons] starting an instance failed: ${(err as Error).message}`);
        this.notice(p, "the dungeon couldn't be opened");
      });
    } else this.notice(p, "malformed dungeon op");
  }

  /** Instances running now. */
  get count(): number {
    return this.running.size;
  }

  instances(): DungeonInstance[] {
    return [...this.running.values()].map((r) => r.instance);
  }

  /** Ask at an entrance: start the party's run, or let a member back into it. */
  async enter(p: ExtensionPlayer, entranceId: string): Promise<void> {
    const { content, pool } = this.opts;
    const rules = content.rules;
    const entrance = content.entrances[entranceId];
    if (p.characterId === null) return this.notice(p, "dungeons need a character");
    const e = p.entity();
    if (!entrance || e < 0 || (C.Transform.px[e] - entrance.x) ** 2 + (C.Transform.pz[e] - entrance.z) ** 2 > entrance.radius ** 2) {
      return this.notice(p, "there is no dungeon entrance here");
    }
    // Back into a run already under way.
    const mine = this.runOf(p.characterId);
    if (mine) {
      if (!rules.reentry) return this.notice(p, "you can't go back in");
      return this.transfer(p, mine, await this.member(p));
    }
    if (this.starting.has(p.characterId)) return;
    if (this.running.size >= rules.maxInstances) return this.notice(p, "every dungeon is busy; try again soon");
    const party = this.opts
      .partyOf(p.name)
      .map((n) => [...this.online.values()].find((o) => o.name.toLowerCase() === n.toLowerCase()))
      .filter((o): o is ExtensionPlayer => o !== undefined && o.characterId !== null && !this.runOf(o.characterId));
    const [min, max] = rules.partySize;
    if (party.length < min) return this.notice(p, `a party of at least ${min} is needed here`);
    if (party.length > max) return this.notice(p, `at most ${max} may enter together`);
    const id = `run-${(this.now() >>> 0).toString(36)}-${++this.seq}`;
    const layout = pool.pick(entrance.rank, entrance.themes, hashId(id));
    if (!layout) return this.notice(p, "no dungeon in the pool fits this entrance (run npm run dungeon:bake)");
    for (const o of party) this.starting.add(o.characterId!);
    try {
      const members = await Promise.all(party.map((o) => this.member(o)));
      const instance = new DungeonInstance({
        id,
        entrance: entranceId,
        layout,
        rules,
        game: this.opts.game(),
        members,
        credentialStore: this.opts.credentialStore,
        characterStore: this.opts.characterStore,
        weaponOf: this.opts.weaponOf,
        armourOf: this.opts.armourOf,
        lootPool: this.opts.lootPool?.() ?? [],
        chestPool: this.opts.chestPool?.() ?? [],
        onEnd: (result) => this.commit(result),
        transport: this.opts.transport,
        now: this.now,
      });
      const port = await instance.start();
      const run: Running = { instance, port, endpoint: this.opts.endpoint(port) };
      this.running.set(id, run);
      this.opts.log?.(`[dungeons] ${id}: "${layout.name}" (${layout.id}) for ${members.map((m) => m.name).join(", ")} on port ${port}`);
      party.forEach((o, i) => this.transfer(o, run, members[i]));
    } finally {
      for (const o of party) this.starting.delete(o.characterId!);
    }
  }

  /**
   * End every run now (the region shutting down, synchronously, before its
   * last save): each commits what it earned, then its port closes.
   */
  endAll(): void {
    for (const r of [...this.running.values()]) r.instance.end("abandoned");
  }

  private runOf(characterId: number): Running | undefined {
    for (const r of this.running.values()) if (!r.instance.ended && r.instance.isMember(characterId)) return r;
    return undefined;
  }

  private async member(p: ExtensionPlayer): Promise<InstanceMember> {
    const rec = await this.opts.characterStore.get(p.username, p.characterId!);
    return { characterId: p.characterId!, username: p.username, name: p.name, look: rec?.look ?? "" };
  }

  private transfer(p: ExtensionPlayer, run: Running, member: InstanceMember): void {
    const token = run.instance.admit(member);
    p.send({ kind: "dungeon", op: "transfer", endpoint: run.endpoint, token, instance: run.instance.id, dungeon: run.instance.layoutName });
  }

  private commit(result: InstanceResult): void {
    let granted = 0;
    let lost = 0;
    for (const l of result.loot) {
      if (this.opts.grant(l.characterId, l.def)) granted++;
      else lost++;
    }
    // Skill gains: one use of the killer's weapon skill per kill, at the
    // same difficulty as an open-world landed hit, keyed by victim kind
    // for repeat falloff. Deaths train nothing: per-hit defence events
    // never enter the batch.
    const train = this.opts.train;
    if (train) {
      const techniques = this.opts.game().rules.combat.techniques;
      for (const k of result.kills) {
        const skill = techniques[this.opts.weaponOf?.(k.characterId)?.technique ?? ""]?.skill;
        if (!skill) continue;
        const key = hashId(k.kind);
        for (let i = 0; i < k.count; i++) train(k.characterId, skill, FIGHT_DIFFICULTY, key);
      }
    }
    this.opts.results.record(result, granted, lost);
    this.opts.onCommitted?.(result);
    this.opts.log?.(
      `[dungeons] ${result.instance} ${result.outcome}: ${result.kills.reduce((n, k) => n + k.count, 0)} kill(s), ` +
        `${granted} item(s) granted${lost > 0 ? `, ${lost} lost (bags full)` : ""}`,
    );
    const run = this.running.get(result.instance);
    this.running.delete(result.instance);
    // Let the "ended" messages reach the clients before the port closes.
    if (run) setTimeout(() => void run.instance.close(), 2000).unref();
  }

  private notice(p: ExtensionPlayer, text: string): void {
    p.send({ kind: "chat", channel: "system", text, from: "", entity: "" });
  }
}

function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
