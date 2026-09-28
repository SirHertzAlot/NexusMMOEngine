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
  start(): Promise<PlayServer>;
  stop(): Promise<void>;
  /** True when this control currently owns a live server process. */
  isRunning(): boolean;
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
   */
  async start(): Promise<void> {
    if (this.state === "starting" || this.state === "running") return;
    if (this.state === "stopping") {
      throw new Error("play-mode: stop in progress");
    }
    this.setState("starting");
    this.savedState = this.hooks.onEnterPlay();
    this.entered = true;
    try {
      this.server = await this.serverControl.start();
      this.client = await this.connectClient(this.server);
      this.setState("running");
    } catch (err) {
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
   */
  async stop(): Promise<void> {
    if (this.state === "idle") return;
    if (this.state === "stopping") return;
    this.setState("stopping");
    let firstError: unknown = null;
    try {
      this.client?.disconnect();
    } catch (err) {
      firstError = err;
    } finally {
      this.client = null;
    }
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
