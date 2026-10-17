/**
 * The town's layout (spec §16 to §17): a walled street grid in quarters,
 * farms outside along the roads out of the gates, and a parcel on every plot.
 *
 *   - Streets run between blocks as a sparse, connected graph (a node at every
 *     crossing, an edge per street segment); the two streets through the
 *     middle are the primary roads, and they leave the town through its gates
 *     as country roads. Terrain-aware, engineered alignments (spec §28) replace
 *     the grid later behind the same `roads` shape.
 *   - At the crossing of the primary roads is the town square: an open block
 *     with a well, no plots. Round it, each district is one quarter grown block
 *     by block: the civic quarter (town hall, guardhouses, chapel) and the market
 *     quarter on the square, the entertainment quarter (taverns, inns, theatre,
 *     baths) along the main road towards one gate, the education quarter (schools,
 *     library) beside the centre, and housing in the rest. The civic,
 *     entertainment and education quarters are as many blocks as their required
 *     buildings fill; the others take their share of the blocks.
 *   - Outside: the craft quarter (manufacturing) lines the country road out of
 *     one gate, nearest the wall, where the farmers live; beyond it, and along
 *     the other roads, as many farm plots as feed the town (with
 *     `farmSurplusPermille` to spare), dealt round the four roads so every gate
 *     has its fields.
 *   - A town of `fortification.minHouseholds` or more is walled: a ring
 *     between the streets and the farms, made of wall pieces, a tower at each
 *     corner and every `towerSpacingMm`, and a gate (an opening flanked by two
 *     towers) where each primary road crosses it. Smaller places are open villages.
 *   - Every plot faces its street (`facing`, a yaw in degrees), so the buildings
 *     of a block stand in rows with their fronts on the road.
 *   - Geometry is integer millimetres throughout.
 */

import { apportion } from "./apportion.js";
import { entityId } from "./ids.js";
import type { Streams } from "./rng.js";
import { requiredCounts } from "./demand.js";
import { DISTRICT_KINDS, SHARED_DISTRICT_KINDS, type DistrictKind, type SettlementRules } from "./rules.js";

export interface RoadNode {
  id: string;
  x: number;
  z: number;
}

export interface RoadEdge {
  id: string;
  from: string;
  to: string;
  roadClass: "primary_town_road" | "secondary_street" | "country_road";
  lengthMm: number;
  widthMm: number;
}

export interface District {
  id: string;
  kind: DistrictKind;
  /** Blocks it covers (agriculture: its plots, counted in blocks' worth). */
  blocks: number;
  areaM2: number;
}

/** Which way a building's front faces, degrees about +Y: 0 is +z, 90 is +x, 180 is -z, 270 is -x. */
export type Facing = 0 | 90 | 180 | 270;

export interface Parcel {
  id: string;
  district: string;
  kind: DistrictKind;
  /** Position on the town-wide parcel grid (neighbours differ by one; each farm lane is its own row). */
  gx: number;
  gz: number;
  center: { x: number; z: number };
  areaM2: number;
  roadFrontage: boolean;
  /** The street it fronts on: the building turns to face it. Its width runs along the street, its depth away from it. */
  facing: Facing;
}

export type WallPieceKind = "town_wall" | "wall_tower" | "town_gate";

/** One piece of the town wall: a run of wall, a tower or a gate. Length runs along the wall (x at yaw 0, z at yaw 90). */
export interface WallPiece {
  id: string;
  kind: WallPieceKind;
  center: { x: number; z: number };
  lengthMm: number;
  thicknessMm: number;
  yawDeg: 0 | 90;
}

/** The open square at the town's centre: one block with no plots, paved, a well in the middle. */
export interface TownSquare {
  center: { x: number; z: number };
  widthMm: number;
  depthMm: number;
}

/** The quarters inside the walls besides housing, which takes what they leave. */
type Quarter = "civic" | "shopping" | "entertainment" | "education";

export interface Layout {
  /** Blocks along each side of the (square) walled block grid. */
  blocks: number;
  /** Whether the town has a wall (`fortification.minHouseholds`). */
  walled: boolean;
  /** Wall pieces left out because water stands there (a town on a shore is open to the water on that side). */
  wallOpenToWater: number;
  roads: { nodes: RoadNode[]; edges: RoadEdge[] };
  districts: District[];
  /** In district then grid order: a parcel's index is its slot in the structure solve. */
  parcels: Parcel[];
  /** The town wall, empty for an open village. */
  fortifications: WallPiece[];
  /** The town square (a village green for a village); null where water took it. */
  square: TownSquare | null;
}

