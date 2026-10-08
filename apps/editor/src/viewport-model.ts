/**
 * Pure parts of the scene viewport (roadmap EA5): terrain snapping, the
 * marker each node is drawn with, and the shared-selection entry a node
 * publishes. The three.js side is ui/scene-viewport.tsx.
 */

import type { SceneNode } from "@mmo-engine/scene";
import type { EditorSelection, SelectionSource } from "./ui/editor-selection.js";

export interface HeightTile {
  cx: number;
  cz: number;
  /** 16 x 16 samples, row-major (index = j * 16 + i, i along x, j along z). */
  heights: ArrayLike<number>;
}

const SAMPLES = 16;
const CELLS = SAMPLES - 1;

/** Ground height at world (x, z) from stored terrain tiles (bilinear), null off the map. */
export function makeHeightSampler(tiles: readonly HeightTile[], chunkSize: number): (x: number, z: number) => number | null {
  const byKey = new Map(tiles.map((t) => [`${t.cx},${t.cz}`, t.heights]));
  return (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const cx = Math.floor(x / chunkSize);
    const cz = Math.floor(z / chunkSize);
    const h = byKey.get(`${cx},${cz}`);
    if (!h) return null;
    // Sample i sits at i * chunkSize / 15 from the chunk's corner.
    const u = ((x - cx * chunkSize) / chunkSize) * CELLS;
    const v = ((z - cz * chunkSize) / chunkSize) * CELLS;
    const i = Math.min(CELLS - 1, Math.max(0, Math.floor(u)));
    const j = Math.min(CELLS - 1, Math.max(0, Math.floor(v)));
    const fu = Math.min(1, Math.max(0, u - i));
    const fv = Math.min(1, Math.max(0, v - j));
    const at = (a: number, b: number): number => h[b * SAMPLES + a];
    const top = at(i, j) * (1 - fu) + at(i + 1, j) * fu;
    const bottom = at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu;
    return top * (1 - fv) + bottom * fv;
  };
}

export interface Marker {
  shape: "box" | "cone" | "octahedron";
  color: number;
}

const SPECIES_COLOR = 0xd9534f;
const PROP_COLOR = 0x5cb85c;
const SPAWN_COLOR = 0xf0c040;
const GROUP_COLOR = 0x8899aa;

/** How a node is drawn: spawn points are cones, groups octahedra, prefabs boxes (species red, props green). */
export function markerFor(node: SceneNode, species: ReadonlySet<string>): Marker {
  if (node.kind === "spawn-point") return { shape: "cone", color: SPAWN_COLOR };
  const prefab = node.prefab;
  const creature = node.components?.Spawner?.creature;
  if (!prefab && typeof creature !== "string") return { shape: "octahedron", color: GROUP_COLOR };
  const names = [prefab ?? "", (prefab ?? "").split("/").pop() ?? "", typeof creature === "string" ? creature : ""];
  return { shape: "box", color: names.some((n) => n && species.has(n)) ? SPECIES_COLOR : PROP_COLOR };
}

/** The shared-selection entry for a scene node. */
export function nodeSelection(source: SelectionSource, node: SceneNode): EditorSelection {
  const vec = (v: readonly number[] | undefined, fallback: string): string => (v ? v.join(", ") : fallback);
  return {
    source,
    kind: "scene-node",
    id: node.id,
    label: node.name || node.id,
    components: [
      {
        name: "Transform",
        fields: [
          { key: "position", value: vec(node.transform?.position, "0, 0, 0") },
          { key: "rotation", value: vec(node.transform?.rotation, "0, 0, 0") },
          { key: "scale", value: vec(node.transform?.scale, "1, 1, 1") },
        ],
      },
      ...Object.entries(node.components ?? {}).map(([name, props]) => ({
        name,
        fields: Object.entries(props).map(([key, value]) => ({ key, value: String(value) })),
      })),
    ],
  };
}

export interface PlaceableLists {
  species: ReadonlyArray<{ id: string }>;
  props: ReadonlyArray<{ id: string }>;
  pcg: ReadonlyArray<{ id: string }>;
}

export function placeableKind(p: PlaceableLists, id: string): "species" | "prop" | "pcg" | null {
  if (p.species.some((x) => x.id === id)) return "species";
  if (p.props.some((x) => x.id === id)) return "prop";
  if (p.pcg.some((x) => x.id === id)) return "pcg";
  return null;
}
