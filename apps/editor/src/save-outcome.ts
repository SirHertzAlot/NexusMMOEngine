/**
 * What a save or check looks like to a panel, whichever document it was for:
 * a green note, or a red one, and, when the host refused the document, the
 * issues to mark. The pure half of ui/use-save-task.ts.
 */

import { IssuesError } from "./api.js";

export type Tone = "ok" | "bad" | "info";

export interface StatusLine {
  tone: Tone;
  text: string;
}

export interface SaveFailure<I> {
  /** Null when the panel shows a refusal only as its issue list. */
  status: StatusLine | null;
  /** The host's issues when it refused the document; null for any other failure. */
  issues: I[] | null;
}

/** "3 issues" / "1 issue". */
export const issueCount = (n: number): string => `${n} issue${n === 1 ? "" : "s"}`;

/**
 * A refused document keeps its issues and says how many; anything else is
 * its own message. `refusedText` words the refusal for the panel (default
 * "Not saved: 2 issues.").
 */
export function describeSaveFailure<I>(e: unknown, refusedText?: (issues: I[]) => string | null): SaveFailure<I> {
  if (e instanceof IssuesError) {
    const issues = e.issues as I[];
    const text = refusedText ? refusedText(issues) : `Not saved: ${issueCount(issues.length)}.`;
    return { status: text === null ? null : { tone: "bad", text }, issues };
  }
  return { status: { tone: "bad", text: e instanceof Error ? e.message : String(e) }, issues: null };
}
