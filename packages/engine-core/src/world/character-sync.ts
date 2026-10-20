/**
 * WorldCharacterSync — persistence P4: global characters at the world
 * tier (PERSISTENCE-LAYER-SPEC, "Characters at the world tier", as
 * amended: in fleet mode the world DB is the single source of truth and
 * the local character store is a working cache).
 *
 * One instance per region process, built over the server's single
 * WorldClient (the P3 pattern: the registration/heartbeat/migration
 * client is reused, never a second one). Standalone mode (no
 * WORLD_URL) never constructs this class, so behaviour there is
 * byte-identical to the local-only store.
 *
 * Lifecycle of a character on this region:
 *
 *   login(id)   — acquire the world session lock BEFORE the character
 *                 is playable; a lock held by a live holder refuses
 *                 the login. Once held, the world record is the
 *                 authority: it seeds the local store (the working
 *                 cache) before the gateway's ordinary restore reads
 *                 it — the P3 seed-then-use-local pattern. No world
 *                 record yet (first fleet login of a pre-existing
 *                 character): the local record stands, and the first
 *                 working save establishes the world record.
 *   save(id)    — a working save on the gateway's existing save
 *                 cadence: the local state (just written by the local
 *                 save) is written uphill, fenced by the held lock's
 *                 epoch. A fenced rejection (lock stolen after expiry,
 *                 or expired) is a logged durability failure: this
 *                 region stops writing that character uphill — never
 *                 silently, never crashing the save cycle or session.
 *   logout(id)  — final commit uphill, then release the lock. If the
 *                 world is unreachable the local record remains the
 *                 fallback truth (logged) and the lock expires on its
 *                 own; logout never blocks on the world. Migration
 *                 commit uses this same path on the source region,
 *                 and login() on the destination (fresh epoch before
 *                 the character is playable there).
 *
 * Slice A2: this sync is also the fencing source for the world-tier
 * atomic operations. It tracks each held character's world record
 * version (login read, accepted puts, settled atomic outcomes) and
 * hands out ParticipantFences (held lock epoch + expected version)
 * through `fence()`; `applySettled()` records a settled operation's
 * records and reconciles the local economy caches to them. When the
 * server wires an economy view, payloads also carry the character's
 * gold + bag (the atomic operations' fields), so the two layers share
 * one world record instead of overwriting each other's halves.
 *
 * Lock renewal: the world offers no refresh op (acquire is refused
 * while a lock is held, even by its holder), so when a held lock
 * reaches its expiry a working save first tries to re-acquire. An
 * unexpired foreign lock refuses that (409) and fences this region
 * out; an expired, unstolen lock is re-acquired with a bumped epoch
 * and saving continues. Nothing here runs on the tick loop: login,
 * save and logout are all called from the gateway's async join/save/
 * sweep paths.
 */

import type {
  AtomicOpResult,
  CharacterSessionLock,
  CharacterStateRecord,
  InventoryItem,
  ParticipantFence,
} from "@mmo-engine/world-server";
import type { CharacterState, CharacterStore } from "../characters/store.js";
import type { SkillSave } from "../stats/mastery.js";
import { WorldTransportError } from "./client.js";

/** The slice of WorldClient character sync needs (tests substitute a fake). */
export interface CharacterWorldClient {
  getCharacterState(
    characterId: number,
  ): Promise<CharacterStateRecord | null>;
  putCharacterState(
    characterId: number,
    epoch: number,
    state: unknown,
  ): Promise<CharacterStateRecord>;
  acquireCharacterLock(
    characterId: number,
    ttlMs: number,
  ): Promise<CharacterSessionLock>;
  releaseCharacterLock(characterId: number, epoch: number): Promise<void>;
}

/**
 * Default session-lock lifetime. Long enough that renewal is a rare
 * event on the save cadence; a silently dead holder's character is
 * steal-able (and its owner's login unblocked) once this elapses.
 */
export const CHARACTER_LOCK_TTL_MS = 10 * 60_000;

