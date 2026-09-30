/**
 * A small webrpc server on the gateway's port (either transport, see
 * ./transport.ts) for the region (the world server's
 * Express adapter speaks the same wire protocol, see world.ridl):
 *
 *   POST /rpc/<Service>/<Method>   Content-Type: application/json
 *   -> {"argName": ...}            <- {"outName": ...}
 *   errors: HTTP <code> with {"code": <code>, "msg": "..."}
 *
 * plus plain GET routes for binary payloads. Browsers call it from the
 * client's and editor's own origins, so every response carries CORS
 * headers and preflights are answered. Every call needs
 * `Authorization: Bearer <session token>`: `authenticate` resolves it.
 */

import { HttpBodyTooLarge, type HttpRequest, type HttpResponse } from "./transport.js";

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

/** Who is calling: resolved from the Bearer token. */
export interface RpcCaller {
  username: string;
}

export type RpcMethod = (args: Record<string, unknown>, caller: RpcCaller) => Promise<Record<string, unknown>>;
export type RpcGet = (
  params: string[],
  caller: RpcCaller,
) => Promise<{ status?: number; contentType: string; body: Uint8Array; headers?: Record<string, string> }>;

export interface RpcServerOptions {
  authenticate: (token: string) => RpcCaller | null;
  /** Largest JSON body accepted, bytes. */
  maxBodyBytes?: number;
}

const BEARER = /^Bearer\s+(\S+)$/;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
};

export class RpcServer {
  private readonly methods = new Map<string, RpcMethod>();
  private readonly gets: Array<{ prefix: string; handler: RpcGet }> = [];

  constructor(private readonly opts: RpcServerOptions) {}

  /** Register `POST /rpc/<service>/<method>`. */
  method(service: string, method: string, fn: RpcMethod): this {
    this.methods.set(`/rpc/${service}/${method}`, fn);
    return this;
  }

  /** Register `GET <prefix>/<a>/<b>/…`: the handler gets the path segments after the prefix. */
  get(prefix: string, handler: RpcGet): this {
    this.gets.push({ prefix: prefix.replace(/\/$/, "") + "/", handler });
    return this;
  }

  /** Handle a request if it is ours; false leaves it to the caller (404, upgrade…). */
  handle(req: HttpRequest, res: HttpResponse): boolean {
    const url = req.url.split("?")[0];
    const isRpc = url.startsWith("/rpc/");
    const get = this.gets.find((g) => url.startsWith(g.prefix));
    if (!isRpc && !get) return false;
    if (req.method === "OPTIONS") {
      res.send(204, CORS);
      return true;
    }
    void this.dispatch(req, res, url, get?.handler ?? null, get?.prefix ?? "").catch((err: unknown) => this.fail(res, err));
    return true;
  }

  private async dispatch(req: HttpRequest, res: HttpResponse, url: string, get: RpcGet | null, prefix: string): Promise<void> {
    const token = BEARER.exec(req.header("authorization").trim())?.[1];
    if (!token) throw new RpcError(401, "missing bearer token");
    const caller = this.opts.authenticate(token);
    if (!caller) throw new RpcError(401, "invalid or expired session token");

    if (get) {
      if (req.method !== "GET") throw new RpcError(405, "use GET");
      const params = url.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
      const out = await get(params, caller);
      res.send(out.status ?? 200, { ...CORS, "Content-Type": out.contentType, "Content-Length": String(out.body.byteLength), ...out.headers }, out.body);
      return;
    }

    if (req.method !== "POST") throw new RpcError(405, "use POST");
    const fn = this.methods.get(url);
    if (!fn) throw new RpcError(404, `unknown method ${url.slice(5)}`);
    if (!req.header("content-type").startsWith("application/json")) {
      throw new RpcError(415, "content-type must be application/json");
    }
    const limit = this.opts.maxBodyBytes ?? 4 << 20;
    let body: string;
    try {
      body = new TextDecoder().decode(await req.readBody(limit));
    } catch (err) {
      throw err instanceof HttpBodyTooLarge ? new RpcError(413, err.message) : err;
    }
    let args: unknown;
    try {
      args = body.length === 0 ? {} : JSON.parse(body);
    } catch {
      throw new RpcError(400, "body is not JSON");
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new RpcError(400, "body must be a JSON object");
    const out = await fn(args as Record<string, unknown>, caller);
    res.send(200, { ...CORS, "Content-Type": "application/json" }, JSON.stringify(out));
  }

  private fail(res: HttpResponse, err: unknown): void {
    const code = err instanceof RpcError ? err.code : 500;
    const msg = err instanceof RpcError ? err.message : "internal error";
    if (code === 500) console.error("[rpc] internal error", err);
    if (res.done) {
      res.abort();
      return;
    }
    res.send(code, { ...CORS, "Content-Type": "application/json" }, JSON.stringify({ code, msg }));
  }
}
