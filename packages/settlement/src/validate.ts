/**
 * Validation gates (spec §22). Each gate re-derives its answer from the
 * finished tables, independently of the stage that built them, so a stage
 * that breaks its own promise is caught here. A gate is data: its name,
 * whether it holds, and the numbers behind it.
 */

import type { Demand } from "./demand.js";
import type { Demographics } from "./demographics.js";
import type { TownMastery } from "./mastery.js";
import type { TownSetting } from "./setting.js";
import { ACRE_M2, scaledLayout, type Holding, type Layout } from "./layout.js";
import { BUILDING_MARGIN_MM, propBox, type Prop } from "./props.js";
import type { Occupancy } from "./occupancy.js";
import type { SettlementRules } from "./rules.js";
import type { Structure } from "./structures.js";

export interface Gate {
  gate: string;
  ok: boolean;
  detail: string;
}

export interface Town {
  setting: TownSetting;
  demographics: Demographics;
  mastery: TownMastery;
  demand: Demand;
  layout: Layout;
  structures: Structure[];
  occupancy: Occupancy;
  props: Prop[];
}

const gate = (name: string, ok: boolean, detail: string): Gate => ({ gate: name, ok, detail });

/**
 * The wall, re-derived from its pieces: four straight sides with no gap, the north and south ones corner to corner
 * and the west and east ones between the corner towers, a gate on each side with a road through it, every street
 * plot inside the ring and every farm outside. An open village has no pieces at all; a shore town's ring is open
 * where pieces stood in water (`wallOpenToWater`), and only that is reported.
 */
export function fortificationGate(l: Layout): Gate {
  if (!l.walled) return gate("fortification", l.fortifications.length === 0, "an open village: no wall, farms along its roads");
  // A shore town: pieces stood in water and were left out, so the ring is open there; what is left must still
  // be pieces of the wall, never standing on a plot.
  if (l.wallOpenToWater > 0) return gate("fortification", true, `${l.fortifications.length} wall pieces, ${l.wallOpenToWater} left out where water stands: open to the water`);
  const sides = new Map<string, { alongX: boolean; at: number; spans: [number, number][]; gates: number }>();
  for (const p of l.fortifications) {
    const alongX = p.yawDeg === 0;
    const at = alongX ? p.center.z : p.center.x;
    const a = alongX ? p.center.x : p.center.z;
    const key = `${alongX ? "z" : "x"}${at}`;
    const side = sides.get(key) ?? { alongX, at, spans: [], gates: 0 };
    side.spans.push([a - p.lengthMm / 2, a + p.lengthMm / 2]);
    if (p.kind === "town_gate") side.gates++;
    sides.set(key, side);
  }
  const list = [...sides.values()];
  const xs = list.filter((v) => !v.alongX).map((v) => v.at);
  const zs = list.filter((v) => v.alongX).map((v) => v.at);
  if (xs.length !== 2 || zs.length !== 2) return gate("fortification", false, `the wall has ${list.length} sides, not 4`);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
  const problems: string[] = [];
  for (const v of list) {
    const spans = v.spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) if (Math.abs(spans[i]![0] - spans[i - 1]![1]) > 1) problems.push(`a ${spans[i]![0] > spans[i - 1]![1] ? "gap" : "overlap"} in the wall at ${spans[i - 1]![1]} mm`);
    // North and south reach past the corners by half a corner tower; west and east meet those towers.
    const half = (spans[0]![1] - spans[0]![0]) / 2;
    const [lo, hi] = v.alongX ? [x0 - half, x1 + half] : [z0 + half, z1 - half];
    if (v.alongX && (Math.abs(spans[0]![0] - lo) > 1 || Math.abs(spans[spans.length - 1]![1] - hi) > 1)) problems.push("a north or south side stops short of a corner");
    if (v.gates !== 1) problems.push(`a side with ${v.gates} gates`);
  }
  // West and east fill exactly between the north and south corner towers.
  const corner = list.find((u) => u.alongX)!.spans.sort((a, b) => a[0] - b[0])[0]!;
  const ct = corner[1] - corner[0];
  for (const v of list.filter((u) => !u.alongX)) {
    if (Math.abs(v.spans[0]![0] - (z0 + ct / 2)) > 1 || Math.abs(v.spans[v.spans.length - 1]![1] - (z1 - ct / 2)) > 1) problems.push("a west or east side does not meet the corner towers");
  }
  const gates = l.fortifications.filter((p) => p.kind === "town_gate");
  const roadless = gates.filter((g) => !l.roads.nodes.some((n) => Math.abs(n.x - g.center.x) <= 1 && Math.abs(n.z - g.center.z) <= 1));
  if (roadless.length) problems.push(`${roadless.length} gates with no road through them`);
  const inside = (p: { center: { x: number; z: number } }): boolean => p.center.x > x0 && p.center.x < x1 && p.center.z > z0 && p.center.z < z1;
  const wrong = l.parcels.filter((p) => inside(p) === OUTSIDE.has(p.kind));
  if (wrong.length) problems.push(`${wrong.length} plots on the wrong side of the wall (farms and crafts go outside, the rest inside)`);
  return gate("fortification", problems.length === 0, problems.length ? problems.join("; ") : `${l.fortifications.length} wall pieces, ${gates.length} gates, a closed ring`);
}

