/**
 * EA23 HUD drag editor: move widgets on a screen-sized canvas, change
 * anchors, flag overlaps, save to content/ui/hud.json.
 */
import * as React from "react";
import { callEnvelope } from "../../../apps/editor/src/api.js";
import { Select } from "../../../apps/editor/src/ui/components.js";
import { useDrag } from "../../../apps/editor/src/ui/use-drag.js";
import { Pill } from "../../../apps/editor/src/ui/widgets.js";
import {
  widgetRect,
  findOverlaps,
  moveWidget,
  type Anchor,
  type WidgetPlacement,
  type WidgetBox,
} from "./hud-editor-logic.js";

interface Layout {
  widgets: Record<string, WidgetPlacement>;
}

const ANCHORS: Anchor[] = [
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right",
];

// Approximate widget sizes for the canvas (the real widgets vary).
const WIDGET_SIZES: Record<string, { w: number; h: number }> = {
  "player-frame": { w: 280, h: 120 },
  "cast-bar": { w: 280, h: 24 },
  "friends-frame": { w: 220, h: 140 },
  "chat-panel": { w: 420, h: 220 },
  "quest-tracker": { w: 240, h: 160 },
  "target-frame": { w: 260, h: 80 },
  "bag-panel": { w: 320, h: 240 },
  "quest-log": { w: 360, h: 400 },
  "character-sheet": { w: 400, h: 500 },
  "party-frame": { w: 210, h: 120 },
  "guild-frame": { w: 210, h: 160 },
};

const SCREEN = { w: 960, h: 540 }; // 16:9 preview, half scale.

export function HudEditor(): React.JSX.Element {
  const [layout, setLayout] = React.useState<Layout | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    callEnvelope<{ layout: Layout }>("/api/editor/hud/layout", "GET")
      .then(({ layout: l }) => {
        setLayout(l);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const boxes: WidgetBox[] = React.useMemo(() => {
    if (!layout) return [];
    // Scale the 1920x1080 layout to the preview canvas.
    const scale = SCREEN.w / 1920;
    return Object.entries(layout.widgets)
      .filter(([, p]) => p.visible)
      .map(([id, p]) => {
        const size = WIDGET_SIZES[id] ?? { w: 200, h: 100 };
        const r = widgetRect(p, size, { w: 1920, h: 1080 });
        return { id, x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale };
      });
  }, [layout]);

  const overlaps = React.useMemo(() => findOverlaps(boxes), [boxes]);

  const drag = useDrag<{ id: string }>({
    threshold: 0,
    move: (_e, g, d) => {
      if (!layout) return;
      const scale = SCREEN.w / 1920;
      const delta = { dx: d.stepX / scale, dy: d.stepY / scale };
      setLayout((cur) => {
        if (!cur) return cur;
        const p = cur.widgets[g.id];
        if (!p) return cur;
        const size = WIDGET_SIZES[g.id] ?? { w: 200, h: 100 };
        return { widgets: { ...cur.widgets, [g.id]: moveWidget(p, delta, { w: 1920, h: 1080 }, size) } };
      });
      setSaved(false);
    },
  });

  const setAnchor = (id: string, anchor: Anchor): void => {
    setLayout((cur) => {
      if (!cur || !cur.widgets[id]) return cur;
      return { widgets: { ...cur.widgets, [id]: { ...cur.widgets[id]!, anchor } } };
    });
    setSaved(false);
  };

  const toggleVisible = (id: string): void => {
    setLayout((cur) => {
      if (!cur || !cur.widgets[id]) return cur;
      return { widgets: { ...cur.widgets, [id]: { ...cur.widgets[id]!, visible: !cur.widgets[id]!.visible } } };
    });
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    if (!layout) return;
    setError(null);
    try {
      await callEnvelope("/api/editor/hud/layout", "PUT", { layout });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error && !layout) {
    return <p style={{ color: "var(--m3-error)" }}>{error}</p>;
  }
  if (!layout) return <p>Loading…</p>;

  const sel = selected ? layout.widgets[selected] : null;

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="rounded-xl p-3 text-sm" style={{ background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" }}>
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void save()}
          className="rounded-full px-4 py-1.5 text-sm font-semibold"
          style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)" }}
        >
          💾 Save layout
        </button>
        {saved && <Pill tone="ok">saved</Pill>}
        {overlaps.length > 0 && (
          <Pill tone="err">{overlaps.length} overlap{overlaps.length > 1 ? "s" : ""}</Pill>
        )}
        <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          Drag widgets on the canvas. The client reads content/ui/hud.json on load.
        </span>
      </div>

      {overlaps.length > 0 && (
        <p className="text-xs" style={{ color: "var(--m3-error)" }}>
          Overlapping: {overlaps.map(([a, b]) => `${a} ↔ ${b}`).join(", ")}
        </p>
      )}

      <div className="flex gap-3">
        <div
          className="relative shrink-0 rounded-xl"
          style={{ width: SCREEN.w, height: SCREEN.h, background: "var(--m3-surface-2)", cursor: "default" }}
          {...drag.handlers}
        >
          {boxes.map((b) => (
            <div
              key={b.id}
              onPointerDown={(e) => {
                setSelected(b.id);
                e.preventDefault();
                drag.begin(e, { id: b.id });
              }}
              className="absolute rounded-lg border-2 text-xs"
              style={{
                left: b.x,
                top: b.y,
                width: b.w,
                height: b.h,
                borderColor: b.id === selected ? "var(--m3-primary)" : "var(--m3-outline-variant)",
                background: "var(--m3-surface-0)",
                cursor: "move",
                opacity: 0.92,
              }}
            >
              <span className="px-1 font-mono">{b.id}</span>
            </div>
          ))}
        </div>

        <div className="min-w-52 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-2 text-sm font-medium">Widgets</p>
          <div className="flex flex-col gap-1">
            {Object.entries(layout.widgets).map(([id, p]) => (
              <button
                key={id}
                onClick={() => setSelected(id)}
                className="rounded-lg px-2 py-1 text-left text-xs"
                style={{
                  background: id === selected ? "var(--m3-primary-container)" : "transparent",
                  color: id === selected ? "var(--m3-on-primary-container)" : "var(--m3-on-surface)",
                }}
              >
                <span className="font-mono">{id}</span>{" "}
                <span style={{ color: "var(--m3-on-surface-variant)" }}>{p.anchor}</span>
                {!p.visible && <span> (hidden)</span>}
              </button>
            ))}
          </div>
          {sel && selected && (
            <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--m3-outline-variant)" }}>
              <p className="mb-1 font-mono text-xs">{selected}</p>
              <label className="mb-2 block text-xs">
                Anchor{" "}
                <Select size="xs"
                  value={sel.anchor}
                  onChange={(e) => setAnchor(selected, e.target.value as Anchor)}
                 
                >
                  {ANCHORS.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </Select>
              </label>
              <p className="mb-2 font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
                offset {sel.offset.x}, {sel.offset.y}
              </p>
              <button
                onClick={() => toggleVisible(selected)}
                className="rounded-full px-3 py-1 text-xs"
                style={{ background: "var(--m3-surface-0)", border: "1px solid var(--m3-outline-variant)" }}
              >
                {sel.visible ? "Hide" : "Show"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
