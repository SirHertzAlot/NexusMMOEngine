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
 *   - Outside: the craft quarter (manufacturing: workshops, smithies and
 *     warehouses) lines the country road out of one gate, `worksBufferMm` clear of
 *     the homes; beyond it, and along the other roads, as many farms as feed the
 *     town (with `farmSurplusPermille` to spare), dealt round the four roads. Each
 *     farm is a holding of its acres (`farming`), one field beside the road with
 *     the farmstead in its yard, so farmsteads stand apart in their own land.
 *   - The watch (`rules.watch`): housing plots get a wealth band (poor at the
 *     edge towards the crafts, well-off by the square), and plots are reserved
 *     for guard posts inside each gate, in the market and in the poor streets,
 *     and for the watch's headquarters and gaol at the back of the civic quarter.
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
import { NO_MASTERY, type TownMastery } from "./mastery.js";
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
  /** How many streets the plot is open to: 2 on a block's corner, else 1. A market needs the traffic of a corner. */
  access: 1 | 2;
  /** A housing plot's wealth band: the well-off streets by the square, the poor ones at the edge towards the crafts. */
  wealth?: Wealth;
  /** A plot reserved for one archetype, and why: the watch's guard posts, its headquarters and the gaol. */
  post?: { archetype: string; why: PostReason };
  /** A farm's land (agriculture): one field, the farmstead in its yard at the road edge. Sizes are along x and z. */
  holding?: Holding;
}

export type Wealth = "high" | "middle" | "low";
export type PostReason = "gate" | "market" | "poor" | "headquarters" | "gaol" | "master";

/** A farm's fields, mm: a rectangle beside its road, its frontage along the road and its depth away from it. */
export interface Holding {
  center: { x: number; z: number };
  sizeXMm: number;
  sizeZMm: number;
  areaM2: number;
}

