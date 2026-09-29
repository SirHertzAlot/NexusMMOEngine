/**
 * Dressing a dungeon: WFC decides what; scatter and the raymarcher decide
 * where.
 *
 *  What (WFC, @mmo-engine/wfc):
 *   1. each room's archetype, over the room graph: by role, theme, size
 *      and rank; never beside an archetype it avoids, beside one it needs
 *      (a storeroom by a barracks), at most so many of a kind;
 *   2. each room's inventory: how many of each of its archetype's items,
 *      within the room's floor capacity (a budget);
 *   3. which vein kind (if any) each room carries, by rank and depth, with
 *      rooms side by side sharing one seam kind.
 *  Where (@mmo-engine/placement): the dungeon grid becomes a distance
 *   field; within each room scatter proposes spots and the raymarcher
 *   settles each item on the floor, in the open centre, against a wall or
 *   into a corner, clear of doorways, of the layout's own props and spawns,
 *   and of each other. A seam's veins are mounted on the walls close
 *   together.
 *
 * Deterministic: the same dungeon, dressing, rank and seed dress the same.
 */

import { GridSdf, placeInRegion, type PlaceItem, type Placed } from "@mmo-engine/placement";
import { solve, type WfcNeed, type WfcOption, type WfcProblem } from "@mmo-engine/wfc";
import { CELL, type Dungeon } from "./generate.js";
import { deriveSeed } from "./rng.js";
import type { Dressing } from "./dressing.js";

export interface DressedProp {
  kind: string;
  /** Grid cells (continuous: cell (i, j) spans [i, i+1) × [j, j+1)). */
  x: number;
  y: number;
  rot: number;
  room: number;
  mount: boolean;
}

export interface Resource {
  kind: string;
  tier: number;
  x: number;
  y: number;
  /** The wall's facing (the vein faces out of it). */
  nx: number;
  ny: number;
  room: number;
}

export interface DungeonDressing {
  rank: number;
  /** Archetype per room ("" where none fits). */
  archetypes: string[];
  /** Vein kind per room ("" for none). */
  seams: string[];
  props: DressedProp[];
  resources: Resource[];
  /** Items the inventory asked for that had no room. */
  unplaced: number;
  /** Solves whose constraints couldn't all hold, so were loosened (a dressing too strict for this layout). */
  relaxed: string[];
}

const STAGE = { archetype: 1, inventory: 2, seams: 3, place: 4 } as const;