/** The districts that stand outside the wall, along the roads out. */
const OUTSIDE = new Set(["agriculture", "manufacturing"]);

/**
 * Each district inside the walls is one quarter: its blocks touch, side to side (housing may be several
 * neighbourhoods). A block with no plots (the square, or one water has emptied) still joins the quarters round it,
 * the way a pond in a town does not split it. Outside, the craft quarter lines one road.
 */
export function quartersGate(l: Layout, rules: SettlementRules): Gate {
  const [bw, bd] = rules.layout.block;
  const byKind = new Map<string, Set<string>>();
  const built = new Set<string>();
  for (const p of l.parcels) {
    if (OUTSIDE.has(p.kind)) continue;
    const k = `${Math.floor(p.gx / bw)},${Math.floor(p.gz / bd)}`;
    built.add(k);
    if (p.kind === "housing") continue;
    const set = byKind.get(p.kind) ?? new Set<string>();
    set.add(k);
    byKind.set(p.kind, set);
  }
  const split: string[] = [];
  for (const [kind, blocks] of byKind) {
    const first = blocks.values().next().value!;
    const seen = new Set([first]);
    const todo = [first];
    while (todo.length) {
      const [x, z] = todo.pop()!.split(",").map(Number) as [number, number];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const [nx, nz] = [x + dx, z + dz];
        const k = `${nx},${nz}`;
        const water = !built.has(k) && nx >= 0 && nz >= 0 && nx < l.blocks && nz < l.blocks;
        if ((blocks.has(k) || water) && !seen.has(k)) {
          seen.add(k);
          todo.push(k);
        }
      }
    }
    if ([...blocks].some((k) => !seen.has(k))) split.push(kind);
  }
  const craftRoads = new Set(l.parcels.filter((p) => p.kind === "manufacturing").map((p) => (-p.gz / 1000 - 1) % 4));
  if (craftRoads.size > 1) split.push("manufacturing (on more than one road)");
  return gate("district_quarters", split.length === 0, split.length ? `split into pieces: ${split.join(", ")}` : `${byKind.size} quarters inside, each one connected group of blocks; the craft quarter on one road out`);
}

/**
 * Farmland by acreage: every farm stands in its own holding (its plot inside it), no two holdings overlap, none
 * reaches the town or the craft quarter, and together they are the acres the people need.
 */
