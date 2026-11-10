/**
 * The gateway's port: WebSocket for the game protocol plus plain HTTP
 * (webrpc services, binary downloads) on one listener, behind a small
 * interface so the socket library can change without touching the
 * gateway.
 *
 * Two transports implement it:
 *
 * - "uws": uWebSockets.js (µWebSockets, C++): the event loop, HTTP parser
 *   and WebSocket framing run natively, so per-message cost and memory per
 *   connection are a fraction of ws's. The default whenever its binary
 *   loads (it ships prebuilt for Linux, macOS and Windows).
 * - "ws": the pure-JS `ws` library on node:http. The fallback where
 *   uWebSockets.js isn't installed (it's an optional dependency) and a
 *   reference to test against.
 *
 * Pick with GatewayOptions.transport or MMO_TRANSPORT=uws|ws; "auto"
 * (the default) takes uws when it loads, else ws.
 *
 * Both give the gateway the same things: a WireSocket per connection
 * (send bytes, close, one current set of listeners, the peer's IP) and
 * transport-neutral HTTP requests. Message bytes handed to listeners are
 * the caller's to keep (uWebSockets.js reuses its buffers after the
 * callback, so its adapter copies).
 */

import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

/** One client connection. */
export interface WireSocket {
  /** The peer's address (for auth rate limiting). */
  readonly remoteIp: string;
  /** Still open: sends are delivered. */
  readonly isOpen: boolean;
  /** Send one binary message. A no-op once closed. */
  send(bytes: Uint8Array): void;
  /** Close with a WebSocket close code and reason (graceful). */
  close(code: number, reason: string): void;
  /**
   * Route this socket's events: replaces the previous listeners (a socket
   * moving onto a re-attached session). `close` fires once.
   */
  listen(on: SocketListener): void;
  /**
   * Join a publish topic (Phase 5, Part A): the socket then receives
   * Transport.publish(topic, bytes). Joining twice is a no-op.
   */
  subscribe(topic: string): void;
  /**
   * Leave a publish topic. Leaving a topic never joined is a no-op.
   * A closed socket's subscriptions die with it.
   */
  unsubscribe(topic: string): void;
}

export interface SocketListener {
  message(data: Uint8Array): void;
  close(): void;
  /**
   * When true, `message(data)` only reads `data` synchronously during the callback (or copies what
   * it keeps), so uWebSockets.js can pass a zero-copy `Uint8Array` view over the native receive
   * buffer without allocating a copy per frame.
   */
  borrowMessage?: boolean;
}

/** An HTTP request on the game port, the same whichever transport serves it. */
export interface HttpRequest {
  readonly method: string;
  /** Path and query, e.g. "/rpc/Pcg/ListAssets". */
  readonly url: string;
  /** A header's value ("" when absent); names are case-insensitive. */
  header(name: string): string;
  /** The body, rejecting with an HttpBodyTooLarge past `limit` bytes. */
  readBody(limit: number): Promise<Uint8Array>;
}

export interface HttpResponse {
  /** Whether a response has been sent (or the client went away). */
  readonly done: boolean;
  /** Send the whole response: status, headers, body. Once. */
  send(status: number, headers: Record<string, string>, body?: Uint8Array | string): void;
  /** Drop the connection without a response. */
  abort(): void;
}

/** Handle a request if it's yours (true); false leaves it to a 404. */
export type HttpHandler = (req: HttpRequest, res: HttpResponse) => boolean;

export class HttpBodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`body over ${limit} bytes`);
    this.name = "HttpBodyTooLarge";
  }
}

export interface TransportHandlers {
  connection(socket: WireSocket): void;
  http: HttpHandler | null;
  /**
   * Largest inbound WebSocket frame accepted, bytes. The transports
   * enforce it at the protocol layer (ws: maxPayload, uWS:
   * maxPayloadLength): an oversized frame closes the connection without
   * the payload ever being buffered. Default MAX_MESSAGE_BYTES.
   */
  maxMessageBytes?: number;
}

