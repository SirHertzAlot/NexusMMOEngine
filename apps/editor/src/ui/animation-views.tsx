/**
 * The Animation panel's views over the real documents (roadmap EA21):
 *
 *  - Clips: the rig's library (its own animations.json, when the art is on
 *    this machine) with where each clip is used and a library check.
 *  - Locomotion: content/animation/animations.json (a v3 manifest). The
 *    graph is the one the client's animator runs; the test rig below it
 *    uses the same `pickLocomotion` to show the clip, rate and crossfade a
 *    given motion gets.
 *  - Combat: content/combat/moves.json. The timeline counts server ticks
 *    (30 Hz); drag the hit frame and the windows. The server reads this
 *    file at start, the client for the clips and sounds.
 */
import * as React from "react";
import { pickLocomotion, type AnimationManifest, type LocomotionGraph, type MediaDocName, type MediaIssue } from "@mmo-engine/art/browser";
import type { CombatMove } from "@mmo-engine/protocol";
import {
  MEDIUMS, TICK_HZ, addGait, checkAgainstRig, clipUsage, removeGait, setDuration, setGait, setMarker, stateGraph, stateOf, toFrame, toggleHit, toggleWindow,
  type Marker, type Medium, type WindowName,
} from "../media-model.js";
import { animationStore, useDetail } from "./animation-store.js";
import { Button, CheckField, Field, Input, NumberInput, Select } from "./components.js";
import { DocBar } from "./doc-bar.js";
import { NO_HISTORY, useDocActions } from "./doc-actions.js";
import type { MediaDoc } from "./use-media-doc.js";

const muted: React.CSSProperties = { color: "var(--m3-on-surface-variant)" };

/** A labelled number box; commits on every valid change. */
export function Num({ label, value, onChange, step = 0.01, min, max, unit, disabled }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; unit?: string; disabled?: boolean;
}): React.JSX.Element {
  return (
    <Field label={unit ? `${label} (${unit})` : label} className="w-28">
      <NumberInput aria-label={label} value={value} step={step} min={min} max={max} disabled={disabled} onChange={(v) => Number.isFinite(v) && onChange(v)} />
    </Field>
  );
}

export function Txt({ label, value, onChange, list, wide }: { label: string; value: string; onChange: (v: string) => void; list?: string; wide?: boolean }): React.JSX.Element {
  return (
    <Field label={label} className={wide ? "w-60" : "w-44"}>
      <Input aria-label={label} className="h-9 font-mono" value={value} list={list} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function Pick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }): React.JSX.Element {
  return (
    <Field label={label}>
      <Select aria-label={label} className="font-mono" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {!options.includes(value) && <option value={value}>{value}</option>}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
    </Field>
  );
}

export const Heading = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <p className="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wider" style={muted}>{children}</p>
);

/** The refused or failing checks of a document, by path. */
export function IssueList({ file, issues }: { file: string; issues: MediaIssue[] }): React.JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <ul className="rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(232,163,61,.14)", color: "#E8A33D" }} aria-label={`${file} problems`}>
      {issues.map((i, k) => (
        <li key={k}><span className="font-mono">{i.path || "document"}</span>: {i.message}</li>
      ))}
    </ul>
  );
}

