/**
 * The structure checks as a post-pass over a synthesized settlement scene (structure-checks.ts), whatever generated it.
 *
 * The scene's shape, as the village synthesis writes it: a group node per parcel named `building:<kind>`, holding a
 * visual part node `<id>-vis-N` (a Structure with the part's asset and size) and a collider node `<id>-pN-col` for each
 * part N. This pass routes by kind (open ground keeps none of the house parts it was handed), prunes parts that touch
 * nothing or hang in the air, and reports whether each building closes. Pure: returns a new scene and a report.
 */

import type { SceneDoc, SceneNode } from "@mmo-engine/scene";
import type { SynthesizedPlacement } from "./types.js";
import { bareKind, envelopeReport, pruneDetached, synthesisRoute, turnByYaw } from "./structure-checks.js";

export interface SceneCheckOptions {
  /** A group smaller than this many touching parts is not a building (default 3). */
  minParts?: number;
  /**
   * Parts closer than this count as touching, metres (default 0.5: on the village preview, dressing that rests on or
   * hangs off a part stands up to 0.45 m from it by its box, a wall torch or a chain sign; what floats stands 0.5 m+ off).
   */
  gap?: number;
  /** Remove the house parts an open-ground parcel was given (default true). */
  stripOpen?: boolean;
}

export interface BuildingReport {
  id: string;
  kind: string;
  route: "enclosed" | "open";
  /** Visual parts handed to the parcel, and how many were removed. */
  parts: number;
  removed: { openGround: number; isolated: number; smallGroup: number; floating: number };
  /** Enclosed buildings only, after pruning. */
  closed?: boolean;
  missing?: string[];
}

export interface SceneCheckReport {
  buildings: BuildingReport[];
  totals: { buildings: number; openWithParts: number; partsRemoved: number; closed: number; open: number; unclosed: number };
  /** The most common things missing from unclosed buildings. */
  missingCounts: Record<string, number>;
}

const VIS = /-vis-(\d+)$/;
const COL = /-p(\d+)-col$/;

/** A part's category from its model name (the pack's names carry it); "part" when the name says nothing. */
export function categoryOf(asset: string): string {
  const n = asset.split("/").pop() ?? asset;
  // By priority, not position: "Base_Wall" is a wall and "Roof_Tile_Window" a roof.
  for (const role of ["roof", "ceiling", "wall", "floor", "stairs", "railing", "pillar", "beam", "door", "window", "chimney", "foundation"]) if (new RegExp(role, "i").test(n)) return role;
  return /base/i.test(n) ? "floor" : "part";
}

const quatOfYaw = (deg: number): [number, number, number, number] => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];

interface Part {
  index: number;
  node: SceneNode;
  placement: SynthesizedPlacement;
}

function partsOf(group: SceneNode): Part[] {
  const out: Part[] = [];
  for (const c of group.children ?? []) {
    const m = VIS.exec(c.id);
    const st = c.components?.Structure as { asset?: string; width?: number; depth?: number; height?: number; centreX?: number; centreY?: number; centreZ?: number } | undefined;
    if (!m || !st) continue;
    const pos = c.transform?.position ?? [0, 0, 0];
    const yaw = (c.transform?.rotation as number[] | undefined)?.[1] ?? 0;
    const asset = st.asset ?? "";
    // The node sits at the model's pivot; the box is round the middle (`centre`, in the part's own axes).
    const mid = turnByYaw([st.centreX ?? 0, st.centreY ?? 0, st.centreZ ?? 0], yaw);
    out.push({
      index: Number(m[1]),
      node: c,
      placement: {
        partId: asset.split("/").pop() ?? asset,
        assetRef: asset,
        category: categoryOf(asset),
        transform: { pos: [pos[0]! + mid[0]!, pos[1]! + mid[1]!, pos[2]! + mid[2]!], rot: quatOfYaw(yaw), scale: [1, 1, 1] } as unknown as SynthesizedPlacement["transform"],
        size: [st.width ?? 1, st.height ?? 1, st.depth ?? 1],
      },
    });
  }
  return out;
}

/** Check (and clean) every `building:*` group of a settlement scene. The input is not modified. */
export function checkSettlementScene(scene: SceneDoc, o: SceneCheckOptions = {}): { scene: SceneDoc; report: SceneCheckReport } {
  const buildings: BuildingReport[] = [];
  const missingCounts: Record<string, number> = {};

  const fix = (node: SceneNode): SceneNode => {
    const m = /^building:(.+)$/.exec(node.name ?? "");
    if (!m) return { ...node, ...(node.children ? { children: node.children.map(fix) } : {}) };
    const kind = bareKind(m[1]!);
    const route = synthesisRoute(kind);
    const parts = partsOf(node);
    const row: BuildingReport = { id: node.id, kind, route, parts: parts.length, removed: { openGround: 0, isolated: 0, smallGroup: 0, floating: 0 } };
    let drop = new Set<number>();
    if (route === "open") {
      if (o.stripOpen !== false) {
        drop = new Set(parts.map((p) => p.index));
        row.removed.openGround = parts.length;
      }
    } else {
      const r = pruneDetached(parts.map((p) => p.placement), { minParts: o.minParts ?? 3, gap: o.gap ?? 0.5 });
      for (const x of r.removed) {
        drop.add(parts[x.index]!.index);
        if (x.reason === "isolated") row.removed.isolated++;
        else if (x.reason === "small-group") row.removed.smallGroup++;
        else row.removed.floating++;
      }
      const kept = parts.filter((p) => !drop.has(p.index)).map((p) => p.placement);
      const env = envelopeReport(kept);
      row.closed = env.closed;
      row.missing = env.missing;
      if (!env.closed) for (const w of env.missing) missingCounts[w] = (missingCounts[w] ?? 0) + 1;
    }
    buildings.push(row);
    // The collider of a dropped part goes with it.
    const children = (node.children ?? []).filter((c) => {
      const v = VIS.exec(c.id);
      if (v) return !drop.has(Number(v[1]));
      const k = COL.exec(c.id);
      return !(k && drop.has(Number(k[1])));
    });
    return { ...node, children };
  };

  const out: SceneDoc = { ...scene, nodes: scene.nodes.map(fix) };
  const sum = (f: (b: BuildingReport) => number): number => buildings.reduce((a, b) => a + f(b), 0);
  return {
    scene: out,
    report: {
      buildings,
      missingCounts,
      totals: {
        buildings: buildings.length,
        openWithParts: buildings.filter((b) => b.route === "open" && b.parts > 0).length,
        partsRemoved: sum((b) => b.removed.openGround + b.removed.isolated + b.removed.smallGroup + b.removed.floating),
        closed: buildings.filter((b) => b.closed === true).length,
        open: buildings.filter((b) => b.route === "enclosed" && b.closed === false).length,
        unclosed: buildings.filter((b) => b.closed === false).length,
      },
    },
  };
}