export interface Transport {
  /** "edge": the players' sockets are the edge's, relayed over the channel (channel-transport.ts). */
  readonly kind: "uws" | "ws" | "edge";
  /** Bind `port` (0: any free port); resolves with the port bound. */
  listen(port: number, handlers: TransportHandlers): Promise<number>;
  /** Stop listening and drop every connection on the port. */
  close(): Promise<void>;
  /**
   * Fan `bytes` out to every socket subscribed to `topic` (Phase 5,
   * Part A): one call replaces one send per subscriber. uWS publishes
   * natively; `ws` emulates it with a subscriber loop. The bytes are
   * never mutated, so the same buffer may be published to several
   * topics. A no-op for a topic with no subscribers, and before
   * listen() / after close().
   */
  publish(topic: string, bytes: Uint8Array): void;
  /**
   * Optional per-tick send batching (uWS only, opt-in): between beginBatch() and endBatch() a socket's
   * sends may be held and written together; publish() writes held sends first so order is kept.
   */
  beginBatch?(): void;
  endBatch?(): void;
}

export type TransportKind = "auto" | "uws" | "ws";

/** Largest message accepted from a client (the protocol's biggest is a few KB). */
export const MAX_MESSAGE_BYTES = 1 << 20;

const require = createRequire(import.meta.url);
let uwsModule: UwsModule | null | undefined;

/** uWebSockets.js if its binary loads here, else null (with why, once). */
export function loadUws(): UwsModule | null {
  if (uwsModule !== undefined) return uwsModule;
  try {
    uwsModule = require("uWebSockets.js") as UwsModule;
  } catch {
    uwsModule = null;
  }
  return uwsModule;
}

/** The transport for `kind` (default: MMO_TRANSPORT, else auto). */
export function createTransport(kind: TransportKind = transportFromEnv()): Transport {
  if (kind === "ws") return new WsTransport();
  const uws = loadUws();
  if (uws) return new UwsTransport(uws);
  if (kind === "uws") throw new Error("transport: uWebSockets.js is not installed or has no binary for this platform (MMO_TRANSPORT=ws uses ws)");
  return new WsTransport();
}

function transportFromEnv(): TransportKind {
  const v = process.env.MMO_TRANSPORT;
  if (v === undefined || v === "" || v === "auto") return "auto";
  if (v === "uws" || v === "ws") return v;
  throw new Error(`MMO_TRANSPORT must be uws, ws or auto (got "${v}")`);
}

const NO_LISTENER: SocketListener = { message() {}, close() {} };

// ---------------------------------------------------------------- ws

/**
 * The `ws` fallback's topic registry (Phase 5 pub/sub): uWS fans out
 * natively, but `ws` has no publish, so the transport tracks who
 * subscribed to what and publish() loops over the topic's members.
 * Members are dropped when their socket closes (forget), so a dead
 * socket never holds a subscription.
 */
class TopicRegistry {
  private readonly topics = new Map<string, Set<WsSocket>>();

  subscribe(s: WsSocket, topic: string): void {
    let members = this.topics.get(topic);
    if (!members) {
      members = new Set();
      this.topics.set(topic, members);
    }
    members.add(s);
  }

  unsubscribe(s: WsSocket, topic: string): void {
    this.topics.get(topic)?.delete(s);
  }

  forget(s: WsSocket): void {
    for (const members of this.topics.values()) members.delete(s);
  }

  /** A snapshot: publish never iterates a live set a send could mutate. */
  members(topic: string): WsSocket[] {
    return [...(this.topics.get(topic) ?? [])];
  }
}

