/**
 * Play-mode debugger (ROADMAP E5) — the developer panels over the game view.
 *
 * The shared dockable HUD (`@mmo-engine/client/debug`):
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
 * - selection (E6): the entity picked with a left click in the view, its
 *   components and, for a PICG asset, its graph parameters
 *   (inspectors/selection.ts); whitelisted fields edit through `set`, and
 *   server inspect, heal, teleport-me-here and despawn act on it (A2/A3,
 *   inspectors/entity-actions.ts)
 */

import * as React from "react";
import type { MirrorClient } from "@mmo-engine/mirror";
import { CombatFeedback, QUALITY_TIERS, type GpuInfo, type HudData, type QualityTier } from "@mmo-engine/client/render";
import {
  actionLabel,
  ACTIONS,
  AdminConsole,
  DevHud,
  FIXED_MOUSE,
  fixedMouseLabel,
  mouseButtonLabel,
  PerfHud,
  prettyCode,
  type DevPanelSpec,
} from "@mmo-engine/client/debug";
import { debuggerLayoutDefaults } from "../debugger-layout.js";
import { DEFAULT_BINDINGS } from "@mmo-engine/client/render";
import { GameView } from "./game-view.js";
import { Button } from "./components.js";
import { clearViewportActions, registerViewportActions, toggleViewportFlag, viewportFlags } from "./viewport-actions.js";
import { selectionCard, type SelectedEntity, type SelectionCard } from "../inspectors/selection.js";
import { SelectionCardView, usePcgLibrary } from "./selection-card.js";
import { editorSelection } from "./editor-selection.js";
import { attachMountToPopup, popOutGameView, takePendingPopup, type PoppedOutView } from "./play-popup.js";

