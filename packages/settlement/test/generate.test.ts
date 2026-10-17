/**
 * The whole pipeline: a request becomes a manifest whose content hash
 * identifies the town, every validation gate passes or the generation fails
 * with the stage that broke, and the event log says what was decided.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACRE_M2, BUILTIN_RULES, contentHash, generateSettlement, GENERATOR_VERSION } from "../src/index.js";

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
    const acres = farms.reduce((a, p) => a + p.holding!.areaM2, 0) / ACRE_M2;
    assert.ok(acres >= (manifest.demographics.population * BUILTIN_RULES.farming.acresPerPersonX10) / 10, `${Math.round(acres)} acres`);
    for (const f of farms) assert.ok(f.holding!.areaM2 / ACRE_M2 >= 40, "a holding is tens of acres");
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
// cathedral and monastery).
const GOLDEN = "a03557b8d322f04223a02e2d960702640e6b5dead1a2c16b18d1a6a3d855dc4b";
