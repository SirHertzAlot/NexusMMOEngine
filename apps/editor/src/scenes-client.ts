/**
 * Browser-safe scene adapter for the editor UI: plain HTTP to the dev
 * host's `/api/editor/scenes` routes (see scenes-host.ts). Validation
 * lives host-side; a refused save throws SceneSaveError with every
 * problem by path, and nothing is written.
 */

import { IssuesError, invalidMessage, requestJson } from "./api.js";
import type { SceneDoc, SceneIssue } from "@mmo-engine/scene";

export class SceneSaveError extends IssuesError<SceneIssue> {
  constructor(issues: SceneIssue[]) {
    super(issues, invalidMessage("scene", issues.length));
  }
}

const refused = (issues: SceneIssue[]): Error => new SceneSaveError(issues);
const url = (base: string, name?: string): string => `${base}/api/editor/scenes${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;

export const listScenes = async (base = ""): Promise<string[]> =>
  (await requestJson<{ scenes?: string[] }>(url(base), { fail: "scene list failed", refused })).scenes ?? [];

export const getScene = async (name: string, base = ""): Promise<SceneDoc> =>
  (await requestJson<{ content: SceneDoc }>(url(base, name), { fail: "scene read failed", refused })).content;

/** Validate on the host and write only when valid; throws SceneSaveError otherwise. */
export const saveScene = (name: string, content: SceneDoc, base = ""): Promise<void> =>
  requestJson(url(base, name), { method: "PUT", body: { content }, fail: "scene save failed", refused });
