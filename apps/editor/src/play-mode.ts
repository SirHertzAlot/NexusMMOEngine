/**
 * PlayModeController — the play-mode inspector's state machine.
 *
 * Play mode = a locally-owned authoritative server + a connected mirror
 * client inside the editor. The controller owns the lifecycle:
 *
 *   idle → starting → running → stopping → idle
 *                       ↘ error (failed start; server cleaned up)
 *
 * Design rules (Joey's constraints):
 * - The controller only ever stops the server process IT started
 *   (tracked pid/handle, never a port scan / pkill).
 * - Pre-play editor state is always restored: the shell hands an opaque
 *   snapshot to onEnterPlay() and gets it back via onExitPlay(), even
 *   when the start fails or a stop step throws.
 * - Server and client are injected seams (ServerControl, ClientFactory)
 *   so the state machine is unit-testable without spawning processes.
 * - Debug overlays (waypoints, navmesh tiles) go through the connected
 *   MirrorClient's read-only 0x0a queries — never through direct
 *   component access.
 */

import type { DebugResponse } from "@mmo-engine/protocol";

export type PlayModeState = "idle" | "starting" | "running" | "stopping" | "error";

/** What a started local server looks like to the controller. */
export interface PlayServer {
  /** WebSocket URL the editor client should connect to. */
  url: string;
  /** OS pid, for diagnostics only — stopping goes through stop(). */
  pid: number;
  /** One-session dev credentials seeded by the host for this server. */
  username: string;
  password: string;
}

/**
 * Owns exactly one server process. Implementations must only ever stop
 * the process they started (the dev host tracks the child handle).
 */
export interface ServerControl {
  start(opts?: PlayStartOptions): Promise<PlayServer>;
  stop(): Promise<void>;
  /** True when this control currently owns a live server process. */
  isRunning(): boolean;
}

/** Options the play-start path honors (a subset of the Play menu). */
export interface PlayStartOptions {
  /**
   * Computer-driven characters near the spawn point. Reaches the owned
   * server as MMO_BOTS; undefined leaves the server default alone.
   */
  bots?: number;
  /**
   * Simulate mode: start the server but do not connect a mirror client.
   * The world ticks; the editor shows status, not a game view.
   */
  noClient?: boolean;
  /**
   * How many mirror clients to connect (1/2/4/8). Client 0 drives the
   * game view; the rest are headless load. Defaults to 1.
   */
  clients?: number;
}

/** Minimal mirror-client surface the play-mode inspector needs. */
export interface PlayClient {
  debug(query: { kind: "debug" } & Record<string, unknown>): Promise<DebugResponse>;
  disconnect(): void;
}

export interface PlayModeHooks {
  /** Called as play mode is entered; returns opaque state to restore later. */
  onEnterPlay(): unknown;
  /** Called with the saved state when play mode exits (always). */
  onExitPlay(saved: unknown): void;
  /** State transitions, for the inspector UI. */
  onStateChange(state: PlayModeState, detail?: string): void;
}

export class PlayModeController {
  private state: PlayModeState = "idle";
  private savedState: unknown = null;
  private entered = false;
  private server: PlayServer | null = null;
  private client: PlayClient | null = null;
  /** Headless load clients (client 0 is `client`, drives the game view). */
  private extraClients: PlayClient[] = [];
  /**
   * Invalidated by stop(): an in-flight start() checks it after every
   * await and cleans up instead of entering running — so Stop works
   * while starting and never leaves an orphaned server.
   */
  private startToken = 0;

  constructor(
    private readonly serverControl: ServerControl,
    private readonly connectClient: (server: PlayServer) => Promise<PlayClient>,
    private readonly hooks: PlayModeHooks,
  ) {}

  getState(): PlayModeState {
    return this.state;
  }

  /** True while a server process owned by this controller is live. */
  get serverInfo(): PlayServer | null {
    return this.server;
  }

  private setState(s: PlayModeState, detail?: string): void {
    this.state = s;
    this.hooks.onStateChange(s, detail);
  }

