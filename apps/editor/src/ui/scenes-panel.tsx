/**
 * Scenes workspace (roadmap EA4): open a scene from content/scenes, edit
 * its node tree (Outliner) and the selected node's fields and components
 * (Details), undo and redo, save and reload. Saves go through the host,
 * which validates and refuses (writing nothing) with every problem by path.
 */

import * as React from "react";
import {
  COMPONENTS,
  History,
  NODE_KINDS,
  SCENE_KINDS,
  addComponent,
  addNode,
  emptyScene,
  findNode,
  moveNode,
  removeComponent,
  removeNode,
  setComponentField,
  setNodeProp,
  setTransform,
  validateScene,
  type FieldSpec,
  type SceneIssue,
  type SceneKind,
  type SceneNode,
  type Vec3,
} from "@mmo-engine/scene";
import { SceneSaveError, getScene, listScenes, saveScene } from "../scenes-client.js";
import { Button, Input, Label, SectionTitle } from "./components.js";

const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";

/** Scene names become file names: lowercase letters, digits and dashes, starting with a letter or digit. */
export const SCENE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Whether a prompted scene name may replace the document. */
export function isValidSceneName(name: string): boolean {
  return SCENE_NAME_RE.test(name);
}

/** Flatten the tree for display, keeping depth. */
function rows(list: SceneNode[], depth = 0): Array<{ node: SceneNode; depth: number }> {
  return list.flatMap((n) => [{ node: n, depth }, ...rows(n.children ?? [], depth + 1)]);
}