class WsSocket implements WireSocket {
  private on: SocketListener = NO_LISTENER;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    readonly remoteIp: string,
    private readonly registry: TopicRegistry,
  ) {
    ws.on("message", (data: WebSocket.RawData) => this.on.message(toBytes(data)));
    ws.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.on.close();
      this.registry.forget(this);
    });
    ws.on("error", () => {
      /* the close event follows and does the cleanup */
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  send(bytes: Uint8Array): void {
    if (this.isOpen) this.ws.send(bytes);
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  listen(on: SocketListener): void {
    this.on = on;
  }

  subscribe(topic: string): void {
    this.registry.subscribe(this, topic);
  }

  unsubscribe(topic: string): void {
    this.registry.unsubscribe(this, topic);
  }
}

/**
 * A peer's address as text, the same on both transports. uWebSockets.js
 * writes an IPv4 peer on a dual-stack listener as an expanded IPv6 address
 * ("0000:0000:0000:0000:0000:ffff:7f00:0001") and Node as "::ffff:127.0.0.1".
 * Both come out as the dotted address.
 */
export function peerText(raw: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped) return mapped[1];
  const expanded = /^(?:0{1,4}:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(raw);
  if (!expanded) return raw;
  const ip = parseInt(expanded[1], 16) * 0x10000 + parseInt(expanded[2], 16);
  return [ip >>> 24, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff].join(".");
}

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (data instanceof Uint8Array) return data; // Buffer extends Uint8Array
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error("transport: unsupported ws frame type");
}

class WsRequest implements HttpRequest {
  constructor(private readonly req: IncomingMessage) {}

  get method(): string {
    return this.req.method ?? "GET";
  }

  get url(): string {
    return this.req.url ?? "/";
  }

  header(name: string): string {
    const v = this.req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v.join(", ") : v ?? "";
  }

  readBody(limit: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      let chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      this.req.on("data", (c: Buffer) => {
        if (over) return; // drained, so the 413 can still be sent
        size += c.length;
        if (size > limit) {
          over = true;
          chunks = [];
          reject(new HttpBodyTooLarge(limit));
          return;
        }
        chunks.push(c);
      });
      this.req.on("end", () => {
        if (!over) resolve(Buffer.concat(chunks));
      });
      this.req.on("error", reject);
    });
  }
}

class WsResponse implements HttpResponse {
  constructor(private readonly res: ServerResponse) {}

  get done(): boolean {
    return this.res.headersSent || this.res.destroyed;
  }

  send(status: number, headers: Record<string, string>, body?: Uint8Array | string): void {
    if (this.done) return;
    this.res.writeHead(status, headers);
    this.res.end(body);
  }

  abort(): void {
    this.res.destroy();
  }
}

export class WsTransport implements Transport {
  readonly kind = "ws" as const;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  /** Every socket on the port (HTTP and upgraded): closed with the transport. */
  private readonly sockets = new Set<Socket>();
  /** Phase 5 pub/sub registry for the `ws` fallback. */
  private readonly registry = new TopicRegistry();

  /** Fan `bytes` out to `topic`'s subscribers (emulated: one send per member). */
  publish(topic: string, bytes: Uint8Array): void {
    for (const s of this.registry.members(topic)) s.send(bytes);
  }

  async listen(port: number, handlers: TransportHandlers): Promise<number> {
    if (this.server) throw new Error("transport: already listening");
    const http = handlers.http;
    const server = createServer((req, res) => {
      if (http?.(new WsRequest(req), new WsResponse(res))) return;
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    });
    server.on("connection", (sock: Socket) => {
      this.sockets.add(sock);
      sock.once("close", () => this.sockets.delete(sock));
    });
    const wss = new WebSocketServer({ server, maxPayload: handlers.maxMessageBytes ?? MAX_MESSAGE_BYTES });
    wss.on("connection", (ws: WebSocket, req: IncomingMessage) =>
      handlers.connection(new WsSocket(ws, peerText(req.socket.remoteAddress ?? "unknown"), this.registry)),
    );
    this.server = server;
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => resolve());
    });
    return (server.address() as AddressInfo | null)?.port ?? 0;
  }

  async close(): Promise<void> {
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      for (const ws of wss.clients) ws.terminate();
      // Not awaited: on an external HTTP server ws waits for its client
      // set to empty; the port's sockets are destroyed below either way.
      wss.close();
    }
    if (this.server) {
      const server = this.server;
      this.server = null;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Upgraded sockets aren't HTTP connections any more: server.close()
      // would wait on them forever. Nothing on the port outlives it.
      server.closeAllConnections();
      for (const sock of this.sockets) sock.destroy();
      this.sockets.clear();
      await closed;
    }
  }
}

// ---------------------------------------------------------------- uWebSockets.js

/** The slice of uWebSockets.js the transport uses (its own types are CJS-only). */
interface UwsModule {
  App(): UwsApp;
  us_listen_socket_close(token: unknown): void;
  us_socket_local_port(token: unknown): number;
}

