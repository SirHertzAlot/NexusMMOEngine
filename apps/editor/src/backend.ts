/**
 * DRY backend convention for the editor (uWS-compatible).
 *
 * Transport note: the game server speaks uWS (uWebSockets.js) by default
 * with a `ws` fallback (MMO_TRANSPORT), serving the WS game channel and
 * plain HTTP on the same MMO_PORT. Browsers speak plain WebSocket either
 * way, so one BrowserSocket covers both transports — everything above it
 * lives here, once, instead of hand-rolled per panel:
 *
 * - hello/auth + id-keyed admin/debug verbs (0x10/0x0a) over MirrorClient,
 * - reconnect with backoff and session-token reattach (grace period),
 * - a staleness watchdog (no snapshot/delta for a while ⇒ reconnect),
 * - typed live-game verbs (inspect/set/spawn/teleport/heal/give/…)
 *   for instantiating and tweaking the live game,
 * - a shared JSON `api()` for the dev-host HTTP routes.
 *
 * Admin gating is server-side (MMO_ADMINS / MMO_DEV_SERVER; the owned
 * play-mode server seeds the editor as admin). A refusal arrives as a
 * normal `{ok: false}` result, never a throw — use assertAdminOk() when
 * the caller wants an exception.
 *
 * Existing panels keep their own connections; new code imports this.
 * The socket factory is injected, so node:test covers the lifecycle
 * with fakes (no processes, no sockets).
 */

import { BrowserSocket, MirrorClient } from "@mmo-engine/mirror";
import type { HelloAuth, MirrorEvents } from "@mmo-engine/mirror";
import type {
  AdminResult,
  DebugQuery,
  DebugResponse,
} from "@mmo-engine/protocol";

/** Minimal surface BackendClient drives (MirrorClient satisfies it). */
export interface ClientLike {
  sessionToken: string | null;
  connect(url: string, clientName: string, auth: HelloAuth): Promise<unknown>;
  disconnect(): void;
  admin(command: string, args?: unknown): Promise<AdminResult>;
  debug(query: DebugQuery): Promise<DebugResponse>;
}

export interface BackendEvents {
  /** Authoritative tick applied (same cadence as the mirror's onState). */
  onTick(tick: number): void;
  /** Socket closed; willRetry tells whether the backoff loop takes over. */
  onClose(willRetry: boolean): void;
  /** A reconnect attempt succeeded (attempt counts from 1). */
  onReconnect(attempt: number): void;
  onError(err: Error): void;
}

export interface BackendOptions {
  clientName?: string;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Give up after this many retries (default: never). */
  maxRetries?: number;
  /** Reconnect when no state arrives for this long (0 = off). */
  staleAfterMs?: number;
  createClient?: (events: MirrorEvents) => ClientLike;
}

export type BackendState = "idle" | "connecting" | "live" | "retrying";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Item picker shape shared by items/give/drop (gateway usage strings). */
export interface ItemPick {
  def?: number;
  base?: string;
  rank?: string;
  source?: string;
}

export class BackendClient {
  state: BackendState = "idle";
  private client: ClientLike | null = null;
  private stopped = false;
  private started = false;
  private everLive = false;
  private lastToken: string | null = null;
  private lastStateAt = 0;
  private closeWaiter: (() => void) | null = null;
  private firstResolve: (() => void) | null = null;
  private firstReject: ((e: Error) => void) | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly clientName: string;
  private readonly createClient: (events: MirrorEvents) => ClientLike;

  constructor(
    private readonly url: string,
    private readonly auth: HelloAuth,
    private readonly events: BackendEvents,
    private readonly opts: BackendOptions = {},
    createClient?: (events: MirrorEvents) => ClientLike,
  ) {
    this.clientName = opts.clientName ?? "mmo-editor-backend";
    this.createClient =
      createClient ??
      opts.createClient ??
      ((ev) => new MirrorClient((u) => new BrowserSocket(u), ev));
  }

  /** Connect once; rejects when the first hello fails (like connectMirror). */
  static async connect(
    url: string,
    auth: HelloAuth,
    events: BackendEvents,
    opts?: BackendOptions,
    createClient?: (events: MirrorEvents) => ClientLike,
  ): Promise<BackendClient> {
    const b = new BackendClient(url, auth, events, opts, createClient);
    await b.start();
    return b;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    const p = new Promise<void>((resolve, reject) => {
      this.firstResolve = resolve;
      this.firstReject = reject;
    });
    void this.run();
    return p;
  }

  stop(): void {
    this.stopped = true;
    this.stopWatchdog();
    try {
      this.client?.disconnect();
    } catch {
      /* already gone */
    }
    this.client = null;
    this.state = "idle";
    this.firstResolve?.();
    this.firstResolve = null;
    this.firstReject = null;
    const w = this.closeWaiter;
    this.closeWaiter = null;
    w?.();
  }

  isLive(): boolean {
    return this.state === "live";
  }

  get sessionToken(): string | null {
    return this.lastToken;
  }

  /** Read-only debug query (0x0a) through the live client. */
  async debug(query: DebugQuery): Promise<DebugResponse> {
    return this.must().debug(query);
  }

  /** Raw admin command (0x10); prefer the typed verbs below. */
  async adminRaw(command: string, args?: unknown): Promise<AdminResult> {
    return this.must().admin(command, args);
  }

  /** Throw the server's message when a command was refused. */
  static assertAdminOk(res: AdminResult): string {
    if (!res.ok) throw new Error(`backend: ${res.command} refused: ${res.message}`);
    return res.message;
  }

