/**
 * Animation panel (roadmap EA21): browse and edit the clip map of
 * content/animation/clips.json — the server's clip id to the animation
 * library's clip name, plus loop and crossfade per entry. Save goes
 * through the dev host, which validates with art's checkClipMap and
 * writes nothing when refused.
 */
import * as React from "react";
import { checkClipMap, type ClipMap, type ClipMapEntry, type ClipMapIssue } from "@mmo-engine/art";
import { getClipMap, saveClipMap } from "../animation-client.js";
import { Button, Field, Input, NumberInput, CheckField } from "./components.js";
import { DataTable, type Column } from "./data-table.js";
import { DocBar } from "./doc-bar.js";
import { useSaveTask } from "./use-save-task.js";

function issuesFor(map: ClipMap): ClipMapIssue[] {
  return checkClipMap(map);
}

export function AnimationPanel(): React.JSX.Element {
  const [map, setMap] = React.useState<ClipMap | null>(null);
  const [saved, setSaved] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const task = useSaveTask();

  const load = React.useCallback((): void => {
    setLoadError(null);
    getClipMap().then(
      ({ map: m }) => {
        setMap(m);
        setSaved(JSON.stringify(m));
        setSelected((cur) => (cur !== null && m.clips.some((c) => String(c.id) === cur) ? cur : (m.clips[0] ? String(m.clips[0].id) : null)));
        task.clear();
      },
      (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(load, [load]);

  const dirty = map !== null && JSON.stringify(map) !== saved;
  const issues = map ? issuesFor(map) : [];
  const errors = issues.filter((i) => i.severity === "error");

  const save = React.useCallback((): void => {
    if (!map || errors.length > 0) return;
    void task.run(() => saveClipMap(map).then(() => setSaved(JSON.stringify(map))), {
      ok: "saved to content/animation/clips.json",
    });
  }, [map, errors.length, task]);

  const patchEntry = (id: number, patch: Partial<ClipMapEntry>): void => {
    setMap((m) => (m ? { ...m, clips: m.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : m));
  };

  const addEntry = (): void => {
    setMap((m) => {
      if (!m) return m;
      const nextId = m.clips.reduce((n, c) => Math.max(n, c.id), 0) + 1;
      return { ...m, clips: [...m.clips, { id: nextId, name: `clip-${nextId}`, clip: "", loop: true, fade: 0.2 }] };
    });
  };

  const removeEntry = (id: number): void => {
    setMap((m) => (m ? { ...m, clips: m.clips.filter((c) => c.id !== id) } : m));
    setSelected((cur) => (cur === String(id) ? null : cur));
  };

  const columns: Array<Column<ClipMapEntry>> = [
    { id: "id", header: "ID", width: "48px", cell: (c) => String(c.id) },
    { id: "name", header: "Name", cell: (c) => c.name },
    { id: "clip", header: "Library clip", cell: (c) => c.clip || <em className="opacity-60">—</em> },
    { id: "loop", header: "Loop", width: "56px", cell: (c) => (c.loop ? "yes" : "no") },
    { id: "fade", header: "Fade (s)", width: "64px", cell: (c) => c.fade.toFixed(2) },
  ];

  const sel = map?.clips.find((c) => String(c.id) === selected) ?? null;

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <DocBar dirty={dirty} busy={task.busy} onSave={save} onRevert={load} />
      {loadError && <div className="text-sm text-red-400">Failed to load: {loadError}</div>}
      {errors.length > 0 && (
        <div className="text-sm text-red-400">
          {errors.map((e, i) => (
            <div key={i}>{e.message}</div>
          ))}
        </div>
      )}
      <div className="flex flex-1 gap-2 overflow-hidden">
        <div className="flex w-2/3 flex-col gap-2 overflow-hidden">
          <DataTable
            columns={columns}
            rows={map?.clips ?? []}
            rowKey={(c) => String(c.id)}
            selected={selected}
            onPick={(c) => setSelected(String(c.id))}
          />
          <div className="flex gap-2">
            <Button onClick={addEntry}>Add clip</Button>
            {selected !== null && (
              <Button variant="danger" onClick={() => removeEntry(Number(selected))}>
                Remove
              </Button>
            )}
          </div>
        </div>
        <div className="w-1/3 overflow-y-auto">
          {sel ? (
            <div className="flex flex-col gap-2">
              <Field label="Name">
                <Input value={sel.name} onChange={(e) => patchEntry(sel.id, { name: e.target.value })} />
              </Field>
              <Field label="Library clip">
                <Input value={sel.clip} onChange={(e) => patchEntry(sel.id, { clip: e.target.value })} placeholder="Idle_Loop" />
              </Field>
              <CheckField label="Loop" checked={sel.loop} onChange={(v) => patchEntry(sel.id, { loop: v })} />
              <Field label="Fade (seconds)">
                <NumberInput value={sel.fade} min={0} max={2} step={0.05} onChange={(v) => patchEntry(sel.id, { fade: v })} />
              </Field>
              <div className="text-xs opacity-60">
                ID {sel.id} — the server's clip id. The library clip is the name in animations.json.
              </div>
            </div>
          ) : (
            <div className="text-sm opacity-60">Select a clip to edit.</div>
          )}
        </div>
      </div>
    </div>
  );
}
