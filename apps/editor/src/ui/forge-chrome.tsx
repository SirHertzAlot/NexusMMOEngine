/**
 * Forge shell chrome — the context bar (docs/EDITOR-UI-2026.md §3 items
 * 1 and 6, slice EU2).
 *
 * The functionality reference puts one strip under the toolbar that says
 * where you are and what the project is doing. Today that same
 * information exists in the editor but is scattered: the workspace is a
 * tab, the view is another tab, the selection is only visible inside
 * whichever inspector owns it, the branch and its dirty files live in
 * the Changes workspace, and the play state is a colour on the toolbar
 * border. This bar gathers them.
 *
 * Nothing here is new capability and nothing here is a new source of
 * truth:
 *
 *   - the workspace and view come from the shell's own router state,
 *     passed in, and clicking a crumb calls the shell's `onGo`;
 *   - the selection comes from `editorSelection` (ui/editor-selection.ts);
 *   - the tool comes from `tool-store.ts`, the same store the toolbar
 *     and every viewport read;
 *   - play state comes from `playUiStore` (play-mode.ts);
 *   - the branch and its changed-file count come from `vcsStatus()`
 *     (/api/editor/vcs/status, vcs-host.ts) — the same call the Source
 *     Control panel makes;
 *   - the problem count is the shell's own total, passed in.
 *
 * It mounts only under `[data-theme="forge"]`: there is no Material 3
 * counterpart to restyle, so rather than draw a second bar in the old
 * language the shell leaves it out (see `useTheme()` in theme.ts).
 */

import * as React from "react";
import { MIcon } from "./components.js";
import { useEditorSelection } from "./editor-selection.js";
import { useTool } from "./tool-store.js";
import { playUiStore } from "./play-ui-store.js";
import type { PlayModeState } from "../play-mode.js";
import { vcsStatus, type VcsFile } from "../vcs-client.js";

export type Tone = "ok" | "warn" | "bad" | "note" | "idle";

const TONE: Readonly<Record<Tone, string>> = {
  ok: "var(--fg-ok)",
  warn: "var(--fg-warn)",
  bad: "var(--fg-bad)",
  note: "var(--fg-note)",
  idle: "var(--fg-text-faint)",
};

export interface Crumb {
  /** Stable key, and what a test matches on. */
  id: string;
  label: string;
  /** Set when the crumb is a place the shell can navigate back to. */
  nav?: boolean;
}

/**
 * The path, outermost first. The selection crumb appears only when
 * something is selected, so the bar never shows an empty tail.
 */
export function crumbs(input: {
  workspaceLabel: string;
  viewLabel?: string;
  selectionLabel?: string;
}): Crumb[] {
  const out: Crumb[] = [{ id: "workspace", label: input.workspaceLabel, nav: true }];
  if (input.viewLabel) out.push({ id: "view", label: input.viewLabel });
  if (input.selectionLabel) out.push({ id: "selection", label: input.selectionLabel });
  return out;
}

/**
 * Play state as a chip. The wording is the controller's own vocabulary
 * (play-mode.ts) rather than a second set of names for the same states.
 */
export function serverChip(state: PlayModeState): { label: string; tone: Tone } {
  switch (state) {
    case "running":
      return { label: "running", tone: "ok" };
    case "starting":
      return { label: "starting", tone: "warn" };
    case "stopping":
      return { label: "stopping", tone: "warn" };
    case "error":
      return { label: "failed", tone: "bad" };
    default:
      return { label: "stopped", tone: "idle" };
  }
}

/**
 * Branch and working-tree summary. A conflict outranks a dirty file,
 * and a dirty file outranks a clean tree, so the one tone the chip can
 * show is the worst thing in the tree — the reference's "Conflict
 * Guard" signal, over the data `vcs-host.ts` already returns.
 */
export function branchChip(
  status: { branch: string; files: ReadonlyArray<VcsFile> } | null,
): { label: string; detail: string; tone: Tone } {
  if (status === null) return { label: "no repository", detail: "", tone: "idle" };
  const conflicted = status.files.filter((f) => f.conflicted).length;
  const changed = status.files.length;
  if (conflicted > 0) {
    return {
      label: status.branch,
      detail: `${conflicted} conflict${conflicted === 1 ? "" : "s"}`,
      tone: "bad",
    };
  }
  if (changed > 0) {
    return { label: status.branch, detail: `${changed} changed`, tone: "warn" };
  }
  return { label: status.branch, detail: "clean", tone: "ok" };
}

