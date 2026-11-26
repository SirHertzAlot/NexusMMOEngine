/**
 * Browser side of the VS Code handoff (slice EU9). Two calls, both
 * loopback: what the host knows about the person's editor, and a
 * request to open one source location in it.
 */

import { requestJson } from "./api.js";
import type { SourceRef } from "./code-handoff.js";

export interface CodeStatus {
  repoRoot: string;
  editor: { command: string; found: boolean; version: string | null };
}

export const codeStatus = (): Promise<CodeStatus> =>
  requestJson<CodeStatus>("/api/editor/code", { fail: "read the editor handoff status" });

/** Open `ref` in VS Code through the host. Rejects with the host's reason. */
export const openInCode = (ref: SourceRef): Promise<{ opened: string }> =>
  requestJson<{ opened: string }>("/api/editor/code/open", {
    method: "POST",
    body: { path: ref.relPath, ...(ref.line === null ? {} : { line: ref.line }) },
    fail: "open it in VS Code",
  });
