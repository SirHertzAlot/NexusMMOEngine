/**
 * Browser-safe rules adapter for the editor UI.
 *
 * Like character-records.ts and server-control.ts, this module only
 * speaks HTTP to the dev-host routes (`/api/editor/rules`), so the
 * Rules panel can import it safely. Validation lives host-side, using
 * the Zod schemas plus cross-file checks in `@mmo-engine/rules`
 * (see rules-host.ts); saves that fail come back as 400 with per-path
 * issues, and nothing is written.
 */

import type { RuleIssueView } from "./rules-tree.js";

/** A failed save: every problem, by file and field. */
export class RulesSaveError extends Error {
  constructor(readonly issues: RuleIssueView[]) {
    super(`invalid rules: ${issues.length} problem${issues.length === 1 ? "" : "s"}`);
    this.name = "RulesSaveError";
  }
}

async function readError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown; issues?: unknown };
    if (res.status === 400 && Array.isArray(body.issues)) {
      return new RulesSaveError(body.issues as RuleIssueView[]);
    }
    if (typeof body.error === "string" && body.error) return new Error(body.error);
  } catch {
    /* fall through to the fallback */
  }
  return new Error(`${fallback}: HTTP ${res.status}`);
}

/** The rules files (content/rules/<name>.json), in schema order. */
export async function listRuleFiles(base = ""): Promise<string[]> {
  const res = await fetch(`${base}/api/editor/rules`);
  if (!res.ok) throw await readError(res, "rules list failed");
  const body = (await res.json()) as { files?: string[] };
  return body.files ?? [];
}

/** One rules file's parsed content (or the engine default when missing). */
export async function getRuleFile(
  base = "",
  name: string,
): Promise<{ name: string; content: unknown; missing: boolean }> {
  const res = await fetch(`${base}/api/editor/rules/${encodeURIComponent(name)}`);
  if (!res.ok) throw await readError(res, "rules read failed");
  const body = (await res.json()) as { name: string; content: unknown; missing?: boolean };
  return { name: body.name, content: body.content, missing: body.missing ?? false };
}

/**
 * Validate on the host and write back pretty-printed JSON only when
 * valid. Throws RulesSaveError (with per-path issues) otherwise.
 */
export async function saveRuleFile(base = "", name: string, content: unknown): Promise<void> {
  const res = await fetch(`${base}/api/editor/rules/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw await readError(res, "rules save failed");
}
