import type { SceneDoc, SceneKind, SceneNode } from "@mmo-engine/scene";
import type { BuildingSynthesisResult, QuatTuple, SynthesisOutput, SynthesizedPlacement } from "./types.js";

export interface SceneExportOptions {
  /** The scene's name: content/scenes/<name>.scene.json. */
  name: string;
  /** The scene kind the server spawns it as (default "arena"). */
  kind?: SceneKind;
  /** Art catalog model per placed asset ref; a part without one is a stand-in box. */
  assets?: Record<string, string>;
  /** Export mode: "standard" (single Structure per part, default) or "modular" (visual Structure + invisible pivot-compensated colliders). */
  mode?: "standard" | "modular";
  /** Optional building group node id prefix when exporting modular placements. */
  idPrefix?: string;
}

export interface BuildingSceneOptions {
  /** Scene node id for the building parent group. */
  id: string;
  /** Settlement archetype label (e.g. "tavern", "house"). */
  archetype: string;
  /** World position [x, y, z] of the building group anchor. */
  position?: [number, number, number];
  /** World yaw around Y in degrees (if omitted, uses baked placement transform). */
  yawDeg?: number;
  /** Optional override map from assetRef -> catalog model id. */
  assets?: Record<string, string>;
  /** Default vendor template when attaching Vendor to shop/tavern counters. */
  vendorTemplate?: string;
  /** Default chest loot table when attaching Chest to lootable containers. */
  chestTable?: string;
}

/** The yaw of a quaternion (x, y, z, w) about the vertical axis, in degrees. */
export function yawDegrees([x, y, z, w]: QuatTuple): number {
  return (Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z)) * 180) / Math.PI;
}

/** Round to millimetres, the precision a scene file keeps. */
const mm = (v: number): number => Math.round(v * 1000) / 1000 || 0;

function localToParent(
  px: number,
  py: number,
  pz: number,
  yawRad: number,
  lx: number,
  ly: number,
  lz: number,
): [number, number, number] {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  return [mm(px + lx * c + lz * s), mm(py + ly), mm(pz - lx * s + lz * c)];
}

/** Compute local axis-aligned bounds of a placed part before Y rotation. */
function localScaledBounds(p: SynthesizedPlacement): {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
} {
  const [sx, sy, sz] = p.transform.scale;
  if (p.pivotBounds) {
    const b = p.pivotBounds;
    const x0 = b.min[0] * sx, x1 = b.max[0] * sx;
    const y0 = b.min[1] * sy, y1 = b.max[1] * sy;
    const z0 = b.min[2] * sz, z1 = b.max[2] * sz;
    return {
      minX: Math.min(x0, x1), maxX: Math.max(x0, x1),
      minY: Math.min(y0, y1), maxY: Math.max(y0, y1),
      minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1),
    };
  }
  const [w, h, d] = p.size;
  return {
    minX: -Math.abs(w) / 2, maxX: Math.abs(w) / 2,
    minY: 0, maxY: Math.abs(h),
    minZ: -Math.abs(d) / 2, maxZ: Math.abs(d) / 2,
  };
}

