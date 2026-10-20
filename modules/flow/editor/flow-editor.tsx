/**
 * Flow editor (roadmap EA8): graph editing over the real
 * content/flow/game.flow.json. Nodes are drawn at their saved x/y, edges
 * are listed beside the graph where they can be rewired, retargeted or
 * deleted. Problems (unreachable node, missing start, dangling edge,
 * unknown event or scene) show live; Save goes through the host, which
 * validates again and writes nothing when refused. "Play from" opens the
 * client at a node.
 */
import * as React from "react";
import { DocBar } from "../../../apps/editor/src/ui/doc-bar.js";
import { duplicateFlowNode, renameFlowNode } from "../../../apps/editor/src/flow-context.js";
import {
  addFlowEdge,
  addFlowNode,
  flowReachable,
  moveFlowNode,
  removeFlowEdge,
  removeFlowNode,
  rewireFlowEdge,
  setFlowStart,
  validateFlow,
  type FlowDoc,
  type SceneIssue,
} from "@mmo-engine/scene";
import { getFlow, playFromUrl, saveFlow } from "../../../apps/editor/src/flow-client.js";
import { leftRightRoute } from "../../../apps/editor/src/ui/graph-view.js";
import { issueCount } from "../../../apps/editor/src/ui/save-outcome.js";
import { useSaveTask } from "../../../apps/editor/src/ui/use-save-task.js";
import { NodeGraph } from "../../../apps/editor/src/ui/node-graph.js";
import { MIcon, Select } from "../../../apps/editor/src/ui/components.js";
import { useDocActions } from "../../../apps/editor/src/ui/doc-actions.js";
import { useDocument } from "../../../apps/editor/src/ui/use-document.js";
import { getTool, subscribeTool } from "../../../apps/editor/src/ui/tool-store.js";
import { canDragGraphNode } from "../../../apps/editor/src/ui/viewport-tools.js";
import { editorSelection } from "../../../apps/editor/src/ui/editor-selection.js";

const NODE_W = 140;
const NODE_H = 44;
const btn = "m3-focus rounded-full px-3 py-1 text-[13px] font-medium";
const field = "m3-focus rounded-md px-2 py-1 text-[13px]";
const fieldStyle: React.CSSProperties = { background: "var(--m3-surface-1)", color: "var(--m3-on-surface)", border: "1px solid var(--m3-outline-variant)" };

function pos(doc: FlowDoc, id: string): { x: number; y: number } {
  const n = doc.nodes[id];
  const i = Object.keys(doc.nodes).indexOf(id);
  return { x: n.x ?? 40 + (i % 5) * 170, y: n.y ?? 40 + Math.floor(i / 5) * 90 };
}

