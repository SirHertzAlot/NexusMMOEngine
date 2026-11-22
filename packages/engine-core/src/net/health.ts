/**
 * GET /health for deploy health checks (EA19): 200 "ok", claimed.
 * Everything else returns false so it composes with the webrpc and
 * other handlers mounted on the game port.
 */
import type { HttpHandler, HttpRequest, HttpResponse } from "./transport.js";

export interface HealthHttpOptions {
  /** Optional Prometheus text exposition callback mounted at `GET /metrics/civic`. */
  renderCivicMetrics?: () => string;
}

/**
 * Create an HTTP handler serving `GET /health` and (when configured) `GET /metrics/civic`.
 * Everything else returns `false` so it composes with WebRPC and other gateway HTTP handlers.
 */
export function makeHealthHttpHandler(opts?: HealthHttpOptions): HttpHandler {
  return (req: HttpRequest, res: HttpResponse): boolean => {
    if (req.method !== "GET") return false;
    const path = req.url.split("?", 1)[0];
    if (path === "/health") {
      res.send(200, { "content-type": "text/plain" }, "ok");
      return true;
    }
    if (path === "/metrics/civic" && opts?.renderCivicMetrics) {
      res.send(200, { "content-type": "text/plain; version=0.0.4" }, opts.renderCivicMetrics());
      return true;
    }
    return false;
  };
}

export const healthHttpHandler: HttpHandler = makeHealthHttpHandler();
