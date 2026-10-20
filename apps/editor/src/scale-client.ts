/**
 * Browser-safe adapter for the Scale view: HTTP to the dev host's
 * `/api/editor/scale` (scale-host.ts), and the local art catalog's model
 * sizes for the gauge (`/assets/catalog.json`, served from the ignored
 * assets folder; absent means the gauge has nothing to size).
 */
import type { SceneIssue, ScaleDoc } from "@mmo-engine/scene";
import { callEnvelope, IssuesError, invalidMessage } from "./api.js";
import type { GaugeModel } from "./scale-model.js";

export class ScaleSaveError extends IssuesError<SceneIssue> {
  constructor(issues: SceneIssue[]) {
    super(issues, invalidMessage("scale", issues.length));
  }
}

export const getScale = async (base = ""): Promise<ScaleDoc> => (await callEnvelope<{ doc: ScaleDoc }>(`${base}/api/editor/scale`, "GET")).doc;

/** Validate on the host and write only when valid; throws ScaleSaveError otherwise. */
export const saveScale = async (doc: ScaleDoc, base = ""): Promise<ScaleDoc> =>
  (await callEnvelope<{ doc: ScaleDoc }>(`${base}/api/editor/scale`, "PUT", { doc }, (i) => new ScaleSaveError(i))).doc;

/** The catalog's models (id, category, name, size), or [] when there is no art folder here. */
export async function getGaugeModels(base = ""): Promise<GaugeModel[]> {
  try {
    const res = await fetch(`${base}/assets/catalog.json`);
    if (!res.ok) return [];
    const b = (await res.json()) as { models?: GaugeModel[] };
    return (b.models ?? []).filter((m) => Array.isArray(m.size) && typeof m.id === "string");
  } catch {
    return [];
  }
}
