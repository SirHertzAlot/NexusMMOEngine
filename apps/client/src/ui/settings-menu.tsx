/**
 * SettingsMenu — the player's way into settings, top right: graphics
 * quality, UI scale, audio volumes, controls (remappable), and leaving
 * the world (docs/ROADMAP.md U4).
 */

import { useEffect, useState } from "react";
import { Button } from "./components.js";
import {
  actionLabel,
  ACTIONS,
  FIXED_MOUSE,
  fixedMouseLabel,
  mouseButtonLabel,
  prettyCode,
  setBinding,
  type ActionId,
  type Bindings,
} from "../input/bindings.js";
import { UI_SCALES, type UiScale } from "./ui-scale.js";
import { AUDIO_BUSES, busLabel, type AudioBus, type Volumes } from "../audio/volumes.js";
import { lang, languageName, languages, storeLang, t } from "../i18n.js";

export function SettingsMenu({
  quality,
  onQuality,
  onDisconnect,
  bindings,
  onBindings,
  onResetBindings,
  uiScale,
  onUiScale,
  volumes,
  onVolumes,
  onPreview,
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
  volumes: Volumes;
  onVolumes: (v: Volumes) => void;
  /** Play a sample of what a bus carries, after its slider is let go. */
  onPreview: (bus: AudioBus) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [rebinding, setRebinding] = useState<{ action: ActionId; index: number } | null>(null);
  return (
    <div className="absolute right-4 top-4 z-10 flex flex-col items-end gap-2 text-sm">
      <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={t("settings.title")} title={t("settings.title")}>
        {t("settings.menu")}
      </Button>
      {open && (
        <div className="flex max-h-[calc(100vh-11rem)] w-64 flex-col gap-1.5 overflow-y-auto rounded-md bg-slate-950/85 p-2 shadow backdrop-blur-sm">
          <Button size="sm" variant="secondary" onClick={onQuality} title={t("settings.graphicsTitle")}>
            {t("settings.graphics", { quality })}
          </Button>
          <div className="flex flex-col gap-1 px-1 pt-1">
            <span className="text-xs text-muted-foreground">{t("settings.interfaceSize")}</span>
            <div className="flex gap-1">
              {UI_SCALES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={s === uiScale ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => onUiScale(s)}
                  title={t("settings.uiScale", { percent: s })}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
          {languages().length > 1 && (
            <label className="flex items-center justify-between gap-2 px-1 pt-1">
              <span className="text-xs text-muted-foreground">{t("settings.language")}</span>
              <select
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                value={lang}
                onChange={(e) => {
                  storeLang(e.target.value);
                  location.reload();
                }}
              >
                {languages().map((l) => (
                  <option key={l} value={l}>
                    {languageName(l)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("settings.audio")}</span>
            <Button
              size="sm"
              variant={volumes.muted ? "default" : "ghost"}
              className="h-6 !px-2 text-xs"
              aria-pressed={volumes.muted}
              onClick={() => onVolumes({ ...volumes, muted: !volumes.muted })}
            >
              {volumes.muted ? t("settings.muted") : t("settings.mute")}
            </Button>
          </div>
          <VolumeSlider label={t("audio.bus.master")} value={volumes.master} disabled={volumes.muted} onChange={(master) => onVolumes({ ...volumes, master })} onRelease={() => onPreview("interface")} />
          {AUDIO_BUSES.map((b) => (
            <VolumeSlider
              key={b}
              label={busLabel(b)}
              value={volumes[b]}
              disabled={volumes.muted}
              onChange={(v) => onVolumes({ ...volumes, [b]: v })}
              onRelease={() => onPreview(b)}
            />
          ))}
          <div className="px-1 pt-1 text-xs uppercase tracking-wide text-muted-foreground">{t("settings.controls")}</div>
          {ACTIONS.map((a) => (
            <div key={a} className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs text-muted-foreground">{actionLabel(a)}</span>
              <div className="flex gap-1">
                {bindings[a].map((code, i) => (
                  <Button
                    key={`${a}-${i}`}
                    size="sm"
                    variant={rebinding?.action === a && rebinding.index === i ? "default" : "outline"}
                    data-rebind={`${a}:${i}`}
                    onClick={() => setRebinding({ action: a, index: i })}
                    title={t("settings.rebind", { action: actionLabel(a) })}
                  >
                    {prettyCode(code)}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          {FIXED_MOUSE.map((m) => (
            <div key={m.code} className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs text-muted-foreground">{fixedMouseLabel(m)}</span>
              <span className="text-xs text-foreground">{mouseButtonLabel(m.code)}</span>
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
          <Button size="sm" variant="ghost" onClick={onResetBindings} title={t("settings.resetKeysTitle")}>
            {t("settings.resetKeys")}
          </Button>
          <Button size="sm" variant="outline" onClick={onDisconnect}>
            {t("settings.leave")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** One 0–100 % volume row. */
function VolumeSlider({
  label,
  value,
  disabled,
  onChange,
  onRelease,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
  onRelease: () => void;
}): React.ReactElement {
  const pct = Math.round(value * 100);
  return (
    <label className={`flex items-center gap-2 px-1 ${disabled ? "opacity-50" : ""}`}>
      <span className="w-16 text-xs text-muted-foreground">{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={pct}
        disabled={disabled}
        aria-label={t("settings.volume", { label })}
        className="h-1.5 flex-1 cursor-pointer accent-primary"
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        onPointerUp={onRelease}
      />
      <span className="w-8 text-right text-xs tabular-nums text-foreground">{pct}</span>
    </label>
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
  return <div className="px-1 text-xs text-foreground">{t("settings.pressKey")}</div>;
}