  // ---------------------------------------------------------- live verbs
  // Arg shapes mirror the gateway usage strings (gateway.ts run*Command).

  async help(): Promise<AdminResult> {
    return this.must().admin("help");
  }

  async whoami(): Promise<AdminResult> {
    return this.must().admin("whoami");
  }

  /** Dump one entity's components ({entity: "<u64>" | "me"}). */
  async inspect(entity: string = "me"): Promise<AdminResult> {
    return this.must().admin("inspect", { entity });
  }

  /** Change one numeric component field. */
  async set(entity: string, component: string, field: string, value: number): Promise<AdminResult> {
    return this.must().admin("set", { entity, component, field, value });
  }

  /** Name the plantable archetypes (spawn table). */
  async spawnlist(): Promise<AdminResult> {
    return this.must().admin("spawnlist");
  }

  /** Plant one archetype at the avatar (or at x/z with ground snap). */
  async spawn(asset: string, at?: { x?: number; z?: number; yaw?: number }): Promise<AdminResult> {
    return this.must().admin("spawn", at ? { asset, ...at } : { asset });
  }

  /** Remove any entity that isn't a live session's avatar. */
  async despawn(entity: string): Promise<AdminResult> {
    return this.must().admin("despawn", { entity });
  }

  /** Teleport with ground snap (default target: the caller's avatar). */
  async teleport(x: number, z: number, entity?: string): Promise<AdminResult> {
    return this.must().admin("teleport", entity === undefined ? { x, z } : { x, z, entity });
  }

  /** Fill health (and mana) from max. */
  async heal(entity?: string): Promise<AdminResult> {
    return this.must().admin("heal", entity === undefined ? {} : { entity });
  }

  /** Describe matching item definitions (no side effects). */
  async items(pick?: ItemPick): Promise<AdminResult> {
    return this.must().admin("items", pick ?? {});
  }

  /** Mint a matching item into the caller's bag. */
  async give(pick?: ItemPick): Promise<AdminResult> {
    return this.must().admin("give", pick ?? {});
  }

  /** Drop a matching item at the caller's feet. */
  async drop(pick?: ItemPick): Promise<AdminResult> {
    return this.must().admin("drop", pick ?? {});
  }

  /** Drop N mob-pool items around the caller. */
  async loot(count?: number): Promise<AdminResult> {
    return this.must().admin("loot", count === undefined ? {} : { count });
  }

  // ---------------------------------------------------------- lifecycle

  private must(): ClientLike {
    const c = this.client;
    if (!c || !this.isLive()) throw new Error("backend: not connected");
    return c;
  }

  private mirrorEvents(): MirrorEvents {
    return {
      onWelcome: () => {},
      onState: (tick) => {
        this.lastStateAt = Date.now();
        this.events.onTick(tick);
      },
      onError: (e) => this.events.onError(new Error(`backend: ${e.code} ${e.message}`)),
      onClose: () => {
        this.client = null;
        this.state = this.stopped ? "idle" : "retrying";
        this.stopWatchdog();
        const w = this.closeWaiter;
        this.closeWaiter = null;
        w?.();
        this.events.onClose(!this.stopped);
      },
    };
  }

  private async run(): Promise<void> {
    const { baseDelayMs = 500, maxDelayMs = 8000, maxRetries = Infinity } = this.opts;
    let attempt = 0;
    while (!this.stopped) {
      this.state = attempt === 0 && !this.everLive ? "connecting" : "retrying";
      try {
        const client = this.createClient(this.mirrorEvents());
        const auth: HelloAuth = this.lastToken ? { token: this.lastToken } : this.auth;
        await client.connect(this.url, this.clientName, auth);
        if (this.stopped) {
          try {
            client.disconnect();
          } catch {
            /* already gone */
          }
          return;
        }
        this.client = client;
        this.lastToken = client.sessionToken ?? this.lastToken;
        this.everLive = true;
        this.state = "live";
        this.lastStateAt = Date.now();
        if (attempt > 0) this.events.onReconnect(attempt);
        this.settleFirst(null);
        this.startWatchdog();
        await new Promise<void>((res) => {
          this.closeWaiter = res;
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!this.everLive && attempt === 0) {
          this.settleFirst(error);
          this.stopped = true;
          this.state = "idle";
          return;
        }
        this.events.onError(error);
      }
      if (this.stopped) return;
      if (attempt >= maxRetries) {
        this.state = "idle";
        this.settleFirst(new Error("backend: retry budget exhausted"));
        return;
      }
      attempt += 1;
      this.state = "retrying";
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt, 6)));
    }
  }

  private settleFirst(err: Error | null): void {
    if (err) this.firstReject?.(err);
    else this.firstResolve?.();
    this.firstResolve = null;
    this.firstReject = null;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const ms = this.opts.staleAfterMs ?? 0;
    if (ms <= 0) return;
    this.watchdog = setInterval(() => {
      if (this.stopped || !this.isLive()) return;
      if (Date.now() - this.lastStateAt > ms) {
        try {
          this.client?.disconnect();
        } catch {
          /* the close handler retries */
        }
      }
    }, Math.min(ms, 1000));
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }
}

/**
 * DRY JSON over the dev-host HTTP routes (replaces hand-rolled fetch
 * per panel). Throws `backend: <path> failed: <detail>` on HTTP errors
 * and on `{ok: false}` bodies — the host's refusal convention.
 */
export async function api<T>(path: string, init?: RequestInit, base = ""): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || (isRecord(body) && body.ok === false)) {
    const detail =
      isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(`backend: ${path} failed: ${detail}`);
  }
  return body as T;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