/** The middle of the road network's bounding box, mm: the town's centre, which a scene puts on its origin. */
export function townCentreMm(nodes: readonly { x: number; z: number }[]): { x: number; z: number } {
  return { x: (Math.min(...nodes.map((n) => n.x)) + Math.max(...nodes.map((n) => n.x))) / 2, z: (Math.min(...nodes.map((n) => n.z)) + Math.max(...nodes.map((n) => n.z))) / 2 };
}

/** The narrowest a street may be, mm: a 0.7 m character capsule always passes, however small the buildings are scaled. */
export const MIN_STREET_MM = 2000;
/** A gate's opening beyond the road's width, mm (a metre each side). */
const GATE_CLEARANCE_MM = 2000;

/**
 * Parcel and street sizes at a building `scale` (a ScaleDoc's `building` factor).
 * The rules are authored for scale 1; parcels follow the factor, streets too but
 * never narrower than MIN_STREET_MM. Integer millimetres.
 */
export function scaledLayout(rules: SettlementRules, scale = 1): { parcelMm: [number, number]; streetMm: number } {
  const { parcelSizeMm, streetWidthMm } = rules.layout;
  return { parcelMm: [Math.round(parcelSizeMm[0] * scale), Math.round(parcelSizeMm[1] * scale)], streetMm: Math.max(MIN_STREET_MM, Math.round(streetWidthMm * scale)) };
}

/** The wall's sizes at a building `scale`, mm (lengths follow the factor like parcels; the gate opening is the road plus a metre each side). */
export function scaledFortification(rules: SettlementRules, scale = 1): { setbackMm: number; thicknessMm: number; pieceMm: number; towerMm: number; towerSpacingMm: number; gateMm: number } {
  const f = rules.fortification;
  const s = (mm: number): number => Math.round(mm * scale);
  return { setbackMm: s(f.setbackMm), thicknessMm: s(f.thicknessMm), pieceMm: s(f.pieceMm), towerMm: s(f.towerMm), towerSpacingMm: s(f.towerSpacingMm), gateMm: scaledLayout(rules, scale).streetMm + GATE_CLEARANCE_MM };
}

/**
 * What a wall piece of each kind must fit, metres at scale 1 (length along the wall, thickness, height): the
 * art side sizes its models to these the way it sizes a building to its parcel.
 */
export function fortificationSizesM(rules: SettlementRules): Record<WallPieceKind, { lengthM: number; thicknessM: number; heightM: number }> {
  const w = scaledFortification(rules, 1);
  const f = rules.fortification;
  return {
    town_wall: { lengthM: w.pieceMm / 1000, thicknessM: w.thicknessMm / 1000, heightM: f.heightM },
    wall_tower: { lengthM: w.towerMm / 1000, thicknessM: w.towerMm / 1000, heightM: f.towerHeightM },
    town_gate: { lengthM: w.gateMm / 1000, thicknessM: w.thicknessMm / 1000, heightM: f.gateHeightM },
  };
}

interface Plan {
  /** Inner (walled) blocks per side. */
  m: number;
  pitchX: number;
  pitchZ: number;
  streetWidthMm: number;
  pw: number;
  pd: number;
  /** Plots of each quarter inside the walls but housing (which takes the rest). */
  quarters: Record<Quarter, number>;
  /** Farm plots outside the town. */
  farms: number;
  /** Craft plots outside the town, along one road. */
  crafts: number;
  walled: boolean;
}

/**
 * How big the town is. The plots it needs for its households are split by the shares (housing, shopping, and the
 * crafts outside); the civic, entertainment and education quarters get a plot for each building that may stand
 * only there, plus a quarter as many again to spare. Each quarter inside is whole blocks (what it leaves of its
 * last block is homes); the square grid the blocks fill holds the town square too, and any spare block is housing.
 * The farms outside feed the town.
 */
