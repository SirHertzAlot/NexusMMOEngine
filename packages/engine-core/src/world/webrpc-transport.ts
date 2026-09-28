/**
 * WebrpcWorldTransport: fetch-based client for the webrpc JSON wire
 * protocol (world.ridl). POST {baseUrl}/rpc/World/<Method>.
 *
 * Written to match what `webrpc-gen -target=typescript` would emit;
 * regenerating from the RIDL must be a drop-in replacement.
 */
import { WorldTransportError, type WorldTransport } from "./client.js";

export class WebrpcWorldTransport implements WorldTransport {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    opts?: { fetchFn?: typeof fetch; timeoutMs?: number },
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts?.fetchFn ?? fetch;
    this.timeoutMs = opts?.timeoutMs ?? 10_000;
  }

  async call(
    method: string,
    args: Record<string, unknown>,
    token?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/rpc/World/${method}`, {
        method: "POST",
        headers,
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new WorldTransportError(
        0,
        `transport error calling ${method}: ${(err as Error).message}`,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new WorldTransportError(
        res.status,
        `non-JSON response from ${method} (http ${res.status})`,
      );
    }
    if (!res.ok) {
      const code =
        typeof body["code"] === "number" ? body["code"] : res.status;
      const msg =
        typeof body["msg"] === "string" ? body["msg"] : `http ${res.status}`;
      throw new WorldTransportError(code, `${method}: ${msg}`);
    }
    return body;
  }
}
