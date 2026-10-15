/**
 * Creature brains (docs/WILDLIFE.md): flee, defend, territorial warning, pack flank,
 * day/night activity, aquatic confinement, instinct raids, and the wildlife table as rules.
 * Synthetic worlds and fixed seeds; the integrator is stood in for by moving along intent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { IntentButton } from "@mmo-engine/protocol";
import { CreaturesSchema, type CreaturesRules } from "@mmo-engine/rules";
import { fnv1a32 } from "@mmo-engine/scatter";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CreatureSystem, isAwake, type CreatureOptions } from "../src/creatures.js";
import { loadGameRules } from "../src/rules/boot.js";
import { loadWildlifeTable } from "../src/procgen/wildlife-table.js";
import { loadNaturalWeapons, wildlifeCreatures } from "../src/procgen/wildlife-creatures.js";

const game = loadGameRules();
type Beh = NonNullable<CreaturesRules["creatures"][string]["behavior"]>;

/** One kind from partial numbers; the schema fills the rest. */
function kind(over: Record<string, unknown>, behavior?: Partial<Beh>): CreaturesRules["creatures"] {
  return CreaturesSchema.parse({
    creatures: {
      beast: { name: "Beast", health: 100, aggroRadius: 12, leashRadius: 60, respawnSeconds: 60, weapons: ["claw"], ...over, ...(behavior ? { behavior } : {}) },
    },
  }).creatures;
}

function setup(creatures: CreaturesRules["creatures"], extra: Partial<CreatureOptions> = {}) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const players: number[] = [];
  const addPlayer = (x: number, z: number): number => {
    const p = sim.spawn();
    for (const c of [C.Transform, C.Health, C.CharacterRef]) {
      addComponent(sim.ecs, c, p);
      for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[p] = 0;
    }
    C.Transform.qw[p] = 1;
    C.Transform.px[p] = x;
    C.Transform.pz[p] = z;
    C.Health.current[p] = C.Health.max[p] = 100;
    players.push(p);
    return p;
  };
  const warnings: Array<{ e: number; ms: number; tick: number }> = [];
  const cancels: number[] = [];
  let tod: number | null = null;
  const sys = new CreatureSystem({
    creatures,
    bases: game.rules.items.bases,
    warn: (e, _x, _z, _yaw, _r, ms, tick) => warnings.push({ e, ms, tick }),
    cancelWarn: (e) => cancels.push(e),
    timeOfDay: () => tod,
    ...extra,
  });
  let tick = 0;
  const run = (n: number, after?: () => void): void => {
    for (let i = 0; i < n; i++) {
      sim.beginTick(++tick);
      sys.step(sim);
      for (const e of sys.entities()) {
        C.Transform.px[e] += C.PlayerIntent.mx[e] * 0.1;
        C.Transform.pz[e] += C.PlayerIntent.mz[e] * 0.1;
      }
      after?.();
      sim.endTick();
    }
  };
  const dist = (a: number, b: number): number => Math.hypot(C.Transform.px[a] - C.Transform.px[b], C.Transform.pz[a] - C.Transform.pz[b]);
  return { sim, sys, addPlayer, run, dist, warnings, cancels, setTod: (t: number | null) => { tod = t; }, now: () => tick };
}

describe("natural weapons and the wildlife table as rules", () => {
  const table = loadWildlifeTable();
  const rules = wildlifeCreatures(table, loadNaturalWeapons());

  it("every species of the table is a valid creature kind with a real item base", () => {
    assert.equal(Object.keys(rules).length, Object.keys(table.species).length);
    const parsed = CreaturesSchema.parse({ creatures: rules });
    for (const [id, c] of Object.entries(parsed.creatures)) {
      for (const w of c.weapons) assert.ok(game.rules.items.bases[w], `${id}: base ${w}`);
      assert.equal(c.health, table.species[id]!.danger.health);
      assert.equal(c.behavior!.telegraphS, table.species[id]!.danger.telegraphS);
    }
  });

  it("a blow lands near damageX times a goblin's, whatever the animal", () => {
    const goblin = game.rules.creatures.creatures.goblin;
    const sys = setup(CreaturesSchema.parse({ creatures: { ...game.rules.creatures.creatures, ...rules } }).creatures, { massPower: game.rules.combat.damage.massPower });
    const dmg = (kindId: string): number => {
      const e = sys.sys.spawn(sys.sim, kindId, 0, 0);
      const w = sys.sys.weaponOf(e)!;
      return game.hooks.computeDamage({ technique: w.technique, skill: 0, item: w.item, part: "torso" }).amount;
    };
    const goblinAvg = goblin.weapons.reduce((s, b) => {
      const base = game.rules.items.bases[b]!;
      return s + game.hooks.computeDamage({ technique: base.technique, skill: 0, item: base, part: "torso" }).amount;
    }, 0) / goblin.weapons.length;
    for (const id of ["deer", "boar", "wolf", "bear", "shark"]) {
      const want = table.species[id]!.danger.damageX;
      const ratio = dmg(id) / goblinAvg / want;
      assert.ok(ratio > 0.6 && ratio < 1.6, `${id}: ${ratio.toFixed(2)} of damageX`);
    }
    assert.ok(dmg("bear") > dmg("wolf") && dmg("wolf") > dmg("rabbit"));
  });
});

