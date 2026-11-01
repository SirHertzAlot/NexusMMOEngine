/**
 * Civil works for the settlement's streets (roadmap SG2b, SETTLEMENTS.md §28): junctions, earthwork and drainage, as
 * stand-ins. The bake has no survey of the ground under a street, so each figure is taken from the street's own profile:
 *
 *   - Junction: a node where three or more paved streets meet gets a flat pad at its height, wide enough for the widest
 *     street meeting there plus a margin. The street ribbons end at the pad's edge.
 *   - Earthwork: a street's profile is measured against its grade line (the straight line between its two ends). Where the
 *     road lies above that line it is fill, below it cut, and the volumes are the profile's area times the street's width.
 *     These are cubic metres of the road's own bulge, not of cut and fill against the natural ground.
 *   - Drainage: a street falls along its length from its higher end to its lower one, which is the outlet. A street under
 *     1 permille (0.1 %) is flat and needs a ditch. Every street gets a standard 2 % crown across its width.
 *
 * Pure: no three, no engine-core. Units are metres in scene coordinates, the same frame as the ribbons.
 */
import type { SettlementManifest } from "./generate.js";

/** Standard camber of a street's surface, permille: 2 % crown from the centreline to each rail. */
export const CROWN_PERMILLE = 20;
/** A street falling less than this, permille, has no outlet and needs a ditch. */
export const FLAT_PERMILLE = 1;
/** Margin beyond the widest street meeting at a junction, metres. */
export const JUNCTION_MARGIN_M = 0.5;

export interface JunctionPad {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radius of the flat pad, metres. */
  readonly radiusM: number;
  /** How many paved streets meet here. */
  readonly arms: number;
}

export interface StreetCivil {
  readonly edgeId: string;
  /** Fill (above the grade line) and cut (below it), cubic metres. */
  readonly fillM3: number;
  readonly cutM3: number;
  /** Fall along the street, permille, from its start to its end (positive: rises toward the end). */
  readonly gradePermille: number;
  /** The lower end's junction, or null when the street is flat (it needs a ditch). */
  readonly outlet: string | null;
  readonly crownPermille: number;
}

export interface CivilWorks {
  readonly junctions: JunctionPad[];
  readonly streets: StreetCivil[];
  readonly totals: { fillM3: number; cutM3: number; junctions: number; flatStreets: number };
}

/** Earthwork and drainage for one routed street, from its path (mm in x and z, metres in h). */
export function streetCivil(
  edge: { id: string; from: string; to: string; widthMm: number },
  path: ReadonlyArray<{ x: number; z: number; h: number }>,
): StreetCivil | null {
  if (path.length < 2 || !(edge.widthMm > 0)) return null;
  const w = edge.widthMm / 1000;
  // Arc length from the start, metres.
  const s: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    s.push(s[i - 1]! + Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z) / 1000);
  }
  const total = s[s.length - 1]!;
  const h0 = path[0]!.h;
  const hN = path[path.length - 1]!.h;
  // Profile against the grade line, integrated by the trapezoid rule over arc length.
  let fill = 0;
  let cut = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const d0 = path[i]!.h - (h0 + ((hN - h0) * s[i]!) / (total || 1));
    const d1 = path[i + 1]!.h - (h0 + ((hN - h0) * s[i + 1]!) / (total || 1));
    const len = s[i + 1]! - s[i]!;
    // Split the leg where the profile crosses the grade line, so fill and cut are not netted.
    if (d0 * d1 >= 0) {
      const area = ((d0 + d1) / 2) * len;
      if (area >= 0) fill += area * w;
      else cut -= area * w;
    } else {
      const t = d0 / (d0 - d1);
      const a1 = (d0 * t * len) / 2;
      const a2 = (d1 * (1 - t) * len) / 2;
      if (d0 > 0) {
        fill += a1 * w;
        cut -= a2 * w;
      } else {
        cut -= a1 * w;
        fill += a2 * w;
      }
    }
  }
  // Grade: the street's fall along its length. An outlet is the lower end, unless the street is flat.
  const gradePermille = total > 0 ? ((hN - h0) / total) * 1000 : 0;
  const flat = Math.abs(gradePermille) < FLAT_PERMILLE;
  // Water runs to the lower end: the start when the street rises from it, the end when it falls.
  const outlet = flat ? null : gradePermille > 0 ? edge.from : edge.to;
  return { edgeId: edge.id, fillM3: fill, cutM3: cut, gradePermille, outlet, crownPermille: CROWN_PERMILLE };
}

/** Junctions and civil figures for every paved street of a town that has a router's path. */
export function civilWorks(manifest: SettlementManifest): CivilWorks {
  const paved = manifest.roads.edges.filter((e) => e.surface === "paved");
  const nodes = new Map(manifest.roads.nodes.map((n) => [n.id, n]));
  // Arms per node and the widest street meeting there.
  const arms = new Map<string, { n: number; widest: number }>();
  for (const e of paved) {
    for (const id of [e.from, e.to]) {
      const a = arms.get(id) ?? { n: 0, widest: 0 };
      arms.set(id, { n: a.n + 1, widest: Math.max(a.widest, e.widthMm) });
    }
  }
  // Each node's height: from the path that ends there.
  const heightAt = new Map<string, number>();
  for (const e of paved) {
    if (!e.path || e.path.length < 2) continue;
    heightAt.set(e.from, e.path[0]!.h);
    heightAt.set(e.to, e.path[e.path.length - 1]!.h);
  }
  const junctions: JunctionPad[] = [];
  for (const [id, a] of arms) {
    if (a.n < 3) continue;
    const n = nodes.get(id);
    if (!n) continue;
    junctions.push({
      nodeId: id,
      x: n.x / 1000,
      y: heightAt.get(id) ?? 0,
      z: n.z / 1000,
      radiusM: a.widest / 2000 + JUNCTION_MARGIN_M,
      arms: a.n,
    });
  }
  const streets: StreetCivil[] = [];
  for (const e of paved) {
    if (!e.path) continue;
    const c = streetCivil(e, e.path);
    if (c) streets.push(c);
  }
  const fillM3 = streets.reduce((t, s) => t + s.fillM3, 0);
  const cutM3 = streets.reduce((t, s) => t + s.cutM3, 0);
  return {
    junctions,
    streets,
    totals: { fillM3, cutM3, junctions: junctions.length, flatStreets: streets.filter((s) => s.outlet === null).length },
  };
}
