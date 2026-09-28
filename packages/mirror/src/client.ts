/**
 * MirrorClient — the browser-side protocol driver (docs/MESSAGE-CATALOG.md).
 *
 * Flow: connect → hello (credentials or session token) → welcome +
 * snapshot → per-tick deltas → intents upstream. It owns the
 * MirrorState and Interpolator but performs no simulation itself:
 * the browser mirrors; the server simulates (skill operating rule 1).
 *
 * The socket is injected (SocketLike), so this class is fully
 * unit-testable in Node with a fake socket.
 */

import {
  decodeControl,
  decodeDelta,
  decodeEnvelope,
  decodeSnapshot,
  encodeControl,
  encodeEnvelope,
  encodeIntentMessage,
  MessageType,
  PROTOCOL_VERSION,
  type DebugQuery,
  type DebugResponse,
  type ErrorMessage,
  type HelloMessage,
  type IntentFields,
  type RegisterMessage,
  type WelcomeMessage,
  type WorldInfo,
} from "@mmo-engine/protocol";
import { Interpolator } from "./interpolate.js";
import { MirrorState } from "./state.js";
import type { SocketLike } from "./socket.js";

export type HelloAuth =
  | { username: string; password: string }
  | { token: string };

export interface MirrorEvents {
  onWelcome(w: WelcomeMessage): void;
  /** Fired after a snapshot or delta is applied (tick = authoritative tick). */
  onState(tick: number): void;
  onError(e: ErrorMessage): void;
  onClose(): void;
}

const CONNECT_TIMEOUT_MS = 8000;

export class MirrorClient {
  readonly state = new MirrorState();
  readonly interpolator = new Interpolator();

  playerEntity: bigint | null = null;
  sessionToken: string | null = null;
  serverTick = 0;
  tickHz = 30;
  /** A baked world's extent and coarse map, from the welcome; null for legacy worlds. */
  world: WorldInfo | null = null;
  lastError: ErrorMessage | null = null;
  closed = false;

  private socket: SocketLike | null = null;
  private welcomeResolve: ((w: WelcomeMessage) => void) | null = null;
  private welcomeReject: ((e: Error) => void) | null = null;
  private debugResolve: ((r: DebugResponse) => void) | null = null;
  private debugReject: ((e: Error) => void) | null = null;

  constructor(
    private readonly createSocket: (url: string) => SocketLike,
    private readonly events: MirrorEvents,
  ) {}

  /**
   * Open the socket, send hello, and resolve with the welcome. Rejects
   * when the server answers with an error, closes, or times out.
   */
  async connect(
    url: string,
    clientName: string,
    auth: HelloAuth,
  ): Promise<WelcomeMessage> {
    const hello: HelloMessage = {
      protocol: PROTOCOL_VERSION,
      client: clientName,
      want_snapshot: true,
      ...auth,
    };
    return this.openAndHandshake(url, MessageType.Hello, hello);
  }

  /**
   * Create an account, then join exactly like a credentials hello: the
   * server answers with the normal welcome + snapshot. Rejects when the
   * server answers with an error (e.g. username taken), closes, or
   * times out.
   */
  async register(
    url: string,
    clientName: string,
    username: string,
    password: string,
  ): Promise<WelcomeMessage> {
    const payload: RegisterMessage = {
      protocol: PROTOCOL_VERSION,
      client: clientName,
      username,
      password,
    };
    return this.openAndHandshake(url, MessageType.Register, payload);
  }

