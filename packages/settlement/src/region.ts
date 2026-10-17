/**
 * A region of towns (rules.industry.trade, .history): the world's sites as towns, what they trade with each other,
 * and how they change over the years as they work their land.
 *
 *  - `planRegion`: each site becomes a town of its access, living off its land (its industry), as big as the land keeps.
 *  - `tradeRegion`: every town needs a load of each good (timber, metal, fish, grain) per `peoplePerLoad` people. It
 *    sells its own good at home first, and buys what it lacks from the towns with loads to spare, cheapest first. The
 *    price climbs with the distance (cheaper by sea between two sea ports); goods it cannot get at all are dear.
 *  - `evolveRegion`: year by year each town uses up its industry's stock (ore never comes back; forests and fish
 *    regrow), so the land keeps fewer people, its rarest product runs out first, and when the stock is too poor the town
 *    turns to the next best thing it has. The town grows or shrinks toward what its land keeps.
 *  - `regionTownRequest`: what to ask `generateSettlement` for to build one of the region's towns as it stands.
 *
 * Distances are straight lines between the towns' centres, in km. Nothing here draws a random number: the region is
 * the same every time for the same sites and rules.
 */

import { industryCap, peoplePerWorkplace, townIndustry, type Land, type TownIndustry } from "./industry.js";
import { INDUSTRIES, type Access, type IndustryId, type SettlementRules, type Trend } from "./rules.js";
import { siteAccess } from "./setting.js";
import type { Site } from "./sites.js";

export interface RegionTown {
  id: string;
  /** The town's centre in the world, metres. */
  x: number;
  z: number;
  access: Access;
  /** Its land, with what the years have used up (`depletedPermille`). */
  land: Land;
  industry: TownIndustry | null;
  /** The people its land keeps now, and the people it has. */
  capacity: number;
  population: number;
  trend: Trend;
}

export interface Route {
  /** The good (an industry's `good`) and what the selling town makes of it. */
  good: string;
  product: string;
  from: string;
  to: string;
  loads: number;
  km: number;
  by: "road" | "sea";
  /** The price a load fetches where it arrives, copper. */
  price: number;
}

export interface TownMarket {
  town: string;
  /** Loads a year of each good: made, used at home, sold to other towns, bought from them, and still lacking. */
  goods: Record<string, { made: number; needed: number; sold: number; bought: number; short: number; price: number }>;
}

export interface Trade {
  routes: Route[];
  markets: TownMarket[];
}

export interface Region {
  year: number;
  towns: RegionTown[];
  trade: Trade;
}

export interface RegionEvent {
  year: number;
  town: string;
  what: string;
}

const km = (a: RegionTown, b: RegionTown): number => Math.hypot(a.x - b.x, a.z - b.z) / 1000;

/** The people a town's access allows at most. */
const accessCap = (t: Pick<RegionTown, "access">, rules: SettlementRules): number => rules.settings.access[t.access].maxPopulation;

/** The world's sites as a region's towns at year 0, each as big as its land keeps. */
export function planRegion(sites: readonly Site[], rules: SettlementRules): Region {
  const towns = sites.map((site, i): RegionTown => {
    const access = siteAccess(site, rules);
    const land: Land = { biomes: site.biomes, waterKind: site.waterKind, shoreM: site.shoreM };
    const industry = townIndustry(land, rules);
    if (industry?.primary) land.worked = industry.primary;
    const capacity = industryCap(rules.settings.access[access].maxPopulation, industry, rules);
    return { id: `town-${String(i + 1).padStart(2, "0")}`, x: Math.round(site.x), z: Math.round(site.z), access, land, industry, capacity, population: capacity, trend: "stable" };
  });
  return { year: 0, towns, trade: tradeRegion(towns, rules) };
}

/** What the towns trade with each other this year (none without trade rules). */
export function tradeRegion(towns: readonly RegionTown[], rules: SettlementRules): Trade {
  const ir = rules.industry;
  const tr = ir?.trade;
  if (!ir || !tr) return { routes: [], markets: [] };
  const goods = INDUSTRIES.map((id) => ir.industries[id]);
  type Ledger = TownMarket["goods"][string];
  const ledger = new Map<string, Record<string, Ledger>>();
  const spare = new Map<string, number>();
  for (const t of towns) {
    const rows: Record<string, Ledger> = {};
    for (const g of goods) {
      const own = t.industry?.primary && ir.industries[t.industry.primary] === g;
      const made = own ? Math.ceil(t.population / peoplePerWorkplace(t.industry!, rules)) * tr.loadsPerWorkplace : 0;
      const needed = Math.ceil(t.population / tr.peoplePerLoad);
      const home = Math.min(made, needed);
      rows[g.good] = { made, needed, sold: 0, bought: 0, short: needed - home, price: g.basePrice };
      spare.set(`${t.id}|${g.good}`, made - home);
    }
    ledger.set(t.id, rows);
  }
  // Every load anyone could buy, cheapest first: the price where it arrives, by road or (port to sea port) by sea.
  const offers: Route[] = [];
  for (const g of goods) {
    for (const to of towns) {
      if (ledger.get(to.id)![g.good]!.short === 0) continue;
      for (const from of towns) {
        if (from === to || (spare.get(`${from.id}|${g.good}`) ?? 0) === 0) continue;
        const d = km(from, to);
        const sea = from.access === "port" && to.access === "port" && from.land.waterKind === "sea" && to.land.waterKind === "sea";
        const perKm = sea ? (tr.pricePermillePerKm * tr.seaPermille) / 1000 : tr.pricePermillePerKm;
        const price = Math.round((g.basePrice * (1000 + perKm * d)) / 1000);
        offers.push({ good: g.good, product: from.industry!.product?.export ?? g.good, from: from.id, to: to.id, loads: 0, km: Math.round(d * 10) / 10, by: sea ? "sea" : "road", price });
      }
    }
  }
  offers.sort((a, b) => a.price - b.price || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || (a.good < b.good ? -1 : 1));
  const routes: Route[] = [];
  for (const o of offers) {
    const buyer = ledger.get(o.to)![o.good]!;
    const key = `${o.from}|${o.good}`;
    const loads = Math.min(buyer.short, spare.get(key)!);
    if (loads <= 0) continue;
    buyer.short -= loads;
    buyer.bought += loads;
    buyer.price = Math.max(buyer.price, o.price);
    ledger.get(o.from)![o.good]!.sold += loads;
    spare.set(key, spare.get(key)! - loads);
    routes.push({ ...o, loads });
  }
  // What a town cannot get at all is dear: the dearest load of it anywhere, times the shortage.
  for (const g of goods) {
    const dearest = Math.max(g.basePrice, ...routes.filter((r) => r.good === g.good).map((r) => r.price));
    for (const t of towns) {
      const row = ledger.get(t.id)![g.good]!;
      if (row.short > 0) row.price = Math.round((dearest * tr.shortagePermille) / 1000);
    }
  }
  return { routes, markets: towns.map((t) => ({ town: t.id, goods: ledger.get(t.id)! })) };
}

