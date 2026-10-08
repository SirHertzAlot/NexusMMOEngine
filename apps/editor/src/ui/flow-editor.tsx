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
import { FlowSaveError, getFlow, playFromUrl, saveFlow } from "../flow-client.js";
import { pastDragThreshold } from "./drag-threshold.js";
import { MIcon } from "./components.js";

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
  const [doc, setDoc] = React.useState<FlowDoc | null>(null);
  const [saved, setSaved] = React.useState("");
  const [scenes, setScenes] = React.useState<string[]>([]);
  const [events, setEvents] = React.useState<string[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string>("loading…");
  const [refused, setRefused] = React.useState<SceneIssue[]>([]);
  const [newId, setNewId] = React.useState("");
  const [newScene, setNewScene] = React.useState("login");
  const [client, setClient] = React.useState("http://localhost:5173");
  const [server, setServer] = React.useState({ url: "", user: "", pass: "" });
  const drag = React.useRef<{ kind: "pan" | "node"; id: string | null; dx: number; dy: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [view, setView] = React.useState({ x: 0, y: 0 });

  const load = React.useCallback((): void => {
    setStatus("loading…");
    getFlow()
      .then((b) => {
        setDoc(b.content);
        setSaved(JSON.stringify(b.content));
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

  if (!doc) {
    const failed = status !== "" && status !== "loading…";
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-[13px]">
        <p>Flow: {status}</p>
        {failed && (
          <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} onClick={() => load()}>
            Retry
          </button>
        )}
      </div>
    );
  }

  const issues = validateFlow(doc, { scenes });
  const dirty = JSON.stringify(doc) !== saved;
  const reach = flowReachable(doc);
  const edit = (next: FlowDoc): void => {
    setDoc(next);
    setRefused([]);
  };
  const ids = Object.keys(doc.nodes);
  const flagged = new Set(issues.filter((i) => i.path.startsWith("nodes.")).map((i) => i.path.split(".")[1]));

  const save = async (): Promise<void> => {
    try {
      await saveFlow(doc);
      setSaved(JSON.stringify(doc));
      setRefused([]);
      setStatus("saved to content/flow/game.flow.json");
    } catch (e) {
      if (e instanceof FlowSaveError) setRefused(e.issues);
      setStatus(e instanceof Error ? `refused: ${e.message}` : String(e));
    }
  };
  const play = (id: string): void => {
    const r = playFromUrl(doc, id, { client, server: server.url && server.user ? server : undefined });
    if ("error" in r) setStatus(r.error);
    else {
      setStatus(`opened ${r.url.replace(/pass=[^&]*/, "pass=…")}`);
      window.open(r.url, "_blank", "noopener");
    }
  };
  const toUnits = (ev: React.PointerEvent): { x: number; y: number } => {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: ev.clientX - (r?.left ?? 0) + view.x, y: ev.clientY - (r?.top ?? 0) + view.y };
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
          <button className={btn} style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)", opacity: dirty ? 1 : 0.5 }} disabled={!dirty} onClick={() => void save()}>
            Save
          </button>
          <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={!dirty} onClick={() => edit(JSON.parse(saved) as FlowDoc)}>
            Revert
          </button>
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

      <svg
        ref={svgRef}
        width="100%"
        height={Math.max(260, ...ids.map((id) => pos(doc, id).y + NODE_H + 30))}
        className="rounded-xl"
        style={{ background: "var(--m3-surface-0)", touchAction: "none" }}
        role="img"
        aria-label="Game flow graph"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { kind: "pan", id: null, dx: 0, dy: 0, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
          (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
          setSelected(null);
        }}
        onPointerMove={(ev) => {
          const d = drag.current;
          if (!d) return;
          if (!pastDragThreshold(d.sx, d.sy, ev.clientX, ev.clientY)) return;
          if (d.kind === "pan") {
            setView({ x: d.ox - (ev.clientX - d.sx), y: d.oy - (ev.clientY - d.sy) });
            return;
          }
          if (d.id === null) return;
          const p = toUnits(ev);
          const id = d.id;
          setDoc((cur) => (cur ? moveFlowNode(cur, id, Math.max(0, Math.round(p.x - d.dx)), Math.max(0, Math.round(p.y - d.dy))) : cur));
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <defs>
          <marker id="ah-gameflow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="#90909A" />
          </marker>
        </defs>
        <g transform={`translate(${-view.x},${-view.y})`}>
        {doc.edges.map((e, i) => {
          if (!doc.nodes[e.from] || !doc.nodes[e.to]) return null;
          const a = pos(doc, e.from);
          const b = pos(doc, e.to);
          const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
          const back = x2 <= x1;
          const d = back
            ? `M${a.x + NODE_W / 2},${a.y + NODE_H} C${a.x + NODE_W / 2},${a.y + NODE_H + 60} ${b.x + NODE_W / 2},${b.y + NODE_H + 60} ${b.x + NODE_W / 2},${b.y + NODE_H}`
            : `M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}`;
          return (
            <g key={i}>
              <path d={d} fill="none" stroke="#90909A" strokeWidth={1.5} markerEnd="url(#ah-gameflow)" />
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 + (back ? 56 : -6)} fontSize={10} textAnchor="middle" fill="#90909A">{e.on}</text>
            </g>
          );
        })}
        {ids.map((id) => {
          const p = pos(doc, id);
          const bad = flagged.has(id) || !reach.has(id);
          return (
            <g
              key={id}
              data-fnode={id}
              transform={`translate(${p.x},${p.y})`}
              style={{ cursor: "grab" }}
              onPointerDown={(ev) => {
                if (ev.button !== 0) return;
                ev.stopPropagation();
                const pt = toUnits(ev);
                drag.current = { kind: "node", id, dx: pt.x - p.x, dy: pt.y - p.y, sx: ev.clientX, sy: ev.clientY, ox: p.x, oy: p.y };
                (ev.currentTarget as SVGGElement).setPointerCapture(ev.pointerId);
                setSelected(id);
              }}
            >
              <rect width={NODE_W} height={NODE_H} rx={10} fill="var(--m3-surface-2, #26272c)" stroke={bad ? "#E8A33D" : id === sel ? "var(--m3-primary)" : "#4a4b52"} strokeWidth={id === sel || bad ? 2 : 1} />
              <text x={10} y={19} fontSize={13} fontWeight={600} fill="currentColor">{id}{id === doc.start ? "  ▶" : ""}</text>
              <text x={10} y={35} fontSize={11} fill="#90909A">{doc.nodes[id].scene}{bad ? " · unreachable" : ""}</text>
            </g>
          );
        })}
        </g>
      </svg>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Transitions</h3>
          {doc.edges.map((e, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1 text-[12px]">
              <select aria-label={`edge ${i} from`} className={field} style={fieldStyle} value={e.from} onChange={(ev) => edit({ ...doc, edges: doc.edges.map((x, k) => (k === i ? { ...x, from: ev.target.value } : x)) })}>
                {ids.map((id) => <option key={id}>{id}</option>)}
              </select>
              <select aria-label={`edge ${i} event`} className={field} style={fieldStyle} value={e.on} onChange={(ev) => edit({ ...doc, edges: doc.edges.map((x, k) => (k === i ? { ...x, on: ev.target.value } : x)) })}>
                {events.map((n) => <option key={n}>{n}</option>)}
              </select>
              <span>→</span>
              <select aria-label={`edge ${i} to`} className={field} style={fieldStyle} value={e.to} onChange={(ev) => edit(rewireFlowEdge(doc, i, ev.target.value))}>
                {ids.map((id) => <option key={id}>{id}</option>)}
              </select>
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
            <select aria-label="new node scene" className={field} style={fieldStyle} value={newScene} onChange={(e) => setNewScene(e.target.value)}>
              {scenes.map((s) => <option key={s}>{s}</option>)}
            </select>
            <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={!newId || newId in doc.nodes} onClick={() => { edit(addFlowNode(doc, newId, { scene: newScene })); setSelected(newId); setNewId(""); }}>
              Add node
            </button>
          </div>
          {sel && (
            <div className="flex flex-wrap items-center gap-1 text-[12px]">
              <strong>{sel}</strong>
              <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={sel === doc.start} onClick={() => edit(setFlowStart(doc, sel))}>Set as start</button>
              <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} onClick={() => { edit(removeFlowNode(doc, sel)); setSelected(null); }}>Delete node</button>
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
