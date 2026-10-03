/**
 * Play-mode debugger (ROADMAP E5) — the developer panels over the game view.
 *
 * The developer client's own dockable HUD (`@mmo-engine/client/debug`):
 * panels you drag, resize, fade, fold and close, ` hides them all, and
 * the "dev" menu reopens them or resets the layout. Here they sit inside
 * the game view rather than the window, and the layout is kept per
 * browser (the editor's origin, so it is apart from the client's).
 *
 * - status: tick, time, weather, fps, position, movement mode, the GPU
 * - performance: the last minute of fps, frame time, draw calls and
 *   triangles over every pass, props by level of detail, GPU memory,
 *   network in and out, JS heap
 * - tools: wireframe terrain, quality preset, FX showcase, maximize, and
 *   the admin console (protocol 0x10)
 * - controls: the key bindings
 */

import * as React from "react";
import type { MirrorClient } from "@mmo-engine/mirror";
import { QUALITY_TIERS, type GpuInfo, type HudData, type QualityTier } from "@mmo-engine/client/render";
import {
  ACTION_LABELS,
  ACTIONS,
  AdminConsole,
  DevHud,
  FIXED_MOUSE,
  PerfHud,
  prettyCode,
  type DevPanelSpec,
} from "@mmo-engine/client/debug";
import { debuggerLayoutDefaults } from "../debugger-layout.js";
import { DEFAULT_BINDINGS } from "@mmo-engine/client/render";
import { GameView } from "./game-view.js";
import { Button } from "./components.js";

const MODE_LABEL = ["walking", "swimming", "flying"];
const QUALITY_CYCLE: ("auto" | QualityTier)[] = ["auto", ...QUALITY_TIERS];

export interface PlayDebuggerProps {
  client: MirrorClient;
  url: string;
  lastStateAt: () => number;
  onHud?: (hud: HudData) => void;
}

export function PlayDebugger({ client, url, lastStateAt, onHud }: PlayDebuggerProps): React.JSX.Element {
  const [hud, setHud] = React.useState<HudData | null>(null);
  const [gpu, setGpu] = React.useState<GpuInfo | null>(null);
  const [wireframe, setWireframe] = React.useState(false);
  const [showcase, setShowcase] = React.useState(false);
  const [maximized, setMaximized] = React.useState(false);
  const [quality, setQuality] = React.useState<"auto" | QualityTier>("auto");
  const [activeQuality, setActiveQuality] = React.useState<{ active: QualityTier; detected: QualityTier | null } | null>(null);
  // The panels mount once the view's frame exists, so their first layout fits it.
  const [frame, setFrame] = React.useState<HTMLDivElement | null>(null);
  const bounds = React.useMemo(() => ({ current: frame }), [frame]);

  const onHudBoth = React.useCallback(
    (h: HudData) => {
      setHud(h);
      onHud?.(h);
    },
    [onHud],
  );
  const onQuality = React.useCallback((active: QualityTier, detected: QualityTier | null) => setActiveQuality({ active, detected }), []);
  const cycleQuality = (): void => setQuality((q) => QUALITY_CYCLE[(QUALITY_CYCLE.indexOf(q) + 1) % QUALITY_CYCLE.length]);

  // Esc leaves the maximized view (once the pointer is free: the first Esc releases it).
  React.useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === "Escape" && document.pointerLockElement === null) setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  const panels: DevPanelSpec[] = [
    {
      id: "status",
      title: "status",
      badge: gpu?.software && (
        <span
          className="shrink-0 rounded border border-amber-400/60 px-1 text-[10px] text-amber-300"
          title="Software rendering: hardware acceleration is off, so fps stays low. Enable it in browser settings (see chrome://gpu)."
        >
          ⚠ software GPU
        </span>
      ),
      content: hud ? (
        <div className="text-muted-foreground tabular-nums" data-testid="debugger-status">
          tick <span className="text-foreground">{hud.tick}</span>
          {hud.time && <> · <span className="text-foreground">{hud.time}</span></>}
          {hud.weather && <> · <span className="text-foreground">{hud.weather}</span></>}
          {" "}· <span className="text-foreground">{hud.fps}</span> fps · {hud.entities} entities · pos{" "}
          <span className="text-foreground">
            {hud.px.toFixed(0)}, {hud.py.toFixed(0)}, {hud.pz.toFixed(0)}
          </span>
          {hud.mode !== null && hud.mode !== 0 && <> · {MODE_LABEL[hud.mode] ?? hud.mode}</>}
          {hud.breath < 1 && <> · air {Math.round(hud.breath * 100)}%</>}
          {gpu && (
            <div className="truncate" title={gpu.renderer}>
              gpu <span className="text-foreground">{gpu.renderer}</span>
            </div>
          )}
        </div>
      ) : (
        <span className="text-muted-foreground">waiting for the first frame…</span>
      ),
    },
    { id: "perf", title: "performance", content: <PerfHud samples={hud?.perf ?? []} /> },
    {
      id: "tools",
      title: "tools",
      content: (
        <>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" className="h-7 px-2 text-xs" variant="secondary" onClick={() => setWireframe((w) => !w)}>
              {wireframe ? "solid terrain" : "wireframe terrain"}
            </Button>
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              variant="secondary"
              onClick={cycleQuality}
              title={activeQuality?.detected ? `this GPU's preset: ${activeQuality.detected}` : "detecting the GPU…"}
            >
              quality: {quality === "auto" ? `auto (${activeQuality?.active ?? "…"})` : quality}
            </Button>
            <Button size="sm" className="h-7 px-2 text-xs" variant="secondary" onClick={() => setShowcase((v) => !v)}>
              {showcase ? "hide FX" : "FX showcase"}
            </Button>
            <Button size="sm" className="h-7 px-2 text-xs" variant="outline" onClick={() => setMaximized((m) => !m)}>
              {maximized ? "restore view" : "maximize view"}
            </Button>
          </div>
          <AdminConsole client={client} />
        </>
      ),
    },
    {
      id: "controls",
      title: "controls",
      content: (
        <div className="text-muted-foreground">
          {ACTIONS.map((a) => `${ACTION_LABELS[a]}: ${DEFAULT_BINDINGS[a].map(prettyCode).join("/")}`).join(" · ")}
          <br />
          {FIXED_MOUSE.map((m) => `${m.label}: ${m.code === "Mouse0" ? "left click" : "right click"}`).join(" · ")}
          {" "}· mouse look (click the view; Esc frees the pointer) · wheel zoom · ` hides the panels
        </div>
      ),
    },
  ];

  return (
    <GameView
      client={client}
      url={url}
      lastStateAt={lastStateAt}
      wireframe={wireframe}
      showcase={showcase}
      quality={quality}
      maximized={maximized}
      onHud={onHudBoth}
      onGpu={setGpu}
      onQuality={onQuality}
      containerRef={setFrame}
    >
      {frame && <DevHud panels={panels} defaults={debuggerLayoutDefaults} bounds={bounds} />}
    </GameView>
  );
}