export function acreageGate(l: Layout, rules: SettlementRules, people: number, scale = 1): Gate {
  const farms = l.parcels.filter((p) => p.kind === "agriculture");
  const problems: string[] = [];
  const box = (h: Holding) => ({ x0: h.center.x - h.sizeXMm / 2, x1: h.center.x + h.sizeXMm / 2, z0: h.center.z - h.sizeZMm / 2, z1: h.center.z + h.sizeZMm / 2 });
  const inside = (b: ReturnType<typeof box>, p: { x: number; z: number }): boolean => p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1;
  const held = farms.filter((p) => p.holding && inside(box(p.holding), p.center));
  if (held.length < farms.length) problems.push(`${farms.length - held.length} farms without their own land`);
  const boxes = held.map((p) => box(p.holding!));
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (boxes[i]!.x0 < boxes[j]!.x1 && boxes[j]!.x0 < boxes[i]!.x1 && boxes[i]!.z0 < boxes[j]!.z1 && boxes[j]!.z0 < boxes[i]!.z1) overlaps++;
  if (overlaps) problems.push(`${overlaps} pairs of holdings overlap`);
  const others = l.parcels.filter((p) => p.kind !== "agriculture");
  const intruded = others.filter((p) => boxes.some((b) => inside(b, p.center))).length;
  if (intruded) problems.push(`${intruded} town or craft plots inside a farm's fields`);
  const acres = boxes.reduce((a, b) => a + ((b.x1 - b.x0) * (b.z1 - b.z0)) / 1_000_000, 0) / ACRE_M2 / (scale * scale);
  // A master farm (rules.mastery) feeds its people on a `landFactor`th of an ordinary holding.
  const acresPer = rules.farming.acresPerPersonX10 / 10;
  const masters = farms.filter((p) => p.post?.why === "master");
  const masterFed = masters.reduce((a, p) => a + (rules.archetypes[p.post!.archetype]?.feeds ?? 0), 0);
  const ordinary = rules.mastery ? (rules.archetypes[Object.values(rules.mastery.professions).find((p) => p.master === masters[0]?.post?.archetype)?.archetype ?? ""]?.feeds ?? 0) : 0;
  const need = Math.max(0, people - masterFed) * acresPer + (masters.length * ordinary * acresPer) / (rules.mastery?.landFactor ?? 1);
  if (acres + 1e-6 < need) problems.push(`${Math.round(acres)} acres for ${people} people, who need ${Math.round(need)}`);
  return gate("farm_acreage", problems.length === 0, problems.length ? problems.join("; ") : `${farms.length} farms on ${Math.round(acres)} acres (${Math.round(need)} needed), each alone in its fields${masters.length ? `, ${masters.length} of them master farms on a quarter of the land` : ""}`);
}

/** Homes stand at least `worksBufferMm` from every workshop and warehouse plot. */
export function separationGate(l: Layout, rules: SettlementRules, scale = 1): Gate {
  const min = rules.layout.worksBufferMm * scale;
  const homes = l.parcels.filter((p) => p.kind === "housing");
  const works = l.parcels.filter((p) => p.kind === "manufacturing");
  let nearest = Infinity;
  for (const h of homes) for (const w of works) nearest = Math.min(nearest, Math.hypot(h.center.x - w.center.x, h.center.z - w.center.z));
  const ok = nearest >= min;
  return gate("works_separation", ok, works.length === 0 ? "no craft quarter" : `the nearest home is ${Math.round(nearest / 1000)} m from the craft quarter (at least ${Math.round(min / 1000)} m)`);
}

/**
 * The watch, re-derived from where its buildings stand: a guard post by every gate (an open village: by the
 * entrances its rules ask for), in the market and in the poor streets as the rules ask, a headquarters, and each
 * gaol beside one.
 */