/** Save / revert / status / problems for one media document, and the toolbar's Save while it is open. */
export function MediaDocBar({ file, doc }: { file: string; doc: Pick<MediaDoc<MediaDocName>, "doc" | "dirty" | "issues" | "task" | "save" | "revert"> }): React.JSX.Element {
  useDocActions(() =>
    doc.doc === null
      ? null
      : {
          label: file,
          canSave: doc.dirty && doc.issues.length === 0,
          ...NO_HISTORY,
          problems: doc.issues.map((i) => ({ severity: "error" as const, where: i.path || "(document)", message: i.message })),
          save: () => void doc.save(),
        },
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-xs opacity-70">{file}</span>
        <span className="text-xs" style={{ color: doc.issues.length ? "#E8A33D" : "#6FCF97" }}>{doc.issues.length ? `${doc.issues.length} problem${doc.issues.length === 1 ? "" : "s"}` : "valid"}</span>
        <span className="ml-auto"><DocBar dirty={doc.dirty} busy={doc.task.busy} saveBlocked={doc.issues.length > 0} onSave={() => void doc.save()} onRevert={doc.revert} /></span>
      </div>
      {doc.task.status && <div className="text-[12px]" role="status" style={{ color: doc.task.status.tone === "bad" ? "#FFB4AB" : "var(--m3-on-surface-variant)" }}>{doc.task.status.text}</div>}
      <IssueList file={file} issues={doc.issues} />
    </div>
  );
}

// ---------------------------------------------------------------- clips