/** Square metres in an acre. */
export const ACRE_M2 = 4046.8564224;

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
  /** Master farms (rules.mastery), before the ordinary ones, each on `masterField`; and the master farm archetype. */
  masterFarms: number;
  masterField: { frontMm: number; deepMm: number };
  masterFarm: string;
  /** A farm's field: frontage along the road and depth away from it, mm. */
  field: { frontMm: number; deepMm: number };
  /** Guard posts, headquarters and gaols the watch reserves, by why. */
  posts: { gate: number; market: number; poor: number; headquarters: number; gaol: number };
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
function plan(households: number, rules: SettlementRules, scale: number, extraBlocks = 0, mastery: TownMastery = NO_MASTERY): Plan {
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
  const counts = requiredCounts(Math.floor(((2 * households + 1) * rules.demographics.householdSizeX10) / 20), rules, mastery);
  const walled = households >= rules.fortification.minHouseholds;
  const onlyIn = (k: DistrictKind): number => Object.entries(counts).reduce((a, [id, c]) => a + (rules.archetypes[id]?.kinds.length === 1 && rules.archetypes[id]!.kinds[0] === k ? c.required : 0), 0);
  const withSpare = (need: number): number => (need > 0 ? need + Math.ceil(need / 4) : 0);
  const shopping = Math.max(withSpare(onlyIn("shopping")), shares.shopping);
  // Families share homes, so housing is the homes the households need (with a quarter spare), not a plot each.
  const housing = withSpare(Math.ceil((households * 10) / rules.layout.familiesPerHomeX10));
  const watch = rules.watch;
  const posts = {
    gate: watch ? (walled ? 4 : watch.villageEntrancePosts) : 0,
    market: watch ? Math.floor(shopping / watch.marketPlotsPerPost) : 0,
    poor: watch ? Math.floor(Math.floor((housing * watch.lowIncomePermille) / 1000) / watch.poorHomesPerPost) : 0,
    headquarters: watch ? (counts[watch.headquarters]?.required ?? 0) : 0,
    gaol: watch ? (counts[watch.gaol]?.required ?? 0) : 0,
  };
  const quarters: Record<Quarter, number> = {
    civic: withSpare(onlyIn("civic")),
    shopping: shopping + posts.market,
    entertainment: withSpare(onlyIn("entertainment")),
    education: withSpare(onlyIn("education")),
  };
  const inner = 1 + Object.values(quarters).reduce((a, q) => a + Math.ceil(q / perBlock), 0) + Math.ceil((housing + posts.gate + posts.poor) / perBlock);
  const m = Math.max(2, Math.ceil(Math.sqrt(inner))) + extraBlocks;
  // Farms are not blocks: as many plots as it takes to feed the town (with the surplus), by the best-feeding
  // archetype that farms; with none, the agriculture share's plots.
  // Masters' archetypes are not the measure: a master farm is one of the masters' (`masterFarms`), fed first.
  const professions = Object.entries(rules.mastery?.professions ?? {});
  const masterIds = new Set(professions.map(([, p]) => p.master));
  const feeds = Math.max(0, ...Object.entries(rules.archetypes).filter(([id, a]) => a.kinds.includes("agriculture") && !masterIds.has(id)).map(([, a]) => a.feeds));
  const farming = professions.find(([, p]) => rules.archetypes[p.master]?.kinds.includes("agriculture"));
  const masterFarms = farming ? (mastery.masters[farming[0]] ?? 0) : 0;
  const masterFarm = farming?.[1].master ?? "";
  const masterFed = masterFarms * (rules.archetypes[masterFarm]?.feeds ?? 0);
  // A town grown to make up for wet ground (`extraBlocks`) also gets a farm more on each of its eight lanes per row;
  // the ordinary farms always have room for the granaries, mills and monastery that stand only on farmland.
  const fed = feeds > 0 ? Math.ceil(Math.max(0, (people * rules.layout.farmSurplusPermille) / 1000 - masterFed) / feeds) : shares.agriculture;
  const farms = Math.max(masterFarms > 0 ? 0 : 1, fed, withSpare(onlyIn("agriculture") - masterFarms)) + 8 * extraBlocks;
  // A master smith or craftsman does the work of `yield` workshops: the craft quarter needs that many fewer plots.
  const industryMasters = professions.filter(([, p]) => rules.archetypes[p.master]?.kinds.includes("manufacturing")).reduce((a, [name]) => a + (mastery.masters[name] ?? 0), 0);
  const crafts = Math.max(withSpare(onlyIn("manufacturing")), shares.manufacturing - (rules.mastery ? rules.mastery.yield - 1 : 0) * industryMasters);
  // A holding is the acres its farmstead's people need, one field `fieldAspect` times deeper than wide; land
  // follows the building factor like the parcels, and is never narrower than a farmstead's plot.
  const acresMm2 = (feeds * rules.farming.acresPerPersonX10 * ACRE_M2 * 1_000_000 * scale * scale) / 10;
  const frontMm = Math.max(pw, Math.round(Math.sqrt(acresMm2 / rules.farming.fieldAspect)));
  const field = { frontMm, deepMm: Math.max(pd, frontMm * rules.farming.fieldAspect) };
  // A master farm feeds more on a `landFactor`th of the land: each side shrinks by its square root.
  const shrink = Math.sqrt(rules.mastery?.landFactor ?? 1);
  const masterField = { frontMm: Math.max(pw, Math.round(field.frontMm / shrink)), deepMm: Math.max(pd, Math.round(field.deepMm / shrink)) };
  return { m, pitchX: bw * pw + streetWidthMm, pitchZ: bd * pd + streetWidthMm, streetWidthMm, pw, pd, quarters, farms, masterFarms, masterField, masterFarm, field, posts, crafts, walled };
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
 * blocks where they can, the craft quarter takes the driest road out and the watch's posts take dry plots; wet
 * plots are still laid out (the generator drops them).
 */
export function layOut(settlement: string, households: number, rules: SettlementRules, rng: Streams, scale = 1, extraBlocks = 0, dry?: (dxMm: number, dzMm: number) => boolean, mastery: TownMastery = NO_MASTERY): Layout {
  const [bw, bd] = rules.layout.block;
  const { m, pitchX, pitchZ, streetWidthMm: s, pw, pd, quarters, farms, masterFarms, masterField, masterFarm, field, posts, crafts, walled } = plan(households, rules, scale, extraBlocks, mastery);
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
  // Outside plots start a setback beyond the wall's outer face (or the street, for a village); the craft quarter
  // a further `worksBufferMm` out, so no home is near the workshops and warehouses.
  const farmStart = s / 2 + (walled ? 2 * wall.setbackMm + wall.thicknessMm : wall.setbackMm);
  const craftStart = farmStart + Math.round(rules.layout.worksBufferMm * scale);
  // The lanes either side of each road out (lane l is road l % 4, on side -1 for the first four): the craft plots
  // first, on both sides of the craft side's road; then the farms, dealt round all eight.
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
  // A point `along` mm out of the town on lane `lane`'s road and `across` mm from its centre line on the lane's side.
  const onLane = (lane: number, along: number, across: number): { x: number; z: number } => {
    const [ei, sideSign] = lanes[lane]!;
    const e = exits[ei]!;
    return e.dx !== 0 ? { x: e.at.x + e.dx * along, z: e.at.z + sideSign * across } : { x: e.at.x + sideSign * across, z: e.at.z + e.dz * along };
  };
  // An outside plot centred `along` mm out on its lane, facing back across to its road.
  const outsidePlot = (lane: number, along: number): { center: { x: number; z: number }; facing: Facing } => {
    const [ei, sideSign] = lanes[lane]!;
    const e = exits[ei]!;
    return { center: onLane(lane, along, s / 2 + pd / 2), facing: e.dx !== 0 ? (sideSign < 0 ? 0 : 180) : sideSign < 0 ? 90 : 270 };
  };
  // A plot is wet when the world's `dry` test (relative to the town's centre) fails anywhere on its footprint.
  const centre = { x: (m * pitchX - s) / 2, z: (m * pitchZ - s) / 2 };
  const wet = (p: { center: { x: number; z: number }; facing: Facing }): boolean => !!dry && !plotIsDry(p, pw, pd, centre, dry);
  // The craft quarter's c-th plot on the road out of side `k`: both sides of the road, nearest the town first.
  const craftLanesOf = (k: number): number[] => lanes.flatMap(([ei], l) => (ei === k ? [l] : []));
  const craftPlot = (k: number, c: number): { lane: number; k: number } => ({ lane: craftLanesOf(k)[c % 2]!, k: Math.floor(c / 2) });
  const craftAlong = (k: number): number => craftStart + k * pw + pw / 2;

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
  // A plot on the end of its block row is also open to the side street.
  const accessOf = (gx: number): 1 | 2 => (gx % bw === 0 || gx % bw === bw - 1 ? 2 : 1);
  const wetPlots = (b: { bx: number; bz: number }): number => {
    let n = 0;
    for (let gz = b.bz * bd; gz < (b.bz + 1) * bd; gz++) for (let gx = b.bx * bw; gx < (b.bx + 1) * bw; gx++) if (wet({ center: plotCenter(gx, gz), facing: innerFacing(gz) })) n++;
    return n;
  };
  const squareBlock = [...blocks].sort((a, b) => dist(a) - dist(b) || order(a, b))[0]!;
  kindOf.set(key(squareBlock), "square");
  // The craft side: the "districts" stream's pick, or the next side round where less of the craft quarter is wet.
  const first = Math.floor(rng.get("districts").raw() * 4);
  const wetCrafts = (k: number): number => Array.from({ length: crafts }, (_, c) => craftPlot(k, c)).filter((p) => wet(outsidePlot(p.lane, craftAlong(p.k)))).length;
  const side = [0, 1, 2, 3].map((i) => (first + i) % 4).reduce((best, k) => (wetCrafts(k) < wetCrafts(best) ? k : best));
  const gateSide = side ^ 1;
  // Blocks from the gate side's edge, and from the primary road running out through it (or either primary road).
  const fromSide = (b: { bx: number; bz: number }, k: number): number => [b.bx, m - 1 - b.bx, b.bz, m - 1 - b.bz][k]!;
  const fromRoad = (b: { bx: number; bz: number }, k: number): number => (k < 2 ? Math.abs(2 * b.bz + 1 - 2 * mid) : Math.abs(2 * b.bx + 1 - 2 * mid));
  const fromRoads = (b: { bx: number; bz: number }): number => Math.min(fromRoad(b, 0), fromRoad(b, 2));
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
  // The civic quarter on the square; the market from the square out along the main roads, where the traffic is;
  // inns and taverns from the gate in along the main road; schools beside the centre, on the far side from the inns.
  grow("civic", quarters.civic, dist);
  grow("shopping", quarters.shopping, (b) => dist(b) + 2 * m * fromRoads(b));
  grow("entertainment", quarters.entertainment, (b) => (m + 1) * fromRoad(b, gateSide) + fromSide(b, gateSide));
  grow("education", quarters.education, (b) => dist(b) - fromSide(b, gateSide));
  for (const b of blocks) if (!kindOf.has(key(b))) kindOf.set(key(b), "housing");
  // Each plot's district: its block's quarter for the `quota` plots nearest the square (for the market, its
  // corner plots first: open to two streets), housing for the rest.
  const sq = { x: squareBlock.bx * pitchX + (bw * pw) / 2, z: squareBlock.bz * pitchZ + (bd * pd) / 2 };
  const plotKind = new Map<string, DistrictKind>();
  for (const b of blocks) {
    const k = kindOf.get(key(b))!;
    if (k === "square") continue;
    const plots: { gx: number; gz: number; d: number; corner: number }[] = [];
    for (let dz = 0; dz < bd; dz++) {
      for (let dx = 0; dx < bw; dx++) {
        const gx = b.bx * bw + dx;
        const gz = b.bz * bd + dz;
        const c = plotCenter(gx, gz);
        plots.push({ gx, gz, d: (c.x - sq.x) ** 2 + (c.z - sq.z) ** 2, corner: k === "shopping" ? 2 - accessOf(gx) : 0 });
      }
    }
    plots.sort((a, c) => a.corner - c.corner || a.d - c.d || a.gz - c.gz || a.gx - c.gx);
    const q = quota.get(key(b)) ?? plots.length;
    plots.forEach((p, i) => plotKind.set(`${p.gx},${p.gz}`, i < q ? (k as DistrictKind) : "housing"));
  }

  // Wealth and the watch. The poor streets are the housing farthest from the square and nearest the craft road;
  // the well-off ones nearest the square. Guard posts stand at each gate (an open village: the ends of its main
  // road), in the market and in the poor streets; the headquarters at the back of the civic quarter, the gaol by it.
  const innerPlots = [...plotKind].map(([k, kind]) => {
    const [gx, gz] = k.split(",").map(Number) as [number, number];
    const center = plotCenter(gx, gz);
    return { k, gx, gz, kind, center, wet: wet({ center, facing: innerFacing(gz) }) };
  });
  const craftGate = exits[side]!.at;
  const d2 = (a: { x: number; z: number }, b: { x: number; z: number }): number => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
  const poverty = (p: { center: { x: number; z: number } }): number => Math.sqrt(d2(p.center, sq)) - Math.sqrt(d2(p.center, craftGate));
  const byGrid = (a: { gx: number; gz: number }, b: { gx: number; gz: number }): number => a.gz - b.gz || a.gx - b.gx;
  const homes = innerPlots.filter((p) => p.kind === "housing").sort((a, b) => poverty(b) - poverty(a) || byGrid(a, b));
  const wealthOf = new Map<string, Wealth>();
  const watch = rules.watch;
  const nLow = watch ? Math.floor((homes.length * watch.lowIncomePermille) / 1000) : 0;
  const nHigh = watch ? Math.floor((homes.length * watch.highIncomePermille) / 1000) : 0;
  homes.forEach((p, i) => wealthOf.set(p.k, i < nLow ? "low" : i >= homes.length - nHigh ? "high" : "middle"));
  const postOf = new Map<string, { archetype: string; why: PostReason }>();
  if (watch) {
    const free = (p: { k: string; wet: boolean }): boolean => !p.wet && !postOf.has(p.k);
    const nearest = (to: { x: number; z: number }, among: typeof innerPlots) => among.filter(free).sort((a, b) => d2(a.center, to) - d2(b.center, to) || byGrid(a, b))[0];
    // `n` posts spread evenly over `among` (in its order).
    const spread = (n: number, among: typeof innerPlots, why: PostReason): void => {
      const c = among.filter(free);
      for (let i = 0; i < Math.min(n, c.length); i++) postOf.set(c[Math.floor(((2 * i + 1) * c.length) / (2 * n))]!.k, { archetype: watch.post, why });
    };
    const entrances = walled ? [0, 1, 2, 3] : [gateSide, side, gateSide ^ 2, gateSide ^ 3].slice(0, posts.gate);
    for (const e of entrances) {
      const p = nearest(exits[e]!.at, innerPlots);
      if (p) postOf.set(p.k, { archetype: watch.post, why: "gate" });
    }
    // Market posts keep off the corner plots where the stalls go, unless there are too few others.
    const market = innerPlots.filter((p) => p.kind === "shopping").sort((a, b) => d2(a.center, sq) - d2(b.center, sq) || byGrid(a, b));
    const inner = market.filter((p) => accessOf(p.gx) === 1 && free(p));
    spread(posts.market, inner.length >= posts.market ? inner : market, "market");
    spread(Math.floor(nLow / watch.poorHomesPerPost), homes.slice(0, nLow), "poor");
    const civic = innerPlots.filter((p) => p.kind === "civic" && free(p)).sort((a, b) => d2(b.center, sq) - d2(a.center, sq) || byGrid(a, b));
    const hq = civic[0];
    if (hq && posts.headquarters > 0) {
      postOf.set(hq.k, { archetype: watch.headquarters, why: "headquarters" });
      for (let i = 0; i < posts.gaol; i++) {
        const g = nearest(hq.center, innerPlots.filter((p) => p.kind === "civic"));
        if (g) postOf.set(g.k, { archetype: watch.gaol, why: "gaol" });
      }
    }
  }

  // The plots along the roads out: the craft quarter first, then the farms, dealt round all eight lanes. A farm
  // stands alone in its holding (frontage along the road, depth away from it); a lane's first holding starts far
  // enough out that its depth clears the fields of the roads either side.
  const used = lanes.map(() => craftStart);
  const outside: { lane: number; k: number; along: number; master?: boolean }[] = [];
  for (let c = 0; c < crafts; c++) {
    const p = craftPlot(side, c);
    used[p.lane] = craftStart + (p.k + 1) * pw;
    outside.push({ lane: p.lane, k: p.k, along: craftAlong(p.k) });
  }
  const clear = field.deepMm - Math.min(xr, m * pitchX - s - xr, zr, m * pitchZ - s - zr) + pw;
  const laneK = lanes.map((_, l) => outside.filter((o) => o.lane === l).length);
  // The far side of each road is staggered by half a holding, so no two farmsteads face each other across it.
  const next = used.map((u, l) => Math.max(clear, u === craftStart ? farmStart : u + pw) + (l >= 4 ? Math.round(field.frontMm / 2) : 0));
  // The master farms first, nearest the town on their roads, each on its smaller holding, on the roads where that
  // first holding is dry (a master's farm is not lost to the water); then the ordinary farms round all eight.
  const fieldWet = (lane: number, along: number, f: { frontMm: number; deepMm: number }): boolean => {
    if (!dry) return false;
    const e = exits[lanes[lane]![0]]!;
    const c = onLane(lane, along, s / 2 + f.deepMm / 2);
    const [w, d] = e.dx !== 0 ? [f.frontMm, f.deepMm] : [f.deepMm, f.frontMm];
    return wet(outsidePlot(lane, along)) || !FOOTPRINT_SAMPLES.every((fx) => FOOTPRINT_SAMPLES.every((fz) => dry(c.x + fx * w - centre.x, c.z + fz * d - centre.z)));
  };
  const dryLanes = lanes.map((_, l) => l).filter((l) => !fieldWet(l, next[l]! + masterField.frontMm / 2, masterField));
  const masterLanes = dryLanes.length ? dryLanes : lanes.map((_, l) => l);
  const dealt: { lane: number; master: boolean }[] = [];
  const outsideFarms: { lane: number; k: number; along: number; master?: boolean }[] = [];
  for (let f = 0; f < masterFarms + farms; f++) {
    const master = f < masterFarms;
    dealt.push({ lane: master ? masterLanes[f % masterLanes.length]! : (f - masterFarms) % 8, master });
  }
  // Each lane in turn, the near side of every road (lanes 0-3) first. A farmstead on the far side keeps at least
  // half a holding along the road from every farmstead facing it, so none stands opposite another.
  const alongs = new Map<number, number[]>();
  const gap = field.frontMm / 2;
  for (const lane of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const opposite = lane >= 4 ? (alongs.get(lane - 4) ?? []) : [];
    const mine: number[] = [];
    dealt.forEach((d, i) => {
      if (d.lane !== lane) return;
      const front = (d.master ? masterField : field).frontMm;
      let along = next[lane]! + front / 2;
      for (let bumped = true; bumped; ) {
        bumped = false;
        for (const o of opposite) if (Math.abs(o - along) < gap) {
          along = o + gap;
          bumped = true;
        }
      }
      next[lane] = along + front / 2;
      mine.push(along);
      outsideFarms[i] = { lane, k: laneK[lane]!++, along, ...(d.master ? { master: true } : {}) };
    });
    alongs.set(lane, mine);
  }
  outside.push(...outsideFarms);
  const roadOut = Math.max(...next, ...used);
  const holdingOf = (lane: number, along: number, master: boolean): Holding => {
    const e = exits[lanes[lane]![0]]!;
    const f = master ? masterField : field;
    const center = onLane(lane, along, s / 2 + f.deepMm / 2);
    const [sizeXMm, sizeZMm] = e.dx !== 0 ? [f.frontMm, f.deepMm] : [f.deepMm, f.frontMm];
    return { center, sizeXMm, sizeZMm, areaM2: (sizeXMm * sizeZMm) / 1_000_000 };
  };

  const districts: District[] = DISTRICT_KINDS.map((kind, i) => {
    const plots = kind === "agriculture" ? masterFarms + farms : kind === "manufacturing" ? crafts : [...plotKind.values()].filter((k) => k === kind).length;
    const areaM2 = kind === "agriculture" ? (farms * field.frontMm * field.deepMm + masterFarms * masterField.frontMm * masterField.deepMm) / 1_000_000 : (plots * pw * pd) / 1_000_000;
    return { id: entityId("district", settlement, i), kind, blocks: Math.ceil(plots / (bw * bd)), areaM2 };
  });

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
      const [from, count] = d.kind === "manufacturing" ? [0, crafts] : [crafts, masterFarms + farms];
      for (const { lane, k, along, master } of outside.slice(from, from + count)) {
        const { center, facing } = outsidePlot(lane, along);
        parcels.push({
          id: entityId("parcel", settlement, di, index++),
          district: d.id,
          kind: d.kind,
          gx: k,
          gz: -1000 * (1 + lane),
          center,
          areaM2: (pw * pd) / 1_000_000,
          roadFrontage: true,
          facing,
          access: 1,
          ...(d.kind === "agriculture" ? { holding: holdingOf(lane, along, !!master) } : {}),
          ...(master ? { post: { archetype: masterFarm, why: "master" as const } } : {}),
        });
      }
      return;
    }
    for (let gz = 0; gz < m * bd; gz++) {
      for (let gx = 0; gx < m * bw; gx++) {
        const k = `${gx},${gz}`;
        if (plotKind.get(k) !== d.kind) continue;
        const wealth = wealthOf.get(k);
        const post = postOf.get(k);
        // The block's front rows face the street before them (-z), its back rows the street behind (+z).
        parcels.push({
          id: entityId("parcel", settlement, di, index++),
          district: d.id,
          kind: d.kind,
          gx,
          gz,
          center: plotCenter(gx, gz),
          areaM2: (pw * pd) / 1_000_000,
          roadFrontage: true,
          facing: innerFacing(gz),
          access: accessOf(gx),
          ...(wealth ? { wealth } : {}),
          ...(post ? { post } : {}),
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
