/**
 * World map overview for the Terrain tab (ROADMAP E9): the whole baked
 * world, the loaded area (cyan), the camera (white), the spawn (gold) and
 * the region grid; a highlighted region is the one regenerate would
 * replace. Click to jump the area there. Drawing only: the picture and
 * every coordinate come from inspectors/world-map.ts.
 */

import * as React from "react";
import { groundColors } from "@mmo-engine/client/render";
import { describeAt, mapToWorld, rangeMetres, shadeMap, worldToMap, type AreaRef, type ChunkRange } from "../inspectors/world-map.js";
import { areaRange } from "../inspectors/world-map.js";
import type { WorldOverview } from "../terrain/terrain-api.js";

export function WorldMapView({
  world,
  area,
  camera,
  highlight,
  onJump,
}: {
  world: WorldOverview;
  area: AreaRef | null;
  camera: { x: number; z: number } | null;
  highlight: ChunkRange | null;
  onJump: (x: number, z: number) => void;
}): React.JSX.Element {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = React.useState<string | null>(null);
  const image = React.useMemo(() => {
    const { map } = world;
    const px = shadeMap(map, groundColors(map), world.seaLevel);
    const c = document.createElement("canvas");
    c.width = map.width;
    c.height = map.depth;
    c.getContext("2d")!.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, map.width, map.depth), 0, 0);
    return c;
  }, [world]);

  React.useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const { map, chunkWorldSize: size } = world;
    const W = el.width;
    const H = el.height;
    const ctx = el.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, 0, 0, W, H);
    const sx = W / map.width;
    const sy = H / map.depth;
    const toPx = (x: number, z: number): [number, number] => {
      const { u, v } = worldToMap(map, x, z);
      return [u * sx, v * sy];
    };
    const rect = (r: ChunkRange, stroke: string, fill: string | null, lw: number): void => {
      const [x0, z0, x1, z1] = rangeMetres(r, size);
      const [a, b] = toPx(x0, z0);
      const [c, d] = toPx(x1, z1);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(a, b, c - a, d - b);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.strokeRect(a, b, c - a, d - b);
    };
    for (const r of world.regions) rect(r.range, "rgba(255,255,255,0.35)", null, 1);
    if (highlight) rect(highlight, "#f59e0b", "rgba(245,158,11,0.18)", 2);
    if (area) rect(areaRange(area), "#22d3ee", "rgba(34,211,238,0.15)", 2);
    const dot = (x: number, z: number, color: string, r: number): void => {
      const [a, b] = toPx(x, z);
      ctx.beginPath();
      ctx.arc(a, b, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#0b1020";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    if (world.spawn) dot(world.spawn.x, world.spawn.z, "#facc15", 4);
    if (camera) dot(camera.x, camera.z, "#ffffff", 4);
  }, [world, image, area, camera, highlight]);

  const worldAt = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; z: number } => {
    const r = e.currentTarget.getBoundingClientRect();
    const u = ((e.clientX - r.left) / r.width) * world.map.width;
    const v = ((e.clientY - r.top) / r.height) * world.map.depth;
    return mapToWorld(world.map, u, v);
  };

  return (
    <div>
      <canvas
        ref={canvas}
        width={512}
        height={512}
        className="aspect-square w-full cursor-crosshair rounded-md border border-border"
        data-testid="world-map"
        onClick={(e) => {
          const p = worldAt(e);
          onJump(p.x, p.z);
        }}
        onMouseMove={(e) => {
          const p = worldAt(e);
          const d = describeAt(world.map, p.x, p.z);
          setHover(d ? `${d.biome}${d.river ? " · river" : ""} · ${Math.round(d.height)} m · (${Math.round(p.x)}, ${Math.round(p.z)})` : null);
        }}
        onMouseLeave={() => setHover(null)}
      />
      <p className="mt-1 h-4 truncate text-xs text-muted-foreground">{hover ?? "Click to load the area there."}</p>
    </div>
  );
}
