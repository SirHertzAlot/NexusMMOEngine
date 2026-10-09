/**
 * Network workspace host routes (roadmap EA26), loopback only:
 *
 *   GET /api/editor/network → { routes, edge }   routes.json plus a live probe of the edge's /metrics
 *   PUT /api/editor/network → { content }        validate with the edge's rules, then write routes.json
 *
 * `<repo>/content/edge/routes.json` is the file the edge loads at boot, so a
 * saved change shows up the next time the edge starts. A refused save writes
 * nothing. The probe asks the edge on EDGE_HTTP_PORT (default 3000) and says
 * "not running" when nothing answers.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEdgeMetrics, validateRoutes } from "./network-model.js";

type Reply = { status: number; body: unknown };
export const routesFile = (repo: string): string => join(resolve(repo, "content", "edge"), "routes.json");

export type EdgeProbe = { running: false; port: number } | { running: true; port: number; metrics: Record<string, number> };

export async function probeEdge(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<EdgeProbe> {
  const port = Number.parseInt(env.EDGE_HTTP_PORT ?? "3000", 10) || 3000;
  try {
    const res = await fetcher(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return { running: false, port };
    return { running: true, port, metrics: parseEdgeMetrics(await res.text()) };
  } catch {
    return { running: false, port };
  }
}

export async function handleNetworkRoute(repoRoot: string, method: string, pathname: string, body: string | undefined, probe: () => Promise<EdgeProbe> = probeEdge): Promise<Reply | null> {
  if (pathname !== "/api/editor/network") return null;
  const file = routesFile(repoRoot);
  if (method === "GET") {
    if (!existsSync(file)) return { status: 404, body: { ok: false, error: "no content/edge/routes.json" } };
    let content: unknown;
    try {
      content = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (err) {
      return { status: 500, body: { ok: false, error: `routes.json is not valid JSON: ${(err as Error).message}` } };
    }
    return { status: 200, body: { ok: true, content, issues: validateRoutes(content), edge: await probe() } };
  }
  if (method === "PUT") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? "") as unknown;
    } catch {
      return { status: 400, body: { ok: false, error: "request body is not valid JSON" } };
    }
    if (typeof parsed !== "object" || parsed === null || !("content" in parsed)) return { status: 400, body: { ok: false, error: 'need a JSON body shaped like {"content": …}' } };
    const content = (parsed as { content: unknown }).content;
    const issues = validateRoutes(content);
    if (issues.length > 0) return { status: 400, body: { ok: false, error: `invalid routes: ${issues.length} problem${issues.length === 1 ? "" : "s"}`, issues } };
    mkdirSync(resolve(repoRoot, "content", "edge"), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { ok: false, error: "not found" } };
}
