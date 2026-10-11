/**
 * useSaveTask: the busy / status / issues state every document editor kept
 * for its own save (and check). `run` wraps one async action: busy while it
 * runs, a green status when it finishes, and on a refusal (an IssuesError
 * from the host) the issues to mark plus a red status.
 *
 *   const task = useSaveTask<SceneIssue>();
 *   const save = () => task.run(() => saveScene(name, doc), { ok: `Saved ${name}` });
 *   // task.busy, task.status, task.issues
 */

import * as React from "react";
import { describeSaveFailure, type StatusLine } from "../save-outcome.js";

export interface RunOptions<R, I> {
  /** The green status line, or a function of the action's result (which may pick another tone). */
  ok: string | StatusLine | ((result: R) => string | StatusLine);
  /** Words the refusal (null: no status line, the issue list says it); default "Not saved: 2 issues." */
  refused?: (issues: I[]) => string | null;
  /** Keep the issues already shown when the action succeeds (a check that only reports). Default: clear them. */
  keepIssues?: boolean;
}

export interface SaveTask<I> {
  busy: boolean;
  status: StatusLine | null;
  issues: I[];
  setIssues: (issues: I[]) => void;
  setStatus: (status: StatusLine | null) => void;
  /** Resolves true when the action finished, false when it failed (the status says why). */
  run: <R>(action: () => Promise<R>, opts: RunOptions<R, I>) => Promise<boolean>;
  /** Forget the status and the issues (a new document was loaded). */
  clear: () => void;
}

export function useSaveTask<I = unknown>(): SaveTask<I> {
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<StatusLine | null>(null);
  const [issues, setIssues] = React.useState<I[]>([]);

  const run = React.useCallback(async <R,>(action: () => Promise<R>, opts: RunOptions<R, I>): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await action();
      if (!opts.keepIssues) setIssues([]);
      const line = typeof opts.ok === "function" ? opts.ok(result) : opts.ok;
      setStatus(typeof line === "string" ? { tone: "ok", text: line } : line);
      return true;
    } catch (e) {
      const failure = describeSaveFailure<I>(e, opts.refused);
      if (failure.issues) setIssues(failure.issues);
      setStatus(failure.status);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = React.useCallback(() => {
    setStatus(null);
    setIssues([]);
  }, []);

  return { busy, status, issues, setIssues, setStatus, run, clear };
}
