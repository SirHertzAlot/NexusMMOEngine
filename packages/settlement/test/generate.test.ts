/**
 * The whole pipeline: a request becomes a manifest whose content hash
 * identifies the town, every validation gate passes or the generation fails
 * with the stage that broke, and the event log says what was decided.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACRE_M2, BUILTIN_RULES, contentHash, drawMastery, generateSettlement, GENERATOR_VERSION, settlementScene, streams } from "../src/index.js";
import { worldNodes } from "@mmo-engine/scene";

const request = { settlementId: "0182", seed: 1234, population: 600 };

const onSquareOf = (m: { square: { center: { x: number; z: number }; widthMm: number; depthMm: number } | null }) => (p: { center: { x: number; z: number } }) =>
  !!m.square && Math.abs(p.center.x - m.square.center.x) < m.square.widthMm / 2 && Math.abs(p.center.z - m.square.center.z) < m.square.depthMm / 2;

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

  it("leaves parks and empty lots: a growing town's lots cleared at its edge, a shrinking town's scattered", () => {
    const og = BUILTIN_RULES.openGround!;
    const towns = [1, 2, 3, 4, 5, 6].map((seed) => must(generateSettlement({ settlementId: "o", seed, population: 1000, access: "road" })).manifest);
    const of = (m: (typeof towns)[number], id: string) => m.structures.filter((s) => s.archetype === id);
    for (const m of towns) {
      assert.equal(of(m, og.park).length, Math.floor((m.demographics.households * BUILTIN_RULES.demographics.householdSizeX10) / 10 / og.parkPerPeople), "a park per 600 people");
      for (const s of [...of(m, og.park), ...of(m, og.lot)]) assert.ok(m.parcels.find((p) => p.id === s.parcel)!.post, "only where the layout reserved it");
    }
    const lots = (trend: string) => towns.filter((m) => m.setting.trend === trend).map((m) => of(m, og.lot).length);
    const [growing, shrinking, stable] = [lots("growing"), lots("shrinking"), lots("stable")];
    assert.ok(growing.length + shrinking.length > 0, "some towns are on the move");
    for (const n of [...growing, ...shrinking]) assert.ok(stable.every((st) => n > st), "a town on the move has more empty lots than a stable one");
    // Housing plots by distance from the square: a growing town's lots on its outskirts, a shrinking town's inside.
    const placed = (trend: string) => {
      const m = towns.find((t) => t.setting.trend === trend);
      if (!m) return null;
      const c = m.square!.center;
      const far = (p: (typeof m.parcels)[number]) => Math.hypot(p.center.x - c.x, p.center.z - c.z);
      const housing = m.parcels.filter((p) => p.kind === "housing").map(far).sort((a, b) => a - b);
      const lotParcels = new Set(of(m, og.lot).map((s) => s.parcel));
      return { lots: m.parcels.filter((p) => lotParcels.has(p.id)).map(far), median: housing[Math.floor(housing.length / 2)]! };
    };
    const g = placed("growing");
    if (g) assert.ok(Math.min(...g.lots) > g.median, "a growing town's cleared lots are on its outskirts");
    const sh = placed("shrinking");
    if (sh) assert.ok(Math.max(...sh.lots) <= sh.median, "a shrinking town's empty lots are inside it");
    assert.ok(g || sh);
  });

  it("dresses the town: lamps along both sides of its paved streets, benches, a fountain and statues in the square, a statue to each grand master", () => {
    const pr = BUILTIN_RULES.props!;
    const of = (m: typeof manifest, k: string) => m.props.filter((p) => p.kind === k);
    assert.ok(manifest.walled && manifest.roads.edges.every((e) => (e.surface === "paved") === (e.roadClass !== "country_road" || !e.to.startsWith("roadend"))), "a walled town is paved out to its gates, the roads beyond are earth");
    const lamps = of(manifest, "street_lamp");
    const inner = manifest.parcels.filter((p) => p.kind !== "agriculture" && p.kind !== "manufacturing");
    assert.equal(lamps.length, inner.filter((p) => (p.gx + (p.facing === 0 ? 1 : 0)) % pr.lampEveryPlots === 0).length + 4, "a lamp every other plot on each side of a street, and one at each corner of the square");
    assert.ok(lamps.some((l) => l.yawDeg === 0) && lamps.some((l) => l.yawDeg === 180), "both sides of the streets");
    const sq = manifest.square!;
    const onSquare = (p: { center: { x: number; z: number } }) => Math.abs(p.center.x - sq.center.x) < sq.widthMm / 2 && Math.abs(p.center.z - sq.center.z) < sq.depthMm / 2;
    assert.ok(of(manifest, "bench").filter(onSquare).length >= 8, "benches round the square");
    assert.ok(!of(manifest, "fountain").some(onSquare) && !of(manifest, "statue").some(onSquare), `a town of 600 has no fountain or statue in its square (from ${pr.fountainMinPopulation} and ${pr.statueMinPopulation})`);
    // The same town with fountains and statues from anyone, and every master grand: a fountain, the town's statue and one to each grand master.
    const rules = structuredClone(BUILTIN_RULES);
    rules.props = { ...pr, fountainMinPopulation: 0, statueMinPopulation: 0 };
    rules.mastery!.grandMaster = { oneInMasters: 1, pupils: 30, pupilsPerWorkplace: 5 };
    const m = must(generateSettlement({ settlementId: "g", seed: 2, population: 600, rules })).manifest;
    const grand = m.occupancy.npcs.filter((n) => n.grandMaster).map((n) => n.id).sort();
    assert.equal(of(m, "fountain").filter(onSquareOf(m)).length, 1);
    const statues = of(m, "statue").filter(onSquareOf(m));
    assert.deepEqual(statues.filter((s) => s.honours).map((s) => s.honours).sort(), grand.slice(0, 6), "a statue to each grand master");
    assert.equal(statues.filter((s) => !s.honours).length, 1, "and the town's own");
    // Parks: benches facing a fountain or a statue; the stores' doors have barrels, the well-off homes planters.
    for (const park of m.structures.filter((s) => s.archetype === BUILTIN_RULES.openGround!.park)) {
      const here = m.props.filter((p) => p.parcel === park.parcel);
      assert.equal(here.filter((p) => p.kind === "bench").length, pr.parkBenches);
      assert.equal(here.filter((p) => p.kind === "fountain" || p.kind === "statue").length, 1);
    }
    for (const s of m.structures.filter((s) => pr.stores.includes(s.archetype))) assert.ok(m.props.some((p) => p.kind === "barrel" && p.parcel === s.parcel), `${s.archetype} has barrels`);
    assert.ok(of(m, "planter").length > 0);
    const gate = m.validation.find((g) => g.gate === "props")!;
    assert.ok(gate.ok, gate.detail);
  });

  it("raises the town hall and the churches on terraces, stairs down to the street", () => {
    const t = BUILTIN_RULES.props!.terraces;
    const built = new Map(manifest.structures.map((s) => [s.parcel, s.archetype]));
    const raised = manifest.structures.filter((s) => t.archetypes.includes(s.archetype));
    assert.ok(raised.some((s) => s.archetype === "town_hall"));
    const terraces = manifest.props.filter((p) => p.kind === "terrace");
    assert.deepEqual(terraces.map((p) => p.parcel).sort(), raised.map((s) => s.parcel).sort(), "a terrace under each, and nothing else");
    for (const p of terraces) {
      assert.equal(p.heightMm, t.heightMm);
      const stairs = manifest.props.find((q) => q.kind === "stairs" && q.parcel === p.parcel)!;
      const parcel = manifest.parcels.find((q) => q.id === p.parcel)!;
      const out = parcel.facing === 0 ? [0, 1] : parcel.facing === 180 ? [0, -1] : parcel.facing === 90 ? [1, 0] : [-1, 0];
      const ahead = (stairs.center.x - parcel.center.x) * out[0]! + (stairs.center.z - parcel.center.z) * out[1]!;
      assert.ok(ahead > BUILTIN_RULES.layout.parcelSizeMm[1] / 2, `${built.get(p.parcel!)}'s stairs run out into the street before its door`);
    }
    // What stands at a raised door stands on the terrace.
    for (const p of manifest.props.filter((p) => p.parcel && terraces.some((q) => q.parcel === p.parcel) && ["barrel", "crate", "planter"].includes(p.kind))) assert.equal(p.yMm, t.heightMm);
  });

  it("lives off its land: its richest resource is its industry, its export and its masters' craft, and caps its size", () => {
    const lands = {
      forest: { biomes: { forest: 650, plains: 350 }, waterKind: "none" as const, shoreM: -1 },
      mountain: { biomes: { mountains: 450, plains: 400, forest: 150 }, waterKind: "none" as const, shoreM: -1 },
      coast: { biomes: { sea: 400, beach: 100, plains: 300, forest: 200 }, waterKind: "sea" as const, shoreM: 20 },
      plains: { biomes: { plains: 900, forest: 100 }, waterKind: "river" as const, shoreM: 400 },
      rainforest: { biomes: { rainforest: 700, plains: 300 }, waterKind: "none" as const, shoreM: -1 },
    };
    const expect = { forest: ["timber", "sawmill", "crafting", "yew longbows and cabinets"], mountain: ["mining", "mine", "smithing", "silver-inlaid blades"], coast: ["fishing", "fishery", "fishing", "salted sea fish"], plains: ["farming", "mill", "farming", "flour and ale"], rainforest: ["timber", "sawmill", "crafting", "heartwood furniture and staves"] } as const;
    const workplaces = Object.values(BUILTIN_RULES.industry!.industries).map((i) => i.workplace).filter((w) => w !== "mill");
    for (const [name, land] of Object.entries(lands)) {
      const [primary, workplace, profession, product] = expect[name as keyof typeof expect];
      let specialists = 0;
      let masters = 0;
      for (const seed of [1, 2, 3]) {
        const m = must(generateSettlement({ settlementId: "i", seed, population: 1000, access: "road", land })).manifest;
        assert.equal(m.industry?.primary, primary, name);
        assert.equal(m.industry?.product?.export, product, `${name} is known for its rarest resource`);
        assert.ok(m.structures.some((s) => s.archetype === workplace), `${name} has its ${workplace}s`);
        for (const w of workplaces) if (w !== workplace) assert.ok(!m.structures.some((s) => s.archetype === w), `${name} has no ${w}`);
        specialists += m.mastery.masters[profession] ?? 0;
        masters += Object.values(m.mastery.masters).reduce((a, b) => a + b, 0);
        const g = m.validation.find((v) => v.gate === "industry")!;
        assert.ok(g.ok, g.detail);
      }
      assert.ok(specialists * 2 > masters, `most of ${name}'s masters are in ${profession}: ${specialists} of ${masters}`);
    }
    // Poor land keeps a town small: its cap is scaled down from the access's.
    const poor = must(generateSettlement({ settlementId: "i", seed: 1, population: 2500, access: "road", land: { biomes: { beach: 1000 }, waterKind: "none", shoreM: -1 } })).manifest;
    assert.ok(poor.setting.capacity! < BUILTIN_RULES.settings.access.road.maxPopulation * 0.6, `poor land caps a road town at ${poor.setting.capacity}`);
    assert.equal(poor.setting.population, poor.setting.capacity);
    // Without the land a town has no industry, and no industry's workplace stands.
    assert.equal(manifest.industry, null);
    for (const w of [...workplaces, "master_fishery"]) assert.ok(!manifest.structures.some((s) => s.archetype === w), `no ${w} without the land`);
  });

  it("has the craft guild of its industry: a hall by the square from 400 people, led by a master, selling recipes by rank", () => {
    const forest = { biomes: { forest: 650, plains: 350 }, waterKind: "none" as const, shoreM: -1 };
    const m = must(generateSettlement({ settlementId: "g", seed: 1, population: 1000, access: "road", land: forest })).manifest;
    const g = m.guild!;
    assert.equal(g.profession, "crafting");
    const hall = m.structures.find((s) => s.id === g.hall)!;
    assert.equal(hall.archetype, "guild_hall");
    assert.equal(m.structures.filter((s) => s.archetype === "guild_hall").length, 1);
    assert.equal(m.occupancy.npcs.find((n) => n.id === g.master)?.mastery, "crafting", "a master of the guild leads it");
    assert.equal(m.props.filter((p) => p.kind === "guild_banner" && p.parcel === hall.parcel).length, 2, "banners either side of its door");
    assert.ok(m.props.some((p) => p.kind === "terrace" && p.parcel === hall.parcel), "on a terrace like the town hall");
    // Ash furniture to an initiate; the town's yew longbows only to a master's pupil.
    assert.deepEqual(g.ranks.map((r) => r.recipes), [["ash furniture"], [], [], ["yew longbows and cabinets"], []]);
    assert.ok(g.ranks.find((r) => r.recipes.includes(g.signature))!.pupil);
    // A hamlet has the guild but no hall; a town without the land has neither.
    const hamlet = must(generateSettlement({ settlementId: "g", seed: 1, population: 250, land: forest })).manifest;
    assert.equal(hamlet.guild?.hall, null);
    assert.ok(!hamlet.structures.some((s) => s.archetype === "guild_hall"));
    assert.equal(manifest.guild, null);
    assert.ok(!manifest.structures.some((s) => s.archetype === "guild_hall"));
  });

  it("puts what players gather round the town: tree stands, ore veins and fishing spots, clear of its ground", () => {
    const mountain = { biomes: { mountains: 450, plains: 400, forest: 150 }, waterKind: "none" as const, shoreM: -1 };
    const m = must(generateSettlement({ settlementId: "r", seed: 1, population: 1000, access: "road", land: mountain })).manifest;
    const veins = m.resources.filter((r) => r.kind === "ore_vein");
    const mines = m.structures.filter((s) => s.archetype === "mine").length;
    assert.equal(veins.length, mines * BUILTIN_RULES.industry!.resources!.perWorkplace, "three veins a mine");
    assert.ok(veins.some((r) => r.material === "silver-ore"), "some of what it is known for");
    assert.ok(veins.every((r) => ["iron-ore", "silver-ore"].includes(r.material) && r.skill === "Mining" && r.regrowHours === 0));
    // The forest near it is worth a few tree stands.
    assert.equal(m.resources.filter((r) => r.kind === "tree_stand").length, Math.round((BUILTIN_RULES.industry!.resources!.nearby * m.industry!.resources.timber) / 1000));
    assert.ok(m.validation.find((g) => g.gate === "resources")!.ok);
    // A worked-out stock leaves less in each vein.
    const worn = must(generateSettlement({ settlementId: "r", seed: 1, population: 1000, access: "road", land: { ...mountain, worked: "mining", depletedPermille: { mining: 300 } } })).manifest;
    assert.ok(worn.resources.filter((r) => r.kind === "ore_vein").every((r) => r.stock === Math.round((BUILTIN_RULES.industry!.resources!.nodes.mining!.stock * 700) / 1000)));
    // Fishing spots go on the water where the world is known: here the sea east of x = 250 m.
    const coast = { biomes: { sea: 400, beach: 100, plains: 300, forest: 200 }, waterKind: "sea" as const, shoreM: 20 };
    const site = { origin: [0, 0] as [number, number], dry: (x: number) => x < 250 };
    const port = must(generateSettlement({ settlementId: "r", seed: 1, population: 250, access: "road", land: coast, site })).manifest;
    const spots = port.resources.filter((r) => r.kind === "fishing_spot");
    assert.ok(spots.length > 0 && spots.every((r) => r.material === "sea-fish"));
    assert.equal(manifest.resources.length, 0, "none without the land");
    // In the scene each is a node someone can gather from: what it gives, how much, and whose stock it is.
    const nodes = worldNodes(settlementScene(m, BUILTIN_RULES, { origin: [0, 0] })).filter((w) => w.node.components?.ResourceNode);
    assert.equal(nodes.length, m.resources.length);
    assert.deepEqual(nodes.find((w) => w.node.id === veins[0]!.id)!.node.components!.ResourceNode, { material: veins[0]!.material, tier: veins[0]!.tier, skill: "Mining", stock: veins[0]!.stock, regrowHours: 0, town: "r" });
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
    assert.deepEqual(events.filter((e) => e.level === "summary").map((e) => e.stage), ["demographics", "demand", "layout", "structures", "occupancy", "character", "props", "validation"]);
    assert.equal(events.filter((e) => e.event === "structure_collapsed").length, manifest.parcels.length);
  });

  it("keeps only what the verbosity asks for (silent: nothing)", () => {
    assert.deepEqual(must(generateSettlement({ ...request, verbosity: "silent" })).events, []);
    assert.equal(must(generateSettlement({ ...request, verbosity: "summary" })).events.length, 8);
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
// cathedral and monastery). Again for settlement-rules/7 and settlement-gen/0.4.0: acreage, the watch, shared homes,
// mastery and grand masters, the homeless, masters on the best ground, parks and empty lots. Again for
// settlement-rules/8 and settlement-gen/0.5.0: street props, paved streets, terraces and stairs. Again for
// settlement-rules/9 and settlement-gen/0.6.0: industry (and its workplaces ruled out of a town without the land), and the
// home-space cap no longer counting farmsteads. Again for settlement-rules/10 and settlement-gen/0.7.0: the guild hall; and for
// settlement-rules/11 and settlement-gen/0.8.0: resource nodes (none here) and their gate.
const GOLDEN = "19252664017f0dc7e165005ac34982570868b819dc927b213a028b07bab32108";