/** Poll the branch. Slow on purpose: a chip is not a file watcher. */
const BRANCH_POLL_MS = 15_000;

export function useVcsSummary(
  read: () => Promise<{ branch: string; files: VcsFile[] }> = vcsStatus,
  periodMs = BRANCH_POLL_MS,
): { branch: string; files: ReadonlyArray<VcsFile> } | null {
  const [status, setStatus] = React.useState<{ branch: string; files: ReadonlyArray<VcsFile> } | null>(
    null,
  );
  React.useEffect(() => {
    let live = true;
    const tick = (): void => {
      read()
        .then((next) => {
          if (live) setStatus(next);
        })
        // No repository, or the host is not serving VCS: the chip says so
        // and the bar stays up. It is context, never a blocker.
        .catch(() => {
          if (live) setStatus(null);
        });
    };
    tick();
    const timer = setInterval(tick, periodMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [read, periodMs]);
  return status;
}

function Chip({
  icon,
  label,
  detail,
  tone,
  title,
}: {
  icon: string;
  label: string;
  detail?: string;
  tone: Tone;
  title: string;
}): React.JSX.Element {
  return (
    <span
      className="fg-chip"
      title={title}
      style={{ color: TONE[tone] }}
    >
      <MIcon name={icon} size={13} />
      <span className="fg-data" style={{ color: "var(--fg-text)" }}>
        {label}
      </span>
      {detail ? <span className="fg-data fg-dim">{detail}</span> : null}
    </span>
  );
}

/**
 * The bar. `onGo` is the shell's own navigation, so the workspace crumb
 * goes where the workspace tab goes and nowhere else.
 */
export function ForgeContextBar({
  workspaceLabel,
  viewLabel,
  problems,
  onGoWorkspace,
  onOpenProblems,
  vcs,
}: {
  workspaceLabel: string;
  viewLabel?: string;
  problems: number;
  onGoWorkspace: () => void;
  onOpenProblems: () => void;
  /** Injected in tests and in the capture harness; live by default. */
  vcs?: { branch: string; files: ReadonlyArray<VcsFile> } | null;
}): React.JSX.Element {
  const selection = useEditorSelection();
  const tool = useTool();
  const { pmState } = playUiStore.useValue();
  const polled = useVcsSummary();
  const status = vcs === undefined ? polled : vcs;

  const path = crumbs({
    workspaceLabel,
    viewLabel,
    selectionLabel: selection ? `${selection.label}` : undefined,
  });
  const server = serverChip(pmState);
  const branch = branchChip(status);

  return (
    <div className="fg-contextbar" role="navigation" aria-label="Editor context">
      <nav className="flex min-w-0 items-center gap-1.5" aria-label="Breadcrumb">
        {path.map((crumb, i) => (
          <React.Fragment key={crumb.id}>
            {i > 0 && (
              <span className="fg-data fg-dim" aria-hidden>
                ›
              </span>
            )}
            {crumb.nav ? (
              <button
                type="button"
                className="m3-focus fg-crumb fg-label"
                onClick={onGoWorkspace}
                title={`Back to ${crumb.label}`}
              >
                {crumb.label}
              </button>
            ) : (
              <span
                className={crumb.id === "selection" ? "fg-data" : "fg-label"}
                style={crumb.id === "selection" ? { color: "var(--fg-accent-text)" } : undefined}
                aria-current={crumb.id === "selection" ? undefined : "page"}
              >
                {crumb.label}
              </span>
            )}
          </React.Fragment>
        ))}
      </nav>

      <div className="ml-auto flex flex-none items-center gap-1.5">
        <Chip
          icon="near_me"
          label={tool}
          tone="note"
          title="The shared viewport tool (V/W/E/R) — every viewport gates its edit gesture on it"
        />
        <Chip
          icon="commit"
          label={branch.label}
          detail={branch.detail}
          tone={branch.tone}
          title="Branch and working tree, from /api/editor/vcs/status"
        />
        <Chip
          icon="dns"
          label={server.label}
          tone={server.tone}
          title="Play-mode server state"
        />
        <button
          type="button"
          className="m3-focus fg-chip"
          onClick={onOpenProblems}
          title="Open the Problems tab"
          style={{ color: problems === 0 ? TONE.idle : TONE.bad }}
        >
          <MIcon name={problems === 0 ? "check_circle" : "error"} size={13} />
          <span className="fg-data" style={{ color: "var(--fg-text)" }}>
            {problems === 0 ? "no problems" : `${problems} problem${problems === 1 ? "" : "s"}`}
          </span>
        </button>
      </div>
    </div>
  );
}
