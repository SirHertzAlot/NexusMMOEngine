/**
 * Quests view of the Story workspace (roadmap EA26): the real quests in
 * content/quests (the files the server loads), read through the Story
 * host. Editing is the Story editor's job; this links there.
 */
import * as React from "react";
import { loadStory } from "../story-client.js";
import { summarizeQuests, type QuestRow } from "../quest-summary.js";
import { Badge, Button, TreeItem } from "./components.js";
import { createStore } from "../store.js";
import { selectedQuest } from "./live-selection.js";
import { renameQuestPrompt } from "./quest-rename.js";

const questRows = createStore<QuestRow[] | null>(null);

export const selectQuest = selectedQuest.set;

/** Quest rows from the files on disk; reloads when asked (after a Story editor save, say). */
export function useQuests(): { rows: QuestRow[] | null; error: string; reload(): void } {
  const rows = questRows.use();
  const [error, setError] = React.useState("");
  const reload = React.useCallback(() => {
    loadStory()
      .then(({ files }) => {
        questRows.set(summarizeQuests(files.quests, files.npcs));
        setError("");
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
  const sel = selectedQuest.use();
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
  const sel = selectedQuest.use();
  const open = (id: string): void => {
    selectQuest(id);
    onView("quests");
  };
  return (
    <div className="flex flex-col gap-0.5">
      {(rows ?? []).map((r) => (
        <TreeItem
          key={r.id}
          icon="flag"
          label={r.id}
          trailing={`${r.steps.length} steps`}
          mono
          selected={sel === r.id}
          onPick={() => open(r.id)}
          menu={[
            { label: "Show in the Quests view", icon: "open_in_new", run: () => open(r.id) },
            "sep",
            { label: "Rename id…", icon: "edit", run: () => void renameQuestPrompt(r.id).then((changed) => { if (changed) { if (sel === r.id) selectQuest(null); reload(); } }) },
          ]}
        />
      ))}
      <p className="px-3 pt-1 font-mono text-[11px]" style={dim}>content/quests · validated as a set at boot</p>
    </div>
  );
}

export function QuestDetailsLive(): React.JSX.Element {
  const { rows } = useQuests();
  const sel = selectedQuest.use();
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
