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

  constructor(
    private readonly inner: SocketLike,
    private readonly lagMs: number,
  ) {
    inner.onmessage = (data) => {
      if (this.lagMs <= 0) {
        this.onmessage?.(data);
      } else {
        setTimeout(() => this.onmessage?.(data), this.lagMs);
      }
    };
    inner.onclose = () => this.onclose?.();
    inner.onerror = (err) => this.onerror?.(err);
    inner.onopen = () => this.onopen?.();
  }

  send(data: Uint8Array): void {
    if (this.lagMs <= 0) {
      this.inner.send(data);
    } else {
      setTimeout(() => this.inner.send(data), this.lagMs);
    }
  }

  close(): void {
    this.inner.close();
  }
}

/** Parse the Play menu's latency option ("0", "80 ms", "200 ms") → ms. */
export function latencyMs(option: string): number {
  const m = /^(\d+)/.exec(option.trim());
  return m ? Number(m[1]) : 0;
}
