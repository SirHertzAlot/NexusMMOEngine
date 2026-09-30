/**
 * The dev HUD: floating panels over the world that the player arranges.
 *
 * - Drag a panel by its title bar; resize it from its bottom-right corner.
 * - Fade it with its opacity slider, fold it to its title (▾), or close it
 *   (×).
 * - The "dev" launcher (bottom left) reopens closed panels and resets the
 *   layout.
 * - The ` key hides every panel at once, to see the game as a player
 *   does, and brings them back.
 *
 * The layout lives in this component, so dragging re-renders only the
 * panels and never the world; dev-layout.ts keeps it in localStorage.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  browserStorage,
  clampPanel,
  loadLayout,
  MIN_H,
  MIN_OPACITY,
  MIN_W,
  saveLayout,
  type DevLayout,
  type PanelLayout,
} from "./dev-layout.js";

export interface DevPanelSpec {
  id: string;
  title: string;
  /** Its name in the dev menu (default: the title). */
  label?: string;
  /** Shown in the title bar next to the title (a warning badge). */
  badge?: React.ReactNode;
  content: React.ReactNode;
}

export function DevHud({ panels, defaults }: { panels: DevPanelSpec[]; defaults: (viewport: Viewport) => DevLayout }): React.ReactElement {
  const [layout, setLayout] = useState<DevLayout>(() => {
    const vp = viewport();
    const l = loadLayout(browserStorage(), defaults(vp));
    return clampAll(l, vp);
  });
  const [menu, setMenu] = useState(false);

  useEffect(() => saveLayout(browserStorage(), layout), [layout]);

  // A smaller window pulls the panels back on screen.
  useEffect(() => {
    const onResize = (): void => setLayout((l) => clampAll(l, viewport()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ` hides (and shows) every dev panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "Backquote" || e.repeat || isTyping(e.target)) return;
      setLayout((l) => ({ ...l, hidden: !l.hidden }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const update = useCallback((id: string, patch: Partial<PanelLayout>) => {
    setLayout((l) => ({ ...l, panels: { ...l.panels, [id]: clampPanel({ ...l.panels[id], ...patch }, viewport()) } }));
  }, []);

  if (layout.hidden) {
    return (
      <div className="pointer-events-none absolute bottom-2 left-3 z-10 text-[10px] text-slate-300/40 select-none">` dev hud</div>
    );
  }
  return (
    <>
      {panels.map((p) => {
        const l = layout.panels[p.id];
        return l?.open ? <DevPanel key={p.id} spec={p} layout={l} onChange={(patch) => update(p.id, patch)} /> : null;
      })}
      <div className="absolute bottom-3 left-3 z-20 text-xs">
        {menu && (
          <div className="mb-1 w-48 rounded-md bg-slate-950/90 p-2 shadow backdrop-blur-sm">
            {panels.map((p) => (
              <label key={p.id} className="flex cursor-pointer items-center gap-2 py-0.5 text-foreground">
                <input
                  type="checkbox"
                  checked={layout.panels[p.id]?.open ?? false}
                  onChange={(e) => update(p.id, { open: e.target.checked, collapsed: false })}
                />
                {p.label ?? p.title}
              </label>
            ))}
            <div className="mt-1 flex items-center justify-between border-t border-slate-700/60 pt-1 text-muted-foreground">
              <button className="hover:text-foreground" onClick={() => setLayout(clampAll(defaults(viewport()), viewport()))}>
                reset layout
              </button>
              <span title="Hide or show every dev panel">` hides all</span>
            </div>
          </div>
        )}
        <button
          className="rounded bg-slate-950/70 px-2 py-0.5 text-muted-foreground shadow hover:text-foreground"
          onClick={() => setMenu((m) => !m)}
          title="Dev panels"
          aria-label="Dev panels"
          aria-expanded={menu}
        >
          dev {menu ? "▾" : "▸"}
        </button>
      </div>
    </>
  );
}

/** One panel: a title bar to drag, its controls, the content, and a corner to resize. */
function DevPanel({ spec, layout, onChange }: { spec: DevPanelSpec; layout: PanelLayout; onChange: (patch: Partial<PanelLayout>) => void }): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "move" | "size"; px: number; py: number; x: number; y: number; w: number; h: number } | null>(null);

  const start = (mode: "move" | "size") => (e: React.PointerEvent): void => {
    if (e.button !== 0 || (mode === "move" && isControl(e.target))) return;
    const el = box.current!;
    drag.current = { mode, px: e.clientX, py: e.clientY, x: layout.x, y: layout.y, w: el.offsetWidth, h: el.offsetHeight };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const move = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (d.mode === "move") onChange({ x: d.x + dx, y: d.y + dy });
    else onChange({ w: Math.max(MIN_W, d.w + dx), h: Math.max(MIN_H, d.h + dy) });
  };
  const end = (e: React.PointerEvent): void => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={box}
      data-panel={spec.id}
      className="absolute z-10 flex flex-col overflow-hidden rounded-md bg-slate-950/75 text-xs shadow backdrop-blur-sm"
      style={{ left: layout.x, top: layout.y, width: layout.w, height: layout.collapsed ? undefined : layout.h ?? undefined, opacity: layout.opacity }}
    >
      <div
        className="flex cursor-move select-none items-center gap-2 border-b border-slate-700/50 px-2 py-1"
        onPointerDown={start("move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <span className="truncate font-medium text-foreground">{spec.title}</span>
        {spec.badge}
        <input
          type="range"
          min={MIN_OPACITY}
          max={1}
          step={0.05}
          value={layout.opacity}
          onChange={(e) => onChange({ opacity: Number(e.target.value) })}
          className="ml-auto h-1 w-14 cursor-pointer accent-sky-400"
          title={`Opacity ${Math.round(layout.opacity * 100)}%`}
          aria-label={`${spec.title} opacity`}
        />
        <button
          className="w-4 text-muted-foreground hover:text-foreground"
          onClick={() => onChange({ collapsed: !layout.collapsed })}
          title={layout.collapsed ? "Unfold" : "Fold to the title"}
          aria-label={`${layout.collapsed ? "unfold" : "fold"} ${spec.title}`}
        >
          {layout.collapsed ? "▸" : "▾"}
        </button>
        <button
          className="w-4 text-muted-foreground hover:text-foreground"
          onClick={() => onChange({ open: false })}
          title="Close (reopen from the dev menu)"
          aria-label={`close ${spec.title}`}
        >
          ×
        </button>
      </div>
      {!layout.collapsed && (
        <>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">{spec.content}</div>
          <div
            className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize"
            style={{ background: "linear-gradient(135deg, transparent 50%, rgb(148 163 184 / 0.6) 50%)" }}
            onPointerDown={start("size")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            title="Resize"
          />
        </>
      )}
    </div>
  );
}

export interface Viewport {
  width: number;
  height: number;
}

function viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function clampAll(l: DevLayout, vp: Viewport): DevLayout {
  const panels: Record<string, PanelLayout> = {};
  for (const [id, p] of Object.entries(l.panels)) panels[id] = clampPanel(p, vp);
  return { ...l, panels };
}

function isControl(t: EventTarget): boolean {
  return t instanceof HTMLElement && t.closest("button, input, select, textarea, a") !== null;
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && (t as HTMLInputElement).type !== "range" && (t as HTMLInputElement).type !== "checkbox";
}
