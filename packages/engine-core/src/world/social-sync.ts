/**
 * SocialWorldSync — PL3c of docs/superpowers/specs/2026-10-23-region-hot-cache-design.md: guilds,
 * parties, friends and blocks are world records every region shares; the region's SQLite stores are a
 * working cache of them, and its books (GuildBook, PartyBook, FriendBook, BlockList) read that cache.
 *
 *   boot()     before the books exist: guilds and parties only this region knows (from before fleet
 *              mode) get world ids and go uphill, friends and block lists the world lacks go uphill,
 *              then every world record is written into the local stores. Ids for new guilds and
 *              parties come from a pool the world allocates (takeId).
 *   writes     the books write through the tracked stores this exposes, which mark the record dirty;
 *              push() (the 1 s save timer) sends each dirty record, guarded by the version this region
 *              last saw. A 409 means another region wrote first: the local edit is dropped (logged)
 *              and the world's copy reread.
 *   refresh()  (every 60 s) newer world records are written into the stores, and the books reload.
 *
 * Nothing here runs on the tick. A world outage leaves the local stores as they are and retries.
 * ponytail: refresh reads every record of a kind each time; a change cursor when the lists grow.
 */

import type { SocialKind, SocialRecord } from "@mmo-engine/world-server";
import type { GuildRecord, GuildStore } from "../guild.js";
import type { PartyRecord, PartyStore } from "../party.js";
import type { SocialStore } from "../social-store.js";
import { WorldTransportError } from "./client.js";

/** The slice of WorldClient this needs (tests substitute a fake). */
export interface SocialWorldClient {
  putSocialRecord(kind: SocialKind, key: string, doc: unknown, expectedVersion: number): Promise<SocialRecord>;
  getSocialRecords(kind: SocialKind): Promise<SocialRecord[]>;
  allocateSocialIds(kind: "guild" | "party", count: number): Promise<number[]>;
}

export interface SocialWorldSyncOptions {
  client: SocialWorldClient;
  guilds: GuildStore;
  parties: PartyStore;
  social: SocialStore;
  /** The books re-read a kind from its store (Gateway.reloadSocial). */
  reload?: (kind: SocialKind) => void;
  log?: (line: string) => void;
}

const KINDS: readonly SocialKind[] = ["guild", "party", "friends", "blocks"];
const POOL = 8;

