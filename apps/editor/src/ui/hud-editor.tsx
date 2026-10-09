/**
 * HUD layout editor (roadmap EA23): the widgets of `content/ui/hud.json`
 * drawn over a preview at a chosen resolution and UI scale. Drag a widget
 * (or nudge it with the arrow keys), re-anchor it, resize it, hide it, set
 * the theme colours; overlaps and off-screen widgets are flagged live, and
 * the matrix shows every resolution x UI scale at once. Save validates on
 * the host and writes the file the client reads (a running client dev
 * server reloads on it).
 *
 * Three panels share one store: the catalog (left dock), the preview
 * (centre) and the inspector (right dock).
 */
import * as React from "react";
import {
  HUD_ANCHORS,
  HUD_CATALOG,
  HUD_RESOLUTIONS,
  HUD_SCALES,
  HUD_THEME_TOKENS,
  hudProblems,
  hudReport,
  widgetRect,
  type HudDoc,
  type SceneIssue,
} from "@mmo-engine/scene";
import { getHud, saveHud, UiSaveError } from "../ui-client.js";
import {
  hudDirty,
  hudDragEnd,
  hudDragStart,
  hudDragWidget,
  hudMarkSaved,
  hudModel,
  hudPatchWidget,
  hudReanchor,
  hudRedo,
  hudRevert,
  hudSetTheme,
  hudUndo,
  widgetProblems,
  type HudModel,
} from "../hud-model.js";
import { MIcon } from "./components.js";
import { clearDocActions, registerDocActions } from "./doc-actions.js";

// ---------------------------------------------------------------- store