  /**
   * Shared socket-open + first-message handshake for connect()/register().
   * The server's reply path (welcome / error / close) is identical for
   * both, so the plumbing lives here once.
   */
  private async openAndHandshake(
    url: string,
    type: MessageType.Hello | MessageType.Register,
    payload: HelloMessage | RegisterMessage,
  ): Promise<WelcomeMessage> {
    if (this.socket) throw new Error("mirror-client: already connected");
    const socket = this.createSocket(url);
    this.socket = socket;
    socket.onmessage = (data) => this.onMessage(data);

    await new Promise<void>((resolve, reject) => {
      const fail = (reason: string): void => {
        clearTimeout(timer);
        reject(new Error(`mirror-client: ${reason}`));
      };
      const unreachable = `could not connect to ${url} (is the server running?)`;
      const timer = setTimeout(() => {
        fail(`no response from ${url} within ${CONNECT_TIMEOUT_MS / 1000}s`);
        socket.close();
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      // Before open, an error or close means the server was never reached
      // (refused, wrong URL, not running): fail now with a clear reason
      // instead of silently waiting out the timer.
      socket.onerror = () => fail(unreachable);
      socket.onclose = () => {
        fail(unreachable);
        this.onClose();
      };
    });
    socket.onclose = () => this.onClose();
    socket.onerror = (err) => this.onSocketError(err);

    const welcomePromise = new Promise<WelcomeMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("mirror-client: welcome timeout")),
        CONNECT_TIMEOUT_MS,
      );
      this.welcomeResolve = (w) => {
        clearTimeout(timer);
        resolve(w);
      };
      this.welcomeReject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });
    socket.send(encodeEnvelope(type, encodeControl(payload)));
    return welcomePromise;
  }

  /**
   * Send one PlayerIntent upstream for the local player entity
   * (docs/MESSAGE-CATALOG.md §0x05, EDA: intents in as events).
   * client_tick = the last authoritative tick seen; the server drops
   * stale intents, so there is no benefit to sending more than once
   * per input change — PlayerIntent persists server-side.
   */
  sendIntent(intent: IntentFields): void {
    if (!this.socket || this.playerEntity == null) return;
    const payload = encodeIntentMessage(
      BigInt(this.serverTick),
      this.playerEntity,
      intent,
    );
    this.socket.send(encodeEnvelope(MessageType.Intent, payload));
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.debugReject?.(new Error("mirror-client: disconnected"));
    this.debugResolve = null;
    this.debugReject = null;
  }

  /**
   * Editor-only read-only debug query (docs/MESSAGE-CATALOG.md §0x0a).
   * One outstanding query at a time (editor overlays poll at low
   * frequency); the promise resolves with the server's DebugResponse
   * or rejects on error/disconnect/timeout.
   */
  debug(query: DebugQuery): Promise<DebugResponse> {
    if (!this.socket || this.closed) {
      return Promise.reject(new Error("mirror-client: not connected"));
    }
    if (this.debugResolve) {
      return Promise.reject(
        new Error("mirror-client: debug query already in flight"),
      );
    }
    const promise = new Promise<DebugResponse>((resolve, reject) => {
      this.debugResolve = resolve;
      this.debugReject = reject;
      setTimeout(() => {
        if (this.debugReject === reject) {
          this.debugResolve = null;
          this.debugReject = null;
          reject(new Error("mirror-client: debug query timed out"));
        }
      }, CONNECT_TIMEOUT_MS);
    });
    this.socket.send(encodeEnvelope(MessageType.Debug, encodeControl(query)));
    return promise;
  }

  // ------------------------------------------------------------ inbound

  private onMessage(data: Uint8Array): void {
    let type: MessageType;
    let payload: Uint8Array;
    try {
      ({ type, payload } = decodeEnvelope(data));
    } catch {
      return; // garbage frame: ignore, the heartbeat will sort it out
    }
    switch (type) {
      case MessageType.Welcome:
        this.onWelcome(decodeControl<WelcomeMessage>(payload));
        break;
      case MessageType.Snapshot:
        this.onSnapshot(payload);
        break;
      case MessageType.Delta:
        this.onDelta(payload);
        break;
      case MessageType.Ping:
        // Heartbeat: echo the payload back as pong (catalog §0x06/0x07).
        this.socket?.send(encodeEnvelope(MessageType.Pong, payload));
        break;
      case MessageType.Error: {
        const err = decodeControl<ErrorMessage>(payload);
        this.lastError = err;
        this.events.onError(err);
        this.welcomeReject?.(
          new Error(`hello rejected: ${err.code} ${err.message}`),
        );
        this.welcomeResolve = null;
        this.welcomeReject = null;
        this.debugReject?.(
          new Error(`debug rejected: ${err.code} ${err.message}`),
        );
        this.debugResolve = null;
        this.debugReject = null;
        break;
      }
      case MessageType.Debug: {
        const res = decodeControl<DebugResponse>(payload);
        this.debugResolve?.(res);
        this.debugResolve = null;
        this.debugReject = null;
        break;
      }
      case MessageType.Bye:
        this.disconnect();
        break;
      default:
        break;
    }
  }

  private onWelcome(w: WelcomeMessage): void {
    if (w.protocol !== PROTOCOL_VERSION) {
      this.welcomeReject?.(
        new Error(`protocol mismatch: server=${w.protocol}`),
      );
      this.welcomeResolve = null;
      this.welcomeReject = null;
      return;
    }
    this.playerEntity = BigInt(w.player_entity);
    this.sessionToken = w.session_token;
    this.serverTick = w.server_tick;
    this.tickHz = w.tick_hz;
    this.world = w.world ?? null;
    this.events.onWelcome(w);
    this.welcomeResolve?.(w);
    this.welcomeResolve = null;
    this.welcomeReject = null;
  }

  private onSnapshot(payload: Uint8Array): void {
    const s = decodeSnapshot(payload);
    this.state.applySnapshot(s);
    this.interpolator.clear();
    this.interpolator.push(s.tick, s.transforms);
    this.serverTick = s.tick;
    this.events.onState(s.tick);
  }

  private onDelta(payload: Uint8Array): void {
    const d = decodeDelta(payload);
    this.state.applyDelta(d);
    this.interpolator.push(d.tick, d.transforms);
    for (const wid of d.despawned) this.interpolator.remove(wid);
    this.serverTick = d.tick;
    this.events.onState(d.tick);
  }

  private onClose(): void {
    this.closed = true;
    this.socket = null;
    this.welcomeReject?.(new Error("mirror-client: connection closed"));
    this.welcomeResolve = null;
    this.welcomeReject = null;
    this.events.onClose();
  }

  private onSocketError(err: unknown): void {
    this.welcomeReject?.(
      new Error(`mirror-client: socket error: ${String(err)}`),
    );
    this.welcomeResolve = null;
    this.welcomeReject = null;
  }
}