type GuildDoc = GuildRecord & { log: Array<{ at: number; text: string }> };
type BlockDoc = Array<{ target: string; name: string }>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class SocialWorldSync {
  /** The stores to hand the gateway: each write marks its record dirty. */
  readonly guildStore: GuildStore;
  readonly partyStore: PartyStore;
  readonly socialStore: SocialStore;

  private readonly known = new Map<string, number>();
  /** Records written here and not yet uphill; `seq` tells an edit made during its upload from the one sent. */
  private readonly dirty = new Map<string, { kind: SocialKind; key: string; seq: number }>();
  private seq = 0;
  private readonly pools = { guild: [] as number[], party: [] as number[] };
  private readonly refilling = new Set<"guild" | "party">();
  private pushing = false;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: SocialWorldSyncOptions) {
    this.log = opts.log ?? (() => {});
    const mark = (kind: SocialKind, key: string): void => {
      this.dirty.set(`${kind}:${key}`, { kind, key, seq: ++this.seq });
    };
    const { guilds, parties, social } = opts;
    this.guildStore = {
      loadAll: () => guilds.loadAll(),
      saveGuild: (g) => { guilds.saveGuild(g); mark("guild", String(g.id)); },
      deleteGuild: (id) => { guilds.deleteGuild(id); mark("guild", String(id)); },
      appendLog: (guild, at, text, keep) => { guilds.appendLog(guild, at, text, keep); mark("guild", String(guild)); },
    };
    this.partyStore = {
      loadAll: () => parties.loadAll(),
      saveParty: (p) => { parties.saveParty(p); mark("party", String(p.id)); },
      deleteParty: (id) => { parties.deleteParty(id); mark("party", String(id)); },
    };
    this.socialStore = {
      loadFriends: () => social.loadFriends(),
      addFriend: (owner, friend) => { social.addFriend(owner, friend); mark("friends", owner.toLowerCase()); },
      removeFriend: (owner, friend) => { social.removeFriend(owner, friend); mark("friends", owner.toLowerCase()); },
      loadBlocks: () => social.loadBlocks(),
      addBlock: (blocker, target, name) => { social.addBlock(blocker, target, name); mark("blocks", blocker.toLowerCase()); },
      removeBlock: (blocker, target) => { social.removeBlock(blocker, target); mark("blocks", blocker.toLowerCase()); },
    };
  }

  /** Seed the local stores from the world (renumbering what only this region had), and fill the id pools. */
  async boot(): Promise<void> {
    try {
      for (const kind of KINDS) {
        const records = await this.opts.client.getSocialRecords(kind);
        const world = new Set(records.map((r) => r.key));
        for (const [key, doc] of this.localDocs(kind)) {
          // World guild and party ids start at SOCIAL_ID_BASE, so an id from before fleet mode never matches one.
          if (world.has(key)) continue;
          // Only this region has it (made before fleet mode): it goes uphill, a guild or party under a world id.
          let worldKey = key;
          let worldDoc = doc;
          if (kind === "guild" || kind === "party") {
            const [id] = await this.opts.client.allocateSocialIds(kind, 1);
            worldKey = String(id);
            worldDoc = { ...(doc as Record<string, unknown>), id };
            if (kind === "guild") this.opts.guilds.deleteGuild(Number(key));
            else this.opts.parties.deleteParty(Number(key));
            this.log(`social: ${kind} ${key} renumbered to world id ${id}`);
          }
          records.push(await this.opts.client.putSocialRecord(kind, worldKey, worldDoc, 0));
        }
        for (const r of records) this.apply(r);
      }
      await Promise.all([this.refill("guild"), this.refill("party")]);
      this.log("social: guilds, parties, friends and blocks seeded from the world");
    } catch (err) {
      this.log(`social: world sync at boot failed (${(err as Error).message}); the local stores stand`);
    }
  }

  /** A world id for a new guild or party (null: the pool is empty; it refills in the background). */
  takeId(kind: "guild" | "party"): number | null {
    const pool = this.pools[kind];
    const id = pool.shift() ?? null;
    if (pool.length < POOL / 2) void this.refill(kind);
    return id;
  }

  /** Send every dirty record uphill (the save timer). Overlapping calls skip. Never throws. */
  async push(): Promise<void> {
    if (this.pushing || this.dirty.size === 0) return;
    this.pushing = true;
    const conflicts = new Set<SocialKind>();
    try {
      for (const [k, { kind, key, seq }] of [...this.dirty]) {
        const doc = this.localDoc(kind, key);
        // An edit made while this upload is in flight re-marks the record: it stays dirty for the next cycle.
        const sent = (): void => {
          if (this.dirty.get(k)?.seq === seq) this.dirty.delete(k);
        };
        try {
          const r = await this.opts.client.putSocialRecord(kind, key, doc, this.known.get(k) ?? 0);
          this.known.set(k, r.version);
          sent();
        } catch (err) {
          if (err instanceof WorldTransportError && err.code === 409) {
            sent();
            conflicts.add(kind);
            this.log(`social: ${kind} ${key} changed on another region first; this region's edit is dropped and the world's copy reread`);
          } else {
            this.log(`social: ${kind} ${key} not sent (${(err as Error).message}); retrying next cycle`);
            break;
          }
        }
      }
    } finally {
      this.pushing = false;
    }
    if (conflicts.size > 0) await this.refresh([...conflicts]);
  }

  /** Write newer world records into the local stores and reload the books that changed. Never throws. */
  async refresh(kinds: readonly SocialKind[] = KINDS): Promise<void> {
    for (const kind of kinds) {
      let records: SocialRecord[];
      try {
        records = await this.opts.client.getSocialRecords(kind);
      } catch (err) {
        this.log(`social: ${kind} refresh failed (${(err as Error).message})`);
        continue;
      }
      let changed = false;
      for (const r of records) {
        const k = `${kind}:${r.key}`;
        if (this.dirty.has(k) || (this.known.get(k) ?? 0) >= r.version) continue;
        this.apply(r);
        changed = true;
      }
      if (changed) this.opts.reload?.(kind);
    }
  }

  /** One world record into the local store (raw: no dirty mark), and its version remembered. */
  private apply(r: SocialRecord): void {
    this.known.set(`${r.kind}:${r.key}`, r.version);
    const doc = r.doc;
    if (r.kind === "guild") {
      const id = Number(r.key);
      this.opts.guilds.deleteGuild(id);
      if (!isObj(doc)) return;
      const g = doc as unknown as GuildDoc;
      this.opts.guilds.saveGuild({ id, name: g.name, tag: g.tag, motd: g.motd, members: g.members ?? [] });
      for (const l of g.log ?? []) this.opts.guilds.appendLog(id, l.at, l.text);
    } else if (r.kind === "party") {
      const id = Number(r.key);
      this.opts.parties.deleteParty(id);
      if (isObj(doc)) this.opts.parties.saveParty({ ...(doc as unknown as PartyRecord), id });
    } else if (r.kind === "friends") {
      for (const f of this.opts.social.loadFriends()) if (f.owner === r.key) this.opts.social.removeFriend(r.key, f.friend);
      for (const name of Array.isArray(doc) ? doc : []) if (typeof name === "string") this.opts.social.addFriend(r.key, name);
    } else {
      for (const b of this.opts.social.loadBlocks()) if (b.blocker === r.key) this.opts.social.removeBlock(r.key, b.target);
      for (const b of (Array.isArray(doc) ? doc : []) as BlockDoc) {
        if (isObj(b) && typeof b.target === "string") this.opts.social.addBlock(r.key, b.target, typeof b.name === "string" ? b.name : b.target);
      }
    }
  }

  /** A record's content from the local store; null when it's gone (a deleted guild or party). */
  private localDoc(kind: SocialKind, key: string): unknown {
    return this.localDocs(kind).get(key) ?? (kind === "friends" || kind === "blocks" ? [] : null);
  }

  private localDocs(kind: SocialKind): Map<string, unknown> {
    const out = new Map<string, unknown>();
    if (kind === "guild") {
      const { guilds, log } = this.opts.guilds.loadAll();
      for (const g of guilds) out.set(String(g.id), { ...g, log: log.filter((l) => l.guild === g.id).map(({ at, text }) => ({ at, text })) });
    } else if (kind === "party") {
      for (const p of this.opts.parties.loadAll()) out.set(String(p.id), p);
    } else if (kind === "friends") {
      for (const f of this.opts.social.loadFriends()) {
        const list = (out.get(f.owner) as string[] | undefined) ?? [];
        list.push(f.friend);
        out.set(f.owner, list);
      }
    } else {
      for (const b of this.opts.social.loadBlocks()) {
        const list = (out.get(b.blocker) as BlockDoc | undefined) ?? [];
        list.push({ target: b.target, name: b.name ?? b.target });
        out.set(b.blocker, list);
      }
    }
    return out;
  }

  private async refill(kind: "guild" | "party"): Promise<void> {
    if (this.refilling.has(kind)) return;
    this.refilling.add(kind);
    try {
      this.pools[kind].push(...(await this.opts.client.allocateSocialIds(kind, POOL)));
    } catch (err) {
      this.log(`social: no ${kind} ids from the world (${(err as Error).message}); new ${kind}s wait for them`);
    } finally {
      this.refilling.delete(kind);
    }
  }
}
