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
  CharacterSessionLock,
  CharacterStateRecord,
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

/** The opaque world-tier payload: exactly what the local store keeps. */
export interface WorldCharacterState {
  state: CharacterState | null;
  skills: SkillSave | null;
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
  return { state: st, skills: sk };
}

/** The world-tier payload for a character, read from the local store. */
export function worldCharacterPayload(
  store: CharacterStore,
  characterId: number,
): WorldCharacterState {
  return {
    state: store.loadState?.(characterId) ?? null,
    skills: store.loadSkills?.(characterId) ?? null,
  };
}

/** Seed the local working cache from a world-tier payload. */
export function seedLocalCharacter(
  store: CharacterStore,
  characterId: number,
  payload: WorldCharacterState,
): void {
  if (payload.state && store.saveState) store.saveState(characterId, payload.state);
  if (payload.skills && store.saveSkills) {
    store.saveSkills(characterId, payload.skills);
  }
}

export interface WorldCharacterSyncOptions {
  client: CharacterWorldClient;
  /** The local character store: the working cache this sync seeds and reads. */
  store: CharacterStore;
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
  private readonly lockTtlMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  /** Locks this region currently holds, by character id. */
  private readonly held = new Map<number, HeldLock>();
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
    this.lockTtlMs = opts.lockTtlMs ?? CHARACTER_LOCK_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** The epoch of the lock held for a character, or null (tests/diagnostics). */
  lockEpoch(characterId: number): number | null {
    return this.held.get(characterId)?.epoch ?? null;
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
        const payload = parseWorldCharacterState(record.state);
        if (payload !== null) {
          seedLocalCharacter(this.store, characterId, payload);
          seeded = true;
        } else {
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
      const payload = worldCharacterPayload(this.store, characterId);
      if (payload.state === null && payload.skills === null) return false;
      try {
        await this.client.putCharacterState(characterId, lock.epoch, payload);
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
