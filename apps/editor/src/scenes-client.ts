/**
 * Browser-safe scene adapter for the editor UI: plain HTTP to the dev
 * host's `/api/editor/scenes` routes (see scenes-host.ts). Validation
 * lives host-side; a refused save throws SceneSaveError with every
 * problem by path, and nothing is written.
 */

import type { SceneDoc, SceneIssue } from "@mmo-engine/scene";

export class SceneSaveError extends Error {
  constructor(readonly issues: SceneIssue[]) {
    super(`invalid scene: ${issues.length} problem${issues.length === 1 ? "" : "s"}`);
    this.name = "SceneSaveError";
  }
}

async function readError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown; issues?: unknown };
    if (res.status === 400 && Array.isArray(body.issues)) return new SceneSaveError(body.issues as SceneIssue[]);
    if (typeof body.error === "string" && body.error) return new Error(body.error);
  } catch {
    /* fall through */
  }
  return new Error(`${fallback}: HTTP ${res.status}`);
}

export async function listScenes(base = ""): Promise<string[]> {
  const res = await fetch(`${base}/api/editor/scenes`);
  if (!res.ok) throw await readError(res, "scene list failed");
  return ((await res.json()) as { scenes?: string[] }).scenes ?? [];
}

export async function getScene(name: string, base = ""): Promise<SceneDoc> {
  const res = await fetch(`${base}/api/editor/scenes/${encodeURIComponent(name)}`);
  if (!res.ok) throw await readError(res, "scene read failed");
  return ((await res.json()) as { content: SceneDoc }).content;
}

/** Validate on the host and write only when valid; throws SceneSaveError otherwise. */
export async function saveScene(name: string, content: SceneDoc, base = ""): Promise<void> {
  const res = await fetch(`${base}/api/editor/scenes/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw await readError(res, "scene save failed");
}
