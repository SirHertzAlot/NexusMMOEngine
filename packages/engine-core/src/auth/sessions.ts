/**
 * SessionManager — in-memory session tokens (auth slice, 2026-09-27).
 *
 * After a successful password check the server issues an opaque token;
 * the token (not the password) is the client's identity from then on,
 * including reconnects inside the gateway's 30 s grace window.
 *
 * Design notes:
 * - Tokens are 128-bit-entropy opaque handles (crypto.randomBytes(32),
 *   hex). They carry no claims — the server is the source of truth, so
 *   there is nothing to forge and nothing to expire client-side.
 * - Sessions live in memory unless a SessionStore is given (edge/core
 *   split E3: the production server keeps them in SQLite so a core
 *   restart does not log every player out). Without a store a restart
 *   invalidates them. Accounts stay durable in the CredentialStore.
 * - Expiry is lazy on get() plus a periodic sweep() (the gateway calls
 *   it from its heartbeat tick). No timers per session.
 */

import { randomBytes } from "node:crypto";

export interface AuthSession {
  /** 64-char hex token. */
  token: string;
  /** Gateway connection handle that created the session. */
  clientId: string;
  username: string;
  /** Clock ms after which the session is dead. */
  expiresAt: number;
  /**
   * The character this session entered the world as: a reconnect after
   * the grace period (its avatar gone) enters as it again.
   */
  character?: { id: number; name: string; look: string };
}

/**
 * Durable backing for sessions. The manager keeps its in-memory map as the
 * working set and writes through; `load` seeds it at construction.
 */
export interface SessionStore {
  load(): AuthSession[];
  put(s: AuthSession): void;
  delete(token: string): void;
  deleteExpired(nowMs: number): void;
}

export interface SessionManagerOptions {
  /** Default 24 h. */
  ttlMs?: number;
  /** Clock for expiry math; default Date.now. Inject in tests. */
  clock?: () => number;
  /** Write-through durable store; absent = memory only. */
  store?: SessionStore;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class SessionManager {
  private readonly sessions = new Map<string, AuthSession>();
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly store: SessionStore | null;

  constructor(opts: SessionManagerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError(
        `session-manager: ttlMs must be positive (got ${opts.ttlMs})`,
      );
    }
    this.clock = opts.clock ?? Date.now;
    this.store = opts.store ?? null;
    if (this.store) {
      this.store.deleteExpired(this.clock());
      for (const s of this.store.load()) this.sessions.set(s.token, s);
    }
  }

  /** Issue a token for an authenticated user. */
  create(clientId: string, username: string): string {
    const token = randomBytes(32).toString("hex");
    const s: AuthSession = {
      token,
      clientId,
      username,
      expiresAt: this.clock() + this.ttlMs,
    };
    this.sessions.set(token, s);
    this.store?.put(s);
    return token;
  }

  /**
   * Look up a live session. Expired or unknown tokens return null
   * (expired entries are removed eagerly).
   */
  get(token: string): AuthSession | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= this.clock()) {
      this.sessions.delete(token);
      this.store?.delete(token);
      return null;
    }
    return s;
  }

  /** Update the connection handle bound to a live session (reconnects). */
  rebind(token: string, clientId: string): void {
    const s = this.sessions.get(token);
    if (s) s.clientId = clientId;
  }

  /** Invalidate a token immediately (logout). */
  revoke(token: string): void {
    this.sessions.delete(token);
    this.store?.delete(token);
  }

  /** Drop all expired sessions. Returns the number removed. */
  sweep(): number {
    const now = this.clock();
    let removed = 0;
    for (const [token, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(token);
        removed += 1;
      }
    }
    if (removed > 0) this.store?.deleteExpired(now);
    return removed;
  }

  /** Every live (unexpired) token. */
  tokens(): string[] {
    const now = this.clock();
    const out: string[] = [];
    for (const [token, s] of this.sessions) if (s.expiresAt > now) out.push(token);
    return out;
  }

  size(): number {
    return this.sessions.size;
  }

  /** Drop the working set (shutdown); a durable store keeps its rows. */
  clear(): void {
    this.sessions.clear();
  }
}
