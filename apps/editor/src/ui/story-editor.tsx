/**
 * Story workspace: quest and dialog graph editor (roadmap EA20).
 *
 * Edits the four documents the server loads (content/quests/*.json): pick a
 * dialog or a quest on the left, edit its graph in the middle (click a node
 * to select it; properties on the right), undo across all edits, validate
 * with the server's own checks, and walk the dialog in the tester against an
 * editable mock quest state. Save writes the changed documents together,
 * only when the set has no errors.
 */

import * as React from "react";
import { checkStoryRemote, loadStory, saveStory, StorySaveError } from "../story-client.js";
import {
  addDialogNode, addReply, deleteDialogNode, dialogGraph, History, questGraph, renameDialogNode, startTest,
  type DialogDoc, type DialogReply, type DialogTest, type MockState, type QuestDoc, type QuestState, type QuestsDoc,
} from "../story-model.js";
import type { StoryFile, StoryFiles, StoryIssue } from "../story-validate.js";
import { Button, Input } from "./components.js";
import { clearDocActions, registerDocActions } from "./doc-actions.js";
import { NodeGraph } from "./node-graph.js";

const STATES: QuestState[] = ["available", "active", "ready", "done", "unavailable"];
type Sel = { kind: "dialog" | "quest"; id: string };
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const dialogsOf = (f: StoryFiles): Record<string, DialogDoc> => (f.dialogs as { dialogs: Record<string, DialogDoc> }).dialogs;
const questsOf = (f: StoryFiles): QuestsDoc => f.quests as QuestsDoc;

function setDialog(f: StoryFiles, id: string, d: DialogDoc): StoryFiles {
  return { ...f, dialogs: { ...(f.dialogs as Any), dialogs: { ...dialogsOf(f), [id]: d } } };
}
function setQuest(f: StoryFiles, id: string, q: QuestDoc): StoryFiles {
  return { ...f, quests: { ...questsOf(f), quests: { ...questsOf(f).quests, [id]: q } } };
}