interface UwsApp {
  ws(pattern: string, behavior: Record<string, unknown>): UwsApp;
  any(pattern: string, handler: (res: UwsResponse, req: UwsRequest) => void): UwsApp;
  listen(port: number, cb: (token: unknown) => void): UwsApp;
  close?(): UwsApp;
  /** Native fan-out to a topic's subscribers (Phase 5, Part A). */
  publish(topic: string, message: Uint8Array, isBinary?: boolean, compress?: boolean): boolean;
}

interface UwsRequest {
  getMethod(): string;
  getCaseSensitiveMethod?(): string;
  getUrl(): string;
  getQuery(): string | undefined;
  getHeader(name: string): string;
  forEach(cb: (key: string, value: string) => void): void;
}

interface UwsResponse {
  writeStatus(status: string): UwsResponse;
  writeHeader(key: string, value: string): UwsResponse;
  end(body?: Uint8Array | string, closeConnection?: boolean): UwsResponse;
  close(): UwsResponse;
  cork(cb: () => void): UwsResponse;
  onAborted(cb: () => void): UwsResponse;
  onData(cb: (chunk: ArrayBuffer, isLast: boolean) => void): UwsResponse;
  getRemoteAddressAsText(): ArrayBuffer;
  upgrade(userData: unknown, key: string, protocol: string, extensions: string, context: unknown): void;
}

interface UwsWebSocket {
  getUserData(): UwsSocketData;
  send(message: Uint8Array, isBinary?: boolean, compress?: boolean): number;
  end(code?: number, reason?: string): void;
  close(): void;
  /** Join a publish topic (Phase 5, Part A). */
  subscribe(topic: string): boolean;
  /** Leave a publish topic. */
  unsubscribe(topic: string): boolean;
  /** Run `cb` with this socket's writes corked into one syscall. */
  cork?(cb: () => void): void;
}

interface UwsSocketData {
  ip: string;
  socket: UwsSocket | null;
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK", 204: "No Content", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
  404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large", 415: "Unsupported Media Type",
  429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable",
};

const decoder = new TextDecoder();

/**
 * Per-tick send batching for uWS (MMO_UWS_CORK=1). Outside a uWS callback every ws.send is its own
 * write syscall; a session gets several messages a tick (names, delta, stats). While active, sends are
 * copied into one reusable arena (producers may reuse their buffers, so references are not held),
 * and flush() writes each socket's contiguous run inside one ws.cork. Sends are only ever delayed to
 * the end of the same broadcast, in order; nothing outlives the tick.
 */
class UwsBatch {
  active = false;
  arena = new Uint8Array(1 << 21);
  used = 0;
  socks: UwsSocket[] = [];
  off = new Int32Array(4096);
  len = new Int32Array(4096);
  runStart = 0;
  runEnd = 0;

  push(s: UwsSocket, bytes: Uint8Array): void {
    const n = bytes.length;
    if (this.used + n > this.arena.length) {
      const next = new Uint8Array(Math.max(this.arena.length * 2, this.used + n));
      next.set(this.arena.subarray(0, this.used));
      this.arena = next;
    }
    const i = this.socks.length;
    if (i >= this.off.length) {
      const off = new Int32Array(i * 2);
      off.set(this.off);
      this.off = off;
      const len = new Int32Array(i * 2);
      len.set(this.len);
      this.len = len;
    }
    this.arena.set(bytes, this.used);
    this.off[i] = this.used;
    this.len[i] = n;
    this.used += n;
    this.socks.push(s);
  }

  /** Write everything held, one corked run per socket; stays active. */
  flush(): void {
    const socks = this.socks;
    const n = socks.length;
    let i = 0;
    while (i < n) {
      const s = socks[i];
      let j = i + 1;
      while (j < n && socks[j] === s) j++;
      this.runStart = i;
      this.runEnd = j;
      s.writeRun(this);
      i = j;
    }
    socks.length = 0;
    this.used = 0;
  }
}

class UwsSocket implements WireSocket {
  private on: SocketListener = NO_LISTENER;
  private closed = false;
  private batchRef: UwsBatch | null = null;
  /** Created once: the cork callback reads its run from the batch, so flushing allocates no closure. */
  private readonly corkCb = (): void => this.sendRun(this.batchRef!);

  constructor(private readonly ws: UwsWebSocket, readonly remoteIp: string, private readonly batch: UwsBatch | null = null) {}

  get isOpen(): boolean {
    return !this.closed;
  }