interface HudUi {
  model: HudModel | null;
  sel: string | null;
  res: number;
  scale: number;
  status: string;
  refused: SceneIssue[];
}
let ui: HudUi = { model: null, sel: null, res: 3, scale: 100, status: "loading…", refused: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<HudUi>): void => {
  ui = { ...ui, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const useHud = (): HudUi => React.useSyncExternalStore(subscribe, () => ui);
const edit = (f: (m: HudModel) => HudModel): void => {
  if (ui.model) set({ model: f(ui.model), refused: [] });
};

let loading = false;
export function loadHudDoc(): void {
  if (loading) return;
  loading = true;
  set({ status: "loading…" });
  getHud()
    .then((b) => set({ model: hudModel(b.content), status: "", sel: ui.sel ?? HUD_CATALOG[0].id }))
    .catch((e: unknown) => set({ status: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      loading = false;
    });
}

async function save(): Promise<void> {
  const m = ui.model;
  if (!m) return;
  try {
    await saveHud(m.doc);
    set({ model: hudMarkSaved(m), refused: [], status: "saved to content/ui/hud.json: a running client reloads on it" });
  } catch (e) {
    if (e instanceof UiSaveError) set({ refused: e.issues });
    set({ status: e instanceof Error ? `refused: ${e.message}` : String(e) });
  }
}

const vp = (s: HudUi): { w: number; h: number } => HUD_RESOLUTIONS[s.res];
const btn = "m3-focus rounded-full px-3 py-1 text-[13px] font-medium";
const outline = { border: "1px solid var(--m3-outline-variant)" } as const;
const label = (id: string): string => HUD_CATALOG.find((c) => c.id === id)?.label ?? id;
const THEME_DEFAULT: Record<string, string> = {
  card: "#10162b",
  "card-foreground": "#f8fafc",
  primary: "#3b82f6",
  border: "#2a3a5c",
  "muted-foreground": "#94a3b8",
  accent: "#1f2e4d",
};

// ---------------------------------------------------------------- centre

export function HudEditor(): React.JSX.Element {
  const s = useHud();
  React.useEffect(() => {
    if (!ui.model) loadHudDoc();
  }, []);
  const m = s.model;
  React.useEffect(() => {
    if (!m) return;
    const target = {
      label: "HUD layout",
      canSave: hudDirty(m),
      canUndo: m.past.length > 0,
      canRedo: m.future.length > 0,
      save: () => void save(),
      undo: () => edit(hudUndo),
      redo: () => edit(hudRedo),
    };
    registerDocActions(target);
    return () => clearDocActions(target);
  });
  const wrap = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(720);
  React.useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [m === null]);
  const drag = React.useRef<{ id: string; sx: number; sy: number; start: HudDoc } | null>(null);

  if (!m) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-[13px]">
        <p>HUD layout: {s.status}</p>
        {s.status !== "loading…" && (
          <button className={btn} style={outline} onClick={() => loadHudDoc()}>
            Retry
          </button>
        )}
      </div>
    );
  }
  const doc = m.doc;
  const res = vp(s);
  const f = width / res.w;
  const here = hudProblems(doc, res, s.scale);
  const matrix = hudReport(doc);
  const flagged = matrix.filter((c) => c.overlaps.length + c.offscreen.length > 0).length;
  const dirty = hudDirty(m);
  const colour = (t: string): string => doc.theme[t] ?? THEME_DEFAULT[t];
  const hot = new Set([...here.overlaps.flat(), ...here.offscreen]);

  return (
    <div className="flex flex-col gap-3 p-3" style={{ color: "var(--m3-on-surface)" }}>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-mono" style={{ color: "var(--m3-on-surface-variant)" }}>content/ui/hud.json</span>
        <label className="flex items-center gap-1.5">
          Resolution
          <select
            className="m3-focus rounded-md px-2 py-1 text-[13px]"
            style={{ background: "var(--m3-surface-1)", border: "1px solid var(--m3-outline-variant)" }}
            value={s.res}
            aria-label="Resolution"
            onChange={(e) => set({ res: Number(e.target.value) })}
          >
            {HUD_RESOLUTIONS.map((r, i) => (
              <option key={i} value={i}>{r.w} × {r.h}</option>
            ))}
          </select>
        </label>
        <div className="flex h-8 items-center overflow-hidden rounded-full" style={outline} role="group" aria-label="UI scale">
          {HUD_SCALES.map((sc) => (
            <button
              key={sc}
              className="m3-focus flex h-full items-center px-3 font-mono text-xs"
              style={sc === s.scale ? { background: "var(--m3-secondary-container)" } : undefined}
              aria-pressed={sc === s.scale}
              onClick={() => set({ scale: sc })}
            >
              {sc} %
            </button>
          ))}
        </div>
        <span style={{ color: here.overlaps.length + here.offscreen.length ? "#E8A33D" : "#6FCF97" }}>
          {here.overlaps.length + here.offscreen.length
            ? `${here.overlaps.length} overlap${here.overlaps.length === 1 ? "" : "s"}, ${here.offscreen.length} off screen here`
            : "no overlaps here"}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <span style={{ color: "#E8A33D" }}>unsaved</span>}
          <button className={btn} style={outline} disabled={m.past.length === 0} onClick={() => edit(hudUndo)}>Undo</button>
          <button className={btn} style={outline} disabled={m.future.length === 0} onClick={() => edit(hudRedo)}>Redo</button>
          <button className={btn} style={outline} disabled={!dirty} onClick={() => edit(hudRevert)}>Revert</button>
          <button className={btn} style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)", opacity: dirty ? 1 : 0.5 }} disabled={!dirty} onClick={() => void save()}>
            Save
          </button>
        </span>
      </div>
      {s.status && <div className="text-[12px]" style={{ color: "var(--m3-on-surface-variant)" }}>{s.status}</div>}
      {s.refused.length > 0 && (
        <ul className="rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(232,163,61,.14)", color: "#E8A33D" }} aria-label="HUD problems">
          {s.refused.map((i, k) => (
            <li key={k}><span className="font-mono">{i.path || "hud"}</span>: {i.message}</li>
          ))}
        </ul>
      )}

      <div ref={wrap} className="w-full">
        <div
          className="relative overflow-hidden rounded-xl outline-none"
          style={{
            width,
            height: res.h * f,
            background: "linear-gradient(180deg,#2b3358 0%,#2b3358 42%,#2b5a8a 46%,#3f7a45 50%,#2f6136 100%)",
            touchAction: "none",
          }}
          tabIndex={0}
          role="application"
          aria-label={`HUD preview at ${res.w} by ${res.h}, ${s.scale} percent`}
          onKeyDown={(e) => {
            const id = s.sel;
            if (!id || !doc.widgets[id]) return;
            const d = e.shiftKey ? 10 : 1;
            const k: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
            const v = k[e.key];
            if (!v) return;
            e.preventDefault();
            const start = hudDragStart(m);
            edit((cur) => hudDragEnd(hudDragWidget(cur, start, id, v[0] * (s.scale / 100), v[1] * (s.scale / 100), s.scale), start));
          }}
        >
          {Object.entries(doc.widgets).map(([id, w]) => {
            if (w.visible === false) return null;
            const r = widgetRect(w, res, s.scale);
            const on = id === s.sel;
            const bad = hot.has(id);
            return (
              <div
                key={id}
                data-widget={id}
                role="button"
                aria-label={label(id)}
                aria-pressed={on}
                className="absolute cursor-move select-none overflow-hidden rounded-md p-1.5 text-left"
                style={{
                  left: r.x * f,
                  top: r.y * f,
                  width: r.w * f,
                  height: r.h * f,
                  background: `${colour("card")}d9`,
                  color: colour("card-foreground"),
                  border: `${on ? 2 : 1}px ${bad ? "dashed" : "solid"} ${bad ? "#E8A33D" : on ? colour("primary") : colour("border")}`,
                  boxShadow: on ? `0 0 0 2px ${colour("primary")}` : undefined,
                  fontSize: Math.max(9, 12 * f * 1.6),
                  touchAction: "none",
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = { id, sx: e.clientX, sy: e.clientY, start: hudDragStart(m) };
                  set({ sel: id });
                  wrap.current?.querySelector<HTMLElement>("[role=application]")?.focus();
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d || d.id !== id) return;
                  edit((cur) => hudDragWidget(cur, d.start, id, (e.clientX - d.sx) / f, (e.clientY - d.sy) / f, s.scale));
                }}
                onPointerUp={() => {
                  const d = drag.current;
                  drag.current = null;
                  if (d) edit((cur) => hudDragEnd(cur, d.start));
                }}
              >
                <div className="truncate font-semibold">{label(id)}</div>
                <div className="truncate" style={{ color: colour("muted-foreground") }}>{w.anchor} · {w.w}×{w.h}</div>
              </div>
            );
          })}
        </div>
      </div>
      {(here.overlaps.length > 0 || here.offscreen.length > 0) && (
        <ul className="rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(232,163,61,.14)", color: "#E8A33D" }} aria-label="Problems at this size">
          {here.overlaps.map(([a, b]) => (
            <li key={`${a}-${b}`}>{label(a)} overlaps {label(b)}</li>
          ))}
          {here.offscreen.map((a) => (
            <li key={a}>{label(a)} is not fully on screen</li>
          ))}
        </ul>
      )}

      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
          Every resolution and UI scale · {flagged === 0 ? "no overlaps anywhere" : `${flagged} of ${matrix.length} flagged`}
        </p>
        <table className="border-collapse text-[12px]" aria-label="Overlap matrix">
          <thead>
            <tr>
              <th className="px-2 text-left font-medium" style={{ color: "var(--m3-on-surface-variant)" }}>resolution</th>
              {HUD_SCALES.map((sc) => (
                <th key={sc} className="px-2 font-mono font-medium" style={{ color: "var(--m3-on-surface-variant)" }}>{sc} %</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HUD_RESOLUTIONS.map((r, ri) => (
              <tr key={ri}>
                <td className="px-2 font-mono">{r.w} × {r.h}</td>
                {HUD_SCALES.map((sc) => {
                  const c = matrix.find((x) => x.w === r.w && x.h === r.h && x.scale === sc)!;
                  const n = c.overlaps.length + c.offscreen.length;
                  const cur = ri === s.res && sc === s.scale;
                  return (
                    <td key={sc} className="p-0.5">
                      <button
                        className="m3-focus w-full rounded-md px-2 py-1 font-mono"
                        style={{
                          background: n ? "rgba(232,163,61,.2)" : "rgba(111,207,151,.14)",
                          color: n ? "#E8A33D" : "#6FCF97",
                          outline: cur ? "2px solid var(--m3-primary)" : undefined,
                        }}
                        title={n ? [...c.overlaps.map(([a, b]) => `${label(a)} / ${label(b)}`), ...c.offscreen.map((a) => `${label(a)} off screen`)].join("\n") : "clean"}
                        onClick={() => set({ res: ri, scale: sc })}
                      >
                        {n ? n : "ok"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- left dock

export function HudCatalog(): React.JSX.Element {
  const s = useHud();
  React.useEffect(() => {
    if (!ui.model) loadHudDoc();
  }, []);
  const m = s.model;
  const here = m ? hudProblems(m.doc, vp(s), s.scale) : null;
  return (
    <ul className="flex flex-col gap-0.5" aria-label="HUD widgets">
      {HUD_CATALOG.map((c) => {
        const w = m?.doc.widgets[c.id];
        const on = c.id === s.sel;
        const bad = here ? widgetProblems(here, c.id) : null;
        const hidden = w?.visible === false;
        return (
          <li key={c.id} className="flex items-center gap-0.5 rounded-full" style={on ? { background: "var(--m3-secondary-container)" } : undefined}>
            <button
              onClick={() => set({ sel: c.id })}
              className="m3-focus flex h-10 min-w-0 flex-1 items-center gap-3 rounded-full px-3 text-sm"
              style={{ color: on ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface)", opacity: hidden ? 0.55 : 1 }}
              title={c.note}
            >
              <MIcon name="widgets" size={19} />
              <span className="truncate">{c.label}</span>
              {bad && (bad.overlaps.length > 0 || bad.offscreen) && <span title="overlaps or off screen at this size" style={{ color: "#E8A33D" }}><MIcon name="warning" size={16} /></span>}
            </button>
            <button
              className="m3-focus flex h-8 w-8 flex-none items-center justify-center rounded-full"
              aria-label={hidden ? `Show ${c.label}` : `Hide ${c.label}`}
              aria-pressed={!hidden}
              onClick={() => edit((cur) => hudPatchWidget(cur, c.id, { visible: hidden ? true : false }))}
            >
              <MIcon name={hidden ? "visibility_off" : "visibility"} size={18} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- right dock

function NumField({ label: l, value, onCommit, min }: { label: string; value: number; onCommit: (n: number) => void; min?: number }): React.JSX.Element {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const n = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(n) && (min === undefined || n >= min)) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <label className="flex flex-col gap-0.5 text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
      {l}
      <input
        className="m3-focus rounded-md px-2 py-1 font-mono text-[13px]"
        style={{ background: "var(--m3-surface-1)", color: "var(--m3-on-surface)", border: "1px solid var(--m3-outline-variant)" }}
        value={draft}
        inputMode="decimal"
        aria-label={l}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(String(value));
        }}
      />
    </label>
  );
}

export function HudInspector(): React.JSX.Element {
  const s = useHud();
  const m = s.model;
  if (!m) return <p className="text-[13px]">{s.status || "HUD layout not loaded"}</p>;
  const id = s.sel && m.doc.widgets[s.sel] ? s.sel : null;
  const w = id ? m.doc.widgets[id] : null;
  const res = vp(s);
  const p = id ? widgetProblems(hudProblems(m.doc, res, s.scale), id) : null;
  const rect = w ? widgetRect(w, res, s.scale) : null;
  return (
    <div className="flex flex-col gap-2">
      {id && w ? (
        <>
          <p className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{id.toUpperCase()} · ANCHOR</p>
          <div className="grid grid-cols-3 gap-1" role="group" aria-label="Anchor">
            {HUD_ANCHORS.map((a) => (
              <button
                key={a}
                className="m3-focus rounded-md"
                style={{ height: 30, background: a === w.anchor ? "var(--m3-primary)" : "var(--m3-surface-3)" }}
                aria-label={a}
                aria-pressed={a === w.anchor}
                title={a}
                onClick={() => edit((cur) => hudReanchor(cur, id, a, res, s.scale))}
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Offset x" value={w.x} onCommit={(n) => edit((cur) => hudPatchWidget(cur, id, { x: n }))} />
            <NumField label="Offset y" value={w.y} onCommit={(n) => edit((cur) => hudPatchWidget(cur, id, { y: n }))} />
            <NumField label="Width" value={w.w} min={1} onCommit={(n) => edit((cur) => hudPatchWidget(cur, id, { w: n }))} />
            <NumField label="Height" value={w.h} min={1} onCommit={(n) => edit((cur) => hudPatchWidget(cur, id, { h: n }))} />
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={w.visible !== false} onChange={(e) => edit((cur) => hudPatchWidget(cur, id, { visible: e.target.checked }))} />
            Visible in the client
          </label>
          {rect && (
            <p className="text-[12px]" style={{ color: "var(--m3-on-surface-variant)" }}>
              On screen at {res.w}×{res.h}, {s.scale}%: {Math.round(rect.x)},{Math.round(rect.y)} · {Math.round(rect.w)}×{Math.round(rect.h)} px
            </p>
          )}
          {p && (p.overlaps.length > 0 || p.offscreen) ? (
            <ul className="rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(232,163,61,.14)", color: "#E8A33D" }}>
              {p.overlaps.map((o) => (
                <li key={o}>overlaps {label(o)}</li>
              ))}
              {p.offscreen && <li>not fully on screen</li>}
            </ul>
          ) : (
            <p className="text-[12px]" style={{ color: "#6FCF97" }}>no overlaps at this size</p>
          )}
        </>
      ) : (
        <p className="text-[13px]" style={{ color: "var(--m3-on-surface-variant)" }}>Pick a widget in the list or the preview.</p>
      )}
      <p className="mt-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Theme tokens</p>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
        {HUD_THEME_TOKENS.map((t) => (
          <label key={t} className="flex items-center gap-2 text-[12px]">
            <input
              type="color"
              aria-label={`Theme ${t}`}
              className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
              value={m.doc.theme[t] ?? THEME_DEFAULT[t]}
              onChange={(e) => edit((cur) => hudSetTheme(cur, t, e.target.value))}
            />
            <span className="truncate">{t}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
