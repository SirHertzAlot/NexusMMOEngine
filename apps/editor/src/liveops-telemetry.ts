import type { TelemetrySnapshot } from "./backend-models.js";

export interface TelemetrySource {
  statsSnapshot(): Promise<TelemetrySnapshot>;
}

export interface TelemetryPollState {
  snapshot: TelemetrySnapshot | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
}

export interface TelemetryPollTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_REFRESH_MS = 10_000;

const browserTimers: TelemetryPollTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Polls the server once per telemetry bucket without concurrent admin calls. */
export class TelemetryPoller {
  private state: TelemetryPollState = {
    snapshot: null,
    error: null,
    loading: false,
    updatedAt: null,
  };
  private readonly listeners = new Set<() => void>();
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private inFlight = false;

  constructor(
    private readonly source: TelemetrySource,
    private readonly timers: TelemetryPollTimers = browserTimers,
  ) {}

  get(): TelemetryPollState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timeout !== null) {
      this.timers.clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  refresh(): void {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    this.set({ ...this.state, loading: true, error: null });
    void this.request();
  }

  private async request(): Promise<void> {
    let interval = DEFAULT_REFRESH_MS;
    try {
      const snapshot = await this.source.statsSnapshot();
      interval = Math.max(1, snapshot.bucketSeconds) * 1000;
      if (!this.stopped) {
        this.set({
          snapshot,
          error: null,
          loading: false,
          updatedAt: this.timers.now(),
        });
      }
    } catch (error) {
      if (!this.stopped) {
        this.set({
          ...this.state,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        });
      }
    } finally {
      this.inFlight = false;
      if (!this.stopped) {
        this.timeout = this.timers.setTimeout(() => {
          this.timeout = null;
          this.refresh();
        }, interval);
      }
    }
  }

  private set(next: TelemetryPollState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
}