const cls = "w-full rounded border border-input bg-background px-1.5 py-1 text-xs";

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function Select({ value, options, onChange, blank }: { value: string; options: string[]; onChange: (v: string) => void; blank?: string }): React.JSX.Element {
  return (
    <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
      {blank !== undefined && <option value="">{blank}</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

// ------------------------------------------------------------------ canvas

type GraphData = ReturnType<typeof dialogGraph>;

function Canvas({ graph, selected, onSelect }: { graph: GraphData; selected: string | null; onSelect: (id: string) => void }): React.JSX.Element {
  return (
    <NodeGraph
      label="Story graph"
      testId="story-graph"
      nodes={graph.nodes}
      edges={graph.edges}
      nodeId={(n) => n.id}
      nodePos={(n) => n}
      nodeSize={{ w: 190, h: 52 }}
      edgeEnds={(e) => ({ from: e.from, to: e.to })}
      height={360}
      fitKey={graph.nodes.map((n) => n.id).join("|")}
      selectedId={selected}
      onSelect={(id) => id !== null && onSelect(id)}
      renderEdge={(e, geom, arrow) => (
        <>
          <path d={geom.d} fill="none" stroke={e.condition ? "#d9a441" : "#888"} strokeWidth={1.4} markerEnd={arrow} />
          <title>{[e.label, e.condition && `if ${e.condition}`, e.effect].filter(Boolean).join(" | ")}</title>
        </>
      )}
      renderNode={(n, { selected: on }) => (
        <>
          <rect width={190} height={52} rx={8} fill={n.kind === "quest" ? "#3b3358" : "#2a3140"} stroke={on ? "#6cf" : n.reachable === false ? "#c55" : "#556"} strokeWidth={on ? 2.5 : 1.2} />
          <text x={8} y={20} fontSize={12} fill="#eee" fontWeight={n.start ? 700 : 400}>{(n.start ? "> " : "") + n.id.slice(0, 26)}</text>
          <text x={8} y={38} fontSize={10} fill="#aab">{n.reachable === false ? "unreachable" : n.title.slice(0, 30)}</text>
        </>
      )}
    />
  );
}

// -------------------------------------------------------------- properties

function ReplyEditor({ r, nodes, quests, onChange, onDelete }: { r: DialogReply; nodes: string[]; quests: string[]; onChange: (r: DialogReply) => void; onDelete: () => void }): React.JSX.Element {
  const doKind = !r.do ? "" : "accept" in r.do ? "accept" : "complete";
  const doQuest = r.do ? ("accept" in r.do ? r.do.accept : r.do.complete) : "";
  const qs = ["board", ...quests];
  return (
    <div className="flex flex-col gap-1 rounded border border-border/60 p-1.5">
      <Input value={r.text} aria-label="reply text" className="h-7 text-xs" onChange={(e) => onChange({ ...r, text: e.target.value })} />
      <div className="flex gap-1">
        <Select value={r.next ?? ""} blank="(ends the talk)" options={nodes} onChange={(v) => { const { next: _n, ...rest } = r; onChange(v ? { ...rest, next: v } : rest); }} />
        <button type="button" className="px-1 text-xs hover:text-red-400" aria-label="delete reply" onClick={onDelete}>x</button>
      </div>
      <div className="flex gap-1">
        <Select value={r.if?.quest ?? ""} blank="(always shown)" options={qs} onChange={(v) => { const { if: _i, ...rest } = r; onChange(v ? { ...rest, if: { quest: v, is: r.if?.is ?? "available" } } : rest); }} />
        {r.if && <Select value={r.if.is} options={STATES} onChange={(v) => onChange({ ...r, if: { quest: r.if!.quest, is: v as QuestState } })} />}
      </div>
      <div className="flex gap-1">
        <Select value={doKind} blank="(no effect)" options={["accept", "complete"]} onChange={(v) => { const { do: _d, ...rest } = r; onChange(v ? { ...rest, do: v === "accept" ? { accept: doQuest || qs[0] } : { complete: doQuest || qs[0] } } : rest); }} />
        {r.do && <Select value={doQuest} options={qs} onChange={(v) => onChange({ ...r, do: doKind === "accept" ? { accept: v } : { complete: v } })} />}
      </div>
    </div>
  );
}

function DialogProps({ d, node, quests, onEdit }: { d: DialogDoc; node: string; quests: string[]; onEdit: (d: DialogDoc) => void }): React.JSX.Element {
  const n = d.nodes[node];
  const [name, setName] = React.useState(node);
  React.useEffect(() => setName(node), [node]);
  if (!n) return <p className="text-xs text-muted-foreground">Select a node.</p>;
  const ids = Object.keys(d.nodes);
  const patch = (next: Partial<typeof n>): void => onEdit({ ...d, nodes: { ...d.nodes, [node]: { ...n, ...next } } });
  return (
    <div className="flex flex-col gap-2">
      <Field label="Node id">
        <div className="flex gap-1">
          <Input value={name} className="h-7 text-xs" onChange={(e) => setName(e.target.value)} onBlur={() => name !== node && /^[a-z][a-z0-9-]*$/.test(name) && onEdit(renameDialogNode(d, node, name))} />
          <Button size="sm" variant="outline" disabled={d.start === node} onClick={() => onEdit({ ...d, start: node })}>{d.start === node ? "start" : "make start"}</Button>
        </div>
      </Field>
      <Field label="Line ({name} and {board} are filled in)">
        <textarea className={cls} rows={3} value={n.text} onChange={(e) => patch({ text: e.target.value })} />
      </Field>
      <p className="text-[11px] font-semibold uppercase text-muted-foreground">Replies (max 8)</p>
      {n.replies.map((r, i) => (
        <ReplyEditor key={i} r={r} nodes={ids} quests={quests}
          onChange={(nr) => patch({ replies: n.replies.map((x, j) => (j === i ? nr : x)) })}
          onDelete={() => patch({ replies: n.replies.filter((_, j) => j !== i) })} />
      ))}
      <div className="flex gap-1">
        <Button size="sm" variant="outline" disabled={n.replies.length >= 8} onClick={() => onEdit(addReply(d, node, { text: "..." }))}>Add reply</Button>
        <Button size="sm" variant="outline" disabled={d.start === node} onClick={() => onEdit(deleteDialogNode(d, node))}>Delete node</Button>
      </div>
    </div>
  );
}

const OBJECTIVES: Record<string, Any> = {
  talk: { type: "talk", npc: "" },
  kill: { type: "kill", kind: "", count: 1 },
  reach: { type: "reach", place: "" },
  collect: { type: "collect", base: "", count: 1 },
};

function QuestProps({ q, npcs, onEdit }: { q: QuestDoc; npcs: string[]; onEdit: (q: QuestDoc) => void }): React.JSX.Element {
  const set = (p: Partial<QuestDoc>): void => onEdit({ ...q, ...p });
  return (
    <div className="flex flex-col gap-2">
      <Field label="Name"><Input value={q.name} className="h-7 text-xs" onChange={(e) => set({ name: e.target.value })} /></Field>
      <Field label="Giver"><Select value={q.giver} options={npcs} onChange={(v) => set({ giver: v })} /></Field>
      <Field label="Summary"><textarea className={cls} rows={3} value={q.summary} onChange={(e) => set({ summary: e.target.value })} /></Field>
      <Field label="After (quest ids, comma separated)"><Input value={(q.after ?? []).join(", ")} className="h-7 text-xs" onChange={(e) => set({ after: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></Field>
      <p className="text-[11px] font-semibold uppercase text-muted-foreground">Steps</p>
      {q.steps.map((s, i) => {
        const upd = (p: Partial<typeof s>): void => set({ steps: q.steps.map((x, j) => (j === i ? { ...x, ...p } : x)) });
        return (
          <div key={i} className="flex flex-col gap-1 rounded border border-border/60 p-1.5">
            <div className="flex gap-1">
              <Input value={s.id} aria-label="step id" className="h-7 w-24 text-xs" onChange={(e) => upd({ id: e.target.value })} />
              <Input value={s.text} aria-label="step text" className="h-7 text-xs" onChange={(e) => upd({ text: e.target.value })} />
              <button type="button" aria-label="delete step" className="px-1 text-xs hover:text-red-400" onClick={() => set({ steps: q.steps.filter((_, j) => j !== i) })}>x</button>
            </div>
            <div className="flex flex-wrap gap-1">
              <Select value={String(s.objective.type)} options={Object.keys(OBJECTIVES)} onChange={(t) => upd({ objective: { ...OBJECTIVES[t] } })} />
              {Object.entries(s.objective).filter(([k]) => k !== "type").map(([k, v]) => (
                <Input key={k} aria-label={k} placeholder={k} className="h-7 w-24 text-xs" value={String(v)}
                  onChange={(e) => upd({ objective: { ...s.objective, [k]: typeof v === "number" ? Number(e.target.value) : e.target.value } })} />
              ))}
            </div>
          </div>
        );
      })}
      <Button size="sm" variant="outline" onClick={() => set({ steps: [...q.steps, { id: `step-${q.steps.length + 1}`, text: "...", objective: { ...OBJECTIVES.talk, npc: q.giver } }] })}>Add step</Button>
      <Field label="Rewards (item bases, comma separated)">
        <Input value={(q.rewards ?? []).map((r) => r.base).join(", ")} className="h-7 text-xs" onChange={(e) => set({ rewards: e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map((base) => ({ base })) })} />
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------ tester

function Tester({ d, quests }: { d: DialogDoc; quests: string[] }): React.JSX.Element {
  const [mock, setMock] = React.useState<MockState>({ name: "Aria", quests: {}, board: "A board quest" });
  const [run, setRun] = React.useState<DialogTest>(() => startTest(d, mock));
  const restart = (m: MockState): void => setRun(startTest(d, m));
  React.useEffect(() => restart(mock), [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = ["board", ...quests];
  const live = run.state; // effects change the state the walk sees
  return (
    <div className="flex flex-col gap-2" data-testid="dialog-tester">
      <p className="text-[11px] font-semibold uppercase text-muted-foreground">Mock quest state</p>
      <div className="grid grid-cols-2 gap-1">
        {keys.map((k) => (
          <React.Fragment key={k}>
            <span className="truncate self-center text-[11px]">{k}</span>
            <Select value={live.quests[k] ?? "unavailable"} options={STATES} onChange={(v) => { const m = { ...live, quests: { ...live.quests, [k]: v as QuestState } }; setMock(m); setRun(run.withState(m)); }} />
          </React.Fragment>
        ))}
      </div>
      <div className="rounded bg-muted/40 p-2 text-xs">
        <p className="text-[10px] text-muted-foreground">{run.node}{run.ended ? " (talk ended)" : ""}</p>
        <p>{run.text}</p>
      </div>
      {run.replies.map((r, i) => (
        <button key={i} type="button" disabled={!r.available || run.ended} title={r.why} onClick={() => setRun(run.pick(i))}
          className="rounded border border-border/60 px-2 py-1 text-left text-xs enabled:hover:bg-accent disabled:opacity-40">
          {r.text}
          {(r.condition || r.effect) && <span className="block text-[10px] text-muted-foreground">{[r.condition && `if ${r.condition}`, r.effect].filter(Boolean).join(" | ")}{r.why ? ` (hidden: ${r.why})` : ""}</span>}
        </button>
      ))}
      {run.effects.length > 0 && <p className="text-[11px]">Effects: {run.effects.join(", ")}</p>}
      <Button size="sm" variant="outline" onClick={() => restart(mock)}>Restart from the start node</Button>
    </div>
  );
}

// ------------------------------------------------------------------- panel

export function StoryEditorPanel(): React.JSX.Element {
  const [saved, setSaved] = React.useState<StoryFiles | null>(null);
  const history = React.useRef<History<StoryFiles> | null>(null);
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  const [sel, setSel] = React.useState<Sel | null>(null);
  const [node, setNode] = React.useState<string | null>(null);
  const [issues, setIssues] = React.useState<StoryIssue[]>([]);
  const [msg, setMsg] = React.useState("");
  const [tab, setTab] = React.useState<"props" | "test">("props");

  const load = React.useCallback(async () => {
    try {
      const { files } = await loadStory();
      history.current = new History(files);
      setSaved(files);
      setSel((s) => s ?? { kind: "dialog", id: Object.keys(dialogsOf(files))[0] });
      setMsg("");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);
  React.useEffect(() => void load(), [load]);

  const files = history.current?.value ?? null;
  const dirty = files !== null && saved !== null && JSON.stringify(files) !== JSON.stringify(saved);

  // Validate (debounced) as the set changes.
  React.useEffect(() => {
    if (!files) return;
    const t = setTimeout(() => checkStoryRemote(files).then(setIssues, (e: Error) => setMsg(e.message)), 350);
    return () => clearTimeout(t);
  }, [files]);

  // Toolbar Save/Undo/Redo target once the documents load.
  React.useEffect(() => {
    if (!files || !sel || !history.current) return;
    const h = history.current;
    const snapshot = JSON.stringify(files);
    const target = {
      label: "story files",
      canSave: saved !== null && snapshot !== JSON.stringify(saved),
      canUndo: h.canUndo,
      canRedo: h.canRedo,
      save: () => void save(),
      undo: () => {
        h.undo();
        bump();
      },
      redo: () => {
        h.redo();
        bump();
      },
    };
    registerDocActions(target);
    return () => clearDocActions(target);
  });

  if (!files || !sel) {
    if (!msg) return <div className="p-3 text-xs text-muted-foreground">Loading quests and dialog...</div>;
    return (
      <div className="flex flex-col items-start gap-2 p-3 text-xs text-muted-foreground" data-testid="story-editor">
        <p>Story: {msg}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  const h = history.current!;
  const edit = (next: StoryFiles): void => { h.push(next); bump(); };
  const dialogs = dialogsOf(files);
  const quests = questsOf(files).quests;
  const questIds = Object.keys(quests);
  const npcIds = Object.keys((files.npcs as { npcs: Record<string, unknown> }).npcs);
  const dialog = sel.kind === "dialog" ? dialogs[sel.id] : null;
  const quest = sel.kind === "quest" ? quests[sel.id] : null;
  const graph = dialog ? dialogGraph(dialog) : questGraph(questsOf(files));
  const errors = issues.filter((i) => i.severity === "error");

  const save = async (): Promise<void> => {
    const changes: Partial<StoryFiles> = {};
    for (const f of Object.keys(files) as StoryFile[]) if (JSON.stringify(files[f]) !== JSON.stringify(saved![f])) changes[f] = files[f];
    try {
      const warnings = await saveStory(changes);
      setSaved(files);
      setIssues(warnings);
      setMsg(`Saved ${Object.keys(changes).join(", ")}`);
    } catch (e) {
      if (e instanceof StorySaveError) { setIssues(e.issues); setMsg("Not saved: fix the errors listed"); } else setMsg((e as Error).message);
    }
  };

  const addDialog = (): void => {
    let n = 1;
    while (dialogs[`dialog-${n}`]) n++;
    const id = `dialog-${n}`;
    edit(setDialog(files, id, { start: "start", nodes: { start: { text: "Hello, {name}.", replies: [{ text: "Farewell." }] } } }));
    setSel({ kind: "dialog", id });
    setNode("start");
  };
  const addQuest = (): void => {
    let n = 1;
    while (quests[`quest-${n}`]) n++;
    const id = `quest-${n}`;
    edit(setQuest(files, id, { name: "New quest", giver: npcIds[0], summary: "...", steps: [{ id: "talk", text: "Speak with the giver.", objective: { type: "talk", npc: npcIds[0] } }] }));
    setSel({ kind: "quest", id });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-testid="story-editor">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!h.canUndo} onClick={() => { h.undo(); bump(); }}>Undo</Button>
        <Button size="sm" variant="outline" disabled={!h.canRedo} onClick={() => { h.redo(); bump(); }}>Redo</Button>
        <Button size="sm" disabled={!dirty || errors.length > 0} onClick={() => void save()}>Save</Button>
        <Button size="sm" variant="outline" onClick={() => void load()}>Reload</Button>
        <span className="text-xs">{errors.length} error(s), {issues.length - errors.length} warning(s){dirty ? " | unsaved changes" : ""}</span>
        <span className="text-xs text-muted-foreground">{msg}</span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[170px_1fr_320px] gap-2">
        <div className="flex flex-col gap-1 overflow-auto text-xs">
          <p className="font-semibold uppercase text-muted-foreground">Dialogs</p>
          {Object.keys(dialogs).map((id) => (
            <button key={id} type="button" className={`rounded px-2 py-1 text-left ${sel.kind === "dialog" && sel.id === id ? "bg-accent" : "hover:bg-accent/50"}`} onClick={() => { setSel({ kind: "dialog", id }); setNode(dialogs[id].start); }}>{id}</button>
          ))}
          <Button size="sm" variant="outline" onClick={addDialog}>New dialog</Button>
          <p className="mt-2 font-semibold uppercase text-muted-foreground">Quests</p>
          {questIds.map((id) => (
            <button key={id} type="button" className={`rounded px-2 py-1 text-left ${sel.kind === "quest" && sel.id === id ? "bg-accent" : "hover:bg-accent/50"}`} onClick={() => setSel({ kind: "quest", id })}>{id}</button>
          ))}
          <Button size="sm" variant="outline" onClick={addQuest}>New quest</Button>
        </div>
        <div className="min-h-0 overflow-auto">
          <Canvas graph={graph} selected={sel.kind === "dialog" ? node : sel.id}
            onSelect={(id) => { if (sel.kind === "dialog") setNode(id); else setSel({ kind: "quest", id: id.split("/")[0] }); }} />
          {dialog && <Button size="sm" variant="outline" className="mt-2" onClick={() => { let n = 1; while (dialog.nodes[`node-${n}`]) n++; edit(setDialog(files, sel.id, addDialogNode(dialog, `node-${n}`))); setNode(`node-${n}`); }}>Add node</Button>}
          <ul className="mt-2 text-xs" aria-label="issues">
            {issues.map((i, k) => (
              <li key={k} className={i.severity === "error" ? "text-red-400" : "text-amber-400"}>{i.severity}: {i.file}{i.path ? `.${i.path}` : ""}: {i.message}</li>
            ))}
          </ul>
        </div>
        <div className="min-h-0 overflow-auto">
          <div className="mb-2 flex gap-1">
            <Button size="sm" variant={tab === "props" ? "default" : "outline"} onClick={() => setTab("props")}>Properties</Button>
            <Button size="sm" variant={tab === "test" ? "default" : "outline"} disabled={!dialog} onClick={() => setTab("test")}>Dialog tester</Button>
          </div>
          {tab === "test" && dialog ? (
            <Tester d={dialog} quests={questIds} />
          ) : dialog ? (
            <DialogProps d={dialog} node={node && dialog.nodes[node] ? node : dialog.start} quests={questIds} onEdit={(nd) => edit(setDialog(files, sel.id, nd))} />
          ) : quest ? (
            <QuestProps q={quest} npcs={npcIds} onEdit={(nq) => edit(setQuest(files, sel.id, nq))} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
