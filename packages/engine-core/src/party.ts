/**
 * Parties (roadmap S3, CHARACTERS-AND-SOCIAL.md §5.4): up to 6 members, the
 * leader invites, kicks and promotes, anyone leaves. Invites lapse after 60 s,
 * a party down to one member disbands, and a member who logs out is removed
 * after 5 minutes. Members are keyed by lower-cased display name. Pure state
 * with an injected clock: the gateway owns sockets and fan-out. Parties write
 * through to a `PartyStore` (SQLite in the server, S3b), so they survive a
 * restart: everyone comes back offline and has the usual 5 minutes to log in.
 * Invites are not kept.
 */

import { z } from "zod";

export const PARTY_MAX = 6;
export const INVITE_TTL_MS = 60_000;
export const OFFLINE_TTL_MS = 5 * 60_000;

export const PartyOpSchema = z
  .object({
    kind: z.literal("party"),
    op: z.enum(["invite", "accept", "leave", "kick", "promote"]),
    name: z.string().trim().min(1).max(32).optional(),
  })
  .strict()
  .refine((m) => (m.op === "accept" || m.op === "leave") === (m.name === undefined), {
    message: "invite, kick and promote need a name; accept and leave must not have one",
  });

export interface PartyMember {
  name: string;
  leader: boolean;
  online: boolean;
}

/** What a party op did: `notify` are the display names whose view changed. */
export type PartyResult = { ok: true; notify: string[] } | { ok: false; reason: string };

/** A stored party: member keys in join order, with their display names. */
export interface PartyRecord {
  id: number;
  leader: string;
  members: Array<{ key: string; name: string }>;
}

/** Synchronous write-through storage; `memoryPartyStore` is the default. */
export interface PartyStore {
  loadAll(): PartyRecord[];
  saveParty(p: PartyRecord): void;
  deleteParty(id: number): void;
}

export function memoryPartyStore(): PartyStore {
  const parties = new Map<number, PartyRecord>();
  return {
    loadAll: () => [...parties.values()].map((p) => structuredClone(p)),
    saveParty: (p) => void parties.set(p.id, structuredClone(p)),
    deleteParty: (id) => void parties.delete(id),
  };
}

interface Party {
  id: number;
  /** Join order: the longest-standing member is first. */
  members: string[];
  leader: string;
}

const key = (n: string): string => n.toLowerCase();

export class PartyBook {
  private nextId = 1;
  private readonly parties = new Map<number, Party>();
  private readonly byMember = new Map<string, number>();
  /** invitee key -> invite (party 0 = the inviter has no party yet). */
  private readonly invites = new Map<string, { party: number; from: string; expires: number }>();
  /** member key -> when they went offline. */
  private readonly offline = new Map<string, number>();
  /** Display names by key. */
  private readonly names = new Map<string, string>();

