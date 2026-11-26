/**
 * Forge integrations — one status list for everything the editor is
 * wired to (docs/EDITOR-UI-2026.md §2.6, slice EU5).
 *
 * The styling reference folds the functionality reference's eight dock
 * tabs into four, of which **Integrations** is a status list: Blender
 * bridge, VS Code, UI layout, git worktree, runtime node. That grouping
 * is better than eight tabs, but two of the four tabs — Code and
 * Console — have nothing behind them yet, so regrouping the dock now
 * would draw empty boxes. This panel is the part that can be built
 * honestly today, over connections that already exist:
 *
 *   - the play server (`playUiStore`, play-mode.ts);
 *   - the branch and working tree (`/api/editor/vcs/status`);
 *   - the advisory soft locks in `content/locks.json`
 *     (`/api/editor/vcs/locks`) — the reference's "Conflict Guard";
 *   - the committed ECS graph and whether it still matches the commit
 *     it was built from (`checkGraphStaleness`, ecs-graph-model.ts).
 *
 * Since `EU8`–`EU10` every row reports something real: the VS Code row
 * reports what the host found on this machine's PATH, and the Blender
 * row what the live link has received. A row with nothing behind it
 * still says **not set up**, with the reason, rather than reading as a
 * failure or as a blank space — a status list that hides what is
 * missing is not a status list.
 */

import * as React from "react";
import { checkGraphStaleness, fetchEcsGraph, type GraphStaleness } from "../ecs-graph-model.js";
import { vcsLocks, vcsStatus, type VcsFile } from "../vcs-client.js";
import { playUiStore } from "./play-ui-store.js";
import { codeStatus, type CodeStatus } from "../code-client.js";
import { blenderLink, type BlenderLink } from "../blender-client.js";
import { sinceLabel } from "../blender-link.js";
import { serverChip } from "./forge-chrome.js";
import type { PlayModeState } from "../play-mode.js";

/** `absent` is not a failure: nothing is wrong, it is simply not set up. */
export type IntegrationState = "ok" | "warn" | "bad" | "absent";

export interface IntegrationRow {
  id: string;
  label: string;
  state: IntegrationState;
  /** One line. Never a guess: every detail here came from a real read. */
  detail: string;
}

export interface IntegrationInputs {
  play: PlayModeState;
  vcs: { branch: string; files: ReadonlyArray<VcsFile> } | null;
  locks: Readonly<Record<string, { owner: string; since: string }>> | null;
  graph: GraphStaleness | null;
  /** What the host found when it looked for `code` on PATH (EU9). */
  code: CodeStatus | null;
  /** What Blender has pushed through the live link (EU10). */
  blender: BlenderLink | null;
  /** For the age on the Blender row; injectable so a test is not a clock. */
  now?: number;
}

/** Plural that reads: "1 file", "3 files". */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Every row, in a fixed order so the list does not reshuffle under the
 * reader as states change. `null` inputs mean "not read yet or not
 * reachable", which is reported as such rather than as healthy.
 */
export function integrationRows(input: IntegrationInputs): IntegrationRow[] {
  const rows: IntegrationRow[] = [];

  const server = serverChip(input.play);
  rows.push({
    id: "runtime",
    label: "Runtime node",
    state: input.play === "running" ? "ok" : input.play === "error" ? "bad" : "absent",
    detail:
      input.play === "running"
        ? "play server running; debug queries and tick timings available"
        : `${server.label} — start play mode to attach`,
  });

  if (input.vcs === null) {
    rows.push({
      id: "worktree",
      label: "Git worktree",
      state: "absent",
      detail: "no repository, or the dev host is not serving /api/editor/vcs",
    });
  } else {
    const conflicted = input.vcs.files.filter((f) => f.conflicted).length;
    rows.push({
      id: "worktree",
      label: "Git worktree",
      state: conflicted > 0 ? "bad" : input.vcs.files.length > 0 ? "warn" : "ok",
      detail:
        conflicted > 0
          ? `${input.vcs.branch} · ${count(conflicted, "conflict")} to resolve`
          : input.vcs.files.length > 0
            ? `${input.vcs.branch} · ${count(input.vcs.files.length, "file")} changed`
            : `${input.vcs.branch} · clean`,
    });
  }

  if (input.locks === null) {
    rows.push({
      id: "locks",
      label: "Conflict guard",
      state: "absent",
      detail: "soft locks unavailable (content/locks.json not served)",
    });
  } else {
    const held = Object.entries(input.locks);
    const owners = new Set(held.map(([, l]) => l.owner));
    rows.push({
      id: "locks",
      label: "Conflict guard",
      state: held.length > 0 ? "warn" : "ok",
      detail:
        held.length === 0
          ? "no advisory locks held"
          : `${count(held.length, "file")} locked by ${count(owners.size, "person", "people")}`,
    });
  }

  rows.push(
    input.graph === null
      ? { id: "graph", label: "ECS graph", state: "absent", detail: "not loaded" }
      : {
          id: "graph",
          label: "ECS graph",
          state: input.graph.state === "synced" ? "ok" : input.graph.state === "stale" ? "warn" : "absent",
          detail: input.graph.reason,
        },
  );

  // The handoff (EU9). `code` missing is "not set up", not a failure:
  // the `vscode://` URI and the copyable command still work without it.
  rows.push(
    input.code === null
      ? {
          id: "vscode",
          label: "VS Code",
          state: "absent",
          detail: "handoff not probed — the dev host is not serving /api/editor/code",
        }
      : input.code.editor.found
        ? {
            id: "vscode",
            label: "VS Code",
            state: "ok",
            detail: `${input.code.editor.version ?? input.code.editor.command} — a source location opens at its line`,
          }
        : {
            id: "vscode",
            label: "VS Code",
            state: "absent",
            detail: "`code` is not on PATH; the vscode:// link and the copyable command still work",
          },
  );

  // The live link (EU10). The add-on pushes; the editor receives. No
  // model yet is "not set up", not a failure: nothing is wrong, nobody
  // has sent anything.
  const now = input.now ?? Date.now();
  rows.push(
    input.blender === null
      ? {
          id: "blender",
          label: "Blender live-link",
          state: "absent",
          detail: "the dev host is not serving /api/editor/blender",
        }
      : input.blender.models.length === 0
        ? {
            id: "blender",
            label: "Blender live-link",
            state: "absent",
            detail: `no model received yet — install ${input.blender.addon} in Blender`,
          }
        : {
            id: "blender",
            label: "Blender live-link",
            state: "ok",
            detail: `${count(input.blender.models.length, "model")} in ${input.blender.dir} · newest ${sinceLabel(input.blender.models[0].at, now)}`,
          },
  );

  return rows;
}

