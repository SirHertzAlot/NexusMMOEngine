/** The wildlife table: schema, pyramid ratios, safe radius, danger ramp, livestock and aquatic rules, determinism. Synthetic species only for the rules; the shipped table must also be sound. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkWildlife, loadWildlifeTable, maxDangerAt, parseWildlifeTable, planWildlifeChunk, speciesModels, WildlifeTableSchema, type Centre, type WildlifeTable } from "../../src/procgen/wildlife-table.js";

const species = (over: Record<string, unknown>) => ({
  role: "small_prey", models: "bunny", habitat: "land", group: { kind: "herd", size: [4, 6] }, territoryM: 50, activity: "diurnal", temperament: "flee",
  danger: { tier: 0, health: 10, damageX: 0.1, noticeM: 10, telegraphS: 0, tactics: "none" }, biomes: { meadow: 10 }, ...over,
});

const base = (): Record<string, unknown> => ({
  version: 1, safeRadiusM: 100,
  rings: [{ fromM: 0, maxDanger: 1 }, { fromM: 100, maxDanger: 2 }, { fromM: 300, maxDanger: 4 }],
  livestock: { radiusM: [10, 60], packsPerKm2: 4000 },
  waterProximity: { rangeM: 100, boost: 1 },
  ratios: { predatorToPrey: [0.07, 0.13], apexToPrey: [0, 0.05] },
  biomes: { meadow: { packsPerKm2: 40000, fertility: 1 }, lagoon: { packsPerKm2: 40000, fertility: 1 } },
  species: {
    bunny: species({}),
    stag: species({ role: "large_herbivore", group: { kind: "herd", size: [2, 4] }, biomes: { meadow: 5 } }),
    cat: species({ role: "mesopredator", group: { kind: "solitary", size: [1, 1] }, temperament: "territorial", danger: { tier: 2, health: 50, damageX: 1, noticeM: 10, telegraphS: 2, tactics: "ambush" }, biomes: { meadow: 1.5 } }),
    pack: species({ role: "apex_predator", group: { kind: "pack", size: [3, 5] }, temperament: "hunt", danger: { tier: 4, health: 90, damageX: 1, noticeM: 25, telegraphS: 3, tactics: "flank" }, biomes: { meadow: 0.2 } }),
    cow: species({ role: "livestock", group: { kind: "herd", size: [2, 3] }, temperament: "defend", danger: { tier: 1, health: 100, damageX: 1, noticeM: 5, telegraphS: 0, tactics: "none" }, biomes: { meadow: 1, lagoon: 1 } }),
    fin: species({ role: "aquatic", trophic: "prey", habitat: "water", depthM: [2, 10], biomes: { lagoon: 10 }, group: { kind: "shoal", size: [5, 5] } }),
    jaw: species({ role: "aquatic", habitat: "water", depthM: [4, 20], trophic: "predator", apex: true, temperament: "hunt", danger: { tier: 3, health: 200, damageX: 2, noticeM: 30, telegraphS: 3, tactics: "none" }, biomes: { lagoon: 0.5 }, group: { kind: "solitary", size: [1, 1] } }),
    eel: species({ role: "aquatic", habitat: "water", depthM: [1, 10], trophic: "predator", temperament: "defend", danger: { tier: 1, health: 30, damageX: 0.5, noticeM: 4, telegraphS: 0, tactics: "none" }, biomes: { lagoon: 3.5 }, group: { kind: "solitary", size: [1, 1] } }),
  },
});
// meadow: prey 10*5 + 5*3 = 65; predators 1.5 + 0.2*4 = 2.3 -> 0.035: too few. Fix by raising the cat.
const sound = (): Record<string, unknown> => {
  const t = base() as { species: Record<string, { biomes: Record<string, number> }> };
  t.species.cat!.biomes.meadow = 5.5; // 5.5 + 0.8 = 6.3 / 65 = 0.097
  t.species.pack!.biomes.meadow = 0.2; // apex 0.8 / 65 = 0.012
  return t as unknown as Record<string, unknown>;
};

describe("wildlife table checks", () => {
  it("a sound table parses", () => {
    parseWildlifeTable(sound());
  });
  it("a prey-poor biome fails the predator:prey ratio, naming the biome", () => {
    const problems = checkWildlife(WildlifeTableSchema.parse(base()));
    assert.ok(problems.some((p) => p.startsWith("biome meadow: predator:prey")), problems.join("; "));
  });
  it("too many apex fails the apex ratio", () => {
    const t = sound() as { species: Record<string, { biomes: Record<string, number> }> };
    t.species.pack!.biomes.meadow = 2;
    assert.ok(checkWildlife(WildlifeTableSchema.parse(t)).some((p) => p.includes("apex:prey")));
  });
  it("rings may not allow a dangerous tier inside the safe radius", () => {
    const t = sound() as { rings: unknown };
    t.rings = [{ fromM: 0, maxDanger: 1 }, { fromM: 50, maxDanger: 2 }];
    assert.ok(checkWildlife(WildlifeTableSchema.parse(t)).some((p) => p.includes("inside safeRadiusM")));
  });
  it("a dangerous species must telegraph, water species need depths, livestock stays gentle", () => {
    const t = sound() as { species: Record<string, Record<string, unknown>> };
    (t.species.cat!.danger as { telegraphS: number }).telegraphS = 0;
    assert.ok(checkWildlife(WildlifeTableSchema.parse(t)).some((p) => p.includes("needs a telegraph")));
    const u = sound() as { species: Record<string, Record<string, unknown>> };
    delete u.species.fin!.depthM;
    assert.throws(() => WildlifeTableSchema.parse(u), /depthM/);
    const v = sound() as { species: Record<string, { danger: { tier: number } }> };
    v.species.cow!.danger.tier = 2;
    assert.ok(checkWildlife(WildlifeTableSchema.parse(v)).some((p) => p.includes("livestock above tier 1")));
  });
  it("the shipped table is sound", () => {
    const t = loadWildlifeTable();
    assert.ok(Object.keys(t.species).length > 20);
  });
});

describe("wildlife planner", () => {
  const t: WildlifeTable = parseWildlifeTable(sound());
  const centres: Centre[] = [{ x: 0, z: 0, kind: "spawn" }, { x: 2000, z: 0, kind: "settlement" }];
  const run = (over: Partial<Parameters<typeof planWildlifeChunk>[1]> = {}, range = 60) => {
    const packs: Array<ReturnType<typeof planWildlifeChunk>[number]> = [];
    for (let cx = -range; cx < range; cx++) for (let cz = -range; cz < range; cz++) packs.push(...planWildlifeChunk(t, { seed: 7, cx, cz, chunkWorldSize: 16, biomeAt: () => "meadow", centres, ...over }));
    return packs;
  };

  it("is deterministic", () => {
    assert.deepEqual(run(), run());
  });
  it("danger ramps with distance: nothing of tier 2+ inside the safe radius, tier 4 only past its ring", () => {
    const packs = run({}, 120); // out to 1920 m
    assert.ok(packs.length > 100);
    for (const p of packs) {
      const d = Math.hypot(p.x, p.z);
      assert.ok(p.tier <= maxDangerAt(t, Math.min(d, Math.hypot(p.x - 2000, p.z))), `${p.kind} tier ${p.tier} at ${d | 0} m`);
      if (p.tier >= 2) assert.ok(Math.min(d, Math.hypot(p.x - 2000, p.z)) >= 100);
    }
    assert.ok(packs.some((p) => p.tier === 2) && packs.some((p) => p.tier === 4), "the ramp does use its upper tiers");
  });
  it("the starter area holds only skittish and defensive animals", () => {
    const near = run({}, 6).filter((p) => Math.hypot(p.x, p.z) < 100);
    assert.ok(near.length > 0);
    assert.ok(near.every((p) => p.tier <= 1));
  });
  it("by individuals the pyramid holds in the wild", () => {
    const packs = run({ centres: [{ x: -1e6, z: -1e6, kind: "spawn" }] }, 120);
    const n = (kinds: string[]) => packs.filter((p) => kinds.includes(p.kind)).reduce((a, p) => a + (p.pack[0] + p.pack[1]) / 2, 0);
    const prey = n(["bunny", "stag"]);
    const pred = n(["cat", "pack"]);
    assert.ok(pred / prey > 0.07 && pred / prey < 0.13, `predator:prey ${(pred / prey).toFixed(3)}`);
  });
  it("livestock only in the ring round a settlement, never elsewhere", () => {
    const cows = run({}, 130).filter((p) => p.kind === "cow");
    assert.ok(cows.length > 0);
    for (const c of cows) { const d = Math.hypot(c.x - 2000, c.z); assert.ok(d >= 10 && d <= 60, `cow ${d | 0} m from the settlement`); }
  });
  it("aquatic species stand only in water within their depths; land species stay dry", () => {
    const depth = (x: number) => (x < 0 ? 6 : 0);
    const packs = run({ biomeAt: (x) => (x < 0 ? "lagoon" : "meadow"), depthAt: depth, centres: [{ x: -1e6, z: -1e6, kind: "spawn" }] }, 80);
    const fin = packs.filter((p) => p.kind === "fin");
    assert.ok(fin.length > 0 && fin.every((p) => p.x < 0), "fish in the water");
    assert.ok(packs.filter((p) => p.kind === "jaw").every((p) => p.x < 0), "a deep species only where deep enough");
    const aquatic = ["fin", "jaw", "eel"];
    assert.ok(packs.filter((p) => p.x < 0).every((p) => aquatic.includes(p.kind)), "no land animal in the water");
    assert.ok(packs.filter((p) => p.x >= 0).every((p) => !aquatic.includes(p.kind)));
    const shallow = run({ biomeAt: () => "lagoon", depthAt: () => 0.5, centres: [{ x: -1e6, z: -1e6, kind: "spawn" }] }, 30);
    assert.equal(shallow.length, 0, "too shallow for any of them (and no land animal in water)");
  });
  it("more groups near water", () => {
    const sparse = parseWildlifeTable({ ...sound(), biomes: { meadow: { packsPerKm2: 1500, fertility: 1 }, lagoon: { packsPerKm2: 1500, fertility: 1 } } });
    const count = (wd: number) => { let n = 0; for (let cx = -60; cx < 60; cx++) for (let cz = -60; cz < 60; cz++) n += planWildlifeChunk(sparse, { seed: 7, cx, cz, chunkWorldSize: 16, biomeAt: () => "meadow", centres: [{ x: -1e6, z: 0, kind: "spawn" }], waterDistanceAt: () => wd }).length; return n; };
    const wet = count(0);
    const dry = count(1e6);
    assert.ok(wet > dry * 1.5, `${wet} vs ${dry}`);
  });
  it("a species without creature rules is planned out", () => {
    assert.ok(run({ spawnable: (k) => k !== "cat" }).every((p) => p.kind !== "cat"));
  });
});

describe("species to models", () => {
  it("matches whole name words on synthetic entries, in sorted order", () => {
    const t = parseWildlifeTable(sound());
    const m = (n: string) => ({ id: `p/${n}`, name: n, skinned: false });
    const map = speciesModels(t, [m("Bunny"), m("Bunny_2"), m("Bunnyhop"), m("Sea_cow")]);
    assert.deepEqual(map.bunny, ["p/Bunny", "p/Bunny_2"], "Bunnyhop is not a bunny");
    assert.ok(!Object.values(map).flat().includes("p/Sea_cow"));
  });
});
