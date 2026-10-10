/**
 * Simulated latency for the mirror client.
 *
 * Wraps a SocketLike and delays outbound sends and inbound messages by
 * `lagMs`. The Play menu's "Simulated latency" option (0 / 80 ms /
 * 200 ms) routes the mirror client's socket through this so developers
 * can feel what the game plays like on a slow link.
 */
import type { SocketLike } from "./socket.js";

export class LaggySocket implements SocketLike {
  onmessage: ((data: Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onopen: (() => void) | null = null;

  /** Set by close(): nothing more is sent or delivered. */
  private closed = false;
  /** Delayed sends and deliveries, cancelled by close(). */
  private readonly pending = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly inner: SocketLike,
    private readonly lagMs: number,
  ) {
    inner.onmessage = (data) => this.later(() => this.onmessage?.(data));
    // The close travels the same slow link: messages that arrived before
    // it are delivered first (timers of equal delay fire in order).
    inner.onclose = () => {
      if (this.closed) this.onclose?.();
      else this.later(() => this.onclose?.());
    };
    inner.onerror = (err) => this.onerror?.(err);
    inner.onopen = () => this.onopen?.();
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    this.later(() => this.inner.send(data));
  }

  close(): void {
    this.closed = true;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    this.inner.close();
  }

  /** Run `fn` after the lag, unless close() comes first. */
  private later(fn: () => void): void {
    if (this.closed) return;
    if (this.lagMs <= 0) {
      fn();
      return;
    }
    const t = setTimeout(() => {
      this.pending.delete(t);
      if (!this.closed) fn();
    }, this.lagMs);
    this.pending.add(t);
  }
}

/** Parse the Play menu's latency option ("0", "80 ms", "200 ms") → ms. */
export function latencyMs(option: string): number {
  const m = /^(\d+)/.exec(option.trim());
  return m ? Number(m[1]) : 0;
}
