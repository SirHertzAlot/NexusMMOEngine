/**
 * Quests view of the Story workspace (roadmap EA26): the real quests in
 * content/quests (the files the server loads), read through the Story
 * host. Editing is the Story editor's job; this links there.
 */
import * as React from "react";
import { loadStory, renameQuestRemote, StorySaveError } from "../story-client.js";
import { summarizeQuests, type QuestRow } from "../quest-summary.js";
import { Badge, Button, OverflowMenu, notify } from "./components.js";

let selected: string | null = null;
let rowsCache: QuestRow[] | null = null;
const subs = new Set<() => void>();
const emit = (): void => subs.forEach((f) => f());
const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

export function selectQuest(id: string | null): void {
  selected = id;
  emit();
}

/** Quest rows from the files on disk; reloads when asked (after a Story editor save, say). */
export function useQuests(): { rows: QuestRow[] | null; error: string; reload(): void } {
  const rows = React.useSyncExternalStore(subscribe, () => rowsCache);
  const [error, setError] = React.useState("");
  const reload = React.useCallback(() => {
    loadStory()
      .then(({ files }) => {
        rowsCache = summarizeQuests(files.quests, files.npcs);
        setError("");
        emit();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  React.useEffect(reload, [reload]);
  return { rows, error, reload };
}

const dim = { color: "var(--m3-on-surface-variant)" } as const;
export const openStoryEditor = (): void => {
  window.location.hash = "#/story/story-editor";
};

export function QuestsPanel(): React.JSX.Element {
  const { rows, error, reload } = useQuests();
  const sel = React.useSyncExternalStore(subscribe, () => selected);
  if (error) return <p className="p-3 text-sm text-red-400">Could not read content/quests: {error}</p>;
  if (rows === null) return <p className="p-3 text-sm" style={dim}>Reading content/quests…</p>;
  const q = rows.find((r) => r.id === sel) ?? rows[0];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <span className="text-sm font-medium">{rows.length} quest{rows.length === 1 ? "" : "s"}</span>
        <span className="font-mono text-xs" style={dim}>content/quests/quests.json · loaded by the server at boot</span>
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={reload}>Reload</Button>
          <Button size="sm" onClick={openStoryEditor}>Open in Story editor</Button>
        </span>
      </div>
      {rows.length === 0 && <p className="text-sm" style={dim}>No quests are authored yet. Add one in the Story editor.</p>}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[260px_1fr]">
        <ul className="flex flex-col gap-1 rounded-xl p-2" style={{ background: "var(--m3-surface-2)" }} aria-label="Quests">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => selectQuest(r.id)}
                aria-current={q?.id === r.id ? "true" : undefined}
                className="m3-focus w-full rounded-xl px-3 py-2 text-left"
                style={q?.id === r.id ? { background: "var(--m3-secondary-container)" } : undefined}
              >
                <span className="block text-sm font-medium">{r.name}</span>
                <span className="font-mono text-[11px]" style={dim}>{r.id} · {r.steps.length} step{r.steps.length === 1 ? "" : "s"} · {r.giverName}</span>
              </button>
            </li>
          ))}
        </ul>
        {q && (
          <section className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }} aria-label={`Quest ${q.name}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-medium">{q.name}</h3>
              {q.repeatable && <Badge tone="info">repeatable</Badge>}
              {q.after.length > 0 && <Badge>after {q.after.join(", ")}</Badge>}
            </div>
            <p className="mt-1 text-sm" style={dim}>{q.summary}</p>
            <p className="mt-1 text-xs" style={dim}>Given by {q.giverName}{q.rewards ? ` · rewards ${q.rewards}` : ""}</p>
            <ol className="mt-3 flex flex-col gap-1.5">
              {q.steps.map((s, i) => (
                <li key={s.id} className="flex items-baseline gap-2 rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--m3-surface-3)" }}>
                  <span className="font-mono text-xs" style={dim}>{i + 1}</span>
                  <span className="flex-1">{s.text}</span>
                  <span className="font-mono text-[11px]" style={dim}>{s.id} · {s.objective}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}

/** Left tree of the Story workspace: the real quests; picking one shows it in the Quests view. */
export function QuestsTree({ onView }: { onView: (v: string) => void }): React.JSX.Element {
  const { rows, reload } = useQuests();
  const sel = React.useSyncExternalStore(subscribe, () => selected);
  const rename = (from: string): void => {
    const to = window.prompt(`Rename quest id "${from}" to (lowercase letters, digits, dashes):`, from);
    if (!to || to === from) return;
    renameQuestRemote(from, to).then(
      () => {
        if (selected === from) selectQuest(to);
        reload();
        notify(`Renamed quest ${from} to ${to} (quests and dialogs updated)`);
      },
      (e: Error) =>
        notify(
          e instanceof StorySaveError
            ? `Rename refused, nothing written: ${e.issues.filter((i) => i.severity === "error").slice(0, 2).map((i) => i.message).join("; ")}`
            : `Rename refused: ${e.message}`,
        ),
    );
  };
  return (
    <div className="flex flex-col gap-0.5">
      {(rows ?? []).map((r) => (
        <div key={r.id} className="flex items-center">
          <button
            onClick={() => {
              selectQuest(r.id);
              onView("quests");
            }}
            aria-current={sel === r.id ? "true" : undefined}
            className="m3-focus flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-1.5 text-left text-[13px]"
            style={sel === r.id ? { background: "var(--m3-secondary-container)" } : undefined}
          >
            <span className="font-mono">{r.id}</span>
            <span className="ml-auto text-[11px]" style={dim}>{r.steps.length} steps</span>
          </button>
          <OverflowMenu label={`${r.id} actions`} size={36} items={[{ label: "Rename id…", icon: "edit", run: () => rename(r.id) }]} />
        </div>
      ))}
      <p className="px-3 pt-1 font-mono text-[11px]" style={dim}>content/quests · validated as a set at boot</p>
    </div>
  );
}

export function QuestDetailsLive(): React.JSX.Element {
  const { rows } = useQuests();
  const sel = React.useSyncExternalStore(subscribe, () => selected);
  const q = (rows ?? []).find((r) => r.id === sel) ?? rows?.[0];
  if (!q) return <p className="text-xs" style={dim}>No quest selected.</p>;
  return (
    <div className="flex flex-col gap-2 text-xs" style={dim}>
      <p className="text-sm font-medium" style={{ color: "var(--m3-on-surface)" }}>{q.name}</p>
      <p className="font-mono">{q.id}</p>
      <p>{q.steps.length} steps. Edit the steps, dialog and rewards in the Story editor; saved quests reach the server the next time it starts.</p>
      <Button size="sm" onClick={openStoryEditor}>Open in Story editor</Button>
    </div>
  );
}
