/**
 * Edge side of the channel: one TCP connection to the core, kept alive with
 * heartbeats and re-established with a fixed backoff.
 */
import { Socket, connect as netConnect } from "node:net";
import { encodeFrame, FrameReader } from "./framing.js";
import type { ChannelLike, ChannelResponse } from "./types.js";

export type ChannelStatus = "up" | "down" | "unknown";

export interface ChannelClientOptions { port: number; host?: string; heartbeatMs?: number; maxMissed?: number; }

/** Reconnect delays in ms; the last one repeats. No jitter. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout; }

export class ChannelClient implements ChannelLike {
  private readonly port: number;
  private readonly host: string;
  private readonly heartbeatMs: number;
  private readonly maxMissed: number;

  private socket: Socket | null = null;
  private _status: ChannelStatus = "unknown";
  private counter = 0;
  private attempt = 0;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private inboundSinceBeat = false;
  private missed = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly pushHandlers = new Map<string, Array<(payload: unknown) => void>>();
  private readonly statusListeners: Array<(s: ChannelStatus) => void> = [];

  constructor(opts: ChannelClientOptions) {
    this.port = opts.port;
    this.host = opts.host ?? "127.0.0.1";
    this.heartbeatMs = opts.heartbeatMs ?? 5000;
    this.maxMissed = opts.maxMissed ?? 3;
  }

  get status(): ChannelStatus { return this._status; }

  /**
   * Opens the connection. Resolves once TCP connects; rejects if this first
   * attempt fails, while the reconnect loop keeps trying in the background.
   */
  connect(): Promise<void> {
    this.closed = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      this.open(() => { if (!settled) { settled = true; resolve(); } },
                (err) => { if (!settled) { settled = true; reject(err); } });
    });
  }

  request(type: string, payload: unknown, id: string, timeoutMs = 5000): Promise<unknown> {
    if (this._status !== "up" || !this.socket) return Promise.reject(new Error("channel down"));
    // The caller's id travels end to end; the per-request prefix keeps ids
    // from different clients (each counting from 1) apart on the wire.
    const wireId = "req-" + (this.counter++) + ":" + id;
    let frame: Buffer;
    try {
      frame = encodeFrame({ type, id: wireId, payload });
    } catch (err) {
      return Promise.reject(err as Error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(wireId);
        reject(new Error("channel timeout after " + timeoutMs + "ms for " + type));
      }, timeoutMs);
      this.pending.set(wireId, { resolve, reject, timer });
      this.socket!.write(frame);
    });
  }

  notify(type: string, payload: unknown): void {
    if (this._status !== "up" || !this.socket) return;
    this.socket.write(encodeFrame({ type, id: "push-" + (this.counter++), payload }));
  }

  onPush(type: string, handler: (payload: unknown) => void): void {
    const list = this.pushHandlers.get(type);
    if (list) list.push(handler); else this.pushHandlers.set(type, [handler]);
  }

  onStatus(cb: (s: ChannelStatus) => void): void { this.statusListeners.push(cb); }

  /** Closes the connection for good: no reconnect, pending requests reject. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.socket?.destroy();
  }

  private open(onConnect: () => void, onFail: (err: Error) => void): void {
    const socket = netConnect({ port: this.port, host: this.host });
    this.socket = socket;
    const reader = new FrameReader();
    let lastError: Error | null = null;

    socket.on("connect", () => {
      this.attempt = 0;
      this.missed = 0;
      this.inboundSinceBeat = false;
      this.startHeartbeat();
      this.setStatus("up");
      onConnect();
    });
    socket.on("data", (chunk: Buffer) => {
      this.inboundSinceBeat = true;
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const f of frames) this.dispatch(f as ChannelResponse);
    });
    socket.on("error", (err) => { lastError = err; });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.stopHeartbeat();
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("channel down"));
        this.pending.delete(id);
      }
      onFail(lastError ?? new Error("channel closed"));
      this.setStatus("down");
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private dispatch(frame: ChannelResponse): void {
    if (typeof frame !== "object" || frame === null || typeof frame.id !== "string") return;
    if (frame.id.startsWith("push-")) {
      for (const h of this.pushHandlers.get(frame.type) ?? []) h(frame.payload);
      return;
    }
    const p = this.pending.get(frame.id);
    if (!p) return; // heartbeat pongs and late answers to timed-out requests
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.error !== undefined) p.reject(new Error(frame.error));
    else p.resolve(frame.payload);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this._status !== "up" || !this.socket) return;
      if (this.inboundSinceBeat) this.missed = 0;
      else this.missed++;
      this.inboundSinceBeat = false;
      if (this.missed >= this.maxMissed) {
        this.socket.destroy();
        return;
      }
      this.socket.write(encodeFrame({ type: "channel.ping", id: "hb-" + (this.counter++), payload: {} }));
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open(() => {}, () => {});
    }, delay);
  }

  private setStatus(s: ChannelStatus): void {
    if (s === this._status) return;
    this._status = s;
    for (const cb of this.statusListeners) cb(s);
  }
}