export function watchGate(t: Pick<Town, "layout" | "structures" | "demand">, rules: SettlementRules, scale = 1): Gate {
  const w = rules.watch;
  if (!w) return gate("town_watch", true, "no watch in these rules");
  const l = t.layout;
  const parcel = new Map(l.parcels.map((p) => [p.id, p]));
  const of = (id: string) => t.structures.filter((s) => s.archetype === id).map((s) => parcel.get(s.parcel)!);
  const posts = of(w.post);
  const [bw, bd] = rules.layout.block;
  const [pw, pd] = rules.layout.parcelSizeMm.map((v) => v * scale) as [number, number];
  const reach = 2 * (Math.max(bw * pw, bd * pd) + rules.layout.streetWidthMm * scale);
  const near = (a: { x: number; z: number }, among: typeof posts): boolean => among.some((p) => Math.hypot(p.center.x - a.x, p.center.z - a.z) <= reach);
  const problems: string[] = [];
  const gates = l.fortifications.filter((g) => g.kind === "town_gate");
  if (l.walled) {
    const bare = gates.filter((g) => !near(g.center, posts)).length;
    if (bare) problems.push(`${bare} gates with no guard post`);
  } else {
    // The road's way out of an open village: the inner end of each country road.
    const country = new Set(l.roads.edges.filter((e) => e.roadClass === "country_road").map((e) => e.from));
    const ends = l.roads.nodes.filter((n) => country.has(n.id));
    const guarded = ends.filter((n) => near(n, posts)).length;
    if (guarded < Math.min(w.villageEntrancePosts, ends.length)) problems.push(`${guarded} of the village's entrances guarded, ${w.villageEntrancePosts} wanted`);
  }
  const market = l.parcels.filter((p) => p.kind === "shopping");
  const marketPosts = posts.filter((p) => p.kind === "shopping").length;
  if (marketPosts < Math.floor((market.length - marketPosts) / w.marketPlotsPerPost)) problems.push(`${marketPosts} guard posts for ${market.length} market plots`);
  const low = l.parcels.filter((p) => p.wealth === "low");
  const poorPosts = posts.filter((p) => p.wealth === "low").length;
  if (poorPosts < Math.floor(low.length / w.poorHomesPerPost)) problems.push(`${poorPosts} guard posts for ${low.length} poor homes`);
  const hq = of(w.headquarters);
  const gaols = of(w.gaol);
  if (hq.length < (t.demand.required[w.headquarters] ?? 0)) problems.push("no headquarters for the watch");
  if (gaols.length < (t.demand.required[w.gaol] ?? 0)) problems.push("no gaol");
  const far = gaols.filter((g) => !near(g.center, hq)).length;
  if (far) problems.push(`${far} gaols away from the watch's headquarters`);
  return gate("town_watch", problems.length === 0, problems.length ? problems.join("; ") : `${posts.length} guard posts (${l.walled ? `${gates.length} gates` : "the entrances"}, ${marketPosts} in the market, ${poorPosts} in the poor streets), ${hq.length} headquarters, ${gaols.length} gaols`);
}

/**
 * Access and capacity: a building that needs the traffic (`minAccess`) stands on a plot open to that many
 * streets, and the churches seat the share of the people the rules ask for.
 */
export function accessGate(t: Pick<Town, "layout" | "structures" | "demographics">, rules: SettlementRules): Gate {
  const parcel = new Map(t.layout.parcels.map((p) => [p.id, p]));
  const shut = t.structures.filter((s) => (rules.archetypes[s.archetype]!.minAccess ?? 1) > parcel.get(s.parcel)!.access);
  const worship = rules.worship;
  const seats = worship ? t.structures.filter((s) => worship.archetypes.includes(s.archetype)).reduce((a, s) => a + (rules.archetypes[s.archetype]!.capacity ?? 0), 0) : 0;
  const need = worship ? Math.ceil((t.demographics.population * worship.sharePermille) / 1000) : 0;
  const problems = [...(shut.length ? [`${shut.length} buildings that need a corner plot stand off one`] : []), ...(seats < need ? [`church seats for ${seats}, ${need} wanted`] : [])];
  return gate("access_capacity", problems.length === 0, problems.length ? problems.join("; ") : `markets on corner plots; church seats for ${seats} of ${t.demographics.population}`);
}

