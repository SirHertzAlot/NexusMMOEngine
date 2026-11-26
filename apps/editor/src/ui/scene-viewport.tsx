/**
 * Scene viewport panel (roadmap EA5): the three.js view of the open scene
 * (scene-view.ts), its toolbar (gizmo mode, snapping) and the content
 * browser to drag species, props and PICG assets from. It owns no document
 * state: the Scenes panel passes the document and applies every change
 * through the scene command stack.
 */

import * as React from "react";
import type { LiveTransform, SceneDoc, Vec3 } from "@mmo-engine/scene";
import { usePlaceables } from "./placeables-store.js";
import { fetchSceneVisuals } from "../scene-visuals-client.js";
import { loadTerrain } from "../terrain/terrain-api.js";
import { SceneView, type GizmoMode } from "./scene-view.js";
import { Button, CheckField } from "./components.js";
import { clearViewportActions, registerViewportActions, viewportFlags } from "./viewport-actions.js";
import { setSceneCameraPos } from "./camera-position.js";
import { parseGoTo } from "./scene-camera.js";
import { setTool, useTool } from "./tool-store.js";
import { gizmoModeFor, toolForGizmoMode } from "./viewport-tools.js";

export interface SceneViewportProps {
  doc: SceneDoc;
  selected: string | null;
  onSelect(id: string | null): void;
  onTransform(id: string, t: LiveTransform): void;
  onPlace(prefab: string, position: Vec3): void;
  onDelete(id: string): void;
}

const MODES: Array<[GizmoMode, string, string]> = [
  ["translate", "Move", "w"],
  ["rotate", "Rotate", "e"],
  ["scale", "Scale", "r"],
];

/** Select is a tool too: it is how you put the gizmo away and just look. */
const SELECT_KEY = "v";