  send(bytes: Uint8Array): void {
    // A closed uWS socket must never be touched (native use-after-free guard).
    if (this.closed) return;
    const b = this.batch;
    if (b !== null && b.active) b.push(this, bytes);
    else this.ws.send(bytes, true, false);
  }

  /** Write a batch run for this socket (corked when uWS offers it). */
  writeRun(b: UwsBatch): void {
    if (this.closed) return;
    if (this.ws.cork) {
      this.batchRef = b;
      this.ws.cork(this.corkCb);
      this.batchRef = null;
    } else this.sendRun(b);
  }

  private sendRun(b: UwsBatch): void {
    for (let k = b.runStart; k < b.runEnd; k++) {
      const o = b.off[k];
      this.ws.send(b.arena.subarray(o, o + b.len[k]), true, false);
    }
  }

  close(code: number, reason: string): void {
    if (!this.closed) this.ws.end(code, reason);
  }

  /** Drop the connection at once (shutdown). */
  terminate(): void {
    if (!this.closed) this.ws.close();
  }

  subscribe(topic: string): void {
    // A closed uWS socket must never be touched (native use-after-free guard).
    if (!this.closed) this.ws.subscribe(topic);
  }

  unsubscribe(topic: string): void {
    if (!this.closed) this.ws.unsubscribe(topic);
  }

  listen(on: SocketListener): void {
    this.on = on;
  }

  /** From the app's message handler: the bytes are only valid during the call. */
  deliver(message: ArrayBuffer): void {
    const view = new Uint8Array(message);
    if (this.on.borrowMessage) {
      this.on.message(view);
      return;
    }
    const copy = new Uint8Array(view.length);
    copy.set(view);
    this.on.message(copy);
  }

  /** From the app's close handler. */
  closedByPeer(): void {
    if (this.closed) return;
    this.closed = true;
    this.on.close();
  }
}

class UwsHttpRequest implements HttpRequest {
  private readonly headers = new Map<string, string>();
  readonly method: string;
  readonly url: string;
  private body: Promise<Uint8Array> | null = null;
  private bodyLimit = 0;
  private resolveBody: ((b: Uint8Array) => void) | null = null;
  private rejectBody: ((e: Error) => void) | null = null;
  private chunks: Uint8Array[] = [];
  private size = 0;
  private ended = false;
  private tooLarge = false;

  constructor(req: UwsRequest) {
    // uWS requests are only valid synchronously: copy what we need now.
    this.method = req.getMethod().toUpperCase();
    const q = req.getQuery();
    this.url = req.getUrl() + (q ? `?${q}` : "");
    req.forEach((k, v) => this.headers.set(k.toLowerCase(), v));
  }

  header(name: string): string {
    return this.headers.get(name.toLowerCase()) ?? "";
  }

  /** Body chunks from the app (registered for every request, synchronously). */
  chunk(ab: ArrayBuffer, last: boolean): void {
    if (this.tooLarge) return;
    this.size += ab.byteLength;
    if (this.body && this.size > this.bodyLimit) return this.overflow();
    this.chunks.push(new Uint8Array(ab.slice(0)));
    if (last) {
      this.ended = true;
      this.finish();
    }
  }

  readBody(limit: number): Promise<Uint8Array> {
    if (!this.body) {
      this.bodyLimit = limit;
      this.body = new Promise((resolve, reject) => {
        this.resolveBody = resolve;
        this.rejectBody = reject;
      });
      if (this.size > limit) this.overflow();
      else this.finish();
    }
    return this.body;
  }

  aborted(): void {
    this.rejectBody?.(new Error("client went away"));
  }

  private finish(): void {
    if (!this.ended || !this.resolveBody) return;
    this.resolveBody(Buffer.concat(this.chunks));
    this.chunks = [];
  }

  private overflow(): void {
    this.tooLarge = true;
    this.chunks = [];
    this.rejectBody?.(new HttpBodyTooLarge(this.bodyLimit));
  }
}

class UwsHttpResponse implements HttpResponse {
  private finished = false;

  constructor(private readonly res: UwsResponse) {
    res.onAborted(() => {
      this.finished = true;
      this.request?.aborted();
    });
  }

  request: UwsHttpRequest | null = null;

  get done(): boolean {
    return this.finished;
  }

