/**
 * Guilds (roadmap S4, CHARACTERS-AND-SOCIAL.md §5.5). A unique name (3-24) and
 * tag (2-5 letters), four ranks (leader, officer, member, recruit), up to 500
 * members, one guild per character, a MOTD and a change log for officers.
 * Exactly one leader; leaving or being purged hands the role to the
 * longest-standing officer (then member, then recruit), and an empty guild is
 * deleted. Members are keyed by lower-cased display name. Pure state with an
 * injected clock; the gateway owns sockets and fan-out. Every change writes
 * through to an optional GuildStore (SQLite in the server).
 */

import { z } from "zod";

export const GUILD_MAX = 500;
export const GUILD_INVITE_TTL_MS = 60_000;
export const GUILD_MOTD_MAX = 200;
export const GUILD_LOG_KEEP = 200;

export const GUILD_RANKS = ["leader", "officer", "member", "recruit"] as const;
export type GuildRank = (typeof GUILD_RANKS)[number];
/** Higher outranks lower. */
const POWER: Record<GuildRank, number> = { leader: 3, officer: 2, member: 1, recruit: 0 };

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u;
const TAG_RE = /^\p{L}{2,5}$/u;

export const GuildOpSchema = z
  .object({
    kind: z.literal("guild"),
    op: z.enum(["create", "invite", "accept", "leave", "kick", "setRank", "motd"]),
    /** create: the guild name; invite, kick, setRank: the character. */
    name: z.string().trim().min(1).max(32).optional(),
    tag: z.string().trim().min(1).max(8).optional(),
    rank: z.enum(GUILD_RANKS).optional(),
    text: z.string().max(GUILD_MOTD_MAX).optional(),
  })
  .strict()
  .refine(
    (m) => {
      const name = m.name !== undefined;
      const tag = m.tag !== undefined;
      const rank = m.rank !== undefined;
      const text = m.text !== undefined;
      switch (m.op) {
        case "create":
          return name && tag && !rank && !text;
        case "invite":
        case "kick":
          return name && !tag && !rank && !text;
        case "setRank":
          return name && rank && !tag && !text;
        case "motd":
          return text && !name && !tag && !rank;
        default:
          return !name && !tag && !rank && !text;
      }
    },
    { message: "wrong fields for this guild op" },
  );

export interface GuildMemberInfo {
  name: string;
  rank: GuildRank;
  online: boolean;
}
export interface GuildLogEntry {
  at: number;
  text: string;
}

/** What a guild op did: `notify` are the display names whose view changed. */
export type GuildResult = { ok: true; notify: string[] } | { ok: false; reason: string };

interface Member {
  key: string;
  name: string;
  rank: GuildRank;
  joinedAt: number;
}
interface Guild {
  id: number;
  name: string;
  tag: string;
  motd: string;
  /** Join order: the longest-standing member is first. */
  members: Member[];
  log: GuildLogEntry[];
}

/** Persisted shape of one guild (no log; entries are appended separately). */
export interface GuildRecord {
  id: number;
  name: string;
  tag: string;
  motd: string;
  members: Array<{ name: string; rank: GuildRank; joinedAt: number }>;
}

/** Synchronous write-through storage; `memoryGuildStore` is the default. */
export interface GuildStore {
  loadAll(): { guilds: GuildRecord[]; log: Array<{ guild: number; at: number; text: string }> };
  saveGuild(g: GuildRecord): void;
  deleteGuild(id: number): void;
  /** Keeps the newest `keep` lines of the guild (default GUILD_LOG_KEEP). */
  appendLog(guild: number, at: number, text: string, keep?: number): void;
}

export function memoryGuildStore(): GuildStore {
  const guilds = new Map<number, GuildRecord>();
  const log: Array<{ guild: number; at: number; text: string }> = [];
  return {
    loadAll: () => ({ guilds: [...guilds.values()].map((g) => structuredClone(g)), log: [...log] }),
    saveGuild: (g) => void guilds.set(g.id, structuredClone(g)),
    deleteGuild: (id) => void guilds.delete(id),
    appendLog: (guild, at, text) => void log.push({ guild, at, text }),
  };
}