/**
 * The character's economy at the world tier (slice A2): the same
 * `gold` + `inventory` fields the world-tier atomic operations read
 * and write on the character record. The sync carries them in its
 * payload (and seeds/reconciles them locally) when the server wires
 * an economy view, so a working save never wipes the fields an atomic
 * operation settled, and an atomic operation never starts from a
 * stale balance the region forgot to upload. Absent (no economy view
 * wired): the payload is exactly the P4 shape.
 */
export interface CharacterEconomyView {
  /** The character's local gold balance (the wallet's working cache). */
  goldOf(characterId: number): number;
  /** The character's bag at the world tier: one entry per bag item. */
  inventoryOf(characterId: number): InventoryItem[];
  /**
   * Apply the world's settled gold + inventory to the local caches:
   * the world record is truth, the local state reconciles to it.
   */
  reconcile(characterId: number, gold: number, inventory: InventoryItem[]): void;
  /**
   * Optional batch form (slice A2): reconcile every participant of
   * one settled operation together, so an item moving between two
   * participants is moved, never destroyed-and-recreated by the
   * first participant's pass before the second's runs. When present,
   * applySettled prefers it over per-character reconcile.
   */
  reconcileAll?(
    settled: Array<{ characterId: number; gold: number; inventory: InventoryItem[] }>,
  ): void;
}

/** The opaque world-tier payload: exactly what the local store keeps. */
export interface WorldCharacterState {
  state: CharacterState | null;
  skills: SkillSave | null;
  /** Slice A2: present when the world record carries economy fields. */
  gold?: number;
  inventory?: InventoryItem[];
}

/** The economy fields of a world record's state, when present and well-formed. */
export function economyOfState(
  state: unknown,
): { gold: number; inventory: InventoryItem[] } | null {
  if (state === null || typeof state !== "object") return null;
  const p = state as Record<string, unknown>;
  const gold = p["gold"];
  const inventory = p["inventory"];
  if (typeof gold !== "number" || !Number.isFinite(gold) || gold < 0) return null;
  if (!isInventory(inventory)) return null;
  return { gold: Math.floor(gold), inventory };
}

function isInventory(v: unknown): v is InventoryItem[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (i) =>
      i !== null &&
      typeof i === "object" &&
      typeof (i as InventoryItem).instanceId === "string" &&
      typeof (i as InventoryItem).def === "number" &&
      typeof (i as InventoryItem).slot === "number" &&
      typeof (i as InventoryItem).count === "number",
  );
}

function isCharacterState(v: unknown): v is CharacterState {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return ["x", "y", "z", "health", "stamina"].every(
    (k) => typeof s[k] === "number" && Number.isFinite(s[k] as number),
  );
}

function isSkillSave(v: unknown): v is SkillSave {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (row) =>
      Array.isArray(row) &&
      row.length === 3 &&
      row.every((n) => typeof n === "number" && Number.isFinite(n)),
  );
}

/**
 * Parse a world record's opaque state back into local-store shape.
 * Returns null when the payload is not one this build wrote — a
 * corrupt or foreign record must never displace the local cache.
 */
export function parseWorldCharacterState(
  state: unknown,
): WorldCharacterState | null {
  if (state === null || typeof state !== "object") return null;
  const p = state as Record<string, unknown>;
  const st = p["state"] ?? null;
  const sk = p["skills"] ?? null;
  if (st !== null && !isCharacterState(st)) return null;
  if (sk !== null && !isSkillSave(sk)) return null;
  if (st === null && sk === null) return null;
  const out: WorldCharacterState = { state: st, skills: sk };
  // Slice A2 economy fields: carried only when present and well-formed;
  // a corrupt economy field makes the record unusable, like any other.
  if (p["gold"] !== undefined || p["inventory"] !== undefined) {
    const eco = economyOfState(p);
    if (eco === null) return null;
    out.gold = eco.gold;
    out.inventory = eco.inventory;
  }
  return out;
}

