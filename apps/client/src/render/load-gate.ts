/**
 * LS1: the world's reveal gate. The world is not shown until the first
 * snapshot has arrived and the models it asked for (PCG meshes, Synty art)
 * have stopped loading for a short settle window. A hard timeout reveals it
 * anyway, so a model that never arrives cannot hold the screen forever.
 */

export interface LoadGateOptions {
  /** How long no model may be pending before the world reveals, ms. */
  settleMs: number;
  /** Reveal no matter what after this long, ms. */
  timeoutMs: number;
}

export const DEFAULT_LOAD_GATE: LoadGateOptions = { settleMs: 1000, timeoutMs: 30_000 };

export interface LoadSample {
  /** Wall clock, ms (performance.now()). */
  now: number;
  /** Whether a snapshot or delta has arrived yet. */
  stateSeen: boolean;
  /** Models ready so far. */
  ready: number;
  /** Models requested and still loading. */
  pending: number;
}

export interface LoadProgress {
  done: boolean;
  /** What the gate is waiting on: the first snapshot, or models. */
  stage: "state" | "models";
  ready: number;
  pending: number;
}

export class LoadGate {
  private startedAt: number | null = null;
  private quietSince: number | null = null;
  private finished = false;

  constructor(private readonly opts: LoadGateOptions = DEFAULT_LOAD_GATE) {}

  /** Feed one frame's sample; returns where loading stands. Once done it stays done. */
  sample(s: LoadSample): LoadProgress {
    const { ready, pending } = s;
    if (this.finished) return { done: true, stage: "models", ready, pending };
    this.startedAt ??= s.now;
    if (s.now - this.startedAt >= this.opts.timeoutMs) this.finished = true;
    if (!s.stateSeen) {
      this.quietSince = null;
      return { done: this.finished, stage: "state", ready, pending };
    }
    if (pending > 0) {
      this.quietSince = null;
    } else {
      this.quietSince ??= s.now;
      if (s.now - this.quietSince >= this.opts.settleMs) this.finished = true;
    }
    return { done: this.finished, stage: "models", ready, pending };
  }

  get done(): boolean {
    return this.finished;
  }
}