describe("flee", () => {
  const rules = kind({ health: 80, weapons: ["bite"] }, { temperament: "flee", noticeM: 20 });
  it("runs from a player inside its notice radius, then goes home once clear", () => {
    const w = setup(rules);
    const p = w.addPlayer(30, 0);
    const [d] = w.sys.spawnPack(w.sim, "beast", 0, 0, [1, 1]);
    w.run(5);
    assert.equal(w.sys.modeOf(d), "idle");
    C.Transform.px[p] = 10;
    const start = w.dist(d, p);
    w.run(40);
    assert.equal(w.sys.modeOf(d), "flee");
    assert.ok(w.dist(d, p) > start, "farther from the player");
    assert.equal(C.PlayerIntent.buttons[d], 0, "prey never swings");
    C.Transform.px[p] = 500;
    w.run(600);
    assert.ok(Math.hypot(C.Transform.px[d], C.Transform.pz[d]) < 2.5, "back home");
  });
  it("runs faster than it would chase (fleeSpeed)", () => {
    const both = { ...rules, ...kind({ health: 80, weapons: ["bite"] }, { temperament: "hunt", noticeM: 20 }) };
    both.hunter = both.beast;
    both.beast = rules.beast;
    const w = setup(both);
    const [d] = w.sys.spawnPack(w.sim, "beast", 0, 0, [1, 1]);
    const [h] = w.sys.spawnPack(w.sim, "hunter", 0, 0, [1, 1]);
    assert.ok(Math.abs(C.NavAgent.speed[d] / C.NavAgent.speed[h] - 1.4) < 1e-4);
  });
});

describe("defend", () => {
  const rules = kind({}, { temperament: "defend", noticeM: 10, telegraphS: 1.5 });
  it("bluffs with a warning but fights only once hurt", () => {
    const w = setup(rules);
    const p = w.addPlayer(6, 0);
    const [d] = w.sys.spawnPack(w.sim, "beast", 0, 0, [1, 1]);
    let swings = 0;
    w.run(120, () => { if (C.PlayerIntent.buttons[d] === IntentButton.Attack) swings++; });
    assert.equal(w.warnings.length >= 1, true, "warned");
    assert.equal(swings, 0, "never struck an unharmed player");
    assert.notEqual(w.sys.modeOf(d), "chase");
    C.Health.current[d] -= 10; // the player hits it
    C.Transform.px[p] = 0.5;
    w.run(60, () => { if (C.PlayerIntent.buttons[d] === IntentButton.Attack) swings++; });
    assert.ok(swings > 0, "fights back once hurt");
  });
});

describe("territorial warning, then the strike", () => {
  const rules = kind({ attackEverySeconds: 1.5 }, { temperament: "territorial", noticeM: 14, telegraphS: 2 });
  it("warns for telegraphS, standing still, then chases and swings", () => {
    const w = setup(rules);
    const p = w.addPlayer(10, 0);
    const [d] = w.sys.spawnPack(w.sim, "beast", 0, 0, [1, 1]);
    const swings: number[] = [];
    w.run(200, () => { if (C.PlayerIntent.buttons[d] === IntentButton.Attack) swings.push(w.now()); });
    assert.equal(w.warnings.length, 1);
    assert.equal(w.warnings[0]!.ms, 2000);
    assert.ok(swings.length > 0, "then it struck");
    assert.ok(swings[0]! >= w.warnings[0]!.tick + 60, `no strike before the warning ends (${swings[0]} vs ${w.warnings[0]!.tick})`);
    assert.ok(w.dist(d, p) < 2, "closed on the intruder");
  });
  it("calls the warning off when the intruder backs away, and stays calm a while", () => {
    const w = setup(rules);
    const p = w.addPlayer(10, 0);
    const [d] = w.sys.spawnPack(w.sim, "beast", 0, 0, [1, 1]);
    w.run(10);
    assert.equal(w.sys.modeOf(d), "warn");
    C.Transform.px[p] = 100;
    w.run(5);
    assert.deepEqual(w.cancels, [d]);
    assert.equal(w.sys.modeOf(d), "idle");
  });
  it("gives up the chase when the intruder leaves its ground", () => {
    const w = setup(rules);
    const p = w.addPlayer(10, 0);
    const [d] = w.sys.spawnPack(w.sim, "beast", 0, 0, [1, 1]);
    w.run(100);
    assert.equal(w.sys.modeOf(d), "chase");
    C.Transform.px[p] = C.Transform.px[d] + 14 * 1.6 + 5;
    w.run(2);
    assert.equal(w.sys.modeOf(d), "return");
  });
});