/** Each master has their master workplace, and someone working in it is the master. */
export function masteryGate(t: Pick<Town, "mastery" | "structures" | "occupancy" | "layout">, rules: SettlementRules): Gate {
  const problems: string[] = [];
  // Masters get the best ground: on every road out, their farms and works come before the ordinary ones (a
  // plot's gx counts out along its lane, its gz names the lane).
  for (const kind of ["agriculture", "manufacturing"] as const) {
    const lanes = new Map<number, { master: number; plain: number }>();
    for (const p of t.layout.parcels) {
      if (p.kind !== kind) continue;
      const l = lanes.get(p.gz) ?? { master: -1, plain: Infinity };
      if (p.post?.why === "master") l.master = Math.max(l.master, p.gx);
      else l.plain = Math.min(l.plain, p.gx);
      lanes.set(p.gz, l);
    }
    if ([...lanes.values()].some((l) => l.master > l.plain)) problems.push(`an ordinary ${kind === "agriculture" ? "farm" : "workplace"} stands nearer the town than a master's on its road`);
  }
  for (const [name, p] of Object.entries(rules.mastery?.professions ?? {})) {
    const want = t.mastery.masters[name] ?? 0;
    const shops = t.structures.filter((s) => s.archetype === p.master);
    if (shops.length !== want) problems.push(`${want} master ${name} but ${shops.length} master workplaces`);
    const masters = t.occupancy.npcs.filter((n) => n.mastery === name).length;
    if (masters !== shops.length) problems.push(`${shops.length} master ${name} workplaces but ${masters} masters at work`);
  }
  for (const [name, n] of Object.entries(t.mastery.grandMasters)) {
    const grand = t.occupancy.npcs.filter((x) => x.grandMaster && x.mastery === name).length;
    if (grand !== n) problems.push(`${n} grand master ${name} but ${grand} at work`);
  }
  const total = Object.values(t.mastery.masters).reduce((a, b) => a + b, 0);
  const grandTotal = Object.values(t.mastery.grandMasters).reduce((a, b) => a + b, 0);
  return gate("mastery", problems.length === 0, problems.length ? problems.join("; ") : total ? `${total} masters (${Object.entries(t.mastery.masters).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ")}), drawing ${t.mastery.residents} residents and ${t.mastery.visitors} visitors${grandTotal ? `; ${grandTotal} grand masters, ${t.mastery.pupils} pupils, the town honours ${t.mastery.discipline}` : ""}` : "no masters in this town");
}

/**
 * The setting held: the town is no bigger than its access keeps (the masters' residents aside), and its homeless
 * are as many as drawn, with no household or home, each at a shelter of the rules' kinds or sleeping rough where
 * the town has none.
 */
export function settingGate(t: Pick<Town, "setting" | "demographics" | "occupancy" | "structures" | "mastery">, rules: SettlementRules): Gate {
  const problems: string[] = [];
  const s = t.setting;
  if (s.capacity !== null && s.population > s.capacity) problems.push(`${s.population} people over the ${s.capacity} a ${s.access} town keeps`);
  if (t.demographics.population !== s.population + t.mastery.residents) problems.push(`${t.demographics.population} people, not the ${s.population} settled and ${t.mastery.residents} drawn by masters`);
  const homeless = t.occupancy.npcs.filter((n) => n.home === null);
  if (homeless.length !== t.demographics.homeless) problems.push(`${homeless.length} homeless, not ${t.demographics.homeless}`);
  const kinds = new Set(rules.homeless?.shelters ?? []);
  const archetypeOf = new Map(t.structures.map((x) => [x.id, x.archetype]));
  const shelters = t.structures.filter((x) => kinds.has(x.archetype)).length;
  for (const n of homeless) {
    if (n.household !== null) problems.push(`${n.id} is homeless but in a household`);
    if (n.shelter ? !kinds.has(archetypeOf.get(n.shelter) ?? "") : shelters > 0) problems.push(`${n.id} has no shelter of the rules' kinds`);
  }
  const sheltered = homeless.filter((n) => n.shelter).length;
  const og = rules.openGround;
  const parks = og ? t.structures.filter((x) => x.archetype === og.park).length : 0;
  const lots = og ? t.structures.filter((x) => x.archetype === og.lot).length : 0;
  const where = s.access ? `a ${s.trend} ${s.access} town at density ${s.densityPermille}${s.population < s.requestedPopulation ? `, capped at ${s.capacity} of ${s.requestedPopulation} asked` : ""}` : "no setting";
  return gate("setting", problems.length === 0, problems.length ? problems.join("; ") : `${where}; ${homeless.length} homeless (${sheltered} sheltered, ${homeless.length - sheltered} sleeping rough); ${parks} parks, ${lots} empty lots`);
}

