/**
 * Game flow storage for the editor dev host (roadmap EA8). One fixed
 * document, `<repo>/content/flow/game.flow.json`, so there is no name to
 * confine. Loopback routes (wired in host.ts):
 *
 *   GET /api/editor/flow → { content, scenes, events }
 *   PUT /api/editor/flow → { content } → validate, then write
 *
 * A save is validated with `validateFlow` (start exists, edges not
 * dangling, events and scenes known, every node reachable); a refused save
 * answers 400 with every issue and writes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ASSIGNED_SCENE, BUILTIN_SCREENS, FLOW_EVENTS, validateFlow } from "@mmo-engine/scene";
import { listScenes } from "./scenes-host.js";
import { refuseInvalid } from "./api.js";
import { writeJsonAtomic } from "./json-file.js";

export const flowFile = (repoRoot: string): string => join(resolve(repoRoot, "content", "flow"), "game.flow.json");
const sceneNames = (repoRoot: string): string[] => [...BUILTIN_SCREENS, ASSIGNED_SCENE, ...listScenes(repoRoot)];

export function saveFlow(repoRoot: string, content: unknown): void {
  const issues = validateFlow(content, { scenes: sceneNames(repoRoot) });
  if (issues.length > 0) {
    throw refuseInvalid("flow", issues);
  }
  writeJsonAtomic(flowFile(repoRoot), content);
}

export function handleFlowRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  body: string | undefined,
): { status: number; body: unknown } | null {
  if (pathname !== "/api/editor/flow" && !pathname.startsWith("/api/editor/flow/")) return null;
  if (pathname !== "/api/editor/flow") return { status: 404, body: { ok: false, error: "not found" } };
  try {
    if (method === "GET") {
      const file = flowFile(repoRoot);
      if (!existsSync(file)) return { status: 404, body: { ok: false, error: "no game.flow.json" } };
      return {
        status: 200,
        body: { ok: true, content: JSON.parse(readFileSync(file, "utf8")) as unknown, scenes: sceneNames(repoRoot), events: FLOW_EVENTS },
      };
    }
    if (method === "PUT") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? "") as unknown;
      } catch {
        return { status: 400, body: { ok: false, error: "request body is not valid JSON" } };
      }
      if (typeof parsed !== "object" || parsed === null || !("content" in parsed)) {
        return { status: 400, body: { ok: false, error: 'need a JSON body shaped like {"content": …}' } };
      }
      saveFlow(repoRoot, (parsed as { content: unknown }).content);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    const e = err as { status?: number; issues?: unknown };
    return {
      status: e.status ?? 500,
      body: { ok: false, error: err instanceof Error ? err.message : String(err), ...(Array.isArray(e.issues) ? { issues: e.issues } : {}) },
    };
  }
}
