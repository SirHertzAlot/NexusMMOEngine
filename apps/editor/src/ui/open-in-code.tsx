/**
 * "Open in VS Code" (docs/EDITOR-UI-2026.md §2.6, slice EU9).
 *
 * The editor already knows where things are: every system node in the
 * committed ECS graph carries `file:line`. This is the click that lands
 * you there, in the editor the person already has open, instead of in a
 * worse one embedded in this one.
 *
 * Three routes to the same place, tried in that order, because each can
 * be unavailable for a reason the others are not:
 *
 *   1. the host spawns `code -g file:line` — works whenever `code` is on
 *      PATH, and is the only one that can report WHY it failed;
 *   2. the `vscode://` URI — needs no host process, only VS Code
 *      registered for the scheme, which it is by default on a desktop
 *      install;
 *   3. the command, copied — always available, and the only option left
 *      when the person's editor is not VS Code at all.
 *
 * A path the handoff refuses (anything under `assets/`, anything
 * leaving the repository) renders as a disabled chip carrying the
 * reason, not as a button that fails when pressed.
 */

import * as React from "react";
import { codeStatus, openInCode, type CodeStatus } from "../code-client.js";
import {
  codeCommand,
  parseSourceRef,
  refLabel,
  refuseOpen,
  vscodeUri,
  type SourceRef,
} from "../code-handoff.js";
import { notify } from "./components.js";

/** One fetch per page: every row asks, the host is asked once. */
let pending: Promise<CodeStatus> | null = null;

export function useCodeStatus(read: () => Promise<CodeStatus> = codeStatus): CodeStatus | null {
  const [status, setStatus] = React.useState<CodeStatus | null>(null);
  React.useEffect(() => {
    let live = true;
    (pending ??= read()).then(
      (s) => live && setStatus(s),
      () => {
        // No host route (a built editor, or an older dev server): the URI
        // and the copyable command still work, so this is not an error.
        pending = null;
      },
    );
    return () => {
      live = false;
    };
  }, [read]);
  return status;
}

/** Forget the cached status — for tests, and after a failed probe. */
export const forgetCodeStatus = (): void => {
  pending = null;
};

export type HandoffStep = "host" | "uri" | "copy";

/**
 * What this click can try, in order. Without a status we have no
 * absolute path, so the URI step is not offered; with `found: false` the
 * host would only answer 409, so it is skipped rather than pressed.
 */
export function handoffSteps(status: CodeStatus | null): HandoffStep[] {
  const steps: HandoffStep[] = [];
  if (status === null || status.editor.found) steps.push("host");
  if (status !== null) steps.push("uri");
  steps.push("copy");
  return steps;
}

/** What the chip's tooltip says: the full reference, or why it is refused. */
export function chipTitle(ref: SourceRef, refusal: string | null): string {
  if (refusal !== null) return refusal;
  const where = ref.line === null ? ref.relPath : `${ref.relPath}:${ref.line}`;
  return `Open ${where} in VS Code`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function OpenInCode({
  source,
  label,
  status,
}: {
  /** `file:line` as the graph records it, or a bare repository path. */
  source: string;
  /** Overrides the default `basename:line`. */
  label?: string;
  /** Pass a shared status when many rows render at once. */
  status?: CodeStatus | null;
}): React.JSX.Element | null {
  const own = useCodeStatus();
  const state = status === undefined ? own : status;
  const ref = React.useMemo(() => parseSourceRef(source), [source]);
  if (ref === null) return null;
  const refusal = refuseOpen(ref.relPath);

  const go = async (): Promise<void> => {
    for (const step of handoffSteps(state)) {
      if (step === "host") {
        try {
          await openInCode(ref);
          return;
        } catch {
          continue; // the URI may still work; the host may simply not be there
        }
      }
      if (step === "uri" && state !== null) {
        window.location.href = vscodeUri(state.repoRoot, ref);
        return;
      }
      if (step === "copy") {
        const command = codeCommand(ref);
        notify(
          (await copy(command))
            ? `Copied: ${command}`
            : `Could not reach VS Code. Run: ${command}`,
        );
      }
    }
  };

  return (
    <button
      type="button"
      className="m3-focus fg-chip fg-data"
      disabled={refusal !== null}
      title={chipTitle(ref, refusal)}
      aria-label={chipTitle(ref, refusal)}
      onClick={() => void go()}
      style={refusal === null ? undefined : { opacity: 0.45, cursor: "not-allowed" }}
    >
      {label ?? refLabel(ref)}
    </button>
  );
}
