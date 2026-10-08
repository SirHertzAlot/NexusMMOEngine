/**
 * The EA15 loopback routes in one hook for host.ts: /api/editor/gameplay[/…]
 * (gameplay-host.ts) and /api/editor/content-catalog (content-catalog.ts).
 * Returns null for any other path so the host carries on.
 */

import { handleCatalog } from "./content-catalog.js";
import { handleGameplay } from "./gameplay-host.js";

const BASE = "/api/editor/gameplay";

export async function handleGameplayRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  contentType: string | undefined,
  readBody: () => Promise<string>,
): Promise<{ status: number; body: unknown } | null> {
  if (pathname === "/api/editor/content-catalog") return handleCatalog(repoRoot, method);
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null;
  let route: string;
  try {
    route = decodeURIComponent(pathname.slice(BASE.length + 1));
  } catch {
    return { status: 400, body: { ok: false, error: "bad path" } };
  }
  let body: unknown = {};
  if (method === "POST" || method === "PUT") {
    try {
      body = JSON.parse((await readBody()) || "{}") as unknown;
    } catch {
      return { status: 400, body: { ok: false, error: "request body is not valid JSON" } };
    }
  }
  return handleGameplay(repoRoot, { method, route, contentType, body });
}
