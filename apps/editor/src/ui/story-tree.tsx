/**
 * Left tree of the Story workspace: the quests that are really in
 * content/quests/quests.json (not a sample list). A quest opens in the Quest
 * and dialog editor; "Rename id…" changes the id everywhere it is named
 * (quests, prerequisites, dialog replies) through the host, which validates
 * the renamed set and writes both files or neither.
 */
import * as React from "react";
import { loadStory } from "../story-client.js";
import { TreeItem } from "./components.js";
import { renameQuestPrompt } from "./quest-rename.js";

const dim = { color: "var(--m3-on-surface-variant)" } as const;

interface QuestRef {
  id: string;
  after: number;
}

/** Quest ids (and how many prerequisites each names) from a quests document. */
export function questRefs(quests: unknown): QuestRef[] {
  const map = (quests as { quests?: Record<string, { after?: unknown[] }> } | null)?.quests ?? {};
  return Object.entries(map).map(([id, q]) => ({ id, after: Array.isArray(q?.after) ? q.after.length : 0 }));
}

export function StoryTree({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const [rows, setRows] = React.useState<QuestRef[] | null>(null);
  const [error, setError] = React.useState("");
  const reload = React.useCallback(() => {
    loadStory().then(
      ({ files }) => {
        setRows(questRefs(files.quests));
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  React.useEffect(reload, [reload]);

  const rename = (from: string): void => {
    void renameQuestPrompt(from).then((changed) => changed && reload());
  };

  if (error) return <p className="px-3 text-xs" style={dim}>Could not read the quests: {error}</p>;
  if (rows === null) return <p className="px-3 text-xs" style={dim}>Reading the quests…</p>;
  return (
    <div className="flex flex-col gap-0.5">
      {rows.length === 0 && <p className="px-3 text-xs" style={dim}>No quests in content/quests/quests.json.</p>}
      {rows.map((r) => (
        <TreeItem
          key={r.id}
          icon="flag"
          label={r.id}
          trailing={r.after > 0 ? `after ${r.after}` : undefined}
          mono
          selected={false}
          onPick={onOpen}
          menu={[
            { label: `Open in the Quest & dialog editor`, icon: "open_in_new", run: onOpen },
            "sep",
            { label: "Rename id…", icon: "edit", run: () => rename(r.id) },
          ]}
        />
      ))}
      <p className="px-3 pt-1 font-mono text-[11px]" style={dim}>content/quests · validated as a set on every save</p>
    </div>
  );
}