export function ClipBrowser({ rig, loading, graph, moves, clipNames }: {
  rig: AnimationManifest | null; loading: boolean; graph: LocomotionGraph | null; moves: CombatMove[]; clipNames: string[];
}): React.JSX.Element {
  const { clip } = animationStore.use();
  const [filter, setFilter] = React.useState("");
  const [source, setSource] = React.useState("all");
  const usage = React.useMemo(() => (graph ? clipUsage(graph, moves) : new Map<string, string[]>()), [graph, moves]);
  const checks = React.useMemo(() => (rig && graph ? checkAgainstRig(rig, graph, moves) : []), [rig, graph, moves]);
  const referenced = [...usage.keys()].sort();
  const rows = rig
    ? rig.clips.filter((c) => (source === "all" || c.source === source) && c.name.toLowerCase().includes(filter.toLowerCase()))
    : [];
  const info = rig?.clips.find((c) => c.name === clip);
  useDetail({
    title: clip || "Clips",
    rows: clip
      ? [
          ["used by", (usage.get(clip) ?? usage.get(clip.replace(/\.F$/, "")) ?? ["nothing yet"]).join(" · ")],
          ...(info ? ([["duration", `${info.duration.toFixed(3)} s`], ["source", info.source], ["loops", info.loop ? "yes" : "no"]] as Array<[string, string]>) : []),
        ]
      : [["clips in the library", String(clipNames.length)], ["clips in use", String(referenced.length)], ["library problems", String(checks.length)]],
    note: "Clips come from the rig's animations.json (npm run convert:animations). Clip map, Locomotion and Combat choose which ones play.",
  });
  const shown = rig
    ? rows.map((c) => ({ name: c.name, source: c.source, dur: c.duration.toFixed(3), loop: c.loop ? "yes" : "", travel: `${c.travel[0].toFixed(2)}, ${c.travel[1].toFixed(2)} m` }))
    : referenced.filter((n) => n.toLowerCase().includes(filter.toLowerCase())).map((n) => ({ name: n, source: "", dur: "", loop: "", travel: "" }));
  return (
    <div className="flex flex-col gap-3">
      {!rig && !loading && (
        <div className="rounded-xl px-3 py-2 text-[12px]" style={{ background: "var(--m3-surface-2)", ...muted }}>
          The rig library is not on this machine (assets/ is licensed art and is not in the repo), so the browser shows the {referenced.length} clips the
          locomotion graph and the combat moves play.
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Txt label="Filter clips" value={filter} onChange={setFilter} />
        {rig && <Pick label="Source" value={source} options={["all", ...rig.sources.map((s) => s.id)]} onChange={setSource} />}
      </div>
      <table className="w-full text-left text-[12px]" aria-label="clip browser">
        <thead style={muted}><tr><th className="py-1">Clip</th><th>Source</th><th>Length</th><th>Loops</th><th>Travel</th><th>Used by</th></tr></thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.name} onClick={() => animationStore.set((p) => ({ ...p, clip: c.name }))} className="cursor-pointer" style={c.name === clip ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : undefined}>
              <td className="py-0.5 font-mono">{c.name}</td><td>{c.source}</td><td className="font-mono">{c.dur}</td><td>{c.loop}</td><td className="font-mono">{c.travel}</td>
              <td className="text-[11px]">{(usage.get(c.name) ?? []).join(" · ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="text-[12px]" style={muted}>No clip matches.</p>}
      <Heading>Library check</Heading>
      {rig ? (
        checks.length === 0 ? <p className="text-[12px]" style={{ color: "#6FCF97" }}>Every clip the graph and the moves play is in the library, and each move is as long as its clip.</p> : (
          <ul className="rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(232,163,61,.14)", color: "#E8A33D" }} aria-label="library problems">
            {checks.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        )
      ) : <p className="text-[12px]" style={muted}>Needs the rig's animations.json.</p>}
      {rig && (
        <>
          <Heading>Sources</Heading>
          <ul className="text-[12px]">
            {rig.sources.map((s) => <li key={s.id}><span className="font-mono">{s.id}</span> · {s.title} · {s.author} · {s.license}{s.reference ? " · reference (not loaded)" : ""}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- locomotion

export function LocomotionEditor({ graph, clipNames, onChange }: { graph: LocomotionGraph; clipNames: string[]; onChange: (g: LocomotionGraph) => void }): React.JSX.Element {
  const [motion, setMotion] = React.useState({ speed: 0, vy: 0, mode: 0, air: 0 });
  const pick = pickLocomotion(graph, { speed: motion.speed, vy: motion.vy, mode: motion.mode }, motion.air);
  const live = stateOf(pick, graph);
  const { nodes, edges } = React.useMemo(() => stateGraph(graph), [graph]);
  const at = new Map(nodes.map((n) => [n.id, n]));
  const [selected, setSelected] = React.useState<string>("ground:idle");
  const n = at.get(selected);
  useDetail({
    title: n ? n.label : "Locomotion",
    rows: n
      ? [["state", n.medium === "air" ? "air" : n.gait < 0 ? "idle" : "gait"], ["clip", n.clip], ["detail", n.detail], ["crossfade in", `${(edges.find((e) => e.to === n.id)?.fade ?? graph.fade).toFixed(2)} s`]]
      : [],
    note: "The client's animator crossfades between these states by speed; the test rig shows what a motion picks.",
  });
  const height = 20 + (MEDIUMS.length + 1) * 80;
  const width = 20 + Math.max(...MEDIUMS.map((m) => graph[m].length + 1)) * 170;
  return (
    <div className="flex flex-col gap-3">
      <svg viewBox={`0 0 ${Math.max(width, 520)} ${height}`} className="w-full rounded-xl" style={{ background: "var(--m3-surface-0)", maxHeight: 380 }} role="img" aria-label="Locomotion state machine">
        <defs><marker id="loco-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#90909A" /></marker></defs>
        {edges.filter((e) => e.from !== e.to).map((e, i) => {
          const a = at.get(e.from)!;
          const b = at.get(e.to)!;
          const fwd = a.x < b.x || (a.x === b.x && a.y < b.y) || b.id === "air";
          const off = fwd ? -6 : 8;
          if (a.y !== b.y) return <path key={i} d={`M${a.x + 120},${a.y + 40} L${b.x + 20},${b.y}`} stroke="#90909A" fill="none" markerEnd="url(#loco-arrow)" strokeDasharray={e.from === "air" ? "4 3" : undefined} />;
          return (
            <g key={i}>
              <path d={`M${fwd ? a.x + 140 : a.x},${a.y + 22 + off} L${fwd ? b.x : b.x + 140},${b.y + 22 + off}`} stroke="#90909A" fill="none" markerEnd="url(#loco-arrow)" />
              <text x={(a.x + b.x) / 2 + 70} y={a.y + 22 + off - 3} fill="#C6C5D0" fontSize="9" textAnchor="middle" fontFamily="monospace">{fwd ? `${e.fade.toFixed(2)} s` : ""}</text>
            </g>
          );
        })}
        {nodes.map((s) => (
          <g key={s.id} onClick={() => setSelected(s.id)} style={{ cursor: "pointer" }} data-state={s.id} data-live={s.id === live}>
            <rect x={s.x} y={s.y} width="140" height="44" rx="10" fill={s.id === live ? "#36449A" : "#292A2F"} stroke={s.id === selected ? "#FFB59A" : s.id === live ? "#B9C3FF" : "#46464F"} strokeWidth={s.id === live || s.id === selected ? 2 : 1} />
            <text x={s.x + 10} y={s.y + 18} fill="#E3E1E9" fontSize="11" fontWeight="600">{s.label.length > 20 ? `${s.label.slice(0, 19)}…` : s.label}</text>
            <text x={s.x + 10} y={s.y + 34} fill="#C6C5D0" fontSize="9" fontFamily="monospace">{s.detail.length > 24 ? `${s.detail.slice(0, 23)}…` : s.detail}</text>
          </g>
        ))}
      </svg>

      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider" style={muted}>Test rig</p>
        <div className="flex flex-wrap items-end gap-3">
          <Num label="Speed" unit="m/s" value={motion.speed} min={0} max={12} step={0.1} onChange={(speed) => setMotion({ ...motion, speed })} />
          <Num label="Vertical speed" unit="m/s" value={motion.vy} step={0.5} onChange={(vy) => setMotion({ ...motion, vy })} />
          <Num label="Seconds airborne" value={motion.air} min={0} step={0.05} onChange={(air) => setMotion({ ...motion, air })} />
          <Pick label="Medium" value={(["ground", "swim", "fly"] as const)[motion.mode]} options={["ground", "swim", "fly"] as const} onChange={(m) => setMotion({ ...motion, mode: ["ground", "swim", "fly"].indexOf(m) })} />
          <p className="font-mono text-[13px]" aria-label="test rig result">
            plays <strong>{pick.clip}</strong> at {pick.timeScale.toFixed(2)}x, crossfade {pick.fade.toFixed(2)} s
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Num label="Crossfade" unit="s" value={graph.fade} min={0} max={2} step={0.01} onChange={(fade) => onChange({ ...graph, fade })} />
        <Num label="Airborne above" unit="m/s" value={graph.airborneVy} min={0} step={0.1} onChange={(airborneVy) => onChange({ ...graph, airborneVy })} />
        <Num label="Air delay" unit="s" value={graph.airSeconds} min={0} step={0.01} onChange={(airSeconds) => onChange({ ...graph, airSeconds })} />
        <Num label="Rate min" value={graph.scale[0]} min={0.1} step={0.05} onChange={(v) => onChange({ ...graph, scale: [v, graph.scale[1]] })} />
        <Num label="Rate max" value={graph.scale[1]} min={0.1} step={0.05} onChange={(v) => onChange({ ...graph, scale: [graph.scale[0], v] })} />
      </div>
      <datalist id="rig-clips">{clipNames.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="flex flex-wrap items-end gap-3">
        {(["ground", "swim", "fly", "air"] as const).map((k) => (
          <Txt key={k} label={`Idle clip · ${k}`} value={graph.idle[k]} list="rig-clips" onChange={(v) => onChange({ ...graph, idle: { ...graph.idle, [k]: v } })} />
        ))}
      </div>
      {MEDIUMS.map((medium: Medium) => (
        <div key={medium} className="flex flex-col gap-1.5">
          <Heading>{medium} gaits</Heading>
          {graph[medium].map((g, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2" data-gait={`${medium}-${i}`}>
              <Txt label="Clip" value={g.clip} list="rig-clips" onChange={(clip) => onChange(setGait(graph, medium, i, { clip }))} />
              <Num label="Starts at" unit="m/s" value={g.from} min={0} step={0.1} onChange={(from) => onChange(setGait(graph, medium, i, { from }))} />
              <Num label="Clip's own speed" unit="m/s" value={g.speed} min={0.01} step={0.1} onChange={(speed) => onChange(setGait(graph, medium, i, { speed }))} />
              <Num label="Crossfade in" unit="s" value={g.fade ?? graph.fade} min={0} max={2} step={0.01} onChange={(fade) => onChange(setGait(graph, medium, i, { fade }))} />
              {g.fade !== undefined && <Button size="sm" variant="outline" onClick={() => onChange(setGait(graph, medium, i, { fade: undefined }))}>Use default fade</Button>}
              <Button size="sm" variant="outline" aria-label={`Remove ${medium} gait ${i + 1}`} onClick={() => onChange(removeGait(graph, medium, i))}>Remove</Button>
            </div>
          ))}
          <Button size="sm" variant="outline" className="w-fit" onClick={() => onChange(addGait(graph, medium, clipNames[0] ?? "Walk_Loop"))}>Add {medium} gait</Button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- combat timeline

const MARKER_COLOUR: Record<string, string> = { hitAt: "#93000A", branchAt: "#7A5A12", chain: "#1F5110", advance: "#3a3355", iframes: "#36449A" };

export function CombatTimeline({ doc, rig, events, onChange }: { doc: { moves: CombatMove[] }; rig: AnimationManifest | null; events: string[]; onChange: (moves: CombatMove[]) => void }): React.JSX.Element {
  const { move: moveId } = animationStore.use();
  const move = doc.moves.find((m) => m.id === moveId) ?? doc.moves[0];
  const [scrub, setScrub] = React.useState(0);
  const drag = React.useRef<Marker | null>(null);
  const frames = Math.max(1, toFrame(move?.duration ?? 0));
  const clip = rig?.clips.find((c) => c.name === move?.clip);
  useDetail(
    move
      ? {
          title: move.name,
          rows: [
            ["move id", String(move.id)],
            ["kind", move.kind],
            ["length", `${move.duration} s · ${frames} ticks`],
            ["hit frame", move.hitAt !== undefined ? `tick ${toFrame(move.hitAt)} (${move.hitAt} s)` : "none"],
            ["clip", move.clip + (clip ? ` · ${clip.duration.toFixed(3)} s` : "")],
            ["sounds", [move.sound?.start && `start ${move.sound.start}`, move.sound?.hit && `hit ${move.sound.hit}`].filter(Boolean).join(" · ") || "none"],
          ],
          note: "The server reads moves.json at start (timing, chain, travel); the client plays the clip and sounds. Restart the play-mode server to apply.",
        }
      : { title: "Combat", rows: [] },
  );
  if (!move) return <p className="text-[13px]" style={muted}>No moves.</p>;
  const edit = (next: CombatMove): void => onChange(doc.moves.map((m) => (m.id === next.id ? next : m)));
  const pct = (sec: number): string => `${(sec / move.duration) * 100}%`;
  /** Seconds under the pointer, measured on the lane the handle sits in. */
  const secAt = (el: HTMLElement, clientX: number): number => {
    const r = el.parentElement!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * move.duration;
  };

  const handle = (marker: Marker, sec: number | undefined, label: string, colour: string): React.ReactNode =>
    sec === undefined ? null : (
      <div
        key={marker} role="slider" tabIndex={0} aria-label={`${label} (${marker})`} aria-valuenow={toFrame(sec)} aria-valuemin={0} aria-valuemax={frames}
        data-marker={marker}
        className="absolute top-0 h-full w-2 -translate-x-1 cursor-ew-resize rounded-sm"
        style={{ left: pct(sec), background: colour, outline: "1px solid #E3E1E9", touchAction: "none" }}
        onPointerDown={(e) => {
          drag.current = marker;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current === marker) edit(setMarker(move, marker, secAt(e.currentTarget, e.clientX)));
        }}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            edit(setMarker(move, marker, sec + (e.key === "ArrowRight" ? 1 : -1) / TICK_HZ));
          }
        }}
      />
    );
  const win = (w: WindowName, label: string): React.ReactNode => {
    const x = move[w];
    return (
      <Lane label={label} on={x !== undefined} onToggle={() => edit(toggleWindow(move, w, doc.moves))}>
        {x && <div className="absolute top-0 h-full rounded-sm" style={{ left: pct(x.from), width: pct(x.to - x.from), background: MARKER_COLOUR[w], opacity: 0.85 }} />}
        {x && handle(`${w}.from` as Marker, x.from, `${label} start`, "#E3E1E9")}
        {x && handle(`${w}.to` as Marker, x.to, `${label} end`, "#E3E1E9")}
      </Lane>
    );
  };
  const t = scrub / TICK_HZ;
  const phase =
    move.hitAt !== undefined && t >= move.hitAt - 1e-6 && t < move.hitAt + 1 / TICK_HZ ? "hit lands"
    : [move.chain && t >= move.chain.from && t <= move.chain.to && "chain window", move.advance && t >= move.advance.from && t <= move.advance.to && "moving forward", move.iframes && t >= move.iframes.from && t <= move.iframes.to && "cannot be hit"].filter(Boolean).join(", ") || "-";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Move">
          <Select aria-label="Move" className="font-mono" value={move.id} onChange={(e) => animationStore.set((p) => ({ ...p, move: Number(e.target.value) }))}>
            {doc.moves.map((m) => <option key={m.id} value={m.id}>{m.id} · {m.name}</option>)}
          </Select>
        </Field>
        <Txt label="Clip" value={move.clip} onChange={(c) => edit({ ...move, clip: c })} />
        <Num label="Length" unit="s" value={move.duration} min={0.1} max={10} step={1 / TICK_HZ} onChange={(d) => edit(setDuration(move, d))} />
        <Num label="Walking during" unit="x speed" value={move.moveScale} min={0} max={1} step={0.05} onChange={(moveScale) => edit({ ...move, moveScale })} />
        <Pick label="Kind" value={move.kind} options={["attack", "guard", "dodge"] as const} onChange={(kind) => edit({ ...move, kind })} />
      </div>
      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 text-sm"><span className="font-mono font-semibold">{move.name}</span> <span className="font-mono text-xs" style={muted}>content/combat/moves.json · {frames} ticks · {TICK_HZ} Hz · server ticks shown</span></p>
        <div className="flex items-center gap-2" style={{ height: 22 }}>
          <span className="w-28 flex-none text-xs" style={muted}>tick</span>
          <div className="relative h-full flex-1 font-mono text-[10px]" style={muted}>
            {Array.from({ length: Math.floor(frames / 5) + 1 }, (_, i) => i * 5).map((f) => (
              <span key={f} className="absolute" style={{ left: `${(f / frames) * 100}%` }}>{f}</span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2" style={{ height: 30 }}>
          <span className="w-28 flex-none text-xs" style={muted}>clip</span>
          <div className="relative h-5 flex-1 rounded-md" style={{ background: "var(--m3-surface-1)" }}>
            <span className="absolute inset-y-0 left-0 overflow-hidden whitespace-nowrap rounded-md px-2 font-mono text-[11px] leading-5" style={{ width: clip ? `${Math.min(100, (clip.duration / move.duration) * 100)}%` : "100%", background: "#434659", color: "#E3E1E9" }}>
              {move.clip}{clip ? ` · ${clip.duration.toFixed(3)} s` : ""}
            </span>
          </div>
        </div>
        <div className="relative" style={{ touchAction: "none" }}>
          <Lane label="hit frame" on={move.hitAt !== undefined} onToggle={() => edit(toggleHit(move))}>
            {handle("hitAt", move.hitAt, "Hit frame", MARKER_COLOUR.hitAt)}
            {move.hitAt !== undefined && <span className="absolute font-mono text-[11px] leading-5" style={{ left: `calc(${pct(move.hitAt)} + 10px)` }}>tick {toFrame(move.hitAt)}</span>}
          </Lane>
          <Lane label="next hit at" on={move.branchAt !== undefined} onToggle={() => edit({ ...move, branchAt: move.branchAt === undefined ? move.duration : undefined })}>
            {handle("branchAt", move.branchAt, "Combo hand-over", MARKER_COLOUR.branchAt)}
          </Lane>
          {win("chain", "chain window")}
          {win("advance", "travel")}
          {win("iframes", "i-frames")}
          <div className="pointer-events-none absolute inset-y-0" style={{ left: `calc(7rem + 0.5rem + (100% - 7.5rem) * ${scrub / frames})`, width: 1, background: "#FFB59A" }} aria-hidden />
        </div>
        <div className="mt-2 flex items-center gap-3 text-[12px]">
          <span style={muted}>Scrub</span>
          <input type="range" min={0} max={frames} value={scrub} aria-label="Scrub the move" className="flex-1" onChange={(e) => setScrub(Number(e.target.value))} />
          <span className="w-24 font-mono">tick {scrub}</span>
          <span className="w-40" style={muted}>{phase}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Num label="Hit frame" unit="tick" value={move.hitAt !== undefined ? toFrame(move.hitAt) : NaN} min={0} max={frames} step={1} disabled={move.hitAt === undefined} onChange={(f) => edit(setMarker(move, "hitAt", f / TICK_HZ))} />
        {move.advance && <Num label="Travel distance" unit="m" value={move.advance.distance} min={0} max={20} step={0.05} onChange={(distance) => edit({ ...move, advance: { ...move.advance!, distance } })} />}
        {move.chain && (
          <Field label="Chains into">
            <Select aria-label="Chains into" className="font-mono" value={move.chain.next} onChange={(e) => edit({ ...move, chain: { ...move.chain!, next: Number(e.target.value) } })}>
              {doc.moves.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Recovery move">
          <Select aria-label="Recovery move" className="font-mono" value={move.recovery ?? 0} onChange={(e) => edit(setRecovery(move, Number(e.target.value)))}>
            <option value={0}>none</option>
            {doc.moves.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <datalist id="audio-events">{events.map((e) => <option key={e} value={e} />)}</datalist>
        <Txt label="Start sound (audio event)" value={move.sound?.start ?? ""} list="audio-events" wide onChange={(v) => edit(setSound(move, "start", v))} />
        <Txt label="Hit-frame sound (audio event)" value={move.sound?.hit ?? ""} list="audio-events" wide onChange={(v) => edit(setSound(move, "hit", v))} />
      </div>
      <CheckField label="Held (the move lasts while its button is held; its clip loops)" checked={move.held === true} onChange={(held) => edit(setHeld(move, held))} />
    </div>
  );
}

function setHeld(m: CombatMove, held: boolean): CombatMove {
  const { held: _h, ...rest } = m;
  return held ? { ...rest, held: true } : rest;
}

function setRecovery(m: CombatMove, id: number): CombatMove {
  const { recovery: _r, ...rest } = m;
  return id === 0 ? rest : { ...rest, recovery: id };
}

function setSound(m: CombatMove, which: "start" | "hit", v: string): CombatMove {
  const sound = { ...(m.sound ?? {}) };
  if (v === "") delete sound[which];
  else sound[which] = v;
  const { sound: _s, ...rest } = m;
  return Object.keys(sound).length === 0 ? rest : { ...rest, sound };
}

function Lane({ label, on, onToggle, children }: { label: string; on: boolean; onToggle: () => void; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2" style={{ height: 30 }}>
      <label className="flex w-28 flex-none items-center gap-1.5 text-xs" style={muted}>
        <input type="checkbox" checked={on} aria-label={`${label} on`} onChange={onToggle} />
        {label}
      </label>
      <div className="relative h-5 flex-1 rounded-md" style={{ background: "var(--m3-surface-1)" }}>{children}</div>
    </div>
  );
}