export function SceneViewport(props: SceneViewportProps): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const viewRef = React.useRef<SceneView | null>(null);
  const latest = React.useRef(props);
  latest.current = props;
  // The gizmo follows the SHARED tool (tool-store.ts) — the same store the
  // toolbar, the shell's context bar and every other viewport read, so the
  // mode on screen and the tool the rest of the editor reports are one thing.
  const tool = useTool();
  const gizmo = gizmoModeFor(tool);
  const mode: GizmoMode = gizmo ?? "translate";
  const setMode = (next: GizmoMode): void => setTool(toolForGizmoMode(next));
  const [snapTerrain, setSnapTerrain] = React.useState(true);
  const [snapGrid, setSnapGrid] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [webgl, setWebgl] = React.useState(true);
  const [flying, setFlying] = React.useState(false);
  const [goTo, setGoTo] = React.useState("");
  const [goToError, setGoToError] = React.useState<string | null>(null);
  // One hook for the placeables, shared with the palette (EB4): the
  // viewport needs it only to know which ids are creatures.
  const { content } = usePlaceables();
  /** False once the host says the art pack resolved no model at all. */
  const [art, setArt] = React.useState(true);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let view: SceneView;
    try {
      view = new SceneView(canvas, {
        onSelect: (id) => latest.current.onSelect(id),
        onTransform: (id, t) => latest.current.onTransform(id, t),
        onPlace: (prefab, position) => latest.current.onPlace(prefab, position),
        // Play menu "Start from camera position" reads this store.
        onCameraGround: (p) => setSceneCameraPos(p),
        onFly: (on) => setFlying(on),
      });
    } catch {
      setWebgl(false);
      return;
    }
    // Publish the initial view (orbit 'change' only fires on interaction).
    setSceneCameraPos({ x: 0, z: 0 });
    viewRef.current = view;
    // The View menu's Zoom/Reset act on the mounted viewport.
    const viewport = {
      label: "scene viewport",
      canZoomIn: true,
      canZoomOut: true,
      canReset: true,
      zoomIn: () => view.zoomIn(),
      zoomOut: () => view.zoomOut(),
      reset: () => view.frame(),
      supports: { grid: true, gizmos: true, wireframe: true, axes: true },
      screenshot: () => view.screenshot(),
    };
    registerViewportActions(viewport);
    let alive = true;
    loadTerrain().then(
      (t) => alive && view.setTerrain(t.tiles, t.chunkWorldSize),
      () => alive && setNote("No terrain (grid only)"),
    );
    // The sizes and models the engine gives each placeable (EB1). Without
    // the table every node is a marker, which is what the viewport drew
    // before, so a failure here costs nothing but accuracy.
    fetchSceneVisuals().then(
      (t) => {
        if (!alive) return;
        view.setVisuals(t.visuals);
        if (!t.art) setArt(false);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      viewRef.current = null;
      clearViewportActions(viewport);
      view.dispose();
    };
  }, []);

  // Grid / gizmos / wireframe follow the toolbar's viewport options.
  const flags = viewportFlags.useValue();
  React.useEffect(() => viewRef.current?.setGrid(flags.grid), [flags.grid, webgl]);
  React.useEffect(() => viewRef.current?.setWireframe(flags.wireframe), [flags.wireframe, webgl, content]);

  const species = React.useMemo(() => new Set(content?.species.map((s) => s.id) ?? []), [content]);
  React.useEffect(() => {
    viewRef.current?.setDoc(props.doc, props.selected, species);
  }, [props.doc, props.selected, species, content]);
  React.useEffect(() => viewRef.current?.setMode(mode), [mode]);
  // With select, the gizmo goes away entirely: left-drag orbits, a click
  // picks. That is what `select` already means in every other viewport.
  React.useEffect(
    () => viewRef.current?.setGizmos(flags.gizmos && gizmo !== null),
    [flags.gizmos, gizmo, webgl],
  );
  React.useEffect(() => viewRef.current?.setAxes(flags.axes), [flags.axes, webgl]);
  React.useEffect(() => viewRef.current?.setSnap({ terrain: snapTerrain, grid: snapGrid }), [snapTerrain, snapGrid]);

  const onKey = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    // While flying, W/A/S/D/Q/E move the camera, not the gizmo mode.
    if (flying) return;
    const hit = MODES.find(([, , key]) => key === e.key.toLowerCase());
    if (hit) setMode(hit[0]);
    else if (e.key.toLowerCase() === SELECT_KEY) setTool("select");
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (props.selected) props.onDelete(props.selected);
    } else if (e.key.toLowerCase() === "f") viewRef.current?.frame();
  };
  const toggleFly = (): void => {
    const view = viewRef.current;
    if (!view) return;
    view.setFly(!view.isFlying);
    setFlying(view.isFlying);
  };
  const goToPoint = (): void => {
    const p = parseGoTo(goTo);
    if (!p) {
      setGoToError("Enter two numbers, like 344, 576");
      return;
    }
    setGoToError(null);
    viewRef.current?.lookAt(p.x, p.z);
  };
  const statusLine = [note, goToError, art ? null : "Stand-in sizes (no art pack)"].filter(Boolean) as string[];

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden rounded-md border"
      style={{ borderColor: "var(--m3-outline-variant)", background: "#000" }}
      data-testid="scene-viewport"
      tabIndex={0}
      onKeyDown={onKey}
    >
      {webgl ? <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" /> : <p className="p-3 text-xs">WebGL is not available here.</p>}
      {/* EB4: the canvas is the workspace, so the controls sit on it rather
          than pushing it down the page. Only the controls take the pointer. */}
      <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start gap-1.5">
        <div
          className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1.5 shadow-lg backdrop-blur"
          style={{
            borderColor: "var(--m3-outline-variant)",
            background: "color-mix(in srgb, var(--m3-surface) 82%, transparent)",
          }}
          role="toolbar"
          aria-label="Viewport tools"
        >
          <Button
            size="sm"
            variant={gizmo === null ? "default" : "outline"}
            aria-pressed={gizmo === null}
            title="Select (V) — camera and pick, no gizmo"
            onClick={() => setTool("select")}
          >
            Select
          </Button>
          {MODES.map(([m, label, key]) => (
            <Button key={m} size="sm" variant={gizmo === m ? "default" : "outline"} aria-pressed={gizmo === m} title={`${label} (${key.toUpperCase()})`} onClick={() => setMode(m)}>
              {label}
            </Button>
          ))}
          <span className="mx-0.5 h-5 w-px" style={{ background: "var(--m3-outline-variant)" }} aria-hidden="true" />
          <CheckField checked={snapTerrain} onChange={setSnapTerrain} label="Snap to terrain" />
          <CheckField checked={snapGrid} onChange={setSnapGrid} label="Grid snap" />
          <span className="mx-0.5 h-5 w-px" style={{ background: "var(--m3-outline-variant)" }} aria-hidden="true" />
          <Button size="sm" variant="outline" title="Frame selection (F)" onClick={() => viewRef.current?.frame()}>Frame</Button>
          <label className="flex items-center gap-1 text-xs">
            <span className="opacity-70">Go to x, z</span>
            <input
              aria-label="Go to x, z"
              aria-invalid={goToError ? true : undefined}
              data-testid="scene-goto"
              value={goTo}
              placeholder="344, 576"
              onChange={(e) => setGoTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") goToPoint();
              }}
              className="w-24 rounded-md border bg-transparent px-2 py-0.5 text-xs"
              style={{ borderColor: "var(--m3-outline-variant)" }}
            />
          </label>
          <Button size="sm" variant="outline" title="Move the view to that ground point" onClick={goToPoint}>Go</Button>
          <Button size="sm" variant={flying ? "default" : "outline"} aria-pressed={flying} title="Free camera: W/S forward and back, A/D left and right, Q/E down and up, Shift faster, Esc to stop" onClick={toggleFly}>
            Fly
          </Button>
          <Button size="sm" variant="outline" disabled={!props.selected} title="Delete (Del)" onClick={() => props.selected && props.onDelete(props.selected)}>Delete</Button>
        </div>
      </div>
      {statusLine.length > 0 && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex flex-wrap gap-2">
          <span
            className="pointer-events-auto rounded-md border px-2 py-1 text-xs backdrop-blur"
            data-testid="viewport-status"
            style={{
              borderColor: "var(--m3-outline-variant)",
              background: "color-mix(in srgb, var(--m3-surface) 82%, transparent)",
              color: goToError ? "var(--m3-error)" : "var(--m3-on-surface-variant)",
            }}
            title={
              art
                ? undefined
                : "assets/manifest.json resolved no model, so nodes are drawn at the size the engine spawns them: creatures as their capsule, props as a stand-in at the scale document's factor."
            }
          >
            {statusLine.join(" · ")}
          </span>
        </div>
      )}
    </div>
  );
}