/**
 * The props, re-derived from where they stand: none that you walk into (all but terraces) stands in a building or
 * in another such prop, every terrace is under a building of a terraced kind with its stairs before it, and every
 * statue to a grand master honours one of the town's.
 */
export function propsGate(t: Pick<Town, "layout" | "structures" | "occupancy" | "props">, rules: SettlementRules, scale = 1): Gate {
  const r = rules.props;
  if (!r) return gate("props", t.props.length === 0, "no props in these rules");
  const [pw, pd] = scaledLayout(rules, scale).parcelMm;
  const open = new Set([rules.openGround?.park, rules.openGround?.lot]);
  const parcels = new Map(t.layout.parcels.map((p) => [p.id, p]));
  type Box = { x0: number; x1: number; z0: number; z1: number };
  const m = BUILDING_MARGIN_MM;
  const buildings: Box[] = t.structures.filter((s) => !open.has(s.archetype)).map((s) => {
    const p = parcels.get(s.parcel)!;
    const [w, d] = p.facing % 180 === 0 ? [pw, pd] : [pd, pw];
    return { x0: p.center.x - w / 2 + m, x1: p.center.x + w / 2 - m, z0: p.center.z - d / 2 + m, z1: p.center.z + d / 2 - m };
  });
  const solid = t.props.filter((p) => p.kind !== "terrace").map((p) => ({ p, b: propBox(p) }));
  // A grid of 10 m cells, so each prop is tested only against what is near it.
  const CELL = 10_000;
  const grid = new Map<string, Box[]>();
  const cells = (b: Box): string[] => {
    const out: string[] = [];
    for (let i = Math.floor(b.x0 / CELL); i <= Math.floor(b.x1 / CELL); i++) for (let j = Math.floor(b.z0 / CELL); j <= Math.floor(b.z1 / CELL); j++) out.push(`${i},${j}`);
    return out;
  };
  const hit = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
  for (const b of buildings) for (const k of cells(b)) grid.set(k, [...(grid.get(k) ?? []), b]);
  const inBuilding = solid.filter(({ b }) => cells(b).some((k) => (grid.get(k) ?? []).some((o) => hit(b, o))));
  const seen = new Map<string, Box[]>();
  let overlapping = 0;
  for (const { b } of solid) {
    if (cells(b).some((k) => (seen.get(k) ?? []).some((o) => hit(b, o)))) overlapping++;
    for (const k of cells(b)) seen.set(k, [...(seen.get(k) ?? []), b]);
  }
  const built = new Map(t.structures.map((s) => [s.parcel, s.archetype]));
  const stairs = new Set(t.props.filter((p) => p.kind === "stairs").map((p) => p.parcel));
  const terraces = t.props.filter((p) => p.kind === "terrace");
  const steps = Math.ceil(r.terraces.heightMm / r.terraces.stepRiseMm) - 1;
  const badTerraces = terraces.filter((p) => !r.terraces.archetypes.includes(built.get(p.parcel!) ?? "") || (steps > 0 && !stairs.has(p.parcel)));
  const grand = new Set(t.occupancy.npcs.filter((n) => n.grandMaster).map((n) => n.id));
  const badStatues = t.props.filter((p) => p.honours !== undefined && !grand.has(p.honours));
  const counts = new Map<string, number>();
  for (const p of t.props) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const ok = inBuilding.length === 0 && overlapping === 0 && badTerraces.length === 0 && badStatues.length === 0;
  const problems = [inBuilding.length && `${inBuilding.length} in a building`, overlapping && `${overlapping} in another prop`, badTerraces.length && `${badTerraces.length} terraces without their building or stairs`, badStatues.length && `${badStatues.length} statues to no grand master`].filter(Boolean);
  return gate("props", ok, ok ? [...counts].map(([k, n]) => `${n} ${k}`).join(", ") || "no props" : problems.join(", "));
}