describe("pack flank", () => {
  const rules = kind({ pack: [2, 2], aggroRadius: 40, leashRadius: 200 }, { temperament: "hunt", noticeM: 40, tactics: "flank" });
  it("members come in from opposite sides of the line to the target", () => {
    const w = setup(rules);
    const p = w.addPlayer(40, 0);
    const [a, b] = w.sys.spawnPack(w.sim, "beast", 0, 0, [2, 2]);
    w.run(40); // mid-approach, still beyond close-in
    const side = (e: number): number => Math.sign(C.Transform.pz[e] - C.Transform.pz[p]);
    assert.notEqual(side(a), 0);
    assert.equal(side(a), -side(b), "one each side");
    w.run(1200);
    assert.ok(w.dist(a, p) < 3 && w.dist(b, p) < 3, "both arrive");
  });
  it("one noticing is enough: pack-mates take its target", () => {
    const w = setup(kind({ pack: [3, 3], aggroRadius: 20, leashRadius: 300 }, { temperament: "hunt", noticeM: 20 }));
    w.addPlayer(100, 0);
    const ids = w.sys.spawnPack(w.sim, "beast", 0, 0, [3, 3]);
    ids.forEach((e) => { C.Transform.px[e] = 70; });
    C.Transform.px[ids[0]!] = 85; // one wandered close (15 m from the player); the others, 30 m away, are within the pack's call
    w.run(2);
    assert.ok(ids.every((e) => w.sys.modeOf(e) === "chase"), ids.map((e) => w.sys.modeOf(e)).join());
  });
});

describe("activity by time of day", () => {
  it("windows", () => {
    assert.ok(isAwake("diurnal", 0.5) && !isAwake("diurnal", 0.0));
    assert.ok(isAwake("nocturnal", 0.0) && !isAwake("nocturnal", 0.5));
    assert.ok(isAwake("crepuscular", 0.25) && !isAwake("crepuscular", 0.5) && !isAwake("crepuscular", 0.0));
    assert.ok(isAwake("cathemeral", 0.5) && isAwake("cathemeral", 0.0) && isAwake("diurnal", null));
  });
  it("a nocturnal hunter sleeps through the day (notices a quarter as far) and wakes at night", () => {
    const w = setup(kind({}, { temperament: "hunt", noticeM: 20, activity: "nocturnal" }));
    w.addPlayer(12, 0);
    const [d] = w.sys.spawnPack(w.sim, "beast", 0, 0, [1, 1]);
    w.setTod(0.5);
    w.run(5);
    assert.equal(w.sys.modeOf(d), "idle", "asleep at noon");
    w.setTod(0.0);
    w.run(5);
    assert.equal(w.sys.modeOf(d), "chase", "awake at midnight");
  });
});

describe("aquatic creatures", () => {
  // Water for x < 0 (3 m deep, surface at y 0), dry beyond.
  const water = (x: number): boolean => x < 0;
  const opts: Partial<CreatureOptions> = {
    waterDepthAt: (x) => (water(x) ? 3 : 0),
    waterSurfaceAt: (x) => (water(x) ? 0 : null),
    groundHeightAt: (x) => (water(x) ? -3 : 1),
  };
  const rules = kind({ weapons: ["bite"], aggroRadius: 30, leashRadius: 200 }, { temperament: "hunt", noticeM: 30, habitat: "water", depthM: [2, 2.4] as [number, number] });
  it("spawns swimming at its depth, and does not leave the water chasing a player on the shore", () => {
    const w = setup(rules, opts);
    const p = w.addPlayer(10, 0);
    const [s] = w.sys.spawnPack(w.sim, "beast", -10, 0, [1, 1]);
    assert.equal(C.Locomotion.mode[s], 1, "swim mode");
    assert.ok(Math.abs(C.Transform.py[s] - (0 - 2.2)) < 0.01, "at mid depth");
    w.run(300, () => assert.ok(C.Transform.px[s] < 0.1, `stays in water (x=${C.Transform.px[s]})`));
    assert.ok(C.Transform.px[s] > -4, "swam to the shore edge after it");
    assert.ok(w.dist(s, p) > 5);
  });
  it("drives the vertical intent toward its depth", () => {
    const w = setup(rules, opts);
    const [s] = w.sys.spawnPack(w.sim, "beast", -10, 0, [1, 1]);
    C.Transform.py[s] = 0; // at the surface
    w.run(1);
    assert.ok(C.PlayerIntent.my[s] < 0, "dives");
  });
});