/** How often the selection card re-reads the picked entity (the mirror changes every tick). */
const CARD_REFRESH_MS = 250;

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
  // Wireframe is the shared viewport toggle (the toolbar's viewport options and the tools panel below).
  const wireframe = viewportFlags.useValue().wireframe;
  const [showcase, setShowcase] = React.useState(false);
  const [maximized, setMaximized] = React.useState(false);
  // Camera view: third-person follow or first-person (V toggles in the view too).
  const [view, setView] = React.useState<"third" | "first">("third");
  const [quality, setQuality] = React.useState<"auto" | QualityTier>("auto");
  const [activeQuality, setActiveQuality] = React.useState<{ active: QualityTier; detected: QualityTier | null } | null>(null);
  // The panels mount once the view's frame exists, so their first layout fits it.
  const [frame, setFrame] = React.useState<HTMLDivElement | null>(null);
  const bounds = React.useMemo(() => ({ current: frame }), [frame]);
  // The game view is the active viewport while it shows: it owns its camera (no zoom/reset), has no
  // grid or gizmos, and can toggle wireframe and take a screenshot.
  React.useEffect(() => {
    if (!frame) return;
    const viewport = {
      label: "game view",
      canZoomIn: false,
      canZoomOut: false,
      canReset: false,
      zoomIn: () => undefined,
      zoomOut: () => undefined,
      reset: () => undefined,
      supports: { wireframe: true },
      screenshot: () => {
        const canvas = frame.querySelector("canvas");
        return new Promise<Blob | null>((resolve) => (canvas ? canvas.toBlob((b) => resolve(b), "image/png") : resolve(null)));
      },
    };
    registerViewportActions(viewport);
    return () => clearViewportActions(viewport);
  }, [frame]);
  // Popped-out view handle ("New window"): attach the frame when it mounts.
  const poppedRef = React.useRef<PoppedOutView | null>(null);
  React.useEffect(() => {
    if (!frame) return;
    const popup = takePendingPopup();
    if (!popup) return;
    const handle = attachMountToPopup(popup, frame);
    if (handle) {
      poppedRef.current = handle;
    } else {
      // Popup closed before the view mounted: close the orphan.
      try {
        popup.close();
      } catch {
        /* ignore */
      }
    }
    return () => {
      // Unmount (stop): move the view back before React tears it down.
      poppedRef.current?.close();
      poppedRef.current = null;
    };
  }, [frame]);
  // The picked entity (a left click in the view) and its card.
  const [combat] = React.useState(() => new CombatFeedback());
  const library = usePcgLibrary();
  const [card, setCard] = React.useState<SelectionCard | null>(null);
  const [picked, setPicked] = React.useState<SelectedEntity | null>(null);
  const selectedWireId = React.useRef<string | null>(null);
  React.useEffect(() => {
    const read = (): void => {
      const target = combat.target;
      const entity = target !== null ? client.state.get(target) : undefined;
      const next = entity ? selectionCard(entity as unknown as SelectedEntity, client.names.get(entity.wireId) ?? null, library.assets) : null;
      setCard(next);
      setPicked(entity ? (entity as unknown as SelectedEntity) : null);
      if (next?.wireId === selectedWireId.current) return;
      selectedWireId.current = next?.wireId ?? null;
      if (!next) {
        editorSelection.clear("viewport");
        return;
      }
      editorSelection.select({
        source: "viewport",
        kind: next.kind,
        id: next.wireId,
        label: next.name ?? next.kind,
        components: next.components,
      });
    };
    read();
    const t = setInterval(read, CARD_REFRESH_MS);
    return () => clearInterval(t);
  }, [client, combat, library.assets]);

  const onHudRef = React.useRef(onHud);
  onHudRef.current = onHud;
  const onHudBoth = React.useCallback(
    (h: HudData) => {
      setHud(h);
      onHudRef.current?.(h);
    },
    [],
  );
  const onQuality = React.useCallback((active: QualityTier, detected: QualityTier | null) => setActiveQuality({ active, detected }), []);
  const cycleQuality = (): void => React.startTransition(() => setQuality((q) => QUALITY_CYCLE[(QUALITY_CYCLE.indexOf(q) + 1) % QUALITY_CYCLE.length]));

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
            <Button size="sm" className="h-7 px-2 text-xs" variant="secondary" onClick={() => toggleViewportFlag("wireframe")}>
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
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              variant="outline"
              title="Toggle first-person view (V)"
              onClick={() => setView((v) => (v === "third" ? "first" : "third"))}
            >
              {view === "third" ? "first person" : "third person"}
            </Button>
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              variant="outline"
              disabled={!frame || poppedRef.current?.isOpen}
              title={poppedRef.current?.isOpen ? "The view is already in a new window" : "Pop the game view out into a new window"}
              onClick={() => {
                if (!frame || poppedRef.current?.isOpen) return;
                // In the click gesture: the popup blocker stays quiet.
                const handle = popOutGameView(frame, { title: "Play" });
                if (handle) poppedRef.current = handle;
              }}
            >
              pop out
            </Button>
          </div>
          <AdminConsole client={client} />
        </>
      ),
    },
    {
      id: "selection",
      title: "selection",
      content: (
        <>
          <div className="mb-2 flex gap-1.5">
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              variant="secondary"
              onClick={() => combat.select(client.playerEntity)}
              disabled={client.playerEntity === null}
            >
              my avatar
            </Button>
            <Button size="sm" className="h-7 px-2 text-xs" variant="outline" onClick={() => combat.select(null)} disabled={!card}>
              clear
            </Button>
          </div>
          <SelectionCardView card={card} libraryError={library.error} entity={picked} admin={client} />
        </>
      ),
    },
    {
      id: "interest",
      title: "interest",
      content: <InterestPanel client={client} />,
    },
    {
      id: "residents",
      title: "residents",
      content: <ResidentsPanel client={client} />,
    },
    {
      id: "controls",
      title: "controls",
      content: (
        <div className="text-muted-foreground">
          {ACTIONS.map((a) => `${actionLabel(a)}: ${DEFAULT_BINDINGS[a].map(prettyCode).join("/")}`).join(" · ")}
          <br />
          {FIXED_MOUSE.map((m) => `${fixedMouseLabel(m)}: ${mouseButtonLabel(m.code)}`).join(" · ")}
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
      combat={combat}
      containerRef={setFrame}
      view={view}
      onViewChange={setView}
    >
      {frame && <DevHud panels={panels} defaults={debuggerLayoutDefaults} bounds={bounds} />}
    </GameView>
  );
}

