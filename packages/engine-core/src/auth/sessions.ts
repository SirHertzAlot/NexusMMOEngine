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
 * - Sessions live ONLY in memory (architecture brief §8): a restart
 *   invalidates them, which is the safe default. Accounts stay durable
 *   in the CredentialStore — never in-memory-only.
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
}

export interface SessionManagerOptions {
  /** Default 24 h. */
  ttlMs?: number;
  /** Clock for expiry math; default Date.now. Inject in tests. */
  clock?: () => number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class SessionManager {
  private readonly sessions = new Map<string, AuthSession>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(opts: SessionManagerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError(
        `session-manager: ttlMs must be positive (got ${opts.ttlMs})`,
      );
    }
    this.clock = opts.clock ?? Date.now;
  }

  /** Issue a token for an authenticated user. */
  create(clientId: string, username: string): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, {
      token,
      clientId,
      username,
      expiresAt: this.clock() + this.ttlMs,
    });
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
    return removed;
  }

  size(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }
}
