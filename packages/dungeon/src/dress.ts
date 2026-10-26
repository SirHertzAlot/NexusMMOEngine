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
import type { Content, Dressing } from "./dressing.js";
import {
  layBefore,
  layBehind,
  layCluster,
  layColonnade,
  layCorners,
  layFlank,
  layGrid,
  layHead,
  layLine,
  layOver,
  layRing,
  layRow,
  layWallFlush,
  reachOf,
  type ArrangeCtx,
} from "./arrange.js";

export interface DressedProp {
  kind: string;
  /** Grid cells (continuous: cell (i, j) spans [i, i+1) × [j, j+1)). */
  x: number;
  y: number;
  rot: number;
  room: number;
  mount: boolean;
  /** Footprint radius, cells. */
  radius: number;
  /** Whether it blocks bodies (the dressing line's `collision`). */
  collision: "solid" | "none";
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

/** Organic floor clutter that naturally lies at arbitrary angles; all other floor/centre furniture snaps to room axes. */
const ORGANIC_CLUTTER = new Set([
  "rubble",
  "bone-pile",
  "mushrooms",
  "sack",
  "coin-pile",
  "candles",
  "frozen-body",
  "root-knot",
  "ritual-circle",
]);

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
  // Precompute a flat nearDoorMask (1 = cell has a doorway in its 3x3 neighborhood) once per dungeon
  const nearDoorMask = new Uint8Array(d.width * d.height);
  for (let cy = 0; cy < d.height; cy++) {
    for (let cx = 0; cx < d.width; cx++) {
      if (!d.doorway[cy * d.width + cx]) continue;
      for (let oy = -1; oy <= 1; oy++) {
        const ny = cy + oy;
        if (ny < 0 || ny >= d.height) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox;
          if (nx >= 0 && nx < d.width) nearDoorMask[ny * d.width + nx] = 1;
        }
      }
    }
  }
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
        return d.roomId[c] === r && d.grid[c] === CELL.floor && !d.lake[c] && !nearDoorMask[c];
      },
    };
  };
  // The room's doorways stay reachable from each other across free floor: bodies walk round what blocks them (discs of the
  // item's radius), so a pattern that would wall a doorway off gives up its last items (they are scattered instead).
  const reachable = (r: number, solids: readonly { x: number; y: number; radius: number }[]): boolean => {
    const reg = regionOf(r);
    const touches = (cx: number, cy: number): boolean => {
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++)
          if (cx + ox >= 0 && cy + oy >= 0 && cx + ox < d.width && cy + oy < d.height && d.roomId[(cy + oy) * d.width + cx + ox] === r) return true;
      return false;
    };
    const doors: number[] = [];
    for (let cy = reg.y0; cy < reg.y1; cy++)
      for (let cx = reg.x0; cx < reg.x1; cx++)
        if (d.doorway[cy * d.width + cx] && touches(cx, cy)) doors.push(cy * d.width + cx);
    if (doors.length < 2) return true;
    const open = (cx: number, cy: number): boolean => {
      const k = cy * d.width + cx;
      return d.grid[k] === CELL.floor && (d.roomId[k] === r || !!d.doorway[k]) && !solids.some((p) => Math.hypot(cx + 0.5 - p.x, cy + 0.5 - p.y) < p.radius);
    };
    const seen = new Set<number>([doors[0]]);
    const stack = [doors[0]];
    while (stack.length) {
      const k = stack.pop()!;
      const [cx, cy] = [k % d.width, Math.floor(k / d.width)];
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const [nx, ny] = [cx + ox, cy + oy];
        if (nx < reg.x0 || ny < reg.y0 || nx >= reg.x1 || ny >= reg.y1 || seen.has(ny * d.width + nx) || !open(nx, ny)) continue;
        seen.add(ny * d.width + nx);
        stack.push(ny * d.width + nx);
      }
    }
    return doors.every((k) => !open(k % d.width, Math.floor(k / d.width)) || seen.has(k));
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
          cost: counts.map((_, n) => n * Math.PI * k.radius * (k.reach ?? k.radius) * 4),
          max: floor * (arch.fill ?? 0.6),
          slots: [i],
        })),
      },
      deriveSeed(seed, STAGE.inventory * 1000 + r),
      () => relaxed.push(`inventory:${r}`),
    );
    type Item = PlaceItem & { kind: string; collision: "solid" | "none"; line: Content };
    const items: Item[] = [];
    lines.forEach((k, i) => {
      // `before` and `behind` lines have one item per item of their anchor, laid after it (their WFC count is not used).
      if (k.arrange === "before" || k.arrange === "behind") return;
      const radius = Math.max(k.radius, k.reach ?? 0); // the footprint a scattered item needs (a pattern uses the line's own radius and reach)
      for (let n = 0; n < inv.assignment[i]; n++) items.push({ kind: k.kind, where: k.where, radius, mount: k.mount, collision: k.collision ?? (k.mount ? "none" : "solid"), line: k });
    });
    const region = regionOf(r);
    const poses = new Map<string, Placed[]>();
    /** What hangs on this room's walls (mounted rows): clear only of each other. */
    const mountedHere = new Map<string, Placed[]>();
    const mountedOf = (kind: string): Placed[] => mountedHere.get(kind) ?? [];
    const alongRoomX = _room.w >= _room.h;
    const roomAxisRot = alongRoomX ? 0 : Math.PI / 2;
    const record = (it: Item, p: Placed, hung = false, snapArchitectural = false): void => {
      let finalRot = p.rot;
      if (snapArchitectural && !it.mount && !ORGANIC_CLUTTER.has(it.kind)) {
        if (it.where === "centre" || it.where === "floor") {
          // Align centre/floor architectural furniture (sarcophagi, tables, lecterns, cauldrons) with the room's axes
          finalRot = Math.round(p.rot / (Math.PI / 2)) * (Math.PI / 2);
          if (it.where === "centre" && (it.line.reach ?? it.line.radius) !== it.line.radius) {
            finalRot = roomAxisRot;
          }
        } else if (it.where === "wall") {
          // Snap wall furniture normals to the 4 cardinal directions so desks/workbenches/racks never sit skewed on stair-step corners
          finalRot = Math.round(p.rot / (Math.PI / 2)) * (Math.PI / 2);
        }
      }
      const placedPose: Placed = { ...p, rot: finalRot };
      // What later items keep clear of is the item's whole footprint (its length along its facing too); a hung item is clear of the floor.
      if (hung) mountedHere.set(it.kind, [...mountedOf(it.kind), placedPose]);
      else layoutTaken[r].push({ ...placedPose, radius: Math.max(placedPose.radius, reachOf(placedPose)) });
      poses.set(it.kind, [...(poses.get(it.kind) ?? []), placedPose]);
      props.push({ kind: it.kind, x: placedPose.x, y: placedPose.y, rot: placedPose.rot, room: r, mount: !!it.mount, radius: Math.max(it.radius, reachOf(placedPose)), collision: it.collision });
    };
    // Scatter a batch (each item on its own, as the dressing always has); the items with no room come back.
    const scatter = (batch: Item[], batchNo: number): Item[] => {
      if (batch.length === 0) return [];
      const spots = placeInRegion(sdf, region, batch, { seed: deriveSeed(seed, STAGE.place * 1000 + r + 10_000 * batchNo), taken: layoutTaken[r] });
      const left: Item[] = [];
      spots.forEach((p, i) => (p ? record(batch[i], p) : left.push(batch[i])));
      return left;
    };
    // Big and centre pieces first.
    const bigFirst = (a: Item, b: Item): number => Number(b.where === "centre") - Number(a.where === "centre") || b.radius - a.radius;
    if (lines.every((k) => k.arrange === "scatter")) {
      items.sort(bigFirst);
      unplaced += scatter(items, 0).length;
    } else {
      // The room's focal pieces (centre items, and what other lines stand round) and its corner items first (corners are the
      // scarcest spots), then each arranged line in its pattern (an anchor line before the lines that use it), then everything
      // else, and what a pattern had no room for, scattered.
      const solidsHere = (): { x: number; y: number; radius: number }[] => props.filter((p) => p.room === r && !p.mount && p.collision === "solid");
      /** Run a scattering stage; if it walled off a doorway the room had open, take its last items back. Returns the items it could not place. */
      const guarded = (stage: () => Item[]): number => {
        const open = reachable(r, solidsHere());
        const mark = props.length;
        let n = stage().length;
        while (open && props.length > mark && !reachable(r, solidsHere())) {
          props.pop();
          layoutTaken[r].pop();
          n++;
        }
        return n;
      };
      const anchors = new Set(lines.filter((k) => k.arrange !== "scatter" && k.anchor).map((k) => k.anchor!));
      const focal = (it: Item): boolean => it.line.arrange === "scatter" && (it.where === "centre" || it.where === "corner" || anchors.has(it.kind));
      const ctx: ArrangeCtx = { sdf, inside: region.inside!, taken: layoutTaken[r], centre: { x: _room.cx, y: _room.cy }, extent: { w: _room.w, h: _room.h } };

      // Settle wide single wall focal pieces flush against straight wall runs at `reach` distance before general focal scatter
      unplaced += guarded(() => scatter(items.filter(focal).sort(bigFirst), 1));

      /** `laid` less its last items until it no longer walls off a doorway the room's other items leave open. */
      const keepOpen = (laid: Placed[], line: Content): Placed[] => {
        if (line.collision === "none" || (line.mount && !line.collision)) return laid;
        const before = solidsHere();
        if (!reachable(r, before)) return laid;
        let kept = laid;
        while (kept.length > 0 && !reachable(r, [...before, ...kept])) kept = kept.slice(0, -1);
        return kept;
      };

      



      const leftover: Item[] = items.filter((it) => it.line.arrange === "scatter" && !focal(it));
      const arrangedLines = lines.filter((k) => k.arrange !== "scatter").sort((a, b) => Number(anchors.has(b.kind)) - Number(anchors.has(a.kind)));

      arrangedLines.forEach((line, li) => {
        const its = items.filter((it) => it.line === line);
        const anchor = line.anchor ? poses.get(line.anchor)?.[0] : undefined;
        const template: Item = { kind: line.kind, where: line.where, radius: line.radius, mount: line.mount, collision: line.collision ?? (line.mount ? "none" : "solid"), line };
        const opts = { ...(line.reach ? { reach: line.reach } : {}), ...(line.mount ? { mounted: true } : {}), ...(line.aisle ? { aisle: line.aisle } : {}) };
        let laid: Placed[] = [];
        if (line.arrange === "row") {
          // Rows on the wall that holds the most (the best of a dozen spots round the walls); what is left over starts another
          // row on another wall, and what that cannot fit is scattered.
          const rowCtx: ArrangeCtx = line.mount ? { ...ctx, taken: mountedOf(line.kind) } : ctx;
          for (let pass = 0; pass < 4 && laid.length < its.length; pass++) {
            const wallSpots = placeInRegion(sdf, region, Array.from({ length: 12 }, () => ({ where: "wall" as const, radius: line.reach ?? line.radius, ...(line.mount ? { mount: true } : {}) })), { seed: deriveSeed(seed, STAGE.place * 1000 + r + 10_000 * (3 + li) + 100_000 * pass), taken: line.mount ? mountedOf(line.kind) : layoutTaken[r] });
            let best: Placed[] = [];
            const take = its.length - laid.length;
            for (const wall of wallSpots) {
              const row = wall ? layRow(rowCtx, wall, line.radius, take, line.gap, opts) : [];
              if (row.length > best.length) best = row;
            }
            best = keepOpen(best, line);
            if (best.length === 0) break;
            best.forEach((p, k) => record(its[laid.length + k], p, !!line.mount));
            laid = [...laid, ...best];
          }
        } else if (line.arrange === "head") {
          // One item at the head of the room: the middle of the longest free run of wall.
          const seeds = placeInRegion(sdf, region, Array.from({ length: 12 }, () => ({ where: "wall" as const, radius: line.reach ?? line.radius })), { seed: deriveSeed(seed, STAGE.place * 1000 + r + 10_000 * (3 + li)), taken: layoutTaken[r] });
          laid = its.length === 0 ? [] : keepOpen(layHead(ctx, seeds.filter((p): p is Placed => !!p), line.radius, opts), line);
          laid.forEach((p, k) => record(its[k], p));
        } else if (line.arrange === "corners") {
          // Symmetrical placement across the room's 4 concave corners facing inward toward the room's centre.
          const seeds = placeInRegion(sdf, region, Array.from({ length: 6 }, () => ({ where: "corner" as const, radius: line.reach ?? line.radius })), { seed: deriveSeed(seed, STAGE.place * 1000 + r + 10_000 * (3 + li)), taken: layoutTaken[r] });
          laid = its.length === 0 ? [] : keepOpen(layCorners(ctx, seeds.filter((p): p is Placed => !!p), line.radius, its.length, line.gap, opts), line);
          laid.forEach((p, k) => record(its[k], p));
        } else if (line.arrange === "colonnade") {
          // Paired symmetrical columns/statues flanking the central nave axis.
          laid = keepOpen(layColonnade(ctx, line.radius, its.length, line.gap, line.at ?? 2.0, opts), line);
          laid.forEach((p, k) => record(its[k], p));
        } else if (line.arrange === "cluster") {
          // Tight functional grouping around anchor props (e.g. barrels/sacks beside crates).
          const anchorList = line.anchor ? poses.get(line.anchor) ?? [] : [];
          laid = keepOpen(layCluster(ctx, anchorList, line.radius, its.length, line.gap, opts), line);
          laid.forEach((p, k) => record(its[k], p));
        } else if (line.arrange === "over") {
          // One over each item of the anchor kind (the upper tier of a wall of niches).
          layOver(line.anchor ? poses.get(line.anchor) ?? [] : [], line.radius, opts).forEach((p) => record(template, p, !!line.mount));
          return;
        } else if (line.arrange === "before") {
          // One item in front of each item of the anchor kind; the room's other items keep their places.
          const front = layBefore(ctx, line.anchor ? poses.get(line.anchor) ?? [] : [], line.radius, line.gap, opts);
          keepOpen(front, line).forEach((p) => record(template, p));
          return;
        } else if (line.arrange === "behind") {
          // One item behind each item of the anchor kind (e.g. pairing benches on both sides of long-tables and reading-tables).
          const back = layBehind(ctx, line.anchor ? poses.get(line.anchor) ?? [] : [], line.radius, line.gap, opts);
          keepOpen(back, line).forEach((p) => record(template, p));
          return;
        } else {
          if (line.arrange === "grid") laid = layGrid(ctx, line.radius, its.length, line.gap, anchor ?? null, opts);
          else if (line.arrange === "line") laid = layLine(ctx, line.radius, its.length, line.gap, line.at ?? 0, opts);
          else if (anchor && (line.arrange === "flank" || line.arrange === "beside")) laid = layFlank(ctx, anchor, line.radius, its.length, line.gap, line.arrange === "flank" ? 2 : 1, opts);
          else if (anchor && line.arrange === "ring") laid = layRing(ctx, anchor, line.radius, its.length, line.gap, line.faces === "out" ? "out" : "in", opts);
          laid = keepOpen(laid, line);
          laid.forEach((p, k) => record(its[k], p));
        }
        // What a row, corners, or cluster could not fit still goes along a wall/corner, and a line whose anchor never came is scattered as plain items; what a
        // line, grid, colonnade, flank or ring could not fit is left out: a sarcophagus or a pew at a random angle would spoil the arrangement.
        const needsAnchor = line.arrange === "flank" || line.arrange === "beside" || line.arrange === "ring" || line.arrange === "cluster";
        const hasOver = lines.some((l) => l.arrange === "over" && l.anchor === line.kind);
        if ((line.arrange === "row" && !hasOver) || line.arrange === "head" || line.arrange === "corners" || line.arrange === "cluster" || (needsAnchor && !anchor)) leftover.push(...its.slice(laid.length));
        else unplaced += its.length - laid.length;
      });
      unplaced += guarded(() => scatter(leftover.sort(bigFirst), 2));
    }
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