/** The world-tier payload for a character, read from the local store. */
export function worldCharacterPayload(
  store: CharacterStore,
  characterId: number,
  economy?: CharacterEconomyView,
): WorldCharacterState {
  const out: WorldCharacterState = {
    state: store.loadState?.(characterId) ?? null,
    skills: store.loadSkills?.(characterId) ?? null,
  };
  if (economy) {
    out.gold = economy.goldOf(characterId);
    out.inventory = economy.inventoryOf(characterId);
  }
  return out;
}

/** Seed the local working cache from a world-tier payload. */
export function seedLocalCharacter(
  store: CharacterStore,
  characterId: number,
  payload: WorldCharacterState,
  economy?: CharacterEconomyView,
): void {
  if (payload.state && store.saveState) store.saveState(characterId, payload.state);
  if (payload.skills && store.saveSkills) {
    store.saveSkills(characterId, payload.skills);
  }
  if (economy && payload.gold !== undefined && payload.inventory !== undefined) {
    economy.reconcile(characterId, payload.gold, payload.inventory);
  }
}

export interface WorldCharacterSyncOptions {
  client: CharacterWorldClient;
  /** The local character store: the working cache this sync seeds and reads. */
  store: CharacterStore;
  /**
   * Slice A2: the region's economy view (wallet + bag). When wired,
   * payloads carry gold + inventory and settled atomic outcomes
   * reconcile the local caches. Absent: P4 behaviour exactly.
   */
  economy?: CharacterEconomyView;
  /** Session-lock lifetime per acquire (default CHARACTER_LOCK_TTL_MS). */
  lockTtlMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export type CharacterLoginResult =
  | { ok: true; seeded: boolean }
  | { ok: false; reason: string };

interface HeldLock {
  epoch: number;
  expiresAt: number;
}

export class WorldCharacterSync {
  private readonly client: CharacterWorldClient;
  private readonly store: CharacterStore;
  private readonly economy: CharacterEconomyView | null;
  private readonly lockTtlMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  /** Locks this region currently holds, by character id. */
  private readonly held = new Map<number, HeldLock>();
  /**
   * The world record version last seen per character (slice A2): read
   * at login, advanced by every accepted put and by every settled
   * atomic operation. This is the expected-version half of every
   * atomic operation's fence — the P4 plumbing is the only source.
   */
  private readonly versions = new Map<number, number>();
  /**
   * Characters whose lock was lost (stolen after expiry, or expired
   * and re-acquire refused): uphill writes stop until a fresh login.
   */
  private readonly fenced = new Set<number>();
  /** A save is in flight per character: overlapping cycles skip. */
  private readonly saving = new Set<number>();