  /**
   * Enter play mode: snapshot editor state, start the owned server,
   * connect the mirror client. On any failure the owned server is
   * stopped and the editor state is restored before surfacing error.
   *
   * A stop() that lands mid-start wins: the start aborts quietly
   * (server cleaned up, state restored, no error surfaced over the
   * user's stop) instead of flipping back to running afterwards.
   */
  async start(opts?: PlayStartOptions): Promise<void> {
    if (this.state === "starting" || this.state === "running") return;
    if (this.state === "stopping") {
      throw new Error("play-mode: stop in progress");
    }
    const token = ++this.startToken;
    this.setState("starting");
    this.savedState = this.hooks.onEnterPlay();
    this.entered = true;
    try {
      this.server = await this.serverControl.start(opts);
      if (token !== this.startToken) {
        await this.cleanupOwnedServer();
        this.restoreEditorState();
        return;
      }
      // Simulate mode: the world ticks with no player client.
      if (!opts?.noClient) {
        const n = opts?.clients ?? 1;
        this.client = await this.connectClient(this.server);
        // Extra headless clients for load testing.
        for (let i = 1; i < n; i++) {
          try {
            this.extraClients.push(await this.connectClient(this.server));
          } catch {
            // A failed extra client doesn't fail the start; the primary is up.
            break;
          }
        }
        if (token !== this.startToken) {
          try {
            this.client?.disconnect();
          } catch {
            /* a stop already owns the outcome; ignore */
          } finally {
            this.client = null;
          }
          for (const c of this.extraClients) {
            try { c.disconnect(); } catch { /* ignore */ }
          }
          this.extraClients = [];
          await this.cleanupOwnedServer();
          this.restoreEditorState();
          return;
        }
      }
      this.setState("running");
    } catch (err) {
      if (token !== this.startToken) {
        await this.cleanupOwnedServer();
        this.restoreEditorState();
        return;
      }
      await this.cleanupOwnedServer();
      this.restoreEditorState();
      this.setState(
        "error",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * Exit play mode: disconnect the client, stop the owned server,
   * restore the pre-play editor state. Every step is attempted even
   * when an earlier one throws; the first error is rethrown.
   *
   * Also valid while starting: it invalidates the in-flight start
   * (which then cleans up after itself) instead of waiting for it.
   */
  async stop(): Promise<void> {
    if (this.state === "idle") return;
    if (this.state === "stopping") return;
    this.startToken++;
    this.setState("stopping");
    let firstError: unknown = null;
    try {
      this.client?.disconnect();
    } catch (err) {
      firstError = err;
    } finally {
      this.client = null;
    }
    for (const c of this.extraClients) {
      try {
        c.disconnect();
      } catch (err) {
        firstError = firstError ?? err;
      }
    }
    this.extraClients = [];
    try {
      await this.cleanupOwnedServer();
    } catch (err) {
      firstError ??= err;
    }
    this.restoreEditorState();
    this.setState("idle");
    if (firstError) throw firstError;
  }

  /** Read-only waypoint overlay query (0x0a). Only while running. */
  async debugWaypoints(entityWireId: string): Promise<DebugResponse> {
    return this.debug({
      kind: "debug",
      query: "waypoints",
      entity: entityWireId,
    });
  }

  /** Read-only navmesh tile-bounds overlay query (0x0a). Only while running. */
  async debugTiles(): Promise<DebugResponse> {
    return this.debug({ kind: "debug", query: "tiles" });
  }

  /** Read-only tick timing query (0x0a). Only while running. */
  async debugTimings(): Promise<DebugResponse> {
    return this.debug({ kind: "debug", query: "timings" });
  }

  private async debug(
    query: { kind: "debug" } & Record<string, unknown>,
  ): Promise<DebugResponse> {
    if (this.state !== "running" || !this.client) {
      throw new Error("play-mode: not running");
    }
    return this.client.debug(query);
  }

  /** Stop the server owned by this controller, if any. Never touches others. */
  private async cleanupOwnedServer(): Promise<void> {
    if (this.serverControl.isRunning()) {
      await this.serverControl.stop();
    }
    this.server = null;
  }

  private restoreEditorState(): void {
    if (this.entered) {
      this.entered = false;
      this.hooks.onExitPlay(this.savedState);
      this.savedState = null;
    }
  }
}