  /** Size and timeouts (social.json `party`, EG9); setRules swaps them on a rules reload. */
  limits = { max: PARTY_MAX, inviteMs: INVITE_TTL_MS, offlineMs: OFFLINE_TTL_MS };

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly store: PartyStore = memoryPartyStore(),
  ) {
    const now = clock();
    for (const r of store.loadAll()) {
      const party: Party = { id: r.id, members: r.members.map((m) => m.key), leader: r.leader };
      this.parties.set(r.id, party);
      for (const m of r.members) {
        this.byMember.set(m.key, r.id);
        this.names.set(m.key, m.name);
        // A restart is a logout for everyone: the offline timer starts now.
        this.offline.set(m.key, now);
      }
      this.nextId = Math.max(this.nextId, r.id + 1);
    }
  }

  private save(party: Party): void {
    this.store.saveParty({
      id: party.id,
      leader: party.leader,
      members: party.members.map((m) => ({ key: m, name: this.display(m) })),
    });
  }

  private partyFor(name: string): Party | undefined {
    const pid = this.byMember.get(key(name));
    return pid === undefined ? undefined : this.parties.get(pid);
  }

  private display(k: string): string {
    return this.names.get(k) ?? k;
  }

  /** Display names of everyone in the caller's party (empty when in none). */
  partyOf(name: string): string[] {
    return this.partyFor(name)?.members.map((m) => this.display(m)) ?? [];
  }

  members(name: string): PartyMember[] {
    const p = this.partyFor(name);
    if (!p) return [];
    return p.members.map((m) => ({ name: this.display(m), leader: m === p.leader, online: !this.offline.has(m) }));
  }

  /** The invite waiting for `name`, if still live. */
  pendingInvite(name: string): { from: string } | null {
    const inv = this.invites.get(key(name));
    if (!inv || inv.expires <= this.clock()) return null;
    return { from: this.display(inv.from) };
  }

  /** `from` invites `to` (the gateway checks both are online and unblocked). */
  invite(from: string, to: string): PartyResult {
    const f = key(from);
    const t = key(to);
    if (f === t) return { ok: false, reason: "cannot invite yourself" };
    this.names.set(f, from);
    this.names.set(t, to);
    const party = this.partyFor(from);
    if (party && party.leader !== f) return { ok: false, reason: "only the leader can invite" };
    if (party && party.members.length >= this.limits.max) return { ok: false, reason: "party is full" };
    if (this.byMember.has(t)) return { ok: false, reason: "already in a party" };
    this.invites.set(t, { party: party?.id ?? 0, from: f, expires: this.clock() + this.limits.inviteMs });
    return { ok: true, notify: [from, to] };
  }

  accept(name: string): PartyResult {
    const n = key(name);
    const inv = this.invites.get(n);
    if (!inv || inv.expires <= this.clock()) {
      this.invites.delete(n);
      return { ok: false, reason: "no invite" };
    }
    this.invites.delete(n);
    this.names.set(n, name);
    if (this.byMember.has(n)) return { ok: false, reason: "already in a party" };
    let party = this.parties.get(inv.party);
    if (!party) {
      // A first invite makes the party when it is accepted, if the inviter is still free.
      if (inv.party !== 0 || this.byMember.has(inv.from)) return { ok: false, reason: "invite is no longer valid" };
      party = { id: this.nextId++, members: [inv.from], leader: inv.from };
      this.parties.set(party.id, party);
      this.byMember.set(inv.from, party.id);
    }
    if (party.members.length >= this.limits.max) return { ok: false, reason: "party is full" };
    party.members.push(n);
    this.byMember.set(n, party.id);
    this.save(party);
    return { ok: true, notify: this.partyOf(name) };
  }

  /** Leave; notify the leaver and whoever remains. */
  leave(name: string): PartyResult {
    const pid = this.byMember.get(key(name));
    if (pid === undefined) return { ok: false, reason: "not in a party" };
    return { ok: true, notify: [name, ...this.remove(pid, key(name))] };
  }

  kick(leader: string, target: string): PartyResult {
    const party = this.partyFor(leader);
    if (!party) return { ok: false, reason: "not in a party" };
    if (party.leader !== key(leader)) return { ok: false, reason: "only the leader can kick" };
    const t = key(target);
    if (t === party.leader || !party.members.includes(t)) return { ok: false, reason: "not in your party" };
    return { ok: true, notify: [this.display(t), ...this.remove(party.id, t)] };
  }

  promote(leader: string, target: string): PartyResult {
    const party = this.partyFor(leader);
    if (!party) return { ok: false, reason: "not in a party" };
    if (party.leader !== key(leader)) return { ok: false, reason: "only the leader can promote" };
    const t = key(target);
    if (t === party.leader || !party.members.includes(t)) return { ok: false, reason: "not in your party" };
    party.leader = t;
    this.save(party);
    return { ok: true, notify: party.members.map((m) => this.display(m)) };
  }

  setRules(r: { max: number; inviteSeconds: number; offlineMinutes: number }): void {
    this.limits = { max: r.max, inviteMs: r.inviteSeconds * 1000, offlineMs: r.offlineMinutes * 60_000 };
  }

  setOnline(name: string, online: boolean): void {
    const n = key(name);
    if (!this.byMember.has(n)) return;
    if (online) this.offline.delete(n);
    else this.offline.set(n, this.clock());
  }

  /** Drop lapsed invites and members offline too long; returns display names whose party changed. */
  sweep(): string[] {
    const now = this.clock();
    const changed: string[] = [];
    for (const [k, inv] of this.invites) if (inv.expires <= now) this.invites.delete(k);
    for (const [k, since] of [...this.offline]) {
      if (now - since < this.limits.offlineMs) continue;
      const pid = this.byMember.get(k);
      if (pid !== undefined) changed.push(...this.remove(pid, k));
    }
    return changed;
  }

  /** Remove a member; disband at one left, hand over leadership. Returns who remains. */
  private remove(pid: number, k: string): string[] {
    const party = this.parties.get(pid);
    this.byMember.delete(k);
    this.offline.delete(k);
    if (!party) return [];
    party.members = party.members.filter((m) => m !== k);
    if (party.members.length <= 1) {
      const left = party.members.map((m) => this.display(m));
      for (const m of party.members) this.byMember.delete(m);
      this.parties.delete(pid);
      this.store.deleteParty(pid);
      return left;
    }
    if (party.leader === k) party.leader = party.members[0] as string;
    this.save(party);
    return party.members.map((m) => this.display(m));
  }
}
