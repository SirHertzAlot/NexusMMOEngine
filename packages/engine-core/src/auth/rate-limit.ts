/**
 * Per-IP sliding-window rate limiter for auth attempts (auth slice).
 *
 * Only FAILED attempts count: a legitimate user who fat-fingers once is
 * unaffected, while a brute-forcer burns through the budget. A success
 * clears the IP's failure record.
 *
 * This is a cheap in-memory gate, not a DDoS solution: it bounds
 * password-guessing against one server process (the Phase 1 topology is
 * a single deployable). Counts live in a Map keyed by remote IP with
 * lazy pruning — no timers.
 */

export interface RateLimitOptions {
  /** Failed attempts per window before limiting. Default 5. */
  maxFailures?: number;
  /** Sliding window length. Default 60_000 ms. */
  windowMs?: number;
  /** Clock for window math; default Date.now. Inject in tests. */
  clock?: () => number;
}

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 60_000;

export class AuthRateLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(opts: RateLimitOptions = {}) {
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.clock = opts.clock ?? Date.now;
    if (!Number.isInteger(this.maxFailures) || this.maxFailures < 1) {
      throw new RangeError(
        `rate-limiter: maxFailures must be an integer >= 1 (got ${opts.maxFailures})`,
      );
    }
    if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) {
      throw new RangeError(
        `rate-limiter: windowMs must be positive (got ${opts.windowMs})`,
      );
    }
  }

  /** True when this IP has exhausted its failure budget. */
  isLimited(ip: string): boolean {
    return this.recent(ip).length >= this.maxFailures;
  }

  /** Record a failed auth attempt from this IP. */
  recordFailure(ip: string): void {
    const list = this.recent(ip);
    list.push(this.clock());
    this.failures.set(ip, list);
  }

  /** A successful auth clears the IP's failure record. */
  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }

  /** Failures inside the window, oldest-first; prunes the rest. */
  private recent(ip: string): number[] {
    const cutoff = this.clock() - this.windowMs;
    const list = (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.failures.delete(ip);
    else this.failures.set(ip, list);
    return list;
  }
}
