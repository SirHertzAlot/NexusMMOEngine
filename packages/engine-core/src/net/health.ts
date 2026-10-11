/**
 * GET /health for deploy health checks (EA19): 200 "ok", claimed.
 * Everything else returns false so it composes with the webrpc and
 * other handlers mounted on the game port.
 */
import type { HttpHandler, HttpRequest, HttpResponse } from "./transport.js";

export const healthHttpHandler: HttpHandler = (req: HttpRequest, res: HttpResponse): boolean => {
  if (req.method !== "GET") return false;
  const path = req.url.split("?", 1)[0];
  if (path !== "/health") return false;
  res.send(200, { "content-type": "text/plain" }, "ok");
  return true;
};