  send(status: number, headers: Record<string, string>, body?: Uint8Array | string): void {
    if (this.finished) return;
    this.finished = true;
    this.res.cork(() => {
      this.res.writeStatus(`${status} ${STATUS_TEXT[status] ?? ""}`.trimEnd());
      // uWS writes Content-Length itself from the body.
      for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== "content-length") this.res.writeHeader(k, v);
      this.res.end(body ?? "");
    });
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.res.close();
  }
}

export class UwsTransport implements Transport {
  readonly kind = "uws" as const;
  private token: unknown = null;
  private app: UwsApp | null = null;
  private readonly sockets = new Set<UwsSocket>();
  /** Opt-in (MMO_UWS_CORK=1): batch each socket's per-tick sends into one corked write. Off by default until measured on real uWS. */
  private readonly batch: UwsBatch | null = process.env.MMO_UWS_CORK === "1" ? new UwsBatch() : null;

  constructor(private readonly uws: UwsModule) {}

  beginBatch(): void {
    if (this.batch) this.batch.active = true;
  }

  endBatch(): void {
    const b = this.batch;
    if (!b) return;
    try {
      b.flush();
    } finally {
      b.active = false;
    }
  }

  /** Native fan-out to `topic`'s subscribers (Phase 5, Part A). No-op before listen(). */
  publish(topic: string, bytes: Uint8Array): void {
    // Held per-session sends go first, so a published delta cannot overtake them.
    if (this.batch?.active) this.batch.flush();
    this.app?.publish(topic, bytes, true, false);
  }

  async listen(port: number, handlers: TransportHandlers): Promise<number> {
    if (this.app) throw new Error("transport: already listening");
    const app = this.uws.App();
    app.ws("/*", {
      compression: 0,
      maxPayloadLength: handlers.maxMessageBytes ?? MAX_MESSAGE_BYTES,
      // The gateway runs its own heartbeat (ping/pong in the protocol).
      idleTimeout: 0,
      // Deltas queue in the kernel/uWS buffer for slow readers; the
      // gateway's own queue and resync handle clients that fall behind.
      maxBackpressure: 64 << 20,
      closeOnBackpressureLimit: false,
      upgrade: (res: UwsResponse, req: UwsRequest, context: unknown) => {
        const data: UwsSocketData = { ip: peerText(decoder.decode(res.getRemoteAddressAsText())), socket: null };
        res.upgrade(
          data,
          req.getHeader("sec-websocket-key"),
          req.getHeader("sec-websocket-protocol"),
          req.getHeader("sec-websocket-extensions"),
          context,
        );
      },
      open: (ws: UwsWebSocket) => {
        const data = ws.getUserData();
        const socket = new UwsSocket(ws, data.ip, this.batch);
        data.socket = socket;
        this.sockets.add(socket);
        handlers.connection(socket);
      },
      message: (ws: UwsWebSocket, message: ArrayBuffer) => {
        ws.getUserData().socket?.deliver(message);
      },
      close: (ws: UwsWebSocket) => {
        const socket = ws.getUserData().socket;
        if (!socket) return;
        this.sockets.delete(socket);
        socket.closedByPeer();
      },
    });
    const http = handlers.http;
    app.any("/*", (res: UwsResponse, req: UwsRequest) => {
      const response = new UwsHttpResponse(res);
      const request = new UwsHttpRequest(req);
      response.request = request;
      // Body chunks arrive after this returns; take them from the start.
      res.onData((chunk, last) => request.chunk(chunk, last));
      if (http?.(request, response)) return;
      response.send(404, { "Content-Type": "text/plain" }, "not found");
    });
    const token = await new Promise<unknown>((resolve) => app.listen(port, resolve));
    if (!token) throw new Error(`transport: could not listen on port ${port}`);
    this.app = app;
    this.token = token;
    return this.uws.us_socket_local_port(token);
  }

  async close(): Promise<void> {
    if (this.token) {
      this.uws.us_listen_socket_close(this.token);
      this.token = null;
    }
    for (const s of [...this.sockets]) {
      this.sockets.delete(s);
      s.terminate();
    }
    // Also closes HTTP keep-alive connections (uWebSockets.js 20.44+).
    this.app?.close?.();
    this.app = null;
  }
}
