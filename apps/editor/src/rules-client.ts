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

import { IssuesError, invalidMessage, requestJson } from "./api.js";
import type { RuleIssueView } from "./rules-tree.js";

/** A failed save: every problem, by file and field. */
export class RulesSaveError extends IssuesError<RuleIssueView> {
  constructor(issues: RuleIssueView[]) {
    super(issues, invalidMessage("rules", issues.length));
  }
}

const refused = (issues: RuleIssueView[]): Error => new RulesSaveError(issues);
const url = (base: string, name?: string): string => `${base}/api/editor/rules${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;

/** The rules files (content/rules/<name>.json), in schema order. */
export async function listRuleFiles(base = ""): Promise<string[]> {
  return (await requestJson<{ files?: string[] }>(url(base), { fail: "rules list failed", refused })).files ?? [];
}

/** One rules file's parsed content (or the engine default when missing). */
export async function getRuleFile(
  base = "",
  name: string,
): Promise<{ name: string; content: unknown; missing: boolean }> {
  const body = await requestJson<{ name: string; content: unknown; missing?: boolean }>(url(base, name), { fail: "rules read failed", refused });
  return { name: body.name, content: body.content, missing: body.missing ?? false };
}

/**
 * Validate on the host and write back pretty-printed JSON only when
 * valid. Throws RulesSaveError (with per-path issues) otherwise.
 */
export const saveRuleFile = (base = "", name: string, content: unknown): Promise<void> =>
  requestJson(url(base, name), { method: "PUT", body: { content }, fail: "rules save failed", refused });