function plan(households: number, rules: SettlementRules, scale: number, extraBlocks = 0): Plan {
  const { block, parcelsPerHouseholdPermille } = rules.layout;
  const [bw, bd] = block;
  const perBlock = bw * bd;
  const { parcelMm, streetMm: streetWidthMm } = scaledLayout(rules, scale);
  const [pw, pd] = parcelMm;
  const parcelsWanted = Math.ceil((households * parcelsPerHouseholdPermille) / 1000);
  const shares = apportion(parcelsWanted, rules.districtShares) as Record<(typeof SHARED_DISTRICT_KINDS)[number], number>;
  const people = Math.ceil((households * rules.demographics.householdSizeX10) / 10);
  // The most people `households` can stand for (households are the population over the household size, rounded),
  // so a quarter always has room for what the town's real population requires.
  const counts = requiredCounts(Math.floor(((2 * households + 1) * rules.demographics.householdSizeX10) / 20), rules);
  const onlyIn = (k: DistrictKind): number => Object.entries(counts).reduce((a, [id, c]) => a + (rules.archetypes[id]?.kinds.length === 1 && rules.archetypes[id]!.kinds[0] === k ? c.required : 0), 0);
  const withSpare = (need: number): number => (need > 0 ? need + Math.ceil(need / 4) : 0);
  const quarters: Record<Quarter, number> = {
    civic: withSpare(onlyIn("civic")),
    shopping: Math.max(withSpare(onlyIn("shopping")), shares.shopping),
    entertainment: withSpare(onlyIn("entertainment")),
    education: withSpare(onlyIn("education")),
  };
  const inner = 1 + Object.values(quarters).reduce((a, q) => a + Math.ceil(q / perBlock), 0) + Math.ceil(shares.housing / perBlock);
  const m = Math.max(2, Math.ceil(Math.sqrt(inner))) + extraBlocks;
  // Farms are not blocks: as many plots as it takes to feed the town (with the surplus), by the best-feeding
  // archetype that farms; with none, the agriculture share's plots.
  const feeds = Math.max(0, ...Object.values(rules.archetypes).filter((a) => a.kinds.includes("agriculture")).map((a) => a.feeds));
  // A town grown to make up for wet ground (`extraBlocks`) also gets a farm more on each of its eight lanes per row.
  const farms = (feeds > 0 ? Math.max(1, Math.ceil((people * rules.layout.farmSurplusPermille) / (1000 * feeds))) : shares.agriculture) + 8 * extraBlocks;
  const crafts = Math.max(withSpare(onlyIn("manufacturing")), shares.manufacturing);
  return { m, pitchX: bw * pw + streetWidthMm, pitchZ: bd * pd + streetWidthMm, streetWidthMm, pw, pd, quarters, farms, crafts, walled: households >= rules.fortification.minHouseholds };
}

/** Half the walled town's footprint, metres (the larger side, streets and wall, not the farms outside). Site selection measures relief over it. */
export function townHalfExtentM(households: number, rules: SettlementRules, scale = 1): number {
  const { m, pitchX, pitchZ, streetWidthMm, walled } = plan(households, rules, scale);
  const w = scaledFortification(rules, scale);
  const ring = walled ? 2 * (w.setbackMm + w.thicknessMm) : 0;
  return Math.ceil((m * Math.max(pitchX, pitchZ) + streetWidthMm + ring) / 2000);
}

/** `total` mm as `parts` whole lengths that add up to it exactly. */
function split(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_, i) => base + (i < total - base * parts ? 1 : 0));
}

/** Where on a parcel's footprint (fraction of its size from the centre) dryness is tested: a 5 x 5 grid. */
export const FOOTPRINT_SAMPLES = [-0.5, -0.25, 0, 0.25, 0.5];

/**
 * Whether a plot's whole footprint is dry: `dry` takes mm from the town's `centre`. A plot facing east or west
 * lies across, its width along z.
 */
export function plotIsDry(p: { center: { x: number; z: number }; facing: Facing }, pw: number, pd: number, centre: { x: number; z: number }, dry: (dxMm: number, dzMm: number) => boolean): boolean {
  const [w, d] = p.facing % 180 === 0 ? [pw, pd] : [pd, pw];
  for (const fx of FOOTPRINT_SAMPLES) for (const fz of FOOTPRINT_SAMPLES) if (!dry(p.center.x + fx * w - centre.x, p.center.z + fz * d - centre.z)) return false;
  return true;
}

/**
 * Lays the town out. With `dry` (the world's dryness test, in mm from the town's centre), the quarters keep to dry
 * blocks where they can and the craft quarter takes the driest road out; wet plots are still laid out (the
 * generator drops them).
 */
