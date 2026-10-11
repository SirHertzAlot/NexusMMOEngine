/**
 * One shared admin link from the editor to the running play-mode server
 * (roadmap EA26: Live ops and Network read and drive the real server).
 *
 * The dev host owns at most one server (`/api/editor/server/*`). This asks
 * its status, connects a BackendClient with the one-session dev login the
 * status carries (loopback only), and keeps simple connection facts: ticks
 * per second as seen, round-trip time of a periodic admin ping, reconnects
 * and bytes. Nothing here is sample data: with no server the state is
 * "stopped" and `start()` uses the host's existing start route.
 *
 * Browser-safe (HTTP + the mirror's WebSocket); the clock, fetch and
 * connect are injected so node:test covers it without a socket.
 */
import { BackendClient } from "./backend.js";
import type { TelemetrySnapshot } from "./backend-models.js";

export interface HostStatus {
  running: boolean;
  pid?: number;
  port?: number;
  url?: string;
  username?: string;
  password?: string;
}

export type LinkPhase = "stopped" | "starting" | "connecting" | "live" | "error";

export interface LinkState {
  phase: LinkPhase;
  error: string | null;
  url: string | null;
  pid: number | null;
  /** Authoritative ticks per second over the last few seconds, as received. */
  tickRate: number | null;
  lastTick: number | null;
  /** Round trip of the last admin ping, ms. */
  rttMs: number | null;
  reconnects: number;
  connectedAt: number | null;
  /** Last `stats` snapshot from the server. */
  telemetry: TelemetrySnapshot | null;
}

export interface LinkDeps {
  fetchStatus(): Promise<HostStatus>;
  startServer(): Promise<void>;
  connect(url: string, username: string, password: string, onTick: (t: number) => void, onClose: () => void, onReconnect: () => void): Promise<LinkClient>;
  now(): number;
}

export interface LinkClient {
  adminRaw(command: string, args?: unknown): Promise<{ ok: boolean; message: string }>;
  statsSnapshot(): Promise<TelemetrySnapshot>;
  stop(): void;
}

const EMPTY: LinkState = { phase: "stopped", error: null, url: null, pid: null, tickRate: null, lastTick: null, rttMs: null, reconnects: 0, connectedAt: null, telemetry: null };
const RATE_WINDOW_MS = 3000;

export const browserDeps = (base = ""): LinkDeps => ({
  async fetchStatus() {
    const res = await fetch(`${base}/api/editor/server/status`);
    if (!res.ok) throw new Error(`server status: HTTP ${res.status}`);
    return (await res.json()) as HostStatus;
  },
  async startServer() {
    const res = await fetch(`${base}/api/editor/server/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) throw new Error(body.error ?? `start failed: HTTP ${res.status}`);
  },
  async connect(url, username, password, onTick, onClose, onReconnect) {
    return BackendClient.connect(url, { username, password }, { onTick, onClose: () => onClose(), onReconnect: () => onReconnect(), onError: () => {} }, { clientName: "mmo-editor-liveops" });
  },
  now: () => Date.now(),
});

export class ServerLink {
  private state: LinkState = EMPTY;
  private client: LinkClient | null = null;
  private connectedTo: string | null = null;
  private ticks: Array<{ at: number; tick: number }> = [];
  private busy = false;
  /** The mirror client answers one admin command at a time; every call to it goes through here in order. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: LinkDeps) {}

  get(): LinkState {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<LinkState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((f) => f());
  }

  /** Re-ask the host; (re)connect when a server is there, drop the link when it is gone. */
  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const st = await this.deps.fetchStatus();
      if (!st.running || !st.url || st.username === undefined || st.password === undefined) {
        this.drop();
        if (this.state.phase !== "starting") this.set({ ...EMPTY });
        return;
      }
      if (this.client === null || this.connectedTo !== st.url + String(st.pid)) {
        this.drop();
        this.set({ phase: "connecting", error: null, url: st.url, pid: st.pid ?? null });
        try {
          const onTick = (t: number): void => this.onTick(t);
          this.client = await this.deps.connect(st.url, st.username, st.password, onTick, () => this.set({ phase: "connecting" }), () => this.set({ reconnects: this.state.reconnects + 1, phase: "live" }));
          this.connectedTo = st.url + String(st.pid);
          this.set({ phase: "live", connectedAt: this.deps.now(), reconnects: 0 });
        } catch (e) {
          this.set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      await this.sample();
    } catch (e) {
      this.set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.queue.then(f, f);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Ping and telemetry, once; called by refresh() while connected. */
  private async sample(): Promise<void> {
    const c = this.client;
    if (!c) return;
    try {
      const { rttMs, telemetry } = await this.serial(async () => {
        const t0 = this.deps.now();
        await c.adminRaw("whoami");
        const rtt = this.deps.now() - t0;
        return { rttMs: rtt, telemetry: await c.statsSnapshot() };
      });
      this.set({ rttMs, telemetry, phase: "live", error: null });
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  private onTick(tick: number): void {
    const at = this.deps.now();
    this.ticks.push({ at, tick });
    while (this.ticks.length > 1 && at - this.ticks[0].at > RATE_WINDOW_MS) this.ticks.shift();
    const first = this.ticks[0];
    const span = at - first.at;
    // Ticks arrive on the 5 Hz-ish state cadence too; the tick NUMBER advance over wall time is the server's rate.
    this.state = { ...this.state, lastTick: tick, tickRate: span >= 500 ? ((tick - first.tick) * 1000) / span : this.state.tickRate };
  }

  private drop(): void {
    this.client?.stop();
    this.client = null;
    this.connectedTo = null;
    this.ticks = [];
  }

  /** Start the host's play-mode server (the existing start route), then connect. */
  async start(): Promise<void> {
    this.set({ phase: "starting", error: null });
    try {
      // A server the host already owns (Play started it) is connected to, not started twice.
      if (!(await this.deps.fetchStatus()).running) await this.deps.startServer();
    } catch (e) {
      this.set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.set({ phase: "stopped" });
    await this.refresh();
  }

  /** Run an admin command on the live server. */
  async admin(command: string, args?: unknown): Promise<{ ok: boolean; message: string }> {
    if (!this.client) return { ok: false, message: "server not running" };
    try {
      const c = this.client;
      return await this.serial(() => c.adminRaw(command, args));
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  close(): void {
    this.drop();
    this.set({ ...EMPTY });
  }
}