/**
 * Interest management (IM6): "show everything" (the debugger's default) or "show what the player
 * sees", and a map of the sectors the server sends this client around the avatar.
 */
interface ResidentsSummary {
  towns: Array<{ id: string; tier: string; people: number; live: number; raid: boolean }>;
  live: number;
  walking: number;
}

/** Residents (RS3): each baked town's tier (full: they walk; coarse: they stand; none: nobody exists), its people and how many are in the world. */
function ResidentsPanel({ client }: { client: MirrorClient }): React.JSX.Element {
  const [s, setS] = React.useState<ResidentsSummary | null>(null);
  React.useEffect(() => {
    const poll = (): void => {
      void client.admin("residents").then((r) => setS(JSON.parse(r.message) as ResidentsSummary)).catch(() => undefined);
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [client]);
  if (!s) return <div className="text-xs text-muted-foreground">asking the server…</div>;
  if (s.towns.length === 0) return <div className="text-xs text-muted-foreground">no residents on this server</div>;
  const order = { full: 0, coarse: 1, none: 2 } as Record<string, number>;
  const towns = [...s.towns].sort((a, b) => (order[a.tier] ?? 3) - (order[b.tier] ?? 3) || a.id.localeCompare(b.id));
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="text-muted-foreground">{s.live} in the world, {s.walking} walking, {s.towns.length} towns</div>
      <table className="w-full tabular-nums">
        <thead><tr className="text-left text-muted-foreground"><th>town</th><th>tier</th><th>live / people</th></tr></thead>
        <tbody>
          {towns.map((t) => (
            <tr key={t.id} className={t.raid ? "text-red-400" : undefined}>
              <td>{t.id}{t.raid ? " (raid)" : ""}</td>
              <td>{t.tier}</td>
              <td>{t.live} / {t.people}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InterestPanel({ client }: { client: MirrorClient }): React.JSX.Element {
  const [all, setAll] = React.useState(true);
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const me = client.playerEntity !== null ? client.state.get(client.playerEntity)?.transform : undefined;
  const cx = me ? Math.floor(me.px / 64) : 0, cz = me ? Math.floor(me.pz / 64) : 0;
  const R = 4, CELL = 14;
  const cells = React.useMemo(() => {
    const cells: React.JSX.Element[] = [];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const on = client.interestSectors.has(`${cx + dx},${cz + dz}`);
        cells.push(
          <rect key={`${dx},${dz}`} x={(dx + R) * CELL} y={(dz + R) * CELL} width={CELL - 1} height={CELL - 1}
            fill={dx === 0 && dz === 0 ? "currentColor" : on ? "rgb(56 189 248 / 0.6)" : "rgb(148 163 184 / 0.15)"} />,
        );
      }
    }
    return cells;
  }, [client.interestSectors, cx, cz]);
  const sectors = [...client.interestSectors].filter((s) => s !== "g").length;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <Button
        size="sm"
        className="h-7 px-2 text-xs"
        variant="outline"
        onClick={() => {
          const next = !all;
          void client.admin("interest", { mode: next ? "all" : "near" }).then(() => setAll(next)).catch(() => undefined);
        }}
      >
        {all ? "show what the player sees" : "show everything"}
      </Button>
      <svg width={(2 * R + 1) * CELL} height={(2 * R + 1) * CELL} aria-label="interest sectors around the avatar">{cells}</svg>
      <div className="text-muted-foreground">
        {all ? "everything" : "player's view"}: {sectors} sectors, {client.state.entityCount} entities (64 m sectors; the avatar's is filled)
      </div>
    </div>
  );
}
