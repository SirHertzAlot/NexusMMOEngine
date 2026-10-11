/**
 * Browser-safe adapter for the Strings panel (roadmap EA25): HTTP to the dev
 * host's `/api/editor/strings` (strings-host.ts). Validation lives host-side
 * with the shared rules of @mmo-engine/scene; a refused save comes back as
 * StringsSaveError with every issue and nothing written.
 */
import type { StringIssue, StringTables } from "@mmo-engine/scene";
import { callEnvelope, IssuesError, invalidMessage } from "./api.js";

export class StringsSaveError extends IssuesError<StringIssue> {
  constructor(issues: StringIssue[]) {
    super(issues, invalidMessage("strings", issues.length));
  }
}

const refused = (issues: StringIssue[]): Error => new StringsSaveError(issues);

export const getStrings = (base = ""): Promise<{ langs: string[]; tables: StringTables }> =>
  callEnvelope(`${base}/api/editor/strings`, "GET");

/** Validate on the host and write only when valid; resolves the languages written, throws StringsSaveError otherwise. */
export const saveStrings = async (tables: StringTables, base = ""): Promise<string[]> =>
  (await callEnvelope<{ saved: string[] }>(`${base}/api/editor/strings`, "PUT", { tables }, refused)).saved;