describe("instinct raids", () => {
  const raider = (extra: Record<string, unknown> = {}) =>
    kind(
      { health: 500, aggroRadius: 5, leashRadius: 20, weapons: ["crush"], ...extra },
      { temperament: "raid", noticeM: 5, size: 3, speedX: 6, raid: { rangeM: 800, hungerSeconds: 1, satiateSeconds: 4, minStructures: 3, weights: { player: 1, livestock: 3, structure: 0.5 } } },
    );
  const settlements = [
    { x: 300, z: 0, size: 2, radius: 30 }, // too small
    { x: 0, z: 400, size: 12, radius: 30 }, // qualifies, bigger and not much farther
    { x: 5000, z: 0, size: 50, radius: 30 }, // out of range
  ];
  it("hungry, it goes for the best qualifying settlement in range, not the nearest small or the far large", () => {
    const w = setup(raider(), { settlements: () => settlements });
    const [r] = w.sys.spawnPack(w.sim, "beast", 0, 0, [1, 1]);
    w.run(200);
    assert.equal(w.sys.modeOf(r), "raid");
    let reached = 0;
    w.run(1500, () => { reached = Math.max(reached, C.Transform.pz[r]); });
    assert.ok(reached > 370 && reached < 430, `got to the settlement at z 400 (${reached})`);
    assert.ok(Math.abs(C.Transform.px[r]) < 40, "not off toward the small or the far one");
  });
  it("prefers livestock to a player to a structure by its weights, strikes it, and is sated", () => {
    const w = setup(CreaturesSchema.parse({ creatures: { ...raider(), cow: { name: "Cow", health: 100, aggroRadius: 5, leashRadius: 5, respawnSeconds: 1, weapons: ["horn"], behavior: { temperament: "defend", role: "livestock" } } } }).creatures, { settlements: () => [settlements[1]!] });
    const player = w.addPlayer(0, 405);
    const [r] = w.sys.spawnPack(w.sim, "beast", 0, 380, [1, 1]);
    const [cow] = w.sys.spawnPack(w.sim, "cow", 0, 412, [1, 1]);
    const prop = w.sim.spawn();
    for (const c of [C.Transform, C.Health]) addComponent(w.sim.ecs, c, prop);
    C.Transform.pz[prop] = 400;
    C.Health.current[prop] = C.Health.max[prop] = 50;
    const swungAt = new Set<number>();
    let sawRaid = false;
    w.run(900, () => {
      if (w.sys.modeOf(r) === "raid") sawRaid = true;
      // Whoever is nearest the raider when it swings is who it swings at.
      if (C.PlayerIntent.buttons[r] === IntentButton.Attack) {
        let best = -1, bd = 1e9;
        for (const t of [player, cow!, prop]) { const d = w.dist(r, t); if (d < bd) { bd = d; best = t; } }
        swungAt.add(best);
      }
    });
    assert.ok(sawRaid);
    assert.ok(swungAt.size > 0, "it fought");
    // Livestock (weight 3) outweighs the player (1) at a similar distance; the prop is the least wanted.
    assert.ok(swungAt.has(cow!) || swungAt.has(player), "went for food or noise first");
    assert.ok(!swungAt.has(prop) || swungAt.has(cow!), "structure only after the food");
  });
  it("sated after satiateSeconds of fighting, it retreats to its lair and stays down until hungry again", () => {
    const w = setup(raider(), { settlements: () => [settlements[1]!] });
    const player = w.addPlayer(0, 400);
    C.Health.max[player] = C.Health.current[player] = 1e9; // a punching bag that does not die
    const [r] = w.sys.spawnPack(w.sim, "beast", 0, 0, [1, 1]);
    const modes = new Set<string>();
    w.run(3000, () => modes.add(w.sys.modeOf(r)!));
    assert.ok(modes.has("raid") && modes.has("return"), [...modes].join());
  });
});

describe("looks: the animal model by asset hash, scaled by size", () => {
  it("carries the model's AssetRef hash and its size", () => {
    const w = setup(kind({}, { size: 2.5 }), { modelOf: () => "animals/SM_Bear_01" });
    const [e] = w.sys.spawnPack(w.sim, "beast", 0, 0, [1, 1]);
    assert.equal(C.AssetRef.assetHash[e], fnv1a32("animals/SM_Bear_01"));
    assert.equal(C.Transform.sx[e], 2.5);
    assert.ok(w.sys.weaponOf(e)!.reach > 2.5 * 0.5, "reach grows with size");
  });
});
