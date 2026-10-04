/**
 * Generic packet router (slice E1 of docs/EDGE-CORE-SPLIT.md).
 *
 * Every client packet is `{ type, id, payload }`. Its `type` is looked up
 * in `content/edge/routes.json`: `"core"` forwards it over the core
 * channel, `"local:<module>"` hands it to a handler registered on the edge.
 */
import { readFileSync } from "node:fs";
import type { ChannelLike } from "@mmo-engine/channel";

export type { ChannelLike };
export interface RouteEntry { packetType: string; destination: string; }
export interface RouterCtx { channel: ChannelLike; modules: Record<string, (payload: unknown) => Promise<unknown> | unknown>; }

const LOCAL_DESTINATION = /^local:[a-z0-9_]+$/;
const ROW_KEYS = new Set(["packetType", "destination"]);

/**
 * Reads and validates a routes file. Strict: every problem in the file is
 * collected and thrown together in one error, one line per bad row.
 */
export function loadRoutes(path: string): RouteEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Invalid routes file ${path}: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`Invalid routes file ${path}: top level must be an object { "routes": [...] }`);
  const top = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(top))
    if (key !== "routes") problems.push(`unknown top-level key "${key}"`);
  if (!Array.isArray(top.routes))
    throw new Error(`Invalid routes file ${path}: "routes" must be an array`);

  const routes: RouteEntry[] = [];
  const seen = new Map<string, number>();
  top.routes.forEach((row: unknown, i: number) => {
    const where = `routes[${i}]`;
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      problems.push(`${where}: must be an object`);
      return;
    }
    const r = row as Record<string, unknown>;
    let ok = true;
    for (const key of Object.keys(r))
      if (!ROW_KEYS.has(key)) { problems.push(`${where}: unknown key "${key}"`); ok = false; }
    if (typeof r.packetType !== "string" || r.packetType.length === 0) {
      problems.push(`${where}: packetType must be a non-empty string`);
      ok = false;
    } else {
      const first = seen.get(r.packetType);
      if (first !== undefined) {
        problems.push(`${where}: duplicate packetType "${r.packetType}" (first at routes[${first}])`);
        ok = false;
      } else {
        seen.set(r.packetType, i);
      }
    }
    if (typeof r.destination !== "string" ||
        (r.destination !== "core" && !LOCAL_DESTINATION.test(r.destination))) {
      problems.push(`${where}: destination must be "core" or match ${LOCAL_DESTINATION.source} (got ${JSON.stringify(r.destination)})`);
      ok = false;
    }
    if (ok) routes.push({ packetType: r.packetType as string, destination: r.destination as string });
  });

  if (problems.length > 0)
    throw new Error(`Invalid routes file ${path}:\n  ${problems.join("\n  ")}`);
  return routes;
}

export async function routePacket(
  packet: { type?: unknown; id?: unknown; payload?: unknown },
  routes: RouteEntry[], ctx: RouterCtx
): Promise<{ type: string; id: string; payload: unknown }> {
  const id = typeof packet.id === "string" ? packet.id : "none";
  if (typeof packet.type !== "string")
    return { type: "error.bad_packet", id, payload: { message: "packet.type must be a string" } };
  const route = routes.find(r => r.packetType === packet.type);
  if (!route)
    return { type: "error.unknown_packet", id, payload: { packetType: packet.type } };
  if (route.destination === "core") {
    try { const result = await ctx.channel.request(packet.type, packet.payload ?? null, id);
      return { type: packet.type, id, payload: result }; }
    catch (err) {
      return { type: "core.unavailable", id, payload: { retry: true,
        message: "The world is restarting. Your connection is safe — try again shortly." } };
    }
  }
  const mod = route.destination.slice("local:".length);
  const handler = ctx.modules[mod];
  if (!handler)
    return { type: "error.unknown_module", id, payload: { module: mod } };
  const result = await handler(packet.payload ?? null);
  return { type: packet.type, id, payload: result };
}