export function layOut(settlement: string, households: number, rules: SettlementRules, rng: Streams, scale = 1, extraBlocks = 0, dry?: (dxMm: number, dzMm: number) => boolean): Layout {
  const [bw, bd] = rules.layout.block;
  const { m, pitchX, pitchZ, streetWidthMm: s, pw, pd, quarters, farms, crafts, walled } = plan(households, rules, scale, extraBlocks);
  const wall = scaledFortification(rules, scale);

  // Streets: a node at each crossing, an edge per segment.
  const nodeId = (i: number, j: number): string => entityId("junction", settlement, i, j);
  const nodes: RoadNode[] = [];
  for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) nodes.push({ id: nodeId(i, j), x: i * pitchX - s / 2, z: j * pitchZ - s / 2 });
  const mid = Math.floor((m + 1) / 2);
  const edges: RoadEdge[] = [];
  const edge = (from: string, to: string, lengthMm: number, roadClass: RoadEdge["roadClass"]): void => {
    edges.push({ id: entityId("road", settlement, edges.length), from, to, roadClass, lengthMm, widthMm: s });
  };
  for (let j = 0; j <= m; j++) for (let i = 0; i < m; i++) edge(nodeId(i, j), nodeId(i + 1, j), pitchX, j === mid ? "primary_town_road" : "secondary_street");
  for (let i = 0; i <= m; i++) for (let j = 0; j < m; j++) edge(nodeId(i, j), nodeId(i, j + 1), pitchZ, i === mid ? "primary_town_road" : "secondary_street");

  // The town's edge: the outer side of its outermost streets. The wall's centre line (if any) is a setback and
  // half a thickness beyond it; country roads start at the outermost junctions and run out through the gates.
  const lo = { x: -s, z: -s };
  const hi = { x: m * pitchX, z: m * pitchZ };
  const out = walled ? wall.setbackMm + wall.thicknessMm / 2 : 0;
  // Farms start a setback beyond the wall's outer face (or the street, for a village).
  const farmStart = s / 2 + (walled ? 2 * wall.setbackMm + wall.thicknessMm : wall.setbackMm);
  // The lanes either side of each road out (lane l is road l % 4, on side -1 for the first four): the craft plots
  // first, on both sides of the craft side's road, nearest the wall; then the farms, dealt round all eight.
  const lanes = [
    [0, -1], [1, 1], [2, 1], [3, -1],
    [0, 1], [1, -1], [2, -1], [3, 1],
  ] as const;
  const xr = mid * pitchX - s / 2;
  const zr = mid * pitchZ - s / 2;
  // The four ways out: west, east, north, south (dx, dz), each from its outermost junction on the primary road.
  const exits = [
    { from: nodeId(0, mid), at: { x: -s / 2, z: zr }, dx: -1, dz: 0 },
    { from: nodeId(m, mid), at: { x: m * pitchX - s / 2, z: zr }, dx: 1, dz: 0 },
    { from: nodeId(mid, 0), at: { x: xr, z: -s / 2 }, dx: 0, dz: -1 },
    { from: nodeId(mid, m), at: { x: xr, z: m * pitchZ - s / 2 }, dx: 0, dz: 1 },
  ];
  // Where an outside plot stands (lane `lane`, `k` plots out from where the plots start), and which way it faces:
  // back across to its road.
  const outsidePlot = (lane: number, k: number): { center: { x: number; z: number }; facing: Facing } => {
    const [ei, sideSign] = lanes[lane]!;
    const e = exits[ei]!;
    const along = farmStart + k * pw + pw / 2;
    // Across the road: half the road and half the plot's depth, on this lane's side.
    const across = sideSign * (s / 2 + pd / 2);
    const center = e.dx !== 0 ? { x: e.at.x + e.dx * along, z: e.at.z + across } : { x: e.at.x + across, z: e.at.z + e.dz * along };
    return { center, facing: e.dx !== 0 ? (sideSign < 0 ? 0 : 180) : sideSign < 0 ? 90 : 270 };
  };
  // A plot is wet when the world's `dry` test (relative to the town's centre) fails anywhere on its footprint.
  const centre = { x: (m * pitchX - s) / 2, z: (m * pitchZ - s) / 2 };
  const wet = (p: { center: { x: number; z: number }; facing: Facing }): boolean => !!dry && !plotIsDry(p, pw, pd, centre, dry);
  // The craft quarter's c-th plot on the road out of side `k`: both sides of the road, nearest the wall first.
  const craftLanesOf = (k: number): number[] => lanes.flatMap(([ei], l) => (ei === k ? [l] : []));
  const craftPlot = (k: number, c: number): { lane: number; k: number } => ({ lane: craftLanesOf(k)[c % 2]!, k: Math.floor(c / 2) });

  // Quarters. The square is the block nearest the centre (distance in half-block units, so it stays integer);
  // each quarter then grows from its best block, a neighbour of what it has at a time, so it stays one piece.
  // The craft side (the "districts" stream picks it) is the road the craft quarter lines outside; the
  // entertainment quarter runs along the main road towards the opposite gate, where travellers come in.
  const blocks: { bx: number; bz: number }[] = [];
  for (let bz = 0; bz < m; bz++) for (let bx = 0; bx < m; bx++) blocks.push({ bx, bz });
  const dist = (b: { bx: number; bz: number }): number => (2 * b.bx - (m - 1)) ** 2 + (2 * b.bz - (m - 1)) ** 2;
  const key = (b: { bx: number; bz: number }): string => `${b.bx},${b.bz}`;
  const order = (a: { bx: number; bz: number }, b: { bx: number; bz: number }): number => a.bz - b.bz || a.bx - b.bx;
  const kindOf = new Map<string, DistrictKind | "square">();
  const plotCenter = (gx: number, gz: number): { x: number; z: number } => ({ x: Math.floor(gx / bw) * pitchX + (gx % bw) * pw + pw / 2, z: Math.floor(gz / bd) * pitchZ + (gz % bd) * pd + pd / 2 });
  const innerFacing = (gz: number): Facing => (gz % bd < bd / 2 ? 180 : 0);
  const wetPlots = (b: { bx: number; bz: number }): number => {
    let n = 0;
    for (let gz = b.bz * bd; gz < (b.bz + 1) * bd; gz++) for (let gx = b.bx * bw; gx < (b.bx + 1) * bw; gx++) if (wet({ center: plotCenter(gx, gz), facing: innerFacing(gz) })) n++;
    return n;
  };
  const squareBlock = [...blocks].sort((a, b) => dist(a) - dist(b) || order(a, b))[0]!;
  kindOf.set(key(squareBlock), "square");
  // The craft side: the "districts" stream's pick, or the next side round where less of the craft quarter is wet.
  const first = Math.floor(rng.get("districts").raw() * 4);
  const wetCrafts = (k: number): number => Array.from({ length: crafts }, (_, c) => craftPlot(k, c)).filter((p) => wet(outsidePlot(p.lane, p.k))).length;
  const side = [0, 1, 2, 3].map((i) => (first + i) % 4).reduce((best, k) => (wetCrafts(k) < wetCrafts(best) ? k : best));
  const gateSide = side ^ 1;
  // Blocks from the gate side's edge, and from the primary road running out through it.
  const fromSide = (b: { bx: number; bz: number }, k: number): number => [b.bx, m - 1 - b.bx, b.bz, m - 1 - b.bz][k]!;
  const fromRoad = (b: { bx: number; bz: number }, k: number): number => (k < 2 ? Math.abs(2 * b.bz + 1 - 2 * mid) : Math.abs(2 * b.bx + 1 - 2 * mid));
  const grow = (kind: Quarter, plots: number, score: (b: { bx: number; bz: number }) => number): void => {
    const region: { bx: number; bz: number }[] = [];
    const touches = (b: { bx: number; bz: number }): boolean => region.some((r) => Math.abs(r.bx - b.bx) + Math.abs(r.bz - b.bz) === 1);
    for (let left = plots; left > 0; left -= bw * bd) {
      const free = blocks.filter((b) => !kindOf.has(key(b)));
      const near = region.length ? free.filter(touches) : free;
      // A block with wet plots is taken only when no dry one is left.
      const pick = (near.length ? near : free).sort((a, b) => wetPlots(a) - wetPlots(b) || score(a) - score(b) || order(a, b))[0];
      if (!pick) return;
      kindOf.set(key(pick), kind);
      // The quarter's plots in its last block are the ones nearest the square; the rest are homes.
      quota.set(key(pick), Math.min(left, bw * bd));
      region.push(pick);
    }
  };
  const quota = new Map<string, number>();
  // The civic quarter and the market on the square; inns and taverns from the gate in along the main road;
  // schools beside the centre, on the far side from the inns.
  grow("civic", quarters.civic, dist);
  grow("shopping", quarters.shopping, dist);
  grow("entertainment", quarters.entertainment, (b) => (m + 1) * fromRoad(b, gateSide) + fromSide(b, gateSide));
  grow("education", quarters.education, (b) => dist(b) - fromSide(b, gateSide));
  for (const b of blocks) if (!kindOf.has(key(b))) kindOf.set(key(b), "housing");
  // Each plot's district: its block's quarter for the `quota` plots nearest the square, housing for the rest.
  const sq = { x: squareBlock.bx * pitchX + (bw * pw) / 2, z: squareBlock.bz * pitchZ + (bd * pd) / 2 };
  const plotKind = new Map<string, DistrictKind>();
  for (const b of blocks) {
    const k = kindOf.get(key(b))!;
    if (k === "square") continue;
    const plots: { gx: number; gz: number; d: number }[] = [];
    for (let dz = 0; dz < bd; dz++) {
      for (let dx = 0; dx < bw; dx++) {
        const gx = b.bx * bw + dx;
        const gz = b.bz * bd + dz;
        const c = plotCenter(gx, gz);
        plots.push({ gx, gz, d: (c.x - sq.x) ** 2 + (c.z - sq.z) ** 2 });
      }
    }
    plots.sort((a, c) => a.d - c.d || a.gz - c.gz || a.gx - c.gx);
    const q = quota.get(key(b)) ?? plots.length;
    plots.forEach((p, i) => plotKind.set(`${p.gx},${p.gz}`, i < q ? (k as DistrictKind) : "housing"));
  }

  const districts: District[] = DISTRICT_KINDS.map((kind, i) => {
    const plots = kind === "agriculture" ? farms : kind === "manufacturing" ? crafts : [...plotKind.values()].filter((k) => k === kind).length;
    return { id: entityId("district", settlement, i), kind, blocks: Math.ceil(plots / (bw * bd)), areaM2: (plots * pw * pd) / 1_000_000 };
  });

  // The plots along the roads out: the craft quarter first, then the farms, dealt round all eight lanes.
  const used = lanes.map(() => 0);
  const plotAt: { lane: number; k: number }[] = [];
  for (let c = 0; c < crafts; c++) {
    const p = craftPlot(side, c);
    used[p.lane] = p.k + 1;
    plotAt.push(p);
  }
  for (let f = 0; f < farms; f++) {
    const lane = f % 8;
    plotAt.push({ lane, k: used[lane]!++ });
  }
  const roadOut = farmStart + Math.max(1, ...used) * pw;
  exits.forEach((e, k) => {
    let from = e.from;
    if (walled) {
      // The gate: where the road crosses the wall's centre line.
      const reach = s / 2 + out;
      const gate = { id: entityId("gatehouse", settlement, k), x: e.at.x + e.dx * reach, z: e.at.z + e.dz * reach };
      nodes.push(gate);
      edge(from, gate.id, reach, "country_road");
      from = gate.id;
    }
    const end = { id: entityId("roadend", settlement, k), x: e.at.x + e.dx * roadOut, z: e.at.z + e.dz * roadOut };
    nodes.push(end);
    edge(from, end.id, roadOut - (walled ? s / 2 + out : 0), "country_road");
  });

  const parcels: Parcel[] = [];
  districts.forEach((d, di) => {
    let index = 0;
    if (d.kind === "agriculture" || d.kind === "manufacturing") {
      // Outside plots, each on its lane, facing back across to the road. A lane is its own parcel row.
      const [from, count] = d.kind === "manufacturing" ? [0, crafts] : [crafts, farms];
      for (const { lane, k } of plotAt.slice(from, from + count)) {
        const { center, facing } = outsidePlot(lane, k);
        parcels.push({ id: entityId("parcel", settlement, di, index++), district: d.id, kind: d.kind, gx: k, gz: -1000 * (1 + lane), center, areaM2: (pw * pd) / 1_000_000, roadFrontage: true, facing });
      }
      return;
    }
    for (let gz = 0; gz < m * bd; gz++) {
      for (let gx = 0; gx < m * bw; gx++) {
        if (plotKind.get(`${gx},${gz}`) !== d.kind) continue;
        // The block's front rows face the street before them (-z), its back rows the street behind (+z).
        const facing = innerFacing(gz);
        parcels.push({
          id: entityId("parcel", settlement, di, index++),
          district: d.id,
          kind: d.kind,
          gx,
          gz,
          center: plotCenter(gx, gz),
          areaM2: (pw * pd) / 1_000_000,
          roadFrontage: true,
          facing,
        });
      }
    }
  });
  const square: TownSquare = { center: sq, widthMm: bw * pw, depthMm: bd * pd };
  return { blocks: m, walled, wallOpenToWater: 0, roads: { nodes, edges }, districts, parcels, fortifications: walled ? fortify(settlement, lo, hi, out, { x: xr, z: zr }, wall) : [], square };
}

