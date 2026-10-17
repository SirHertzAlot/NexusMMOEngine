/**
 * The whole pipeline: a request becomes a manifest whose content hash
 * identifies the town, every validation gate passes or the generation fails
 * with the stage that broke, and the event log says what was decided.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACRE_M2, BUILTIN_RULES, contentHash, drawMastery, generateSettlement, GENERATOR_VERSION, streams } from "../src/index.js";

const request = { settlementId: "0182", seed: 1234, population: 600 };

function must(r: ReturnType<typeof generateSettlement>) {
  assert.ok(r.ok, r.ok ? "" : `${r.error.stage}: ${r.error.message}`);
  return r;
}

describe("generateSettlement", () => {
  const { manifest, events } = must(generateSettlement({ ...request, verbosity: "verbose" }));

  it("emits a versioned manifest whose hash covers everything else", () => {
    assert.equal(manifest.format, "mmo-settlement/1");
    assert.equal(manifest.generatorVersion, GENERATOR_VERSION);
    assert.equal(manifest.rulesVersion, BUILTIN_RULES.version);
    const { hash, ...rest } = manifest;
    assert.equal(hash, contentHash(rest));
  });

  it("is reproducible: the same request gives the same hash, another seed another town", () => {
    assert.equal(must(generateSettlement(request)).manifest.hash, manifest.hash);
    assert.notEqual(must(generateSettlement({ ...request, seed: 99 })).manifest.hash, manifest.hash);
  });

  it("pins the golden hash, so any change to the generator's output is a visible decision", () => {
    assert.equal(manifest.hash, GOLDEN);
  });

  it("passes every validation gate", () => {
    assert.ok(manifest.validation.length >= 6);
    for (const g of ["fortification", "district_quarters"]) assert.ok(manifest.validation.some((v) => v.gate === g), g);
  });

  it("gives a village one school and one tavern, and a city its halls, guards, schools and entertainment", () => {
    const count = (m: typeof manifest, id: string) => m.structures.filter((s) => s.archetype === id).length;
    const village = generateSettlement({ settlementId: "0183", seed: 3, population: 100 });
    assert.ok(village.ok, village.ok ? "" : village.error.message);
    assert.equal(count(village.manifest, "school"), 1);
    assert.equal(count(village.manifest, "tavern"), 1);
    assert.ok(count(village.manifest, "guardhouse") >= 1, "a village has its watch");
    for (const none of ["barracks", "theatre", "library", "town_hall"]) assert.equal(count(village.manifest, none), 0, none);
    const city = generateSettlement({ settlementId: "0184", seed: 3, population: 2500 });
    assert.ok(city.ok, city.ok ? "" : city.error.message);
    for (const id of ["town_hall", "guardhouse", "barracks", "school", "library", "tavern", "inn", "theatre", "bathhouse"]) assert.ok(count(city.manifest, id) >= 1, id);
    // Church life: a village has its chapel and churchyard; a city its parish churches, almshouse-hospital,
    // cathedral, and a monastery out on its own lands.
    assert.ok(count(village.manifest, "chapel") >= 1 && count(village.manifest, "churchyard") >= 1, "a village chapel and churchyard");
    assert.equal(count(village.manifest, "cathedral"), 0);
    for (const id of ["parish_church", "churchyard", "rectory", "hospital", "cathedral", "monastery", "apothecary"]) assert.ok(count(city.manifest, id) >= 1, id);
    const kindOf = new Map(city.manifest.parcels.map((p) => [p.id, p.kind]));
    assert.equal(kindOf.get(city.manifest.structures.find((s) => s.archetype === "monastery")!.parcel), "agriculture", "the monastery stands out on the farmland");
    const guards = city.manifest.occupancy.npcs.filter((n) => n.role === "town guard" || n.role === "soldier").length;
    assert.ok(guards >= 20, `${guards} guards and soldiers for 2500 people`);
    for (const g of manifest.validation) assert.ok(g.ok, `${g.gate}: ${g.detail}`);
  });

  it("gives every farm its own acreage, apart from its neighbours, and keeps the homes away from the crafts", () => {
    const farms = manifest.parcels.filter((p) => p.kind === "agriculture");
    // An ordinary holding is tens of acres; a master farm a quarter of that.
    for (const f of farms) assert.ok(f.holding!.areaM2 / ACRE_M2 >= (f.post?.why === "master" ? 10 : 40), "a holding is tens of acres");
    const apart = Math.min(...farms.flatMap((a, i) => farms.slice(i + 1).map((b) => Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z))));
    assert.ok(apart >= 100_000, `the nearest two farmsteads are ${apart / 1000} m apart`);
    for (const g of ["farm_acreage", "works_separation"]) assert.ok(manifest.validation.find((v) => v.gate === g)!.ok, g);
    const kindOf = new Map(manifest.parcels.map((p) => [p.id, p.kind]));
    for (const s of manifest.structures.filter((x) => x.archetype === "warehouse")) assert.equal(kindOf.get(s.parcel), "manufacturing", "warehouses stand out with the crafts");
  });

  it("posts the watch at every gate, in the market and the poor streets, with a headquarters and a gaol beside it", () => {
    const parcel = new Map(manifest.parcels.map((p) => [p.id, p]));
    const posts = manifest.structures.filter((s) => s.archetype === "guardhouse").map((s) => parcel.get(s.parcel)!);
    const why = (w: string) => posts.filter((p) => p.post?.why === w).length;
    assert.equal(why("gate"), 4, "one inside each gate");
    assert.ok(why("market") >= 1 && why("poor") >= 1, "the market and the poor streets have theirs");
    assert.equal(manifest.structures.filter((s) => s.archetype === "watch_hq").length, 1);
    assert.ok(manifest.structures.some((s) => s.archetype === "gaol"));
    assert.ok(manifest.validation.find((v) => v.gate === "town_watch")!.ok);
  });

  it("opens the markets to two streets and keeps churches and schools to a door or two, seating the parish", () => {
    const parcel = new Map(manifest.parcels.map((p) => [p.id, p]));
    for (const s of manifest.structures.filter((x) => x.archetype === "market")) assert.equal(parcel.get(s.parcel)!.access, 2, "a market on a corner");
    const doors = (id: string) => BUILTIN_RULES.archetypes[id]!.entrances!;
    assert.ok(doors("market") > doors("parish_church") && doors("parish_church") <= 2 && doors("school") === 1);
    assert.ok(manifest.validation.find((v) => v.gate === "access_capacity")!.ok);
  });

  it("shares homes between families: many homes hold two or three households", () => {
    const per = new Map<string, number>();
    for (const h of manifest.occupancy.households) per.set(h.home, (per.get(h.home) ?? 0) + 1);
    assert.ok([...per.values()].some((n) => n >= 2), "some homes are shared");
    const homes = manifest.structures.filter((s) => (BUILTIN_RULES.archetypes[s.archetype]!.households ?? 0) > 0).length;
    assert.ok(homes < manifest.demographics.households, `${homes} homes for ${manifest.demographics.households} households`);
  });

  it("draws masters about one in a hundred: smaller, richer farms, fewer workshops, busier towns, masters to learn from", () => {
    const draws = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => must(generateSettlement({ settlementId: "m", seed, population: 1000 })).manifest);
    const totals = draws.map((m) => Object.values(m.mastery.masters).reduce((a, b) => a + b, 0));
    assert.ok(new Set(totals).size > 1, "mastery differs from town to town");
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    assert.ok(mean > 4 && mean < 18, `about 10 masters in 1000 people, got ${mean}`);
    const m = draws[totals.indexOf(Math.max(...totals))]!;
    const count = (id: string) => m.structures.filter((s) => s.archetype === id).length;
    const y = BUILTIN_RULES.mastery!.yield;
    for (const [name, p] of Object.entries(BUILTIN_RULES.mastery!.professions)) assert.equal(count(p.master), m.mastery.masters[name], `one master ${name} workplace per master`);
    assert.equal(m.demographics.population, 1000 + m.mastery.residents, "masters draw people to live there");
    assert.ok(m.mastery.visitors > 0 && count("tavern") + count("inn") >= Math.ceil((1000 + m.mastery.residents + m.mastery.visitors) / 300), "taverns and inns serve the visitors");
    if (m.mastery.masters.smithing! > 0) assert.ok(m.demand.required.smithy! <= Math.max(0, Math.ceil(m.demographics.population / 400) - y * m.mastery.masters.smithing!), "a master smith does the work of four smithies");
    const masterFarms = m.parcels.filter((p) => p.post?.why === "master");
    const ordinary = m.parcels.find((p) => p.kind === "agriculture" && !p.post)!;
    if (masterFarms.length) assert.ok(Math.abs(masterFarms[0]!.holding!.areaM2 * BUILTIN_RULES.mastery!.landFactor - ordinary.holding!.areaM2) / ordinary.holding!.areaM2 < 0.01, "a master farm on a quarter of the land");
    assert.equal(BUILTIN_RULES.archetypes.master_farmstead!.feeds, y * BUILTIN_RULES.archetypes.farmstead!.feeds, "and four times the food");
    const masters = m.occupancy.npcs.filter((n) => n.mastery);
    assert.equal(masters.length, Object.values(m.mastery.masters).reduce((a, b) => a + b, 0), "every master is someone, at work");
    assert.ok(m.occupancy.npcs.some((n) => n.role.startsWith("apprentice ")), "with apprentices beside them");
    assert.ok(m.validation.find((g) => g.gate === "mastery")!.ok);
  });

  it("gives masters the best ground: their farms and works nearest the town, ordinary farms farther out", () => {
    const m = must(generateSettlement({ settlementId: "p", seed: 1, population: 1000 })).manifest;
    const lanes = new Map<number, { master: number[]; plain: number[] }>();
    for (const p of m.parcels.filter((x) => x.kind === "agriculture" || x.kind === "manufacturing")) {
      const l = lanes.get(p.gz * 10 + (p.kind === "agriculture" ? 1 : 0)) ?? { master: [], plain: [] };
      (p.post?.why === "master" ? l.master : l.plain).push(p.gx);
      lanes.set(p.gz * 10 + (p.kind === "agriculture" ? 1 : 0), l);
    }
    assert.ok(m.parcels.some((p) => p.kind === "agriculture" && p.post?.why === "master"), "this town has master farms");
    assert.ok(m.parcels.some((p) => p.kind === "manufacturing" && p.post?.why === "master"), "and master works");
    for (const l of lanes.values()) if (l.master.length && l.plain.length) assert.ok(Math.max(...l.master) < Math.min(...l.plain), "on every road the masters come first");
    // Across the roads too: no ordinary farmstead is nearer the town than the farthest master farm's holding reaches.
    const c = { x: 0, z: 0 };
    for (const n of m.roads.nodes) (c.x += n.x / m.roads.nodes.length), (c.z += n.z / m.roads.nodes.length);
    const far = (p: (typeof m.parcels)[number]) => Math.hypot(p.center.x - c.x, p.center.z - c.z);
    const masterFar = Math.max(...m.parcels.filter((p) => p.kind === "agriculture" && p.post?.why === "master").map(far));
    const farmsteads = new Set(m.structures.filter((s) => s.archetype === "farmstead").map((s) => s.parcel));
    assert.ok(Math.min(...m.parcels.filter((p) => farmsteads.has(p.id)).map(far)) > masterFar, "the ordinary farms lie beyond the masters'");
    assert.ok(m.validation.find((g) => g.gate === "mastery")!.ok);
  });

  it("makes a few masters grand masters, whose paying pupils grow the town around their discipline", () => {
    const rules = structuredClone(BUILTIN_RULES);
    rules.mastery!.grandMaster = { oneInMasters: 1, pupils: 30, pupilsPerWorkplace: 5 };
    const m = must(generateSettlement({ settlementId: "g", seed: 2, population: 600, rules })).manifest;
    const grand = Object.values(m.mastery.grandMasters).reduce((a, b) => a + b, 0);
    assert.ok(grand > 0 && grand === Object.values(m.mastery.masters).reduce((a, b) => a + b, 0), "every master grand at one in one");
    assert.equal(m.mastery.pupils, grand * 30);
    assert.equal(m.demographics.population, 600 + m.mastery.residents, "the pupils live in the town");
    assert.ok(m.mastery.discipline !== null && m.mastery.grandMasters[m.mastery.discipline]! === Math.max(...Object.values(m.mastery.grandMasters)), "the town honours its grand masters' discipline");
    const p = rules.mastery!.professions[m.mastery.discipline!]!;
    const plain = generateSettlement({ settlementId: "g", seed: 2, population: 600 + m.mastery.residents, rules: { ...rules, mastery: { ...rules.mastery!, grandMaster: undefined } } });
    if (plain.ok) assert.ok(m.demand.required[p.archetype]! >= Math.ceil((m.mastery.grandMasters[m.mastery.discipline!]! * 30) / 5), `the pupils' ${p.archetype}s`);
    assert.equal(m.occupancy.npcs.filter((n) => n.grandMaster).length, grand, "every grand master is someone, at work");
    assert.ok(m.occupancy.npcs.some((n) => n.role.startsWith("grand master")));
    // The built-in chance: about one master in twenty.
    const big = drawMastery(200_000, BUILTIN_RULES, streams(5));
    const ratio = Object.values(big.grandMasters).reduce((a, b) => a + b, 0) / Object.values(big.masters).reduce((a, b) => a + b, 0);
    assert.ok(ratio > 0.03 && ratio < 0.07, `about 1 in 20 masters grand, got ${ratio}`);
  });

  it("leaves a few people homeless, sheltering at the hospital and the churches", () => {
    const m = must(generateSettlement({ settlementId: "h", seed: 1, population: 1000 })).manifest;
    const d = m.demographics;
    assert.ok(d.homeless >= Math.floor(d.population / 100) && d.homeless <= Math.ceil((d.population * 3) / 100), `1 to 3 in 100 homeless, got ${d.homeless} of ${d.population}`);
    const homeless = m.occupancy.npcs.filter((n) => n.home === null);
    assert.equal(homeless.length, d.homeless);
    assert.equal(m.occupancy.households.reduce((a, h) => a + h.size, 0) + d.homeless, d.population, "everyone else lives in a household");
    const shelters = new Set(m.structures.filter((s) => BUILTIN_RULES.homeless!.shelters.includes(s.archetype)).map((s) => s.id));
    for (const n of homeless) {
      assert.equal(n.household, null);
      assert.ok(n.shelter && shelters.has(n.shelter), "sleeping at a shelter");
      assert.ok(n.workplace || n.role === "beggar" || n.role === "orphan", n.role);
    }
    assert.ok(homeless.every((n) => n.class === "peasant"), "the poorest");
    assert.equal(must(generateSettlement({ settlementId: "h", seed: 1, population: 60 })).manifest.demographics.homeless, 0, "a hamlet takes in its own");
    assert.ok(m.validation.find((g) => g.gate === "setting")!.ok);
  });

  it("sizes a town by its access: ports grow big and dense, remote towns stay small, sparse and short of masters", () => {
    const port = must(generateSettlement({ settlementId: "a", seed: 3, population: 2000, access: "port" })).manifest;
    const remote = must(generateSettlement({ settlementId: "a", seed: 3, population: 2000, access: "remote" })).manifest;
    assert.equal(port.setting.population, 2000, "a port keeps them all");
    assert.equal(remote.setting.population, BUILTIN_RULES.settings.access.remote.maxPopulation, "a remote town only so many");
    assert.ok(port.setting.densityPermille > 1000 && remote.setting.densityPermille < 1000);
    // People per plot inside the walls: the port crowds, the remote town spreads out.
    const perPlot = (m: typeof port) => m.demographics.population / m.parcels.filter((p) => p.kind !== "agriculture" && p.kind !== "manufacturing").length;
    assert.ok(perPlot(port) > 1.4 * perPlot(remote), `${perPlot(port)} vs ${perPlot(remote)} people a plot`);
    for (const m of [port, remote]) assert.ok(m.validation.every((g) => g.ok), m.validation.filter((g) => !g.ok).map((g) => g.detail).join("; "));
    // Masters go where their goods sell.
    const masters = (permille: number) => Object.values(drawMastery(100_000, BUILTIN_RULES, streams(9), permille).masters).reduce((a, b) => a + b, 0);
    assert.ok(masters(BUILTIN_RULES.settings.access.remote.masteryPermille) * 3 < masters(BUILTIN_RULES.settings.access.road.masteryPermille), "a remote town has far fewer masters");
    assert.ok(masters(BUILTIN_RULES.settings.access.port.masteryPermille) > masters(1000), "a port more");
    const r = generateSettlement({ ...request, access: "moon" as never });
    assert.ok(!r.ok && r.error.code === "bad_access");
  });

  it("carries who lives and works where, and the gates that check it", () => {
    assert.equal(manifest.occupancy.npcs.length, manifest.demographics.population);
    assert.equal(manifest.occupancy.households.length, manifest.demographics.households);
    const gates = manifest.validation.map((g) => g.gate);
    for (const g of ["occupancy_homes", "occupancy_jobs", "occupancy_population"]) assert.ok(gates.includes(g), g);
  });

  it("holds its tables in id order, with no wall-clock or random state in them", () => {
    for (const table of [manifest.districts, manifest.parcels, manifest.structures, manifest.occupancy.households, manifest.occupancy.npcs, manifest.occupancy.shops] as { id: string }[][]) {
      assert.deepEqual(table.map((r) => r.id), [...table.map((r) => r.id)].sort());
    }
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(manifest)), "no ISO timestamps");
  });

  it("logs a summary event per stage, and a collapse per parcel at verbose", () => {
    assert.deepEqual(events.filter((e) => e.level === "summary").map((e) => e.stage), ["demographics", "demand", "layout", "structures", "occupancy", "validation"]);
    assert.equal(events.filter((e) => e.event === "structure_collapsed").length, manifest.parcels.length);
  });

  it("keeps only what the verbosity asks for (silent: nothing)", () => {
    assert.deepEqual(must(generateSettlement({ ...request, verbosity: "silent" })).events, []);
    assert.equal(must(generateSettlement({ ...request, verbosity: "summary" })).events.length, 6);
  });

  it("fails with the stage and reason when the demand cannot be met", () => {
    const rules = structuredClone(BUILTIN_RULES);
    rules.required.market = { min: 9999 };
    const r = generateSettlement({ ...request, rules });
    assert.ok(!r.ok);
    assert.equal(r.error.stage, "structures");
  });

  it("refuses a request that makes no sense", () => {
    const r = generateSettlement({ ...request, population: 0 });
    assert.ok(!r.ok);
    assert.equal(r.error.stage, "request");
  });
});

// Re-pinned on purpose: settlement-rules/4 and settlement-gen/0.2.0 (walled towns with gates and towers, a town square,
// civic, market, entertainment and education quarters, the crafts and farms outside along the roads, plots facing their
// streets, ceilings on taverns, bakeries and the like, church life: parish church, churchyard, rectory, almshouse-hospital,
// cathedral and monastery). Again for settlement-rules/6 and settlement-gen/0.4.0: acreage, the watch, shared homes,
// mastery and grand masters, the homeless, masters on the best ground.
const GOLDEN = "34495bf000cc02ccc6d53fc24d3bda314ea93db90681c3e315db1c37eeb158e9";