export function dressDungeon(d: Dungeon, dressing: Dressing, rank: number, seed = d.seed): DungeonDressing {
  if (!Number.isInteger(rank) || rank < 1) throw new RangeError(`rank must be a whole number >= 1 (got ${rank})`);
  const theme = d.params.theme;
  const rooms = d.rooms;
  const N = rooms.length;
  const adjacency = d.corridors.map((e) => ({ a: e.a, b: e.b, rule: "adjacent" as const }));

  // ---- 1. archetypes ----------------------------------------------------
  const archIds = Object.keys(dressing.archetypes);
  const archOptions: WfcOption[] = [...archIds.map((id) => ({ id, weight: dressing.archetypes[id].weight })), { id: "", weight: 1e-6 }];
  const plain = archIds.length;
  const archDomains = rooms.map((r) => {
    const size = Math.min(r.w, r.h);
    const fits = archIds.flatMap((id, i) => {
      const arch = dressing.archetypes[id];
      return arch.roles.includes(r.type) && (!arch.themes || arch.themes.includes(theme)) && size >= arch.minSize ? [i] : [];
    });
    // Nothing fits: the room stays plain (an unseen fallback, never chosen otherwise).
    return fits.length > 0 ? fits : [plain];
  });
  const archNeeds: WfcNeed[] = archIds.flatMap((id, i) => {
    const near = dressing.archetypes[id].near.map((n) => archIds.indexOf(n)).filter((k) => k >= 0);
    return near.length > 0 ? [{ option: i, from: near }] : [];
  });
  const archProblem: WfcProblem = {
    options: archOptions,
    slots: N,
    domains: archDomains,
    edges: adjacency,
    rules: {
      adjacent: (x, y, xi, yi) => {
        if (xi === plain || yi === plain) return true;
        const ax = dressing.archetypes[x.id], ay = dressing.archetypes[y.id];
        if (xi === yi && !ax.repeatable) return false;
        return !ax.avoid.includes(y.id) && !ay.avoid.includes(x.id);
      },
    },
    needs: archNeeds,
    counts: archIds.flatMap((id, i) => (dressing.archetypes[id].max !== undefined ? [{ options: [i], max: dressing.archetypes[id].max }] : [])),
  };
  const relaxed: string[] = [];
  const archResult = solveOrRelax(archProblem, deriveSeed(seed, STAGE.archetype), () => relaxed.push("archetypes"));
  const archetypes = Array.from(archResult.assignment, (k) => archOptions[k].id);

  // ---- where: the dungeon as a distance field ---------------------------
  // Open space is floor; walls, liquid and the void are solid.
  const sdf = new GridSdf(d.width, d.height, (x, y) => d.grid[y * d.width + x] !== CELL.floor);
  const nearDoor = (x: number, y: number): boolean => {
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const cx = x + ox, cy = y + oy;
        if (cx >= 0 && cy >= 0 && cx < d.width && cy < d.height && d.doorway[cy * d.width + cx]) return true;
      }
    return false;
  };
  const regionOf = (r: number) => {
    const room = rooms[r];
    return {
      x0: Math.max(0, Math.floor(room.cx - room.w / 2) - 1),
      y0: Math.max(0, Math.floor(room.cy - room.h / 2) - 1),
      x1: Math.min(d.width, Math.ceil(room.cx + room.w / 2) + 2),
      y1: Math.min(d.height, Math.ceil(room.cy + room.h / 2) + 2),
      inside: (x: number, y: number): boolean => {
        const cx = Math.floor(x), cy = Math.floor(y);
        if (cx < 0 || cy < 0 || cx >= d.width || cy >= d.height) return false;
        const c = cy * d.width + cx;
        return d.roomId[c] === r && d.grid[c] === CELL.floor && !d.lake[c] && !nearDoor(cx, cy);
      },
    };
  };
  // What the layout already put down, kept clear of.
  const layoutTaken: Placed[][] = rooms.map(() => []);
  for (const p of d.props) if (p.room !== undefined && p.room >= 0 && p.kind !== "debris" && p.kind !== "moss") layoutTaken[p.room].push({ x: p.x + 0.5, y: p.y + 0.5, rot: 0, radius: 0.6 });
  for (const s of d.spawns) layoutTaken[s.room].push({ x: s.x + 0.5, y: s.y + 0.5, rot: 0, radius: 0.5 });

  // ---- 2 + where: each room's inventory, then its placement --------------
  const props: DressedProp[] = [];
  let unplaced = 0;
  rooms.forEach((_room, r) => {
    const arch = archetypes[r] ? dressing.archetypes[archetypes[r]] : undefined;
    if (!arch) return;
    const lines = arch.contents.filter((k) => rank >= k.minRank);
    if (lines.length === 0) return;
    // What: a count per line, the room's floor able to hold them (area budget).
    let floor = 0;
    for (let c = 0; c < d.grid.length; c++) if (d.roomId[c] === r && d.grid[c] === CELL.floor) floor++;
    const maxCount = Math.max(...lines.map((k) => k.count[1]));
    const counts: WfcOption[] = Array.from({ length: maxCount + 1 }, (_, n) => ({ id: String(n), weight: 1 }));
    const inv = solveOrRelax(
      {
        options: counts,
        slots: lines.length,
        domains: lines.map((k) => Array.from({ length: k.count[1] - k.count[0] + 1 }, (_, i) => k.count[0] + i)),
        budgets: lines.map((k, i) => ({
          // Line i's footprint per item, counted only in its own slot.
          cost: counts.map((_, n) => n * Math.PI * k.radius * k.radius * 4),
          max: floor * 0.6,
          slots: [i],
        })),
      },
      deriveSeed(seed, STAGE.inventory * 1000 + r),
      () => relaxed.push(`inventory:${r}`),
    );
    const items: (PlaceItem & { kind: string })[] = [];
    lines.forEach((k, i) => {
      for (let n = 0; n < inv.assignment[i]; n++) items.push({ kind: k.kind, where: k.where, radius: k.radius, mount: k.mount });
    });
    // Where: big and centre pieces first.
    items.sort((p, q) => Number(q.where === "centre") - Number(p.where === "centre") || q.radius - p.radius);
    const spots = placeInRegion(sdf, regionOf(r), items, { seed: deriveSeed(seed, STAGE.place * 1000 + r), taken: layoutTaken[r], reach: 3 });
    spots.forEach((p, i) => {
      if (!p) {
        unplaced++;
        return;
      }
      layoutTaken[r].push(p);
      props.push({ kind: items[i].kind, x: p.x, y: p.y, rot: p.rot, room: r, mount: !!items[i].mount });
    });
  });

  // ---- 3. seams: which vein kind each room carries ----------------------
  const veinIds = Object.keys(dressing.veins).filter((id) => rank >= dressing.veins[id].minRank);
  const seamOptions: WfcOption[] = [{ id: "", weight: 1 }, ...veinIds.map((id) => ({ id, weight: 1 }))];
  const chance = Math.min(0.95, dressing.veinRooms + dressing.veinRoomsPerRank * (rank - 1));
  const K = seamOptions.length;
  const seamWeights = new Float64Array(N * K);
  rooms.forEach((room, r) => {
    const noVeins = room.type === "entrance";
    seamWeights[r * K] = noVeins ? 1 : (1 - chance) * 10;
    const eligible = veinIds.map((id) => {
      const v = dressing.veins[id];
      return noVeins || room.difficulty < v.minDepth ? 0 : v.weight * (v.themes.includes(theme) ? v.themeBoost : 1);
    });
    const total = eligible.reduce((s, w) => s + w, 0);
    eligible.forEach((w, i) => (seamWeights[r * K + 1 + i] = total > 0 ? (w / total) * chance * 10 : 0));
  });
  const seams = solveOrRelax(
    {
      options: seamOptions,
      slots: N,
      weights: seamWeights,
      edges: adjacency,
      // One seam runs through neighbouring rooms: two different kinds never sit side by side.
      rules: { adjacent: (_x, _y, xi, yi) => xi === 0 || yi === 0 || xi === yi },
    },
    deriveSeed(seed, STAGE.seams),
    () => relaxed.push("seams"),
  );
  const seamOf = Array.from(seams.assignment, (k) => seamOptions[k].id);

  // Where: a seam's veins on the room's walls, clustered round the first.
  const resources: Resource[] = [];
  rooms.forEach((room, r) => {
    const kind = seamOf[r];
    if (!kind) return;
    const v = dressing.veins[kind];
    const [lo, hi] = dressing.seam;
    const bigness = Math.min(1, (room.w * room.h) / 200) * 0.5 + Math.min(1, (rank - 1) / 4) * 0.5;
    const n = Math.round(lo + (hi - lo) * bigness);
    const region = regionOf(r);
    const vein: PlaceItem = { where: "wall", radius: 0.3, mount: true };
    const [first] = placeInRegion(sdf, region, [vein], { seed: deriveSeed(seed, STAGE.place * 1000 + 500 + r), taken: layoutTaken[r] });
    if (!first) return;
    const cluster = { ...region, inside: (x: number, y: number) => region.inside(x, y) && Math.hypot(x - first.x, y - first.y) <= 3.5 };
    const rest = placeInRegion(sdf, cluster, Array.from({ length: n - 1 }, () => vein), {
      seed: deriveSeed(seed, STAGE.place * 1000 + 700 + r),
      taken: [...layoutTaken[r], first],
      spacing: 0.4,
    });
    for (const p of [first, ...rest]) {
      if (!p) continue;
      resources.push({ kind, tier: v.tier, x: p.x, y: p.y, nx: p.nx ?? 0, ny: p.ny ?? 0, room: r });
    }
  });

  return { rank, archetypes, seams: seamOf, props, resources, unplaced, relaxed };
}

/**
 * Solve; if the constraints can't all hold (a custom dressing too strict
 * for this layout), drop the needs, then the edge rules, before giving up:
 * a dungeon is better dressed loosely than not at all.
 */
function solveOrRelax(p: WfcProblem, seed: number, onRelax: () => void) {
  try {
    return solve(p, { seed });
  } catch {
    onRelax();
    try {
      return solve({ ...p, needs: [] }, { seed });
    } catch {
      return solve({ ...p, needs: [], edges: [], counts: [] }, { seed });
    }
  }
}
