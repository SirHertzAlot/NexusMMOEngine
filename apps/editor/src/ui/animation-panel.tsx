/**
 * Animation panel (roadmap EA21), four views over the real documents:
 *
 *  - Clip map: content/animation/clips.json — the server's clip id to the
 *    animation library's clip name, plus loop and crossfade per entry.
 *  - Clips: the rig's library with where each clip is used.
 *  - Locomotion: content/animation/animations.json, the state machine the
 *    client's animator runs.
 *  - Combat: content/combat/moves.json on a tick timeline.
 *
 * Saves go through the dev host, which validates and writes nothing when it
 * refuses (animation-host.ts for the clip map, media-host.ts for the rest).
 */
import * as React from "react";
import { checkClipMap, type AnimationManifest, type ClipMap, type ClipMapEntry, type ClipMapIssue } from "@mmo-engine/art/browser";
import { getClipMap, saveClipMap } from "../animation-client.js";
import { getAudioEventNames, getRigManifest } from "../media-client.js";
import { clipUsage } from "../media-model.js";
import { animationStore, usePublishLists, type AnimationTab } from "./animation-store.js";
import { ClipBrowser, CombatTimeline, LocomotionEditor, MediaDocBar } from "./animation-views.js";
import { Button, Field, Input, NumberInput, CheckField } from "./components.js";
import { DataTable, type Column } from "./data-table.js";
import { DocBar } from "./doc-bar.js";
import { useMediaDoc } from "./use-media-doc.js";
import { useSaveTask } from "./use-save-task.js";

function issuesFor(map: ClipMap): ClipMapIssue[] {
  return checkClipMap(map);
}

const TABS: Array<[AnimationTab, string]> = [["clipmap", "Clip map"], ["clips", "Clips"], ["locomotion", "Locomotion"], ["combat", "Combat timeline"]];

export function AnimationPanel(): React.JSX.Element {
  const { tab } = animationStore.useValue();
  const anim = useMediaDoc("animation");
  const combat = useMediaDoc("combat");
  const [rigState, setRigState] = React.useState<{ rig: AnimationManifest | null; loading: boolean }>({ rig: null, loading: true });
  const [events, setEvents] = React.useState<string[]>([]);
  React.useEffect(() => {
    void getRigManifest().then((rig) => setRigState({ rig, loading: false }));
    void getAudioEventNames().then(setEvents);
  }, []);
  const { rig, loading } = rigState;

  const clipNames = React.useMemo(
    () => (rig ? rig.clips.map((c) => c.name) : [...(anim.doc && combat.doc ? clipUsage(anim.doc.locomotion, combat.doc.moves).keys() : [])].sort()),
    [rig, anim.doc, combat.doc],
  );
  usePublishLists(clipNames, (combat.doc?.moves ?? []).map((m): [number, string] => [m.id, m.name]));

  const active = tab === "combat" ? combat : anim;
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Animation views" className="flex h-9 w-fit items-center overflow-hidden rounded-full text-sm" style={{ border: "1px solid var(--m3-outline-variant)" }}>
          {TABS.map(([id, text]) => (
            <button
              key={id} role="tab" aria-selected={id === tab} onClick={() => animationStore.set((p) => ({ ...p, tab: id }))}
              className="flex h-full items-center px-4"
              style={id === tab ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
            >
              {text}
            </button>
          ))}
        </div>
        <span className="text-xs opacity-70">
          {rig ? `${rig.clips.length} clips in the rig (animations.json v${rig.version})` : loading ? "reading the rig…" : "the rig's animations.json is not on this machine"}
        </span>
      </div>
      {tab === "clipmap" && <ClipMapView />}
      {tab === "clips" && <ClipBrowser rig={rig} loading={loading} graph={anim.doc?.locomotion ?? null} moves={combat.doc?.moves ?? []} clipNames={clipNames} />}
      {(tab === "locomotion" || tab === "combat") && (
        <MediaDocBar file={tab === "combat" ? "content/combat/moves.json" : "content/animation/animations.json"} doc={active} />
      )}
      {tab === "locomotion" && anim.doc && <LocomotionEditor graph={anim.doc.locomotion} clipNames={clipNames} onChange={(locomotion) => anim.set({ ...anim.doc!, locomotion })} />}
      {tab === "combat" && combat.doc && <CombatTimeline doc={combat.doc} rig={rig} events={events} onChange={(moves) => combat.set({ ...combat.doc!, moves })} />}
      {(tab === "locomotion" || tab === "combat") && !active.doc && <p className="text-[13px] opacity-70">{active.loadError ?? "loading…"}</p>}
    </div>
  );
}

function ClipMapView(): React.JSX.Element {
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
    <div className="flex min-h-[420px] flex-1 flex-col gap-2">
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