const TONE: Readonly<Record<IntegrationState, string>> = {
  ok: "var(--fg-ok)",
  warn: "var(--fg-warn)",
  bad: "var(--fg-bad)",
  absent: "var(--fg-text-faint)",
};

const WORD: Readonly<Record<IntegrationState, string>> = {
  ok: "connected",
  warn: "attention",
  bad: "blocked",
  absent: "not set up",
};

export function ForgeIntegrationsView({ rows }: { rows: readonly IntegrationRow[] }): React.JSX.Element {
  const connected = rows.filter((r) => r.state === "ok").length;
  return (
    <section className="fg-panel flex min-h-0 flex-col">
      <header className="flex items-baseline gap-3 p-3">
        <span className="fg-label">Integrations</span>
        <span className="fg-data fg-dim">
          {connected} of {rows.length} connected
        </span>
      </header>
      <div className="m3-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {rows.map((r) => (
          <div key={r.id} className="fg-row flex items-center gap-2.5 px-2.5 py-2">
            <i className="fg-dot" style={{ color: TONE[r.state] }} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate" style={{ color: "var(--fg-text)", fontSize: 12 }}>
                {r.label}
              </span>
              <span className="fg-data block truncate" title={r.detail}>
                {r.detail}
              </span>
            </span>
            <span className="fg-label" style={{ color: TONE[r.state] }}>
              {WORD[r.state]}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Poll each connection. Slow on purpose: a status list is not a watcher. */
const POLL_MS = 15_000;

export function useIntegrations(periodMs = POLL_MS): IntegrationInputs {
  const { pmState } = playUiStore.useValue();
  const [vcs, setVcs] = React.useState<IntegrationInputs["vcs"]>(null);
  const [locks, setLocks] = React.useState<IntegrationInputs["locks"]>(null);
  const [graph, setGraph] = React.useState<GraphStaleness | null>(null);
  // The editor handoff is a property of the machine, not of this session:
  // probed once rather than every poll.
  const [code, setCode] = React.useState<CodeStatus | null>(null);
  const [blender, setBlender] = React.useState<BlenderLink | null>(null);

  React.useEffect(() => {
    let live = true;
    const tick = (): void => {
      // Each read fails on its own: one missing route must not blank the
      // whole list, because the rest of it is still true.
      vcsStatus().then(
        (s) => live && setVcs(s),
        () => live && setVcs(null),
      );
      vcsLocks().then(
        (l) => live && setLocks(l.locks),
        () => live && setLocks(null),
      );
      blenderLink().then(
        (b) => live && setBlender(b),
        () => live && setBlender(null),
      );
      fetchEcsGraph().then(
        (p) => live && setGraph(checkGraphStaleness(p.meta.builtFromCommit, null, p.currentHead)),
        () => live && setGraph(null),
      );
    };
    tick();
    codeStatus().then(
      (c) => live && setCode(c),
      () => live && setCode(null),
    );
    const t = setInterval(tick, periodMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [periodMs]);

  return { play: pmState, vcs, locks, graph, code, blender };
}

export function ForgeIntegrationsPanel(): React.JSX.Element {
  return <ForgeIntegrationsView rows={integrationRows(useIntegrations())} />;
}
