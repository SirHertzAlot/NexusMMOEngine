/**
 * Tests for Track A1: Live Vein Traits in ItemService views, Weapon specs,
 * StaminaSystem attack drain, CombatSystem armour penetration & hit damage,
 * and provenance persistence across item transfers (`moveItem`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { combatMove, IntentButton, Move, type ItemProvenanceView } from "@mmo-engine/protocol";
import { DEFAULT_CIVIC_RULES, engineDefaults, type LootRules, type VeinTraitDef } from "@mmo-engine/rules";
import { CombatSystem, type Weapon } from "../../src/combat.js";
import * as C from "../../src/components.js";
import { SqliteCivicStore } from "../../src/civic/index.js";
import {
  ItemDefs,
  ItemService,
  applyTraitToItemViewStats,
  applyTraitToWeapon,
  resolveTraitById,
  type PoolItemLike,
} from "../../src/items/index.js";
import { loadGameRules } from "../../src/rules/boot.js";
import { ATTACK_COST, DODGE_COST, StaminaSystem } from "../../src/stats/stamina-system.js";
import { IntegrateSystem, IntentSystem } from "../../src/systems.js";
import { SimWorld } from "../../src/world.js";

const DT = 1 / 30;
const { hooks } = loadGameRules();

const RULES = (() => {
  const r = engineDefaults();
  r.items.bases.sword = {
    ...r.items.fallback,
    mass: 1.3,
    length: 0.9,
    edge: 0.9,
    point: 0.8,
    hardness: 0.9,
    durability: 100,
    hand: "main",
    technique: "cut",
    models: ["pack/SM_Wep_Sword_01"],
  };
  r.items.bases.shield = {
    ...r.items.fallback,
    mass: 4.0,
    length: 0.6,
    edge: 0.05,
    point: 0.05,
    hardness: 0.9,
    durability: 150,
    hand: "off",
    technique: "bludgeon",
    models: ["pack/SM_Wep_Shield_01"],
  };
  return r;
})();

const LOOT: LootRules = {
  ownershipSeconds: 30,
  despawnSeconds: 300,
  pickupRange: 2.5,
  bagSlots: 10,
  maxGroundItems: 64,
};

const POOL: PoolItemLike[] = [
  {
    id: "iron-sword-1",
    rank: "common",
    source: "craft",
    item: "sword",
    seed: 1,
    bundle: {
      Identity: { id: "iron-sword-1", name: "Iron Sword", base: "sword" },
      Rank: { id: "common", color: "#ffffff" },
      Stats: { power: 10 },
    },
  },
  {
    id: "oak-shield-1",
    rank: "common",
    source: "craft",
    item: "shield",
    seed: 2,
    bundle: {
      Identity: { id: "oak-shield-1", name: "Oak Shield", base: "shield" },
      Rank: { id: "common", color: "#ffffff" },
      Stats: { block: 5 },
    },
  },
  {
    id: "bread-1",
    rank: "common",
    source: "mob",
    item: "bread",
    seed: 3,
    bundle: {
      Identity: { id: "bread-1", name: "Bread", base: "bread" },
      Rank: { id: "common", color: "#ffffff" },
      Stats: { nourish: 25 },
    },
  },
];

const BASE_WEAPON: Weapon = {
  technique: "cut",
  item: { mass: 1.2, edge: 0.8, point: 0.3, hardness: 0.6 },
  reach: 0.9,
  family: "sword",
};

const hitTick = (move: number): number => 1 + Math.round(combatMove(move)!.hitAt! * 30);

function makeTrait(overrides: Partial<VeinTraitDef> & { id: string }): VeinTraitDef {
  return {
    name: overrides.id,
    craftTag: "Test",
    powerBonusPct: 0,
    durabilityBonusPct: 0,
    staminaReductionPct: 0,
    armourPenetrationPct: 0,
    ...overrides,
  };
}

function makeProvenance(itemId: number, traitId: string): ItemProvenanceView {
  return {
    provenanceId: itemId * 10,
    veinBatchId: "east-gorge-vein-1",
    traitId,
    townId: "millhaven",
    crafterId: 1,
    crafterName: "Forgeon",
    eraTag: "Restored Cart Span",
    craftedAt: 1_700_000_000_000,
  };
}

function setupCombat(opts: {
  weaponOf: (e: number) => Weapon | null;
  armourOf?: (target: number) => number;
  withStamina?: boolean;
}) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const make = (comps: object[], x: number, z: number): number => {
    const e = sim.spawn();
    for (const c of comps) {
      addComponent(sim.ecs, c, e);
      for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
    }
    C.Transform.qw[e] = 1;
    C.Transform.px[e] = x;
    C.Transform.pz[e] = z;
    return e;
  };
  const attackerComps = opts.withStamina
    ? [C.Transform, C.Velocity, C.PlayerIntent, C.Action, C.Health, C.Stamina]
    : [C.Transform, C.Velocity, C.PlayerIntent, C.Action, C.Health];
  const attacker = make(attackerComps, 0, 0);
  C.Health.current[attacker] = C.Health.max[attacker] = 100;
  if (opts.withStamina) {
    C.Stamina.current[attacker] = C.Stamina.max[attacker] = 100;
  }
  const target = make([C.Transform, C.Health], 0, 1);
  C.Health.current[target] = C.Health.max[target] = 1000;

  const stamina = opts.withStamina ? new StaminaSystem() : undefined;
  const combat = new CombatSystem(30, stamina, {
    hooks,
    weaponOf: opts.weaponOf,
    armourOf: opts.armourOf,
  });
  const systems = stamina
    ? [new IntentSystem(), combat, stamina, new IntegrateSystem()]
    : [new IntentSystem(), combat, new IntegrateSystem()];

  let tick = 0;
  const run = (ticks: number, buttons = 0, lookYaw = 0): void => {
    for (let i = 0; i < ticks; i++) {
      sim.queueIntent(attacker, { mx: 0, my: 0, mz: 0, lookYaw, lookPitch: 0, jump: false, buttons });
      sim.beginTick(++tick);
      for (const s of systems) s.step(sim, DT);
      sim.endTick();
    }
  };
  return { sim, attacker, target, combat, stamina, run };
}

describe("Track A1 pure vein-trait modifiers", () => {
  const traits = DEFAULT_CIVIC_RULES.traits;

  it("resolveTraitById resolves known traits and returns undefined for missing/unknown ids", () => {
    assert.equal(resolveTraitById(traits, "high-carbon")?.powerBonusPct, 15);
    assert.equal(resolveTraitById(traits, "cold-short")?.staminaReductionPct, 10);
    assert.equal(resolveTraitById(traits, "deep-vein")?.armourPenetrationPct, 12);
    assert.equal(resolveTraitById(traits, "bog-standard")?.id, "bog-standard");
    assert.equal(resolveTraitById(traits, "unknown-trait"), undefined);
    assert.equal(resolveTraitById(traits, ""), undefined);
    assert.equal(resolveTraitById(traits, undefined), undefined);
    assert.equal(resolveTraitById(undefined, "high-carbon"), undefined);

    const byId = new Map(traits.map((t) => [t.id, t]));
    assert.equal(resolveTraitById(byId, "deep-vein")?.craftTag, "Deep-Forged");
  });

  it("applyTraitToItemViewStats handles all default traits, unknown/bog-standard no-ops, and edge bounds", () => {
    const baseStats = { power: 10, crit: 2 };

    // bog-standard & undefined -> exact no-op
    assert.deepEqual(applyTraitToItemViewStats(baseStats, 100, undefined), {
      stats: { power: 10, crit: 2 },
      durability: 100,
    });
    assert.deepEqual(
      applyTraitToItemViewStats(baseStats, 100, resolveTraitById(traits, "bog-standard")),
      { stats: { power: 10, crit: 2 }, durability: 100 },
    );

    // high-carbon: +15% power (10 -> 12), +10% durability (100 -> 110)
    assert.deepEqual(
      applyTraitToItemViewStats(baseStats, 100, resolveTraitById(traits, "high-carbon")),
      { stats: { power: 12, crit: 2 }, durability: 110 },
    );

    // cold-short: +8% power (10 -> 11), +0% durability, +10% stamina reduction
    assert.deepEqual(
      applyTraitToItemViewStats(baseStats, 100, resolveTraitById(traits, "cold-short")),
      { stats: { power: 11, crit: 2, staminaReductionPct: 10 }, durability: 100 },
    );

    // deep-vein: +6% power (10 -> 11), +20% durability (100 -> 120), +12% armour penetration
    assert.deepEqual(
      applyTraitToItemViewStats(baseStats, 100, resolveTraitById(traits, "deep-vein")),
      { stats: { power: 11, crit: 2, armourPenetrationPct: 12 }, durability: 120 },
    );

    // masterwork: +20% power (10 -> 12), +25% durability (100 -> 125), 10% stam reduction, 15% armour pen
    assert.deepEqual(
      applyTraitToItemViewStats(baseStats, 100, resolveTraitById(traits, "masterwork")),
      { stats: { power: 12, crit: 2, armourPenetrationPct: 15, staminaReductionPct: 10 }, durability: 125 },
    );

    // Negative percentages floor cleanly at >= 1 when base > 0
    const cursed = makeTrait({
      id: "brittle-slag",
      powerBonusPct: -150,
      durabilityBonusPct: -150,
      armourPenetrationPct: -25,
      staminaReductionPct: -10,
    });
    assert.deepEqual(applyTraitToItemViewStats({ power: 10 }, 100, cursed), {
      stats: { power: 1 },
      durability: 1,
    });

    // Items with power: 0, no power key, or durability: 0 are never inflated to 1
    assert.deepEqual(applyTraitToItemViewStats({ power: 0, nourish: 25 }, 0, cursed), {
      stats: { power: 0, nourish: 25 },
      durability: 0,
    });

    // Clamping bounds: armour pen 0..100, stamina reduction 0..50
    const overCapped = makeTrait({
      id: "overcapped",
      powerBonusPct: 0,
      durabilityBonusPct: 0,
      armourPenetrationPct: 180,
      staminaReductionPct: 90,
    });
    assert.deepEqual(applyTraitToItemViewStats({ power: 10 }, 50, overCapped), {
      stats: { power: 10, armourPenetrationPct: 100, staminaReductionPct: 50 },
      durability: 50,
    });
  });

  it("applyTraitToWeapon scales power via item mass and clamps pen/stamina cleanly", () => {
    // No-op on undefined or bog-standard
    const noopUndefined = applyTraitToWeapon(BASE_WEAPON, undefined);
    assert.deepEqual(noopUndefined, BASE_WEAPON);
    assert.notEqual(noopUndefined, BASE_WEAPON);
    assert.notEqual(noopUndefined.item, BASE_WEAPON.item);

    const noopBog = applyTraitToWeapon(BASE_WEAPON, resolveTraitById(traits, "bog-standard"));
    assert.deepEqual(noopBog, BASE_WEAPON);

    // high-carbon: +15% power -> mass * 1.15^2
    const hc = applyTraitToWeapon(BASE_WEAPON, resolveTraitById(traits, "high-carbon"));
    assert.ok(Math.abs(hc.item.mass - BASE_WEAPON.item.mass * 1.15 * 1.15) < 1e-9);
    assert.equal(hc.armourPenetrationPct, undefined);
    assert.equal(hc.staminaReductionPct, undefined);

    // cold-short: +8% power, 10% stamina reduction
    const cs = applyTraitToWeapon(BASE_WEAPON, resolveTraitById(traits, "cold-short"));
    assert.ok(Math.abs(cs.item.mass - BASE_WEAPON.item.mass * 1.08 * 1.08) < 1e-9);
    assert.equal(cs.staminaReductionPct, 10);
    assert.equal(cs.armourPenetrationPct, undefined);

    // deep-vein: +6% power, 12% armour pen
    const dv = applyTraitToWeapon(BASE_WEAPON, resolveTraitById(traits, "deep-vein"));
    assert.ok(Math.abs(dv.item.mass - BASE_WEAPON.item.mass * 1.06 * 1.06) < 1e-9);
    assert.equal(dv.armourPenetrationPct, 12);
    assert.equal(dv.staminaReductionPct, undefined);

    // masterwork: +20% power, 15% armour pen, 10% stamina reduction
    const mw = applyTraitToWeapon(BASE_WEAPON, resolveTraitById(traits, "masterwork"));
    assert.ok(Math.abs(mw.item.mass - BASE_WEAPON.item.mass * 1.2 * 1.2) < 1e-9);
    assert.equal(mw.armourPenetrationPct, 15);
    assert.equal(mw.staminaReductionPct, 10);

    // Negative / out-of-range clamping
    const extremeNeg = makeTrait({
      id: "extreme-neg",
      powerBonusPct: -200,
      armourPenetrationPct: -30,
      staminaReductionPct: -5,
    });
    const wNeg = applyTraitToWeapon(BASE_WEAPON, extremeNeg);
    assert.ok(Number.isFinite(wNeg.item.mass) && wNeg.item.mass > 0);
    assert.equal(wNeg.armourPenetrationPct, undefined);
    assert.equal(wNeg.staminaReductionPct, undefined);

    const extremePos = makeTrait({
      id: "extreme-pos",
      armourPenetrationPct: 165,
      staminaReductionPct: 85,
    });
    const wPos = applyTraitToWeapon(BASE_WEAPON, extremePos);
    assert.equal(wPos.armourPenetrationPct, 100);
    assert.equal(wPos.staminaReductionPct, 50);
  });
});

describe("Track A1 ItemService view, weaponForCharacter & moveItem provenance persistence", () => {
  const defs = new ItemDefs(POOL, RULES);

  it("applies trait stats/durability in view() and weaponForCharacter() across bog-standard, unknown, and active traits", () => {
    const items = new ItemService({ defs, loot: LOOT, tickHz: 30 });
    items.setTraitDefs(DEFAULT_CIVIC_RULES.traits);

    const provenanceMap = new Map<number, ItemProvenanceView>();
    items.setProvenanceLookup((id) => provenanceMap.get(id));

    const swordDef = defs.indexOf("iron-sword-1");
    const shieldDef = defs.indexOf("oak-shield-1");

    // Empty-handed -> null weapon
    assert.equal(items.weaponForCharacter(1), null);

    // Off-hand shield only -> null main-hand weapon
    const sh = items.give(1, shieldDef);
    assert.equal(sh.ok, true);
    assert.equal(items.equip(1, sh.itemId!).ok, true);
    assert.equal(items.weaponForCharacter(1), null);

    // Give 5 swords with different traits: none, bog-standard, unknown, high-carbon, cold-short, deep-vein
    const giveSword = (traitId: string | null): number => {
      const r = items.give(1, swordDef);
      assert.equal(r.ok, true);
      const id = r.itemId!;
      if (traitId !== null) provenanceMap.set(id, makeProvenance(id, traitId));
      return id;
    };

    const plainId = giveSword(null);
    const bogId = giveSword("bog-standard");
    const unknownId = giveSword("nonexistent-trait");
    const hcId = giveSword("high-carbon");
    const csId = giveSword("cold-short");
    const dvId = giveSword("deep-vein");

    // Plain, bog-standard, and unknown trait produce identical unmodified stats/durability
    assert.deepEqual(items.view(plainId).stats, { power: 10 });
    assert.equal(items.view(plainId).durability, 100);
    assert.deepEqual(items.view(bogId).stats, { power: 10 });
    assert.equal(items.view(bogId).durability, 100);
    assert.deepEqual(items.view(unknownId).stats, { power: 10 });
    assert.equal(items.view(unknownId).durability, 100);
    assert.equal(items.view(unknownId).provenance?.traitId, "nonexistent-trait");

    // Active trait views (and repeated view calls do not compound)
    assert.deepEqual(items.view(hcId).stats, { power: 12 });
    assert.equal(items.view(hcId).durability, 110);
    assert.deepEqual(items.view(hcId).stats, { power: 12 });
    assert.deepEqual(items.view(csId).stats, { power: 11, staminaReductionPct: 10 });
    assert.equal(items.view(csId).durability, 100);
    assert.deepEqual(items.view(dvId).stats, { power: 11, armourPenetrationPct: 12 });
    assert.equal(items.view(dvId).durability, 120);

    // Equip each sword into main hand and verify weaponForCharacter()
    assert.equal(items.equip(1, plainId).ok, true);
    const wPlain = items.weaponForCharacter(1)!;
    assert.ok(wPlain);
    assert.equal(wPlain.technique, "cut");
    assert.equal(wPlain.family, "sword");
    assert.ok(Math.abs(wPlain.item.mass - 1.3) < 1e-6);

    assert.equal(items.equip(1, bogId).ok, true);
    assert.deepEqual(items.weaponForCharacter(1), wPlain);

    assert.equal(items.equip(1, unknownId).ok, true);
    assert.deepEqual(items.weaponForCharacter(1), wPlain);

    assert.equal(items.equip(1, hcId).ok, true);
    const wHc = items.weaponForCharacter(1)!;
    assert.ok(Math.abs(wHc.item.mass - wPlain.item.mass * 1.15 * 1.15) < 1e-5);

    assert.equal(items.equip(1, csId).ok, true);
    const wCs = items.weaponForCharacter(1)!;
    assert.equal(wCs.staminaReductionPct, 10);

    assert.equal(items.equip(1, dvId).ok, true);
    const wDv = items.weaponForCharacter(1)!;
    assert.equal(wDv.armourPenetrationPct, 12);

    // setTraitDefs([]) clears trait modifiers cleanly
    items.setTraitDefs([]);
    assert.deepEqual(items.view(dvId).stats, { power: 10 });
    assert.equal(items.view(dvId).durability, 100);
    assert.deepEqual(items.weaponForCharacter(1), wPlain);
  });

  it("persists provenance and live trait modifiers across moveItem and equip", () => {
    const store = new SqliteCivicStore(":memory:");
    const items = new ItemService({ defs, loot: LOOT, tickHz: 30 });
    items.setTraitDefs(DEFAULT_CIVIC_RULES.traits);
    items.setProvenanceLookup((id) => store.getProvenanceByItemId(id));

    const swordDef = defs.indexOf("iron-sword-1");
    const given = items.give(1, swordDef);
    assert.equal(given.ok, true);
    const itemId = given.itemId!;

    const minted = store.mintProvenance({
      veinBatchId: "highland-ridge-vein-1",
      traitId: "deep-vein",
      townId: "millhaven",
      crafterId: 1,
      crafterName: "Forgeon",
      eraTag: "Restored Cart Span",
      craftedAt: 1_700_000_000_000,
    });
    store.bindItemProvenance(itemId, minted.provenanceId);

    // Move item from character 1 to character 2 and equip on character 2
    assert.equal(items.moveItem(itemId, 1, 2), true);
    assert.equal(items.store.inBagOf(2, itemId), true);
    assert.equal(items.view(itemId).provenance?.traitId, "deep-vein");
    assert.deepEqual(items.view(itemId).stats, { power: 11, armourPenetrationPct: 12 });
    assert.equal(items.view(itemId).durability, 120);

    assert.equal(items.equip(2, itemId).ok, true);
    assert.equal(items.weaponForCharacter(1), null);
    const w2 = items.weaponForCharacter(2)!;
    assert.equal(w2.armourPenetrationPct, 12);
    assert.ok(w2.item.mass > defs.mass[swordDef]!);
    store.close();
  });
});

describe("Track A1 CombatSystem hit damage, armour penetration clamping & stamina bounds", () => {
  const traits = DEFAULT_CIVIC_RULES.traits;

  it("increases hit damage proportionally for high-carbon and stays backward-compatible for bog-standard/unknown", () => {
    const baseRun = setupCombat({ weaponOf: () => BASE_WEAPON });
    baseRun.run(hitTick(Move.SwordA), IntentButton.Attack);
    const baseHit = baseRun.combat.drainHits()[0]!;
    assert.equal(baseHit.outcome, "hit");

    const bogRun = setupCombat({
      weaponOf: () => applyTraitToWeapon(BASE_WEAPON, resolveTraitById(traits, "bog-standard")),
    });
    bogRun.run(hitTick(Move.SwordA), IntentButton.Attack);
    const bogHit = bogRun.combat.drainHits()[0]!;
    assert.ok(Math.abs(bogHit.amount - baseHit.amount) < 1e-6);

    const unknownRun = setupCombat({
      weaponOf: () => applyTraitToWeapon(BASE_WEAPON, resolveTraitById(traits, "does-not-exist")),
    });
    unknownRun.run(hitTick(Move.SwordA), IntentButton.Attack);
    const unknownHit = unknownRun.combat.drainHits()[0]!;
    assert.ok(Math.abs(unknownHit.amount - baseHit.amount) < 1e-6);

    const hcRun = setupCombat({
      weaponOf: () => applyTraitToWeapon(BASE_WEAPON, resolveTraitById(traits, "high-carbon")),
    });
    hcRun.run(hitTick(Move.SwordA), IntentButton.Attack);
    const hcHit = hcRun.combat.drainHits()[0]!;
    assert.ok(hcHit.amount > baseHit.amount, "high-carbon must deal more damage");
    assert.ok(
      Math.abs(hcHit.amount - baseHit.amount * 1.15) < 1e-4,
      `expected +15% damage (${baseHit.amount * 1.15}), got ${hcHit.amount}`,
    );
  });

  it("deep-vein penetrates armour and clamps 0% & 100% armour penetration cleanly", () => {
    const armourFactor = 0.4; // 60% mitigation

    const unarmoured = setupCombat({ weaponOf: () => BASE_WEAPON, armourOf: () => 1 });
    unarmoured.run(hitTick(Move.SwordA), IntentButton.Attack);
    const unarmouredDmg = unarmoured.combat.drainHits()[0]!.amount;

    const armouredBase = setupCombat({ weaponOf: () => BASE_WEAPON, armourOf: () => armourFactor });
    armouredBase.run(hitTick(Move.SwordA), IntentButton.Attack);
    const armouredBaseDmg = armouredBase.combat.drainHits()[0]!.amount;
    assert.ok(Math.abs(armouredBaseDmg - unarmouredDmg * armourFactor) < 1e-4);

    // 0% and negative armour pen -> exact base armoured damage
    const zeroPen = setupCombat({
      weaponOf: () => ({ ...BASE_WEAPON, armourPenetrationPct: 0 }),
      armourOf: () => armourFactor,
    });
    zeroPen.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.ok(Math.abs(zeroPen.combat.drainHits()[0]!.amount - armouredBaseDmg) < 1e-4);

    const negPen = setupCombat({
      weaponOf: () => ({ ...BASE_WEAPON, armourPenetrationPct: -25 }),
      armourOf: () => armourFactor,
    });
    negPen.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.ok(Math.abs(negPen.combat.drainHits()[0]!.amount - armouredBaseDmg) < 1e-4);

    // 100% and >100% armour pen -> full unarmoured damage (clamped at 1.0 effective armour factor)
    const fullPen = setupCombat({
      weaponOf: () => ({ ...BASE_WEAPON, armourPenetrationPct: 100 }),
      armourOf: () => armourFactor,
    });
    fullPen.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.ok(Math.abs(fullPen.combat.drainHits()[0]!.amount - unarmouredDmg) < 1e-4);

    const overPen = setupCombat({
      weaponOf: () => ({ ...BASE_WEAPON, armourPenetrationPct: 175 }),
      armourOf: () => armourFactor,
    });
    overPen.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.ok(Math.abs(overPen.combat.drainHits()[0]!.amount - unarmouredDmg) < 1e-4);

    // Against unarmoured target, 100% pen does NOT amplify past unarmoured damage
    const bareFullPen = setupCombat({
      weaponOf: () => ({ ...BASE_WEAPON, armourPenetrationPct: 100 }),
      armourOf: () => 1,
    });
    bareFullPen.run(hitTick(Move.SwordA), IntentButton.Attack);
    assert.ok(Math.abs(bareFullPen.combat.drainHits()[0]!.amount - unarmouredDmg) < 1e-4);

    // deep-vein (+6% power, +12% armour pen) against 0.4 armour -> 1.06 * (1 - 0.6 * 0.88) = 1.06 * 0.472
    const dvWeapon = applyTraitToWeapon(BASE_WEAPON, resolveTraitById(traits, "deep-vein"));
    const dvRun = setupCombat({ weaponOf: () => dvWeapon, armourOf: () => armourFactor });
    dvRun.run(hitTick(Move.SwordA), IntentButton.Attack);
    const dvDmg = dvRun.combat.drainHits()[0]!.amount;
    const expectedFactor = 1 - (1 - armourFactor) * (1 - 0.12);
    assert.ok(dvDmg > armouredBaseDmg * 1.06, "armour pen must boost damage beyond power bonus alone");
    assert.ok(Math.abs(dvDmg - unarmouredDmg * 1.06 * expectedFactor) < 1e-3);
  });

  it("reduces attack stamina drain for cold-short, clamps bounds to 0..50%, and preserves dodge cost", () => {
    // Baseline attack cost (omitted staminaReductionPct)
    const baseStam = setupCombat({ weaponOf: () => BASE_WEAPON, withStamina: true });
    baseStam.run(1, IntentButton.Attack);
    assert.equal(C.Action.move[baseStam.attacker], Move.SwordA);
    assert.equal(C.Stamina.current[baseStam.attacker], 100 - ATTACK_COST);

    // cold-short: 10% reduction -> attack costs 9 instead of 10
    const csWeapon = applyTraitToWeapon(BASE_WEAPON, resolveTraitById(traits, "cold-short"));
    const csStam = setupCombat({ weaponOf: () => csWeapon, withStamina: true });
    csStam.run(1, IntentButton.Attack);
    assert.equal(C.Action.move[csStam.attacker], Move.SwordA);
    assert.equal(C.Stamina.current[csStam.attacker], 100 - ATTACK_COST * 0.9);

    // Negative reduction clamps to 0% -> full ATTACK_COST
    const negStam = setupCombat({
      weaponOf: () => ({ ...BASE_WEAPON, staminaReductionPct: -40 }),
      withStamina: true,
    });
    negStam.run(1, IntentButton.Attack);
    assert.equal(C.Stamina.current[negStam.attacker], 100 - ATTACK_COST);

    // Over-cap reduction (90%) clamps to 50% -> half ATTACK_COST
    const maxStam = setupCombat({
      weaponOf: () => ({ ...BASE_WEAPON, staminaReductionPct: 90 }),
      withStamina: true,
    });
    maxStam.run(1, IntentButton.Attack);
    assert.equal(C.Stamina.current[maxStam.attacker], 100 - ATTACK_COST * 0.5);

    // Gating threshold: with stamina = 9, plain weapon (cost 10) is denied while cold-short (cost 9) fires
    const deniedRun = setupCombat({ weaponOf: () => BASE_WEAPON, withStamina: true });
    assert.equal(deniedRun.stamina!.spend(deniedRun.sim, deniedRun.attacker, 100 - ATTACK_COST * 0.9), true);
    deniedRun.run(1, IntentButton.Attack);
    assert.equal(C.Action.move[deniedRun.attacker], Move.None);
    assert.equal(C.Stamina.current[deniedRun.attacker], ATTACK_COST * 0.9);

    const allowedColdRun = setupCombat({ weaponOf: () => csWeapon, withStamina: true });
    assert.equal(allowedColdRun.stamina!.spend(allowedColdRun.sim, allowedColdRun.attacker, 100 - ATTACK_COST * 0.9), true);
    allowedColdRun.run(1, IntentButton.Attack);
    assert.equal(C.Action.move[allowedColdRun.attacker], Move.SwordA);
    assert.equal(C.Stamina.current[allowedColdRun.attacker], 0);

    // Dodge cost is unaffected by weapon staminaReductionPct
    const dodgeRun = setupCombat({
      weaponOf: () => ({ ...BASE_WEAPON, staminaReductionPct: 50 }),
      withStamina: true,
    });
    dodgeRun.run(1, IntentButton.Dodge);
    assert.equal(C.Action.move[dodgeRun.attacker], Move.Roll);
    assert.equal(C.Stamina.current[dodgeRun.attacker], 100 - DODGE_COST);
  });

  it("integrates ItemService.weaponForCharacter end-to-end into CombatSystem + StaminaSystem", () => {
    const defs = new ItemDefs(POOL, RULES);
    const items = new ItemService({ defs, loot: LOOT, tickHz: 30 });
    items.setTraitDefs(DEFAULT_CIVIC_RULES.traits);
    const provenanceMap = new Map<number, ItemProvenanceView>();
    items.setProvenanceLookup((id) => provenanceMap.get(id));

    const swordDef = defs.indexOf("iron-sword-1");
    const rPlain = items.give(1, swordDef);
    const rCold = items.give(2, swordDef);
    if (!rPlain.ok) assert.fail(rPlain.error);
    if (!rCold.ok) assert.fail(rCold.error);
    assert.ok(rPlain.itemId !== undefined && rCold.itemId !== undefined);
    provenanceMap.set(rCold.itemId, makeProvenance(rCold.itemId, "cold-short"));

    assert.equal(items.equip(1, rPlain.itemId).ok, true);
    assert.equal(items.equip(2, rCold.itemId).ok, true);

    const w1 = setupCombat({ weaponOf: () => items.weaponForCharacter(1), withStamina: true });
    w1.run(hitTick(Move.SwordA), IntentButton.Attack);
    const hit1 = w1.combat.drainHits()[0]!;
    const stam1 = C.Stamina.current[w1.attacker];

    const w2 = setupCombat({ weaponOf: () => items.weaponForCharacter(2), withStamina: true });
    w2.run(hitTick(Move.SwordA), IntentButton.Attack);
    const hit2 = w2.combat.drainHits()[0]!;
    const stam2 = C.Stamina.current[w2.attacker];

    assert.ok(Math.abs(hit2.amount - hit1.amount * 1.08) < 1e-3);
    assert.equal(stam1, 100 - ATTACK_COST);
    assert.equal(stam2, 100 - ATTACK_COST * 0.9);
  });
});