function nextId(doc: { nodes: SceneNode[] }, base: string): string {
  const used = new Set(rows(doc.nodes).map((r) => r.node.id));
  for (let i = 1; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

function FieldInput({ spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void }): React.JSX.Element {
  if (spec.type === "boolean") {
    return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (spec.type === "enum") {
    return (
      <select className={sel} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {spec.options.map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  }
  if (spec.type === "number") {
    return <Input type="number" className="h-9" value={Number.isFinite(value) ? String(value) : ""} onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))} />;
  }
  return <Input className="h-9" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
}

export function ScenesPanel(): React.JSX.Element {
  const [hist] = React.useState(() => new History(emptyScene("untitled", "arena")));
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  const [names, setNames] = React.useState<string[]>([]);
  const [open, setOpen] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [issues, setIssues] = React.useState<SceneIssue[]>([]);
  const [status, setStatus] = React.useState("");
  const doc = hist.doc;
  const node = selected ? findNode(doc, selected) : undefined;

  const run = (label: string, fn: Parameters<History["apply"]>[1]): void => {
    try {
      hist.apply(label, fn);
      setIssues(validateScene(hist.doc));
      setStatus("");
    } catch (e) {
      setStatus((e as Error).message);
    }
    bump();
  };
  const refresh = (): void => void listScenes().then(setNames, (e: Error) => setStatus(e.message));
  React.useEffect(refresh, []);

  const load = (name: string): void => {
    getScene(name).then(
      (d) => {
        hist.replace(d);
        setOpen(name);
        setSelected(null);
        setIssues(validateScene(d));
        setStatus(`opened ${name}`);
        bump();
      },
      (e: Error) => setStatus(e.message),
    );
  };
  const save = (): void => {
    if (!open) return;
    saveScene(open, doc).then(
      () => {
        hist.markSaved();
        setIssues([]);
        setStatus(`saved ${open}`);
        bump();
        refresh();
      },
      (e: Error) => {
        if (e instanceof SceneSaveError) setIssues(e.issues);
        setStatus(`${e.message} - nothing was written`);
      },
    );
  };
  const create = (): void => {
    const name = window.prompt("New scene name (lowercase, digits, dashes): ^[a-z0-9][a-z0-9-]*$");
    if (!name) return;
    if (!isValidSceneName(name)) {
      setStatus(`invalid scene name "${name}": use ^[a-z0-9][a-z0-9-]*$ (lowercase letters, digits and dashes, starting with a letter or digit) - nothing was created`);
      return;
    }
    hist.replace(emptyScene(name, "arena"));
    setOpen(name);
    setSelected(null);
    setIssues(validateScene(hist.doc));
    bump();
  };

  const setVec = (key: "position" | "rotation" | "scale", i: number, v: number): void => {
    if (!node) return;
    const cur: Vec3 = [...(node.transform?.[key] ?? (key === "scale" ? [1, 1, 1] : [0, 0, 0]))] as Vec3;
    cur[i] = v;
    run("transform", (d) => setTransform(d, node.id, { [key]: cur }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2.5 text-[13px]" data-testid="scenes-panel">
      <div className="flex flex-wrap items-center gap-2">
        <select className={sel} value={open ?? ""} onChange={(e) => e.target.value && load(e.target.value)} aria-label="Open scene">
          <option value="">{names.length ? "Open scene…" : "No scenes yet"}</option>
          {names.map((n) => <option key={n}>{n}</option>)}
        </select>
        <Button size="sm" variant="outline" onClick={create}>New</Button>
        <Button size="sm" disabled={!open} onClick={save}>Save{hist.dirty ? " *" : ""}</Button>
        <Button size="sm" variant="outline" disabled={!open} onClick={() => open && load(open)}>Reload</Button>
        <Button size="sm" variant="outline" disabled={!hist.canUndo} onClick={() => { hist.undo(); setIssues(validateScene(hist.doc)); bump(); }}>Undo</Button>
        <Button size="sm" variant="outline" disabled={!hist.canRedo} onClick={() => { hist.redo(); setIssues(validateScene(hist.doc)); bump(); }}>Redo</Button>
        <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{status}</span>
      </div>
      {issues.length > 0 && (
        <ul className="rounded-md border border-border p-2 text-xs text-red-500" role="alert">
          {issues.map((i, k) => <li key={k}><code>{i.path || "(scene)"}</code>: {i.message}</li>)}
        </ul>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(180px,1fr)_minmax(260px,2fr)] gap-3">
        <section className="m3-scroll min-h-0 overflow-auto" aria-label="Outliner">
          <SectionTitle>Outliner</SectionTitle>
          <div className="mb-2 flex gap-1">
            <Button size="sm" variant="outline" disabled={!open} onClick={() => {
              const id = nextId(doc, "node");
              run("add node", (d) => addNode(d, selected, { id, kind: "group" }));
              setSelected(id);
            }}>Add child</Button>
            <Button size="sm" variant="outline" disabled={!node} onClick={() => {
              if (!node) return;
              run("delete node", (d) => removeNode(d, node.id));
              setSelected(null);
            }}>Delete</Button>
            <Button size="sm" variant="outline" disabled={!node} onClick={() => node && run("move to root", (d) => moveNode(d, node.id, null))}>To root</Button>
          </div>
          {rows(doc.nodes).map(({ node: n, depth }) => (
            <div
              key={n.id}
              role="treeitem"
              aria-selected={n.id === selected}
              tabIndex={0}
              onClick={() => setSelected(n.id)}
              onKeyDown={(e) => e.key === "Enter" && setSelected(n.id)}
              className="cursor-pointer rounded px-2 py-1"
              style={{ paddingLeft: 8 + depth * 14, background: n.id === selected ? "var(--m3-secondary-container)" : undefined }}
            >
              {n.name || n.id} <span className="text-xs opacity-60">{n.prefab ?? n.kind ?? "group"}</span>
            </div>
          ))}
          {open && doc.nodes.length === 0 && <p className="text-xs opacity-70">Empty scene. Add a node.</p>}
        </section>
        <section className="m3-scroll min-h-0 overflow-auto" aria-label="Details">
          <SectionTitle>Details</SectionTitle>
          {!node ? (
            open ? (
              <div className="flex flex-col gap-2">
                <Label>Scene kind</Label>
                <select className={sel} value={doc.kind} onChange={(e) => run("scene kind", (d) => ({ ...d, kind: e.target.value as SceneKind }))}>
                  {SCENE_KINDS.map((k) => <option key={k}>{k}</option>)}
                </select>
                <Button size="sm" variant="outline" onClick={() => {
                  const id = nextId(doc, "node");
                  run("add node", (d) => addNode(d, null, { id, kind: "group" }));
                  setSelected(id);
                }}>Add root node</Button>
              </div>
            ) : <p className="text-xs opacity-70">Open or create a scene.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <Label>Id</Label>
              <Input className="h-9" value={node.id} readOnly />
              <Label>Name</Label>
              <Input className="h-9" value={node.name ?? ""} onChange={(e) => run("rename", (d) => setNodeProp(d, node.id, "name", e.target.value))} />
              <Label>Kind</Label>
              <select className={sel} value={node.kind ?? "group"} onChange={(e) => run("kind", (d) => setNodeProp(d, node.id, "kind", e.target.value))}>
                {NODE_KINDS.map((k) => <option key={k}>{k}</option>)}
              </select>
              <Label>Prefab</Label>
              <Input className="h-9" value={node.prefab ?? ""} placeholder="e.g. camps/goblin" onChange={(e) => run("prefab", (d) => setNodeProp(d, node.id, "prefab", e.target.value))} />
              {(["position", "rotation", "scale"] as const).map((key) => (
                <div key={key}>
                  <Label>{key}</Label>
                  <div className="grid grid-cols-3 gap-1">
                    {[0, 1, 2].map((i) => (
                      <Input key={i} type="number" className="h-9" aria-label={`${key} ${"xyz"[i]}`}
                        value={String((node.transform?.[key] ?? (key === "scale" ? [1, 1, 1] : [0, 0, 0]))[i])}
                        onChange={(e) => Number.isFinite(Number(e.target.value)) && setVec(key, i, Number(e.target.value))} />
                    ))}
                  </div>
                </div>
              ))}
              <SectionTitle>Components</SectionTitle>
              {Object.entries(node.components ?? {}).map(([cn, props]) => (
                <div key={cn} className="rounded-md border border-border p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <strong>{COMPONENTS[cn]?.label ?? cn}</strong>
                    <Button size="sm" variant="outline" onClick={() => run("remove component", (d) => removeComponent(d, node.id, cn))}>Remove</Button>
                  </div>
                  {Object.entries(COMPONENTS[cn]?.fields ?? {}).map(([fn, spec]) => (
                    <div key={fn} className="mb-1">
                      <Label>{fn}</Label>
                      <FieldInput spec={spec} value={props[fn]} onChange={(v) => run("edit component", (d) => setComponentField(d, node.id, cn, fn, v))} />
                    </div>
                  ))}
                </div>
              ))}
              <select className={sel} value="" aria-label="Add component" onChange={(e) => e.target.value && run("add component", (d) => addComponent(d, node.id, e.target.value))}>
                <option value="">Add component…</option>
                {Object.keys(COMPONENTS).filter((c) => !node.components?.[c]).map((c) => <option key={c} value={c}>{COMPONENTS[c].label}</option>)}
              </select>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
