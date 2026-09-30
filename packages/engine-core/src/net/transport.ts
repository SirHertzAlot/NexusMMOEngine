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
}

export interface SocketListener {
  message(data: Uint8Array): void;
  close(): void;
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
}

export interface Transport {
  readonly kind: "uws" | "ws";
  /** Bind `port` (0: any free port); resolves with the port bound. */
  listen(port: number, handlers: TransportHandlers): Promise<number>;
  /** Stop listening and drop every connection on the port. */
  close(): Promise<void>;
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

class WsSocket implements WireSocket {
  private on: SocketListener = NO_LISTENER;
  private closed = false;

  constructor(private readonly ws: WebSocket, readonly remoteIp: string) {
    ws.on("message", (data: WebSocket.RawData) => this.on.message(toBytes(data)));
    ws.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.on.close();
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
    const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });
    wss.on("connection", (ws: WebSocket, req: IncomingMessage) =>
      handlers.connection(new WsSocket(ws, req.socket.remoteAddress ?? "unknown")),
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

class UwsSocket implements WireSocket {
  private on: SocketListener = NO_LISTENER;
  private closed = false;

  constructor(private readonly ws: UwsWebSocket, readonly remoteIp: string) {}

  get isOpen(): boolean {
    return !this.closed;
  }

  send(bytes: Uint8Array): void {
    // A closed uWS socket must never be touched (native use-after-free guard).
    if (!this.closed) this.ws.send(bytes, true, false);
  }

  close(code: number, reason: string): void {
    if (!this.closed) this.ws.end(code, reason);
  }

  /** Drop the connection at once (shutdown). */
  terminate(): void {
    if (!this.closed) this.ws.close();
  }

  listen(on: SocketListener): void {
    this.on = on;
  }

  /** From the app's message handler: the bytes are only valid during the call. */
  deliver(message: ArrayBuffer): void {
    this.on.message(new Uint8Array(message.slice(0)));
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

  constructor(private readonly uws: UwsModule) {}

  async listen(port: number, handlers: TransportHandlers): Promise<number> {
    if (this.app) throw new Error("transport: already listening");
    const app = this.uws.App();
    app.ws("/*", {
      compression: 0,
      maxPayloadLength: MAX_MESSAGE_BYTES,
      // The gateway runs its own heartbeat (ping/pong in the protocol).
      idleTimeout: 0,
      // Deltas queue in the kernel/uWS buffer for slow readers; the
      // gateway's own queue and resync handle clients that fall behind.
      maxBackpressure: 64 << 20,
      closeOnBackpressureLimit: false,
      upgrade: (res: UwsResponse, req: UwsRequest, context: unknown) => {
        const data: UwsSocketData = { ip: decoder.decode(res.getRemoteAddressAsText()), socket: null };
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
        const socket = new UwsSocket(ws, data.ip);
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