/** Emit invisible `prefab: "collider"` SceneNodes compensating for GLB pivot, split doorways, and stepped stairs. */
function buildColliderNodes(
  idBase: string,
  p: SynthesizedPlacement,
  yawDeg: number,
): SceneNode[] {
  const mode = p.colliderMode ?? "solid";
  if (mode === "none") return [];

  const [px, py, pz] = p.transform.pos;
  const yawRad = (yawDeg * Math.PI) / 180;
  const lb = localScaledBounds(p);
  const spanX = lb.maxX - lb.minX;
  const spanY = lb.maxY - lb.minY;
  const spanZ = lb.maxZ - lb.minZ;
  const lcx = (lb.minX + lb.maxX) / 2;
  const lcy = (lb.minY + lb.maxY) / 2;
  const lcz = (lb.minZ + lb.maxZ) / 2;

  const boxNode = (suffix: string, lx: number, ly: number, lz: number, hx: number, hy: number, hz: number): SceneNode => ({
    id: `${idBase}-${suffix}`,
    prefab: "collider",
    transform: {
      position: localToParent(px, py, pz, yawRad, lx, ly, lz),
      rotation: [0, mm(yawDeg), 0],
    },
    components: {
      Collider: {
        shape: "box",
        hx: Math.max(0.05, mm(hx)),
        hy: Math.max(0.04, mm(hy)),
        hz: Math.max(0.05, mm(hz)),
      },
    },
  });

  if (mode === "split-doorway") {
    const out: SceneNode[] = [];
    const clearH = Math.min(2.08, Math.max(1.85, spanY * 0.82));
    if (spanX >= spanZ && spanX >= 1.6) {
      const clearW = Math.min(1.25, spanX * 0.48);
      const sideW = (spanX - clearW) / 2;
      const hz = Math.max(0.12, spanZ / 2);
      if (sideW >= 0.08) {
        const hy = Math.max(0.2, spanY / 2);
        out.push(boxNode("jamb-l", lb.minX + sideW / 2, lcy, lcz, sideW / 2, hy, hz));
        out.push(boxNode("jamb-r", lb.maxX - sideW / 2, lcy, lcz, sideW / 2, hy, hz));
      }
      const lintelH = spanY - clearH;
      if (lintelH >= 0.08) {
        out.push(boxNode("lintel", lcx, lb.minY + clearH + lintelH / 2, lcz, clearW / 2, lintelH / 2, hz));
      }
      return out;
    }
    if (spanZ > spanX && spanZ >= 1.6) {
      const clearW = Math.min(1.25, spanZ * 0.48);
      const sideD = (spanZ - clearW) / 2;
      const hx = Math.max(0.12, spanX / 2);
      if (sideD >= 0.08) {
        const hy = Math.max(0.2, spanY / 2);
        out.push(boxNode("jamb-l", lcx, lcy, lb.minZ + sideD / 2, hx, hy, sideD / 2));
        out.push(boxNode("jamb-r", lcx, lcy, lb.maxZ - sideD / 2, hx, hy, sideD / 2));
      }
      const lintelH = spanY - clearH;
      if (lintelH >= 0.08) {
        out.push(boxNode("lintel", lcx, lb.minY + clearH + lintelH / 2, lcz, hx, lintelH / 2, clearW / 2));
      }
      return out;
    }
  }

  if (mode === "stairs" && spanY >= 0.5) {
    // Discretize stairs into walkable steps climbing from +Z bottom toward -Z top
    const steps = Math.max(4, Math.min(12, Math.ceil(spanY / 0.28)));
    const stepH = spanY / steps;
    const treadHy = Math.min(0.18, Math.max(0.09, stepH * 0.52));
    const hx = Math.max(0.35, spanX / 2);
    const stepDepth = spanZ / steps;
    const hz = Math.max(0.14, stepDepth * 0.65);
    const out: SceneNode[] = [];
    for (let s = 0; s < steps; s++) {
      const topY = lb.minY + (s + 1) * stepH;
      const lz = lb.maxZ - (s + 0.5) * stepDepth;
      out.push(boxNode(`step-${s}`, lcx, topY - treadHy, lz, hx, treadHy, hz));
    }
    return out;
  }

  if (mode === "floor") {
    const hy = Math.min(0.16, Math.max(0.06, spanY / 2));
    return [boxNode("floor", lcx, lb.maxY - hy, lcz, spanX / 2, hy, spanZ / 2)];
  }

  return [boxNode("col", lcx, lcy, lcz, spanX / 2, spanY / 2, spanZ / 2)];
}

/**
 * Convert a synthesized `BuildingSynthesisResult` into a hierarchical parent group node
 * containing visual `Structure` parts (`Collider: "none"`) and invisible pivot-compensated
 * `prefab: "collider"` boxes (with split doorway openings and stepped stair treads).
 */
