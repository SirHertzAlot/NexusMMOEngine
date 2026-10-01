/**
 * SettingsMenu — the player's way into settings, top right: graphics
 * quality, controls (remappable, U4), UI scale (U4), and leaving the
 * world. Audio waits for an audio engine; sliders with nothing behind
 * them would be dead UI, so it stays out (docs/ROADMAP.md U4).
 */

import { useEffect, useState } from "react";
import { Button } from "./components.js";
import {
  ACTION_LABELS,
  ACTIONS,
  FIXED_MOUSE,
  prettyCode,
  setBinding,
  type ActionId,
  type Bindings,
} from "../input/bindings.js";
import { UI_SCALES, type UiScale } from "./ui-scale.js";

export function SettingsMenu({
  quality,
  onQuality,
  onDisconnect,
  bindings,
  onBindings,
  onResetBindings,
  uiScale,
  onUiScale,
}: {
  /** The quality setting as shown ("auto (high)", "low", ...). */
  quality: string;
  onQuality: () => void;
  onDisconnect: () => void;
  bindings: Bindings;
  onBindings: (b: Bindings) => void;
  onResetBindings: () => void;
  uiScale: UiScale;
  onUiScale: (s: UiScale) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [rebinding, setRebinding] = useState<{ action: ActionId; index: number } | null>(null);
  return (
    <div className="absolute right-4 top-4 z-10 flex flex-col items-end gap-2 text-sm">
      <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Settings" title="Settings">
        ⚙ menu
      </Button>
      {open && (
        <div className="flex w-64 flex-col gap-1.5 rounded-md bg-slate-950/85 p-2 shadow backdrop-blur-sm">
          <Button size="sm" variant="secondary" onClick={onQuality} title="Cycle the graphics quality">
            graphics: {quality}
          </Button>
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            <span className="text-xs text-muted-foreground">interface size</span>
            <div className="flex gap-1">
              {UI_SCALES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={s === uiScale ? "default" : "outline"}
                  onClick={() => onUiScale(s)}
                  title={`UI scale ${s}%`}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
          <div className="px-1 pt-1 text-xs uppercase tracking-wide text-muted-foreground">controls</div>
          {ACTIONS.map((a) => (
            <div key={a} className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs text-muted-foreground">{ACTION_LABELS[a]}</span>
              <div className="flex gap-1">
                {bindings[a].map((code, i) => (
                  <Button
                    key={`${a}-${i}`}
                    size="sm"
                    variant={rebinding?.action === a && rebinding.index === i ? "default" : "outline"}
                    data-rebind={`${a}:${i}`}
                    onClick={() => setRebinding({ action: a, index: i })}
                    title={`Rebind ${ACTION_LABELS[a]}`}
                  >
                    {prettyCode(code)}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          {FIXED_MOUSE.map((m) => (
            <div key={m.code} className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs text-muted-foreground">{m.label}</span>
              <span className="text-xs text-foreground">{m.code === "Mouse0" ? "left click" : "right click"}</span>
            </div>
          ))}
          {rebinding && (
            <RebindCapture
              key={`${rebinding.action}:${rebinding.index}`}
              onDone={() => setRebinding(null)}
              onBindings={onBindings}
              bindings={bindings}
              rebinding={rebinding}
            />
          )}
          <Button size="sm" variant="ghost" onClick={onResetBindings} title="Restore default keys">
            reset keys
          </Button>
          <Button size="sm" variant="outline" onClick={onDisconnect}>
            leave the world
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Captures the next keydown for one binding slot (Escape cancels).
 * Mounted only while rebinding; steals the code from other actions.
 */
function RebindCapture({
  bindings,
  rebinding,
  onBindings,
  onDone,
}: {
  bindings: Bindings;
  rebinding: { action: ActionId; index: number };
  onBindings: (b: Bindings) => void;
  onDone: () => void;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== "Escape") {
        onBindings(setBinding(bindings, rebinding.action, rebinding.index, e.code));
      }
      onDone();
    };
    // Capture phase: beat the canvas listener so the rebinding keypress
    // never leaks into movement.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [bindings, rebinding, onBindings, onDone]);
  return <div className="px-1 text-xs text-foreground">press a key… (Esc cancels)</div>;
}
