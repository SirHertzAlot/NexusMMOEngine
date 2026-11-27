/**
 * The content palette (roadmap EB4): what you can drop into the scene.
 *
 * It used to be three wrapping rows of chips squeezed under the canvas, so
 * the viewport was the small thing in the middle of a form. The palette is
 * now a column of its own beside the Outliner: searchable, grouped and
 * scrolling, with the same two gestures it always had — drag onto the
 * ground, or click to place at what the camera is looking at.
 *
 * It owns no list of its own: `usePlaceables()` is the one hook for that
 * data source, shared with the viewport.
 */

import * as React from "react";
import type { Vec3 } from "@mmo-engine/scene";
import { filterPlaceables, paletteSummary } from "../placeables-filter.js";
import { getSceneCameraPos } from "./camera-position.js";
import { usePlaceables } from "./placeables-store.js";
import { SectionTitle } from "./components.js";

export interface ScenePaletteProps {
  /** Drop a placeable into the open scene at `position` (scene space). */
  onPlace(prefab: string, position: Vec3): void;
  /** False while no scene is open: the palette shows, but places nothing. */
  enabled: boolean;
}

/** Where a click (rather than a drag) puts a placeable: the camera's ground point. */
export function placePoint(): Vec3 {
  const p = getSceneCameraPos();
  return p ? [p.x, 0, p.z] : [0, 0, 0];
}

export function ScenePalette(props: ScenePaletteProps): React.JSX.Element {
  const { content, error } = usePlaceables();
  const [query, setQuery] = React.useState("");
  const groups = React.useMemo(() => filterPlaceables(content, query), [content, query]);

  return (
    <section className="flex min-h-0 flex-col" aria-label="Content palette" data-testid="scene-palette">
      <SectionTitle>Content</SectionTitle>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search content"
        aria-label="Search content"
        data-testid="palette-search"
        className="mb-1 h-8 w-full rounded-md border bg-transparent px-2 text-xs"
        style={{ borderColor: "var(--m3-outline-variant)" }}
      />
      <p className="mb-1 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
        {error ?? paletteSummary(content, groups, query)}
      </p>
      <div className="m3-scroll min-h-0 flex-1 overflow-auto pr-1">
        {groups.map((group) => (
          <div key={group.title} className="mb-2">
            <p className="mb-0.5 text-xs uppercase tracking-wide" style={{ color: "var(--m3-on-surface-variant)" }}>
              {group.title}
            </p>
            <div className="flex flex-col">
              {group.items.map((item) => (
                <button
                  key={`${group.title}:${item.id}`}
                  type="button"
                  draggable={props.enabled}
                  disabled={!props.enabled}
                  data-testid={`placeable-${group.title}-${item.id}`}
                  title={
                    props.enabled
                      ? "Drag into the viewport, or click to place at the view centre"
                      : "Open a scene to place content"
                  }
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", `mmo-placeable:${item.id}`);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => props.enabled && props.onPlace(item.id, placePoint())}
                  className="flex cursor-grab items-baseline justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-[var(--m3-secondary-container)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="min-w-0 truncate">{item.label}</span>
                  {item.label !== item.id && (
                    <span className="shrink-0 opacity-60">{item.id}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