/**
 * The wall ring around the box `lo`..`hi` (the streets' outer edge), its centre line `out` beyond it: a tower at
 * each corner (on the north and south runs), a gate with a tower each side where the primary roads (`road`) cross,
 * and between them wall pieces no longer than `pieceMm`, with a tower wherever a stretch would pass `towerSpacingMm`.
 */
function fortify(settlement: string, lo: { x: number; z: number }, hi: { x: number; z: number }, out: number, road: { x: number; z: number }, w: ReturnType<typeof scaledFortification>): WallPiece[] {
  const pieces: WallPiece[] = [];
  const t = w.towerMm;
  const add = (kind: WallPieceKind, a: number, lengthMm: number, fixed: number, alongX: boolean): void => {
    pieces.push({ id: entityId("wall", settlement, pieces.length), kind, center: alongX ? { x: a, z: fixed } : { x: fixed, z: a }, lengthMm, thicknessMm: kind === "wall_tower" ? t : w.thicknessMm, yawDeg: alongX ? 0 : 90 });
  };
  // A run of wall from `a0` to `a1` along one side: towers where it is too long between towers, wall pieces between.
  const run = (a0: number, a1: number, fixed: number, alongX: boolean): void => {
    const span = a1 - a0;
    if (span <= 0) return;
    const stretches = Math.max(1, Math.ceil(span / (w.towerSpacingMm + t)));
    const lengths = split(span - (stretches - 1) * t, stretches);
    let a = a0;
    lengths.forEach((len, i) => {
      for (const piece of split(len, Math.max(1, Math.ceil(len / w.pieceMm)))) {
        add("town_wall", a + piece / 2, piece, fixed, alongX);
        a += piece;
      }
      if (i < lengths.length - 1) {
        add("wall_tower", a + t / 2, t, fixed, alongX);
        a += t;
      }
    });
  };
  // A side from `a0` to `a1` with the gate at `g`: posts (towers, the gate) and the runs between them.
  const side = (a0: number, a1: number, g: number, fixed: number, alongX: boolean, corners: boolean): void => {
    const posts: { kind: WallPieceKind; a: number; len: number }[] = [];
    if (corners) posts.push({ kind: "wall_tower", a: a0 + t / 2, len: t });
    posts.push({ kind: "wall_tower", a: g - w.gateMm / 2 - t / 2, len: t }, { kind: "town_gate", a: g, len: w.gateMm }, { kind: "wall_tower", a: g + w.gateMm / 2 + t / 2, len: t });
    if (corners) posts.push({ kind: "wall_tower", a: a1 - t / 2, len: t });
    let at = a0;
    for (const p of posts) {
      run(at, p.a - p.len / 2, fixed, alongX);
      add(p.kind, p.a, p.len, fixed, alongX);
      at = p.a + p.len / 2;
    }
    run(at, a1, fixed, alongX);
  };
  const x0 = lo.x - out;
  const x1 = hi.x + out;
  const z0 = lo.z - out;
  const z1 = hi.z + out;
  // North and south run corner to corner (outer tower faces); west and east fit between the corner towers.
  side(x0 - t / 2, x1 + t / 2, road.x, z0, true, true);
  side(x0 - t / 2, x1 + t / 2, road.x, z1, true, true);
  side(z0 + t / 2, z1 - t / 2, road.z, x0, false, false);
  side(z0 + t / 2, z1 - t / 2, road.z, x1, false, false);
  return pieces;
}
