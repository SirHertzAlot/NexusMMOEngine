/**
 * Browser-safe adapter for the HUD layout and string tables (roadmap EA23,
 * EA25): plain HTTP to `/api/editor/hud` and `/api/editor/strings` (ui-host.ts).
 * A refused save throws UiSaveError with every problem by path.
 */
import type { HudDoc, SceneIssue, StringsBundle, StringsStatus } from "@mmo-engine/scene";

export class UiSaveError extends Error {
  constructor(readonly issues: SceneIssue[]) {
    super(`invalid: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
    this.name = "UiSaveError";
  }
}

async function readError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown; issues?: unknown };
    if (res.status === 400 && Array.isArray(body.issues)) return new UiSaveError(body.issues as SceneIssue[]);
    if (typeof body.error === "string" && body.error) return new Error(body.error);
  } catch {
    /* fall through */
  }
  return new Error(`${fallback}: HTTP ${res.status}`);
}

export interface HudBundle {
  content: HudDoc;
  catalog: Array<{ id: string; label: string; note: string }>;
}

export async function getHud(base = ""): Promise<HudBundle> {
  const res = await fetch(`${base}/api/editor/hud`);
  if (!res.ok) throw await readError(res, "HUD read failed");
  return (await res.json()) as HudBundle;
}

export async function saveHud(content: HudDoc, base = ""): Promise<void> {
  const res = await fetch(`${base}/api/editor/hud`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
  if (!res.ok) throw await readError(res, "HUD save failed");
}

export interface StringsBundleSet {
  langs: Record<string, StringsBundle>;
  status: Record<string, StringsStatus>;
  /** t() ids the client calls, with the files that call them. */
  used: Record<string, string[]>;
  prefixes: string[];
  /** Used by the client but missing from en.json. */
  missingInSource: string[];
  /** In en.json but nothing in the client asks for it. */
  unused: string[];
}

export async function getStrings(base = ""): Promise<StringsBundleSet> {
  const res = await fetch(`${base}/api/editor/strings`);
  if (!res.ok) throw await readError(res, "strings read failed");
  return (await res.json()) as StringsBundleSet;
}

export async function saveStrings(lang: string, content: StringsBundle, base = ""): Promise<void> {
  const res = await fetch(`${base}/api/editor/strings/${encodeURIComponent(lang)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw await readError(res, "strings save failed");
}