export function validateTown(t: Town, rules: SettlementRules, scale = 1): Gate[] {
  const sum = (f: (id: string) => number): number => t.structures.reduce((a, s) => a + f(s.archetype), 0);
  const d = t.demographics;
  const housing = sum((id) => rules.archetypes[id]!.households);
  const food = sum((id) => rules.archetypes[id]!.feeds);
  const workers = sum((id) => rules.archetypes[id]!.workers);
  const kindOf = new Map(t.layout.parcels.map((p) => [p.id, p.kind]));
  const misplaced = t.structures.filter((s) => !rules.archetypes[s.archetype]!.kinds.includes(kindOf.get(s.parcel)!));
  const built = new Set(t.structures.map((s) => s.parcel));
  const kindById = new Map(t.structures.map((s) => [s.id, s.archetype]));
  const count = (id: string): number => t.structures.filter((s) => s.archetype === id).length;
  const short = Object.entries(t.demand.required).filter(([id, n]) => count(id) < n);
  const total = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

  // Connected: grow from the first junction along the street segments.
  const reached = new Set([t.layout.roads.nodes[0]!.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of t.layout.roads.edges) {
      if (reached.has(e.from) !== reached.has(e.to)) {
        reached.add(e.from).add(e.to);
        grew = true;
      }
    }
  }

  const o = t.occupancy;
  const perHome = new Map<string, number>();
  for (const h of o.households) perHome.set(h.home, (perHome.get(h.home) ?? 0) + 1);
  const housed = o.households.reduce((a, h) => a + h.size, 0);
  const overHome = [...perHome].filter(([id, n]) => n > rules.archetypes[kindById.get(id)!]!.households);
  const perJob = new Map<string, number>();
  for (const n of o.npcs) if (n.workplace) perJob.set(n.workplace, (perJob.get(n.workplace) ?? 0) + 1);
  const overJob = [...perJob].filter(([id, n]) => n > rules.archetypes[kindById.get(id)!]!.workers);

  return [
    gate("demographic_validity", total(d.ageCohorts) === d.population && total(d.socialClasses) === d.population, `${d.population} people in ${d.households} households`),
    gate("housing_capacity", housing >= d.households, `${housing} homes for ${d.households} households`),
    gate("food_security", food >= t.demand.foodDemand, `feeds ${food} of ${t.demand.foodDemand}`),
    gate("labor_balance", workers <= d.laborPool, `${workers} jobs for ${d.laborPool} workers`),
    gate("road_connectivity", reached.size === t.layout.roads.nodes.length && t.layout.parcels.every((p) => p.roadFrontage), `${reached.size} of ${t.layout.roads.nodes.length} junctions reachable`),
    gate("structure_coverage", t.layout.parcels.every((p) => built.has(p.id)) && short.length === 0, short.length ? `short of ${short.map(([id]) => id).join(", ")}` : `${t.structures.length} structures on ${t.layout.parcels.length} parcels`),
    gate("occupancy_population", o.npcs.length === d.population && housed + d.homeless === d.population, `${housed} people in ${o.households.length} households and ${d.homeless} homeless`),
    gate("occupancy_homes", overHome.length === 0 && o.households.length === d.households, overHome.length ? `${overHome.length} homes over capacity` : `${o.households.length} households, each in a home with room`),
    gate("occupancy_jobs", overJob.length === 0, overJob.length ? `${overJob.length} workplaces over their jobs` : `${perJob.size} workplaces staffed within their jobs`),
    fortificationGate(t.layout),
    quartersGate(t.layout, rules),
    acreageGate(t.layout, rules, d.population, scale),
    separationGate(t.layout, rules, scale),
    watchGate(t, rules, scale),
    accessGate(t, rules),
    masteryGate(t, rules),
    settingGate(t, rules),
    propsGate(t, rules, scale),
    gate("zoning", misplaced.length === 0, misplaced.length ? `${misplaced.length} structures outside their district` : "every structure stands in a district that allows it"),
  ];
}