/**
 * The region year by year for `years` years from `start`: snapshots every `every` years (and the last), and what
 * happened (a town's industry or signature product changing, its stock half and then all used up).
 */
export function evolveRegion(start: Region, years: number, rules: SettlementRules, every = 1): { snapshots: Region[]; events: RegionEvent[] } {
  const ir = rules.industry;
  const h = ir?.history;
  const snapshots: Region[] = [start];
  const events: RegionEvent[] = [];
  if (!ir || !h) return { snapshots, events };
  let towns: RegionTown[] = start.towns.map((t) => ({ ...t, land: { ...t.land, depletedPermille: { ...(t.land.depletedPermille ?? {}) } } }));
  for (let year = start.year + 1; year <= start.year + years; year++) {
    towns = towns.map((t) => {
      const was = t.industry;
      const used: Partial<Record<IndustryId, number>> = { ...(t.land.depletedPermille ?? {}) };
      // The industry it works is used up as hard as the town works it; whatever regrows comes back on all of them.
      if (was?.primary) {
        const ind = ir.industries[was.primary];
        const before = used[was.primary] ?? 0;
        used[was.primary] = Math.min(1000, before + (ind.depletePermillePerYear * t.population) / accessCap(t, rules));
        for (const [mark, words] of [[500, "half worked out"], [1000, "worked out"]] as const) {
          if (before < mark && used[was.primary]! >= mark) events.push({ year, town: t.id, what: `its ${ind.good} is ${words}` });
        }
      }
      for (const id of INDUSTRIES) {
        const u = used[id];
        if (u === undefined) continue;
        const back = u - (u * ir.industries[id].regrowPermillePerYear) / 1000;
        used[id] = back < 0.5 ? 0 : back;
      }
      const industry = townIndustry({ ...t.land, depletedPermille: rounded(used) }, rules);
      const land: Land = { ...t.land, depletedPermille: used, ...(industry?.primary ? { worked: industry.primary } : {}) };
      const capacity = industryCap(accessCap(t, rules), industry, rules);
      if (industry?.primary !== was?.primary) events.push({ year, town: t.id, what: industry?.primary ? `turned from ${was?.primary ?? "nothing"} to ${industry.primary}` : `has no industry left (was ${was?.primary})` });
      else if (industry?.product?.export !== was?.product?.export) events.push({ year, town: t.id, what: `is now known for ${industry?.product?.export} (its ${was?.product?.material} ran out)` });
      // Toward what the land keeps: growing or shrinking a share of itself a year.
      const gap = (capacity - t.population) / Math.max(1, t.population);
      const trend: Trend = gap * 1000 > h.stablePermille ? "growing" : -gap * 1000 > h.stablePermille ? "shrinking" : "stable";
      const step = (p: number): number => Math.max(1, Math.ceil((t.population * p) / 1000));
      const population = capacity > t.population ? Math.min(capacity, t.population + step(h.growthPermillePerYear)) : Math.max(capacity, t.population - step(h.shrinkPermillePerYear));
      return { ...t, land, industry, capacity, population, trend };
    });
    if ((year - start.year) % every === 0 || year === start.year + years) {
      const snap = towns.map((t) => ({ ...t, land: { ...t.land, depletedPermille: rounded(t.land.depletedPermille ?? {}) } }));
      snapshots.push({ year, towns: snap, trade: tradeRegion(snap, rules) });
    }
  }
  return { snapshots, events };
}

const rounded = (used: Partial<Record<IndustryId, number>>): Partial<Record<IndustryId, number>> => Object.fromEntries(Object.entries(used).filter(([, v]) => v !== undefined && Math.round(v) > 0).map(([k, v]) => [k, Math.round(v!)]));

/** What to ask `generateSettlement` for (with a settlement id and seed) to build one of the region's towns as it stands. */
export function regionTownRequest(region: Region, townId: string): { population: number; access: Access; land: Land; trend: Trend } {
  const t = region.towns.find((x) => x.id === townId);
  if (!t) throw new Error(`no town ${townId} in the region`);
  return { population: t.population, access: t.access, land: t.land, trend: t.trend };
}