export function buildingToSceneNodes(
  building: Pick<BuildingSynthesisResult, "archetype" | "placements">,
  opts: BuildingSceneOptions,
): SceneNode {
  const vendorTemplate = opts.vendorTemplate ?? "blacksmith";
  const chestTable = opts.chestTable ?? "treasure-chest";
  const children: SceneNode[] = [];

  for (let i = 0; i < building.placements.length; i++) {
    const p = building.placements[i];
    const [w, h, d] = p.size;
    const yawDeg = mm(yawDegrees(p.transform.rot));
    const [sx, sy, sz] = p.transform.scale;
    const nonUnitScale = Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01 || Math.abs(sz - 1) > 0.01;
    const resolvedAsset = opts.assets?.[p.assetRef] ?? p.assetRef;
    const lb = localScaledBounds(p);

    children.push({
      id: `${opts.id}-vis-${i}`,
      name: p.partId,
      transform: {
        position: [mm(p.transform.pos[0]), mm(p.transform.pos[1]), mm(p.transform.pos[2])],
        rotation: [0, yawDeg, 0],
        ...(nonUnitScale ? { scale: [sx, sy, sz] } : {}),
      },
      components: {
        Structure: {
          kind: p.category || p.partId,
          asset: resolvedAsset,
          width: Math.max(0.1, mm(Math.abs(w))),
          depth: Math.max(0.1, mm(Math.abs(d))),
          height: Math.max(0.1, mm(Math.abs(h))),
          // A part's position is its model's pivot, which is not the middle of the model (a wall's pivot is at its top
          // and one end): `centre*` is where the middle lies from the pivot, in the part's own axes, before its yaw.
          centreX: mm((lb.minX + lb.maxX) / 2),
          centreY: mm((lb.minY + lb.maxY) / 2),
          centreZ: mm((lb.minZ + lb.maxZ) / 2),
        },
        Collider: { shape: "none" },
        ...(p.interaction?.kind === "vendor"
          ? { Vendor: { template: p.interaction.template ?? vendorTemplate } }
          : {}),
        ...(p.interaction?.kind === "chest"
          ? { Chest: { table: p.interaction.table ?? chestTable, refillSeconds: 300 } }
          : {}),
        ...(p.interaction?.kind === "door"
          ? { Door: { castSeconds: 0 } }
          : {}),
      },
    });

    children.push(...buildColliderNodes(`${opts.id}-p${i}`, p, yawDeg));
  }

  return {
    id: opts.id,
    name: `building:${opts.archetype}`,
    kind: "group",
    transform: {
      position: opts.position ?? [0, 0, 0],
      rotation: [0, opts.yawDeg ?? 0, 0],
    },
    children,
  };
}

/**
 * A synthesized room or modular building as a scene document.
 * Default `"standard"` mode keeps legacy flat Structure nodes for backwards compatibility;
 * `"modular"` mode emits separate visual Structure meshes + invisible pivot-compensated colliders.
 */
export function synthesisToScene(out: Pick<SynthesisOutput, "placements">, o: SceneExportOptions): SceneDoc {
  if (o.mode === "modular") {
    const group = buildingToSceneNodes(
      { archetype: o.name, placements: out.placements },
      { id: o.idPrefix ?? "part", archetype: o.name, assets: o.assets },
    );
    return { version: 1, name: o.name, kind: o.kind ?? "arena", nodes: [group] };
  }

  const nodes: SceneNode[] = out.placements.map((p, i) => {
    const [w, h, d] = p.size;
    return {
      id: `part-${i}`,
      name: p.partId,
      transform: { position: [...p.transform.pos], rotation: [0, yawDegrees(p.transform.rot), 0] },
      components: {
        Structure: {
          kind: p.category || p.partId,
          asset: o.assets?.[p.assetRef] ?? "",
          width: Math.max(0.1, mm(Math.abs(w))),
          depth: Math.max(0.1, mm(Math.abs(d))),
          height: Math.max(0.1, mm(Math.abs(h))),
        },
      },
    };
  });
  return { version: 1, name: o.name, kind: o.kind ?? "arena", nodes };
}