  constructor(opts: WorldCharacterSyncOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.economy = opts.economy ?? null;
    this.lockTtlMs = opts.lockTtlMs ?? CHARACTER_LOCK_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** The epoch of the lock held for a character, or null (tests/diagnostics). */
  lockEpoch(characterId: number): number | null {
    return this.held.get(characterId)?.epoch ?? null;
  }

  /** The world record version last seen for a character, or null. */
  worldVersion(characterId: number): number | null {
    return this.versions.get(characterId) ?? null;
  }

  /**
   * The atomic-operation fence for a character this region holds
   * (slice A2): the held lock's epoch (renewed first when it has
   * reached expiry, exactly like a working save) plus the record
   * version last seen. Null when this region holds no lock for the
   * character or has been fenced out of it — the caller fails the
   * operation closed rather than inventing a fence.
   */
  async fence(characterId: number): Promise<ParticipantFence | null> {
    if (this.fenced.has(characterId)) return null;
    const lock = await this.ensureLock(characterId);
    if (lock === null) return null;
    return {
      characterId,
      epoch: lock.epoch,
      expectedVersion: this.versions.get(characterId) ?? 0,
    };
  }

  /**
   * Record a settled atomic operation (slice A2): advance each
   * participating character's known version to the world's, and
   * reconcile the local economy caches to the settled records — the
   * world's version is truth, never the reverse. A rejection settles
   * nothing and changes nothing here.
   */
  applySettled(result: AtomicOpResult): void {
    if (!result.ok) return;
    const settled: Array<{ characterId: number; gold: number; inventory: InventoryItem[] }> = [];
    for (const record of result.characters) {
      // Only characters this region holds are tracked or reconciled:
      // a cross-shard participant's caches live on its own region.
      if (!this.held.has(record.characterId)) continue;
      this.versions.set(record.characterId, record.version);
      if (this.economy) {
        const eco = economyOfState(record.state);
        if (eco !== null) settled.push({ characterId: record.characterId, ...eco });
      }
    }
    if (this.economy && settled.length > 0) {
      if (this.economy.reconcileAll) this.economy.reconcileAll(settled);
      else for (const s of settled) this.economy.reconcile(s.characterId, s.gold, s.inventory);
    }
  }

  /** True once this region has been fenced out of a character's writes. */
  isFenced(characterId: number): boolean {
    return this.fenced.has(characterId);
  }

  /**
   * Acquire the character's session lock and seed the local cache
   * from the world record. Must complete before the character is
   * playable. A refusal (a live holder elsewhere, or the world
   * unreachable) returns { ok: false } — the caller refuses the login
   * through its existing error semantics. Re-login of a character
   * this region already holds (local session takeover) is a no-op.
   */
  async login(characterId: number): Promise<CharacterLoginResult> {
    if (this.held.has(characterId)) return { ok: true, seeded: false };
    let lock: CharacterSessionLock;
    try {
      lock = await this.client.acquireCharacterLock(
        characterId,
        this.lockTtlMs,
      );
    } catch (err) {
      const reason = (err as Error).message;
      this.log(
        `character ${characterId}: session lock refused (${reason}); login refused`,
      );
      return { ok: false, reason };
    }
    this.held.set(characterId, { epoch: lock.epoch, expiresAt: lock.expiresAt });
    this.fenced.delete(characterId);

    // The world record is the authority: seed the working cache
    // before the gateway restores from it. No record (or an unusable
    // one) leaves the local record standing — the first working save
    // establishes (or repairs) the world record.
    let seeded = false;
    try {
      const record = await this.client.getCharacterState(characterId);
      if (record !== null) {
        // The version this login saw is the fence baseline for every
        // atomic operation until a save or a settled op advances it.
        this.versions.set(characterId, record.version);
        const payload = parseWorldCharacterState(record.state);
        if (payload !== null) {
          seedLocalCharacter(this.store, characterId, payload, this.economy ?? undefined);
          seeded = true;
        } else {
          // A record with economy fields but no usable character
          // payload still seeds the economy caches from the world.
          if (this.economy) {
            const eco = economyOfState(record.state);
            if (eco !== null) this.economy.reconcile(characterId, eco.gold, eco.inventory);
          }
          this.log(
            `character ${characterId}: world record v${record.version} is not a usable character state; keeping the local record`,
          );
        }
      }
    } catch (err) {
      this.log(
        `character ${characterId}: world record fetch failed (${(err as Error).message}); keeping the local record`,
      );
    }
    return { ok: true, seeded };
  }

  /**
   * One working save: write the local store's current state uphill,
   * fenced by the held lock's epoch. Never throws. Returns whether
   * the world accepted the write. A fenced rejection marks the
   * character fenced (logged once) and stops further uphill writes;
   * a transport failure only logs — the next cycle retries.
   */
  async save(characterId: number): Promise<boolean> {
    if (this.fenced.has(characterId)) return false;
    if (!this.held.has(characterId)) return false;
    if (this.saving.has(characterId)) return false;
    this.saving.add(characterId);
    try {
      const lock = await this.ensureLock(characterId);
      if (lock === null) return false;
      if (this.economy) {
        // Slice A2: another region may have settled an atomic
        // operation against this character since our last save (the
        // cross-shard case — e.g. our character was the seller in an
        // auction settled elsewhere). The payload below carries the
        // local economy cache uphill, so a version drift means that
        // cache is stale: reconcile it to the world's settled
        // outcome BEFORE writing, never the reverse. A failed
        // refresh aborts the save (retried next cycle) rather than
        // risk overwriting the settled outcome.
        const known = this.versions.get(characterId);
        if (known !== undefined) {
          let current: CharacterStateRecord | null;
          try {
            current = await this.client.getCharacterState(characterId);
          } catch (err) {
            this.log(
              `character ${characterId}: pre-save refresh failed (${(err as Error).message}); save deferred`,
            );
            return false;
          }
          if (current !== null && current.version !== known) {
            const eco = economyOfState(current.state);
            if (eco !== null) this.economy.reconcile(characterId, eco.gold, eco.inventory);
            this.versions.set(characterId, current.version);
          }
        }
      }
      const payload = worldCharacterPayload(this.store, characterId, this.economy ?? undefined);
      if (payload.state === null && payload.skills === null) return false;
      try {
        const record = await this.client.putCharacterState(characterId, lock.epoch, payload);
        this.versions.set(characterId, record.version);
        return true;
      } catch (err) {
        if (isFencingRejection(err)) {
          this.markFenced(
            characterId,
            `write fenced by the world (${(err as Error).message})`,
          );
        } else {
          this.log(
            `character ${characterId}: uphill save failed (${(err as Error).message}); local record remains the fallback, retrying next cycle`,
          );
        }
        return false;
      }
    } finally {
      this.saving.delete(characterId);
    }
  }

  /**
   * Final commit uphill, then release the lock (logout and migration
   * commit). Never throws and never blocks on the world: if the
   * commit or the release cannot land, the local record remains the
   * fallback truth (logged) and the lock expires on its own.
   * Returns whether the final commit landed.
   */
  async logout(characterId: number): Promise<boolean> {
    const committed = await this.save(characterId);
    const lock = this.held.get(characterId);
    this.held.delete(characterId);
    this.versions.delete(characterId);
    if (lock && !this.fenced.has(characterId)) {
      try {
        await this.client.releaseCharacterLock(characterId, lock.epoch);
      } catch (err) {
        this.log(
          `character ${characterId}: lock release failed (${(err as Error).message}); the lock expires on its own`,
        );
      }
    }
    this.fenced.delete(characterId);
    return committed;
  }

  /**
   * The held lock, renewed first when it has reached expiry: an
   * expired lock is re-acquired (bumped epoch) unless someone else
   * holds it now — that refusal fences this region out. Returns null
   * when no usable lock is held.
   */
  private async ensureLock(characterId: number): Promise<HeldLock | null> {
    const lock = this.held.get(characterId);
    if (!lock) return null;
    if (this.now() < lock.expiresAt) return lock;
    try {
      const fresh = await this.client.acquireCharacterLock(
        characterId,
        this.lockTtlMs,
      );
      const renewed: HeldLock = {
        epoch: fresh.epoch,
        expiresAt: fresh.expiresAt,
      };
      this.held.set(characterId, renewed);
      this.log(
        `character ${characterId}: session lock renewed at epoch ${fresh.epoch}`,
      );
      return renewed;
    } catch (err) {
      this.markFenced(
        characterId,
        `session lock expired and renewal was refused (${(err as Error).message})`,
      );
      return null;
    }
  }

  private markFenced(characterId: number, why: string): void {
    if (this.fenced.has(characterId)) return;
    this.fenced.add(characterId);
    this.held.delete(characterId);
    this.log(
      `character ${characterId}: DURABILITY FAILURE — ${why}; uphill writes stopped, local record remains the fallback`,
    );
  }
}

/** A world rejection that means the lock is no longer ours (403/409). */
function isFencingRejection(err: unknown): boolean {
  return (
    err instanceof WorldTransportError && (err.code === 403 || err.code === 409)
  );
}