const key = (n: string): string => n.toLowerCase();
const norm = (n: string): string => n.trim().replace(/\s+/g, " ");

export class GuildBook {
  private nextId = 1;
  private readonly guilds = new Map<number, Guild>();
  private readonly byMember = new Map<string, number>();
  private readonly invites = new Map<string, { guild: number; from: string; expires: number }>();
  private readonly online = new Set<string>();

  /** Size, invite timeout and text limits (social.json `guild`, EG9); setRules swaps them on a rules reload. */
  limits = { max: GUILD_MAX, inviteMs: GUILD_INVITE_TTL_MS, motdMax: GUILD_MOTD_MAX, logKeep: GUILD_LOG_KEEP };

  /** Fleet mode (PL3c): a new guild's id comes from the world (null: none to hand right now). Unset: counted here. */
  ids: (() => number | null) | null = null;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly store: GuildStore = memoryGuildStore(),
    max: number = GUILD_MAX,
  ) {
    this.limits.max = max;
    this.load();
  }

  /** Read every guild again from the store (another region changed some, PL3c); invites and who's online stay. */
  reload(): void {
    this.guilds.clear();
    this.byMember.clear();
    this.load();
  }

  private load(): void {
    const { guilds, log } = this.store.loadAll();
    for (const r of guilds) {
      const g: Guild = {
        id: r.id,
        name: r.name,
        tag: r.tag,
        motd: r.motd,
        members: r.members.map((m) => ({ key: key(m.name), name: m.name, rank: m.rank, joinedAt: m.joinedAt })),
        log: [],
      };
      this.guilds.set(g.id, g);
      for (const m of g.members) this.byMember.set(m.key, g.id);
      this.nextId = Math.max(this.nextId, g.id + 1);
    }
    for (const l of log) this.guilds.get(l.guild)?.log.push({ at: l.at, text: l.text });
    for (const g of this.guilds.values()) g.log = g.log.slice(-GUILD_LOG_KEEP);
  }

  private guildFor(name: string): Guild | undefined {
    const id = this.byMember.get(key(name));
    return id === undefined ? undefined : this.guilds.get(id);
  }

  private memberOf(g: Guild, name: string): Member | undefined {
    const k = key(name);
    return g.members.find((m) => m.key === k);
  }

  private save(g: Guild): void {
    this.store.saveGuild({
      id: g.id,
      name: g.name,
      tag: g.tag,
      motd: g.motd,
      members: g.members.map((m) => ({ name: m.name, rank: m.rank, joinedAt: m.joinedAt })),
    });
  }

  private note(g: Guild, text: string): void {
    const at = this.clock();
    g.log.push({ at, text });
    while (g.log.length > this.limits.logKeep) g.log.shift();
    this.store.appendLog(g.id, at, text, this.limits.logKeep);
  }

  private everyone(g: Guild): string[] {
    return g.members.map((m) => m.name);
  }

  /** The character's guild tag ("" when in none), for nameplates. */
  tagOf(name: string): string {
    return this.guildFor(name)?.tag ?? "";
  }

  guildName(name: string): string | null {
    return this.guildFor(name)?.name ?? null;
  }

  rankOf(name: string): GuildRank | null {
    const g = this.guildFor(name);
    return g ? (this.memberOf(g, name)?.rank ?? null) : null;
  }

  /** Display names of the character's guild (empty when in none). */
  guildOf(name: string): string[] {
    const g = this.guildFor(name);
    return g ? this.everyone(g) : [];
  }

  members(name: string): GuildMemberInfo[] {
    const g = this.guildFor(name);
    if (!g) return [];
    return g.members.map((m) => ({ name: m.name, rank: m.rank, online: this.online.has(m.key) }));
  }

  motd(name: string): string {
    return this.guildFor(name)?.motd ?? "";
  }

  /** The change log, for officers and the leader only (else empty). */
  logFor(name: string): GuildLogEntry[] {
    const g = this.guildFor(name);
    const me = g && this.memberOf(g, name);
    return g && me && POWER[me.rank] >= POWER.officer ? [...g.log] : [];
  }

  pendingInvite(name: string): { from: string; guild: string } | null {
    const inv = this.invites.get(key(name));
    const g = inv && this.guilds.get(inv.guild);
    if (!inv || !g || inv.expires <= this.clock()) return null;
    return { from: inv.from, guild: g.name };
  }

  create(founder: string, rawName: string, rawTag: string): GuildResult {
    if (this.guildFor(founder)) return { ok: false, reason: "already in a guild" };
    const name = norm(rawName);
    const tag = rawTag.trim().toUpperCase();
    if (name.length < 3 || name.length > 24 || !NAME_RE.test(name)) {
      return { ok: false, reason: "guild name must be 3-24 letters, digits, spaces, apostrophes or hyphens" };
    }
    if (!TAG_RE.test(tag)) return { ok: false, reason: "guild tag must be 2-5 letters" };
    for (const g of this.guilds.values()) {
      if (key(g.name) === key(name)) return { ok: false, reason: "guild name is taken" };
      if (g.tag === tag) return { ok: false, reason: "guild tag is taken" };
    }
    const id = this.ids ? this.ids() : this.nextId++;
    if (id === null) return { ok: false, reason: "guilds can't be founded this moment; try again shortly" };
    const g: Guild = {
      id,
      name,
      tag,
      motd: "",
      members: [{ key: key(founder), name: founder, rank: "leader", joinedAt: this.clock() }],
      log: [],
    };
    this.guilds.set(g.id, g);
    this.byMember.set(key(founder), g.id);
    this.save(g);
    this.note(g, `${founder} founded ${name} [${tag}]`);
    return { ok: true, notify: [founder] };
  }

  invite(from: string, to: string): GuildResult {
    const g = this.guildFor(from);
    if (!g) return { ok: false, reason: "not in a guild" };
    const me = this.memberOf(g, from)!;
    if (POWER[me.rank] < POWER.officer) return { ok: false, reason: "officers and above can invite" };
    if (key(from) === key(to)) return { ok: false, reason: "cannot invite yourself" };
    if (this.byMember.has(key(to))) return { ok: false, reason: "already in a guild" };
    if (g.members.length >= this.limits.max) return { ok: false, reason: "guild is full" };
    this.invites.set(key(to), { guild: g.id, from: me.name, expires: this.clock() + this.limits.inviteMs });
    return { ok: true, notify: [to] };
  }

  accept(name: string): GuildResult {
    const k = key(name);
    const inv = this.invites.get(k);
    this.invites.delete(k);
    const g = inv && this.guilds.get(inv.guild);
    if (!inv || !g || inv.expires <= this.clock()) return { ok: false, reason: "no invite" };
    if (this.byMember.has(k)) return { ok: false, reason: "already in a guild" };
    if (g.members.length >= this.limits.max) return { ok: false, reason: "guild is full" };
    g.members.push({ key: k, name, rank: "recruit", joinedAt: this.clock() });
    this.byMember.set(k, g.id);
    this.save(g);
    this.note(g, `${name} joined (invited by ${inv.from})`);
    return { ok: true, notify: this.everyone(g) };
  }

  /** Leave; notify the leaver and whoever remains. */
  leave(name: string): GuildResult {
    const g = this.guildFor(name);
    if (!g) return { ok: false, reason: "not in a guild" };
    this.note(g, `${name} left`);
    return { ok: true, notify: [name, ...this.remove(g, key(name))] };
  }

  /** A deleted character leaves their guild like anyone else (leadership passes on). */
  purge(name: string): string[] {
    const g = this.guildFor(name);
    if (!g) return [];
    this.note(g, `${name} was deleted`);
    return [name, ...this.remove(g, key(name))];
  }

  kick(actor: string, target: string): GuildResult {
    const g = this.guildFor(actor);
    if (!g) return { ok: false, reason: "not in a guild" };
    const me = this.memberOf(g, actor)!;
    if (POWER[me.rank] < POWER.officer) return { ok: false, reason: "officers and above can kick" };
    const t = this.memberOf(g, target);
    if (!t) return { ok: false, reason: "not in your guild" };
    if (POWER[t.rank] >= POWER[me.rank]) return { ok: false, reason: "you can only kick lower ranks" };
    this.note(g, `${me.name} kicked ${t.name}`);
    return { ok: true, notify: [t.name, ...this.remove(g, t.key)] };
  }

  /**
   * Promote or demote. Officers act on members and recruits (up to member);
   * the leader sets any rank, and making someone leader hands the role over
   * (the old leader becomes an officer).
   */
  setRank(actor: string, target: string, rank: GuildRank): GuildResult {
    const g = this.guildFor(actor);
    if (!g) return { ok: false, reason: "not in a guild" };
    const me = this.memberOf(g, actor)!;
    if (POWER[me.rank] < POWER.officer) return { ok: false, reason: "officers and above can change ranks" };
    const t = this.memberOf(g, target);
    if (!t) return { ok: false, reason: "not in your guild" };
    if (t === me) return { ok: false, reason: "cannot change your own rank" };
    if (POWER[t.rank] >= POWER[me.rank]) return { ok: false, reason: "you can only change lower ranks" };
    if (rank === t.rank) return { ok: false, reason: `already ${rank}` };
    if (rank === "leader") {
      if (me.rank !== "leader") return { ok: false, reason: "only the leader can hand over leadership" };
      me.rank = "officer";
      t.rank = "leader";
      this.note(g, `${me.name} handed leadership to ${t.name}`);
    } else {
      if (POWER[rank] >= POWER[me.rank]) return { ok: false, reason: "you can only set ranks below your own" };
      const up = POWER[rank] > POWER[t.rank];
      t.rank = rank;
      this.note(g, `${me.name} ${up ? "promoted" : "demoted"} ${t.name} to ${rank}`);
    }
    this.save(g);
    return { ok: true, notify: this.everyone(g) };
  }

  setRules(r: { max: number; inviteSeconds: number; motdMax: number; logKeep: number }): void {
    this.limits = { max: r.max, inviteMs: r.inviteSeconds * 1000, motdMax: r.motdMax, logKeep: r.logKeep };
  }

  setMotd(actor: string, text: string): GuildResult {
    const g = this.guildFor(actor);
    if (!g) return { ok: false, reason: "not in a guild" };
    const me = this.memberOf(g, actor)!;
    if (POWER[me.rank] < POWER.officer) return { ok: false, reason: "officers and above can edit the message of the day" };
    g.motd = text.trim().slice(0, this.limits.motdMax);
    this.save(g);
    this.note(g, `${me.name} set the message of the day`);
    return { ok: true, notify: this.everyone(g) };
  }

  setOnline(name: string, on: boolean): void {
    if (on) this.online.add(key(name));
    else this.online.delete(key(name));
  }

  /** Drop lapsed invites. */
  sweep(): void {
    const now = this.clock();
    for (const [k, inv] of this.invites) if (inv.expires <= now) this.invites.delete(k);
  }

  /** Remove a member, passing leadership on; delete the guild when empty. Returns who remains. */
  private remove(g: Guild, k: string): string[] {
    const was = g.members.find((m) => m.key === k);
    g.members = g.members.filter((m) => m.key !== k);
    this.byMember.delete(k);
    if (g.members.length === 0) {
      this.guilds.delete(g.id);
      this.store.deleteGuild(g.id);
      return [];
    }
    if (was?.rank === "leader") {
      // Longest-standing officer, else member, else recruit (join order breaks ties).
      let heir = g.members[0] as Member;
      for (const m of g.members) if (POWER[m.rank] > POWER[heir.rank]) heir = m;
      heir.rank = "leader";
      this.note(g, `${heir.name} became leader`);
    }
    this.save(g);
    return this.everyone(g);
  }
}
