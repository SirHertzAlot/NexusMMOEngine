/**
 * PICG Graphs tab (ROADMAP E7) — the hierarchical graph editor's panels.
 *
 * Presentation only: inspectors/graph-editor.ts holds the documents, the
 * breadcrumb, undo and the view-model; this file draws them. The canvas
 * is plain SVG: drag a node to move it, drag the background to pan, wheel
 * to zoom, double-click a subgraph node to enter it, the breadcrumb to
 * climb out. The side panel edits the selected node's properties and the
 * graph's parameter defaults; Save sends every edited document to the dev
 * host, which refuses one that would break a cook (with the issues).
 */

import * as React from "react";
import { edgePath, GraphEditor, parseFieldValue, type GraphDocument, type GraphViewModel, type NodeView, type PropertyView } from "../inspectors/graph-editor.js";
import type { PcgDocumentInfo, PcgIssue } from "../pcg-host.js";
import { pastDragThreshold } from "./drag-threshold.js";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, SectionTitle } from "./components.js";
import { editorSelection } from "./editor-selection.js";

const NODE_W = 168;
const NODE_H = 52;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { body });
  return body;
}

export function GraphEditorPanel(): React.JSX.Element {
  const [docs, setDocs] = React.useState<PcgDocumentInfo[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [issues, setIssues] = React.useState<Array<PcgIssue & { file: string }>>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [editor, setEditor] = React.useState<GraphEditor | null>(null);
  const [, bump] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    getJson<{ docs: PcgDocumentInfo[] }>("/api/editor/pcg/docs")
      .then(({ docs }) => {
        setDocs(docs);
        const ed = new GraphEditor(new Map(docs.filter((d) => d.kind === "subgraph" && d.guid).map((d) => [d.guid!, d.file])));
        setEditor(ed);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  React.useEffect(() => editor?.subscribe(bump), [editor]);

  const fetchDoc = React.useCallback(async (file: string) => {
    const { info, doc } = await getJson<{ info: PcgDocumentInfo; doc: GraphDocument }>(`/api/editor/pcg/doc?file=${encodeURIComponent(file)}`);
    return { info, doc };
  }, []);

  const open = async (file: string): Promise<void> => {
    if (!editor) return;
    setError(null);
    try {
      const { info, doc } = await fetchDoc(file);
      editor.open(file, info.kind, doc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const enter = async (nodeId: string): Promise<void> => {
    if (!editor) return;
    const need = editor.enter(nodeId);
    if (!need) return;
    try {
      const { info, doc } = await fetchDoc(need.needs);
      editor.load(need.needs, info.kind, doc);
      editor.enter(nodeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async (): Promise<void> => {
    if (!editor) return;
    setIssues([]);
    setNotice(null);
    const found: Array<PcgIssue & { file: string }> = [];
    let saved = 0;
    for (const { file, doc } of editor.pendingSaves()) {
      try {
        await getJson(`/api/editor/pcg/doc`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, doc }) });
        editor.markSaved(file);
        saved++;
      } catch (e) {
        const body = (e as { body?: { issues?: PcgIssue[] } }).body;
        for (const i of body?.issues ?? [{ path: file, message: e instanceof Error ? e.message : String(e) }]) found.push({ ...i, file });
      }
    }
    setIssues(found);
    setNotice(found.length ? null : `saved ${saved} document${saved === 1 ? "" : "s"}; a play-mode server picks them up when it next starts`);
  };

  const vm = editor?.viewModel() ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr_320px]" data-testid="graph-editor">
      <Card>
        <CardHeader>
          <CardTitle>PICG library</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {(["graph", "subgraph"] as const).map((kind) => (
            <div key={kind}>
              <SectionTitle>{kind === "graph" ? "Asset graphs" : "Parts"}</SectionTitle>
              <ul className="mt-1 space-y-0.5">
                {docs
                  .filter((d) => d.kind === kind)
                  .map((d) => (
                    <li key={d.file}>
                      <button
                        className={
                          "w-full rounded px-2 py-1 text-left hover:bg-accent " + (vm?.crumbs.length && editor?.current?.file === d.file ? "bg-accent" : "")
                        }
                        onClick={() => void open(d.file)}
                        title={d.file}
                      >
                        {d.name}
                        {vm?.dirtyFiles.includes(d.file) && <span className="ml-1 text-amber-300">●</span>}
                        <span className="block font-mono text-[10px] text-muted-foreground">{d.file}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Breadcrumb vm={vm} onUp={(d) => editor?.up(d)} />
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => editor?.undo()} disabled={!vm?.canUndo}>
                Undo
              </Button>
              <Button size="sm" variant="outline" onClick={() => editor?.redo()} disabled={!vm?.canRedo}>
                Redo
              </Button>
              <Button size="sm" variant="outline" onClick={() => vm && editor?.revert(vm.file)} disabled={!vm?.dirty}>
                Revert
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={!vm?.dirtyFiles.length}>
                Save{vm?.dirtyFiles.length ? ` (${vm.dirtyFiles.length})` : ""}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {vm && vm.crumbs.length ? (
            <GraphCanvas vm={vm} editor={editor!} onEnter={(id) => void enter(id)} />
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground">Open a graph or a part from the library.</p>
          )}
          {notice && <p className="mt-2 text-xs text-emerald-300">{notice}</p>}
          {issues.length > 0 && (
            <div className="mt-2 rounded-md border border-red-900 bg-red-950/40 p-2 text-xs text-red-200" data-testid="graph-issues">
              <p className="font-semibold">Not saved: the cook would fail.</p>
              <ul className="mt-1 space-y-0.5 font-mono">
                {issues.map((i, n) => (
                  <li key={n}>
                    {i.file} · {i.path}: {i.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{vm?.selected ? vm.selected.node.title : "Details"}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-xs">
          {vm?.selected ? (
            <div data-testid="node-details">
              <p className="mb-2 text-muted-foreground">
                <span className="font-mono">{vm.selected.node.id}</span> · {vm.selected.node.type}
                {vm.selected.node.enter && <> · double-click to open</>}
              </p>
              {vm.selected.properties.length === 0 && <p className="text-muted-foreground">No properties.</p>}
              {vm.selected.properties.map((p) => (
                <FieldRow
                  key={`${vm.file}:${vm.selected!.node.id}:${p.key}`}
                  label={p.key}
                  editor={p.editor}
                  value={p.value}
                  onCommit={(value) => editor?.apply({ kind: "setData", node: vm.selected!.node.id, key: p.key, value })}
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">Click a node to see its properties.</p>
          )}
          {vm && vm.parameters.length > 0 && (
            <div>
              <SectionTitle>Graph parameters</SectionTitle>
              {vm.parameters.map((p) => (
                <FieldRow
                  key={`${vm.file}:param:${p.id}`}
                  label={p.name}
                  hint={`${p.target}${p.range ? ` · ${p.range[0]} – ${p.range[1]}` : ""}`}
                  editor={p.editor}
                  value={p.value}
                  onCommit={(value) => editor?.apply({ kind: "setParameterDefault", parameter: p.id, value })}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Breadcrumb({ vm, onUp }: { vm: GraphViewModel | null; onUp: (depth: number) => void }): React.JSX.Element {
  if (!vm || vm.crumbs.length === 0) return <CardTitle>Graph</CardTitle>;
  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Graph hierarchy" data-testid="graph-breadcrumb">
      {vm.crumbs.map((c, i) => (
        <React.Fragment key={c.depth}>
          {i > 0 && <span className="text-muted-foreground">›</span>}
          {i < vm.crumbs.length - 1 ? (
            <button className="text-sky-300 hover:underline" onClick={() => onUp(c.depth)}>
              {c.label}
            </button>
          ) : (
            <span className="font-semibold">{c.label}</span>
          )}
        </React.Fragment>
      ))}
      <Badge tone={vm.kind === "graph" ? "info" : "default"}>{vm.kind === "graph" ? "asset graph" : "part"}</Badge>
      {vm.dirty && <Badge tone="warn">edited</Badge>}
    </nav>
  );
}

/** One editable field: commits on Enter or blur; a bad value shows in red and isn't applied. */
function FieldRow({
  label,
  hint,
  editor,
  value,
  onCommit,
}: {
  label: string;
  hint?: string;
  editor: PropertyView["editor"];
  value: unknown;
  onCommit: (value: unknown) => void;
}): React.JSX.Element {
  const shown = editor === "json" ? JSON.stringify(value) : String(value);
  const [text, setText] = React.useState(shown);
  const [bad, setBad] = React.useState(false);
  React.useEffect(() => {
    setText(shown);
    setBad(false);
  }, [shown]);
  const commit = (t: string): void => {
    try {
      const v = parseFieldValue(editor, t);
      setBad(false);
      if (JSON.stringify(v) !== JSON.stringify(value)) onCommit(v);
    } catch {
      setBad(true);
    }
  };
  return (
    <label className="mt-1.5 block">
      <span className="flex justify-between gap-2 text-muted-foreground">
        <span className="font-mono">{label}</span>
        {hint && <span className="truncate">{hint}</span>}
      </span>
      {editor === "boolean" ? (
        <input type="checkbox" checked={value === true} onChange={(e) => onCommit(e.target.checked)} />
      ) : editor === "json" || (editor === "text" && shown.length > 40) ? (
        <textarea
          className={"mt-0.5 w-full rounded border bg-background px-1.5 py-1 font-mono " + (bad ? "border-red-500" : "border-input")}
          rows={Math.min(6, Math.max(2, Math.ceil(text.length / 38)))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
        />
      ) : (
        <input
          className={"mt-0.5 w-full rounded border bg-background px-1.5 py-1 font-mono " + (bad ? "border-red-500" : "border-input")}
          value={text}
          inputMode={editor === "number" ? "decimal" : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commit((e.target as HTMLInputElement).value)}
        />
      )}
    </label>
  );
}

function pinX(node: NodeView, pins: string[], pin: string): number {
  const i = Math.max(0, pins.indexOf(pin));
  return node.x + ((i + 1) * NODE_W) / (pins.length + 1);
}

/** The SVG canvas: nodes, edges, pan, zoom, drag. */
function GraphCanvas({ vm, editor, onEnter }: { vm: GraphViewModel; editor: GraphEditor; onEnter: (id: string) => void }): React.JSX.Element {
  const svg = React.useRef<SVGSVGElement>(null);
  const [view, setView] = React.useState({ x: -60, y: -60, scale: 1 });
  const drag = React.useRef<{ kind: "pan" | "node"; id?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);

  // Fit the level when it changes (another document or definition).
  const levelKey = `${vm.file}|${vm.title}`;
  React.useEffect(() => {
    if (vm.nodes.length === 0) return;
    const minX = Math.min(...vm.nodes.map((n) => n.x));
    const minY = Math.min(...vm.nodes.map((n) => n.y));
    setView({ x: minX - 80, y: minY - 60, scale: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelKey]);

  const toWorld = (e: React.PointerEvent | React.WheelEvent): { x: number; y: number } => {
    const r = svg.current!.getBoundingClientRect();
    return { x: view.x + (e.clientX - r.left) / view.scale, y: view.y + (e.clientY - r.top) / view.scale };
  };
  const byId = new Map(vm.nodes.map((n) => [n.id, n]));

  return (
    <svg
      ref={svg}
      className="h-[60vh] min-h-[420px] w-full cursor-grab touch-none select-none rounded-md border border-border bg-[#0b1220]"
      data-testid="graph-canvas"
      viewBox={`${view.x} ${view.y} ${(svg.current?.clientWidth ?? 800) / view.scale} ${(svg.current?.clientHeight ?? 500) / view.scale}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
        (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
        editor.select(null);
        const cur = editorSelection.get();
        if (cur && cur.kind === "graph-node") editorSelection.clear();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (!pastDragThreshold(d.sx, d.sy, e.clientX, e.clientY)) return;
        const dx = (e.clientX - d.sx) / view.scale;
        const dy = (e.clientY - d.sy) / view.scale;
        if (d.kind === "pan") setView((v) => ({ ...v, x: d.ox - dx, y: d.oy - dy }));
        else if (d.id) editor.apply({ kind: "move", node: d.id, x: d.ox + dx, y: d.oy + dy });
      }}
      onPointerUp={() => {
        if (drag.current?.kind === "node") editor.endMove();
        drag.current = null;
      }}
      onWheel={(e) => {
        const p = toWorld(e);
        const scale = Math.min(2.5, Math.max(0.3, view.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        const k = view.scale / scale;
        setView({ scale, x: p.x - (p.x - view.x) * k, y: p.y - (p.y - view.y) * k });
      }}
    >
      <defs>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x={view.x - 4000} y={view.y - 4000} width="12000" height="12000" fill="url(#grid)" />
      {vm.edges.map((e) => {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        if (!s || !t) return null;
        return (
          <path
            key={e.id}
            d={edgePath(pinX(s, s.outputs, e.sourcePin), s.y + NODE_H, pinX(t, t.inputs, e.targetPin), t.y)}
            fill="none"
            stroke="#38bdf8"
            strokeOpacity="0.7"
            strokeWidth="2"
          />
        );
      })}
      {vm.nodes.map((n) => {
        const selected = vm.selected?.node.id === n.id;
        const fill = n.enter ? "#1e3a5f" : n.structural ? "#27272a" : "#1e293b";
        return (
          <g
            key={n.id}
            data-node={n.id}
            transform={`translate(${n.x} ${n.y})`}
            className="cursor-pointer"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              editor.select(n.id);
              editorSelection.select({
                source: "outliner",
                kind: "graph-node",
                id: n.id,
                label: n.title || n.id,
                components: [{ name: "Graph node", fields: [{ key: "id", value: n.id }, { key: "type", value: n.type }] }],
              });
              drag.current = { kind: "node", id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y };
              // Captured on the node (not the canvas), so its double-click still lands on it.
              (e.currentTarget as SVGGElement).setPointerCapture(e.pointerId);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (n.enter) onEnter(n.id);
            }}
          >
            <rect width={NODE_W} height={NODE_H} rx="6" fill={fill} stroke={selected ? "#fbbf24" : n.enter?.kind === "missing" ? "#ef4444" : "#475569"} strokeWidth={selected ? 2 : 1} />
            <text x="10" y="21" fill="#f1f5f9" fontSize="13" fontWeight="600">
              {n.title.length > 20 ? `${n.title.slice(0, 19)}…` : n.title}
            </text>
            <text x="10" y="39" fill="#94a3b8" fontSize="11">
              {n.title !== n.type ? n.type : n.id}
              {n.enter ? (n.enter.kind === "missing" ? " · missing part" : " · ⤵ open") : ""}
            </text>
            {n.inputs.map((p) => (
              <circle key={`i${p}`} cx={pinX(n, n.inputs, p) - n.x} cy="0" r="4" fill="#0ea5e9">
                <title>{p}</title>
              </circle>
            ))}
            {n.outputs.map((p) => (
              <circle key={`o${p}`} cx={pinX(n, n.outputs, p) - n.x} cy={NODE_H} r="4" fill="#22c55e">
                <title>{p}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