export function FlowEditor(): React.JSX.Element {
  const tool = React.useSyncExternalStore(subscribeTool, getTool);
  const flow = useDocument<FlowDoc>();
  const doc = flow.value;
  // One undo step per node drag: the first move opens it, the rest merge into it.
  const dragging = React.useRef(false);
  const [scenes, setScenes] = React.useState<string[]>([]);
  const [events, setEvents] = React.useState<string[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  // Node context menu: {id, x, y} when open.
  const [ctx, setCtx] = React.useState<{ id: string; x: number; y: number } | null>(null);
  // Inline rename: node id being renamed.
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const pick = (id: string | null): void => {
    setSelected(id);
    if (id === null) {
      const cur = editorSelection.get();
      if (cur && cur.kind === "flow-node") editorSelection.clear();
      return;
    }
    editorSelection.select({
      source: "outliner",
      kind: "flow-node",
      id,
      label: id,
      components: [{ name: "Flow node", fields: [{ key: "id", value: id }] }],
    });
  };
  const task = useSaveTask<SceneIssue>();
  const refused = task.issues;
  // Plain notes (loading, opened a URL, a failed load) share the save's status line.
  const status = task.status?.text ?? "";
  const setStatus = (text: string): void => task.setStatus({ tone: "info", text });
  const [newId, setNewId] = React.useState("");
  const [newScene, setNewScene] = React.useState("login");
  const [client, setClient] = React.useState("http://localhost:5173");
  const [server, setServer] = React.useState({ url: "", user: "", pass: "" });

  const load = React.useCallback((): void => {
    setStatus("loading…");
    getFlow()
      .then((b) => {
        flow.load(b.content);
        setScenes(b.scenes);
        setEvents(b.events);
        setNewScene(b.scenes[0] ?? "login");
        setStatus("");
      })
      .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  // Toolbar Save target while the flow is open (no undo stack here —
  // edits apply directly, so Undo/Redo stay disabled).
  useDocActions(() => {
    if (!doc) return null;
    return {
      label: "game flow",
      canSave: flow.dirty,
      ...flow.history,
      problems: validateFlow(doc, { scenes }).map((i) => ({ severity: "error" as const, where: i.path || "(flow)", message: i.message })),
      save: () => void save(),
      canRevert: flow.dirty,
      revert: () => {
        flow.revert();
        task.setIssues([]);
      },
      exportDoc: () => ({ name: "game.flow", data: doc }),
      importDoc: (incoming: unknown) => {
        const found = validateFlow(incoming, { scenes });
        if (found.length > 0) throw new Error(`invalid flow: ${found.slice(0, 3).map((i) => `${i.path} ${i.message}`).join("; ")}`);
        flow.edit(incoming as FlowDoc);
        task.setIssues([]);
      },
    };
  });

  if (!doc) {
    const failed = status !== "" && status !== "loading…";
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-[13px]">
        <p>Flow: {status || "loading…"}</p>
        {failed && (
          <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} onClick={() => load()}>
            Retry
          </button>
        )}
      </div>
    );
  }
  const issues = validateFlow(doc, { scenes });
  const dirty = flow.dirty;
  const reach = flowReachable(doc);
  const edit = (next: FlowDoc): void => {
    flow.edit(next);
    task.setIssues([]);
  };
  const ids = Object.keys(doc.nodes);
  const flagged = new Set(issues.filter((i) => i.path.startsWith("nodes.")).map((i) => i.path.split(".")[1]));

  const save = async (): Promise<void> => {
    if (await task.run(() => saveFlow(doc), { ok: "saved to content/flow/game.flow.json", refused: (i) => `refused: ${issueCount(i.length)}` })) flow.markSaved(doc);
  };
  const play = (id: string): void => {
    const r = playFromUrl(doc, id, { client, server: server.url && server.user ? server : undefined });
    if ("error" in r) setStatus(r.error);
    else {
      setStatus(`opened ${r.url.replace(/pass=[^&]*/, "pass=…")}`);
      window.open(r.url, "_blank", "noopener");
    }
  };
  const sel = selected && doc.nodes[selected] ? selected : null;

  return (
    <div className="flex flex-col gap-3 p-3" style={{ color: "var(--m3-on-surface)" }}>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-mono" style={{ color: "var(--m3-on-surface-variant)" }}>content/flow/game.flow.json</span>
        <span>{ids.length} nodes · {doc.edges.length} transitions</span>
        <span style={{ color: issues.length ? "#E8A33D" : "#6FCF97" }}>{issues.length ? `${issues.length} problem${issues.length === 1 ? "" : "s"}` : "valid"}</span>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <span style={{ color: "#E8A33D" }}>unsaved</span>}
          <DocBar dirty={dirty} history={flow.history} onSave={() => void save()} onRevert={flow.revert} />
        </span>
      </div>
      {status && <div className="text-[12px]" style={{ color: "var(--m3-on-surface-variant)" }}>{status}</div>}
      {(refused.length > 0 ? refused : issues).length > 0 && (
        <ul className="rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(232,163,61,.14)", color: "#E8A33D" }} aria-label="flow problems">
          {(refused.length > 0 ? refused : issues).map((i, k) => (
            <li key={k}><span className="font-mono">{i.path || "flow"}</span>: {i.message}</li>
          ))}
        </ul>
      )}

      <NodeGraph
        label="Game flow graph"
        testId="flow-graph"
        nodes={ids}
        edges={doc.edges.filter((e) => doc.nodes[e.from] && doc.nodes[e.to])}
        nodeId={(id) => id}
        nodePos={(id) => pos(doc, id)}
        nodeSize={{ w: NODE_W, h: NODE_H }}
        edgeEnds={(e) => ({ from: e.from, to: e.to })}
        height={Math.max(260, ...ids.map((id) => pos(doc, id).y + NODE_H + 30))}
        selectedId={sel}
        onSelect={pick}
        canMove={canDragGraphNode(tool)}
        onMove={(id, x, y) => {
          flow.edit((cur) => moveFlowNode(cur, id, Math.max(0, Math.round(x)), Math.max(0, Math.round(y))), { merge: dragging.current });
          dragging.current = true;
        }}
        onMoveEnd={() => { dragging.current = false; }}
        onNodeContextMenu={(id, at) => {
          pick(id);
          setCtx({ id, x: at.x, y: at.y });
        }}
        route={(a, b) => leftRightRoute(a.box, b.box)}
        renderEdge={(e, geom, arrow) => (
          <>
            <path d={geom.d} fill="none" stroke="#90909A" strokeWidth={1.5} markerEnd={arrow} />
            <text x={geom.mid.x} y={geom.mid.y} fontSize={10} textAnchor="middle" fill="#90909A">{e.on}</text>
          </>
        )}
        renderNode={(id, { selected }) => {
          const bad = flagged.has(id) || !reach.has(id);
          return (
            <>
              <rect width={NODE_W} height={NODE_H} rx={10} fill="var(--m3-surface-2, #26272c)" stroke={bad ? "#E8A33D" : selected ? "var(--m3-primary)" : "#4a4b52"} strokeWidth={selected || bad ? 2 : 1} />
              <text x={10} y={19} fontSize={13} fontWeight={600} fill="currentColor">{id}{id === doc.start ? "  ▶" : ""}</text>
              <text x={10} y={35} fontSize={11} fill="#90909A">{doc.nodes[id].scene}{bad ? " · unreachable" : ""}</text>
            </>
          );
        }}
      />
      {ctx && <span className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} />}
      {ctx && (
        <div
          className="fixed z-50 min-w-40 rounded-lg border py-1 shadow-lg"
          style={{
            left: ctx.x,
            top: ctx.y,
            background: "var(--m3-surface)",
            borderColor: "var(--m3-outline-variant)",
          }}
          role="menu"
          onMouseLeave={() => setCtx(null)}
        >
          {[
            { label: "Rename…", run: () => { setRenaming(ctx.id); setCtx(null); } },
            {
              label: "Duplicate",
              run: () => {
                setCtx(null);
                try {
                  const next = duplicateFlowNode(doc, ctx.id);
                  edit(next);
                  // Select the copy (the one key the duplicate added).
                  const added = Object.keys(next.nodes).find((k) => !(k in doc.nodes));
                  if (added) pick(added);
                } catch (e) {
                  setStatus((e as Error).message);
                }
              },
            },
            {
              label: "Delete",
              run: () => {
                setCtx(null);
                edit(removeFlowNode(doc, ctx.id));
                if (selected === ctx.id) pick(null);
              },
            },
          ].map((item) => (
            <button
              key={item.label}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--m3-secondary-container)]"
              onClick={item.run}
              role="menuitem"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {renaming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-label="Rename node">
          <div className="rounded-lg border p-4 shadow-lg" style={{ background: "var(--m3-surface)", borderColor: "var(--m3-outline-variant)" }}>
            <h3 className="mb-2 text-sm font-medium">Rename node</h3>
            <input
              autoFocus
              className="mb-2 w-64 rounded border px-2 py-1 text-sm"
              defaultValue={renaming}
              id="flow-rename-input"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value;
                  try {
                    edit(renameFlowNode(doc, renaming, v));
                    // The selection follows the node to its new id.
                    if (selected === renaming) pick(v.trim());
                    setRenaming(null);
                  } catch (err) {
                    setStatus((err as Error).message);
                  }
                } else if (e.key === "Escape") setRenaming(null);
              }}
              aria-label="New node id"
            />
            <div className="flex justify-end gap-2">
              <button className="rounded border px-3 py-1 text-sm" onClick={() => setRenaming(null)}>Cancel</button>
              <button
                className="rounded px-3 py-1 text-sm"
                style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)" }}
                onClick={() => {
                  const el = document.getElementById("flow-rename-input") as HTMLInputElement | null;
                  const v = el?.value ?? "";
                  try {
                    edit(renameFlowNode(doc, renaming, v));
                    // The selection follows the node to its new id.
                    if (selected === renaming) pick(v.trim());
                    setRenaming(null);
                  } catch (err) {
                    setStatus((err as Error).message);
                  }
                }}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Transitions</h3>
          {doc.edges.map((e, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1 text-[12px]">
              <Select size="md" aria-label={`edge ${i} from`} value={e.from} onChange={(ev) => edit({ ...doc, edges: doc.edges.map((x, k) => (k === i ? { ...x, from: ev.target.value } : x)) })}>
                {ids.map((id) => <option key={id}>{id}</option>)}
              </Select>
              <Select size="md" aria-label={`edge ${i} event`} value={e.on} onChange={(ev) => edit({ ...doc, edges: doc.edges.map((x, k) => (k === i ? { ...x, on: ev.target.value } : x)) })}>
                {events.map((n) => <option key={n}>{n}</option>)}
              </Select>
              <span>→</span>
              <Select size="md" aria-label={`edge ${i} to`} value={e.to} onChange={(ev) => edit(rewireFlowEdge(doc, i, ev.target.value))}>
                {ids.map((id) => <option key={id}>{id}</option>)}
              </Select>
              <button aria-label={`delete transition ${i}`} className={btn} onClick={() => edit(removeFlowEdge(doc, i))}><MIcon name="delete" size={16} /></button>
            </div>
          ))}
          <button
            className={btn}
            style={{ border: "1px solid var(--m3-outline-variant)", alignSelf: "flex-start" }}
            onClick={() => edit(addFlowEdge(doc, { from: sel ?? doc.start, on: events[0] ?? "ui.submit", to: sel ?? doc.start }))}
          >
            + Transition{sel ? ` from ${sel}` : ""}
          </button>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Nodes</h3>
          <div className="flex flex-wrap items-center gap-1 text-[12px]">
            <input aria-label="new node id" className={field} style={fieldStyle} placeholder="node-id" value={newId} onChange={(e) => setNewId(e.target.value)} />
            <Select size="md" aria-label="new node scene" value={newScene} onChange={(e) => setNewScene(e.target.value)}>
              {scenes.map((s) => <option key={s}>{s}</option>)}
            </Select>
            <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={!newId || newId in doc.nodes} onClick={() => { edit(addFlowNode(doc, newId, { scene: newScene })); pick(newId); setNewId(""); }}>
              Add node
            </button>
          </div>
          {sel && (
            <div className="flex flex-wrap items-center gap-1 text-[12px]">
              <strong>{sel}</strong>
              <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={sel === doc.start} onClick={() => edit(setFlowStart(doc, sel))}>Set as start</button>
              <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} onClick={() => { edit(removeFlowNode(doc, sel)); pick(null); }}>Delete node</button>
            </div>
          )}
          <h3 className="mt-2 text-[13px] font-semibold">Play from</h3>
          <div className="flex flex-wrap items-center gap-1 text-[12px]">
            <input aria-label="client url" className={field} style={fieldStyle} value={client} onChange={(e) => setClient(e.target.value)} />
            <input aria-label="server url" className={field} style={fieldStyle} placeholder="ws://localhost:7777" value={server.url} onChange={(e) => setServer({ ...server, url: e.target.value })} />
            <input aria-label="dev user" className={field} style={fieldStyle} placeholder="user" value={server.user} onChange={(e) => setServer({ ...server, user: e.target.value })} />
            <input aria-label="dev password" type="password" className={field} style={fieldStyle} placeholder="password" value={server.pass} onChange={(e) => setServer({ ...server, pass: e.target.value })} />
          </div>
          <div className="flex flex-wrap gap-1">
            {ids.map((id) => (
              <button key={id} className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={!reach.has(id)} onClick={() => play(id)}>
                <MIcon name="play_arrow" size={16} /> {id}
              </button>
            ))}
          </div>
          <p className="text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
            Login needs nothing. Character creation previews without a server. Character select and world log in with the server and account above, then jump to the node.
          </p>
        </section>
      </div>
    </div>
  );
}
