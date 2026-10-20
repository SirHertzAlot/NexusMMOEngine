/**
 * A region of towns: what each lives off, what they trade with each other, and how working their land changes them
 * over the years; and a town of the region built as it stands.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, evolveRegion, generateSettlement, planRegion, regionTownRequest, townIndustry, industryCap, type Site } from "../src/index.js";

const site = (x: number, z: number, biomes: Record<string, number>, water: { kind: Site["waterKind"]; shoreM: number } = { kind: "none", shoreM: -1 }, walkM = 500): Site => ({
  x, z, biomes, waterKind: water.kind, shoreM: water.shoreM, walkM, pressurePermille: 600, waterDistanceM: water.shoreM, resourcePermille: 0, slopePermille: 0, elevationM: 10, reliefM: 1, biome: "plains",
});

const farm = site(0, 0, { plains: 900, forest: 100 }, { kind: "river", shoreM: 300 });
const wood = site(4000, 1000, { forest: 650, plains: 350 });
const mine = site(-3000, 5000, { mountains: 450, plains: 400, forest: 150 }, undefined, 3000);
const portA = site(8000, -6000, { sea: 400, beach: 100, plains: 300, forest: 200 }, { kind: "sea", shoreM: 20 });
const portB = site(-9000, -7000, { sea: 300, plains: 400, forest: 300 }, { kind: "sea", shoreM: 30 });
const far = site(40000, 40000, { volcanic: 600, plains: 400 });
const region = planRegion([farm, wood, mine, portA, portB, far], BUILTIN_RULES);
const town = (id: string) => region.towns.find((t) => t.id === id)!;
const market = (id: string, good: string) => region.trade.markets.find((m) => m.town === id)!.goods[good]!;

describe("planRegion", () => {
  it("makes each site a town of its access, living off its land, as big as the land keeps", () => {
    assert.deepEqual(region.towns.map((t) => [t.access, t.industry?.primary]), [["river", "farming"], ["road", "timber"], ["remote", "mining"], ["port", "fishing"], ["port", "fishing"], ["road", "mining"]]);
    for (const t of region.towns) assert.equal(t.population, industryCap(BUILTIN_RULES.settings.access[t.access].maxPopulation, t.industry, BUILTIN_RULES));
  });
});

describe("tradeRegion", () => {
  it("sells what a town makes at home first, and what it lacks it buys from the towns with loads to spare", () => {
    for (const m of region.trade.markets) for (const [good, g] of Object.entries(m.goods)) {
      assert.equal(Math.min(g.made, g.needed) + g.bought + g.short, g.needed, `${m.town} ${good}: home, bought and short make up its need`);
      assert.ok(g.sold <= g.made - Math.min(g.made, g.needed), `${m.town} sells only its spare ${good}`);
    }
    // The timber town sends its wood to the farm town next door, and the farm town its grain back.
    assert.ok(region.trade.routes.some((r) => r.from === "town-02" && r.to === "town-01" && r.good === "timber" && r.product === "yew longbows and cabinets"));
    assert.ok(region.trade.routes.some((r) => r.from === "town-01" && r.to === "town-02" && r.good === "grain"));
  });

  it("prices a load by the road it travels, cheaper by sea between two sea ports, and dear where it cannot be had", () => {
    const tr = BUILTIN_RULES.industry!.trade!;
    for (const r of region.trade.routes) {
      const base = BUILTIN_RULES.industry!.industries[(["timber", "mining", "fishing", "farming"] as const).find((id) => BUILTIN_RULES.industry!.industries[id].good === r.good)!].basePrice;
      const perKm = r.by === "sea" ? (tr.pricePermillePerKm * tr.seaPermille) / 1000 : tr.pricePermillePerKm;
      assert.ok(Math.abs(r.price - (base * (1000 + perKm * r.km)) / 1000) <= 1, `${r.good} ${r.from} to ${r.to}`);
      assert.equal(r.by === "sea", town(r.from).access === "port" && town(r.to).access === "port");
    }
    // Nearer is cheaper: the farm town's metal comes from the mine 5.8 km off, not the far one.
    assert.ok(region.trade.routes.some((r) => r.to === "town-01" && r.good === "metal" && r.from === "town-03"));
    // The far mining town is short of what its neighbours had no more of: it pays the shortage price.
    const short = Object.values(region.trade.markets.find((m) => m.town === "town-06")!.goods).find((g) => g.short > 0)!;
    assert.ok(short.price > BUILTIN_RULES.industry!.industries.timber.basePrice, "a good it cannot get is dear");
    assert.equal(market("town-01", "grain").price, BUILTIN_RULES.industry!.industries.farming.basePrice, "its own good costs what it costs to make");
  });
});

describe("evolveRegion", () => {
  const { snapshots, events } = evolveRegion(region, 150, BUILTIN_RULES, 25);
  const at = (year: number, id: string) => snapshots.find((s) => s.year === year)!.towns.find((t) => t.id === id)!;

  it("uses up a mine: its rarest ore first, then the town turns to the next best thing it has", () => {
    const mineEvents = events.filter((e) => e.town === "town-03").map((e) => e.what);
    assert.ok(mineEvents.some((w) => /known for iron blades and tools \(its silver-ore ran out\)/.test(w)), mineEvents.join("; "));
    assert.ok(mineEvents.some((w) => w === "turned from mining to farming"), mineEvents.join("; "));
    assert.ok(mineEvents.findIndex((w) => /silver-ore ran out/.test(w)) < mineEvents.findIndex((w) => /to farming/.test(w)), "the silver runs out before the mine closes");
    assert.ok((at(150, "town-03").land.depletedPermille?.mining ?? 0) >= 380, "ore never comes back");
  });

  it("lets forests and fish regrow, so a timber or fishing town lives off them for good", () => {
    for (const id of ["town-02", "town-04"]) {
      const t = at(150, id);
      assert.equal(t.industry?.primary, town(id).industry?.primary, `${id} still works its land`);
      assert.ok(Object.values(t.land.depletedPermille ?? {}).every((u) => u! < 500), `${id} never works it out`);
    }
  });

  it("grows or shrinks a town toward what its land keeps, and never flips between two industries", () => {
    for (const s of snapshots) for (const t of s.towns) assert.ok(Math.abs(t.population - t.capacity) <= Math.ceil(t.capacity / 10) || t.trend !== "stable", `${t.id} in ${s.year}`);
    assert.ok(at(50, "town-03").population < town("town-03").population, "the mine town shrinks as its ore runs out");
    for (const id of region.towns.map((t) => t.id)) assert.ok(events.filter((e) => e.town === id && /^turned/.test(e.what)).length <= 1, `${id} turns once at most`);
  });

  it("is the same every time", () => {
    assert.deepEqual(evolveRegion(planRegion([farm, wood, mine, portA, portB, far], BUILTIN_RULES), 150, BUILTIN_RULES, 25), { snapshots, events });
  });

  it("builds a town of the region as it stands: the remote mining town, a century on, farming", () => {
    const year = snapshots.find((s) => s.year === 100)!;
    const ask = regionTownRequest(year, "town-03");
    const r = generateSettlement({ settlementId: "r", seed: 1, ...ask });
    assert.ok(r.ok, r.ok ? "" : r.error.message);
    const m = r.manifest;
    assert.equal(m.industry?.primary, at(100, "town-03").industry?.primary);
    assert.equal(m.setting.population, ask.population);
    assert.equal(m.setting.trend, ask.trend);
    assert.ok(m.validation.every((g) => g.ok));
  });
});

describe("townIndustry over the years", () => {
  it("counts what is used up against the stock, and keeps the industry a town has worked until another is clearly richer", () => {
    const land = { biomes: { forest: 400, mountains: 300, plains: 300 }, waterKind: "none" as const, shoreM: -1 };
    const fresh = townIndustry(land, BUILTIN_RULES)!;
    const worn = townIndustry({ ...land, depletedPermille: { [fresh.primary!]: 500 } }, BUILTIN_RULES)!;
    assert.equal(worn.resources[fresh.primary!], Math.round(fresh.resources[fresh.primary!] / 2));
    assert.ok(industryCap(2500, worn, BUILTIN_RULES) <= industryCap(2500, fresh, BUILTIN_RULES));
    // A little thinner than its neighbour, a worked mine stays a mine; much thinner, it does not.
    const mining = { biomes: { mountains: 350, forest: 380, plains: 270 }, waterKind: "none" as const, shoreM: -1 };
    assert.equal(townIndustry(mining, BUILTIN_RULES)!.primary, "timber");
    assert.equal(townIndustry({ ...mining, worked: "mining" }, BUILTIN_RULES)!.primary, "mining");
    assert.equal(townIndustry({ ...mining, worked: "mining", depletedPermille: { mining: 600 } }, BUILTIN_RULES)!.primary, "timber");
  });
});
