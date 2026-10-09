/**
 * Scene viewport panel (roadmap EA5): the three.js view of the open scene
 * (scene-view.ts), its toolbar (gizmo mode, snapping) and the content
 * browser to drag species, props and PICG assets from. It owns no document
 * state: the Scenes panel passes the document and applies every change
 * through the scene command stack.
 */

import * as React from "react";
import type { LiveTransform, SceneDoc, Vec3 } from "@mmo-engine/scene";
import { fetchPlaceables, type Placeables } from "../scene-content-client.js";
import { loadTerrain } from "../terrain/terrain-api.js";
import { SceneView, type GizmoMode } from "./scene-view.js";
import { sceneCamera } from "./scene-camera.js";
import { Button } from "./components.js";

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

export function SceneViewport(props: SceneViewportProps): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const viewRef = React.useRef<SceneView | null>(null);
  const latest = React.useRef(props);
  latest.current = props;
  const [mode, setMode] = React.useState<GizmoMode>("translate");
  const [snapTerrain, setSnapTerrain] = React.useState(true);
  const [snapGrid, setSnapGrid] = React.useState(false);
  const [content, setContent] = React.useState<Placeables | null>(null);
  const [note, setNote] = React.useState("");
  const [webgl, setWebgl] = React.useState(true);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let view: SceneView;
    try {
      view = new SceneView(canvas, {
        onSelect: (id) => latest.current.onSelect(id),
        onTransform: (id, t) => latest.current.onTransform(id, t),
        onPlace: (prefab, position) => latest.current.onPlace(prefab, position),
      });
    } catch {
      setWebgl(false);
      return;
    }
    viewRef.current = view;
    sceneCamera.set(() => view.centre());
    let alive = true;
    loadTerrain().then(
      (t) => alive && view.setTerrain(t.tiles, t.chunkWorldSize),
      () => alive && setNote("No terrain (grid only)"),
    );
    fetchPlaceables().then(
      (p) => alive && setContent(p),
      (e: Error) => alive && setNote(e.message),
    );
    return () => {
      alive = false;
      viewRef.current = null;
      sceneCamera.set(null);
      view.dispose();
    };
  }, []);

  const species = React.useMemo(() => new Set(content?.species.map((s) => s.id) ?? []), [content]);
  React.useEffect(() => {
    viewRef.current?.setDoc(props.doc, props.selected, species);
  }, [props.doc, props.selected, species, content]);
  React.useEffect(() => viewRef.current?.setMode(mode), [mode]);
  React.useEffect(() => viewRef.current?.setSnap({ terrain: snapTerrain, grid: snapGrid }), [snapTerrain, snapGrid]);

  const onKey = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const hit = MODES.find(([, , key]) => key === e.key.toLowerCase());
    if (hit) setMode(hit[0]);
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (props.selected) props.onDelete(props.selected);
    } else if (e.key.toLowerCase() === "f") viewRef.current?.frame();
  };
  const placeAtCentre = (id: string): void => props.onPlace(id, viewRef.current?.centre() ?? [0, 0, 0]);

  const group = (title: string, items: Array<{ id: string; label: string }> | undefined): React.JSX.Element | null =>
    items && items.length > 0 ? (
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs opacity-70">{title}</span>
        {items.map((it) => (
          <button
            key={`${title}:${it.id}`}
            type="button"
            draggable
            data-testid={`placeable-${title}-${it.id}`}
            title="Drag into the viewport, or click to place at the view centre"
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", `mmo-placeable:${it.id}`);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => placeAtCentre(it.id)}
            className="cursor-grab rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
          >
            {it.label}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5" data-testid="scene-viewport" tabIndex={0} onKeyDown={onKey}>
      <div className="flex flex-wrap items-center gap-1.5">
        {MODES.map(([m, label, key]) => (
          <Button key={m} size="sm" variant={mode === m ? "default" : "outline"} aria-pressed={mode === m} title={`${label} (${key.toUpperCase()})`} onClick={() => setMode(m)}>
            {label}
          </Button>
        ))}
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={snapTerrain} onChange={(e) => setSnapTerrain(e.target.checked)} /> Snap to terrain
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={snapGrid} onChange={(e) => setSnapGrid(e.target.checked)} /> Grid snap
        </label>
        <Button size="sm" variant="outline" title="Frame selection (F)" onClick={() => viewRef.current?.frame()}>Frame</Button>
        <Button size="sm" variant="outline" disabled={!props.selected} title="Delete (Del)" onClick={() => props.selected && props.onDelete(props.selected)}>Delete</Button>
        {note && <span className="text-xs opacity-70">{note}</span>}
      </div>
      <div className="relative min-h-[260px] flex-1 overflow-hidden rounded-md border border-border bg-black">
        {webgl ? <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" /> : <p className="p-3 text-xs">WebGL is not available here.</p>}
      </div>
      <div className="m3-scroll flex max-h-24 flex-col gap-1 overflow-auto" aria-label="Content browser">
        {group("species", content?.species)}
        {group("props", content?.props)}
        {group("PICG", content?.pcg)}
        {content && content.species.length + content.props.length + content.pcg.length === 0 && <span className="text-xs opacity-70">Nothing to place.</span>}
      </div>
    </div>
  );
}
