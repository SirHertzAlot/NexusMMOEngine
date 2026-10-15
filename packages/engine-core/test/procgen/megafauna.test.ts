/** Megafauna (tier 5 bosses) and megaflora: schema, rarity bounds, ratios, raids, lairs, model mapping. Synthetic data for the rules; the shipped table must also be sound. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkWildlife, loadWildlifeTable, parseWildlifeTable, planWildlifeChunk, WildlifeTableSchema, type Centre, type WildlifeTable } from "../../src/procgen/wildlife-table.js";
import { bossModels, planMegafauna, raidTargets, type RaidSettlement } from "../../src/procgen/megafauna.js";
import { megafloraLayers, withMegaflora, type CatalogModel } from "../../src/procgen/wildlife-plan.js";
import { parseEcologyPlan, type EcologyPlan } from "../../src/procgen/ecology.js";

const sp = (over: Record<string, unknown>) => ({
  role: "small_prey", models: "bunny", habitat: "land", group: { kind: "herd", size: [4, 6] }, territoryM: 50, activity: "diurnal", temperament: "flee",
  danger: { tier: 0, health: 10, damageX: 0.1, noticeM: 10, telegraphS: 0, tactics: "none" }, biomes: { meadow: 10, lagoon: 0 }, ...over,
});
const bossBlock = (over: Record<string, unknown> = {}) => ({
  lengthM: 4, heightM: 2, base: { species: "cat", lengthM: 1.5 }, speedX: 1.4,
  lair: { radiusM: 150, floraBias: 0.5 }, rarityPer100Km2: 3, loot: "boss-hide", intelligence: 0, drives: ["hunger", "territory", "scent_blood"],
  weakPoints: [{ part: "eye", damageMult: 2, staggerS: 3 }],
  raid: {
    minPopulation: 300, minStructures: 20, minLivestock: 0, rangeM: 3000, cooldownS: 7200, approach: "habitat_edge", targets: ["livestock", "structures", "players"],
    retreat: { satiatedMeals: 4, hpBelowPct: 25, maxS: 600 }, warningSigns: [{ kind: "tracks", radiusM: 300, leadS: 600 }],
  },
  ...over,
});
const bossSpecies = (over: Record<string, unknown> = {}, boss: Record<string, unknown> = {}) =>
  sp({ role: "apex_predator", models: "bear", group: { kind: "solitary", size: [1, 1] }, temperament: "hunt", territoryM: 800, activity: "nocturnal",
    danger: { tier: 5, health: 2000, damageX: 9, noticeM: 60, telegraphS: 3, tactics: "ambush" }, biomes: { meadow: 1 }, boss: bossBlock(boss), ...over });
const seaBoss = (over: Record<string, unknown> = {}, boss: Record<string, unknown> = {}) =>
  sp({ role: "aquatic", trophic: "predator", models: "shark", habitat: "water", depthM: [10, 80], group: { kind: "solitary", size: [1, 1] }, temperament: "hunt", territoryM: 1500, activity: "crepuscular",
    danger: { tier: 5, health: 3500, damageX: 12, noticeM: 80, telegraphS: 3, tactics: "none" }, biomes: { lagoon: 1 },
    boss: bossBlock({ modelsNot: "fin|tooth|tail", lengthM: 14, heightM: 4, base: { species: "shark", lengthM: 3 }, speedX: 1.2, swimSpeedX: 1.9, raid: { ...bossBlock().raid, approach: "along_water", targets: ["structures", "players", "boats"] } , ...boss }), ...over });

const MEGA = { maxPerWorld: 5, maxRarityPer100Km2: 4, totalRarityPer100Km2: 40, bossToPredator: [0, 0.2], yardsticks: { goblin: 60, orc: 180, troll: 500, golem: 1000 }, healthTrolls: [2, 8], damageX: [5, 16], minTelegraphS: 2.5, minSpeedX: 1.1, minSwimSpeedX: 1.3, raidMinPopulation: 300, raidCooldownMinS: 1800, minSeparationM: 400, lairMinFromSettlementM: 200, maxModelScale: 20 };

const base = (): Record<string, any> => ({
  version: 1, safeRadiusM: 100,
  rings: [{ fromM: 0, maxDanger: 1 }, { fromM: 100, maxDanger: 2 }, { fromM: 300, maxDanger: 4 }, { fromM: 800, maxDanger: 5 }],
  livestock: { radiusM: [10, 60], packsPerKm2: 4000 },
  waterProximity: { rangeM: 100, boost: 1 },
  ratios: { predatorToPrey: [0.07, 0.13], apexToPrey: [0, 0.05] },
  megafauna: structuredClone(MEGA),
  biomes: { meadow: { packsPerKm2: 40000, fertility: 1 }, lagoon: { packsPerKm2: 40000, fertility: 1 } },
  species: {
    bunny: sp({}),
    stag: sp({ role: "large_herbivore", group: { kind: "herd", size: [2, 4] }, biomes: { meadow: 5 } }),
    cat: sp({ role: "mesopredator", models: "cat", group: { kind: "solitary", size: [1, 1] }, temperament: "territorial", danger: { tier: 2, health: 50, damageX: 1, noticeM: 10, telegraphS: 2, tactics: "ambush" }, biomes: { meadow: 5.5 } }),
    pack: sp({ role: "apex_predator", group: { kind: "pack", size: [3, 5] }, temperament: "hunt", danger: { tier: 4, health: 90, damageX: 1, noticeM: 25, telegraphS: 3, tactics: "flank" }, biomes: { meadow: 0.2 } }),
    fin: sp({ role: "aquatic", trophic: "prey", habitat: "water", depthM: [2, 10], biomes: { lagoon: 10 }, group: { kind: "shoal", size: [5, 5] } }),
    shark: sp({ role: "aquatic", habitat: "water", depthM: [3, 40], trophic: "predator", apex: true, temperament: "hunt", danger: { tier: 3, health: 300, damageX: 2, noticeM: 30, telegraphS: 3, tactics: "none" }, biomes: { lagoon: 0.9 }, group: { kind: "solitary", size: [1, 1] } }),
    eel: sp({ role: "aquatic", habitat: "water", depthM: [1, 10], trophic: "predator", temperament: "defend", danger: { tier: 1, health: 30, damageX: 0.5, noticeM: 4, telegraphS: 0, tactics: "none" }, biomes: { lagoon: 3.2 }, group: { kind: "solitary", size: [1, 1] } }),
    bear: bossSpecies({}, { modelsNot: "head" }),
    kraken: seaBoss(),
  },
});
const parse = (t: Record<string, any>): WildlifeTable => parseWildlifeTable(t);
const problems = (t: Record<string, any>): string[] => checkWildlife(WildlifeTableSchema.parse(t));
const edit = (f: (t: Record<string, any>) => void): Record<string, any> => { const t = base(); f(t); return t; };

describe("megafauna schema and checks", () => {
  it("a sound table with bosses parses", () => {
    const t = parse(base());
    assert.equal(t.species.bear!.danger.tier, 5);
  });
  it("a boss must declare intelligence 0 (instinct only) and at least one drive", () => {
    assert.throws(() => WildlifeTableSchema.parse(edit((t) => { t.species.bear.boss.intelligence = 1; })));
    assert.throws(() => WildlifeTableSchema.parse(edit((t) => { t.species.bear.boss.drives = []; })));
    assert.throws(() => WildlifeTableSchema.parse(edit((t) => { t.species.bear.boss.drives = ["cunning"]; })));
  });
  it("tier 5 and the boss block go together", () => {
    assert.ok(problems(edit((t) => { delete t.species.bear.boss; })).some((p) => p.includes("tier 5") && p.includes("boss")));
    assert.ok(problems(edit((t) => { t.species.bear.danger.tier = 3; })).some((p) => p.includes("boss") && p.includes("tier 5")));
  });
  it("rarity is bounded per species and in total", () => {
    assert.ok(problems(edit((t) => { t.species.bear.boss.rarityPer100Km2 = 9; })).some((p) => p.includes("rarity")));
    assert.ok(problems(edit((t) => { t.megafauna.totalRarityPer100Km2 = 5; })).some((p) => p.includes("total rarity")));
  });
  it("bosses stay out of the pyramid but are rarer than the predators they hunt beside", () => {
    assert.deepEqual(problems(base()), []);
    const crowded = edit((t) => { t.megafauna.bossToPredator = [0, 1e-9]; });
    assert.ok(problems(crowded).some((p) => p.includes("boss:predator")));
  });
  it("a boss is tougher than a few trolls and hits harder than a troll, within the scale", () => {
    assert.ok(problems(edit((t) => { t.species.bear.danger.health = 300; })).some((p) => p.includes("health")));
    assert.ok(problems(edit((t) => { t.species.bear.danger.health = 90000; })).some((p) => p.includes("health")));
    assert.ok(problems(edit((t) => { t.species.bear.danger.damageX = 1; })).some((p) => p.includes("damageX")));
  });
  it("a boss telegraphs and outruns the player", () => {
    assert.ok(problems(edit((t) => { t.species.bear.danger.telegraphS = 1; })).some((p) => p.includes("telegraph")));
    assert.ok(problems(edit((t) => { t.species.bear.boss.speedX = 0.9; })).some((p) => p.includes("speed")));
  });
  it("sea bosses need water habitat, a depth range that fits their body, and a swim speed", () => {
    assert.ok(problems(edit((t) => { t.species.kraken.habitat = "shore"; })).some((p) => p.includes("kraken") && p.includes("water")));
    assert.ok(problems(edit((t) => { t.species.kraken.depthM = [1, 8]; })).some((p) => p.includes("depth")));
    assert.ok(problems(edit((t) => { delete t.species.kraken.boss.swimSpeedX; })).some((p) => p.includes("swim")));
  });
  it("model scale comes from its body length over the base model and stays bounded; base must exist", () => {
    assert.ok(problems(edit((t) => { t.species.bear.boss.base.lengthM = 0.1; })).some((p) => p.includes("scale")));
    assert.ok(problems(edit((t) => { t.species.bear.boss.base.species = "nothing"; })).some((p) => p.includes("base")));
  });
  it("raid thresholds: big towns only, a real cooldown, a warning sign, safe radius kept", () => {
    assert.ok(problems(edit((t) => { t.species.bear.boss.raid.minPopulation = 50; })).some((p) => p.includes("raid") && p.includes("population")));
    assert.ok(problems(edit((t) => { t.species.bear.boss.raid.cooldownS = 60; })).some((p) => p.includes("cooldown")));
    assert.throws(() => WildlifeTableSchema.parse(edit((t) => { t.species.bear.boss.raid.warningSigns = []; })));
    assert.ok(problems(edit((t) => { t.species.kraken.boss.raid.approach = "habitat_edge"; })).some((p) => p.includes("along_water")), "a sea giant raids along the water");
  });
  it("a boss tier needs a ring that allows it, past the safe radius", () => {
    assert.ok(problems(edit((t) => { t.rings = [{ fromM: 0, maxDanger: 1 }, { fromM: 100, maxDanger: 4 }]; })).some((p) => p.includes("tier 5")));
    assert.ok(problems(edit((t) => { t.rings.push({ fromM: 50, maxDanger: 5 }); t.rings.sort((a: any, b: any) => a.fromM - b.fromM); })).length > 0);
  });
  it("a dire-wolf-style escort must name an existing non-boss species", () => {
    assert.ok(problems(edit((t) => { t.species.bear.boss.escort = { species: "ghost", count: [2, 3] }; })).some((p) => p.includes("escort")));
    parse(edit((t) => { t.species.bear.boss.escort = { species: "pack", count: [2, 3] }; }));
  });
  it("the regular planner never places a boss as an ordinary pack", () => {
    const t = parse(base());
    const centres: Centre[] = [{ x: -1e6, z: -1e6, kind: "spawn" }];
    let n = 0;
    for (let cx = -60; cx < 60; cx++) for (let cz = -60; cz < 60; cz++) for (const p of planWildlifeChunk(t, { seed: 3, cx, cz, chunkWorldSize: 16, biomeAt: () => "meadow", centres })) { n++; assert.ok(p.tier < 5, p.kind); }
    assert.ok(n > 100);
  });
  it("the shipped table is sound and its bosses obey the bounds", () => {
    const t = loadWildlifeTable();
    const bosses = Object.entries(t.species).filter(([, s]) => s.boss);
    assert.ok(bosses.length >= 12, `${bosses.length} bosses`);
    const m = t.megafauna!;
    assert.ok(bosses.reduce((a, [, s]) => a + s.boss!.rarityPer100Km2, 0) <= m.totalRarityPer100Km2);
    assert.ok(bosses.some(([, s]) => s.habitat === "water") && bosses.some(([, s]) => s.habitat === "land"));
    for (const [id, s] of bosses) assert.equal(s.boss!.intelligence, 0, id);
    assert.deepEqual(checkWildlife(t), []);
  });
});

describe("megafauna planner", () => {
  const t = parse(base());
  const spawn: Centre = { x: 2000, z: 2000, kind: "spawn" };
  const run = (over: Partial<Parameters<typeof planMegafauna>[1]> = {}, seed = 1) =>
    planMegafauna(t, { seed, sizeM: 4000, biomeAt: (x) => (x < 1000 ? "lagoon" : "meadow"), depthAt: (x) => (x < 1000 ? 30 : 0), centres: [spawn], ...over });
  const many = (n = 400, over: Partial<Parameters<typeof planMegafauna>[1]> = {}) => { const out: ReturnType<typeof run> = []; for (let s = 0; s < n; s++) out.push(...run(over, s)); return out; };

  it("is deterministic", () => {
    assert.deepEqual(run({}, 5), run({}, 5));
  });
  it("never exceeds the per-world cap, and averages about rarity x area (a handful at most)", () => {
    let total = 0;
    for (let s = 0; s < 400; s++) { const n = run({}, s).length; assert.ok(n <= t.megafauna!.maxPerWorld); total += n; }
    const expected = (3 + 3) * (16e6 / 100e6); // two bosses, 3 per 100 km2, a 4x4 km world
    assert.ok(Math.abs(total / 400 - expected) < 0.25, `mean ${(total / 400).toFixed(2)} vs ${expected.toFixed(2)}`);
    const capped = parse(edit((x) => { x.megafauna.maxPerWorld = 1; }));
    for (let s = 0; s < 100; s++) assert.ok(planMegafauna(capped, { seed: s, sizeM: 40000, biomeAt: () => "meadow", centres: [spawn] }).length <= 1);
  });
  it("never inside the safe radius or the tier-5 ring of a spawn, and not on top of a settlement", () => {
    const town: Centre = { x: 3500, z: 3500, kind: "settlement" };
    const lairs = many(400, { centres: [spawn, town] });
    assert.ok(lairs.length > 20);
    for (const l of lairs) {
      assert.ok(Math.hypot(l.x - spawn.x, l.z - spawn.z) >= 800, `${l.kind} ${Math.hypot(l.x - spawn.x, l.z - spawn.z) | 0} m from the spawn`);
      assert.ok(Math.hypot(l.x - town.x, l.z - town.z) >= t.megafauna!.lairMinFromSettlementM);
    }
  });
  it("sea bosses lie in water within their depths; land bosses stay dry", () => {
    const lairs = many();
    const sea = lairs.filter((l) => l.kind === "kraken");
    const land = lairs.filter((l) => l.kind === "bear");
    assert.ok(sea.length > 5 && land.length > 5);
    assert.ok(sea.every((l) => l.x < 1000 && l.depthM !== undefined && l.depthM >= 10 && l.depthM <= 80));
    assert.ok(land.every((l) => l.x >= 1000));
  });
  it("lairs keep apart", () => {
    for (let s = 0; s < 200; s++) {
      const ls = run({}, s);
      for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) assert.ok(Math.hypot(ls[i]!.x - ls[j]!.x, ls[i]!.z - ls[j]!.z) >= t.megafauna!.minSeparationM);
    }
  });
  it("lairs lean toward megaflora groves when the species asks", () => {
    const grove = (x: number) => (x > 3000 ? 1 : 0.05);
    const keen = parse(edit((x) => { x.species.bear.boss.lair.floraBias = 1; }));
    const near: ReturnType<typeof run> = [];
    for (let s = 0; s < 600; s++) near.push(...planMegafauna(keen, { seed: s, sizeM: 4000, biomeAt: () => "meadow", depthAt: () => 0, centres: [spawn], groveAt: grove }).filter((l) => l.kind === "bear"));
    const share = near.filter((l) => l.x > 3000).length / near.length;
    assert.ok(share > 0.55, `grove share ${share.toFixed(2)} (area share 0.25)`);
  });
});

describe("raids", () => {
  const t = parse(base());
  const lair = { kind: "bear", biome: "meadow", x: 3000, z: 3000, radiusM: 150, tier: 5 as const };
  const town = (over: Partial<RaidSettlement> = {}): RaidSettlement => ({ id: "t", x: 4500, z: 3000, population: 400, structures: 60, livestock: 80, foodStores: 100, coastal: false, ...over });
  const spawn: Centre = { x: 2000, z: 2000, kind: "spawn" };

  it("targets big towns in range, nearest first; ignores small ones and far ones", () => {
    const got = raidTargets(t, "bear", lair, [town({ id: "far", x: 9000 }), town({ id: "small", population: 120 }), town({ id: "near", x: 4000 }), town({ id: "mid" })], [spawn]);
    assert.deepEqual(got.map((s) => s.id), ["near", "mid"]);
  });
  it("structure and livestock thresholds also apply", () => {
    assert.equal(raidTargets(t, "bear", lair, [town({ structures: 5 })], [spawn]).length, 0);
  });
  it("never a settlement inside the starter safe radius unless the table says so", () => {
    const starter = town({ id: "starter", x: 2050, z: 2000 });
    assert.equal(raidTargets(t, "bear", lair, [starter], [spawn]).length, 0);
    const allowed = parse(edit((x) => { x.species.bear.boss.raid.allowInsideSafeRadius = true; }));
    assert.equal(raidTargets(allowed, "bear", lair, [starter], [spawn]).length, 1);
  });
  it("sea giants hit only coastal towns", () => {
    const k = { ...lair, kind: "kraken" };
    assert.equal(raidTargets(t, "kraken", k, [town({ coastal: false })], [spawn]).length, 0);
    assert.equal(raidTargets(t, "kraken", k, [town({ coastal: true })], [spawn]).length, 1);
  });
  it("a species without a raid spec targets nothing", () => {
    const g = parse(edit((x) => { delete x.species.bear.boss.raid; }));
    assert.deepEqual(raidTargets(g, "bear", lair, [town()], [spawn]), []);
  });
});

describe("boss art models", () => {
  const m = (n: string, size: [number, number, number] = [1, 1, 1], skinned = false): CatalogModel => ({ id: `p/${n}`, name: n, skinned, size });
  it("uses its own name matches, scaled by body length over the model's length", () => {
    const t = parse(base());
    const out = bossModels(t, [m("Shark", [1, 1, 3]), m("Shark_fin", [1, 1, 1]), m("Cat", [0.3, 0.5, 1.5])]);
    assert.equal(out.kraken!.from, "own");
    assert.deepEqual(out.kraken!.models.map((x) => x.id), ["p/Shark"]);
    assert.ok(Math.abs(out.kraken!.models[0]!.scale - 14 / 3) < 1e-9);
  });
  it("falls back to scaling the base species' model, and reports none when even that is missing", () => {
    const t = parse(base());
    const out = bossModels(t, [m("Cat", [0.3, 0.5, 1.5])]);
    assert.equal(out.bear!.from, "base:cat");
    assert.ok(Math.abs(out.bear!.models[0]!.scale - 4 / 1.5) < 1e-9);
    assert.equal(out.kraken!.from, "none");
  });
  it("a model that would need more than the maximum scale is skipped, and the base species' props are not used", () => {
    const t = parse(base());
    const out = bossModels(t, [m("Cat", [0.1, 0.5, 0.1]), m("Cat_head", [0.3, 0.5, 0.5])]);
    assert.equal(out.bear!.from, "none", "4 m over 0.1 m is 40x, and a head is a prop");
    assert.deepEqual(bossModels(t, [m("Cat", [0.3, 0.5, 1.5]), m("Cat_head", [0.3, 0.5, 0.5])]).bear!.models.map((x) => x.id), ["p/Cat"]);
  });
  it("skinned models are left out", () => {
    const t = parse(base());
    assert.equal(bossModels(t, [m("Shark", [1, 1, 3], true)]).kraken!.from, "none");
  });
});

describe("megaflora", () => {
  const withFlora = (): Record<string, any> => edit((t) => {
    t.megaflora = {
      "giant-fern": { kind: "fern", names: "fern", scale: [3, 6], collision: "none", biomes: { meadow: 2 }, groves: true },
      "scale-tree": { kind: "tree", names: "lepidodendron|cycad", scale: [3, 5], collision: "trunk", biomes: { meadow: 1 }, groves: true },
      "pitcher": { kind: "carnivorous", names: "pitcher_plant", scale: [3, 5], collision: "none", biomes: { meadow: 0.5 }, groves: true, hazard: { radiusM: 4, damageX: 2, telegraphS: 1.5 } },
    };
  });
  const m = (n: string): CatalogModel => ({ id: `p/${n}`, name: n, skinned: false });
  it("schema bounds the scale and requires a telegraphed hazard for carnivorous plants", () => {
    parse(withFlora());
    assert.throws(() => parse(edit((t) => { t.megaflora = { x: { kind: "fern", names: "fern", scale: [3, 30], collision: "none", biomes: { meadow: 1 }, groves: true } }; })), /scale/);
    assert.throws(() => parse(edit((t) => { t.megaflora = { x: { kind: "fern", names: "fern", scale: [0.5, 2], collision: "none", biomes: { meadow: 1 }, groves: true } }; })), /scale/);
    assert.throws(() => parse(edit((t) => { t.megaflora = { x: { kind: "carnivorous", names: "pitcher_plant", scale: [3, 5], collision: "none", biomes: { meadow: 1 }, groves: true } }; })), /hazard/);
    assert.throws(() => parse(edit((t) => { t.megaflora = { x: { kind: "fern", names: "fern", scale: [3, 5], collision: "none", biomes: { nowhere: 1 }, groves: true } }; })), /biome/);
  });
  it("layers: trunks collide, fronds do not, scales are the table's, only matching kinds appear", () => {
    const t = parse(withFlora());
    const layers = megafloraLayers(t, [m("SM_Env_Fern_01"), m("Cycad_1"), m("Rock")]);
    assert.deepEqual(layers.map((l) => l.id), ["megaGiantFern", "megaScaleTree"]);
    const fern = layers[0]!, tree = layers[1]!;
    assert.deepEqual(fern.scale, [3, 6]);
    assert.equal(fern.category, "plant");
    assert.equal(fern.collision?.shape, "none");
    assert.equal(tree.category, "tree");
    assert.equal(tree.collision?.shape, "box");
    assert.ok((tree.collision?.fit ?? 1) < 0.5, "a trunk share of the footprint, not the crown");
  });
  it("the plan takes the layers, a grove field and a biome group that is zero by default; validates", () => {
    const t = parse(withFlora());
    const plan: EcologyPlan = { version: 1, name: "t", fields: { forest: { scale: 100, seed: 1 } }, biomes: { default: { trees: 1 } }, layers: [] };
    const out = withMegaflora(plan, t, [m("Fern"), m("Cycad")]);
    parseEcologyPlan(JSON.parse(JSON.stringify(out)));
    assert.ok(out.fields.megaGrove);
    assert.equal(out.biomes.default!.megaGiantFern, 0, "no megaflora outside the biomes that list it");
    assert.ok((out.biomes.meadow?.megaGiantFern ?? 0) > 0);
    assert.equal(withMegaflora(plan, t, [m("Rock")]).layers.length, 0);
  });
  it("the shipped table's megaflora stays within the scale bounds", () => {
    const t = loadWildlifeTable();
    const f = Object.entries(t.megaflora ?? {});
    assert.ok(f.length >= 4);
    for (const [id, x] of f) assert.ok(x.scale[0] >= 1.5 && x.scale[1] <= 8, id);
  });
});
