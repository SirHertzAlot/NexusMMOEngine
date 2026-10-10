/**
 * Network workspace data (roadmap EA26): the edge routes file and the edge's
 * Prometheus scrape, as pure functions. The rules mirror the edge's own
 * loader (apps/edge/src/router.ts) so the editor refuses what the edge would.
 */
export interface RouteRow {
  packetType: string;
  destination: string;
}

export interface RouteIssue {
  path: string;
  message: string;
}

const LOCAL = /^local:[a-z0-9_]+$/;

/** Every problem in a routes document (empty = the edge would load it). */
export function validateRoutes(doc: unknown): RouteIssue[] {
  const out: RouteIssue[] = [];
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [{ path: "", message: 'top level must be an object { "routes": [...] }' }];
  const top = doc as Record<string, unknown>;
  for (const k of Object.keys(top)) if (k !== "routes") out.push({ path: k, message: "unknown top-level key" });
  if (!Array.isArray(top.routes)) return [...out, { path: "routes", message: "routes must be an array" }];
  const seen = new Map<string, number>();
  top.routes.forEach((row: unknown, i: number) => {
    const where = `routes[${i}]`;
    if (typeof row !== "object" || row === null || Array.isArray(row)) return void out.push({ path: where, message: "must be an object" });
    const r = row as Record<string, unknown>;
    for (const k of Object.keys(r)) if (k !== "packetType" && k !== "destination") out.push({ path: `${where}.${k}`, message: "unknown key" });
    if (typeof r.packetType !== "string" || r.packetType.length === 0) out.push({ path: `${where}.packetType`, message: "must be a non-empty string" });
    else if (seen.has(r.packetType)) out.push({ path: `${where}.packetType`, message: `duplicate of routes[${seen.get(r.packetType)}]` });
    else seen.set(r.packetType, i);
    if (typeof r.destination !== "string" || (r.destination !== "core" && !LOCAL.test(r.destination))) {
      out.push({ path: `${where}.destination`, message: 'must be "core" or "local:<module>"' });
    }
  });
  return out;
}

/** The edge metrics the Network panel shows, summed over label sets. */
export const EDGE_SHOWN = [
  "mmo_edge_ws_connections",
  "mmo_edge_ws_connects_total",
  "mmo_edge_ws_disconnects_total",
  "mmo_edge_router_requests_total",
  "mmo_edge_router_errors_total",
  "mmo_edge_core_metrics_stale",
] as const;

/** Sum each shown metric's samples out of a Prometheus text exposition; absent metrics are left out. */
export function parseEdgeMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(-?[0-9.eE+-]+|NaN|\+Inf)\s*$/.exec(line.trim());
    if (!m || !(EDGE_SHOWN as readonly string[]).includes(m[1])) continue;
    const v = Number(m[2]);
    if (Number.isFinite(v)) out[m[1]] = (out[m[1]] ?? 0) + v;
  }
  return out;
}
