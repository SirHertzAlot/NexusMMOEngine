/**
 * The gateway's port served through the edge (E3b of docs/EDGE-CORE-SPLIT.md): the edge holds the
 * players' WebSocket and HTTP connections on the public port and relays them over the edge/core
 * channel, so the core binds no player listener. A third Transport beside uws and ws; the gateway
 * can't tell the difference.
 *
 * Edge -> core, channel notifies (in order: one TCP stream):
 *   wire.open {sid, ip}    wire.msg {sid, data}    wire.close {sid}    (the edge's socket closed)
 * Edge -> core, channel request:
 *   http {method, url, headers, body} -> {status, headers, body}
 * Core -> edge, channel pushes:
 *   wire.send {sid, data}  wire.end {sid, code, reason}  wire.sub / wire.unsub {sid, topic}
 *   wire.publish {topic, data}  (the edge fans it out to its sockets on the topic)
 * Bytes travel as base64. The edge's apps/edge/src/game-relay.ts is the other end.
 *
 * ponytail: one edge per core (an edge that goes away ends every relayed socket); base64 in JSON frames
 * costs a third more bytes on the loopback channel, binary channel frames are E5a.
 */

import type { ChannelPacket } from "@mmo-engine/channel";
import {
  HttpBodyTooLarge,
  MAX_MESSAGE_BYTES,
  type HttpRequest,
  type HttpResponse,
  type SocketListener,
  type Transport,
  type TransportHandlers,
  type WireSocket,
} from "./transport.js";

/** Send one push to the edge. */
export type EdgePush = (type: string, payload: unknown) => void;

const NO_LISTENER: SocketListener = { message() {}, close() {} };
const b64 = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64");

class RelayedSocket implements WireSocket {
  private on: SocketListener = NO_LISTENER;
  /** close() was called: sends stop now, `close` fires when the edge confirms (or goes away). */
  private closing = false;
  private ended = false;

  constructor(
    readonly sid: string,
    readonly remoteIp: string,
    private readonly push: EdgePush,
    private readonly forget: (sid: string) => void,
  ) {}

  get isOpen(): boolean {
    return !this.closing && !this.ended;
  }

  send(bytes: Uint8Array): void {
    if (this.isOpen) this.push("wire.send", { sid: this.sid, data: b64(bytes) });
  }

  close(code: number, reason: string): void {
    if (!this.isOpen) return;
    this.closing = true;
    this.push("wire.end", { sid: this.sid, code, reason });
  }

  listen(on: SocketListener): void {
    this.on = on;
  }

  subscribe(topic: string): void {
    if (this.isOpen) this.push("wire.sub", { sid: this.sid, topic });
  }

  unsubscribe(topic: string): void {
    if (this.isOpen) this.push("wire.unsub", { sid: this.sid, topic });
  }

  received(data: Uint8Array): void {
    if (this.isOpen) this.on.message(data);
  }

  /** The edge's socket is gone: `close` fires once. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.forget(this.sid);
    this.on.close();
  }
}

function obj(p: unknown): Record<string, unknown> {
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Error("payload must be an object");
  return p as Record<string, unknown>;
}

function str(o: Record<string, unknown>, k: string, max = 4096): string {
  const v = o[k];
  if (typeof v !== "string" || v.length > max) throw new Error(`payload.${k} must be a string of at most ${max} chars`);
  return v;
}

export class ChannelTransport implements Transport {
  readonly kind = "edge" as const;
  private handlers: TransportHandlers | null = null;
  private readonly sockets = new Map<string, RelayedSocket>();

  /** `push` reaches the edge; `port` is the channel's, reported as the port listened on. */
  constructor(
    private readonly push: EdgePush,
    private readonly port: number,
  ) {}

  async listen(_port: number, handlers: TransportHandlers): Promise<number> {
    if (this.handlers) throw new Error("transport: already listening");
    this.handlers = handlers;
    return this.port;
  }

  async close(): Promise<void> {
    this.handlers = null;
    for (const s of [...this.sockets.values()]) {
      s.close(1001, "server shutting down");
      s.end();
    }
  }

  publish(topic: string, bytes: Uint8Array): void {
    if (this.handlers) this.push("wire.publish", { topic, data: b64(bytes) });
  }

  /** Sockets the edge holds open for the gateway now. */
  get size(): number {
    return this.sockets.size;
  }

  /** The edge went away: every socket it held is closed. */
  edgeGone(): void {
    for (const s of [...this.sockets.values()]) s.end();
  }

  /** Answer a channel packet that is this transport's ("wire.*", "http"); undefined for any other. */
  handle(p: ChannelPacket): Promise<unknown> | undefined {
    if (p.type === "http") return this.http(obj(p.payload));
    if (!p.type.startsWith("wire.")) return undefined;
    const o = obj(p.payload);
    const sid = str(o, "sid", 128);
    switch (p.type) {
      case "wire.open": {
        const h = this.handlers;
        if (!h) {
          this.push("wire.end", { sid, code: 1013, reason: "server not ready" });
          break;
        }
        this.sockets.get(sid)?.end();
        const socket = new RelayedSocket(sid, str(o, "ip", 256), this.push, (id) => this.sockets.delete(id));
        this.sockets.set(sid, socket);
        h.connection(socket);
        break;
      }
      case "wire.msg": {
        const socket = this.sockets.get(sid);
        if (!socket) break;
        const data = Buffer.from(str(o, "data", Number.MAX_SAFE_INTEGER), "base64");
        // The edge enforces the same cap at its WebSocket; this holds if it doesn't.
        if (data.length > (this.handlers?.maxMessageBytes ?? MAX_MESSAGE_BYTES)) socket.close(1009, "message too big");
        else socket.received(new Uint8Array(data));
        break;
      }
      case "wire.close":
        this.sockets.get(sid)?.end();
        break;
      default:
        throw new Error(`unknown packet type ${p.type}`);
    }
    return Promise.resolve(null);
  }

  private http(o: Record<string, unknown>): Promise<unknown> {
    const method = str(o, "method", 16);
    const url = str(o, "url");
    const headers = typeof o.headers === "object" && o.headers !== null ? (o.headers as Record<string, unknown>) : {};
    const body = Buffer.from(typeof o.body === "string" ? o.body : "", "base64");
    return new Promise((resolve) => {
      let done = false;
      const req: HttpRequest = {
        method,
        url,
        header: (name) => {
          const v = headers[name.toLowerCase()];
          return typeof v === "string" ? v : "";
        },
        readBody: (limit) => (body.length > limit ? Promise.reject(new HttpBodyTooLarge(limit)) : Promise.resolve(new Uint8Array(body))),
      };
      const res: HttpResponse = {
        get done() {
          return done;
        },
        send(status, hdrs, b) {
          if (done) return;
          done = true;
          resolve({ status, headers: hdrs, body: b === undefined ? "" : b64(b) });
        },
        abort() {
          if (done) return;
          done = true;
          resolve({ status: 502, headers: {}, body: "" });
        },
      };
      if (!this.handlers?.http?.(req, res)) res.send(404, { "Content-Type": "text/plain" }, "not found");
    });
  }
}
