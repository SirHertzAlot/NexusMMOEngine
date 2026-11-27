/**
 * Track P3 (`pool-systems`): End-to-end tests wiring all 5 engine respawning
 * systems (`DeathSystem`, `CreatureSystem`, `GatheringSystem`, `ChestSystem`,
 * `BreakSystem`, `CivicService`) onto a single shared L2-resident `SpawnPoolSoA`,
 * including persistence roundtrip via `encodeBinary` / `decodeBinary` and
 * steady-state zero-allocation verification.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { addComponent, defineQuery, entityExists, hasComponent } from "bitecs";
import { DEFAULT_CIVIC_RULES, type CivicRules } from "@mmo-engine/rules";
import { fnv1a32, parseSpawnTableJSON } from "@mmo-engine/scatter";
import { AssetRef, BodyConfig, Breakable, CharacterRef, CivicService, CreatureSystem, Health, INVALID_POOL_HANDLE, loadGameRules, PlayerIntent, PoolSlotFlags, RespawnKind, SimWorld, SlotState, SpawnPoolSoA, spawnScatterEntity, SqliteCivicStore, Transform, Velocity } from "@mmo-engine/engine-core";
import { buildSpawn } from "@mmo-engine/engine-core/dist/src/admin/spawn.js";
import { WalletSystem } from "@mmo-engine/engine-core/dist/src/economy/wallet.js";
import { GatheringSystem, type ResourceNodeSpec, SqliteGatheringStore } from "@mmo-engine/engine-core/dist/src/gathering/index.js";
import { breakDefsOf, BreakSystem, ChestSystem, SqlitePlacesStore } from "@mmo-engine/engine-core/dist/src/interact/index.js";
import type { ExtensionPlayer } from "@mmo-engine/engine-core/dist/src/net/extension.js";
import { compileSpawnPool } from "@mmo-engine/engine-core/dist/src/pools/spawn-pool-solver.js";
import { DeathRespawnPool, DeathSystem } from "../../src/death.js";

const GAME = loadGameRules();

const PROP_TABLE = parseSpawnTableJSON({
  version: 1,
  archetypes: {
    "world:crate": {
      asset: "world:crate",
      collision: { halfExtents: [0.5, 0.5, 0.5], motion: "static", shape: "box" },
      breakable: { health: 20, into: "remove", respawnS: 3 },
    },
    "world:statue": {
      asset: "world:statue",
      collision: { halfExtents: [0.8, 1.5, 0.8], motion: "static", shape: "box" },
      breakable: {
        health: 40,
        into: "variant",
        respawnS: null,
        repair: { material: "yew-log", count: 2, castSeconds: 1 },
      },
    },
  },
});

const TREE_SPEC: ResourceNodeSpec = {
  kind: "tree_stand",
  material: "yew-log",
  tier: 2,
  skill: "Woodcutting",
  stock: 2,
  regrowHours: 5 / 3600, // 5 seconds at default regrowHourMs = 3_600_000
  halfX: 2,
  halfZ: 2,
};

const ORE_SPEC: ResourceNodeSpec = {
  kind: "ore_vein",
  material: "silver-ore",
  tier: 2,
  skill: "Mining",
  stock: 2,
  regrowHours: 0,
  halfX: 1.5,
  halfZ: 1.5,
};

function makeCivicRules(): CivicRules {
  const rules = structuredClone(DEFAULT_CIVIC_RULES);
  rules.surveying.minActivePerRegion = 1;
  rules.surveying.cooldownMs = 0;
  rules.veins = [
    {
      id: "redwater-iron",
      material: "iron",
      stock: 2,
      isBaseline: true,
      respawnDelayMs: 6000,
      traitPool: ["high-carbon", "cold-forged"],
      spawnAnchors: [
        { x: 40, z: 0 },
        { x: 80, z: 20 },
      ],
    },
  ];
  return rules;
}

function makeAvatar(sim: SimWorld, x: number, z: number): number {
  const e = sim.spawn();
  for (const c of [Transform, Velocity, PlayerIntent, Health, CharacterRef]) {
    addComponent(sim.ecs, c, e);
  }
  Transform.px[e] = x;
  Transform.py[e] = 0;
  Transform.pz[e] = z;
  Transform.qw[e] = 1;
  Transform.sx[e] = Transform.sy[e] = Transform.sz[e] = 1;
  Health.current[e] = Health.max[e] = 100;
  return e;
}

function makeCivicPlayer(
  charId: number,
  name: string,
  eid: number,
): ExtensionPlayer & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    characterId: charId,
    username: name.toLowerCase(),
    name,
    sent,
    entity: () => eid,
    send: (m) => sent.push(m),
    refreshInventory: () => {},
  };
}

function spawnWorldCrate(sim: SimWorld, x: number, z: number): number {
  const built = buildSpawn(PROP_TABLE, "world:crate", x, 0, z, 0);
  if ("error" in built) throw new Error(built.error);
  return spawnScatterEntity(sim, built);
}

describe("Track P3: Engine Respawn Systems on Shared SpawnPoolSoA", () => {
  it("instantiates all 5 respawn kinds in one shared SAB pool and drives full lifecycles", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const clock = { t: 1_000_000 };

    // 1. Pre-compile a single shared L2-resident SAB pool containing all 5 respawn kinds
    const pool = SpawnPoolSoA.create({ capacity: 128 });
    const kindByHash = new Map<number, string>([[fnv1a32("goblin") >>> 0, "goblin"]]);

    const creatureHandle = pool.allocateSlot({
      key: "creature/goblin-0",
      kind: RespawnKind.Creature,
      state: SlotState.Active,
      archetypeId: "goblin",
      modelId: "goblin",
      homeX: 25,
      homeY: 0,
      homeZ: -12,
      footprintRadiusM: 0.6,
      respawnDelayMs: 2000,
    });
    const treeHandle = pool.allocateSlot({
      key: "town/tree-0",
      kind: RespawnKind.ResourceNode,
      state: SlotState.Active,
      archetypeId: TREE_SPEC.kind,
      modelId: TREE_SPEC.material,
      stock: TREE_SPEC.stock,
      maxStock: TREE_SPEC.stock,
      homeX: 10,
      homeY: 0,
      homeZ: 10,
      footprintRadiusM: 2,
      respawnDelayMs: 5000,
    });
    const chestHandle = pool.allocateSlot({
      key: "town/chest-0",
      kind: RespawnKind.Chest,
      state: SlotState.Active,
      archetypeId: "chest-common",
      stock: 1,
      maxStock: 1,
      homeX: -10,
      homeY: 0,
      homeZ: 5,
      respawnDelayMs: 4000,
    });
    const propHandle = pool.allocateSlot({
      key: "town/crate-0",
      kind: RespawnKind.BreakableProp,
      state: SlotState.Active,
      modelId: "world:crate",
      stock: 1,
      maxStock: 1,
      homeX: 0,
      homeY: 0,
      homeZ: -20,
      footprintRadiusM: 0.5,
      respawnDelayMs: 3000,
    });
    const veinHandle = pool.allocateSlot({
      key: "redwater-iron-1",
      kind: RespawnKind.CivicVein,
      state: SlotState.Active,
      flags: PoolSlotFlags.Baseline | PoolSlotFlags.Persistent,
      archetypeId: "redwater-iron",
      modelId: "iron",
      stock: 2,
      maxStock: 2,
      anchorIndex: 0,
      homeX: 40,
      homeY: 0,
      homeZ: 0,
      respawnDelayMs: 6000,
    });

    for (const h of [creatureHandle, treeHandle, chestHandle, propHandle, veinHandle]) {
      assert.notEqual(h, INVALID_POOL_HANDLE);
    }

    // 2. Construct all 5 systems bound to the shared SAB pool
    const creatures = new CreatureSystem({
      creatures: GAME.rules.creatures.creatures,
      bases: GAME.rules.items.bases,
      pool,
      now: () => clock.t,
    });
    const death = new DeathSystem(
      GAME.hooks,
      30,
      () => 999,
      (s, e) => creatures.place(s, e),
      (e) => creatures.respawnSeconds(e),
      undefined,
      undefined,
      undefined,
      (e) => creatures.poolSlotOf(e),
      new DeathRespawnPool(pool, { slotOf: (e) => creatures.poolSlotOf(e), now: () => clock.t }),
    );

    const gatherStore = new SqliteGatheringStore(new Database(":memory:"));
    const gathering = new GatheringSystem({
      store: gatherStore,
      pool,
      now: () => clock.t,
      cooldownMs: 0,
    });

    const placesStore = new SqlitePlacesStore(new Database(":memory:"));
    const drops: string[] = [];
    const chests = new ChestSystem({
      drop: (_s, table) => (drops.push(table), 1),
      store: placesStore,
      pool,
      now: () => clock.t,
    });

    const breaks = new BreakSystem(breakDefsOf(PROP_TABLE), {
      store: placesStore,
      pool,
      now: () => clock.t,
    });

    const civicRules = makeCivicRules();
    const civicStore = new SqliteCivicStore(":memory:");
    const wallet = new WalletSystem();
    const civic = new CivicService({
      rules: civicRules,
      store: civicStore,
      respawnPool: pool,
      now: () => clock.t,
      sweepEveryTicks: 30,
      countMaterial: (cid, mat) => gathering.countOf(cid, mat),
      takeMaterial: (cid, mat, q) => gathering.take(cid, mat, q),
      grantMaterial: (cid, mat, q) => gathering.grant(cid, mat, q),
      hasMaterialRoom: (cid, mat, q) => gathering.hasRoom(cid, mat, q),
      balanceOf: (cid) => wallet.balanceOf(cid),
      spendGold: (cid, amt, tick) => wallet.spend(cid, amt, tick),
      grantGold: (cid, amt, tick) => wallet.grant(cid, amt, tick),
      hasBagRoom: () => true,
      craftAndGrantItem: () => null,
    });

    // 3. Instantiate entities from the shared SAB pool
    const scratchSlots = new Int32Array(128);
    const spawnedCreatures = creatures.instantiateFromPool(
      sim,
      pool,
      (h) => kindByHash.get(h),
      { scratchSlots },
    );
    assert.equal(spawnedCreatures.length, 1);
    const goblinEid = spawnedCreatures[0]!;
    assert.equal(creatures.poolSlotOf(goblinEid), creatureHandle);
    assert.equal(pool.liveEid[pool.slotIndexOf(creatureHandle)], goblinEid);
    assert.equal(Transform.px[goblinEid], 25);
    assert.equal(Transform.pz[goblinEid], -12);

    const treeEid = sim.spawn();
    addComponent(sim.ecs, Transform, treeEid);
    Transform.px[treeEid] = 10;
    Transform.pz[treeEid] = 10;
    gathering.register(treeEid, "town/tree-0", TREE_SPEC);
    assert.equal(gathering.poolSlotOf(treeEid), treeHandle);

    const chestEid = sim.spawn();
    addComponent(sim.ecs, Transform, chestEid);
    Transform.px[chestEid] = -10;
    Transform.pz[chestEid] = 5;
    chests.register(chestEid, "town/chest-0", { table: "chest-common", refillSeconds: 4 });
    assert.equal(chests.poolSlotOf(chestEid), chestHandle);

    const crateEid = spawnWorldCrate(sim, 0, -20);
    breaks.register(sim, crateEid, "town/crate-0", PROP_TABLE.archetypes["world:crate"]!.breakable!);
    assert.equal(breaks.poolSlotOf(crateEid), propHandle);

    assert.equal(civic.poolSlotOf("redwater-iron-1"), veinHandle);
    assert.equal(civicStore.getVein("redwater-iron-1")!.stock, 2);

    // Avatar used to interact with tree, chest, and civic vein
    const avatarEid = makeAvatar(sim, 10, 10);
    const player = makeCivicPlayer(7, "Prospector", avatarEid);
    civic.onEnter(player);

    // ---- Lifecycle A: Creature kill -> DeathSystem schedules in SAB -> respawns at SAB homeX/Z ----
    Transform.px[goblinEid] = 120;
    Transform.pz[goblinEid] = 85;
    Health.current[goblinEid] = 0;

    let tick = 1;
    sim.beginTick(tick);
    death.step(sim);
    sim.endTick();

    assert.equal(death.isDead(goblinEid), true);
    const deadEv = death.drainEvents();
    assert.equal(deadEv.length, 1);
    assert.equal(deadEv[0]!.state, "dead");
    const cIdx = pool.slotIndexOf(creatureHandle);
    assert.equal(pool.state[cIdx], SlotState.CooldownRespawn);
    assert.equal(pool.liveEid[cIdx], -1);
    assert.equal(pool.respawnAtMs[cIdx], clock.t + 2000);

    // Update SAB home coordinates to verify DeathSystem + CreatureSystem.place() respawn at SAB homeX/Z
    pool.setHome(creatureHandle, 32, 0, -18);

    clock.t += 1999;
    sim.beginTick(++tick);
    death.step(sim);
    sim.endTick();
    assert.equal(death.isDead(goblinEid), true, "still dead 1 ms early");

    clock.t += 1;
    sim.beginTick(++tick);
    death.step(sim);
    sim.endTick();

    assert.equal(death.isDead(goblinEid), false);
    assert.equal(death.drainEvents()[0]!.state, "alive");
    assert.equal(Transform.px[goblinEid], 32);
    assert.equal(Transform.pz[goblinEid], -18);
    assert.equal(Health.current[goblinEid], Health.max[goblinEid]);
    assert.equal(pool.state[cIdx], SlotState.Active);
    assert.equal(pool.liveEid[cIdx], goblinEid);

    // ---- Lifecycle B: Resource node gather -> deplete -> SAB regrowth -> store coherent ----
    Transform.px[avatarEid] = 10;
    Transform.pz[avatarEid] = 10;
    assert.equal(gathering.gather(sim, 7, avatarEid, treeEid).ok, true);
    const tIdx = pool.slotIndexOf(treeHandle);
    assert.equal(pool.stock[tIdx], 1);
    assert.equal(gathering.gather(sim, 7, avatarEid, treeEid).ok, true);
    assert.equal(pool.stock[tIdx], 0);
    assert.equal(pool.state[tIdx], SlotState.CooldownRespawn);
    assert.equal(gatherStore.loadNode("town/tree-0")!.stock, 0);

    clock.t += 4999;
    sim.currentTick = 30;
    gathering.step(sim, 1 / 30);
    assert.equal(gathering.views(sim).find((v) => v.material === "yew-log")!.stock, 0);

    clock.t += 1;
    sim.currentTick = 60;
    gathering.drainChanges(sim);
    gathering.step(sim, 1 / 30);
    assert.equal(pool.state[tIdx], SlotState.Active);
    assert.equal(pool.stock[tIdx], 2);
    assert.equal(gathering.views(sim).find((v) => v.material === "yew-log")!.stock, 2);
    assert.equal(gatherStore.loadNode("town/tree-0")!.stock, 2);
    assert.equal(gatherStore.loadNode("town/tree-0")!.regrowAt, null);
    assert.equal(gathering.drainChanges(sim).length, 1);

    // ---- Lifecycle C: Chest open -> SAB refill timer -> PlacesStore coherent ----
    Transform.px[avatarEid] = -10;
    Transform.pz[avatarEid] = 5;
    assert.deepEqual(chests.open(sim, 7, avatarEid, chestEid), { ok: true, items: 1 });
    assert.deepEqual(drops, ["chest-common"]);
    const chIdx = pool.slotIndexOf(chestHandle);
    assert.equal(pool.state[chIdx], SlotState.CooldownRespawn);
    assert.equal(placesStore.load("chest", "town/chest-0")!.state, "open");

    clock.t += 3999;
    chests.step();
    assert.equal(chests.isOpen(chestEid), true);

    clock.t += 1;
    chests.step();
    assert.equal(chests.isOpen(chestEid), false);
    assert.equal(pool.state[chIdx], SlotState.Active);
    assert.equal(placesStore.load("chest", "town/chest-0"), undefined);

    // ---- Lifecycle D: Timed breakable prop -> break -> SAB respawn -> PlacesStore coherent ----
    Health.current[crateEid] = 0;
    breaks.step(sim);
    assert.equal(entityExists(sim.ecs, crateEid), false);
    const pIdx = pool.slotIndexOf(propHandle);
    assert.equal(pool.state[pIdx], SlotState.CooldownRespawn);
    assert.equal(placesStore.load("break", "town/crate-0")!.state, "broken");

    clock.t += 2999;
    breaks.step(sim);
    assert.equal(defineQuery([Breakable])(sim.ecs).length, 0);

    clock.t += 1;
    breaks.step(sim);
    const respawnedProps = defineQuery([Breakable])(sim.ecs);
    assert.equal(respawnedProps.length, 1);
    const newCrateEid = respawnedProps[0]!;
    assert.equal(pool.state[pIdx], SlotState.Active);
    assert.equal(pool.liveEid[pIdx], newCrateEid);
    assert.equal(breaks.poolSlotOf(newCrateEid), propHandle);
    assert.equal(placesStore.load("break", "town/crate-0"), undefined);

    // ---- Lifecycle E: Civic vein extract to 0 -> SAB schedules & 1 Hz step rotates anchor/trait ----
    Transform.px[avatarEid] = 40;
    Transform.pz[avatarEid] = 0;
    civic.onMessage(player, { kind: "civic", op: "extract", veinBatchId: "redwater-iron-1", qty: 2 });
    const vIdx = pool.slotIndexOf(veinHandle);
    assert.equal(pool.stock[vIdx], 0);
    assert.equal(pool.state[vIdx], SlotState.CooldownRespawn);

    // Advance past 6000 ms and run 1 Hz sweep (tick % 30 === 0)
    clock.t += 6000;
    sim.beginTick(90);
    civic.step(sim, 1 / 30);
    sim.endTick();

    assert.equal(pool.isValidHandle(veinHandle), false, "old depleted vein slot freed after rotation");
    const activeVeins = civicStore.listVeins(false);
    const rotated = activeVeins.find((v) => v.veinBatchId !== "redwater-iron-1");
    assert.ok(rotated, "rotated vein spawned");
    assert.equal(rotated!.anchorIndex, 1);
    assert.equal(rotated!.x, 80);
    assert.equal(rotated!.z, 20);
    assert.equal(rotated!.traitId, "cold-forged");
    const rotatedHandle = civic.poolSlotOf(rotated!.veinBatchId);
    assert.notEqual(rotatedHandle, INVALID_POOL_HANDLE);
    assert.equal(pool.state[pool.slotIndexOf(rotatedHandle)], SlotState.Active);
    assert.equal(pool.stock[pool.slotIndexOf(rotatedHandle)], 2);
  });

  it("saves encodeBinary while all 5 systems are cooling down and resumes timers cleanly in a fresh SpawnPoolSoA", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim1 = new SimWorld();
    const clock = { t: 5_000_000 };
    const pool1 = SpawnPoolSoA.create({ capacity: 64 });
    const kindByHash = new Map<number, string>([[fnv1a32("goblin") >>> 0, "goblin"]]);

    const cHandle = pool1.allocateSlot({
      key: "creature/g1",
      kind: RespawnKind.Creature,
      archetypeId: "goblin",
      modelId: "goblin",
      homeX: 15,
      homeY: 0,
      homeZ: -8,
      respawnDelayMs: 2000,
    });
    pool1.allocateSlot({
      key: "node/yew-1",
      kind: RespawnKind.ResourceNode,
      archetypeId: TREE_SPEC.kind,
      modelId: TREE_SPEC.material,
      stock: 1,
      maxStock: 1,
      homeX: 5,
      homeZ: 5,
      respawnDelayMs: 5000,
    });
    pool1.allocateSlot({
      key: "chest/c1",
      kind: RespawnKind.Chest,
      archetypeId: "chest-common",
      stock: 1,
      maxStock: 1,
      homeX: 0,
      homeZ: 5,
      respawnDelayMs: 4000,
    });
    pool1.allocateSlot({
      key: "prop/crate-1",
      kind: RespawnKind.BreakableProp,
      modelId: "world:crate",
      stock: 1,
      maxStock: 1,
      homeX: -5,
      homeZ: 5,
      respawnDelayMs: 3000,
    });
    pool1.allocateSlot({
      key: "redwater-iron-1",
      kind: RespawnKind.CivicVein,
      flags: PoolSlotFlags.Baseline | PoolSlotFlags.Persistent,
      archetypeId: "redwater-iron",
      modelId: "iron",
      stock: 1,
      maxStock: 1,
      anchorIndex: 0,
      homeX: 40,
      homeZ: 0,
      respawnDelayMs: 6000,
    });

    const creatures1 = new CreatureSystem({
      creatures: GAME.rules.creatures.creatures,
      bases: GAME.rules.items.bases,
      pool: pool1,
      now: () => clock.t,
    });
    const death1 = new DeathSystem(
      GAME.hooks,
      30,
      undefined,
      (s, e) => creatures1.place(s, e),
      (e) => creatures1.respawnSeconds(e),
      undefined,
      undefined,
      undefined,
      (e) => creatures1.poolSlotOf(e),
      new DeathRespawnPool(pool1, { slotOf: (e) => creatures1.poolSlotOf(e), now: () => clock.t }),
    );
    const gathering1 = new GatheringSystem({ pool: pool1, now: () => clock.t, cooldownMs: 0 });
    const chests1 = new ChestSystem({ drop: () => 1, pool: pool1, now: () => clock.t });
    const breaks1 = new BreakSystem(breakDefsOf(PROP_TABLE), { pool: pool1, now: () => clock.t });
    const civicRules = makeCivicRules();
    civicRules.surveying.minActivePerRegion = 0; // Ensure only rotated vein spawns on timer!
    civicRules.veins[0]!.stock = 1;
    const civic1 = new CivicService({
      rules: civicRules,
      store: new SqliteCivicStore(":memory:"),
      respawnPool: pool1,
      now: () => clock.t,
      sweepEveryTicks: 30,
      countMaterial: (cid, m) => gathering1.countOf(cid, m),
      takeMaterial: (cid, m, q) => gathering1.take(cid, m, q),
      grantMaterial: (cid, m, q) => gathering1.grant(cid, m, q),
      hasMaterialRoom: (cid, m, q) => gathering1.hasRoom(cid, m, q),
      balanceOf: () => 0,
      spendGold: () => false,
      grantGold: () => false,
      hasBagRoom: () => true,
      craftAndGrantItem: () => null,
    });

    const [goblin1] = creatures1.instantiateFromPool(sim1, pool1, (h) => kindByHash.get(h));
    const tree1 = sim1.spawn();
    addComponent(sim1.ecs, Transform, tree1);
    Transform.px[tree1] = 5;
    Transform.pz[tree1] = 5;
    gathering1.register(tree1, "node/yew-1", { ...TREE_SPEC, stock: 1 });

    const chest1 = sim1.spawn();
    addComponent(sim1.ecs, Transform, chest1);
    Transform.px[chest1] = 0;
    Transform.pz[chest1] = 5;
    chests1.register(chest1, "chest/c1", { table: "t", refillSeconds: 4 });

    const prop1 = spawnWorldCrate(sim1, -5, 5);
    breaks1.register(sim1, prop1, "prop/crate-1", PROP_TABLE.archetypes["world:crate"]!.breakable!);

    const avatar1 = makeAvatar(sim1, 5, 5);
    const p1 = makeCivicPlayer(1, "Miner", avatar1);
    civic1.onEnter(p1);

    // Put ALL 5 into CooldownRespawn at t = 5_000_000
    Health.current[goblin1!] = 0;
    sim1.beginTick(1);
    death1.step(sim1);
    sim1.endTick();

    assert.equal(gathering1.gather(sim1, 1, avatar1, tree1).ok, true);
    Transform.px[avatar1] = 0;
    assert.equal(chests1.open(sim1, 1, avatar1, chest1).ok, true);
    Health.current[prop1] = 0;
    breaks1.step(sim1);
    Transform.px[avatar1] = 40;
    Transform.pz[avatar1] = 0;
    civic1.onMessage(p1, { kind: "civic", op: "extract", veinBatchId: "redwater-iron-1", qty: 1 });

    // Save SAB state to binary, advance clock 1000 ms during downtime, reopen in fresh pool & systems
    const encoded = pool1.encodeBinary();
    clock.t += 1000; // now = 5_001_000 (remaining: creature 1s, prop 2s, chest 3s, node 4s, vein 5s)

    const pool2 = SpawnPoolSoA.decodeBinary(encoded);
    const sim2 = new SimWorld();

    const creatures2 = new CreatureSystem({
      creatures: GAME.rules.creatures.creatures,
      bases: GAME.rules.items.bases,
      pool: pool2,
      kindResolver: (h) => kindByHash.get(h),
      now: () => clock.t,
    });
    const gathering2 = new GatheringSystem({ pool: pool2, now: () => clock.t, cooldownMs: 0 });
    const chests2 = new ChestSystem({ drop: () => 1, pool: pool2, now: () => clock.t });
    const breaks2 = new BreakSystem(breakDefsOf(PROP_TABLE), { pool: pool2, now: () => clock.t });
    const civicStore2 = new SqliteCivicStore(":memory:");
    const civic2 = new CivicService({
      rules: civicRules,
      store: civicStore2,
      respawnPool: pool2,
      now: () => clock.t,
      sweepEveryTicks: 30,
      countMaterial: () => 0,
      takeMaterial: () => false,
      grantMaterial: () => false,
      hasMaterialRoom: () => false,
      balanceOf: () => 0,
      spendGold: () => false,
      grantGold: () => false,
      hasBagRoom: () => true,
      craftAndGrantItem: () => null,
    });

    // Instantiating active creatures must NOT spawn the cooling-down goblin early
    const spawnedOnBoot = creatures2.instantiateFromPool(sim2, pool2, (h) => kindByHash.get(h));
    assert.equal(spawnedOnBoot.length, 0);

    const tree2 = sim2.spawn();
    addComponent(sim2.ecs, Transform, tree2);
    Transform.px[tree2] = 5;
    Transform.pz[tree2] = 5;
    gathering2.register(tree2, "node/yew-1", { ...TREE_SPEC, stock: 1 });
    assert.equal(gathering2.views(sim2)[0]!.stock, 0, "still depleted after reopen");

    const chest2 = sim2.spawn();
    addComponent(sim2.ecs, Transform, chest2);
    Transform.px[chest2] = 0;
    Transform.pz[chest2] = 5;
    chests2.register(chest2, "chest/c1", { table: "t", refillSeconds: 4 });
    assert.equal(chests2.isOpen(chest2), true, "chest still open after reopen");

    const prop2 = spawnWorldCrate(sim2, -5, 5);
    breaks2.register(sim2, prop2, "prop/crate-1", PROP_TABLE.archetypes["world:crate"]!.breakable!);
    assert.equal(entityExists(sim2.ecs, prop2), false, "prop still broken after reopen");
    assert.equal(civicStore2.getVein("redwater-iron-1")!.stock, 0, "vein still depleted after reopen");

    const stepAll = (tickNum: number) => {
      sim2.beginTick(tickNum);
      creatures2.step(sim2);
      gathering2.step(sim2, 1 / 30);
      chests2.step();
      breaks2.step(sim2);
      civic2.step(sim2, 1 / 30);
      sim2.endTick();
    };

    // At +1s (total +2s from break): ONLY creature respawns at (15, -8)
    clock.t += 1000;
    stepAll(30);
    const liveGoblins = [...creatures2.entities()];
    assert.equal(liveGoblins.length, 1);
    assert.equal(Transform.px[liveGoblins[0]!], 15);
    assert.equal(Transform.pz[liveGoblins[0]!], -8);
    assert.equal(pool2.state[pool2.slotIndexOf(cHandle)], SlotState.Active);
    assert.equal(defineQuery([Breakable])(sim2.ecs).length, 0);
    assert.equal(chests2.isOpen(chest2), true);
    assert.equal(gathering2.views(sim2)[0]!.stock, 0);
    assert.equal(civicStore2.listVeins(false).length, 0);

    // At +2s (total +3s): breakable prop respawns
    clock.t += 1000;
    stepAll(60);
    assert.equal(defineQuery([Breakable])(sim2.ecs).length, 1);
    assert.equal(chests2.isOpen(chest2), true);

    // At +3s (total +4s): chest refills
    clock.t += 1000;
    stepAll(90);
    assert.equal(chests2.isOpen(chest2), false);
    assert.equal(gathering2.views(sim2)[0]!.stock, 0);

    // At +4s (total +5s): resource node regrows
    clock.t += 1000;
    stepAll(120);
    assert.equal(gathering2.views(sim2)[0]!.stock, 1);
    assert.equal(civicStore2.listVeins(false).length, 0);

    // At +5s (total +6s): civic vein rotates onto anchor 1
    clock.t += 1000;
    stepAll(150);
    const activeAfter = civicStore2.listVeins(false);
    assert.equal(activeAfter.length, 1);
    assert.equal(activeAfter[0]!.anchorIndex, 1);
    assert.equal(activeAfter[0]!.x, 80);
    assert.equal(activeAfter[0]!.z, 20);
  });

  it("handles mixed pool + non-pool entities, Infinity resident delays, permanent exhaustion, and ruin repairs cleanly", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const clock = { t: 2_000_000 };
    const pool = SpawnPoolSoA.create({ capacity: 32 });

    // Non-pool player + pool-backed creature + resident with Infinity delay
    const playerEid = makeAvatar(sim, 0, 0);
    const residentEid = makeAvatar(sim, 2, 0);
    const goblinHandle = pool.allocateSlot({
      key: "creature/g-tick",
      kind: RespawnKind.Creature,
      archetypeId: "goblin",
      homeX: 12,
      homeZ: 14,
      respawnDelayMs: 1000,
    });
    const creatures = new CreatureSystem({
      creatures: GAME.rules.creatures.creatures,
      bases: GAME.rules.items.bases,
    });
    const [goblinEid] = creatures.instantiateFromPool(
      sim,
      pool,
      (h) => (h === fnv1a32("goblin") >>> 0 ? "goblin" : undefined),
    );

    const playerPlaced: number[] = [];
    // Test tick-derived clock on DeathSystem (no `now` passed) + 10th param SpawnPoolSoA
    const death = new DeathSystem(
      GAME.hooks,
      30,
      undefined,
      (s, e) => {
        if (creatures.place(s, e)) return true;
        playerPlaced.push(e);
        return true;
      },
      (e) => (e === residentEid ? Number.POSITIVE_INFINITY : creatures.respawnSeconds(e)),
      undefined,
      undefined,
      undefined,
      (e) => creatures.poolSlotOf(e),
      pool,
    );

    Health.current[playerEid] = 0;
    Health.current[residentEid] = 0;
    Health.current[goblinEid!] = 0;

    sim.beginTick(1);
    death.step(sim);
    sim.endTick();

    assert.equal(death.isDead(playerEid), true);
    assert.equal(death.isDead(residentEid), true);
    assert.equal(death.isDead(goblinEid!), true);
    assert.equal(pool.state[pool.slotIndexOf(goblinHandle)], SlotState.CooldownRespawn);

    // Advance 30 ticks (1s at 30Hz): goblin respawns at (12, 14) via SAB pollReady
    for (let t = 2; t <= 31; t++) {
      sim.beginTick(t);
      death.step(sim);
      sim.endTick();
    }
    assert.equal(death.isDead(goblinEid!), false);
    assert.equal(Transform.px[goblinEid!], 12);
    assert.equal(Transform.pz[goblinEid!], 14);
    assert.equal(pool.state[pool.slotIndexOf(goblinHandle)], SlotState.Active);
    assert.equal(death.isDead(residentEid), true, "Infinity delay resident never crashes or respawns early");

    // Exhausted ore node (regrowHours = 0) never regrows
    const gathering = new GatheringSystem({ pool, now: () => clock.t, cooldownMs: 0 });
    const oreEid = sim.spawn();
    addComponent(sim.ecs, Transform, oreEid);
    Transform.px[oreEid] = 0;
    Transform.pz[oreEid] = 0;
    gathering.register(oreEid, "ore/silver-0", ORE_SPEC);
    const oreHandle = gathering.poolSlotOf(oreEid);
    assert.equal(gathering.gather(sim, 1, playerEid, oreEid).ok, true);
    assert.equal(gathering.gather(sim, 1, playerEid, oreEid).ok, true);
    assert.equal(pool.state[pool.slotIndexOf(oreHandle)], SlotState.Exhausted);
    clock.t += 999_999_999;
    sim.currentTick = 120;
    gathering.step(sim, 1 / 30);
    assert.equal(pool.state[pool.slotIndexOf(oreHandle)], SlotState.Exhausted);
    assert.equal(gathering.views(sim)[0]!.stock, 0);

    // Permanent ruin (variant, respawnS: null) goes Exhausted and returns to Active on repair()
    gathering.grant(1, "yew-log", 4);
    const breaks = new BreakSystem(breakDefsOf(PROP_TABLE), {
      pool,
      now: () => clock.t,
      materials: {
        count: (h, m) => gathering.countOf(h, m),
        spend: (h, m, n) => gathering.spend(h, m, n),
      },
    });
    const statueEid = sim.spawn();
    addComponent(sim.ecs, Transform, statueEid);
    addComponent(sim.ecs, AssetRef, statueEid);
    addComponent(sim.ecs, BodyConfig, statueEid);
    Transform.px[statueEid] = 1;
    Transform.pz[statueEid] = 0;
    Transform.qw[statueEid] = 1;
    AssetRef.assetHash[statueEid] = fnv1a32("world:statue") >>> 0;
    BodyConfig.halfX[statueEid] = 0.8;
    BodyConfig.halfY[statueEid] = 1.5;
    BodyConfig.halfZ[statueEid] = 0.8;
    breaks.register(sim, statueEid, "town/statue-0", PROP_TABLE.archetypes["world:statue"]!.breakable!);
    const statueHandle = breaks.poolSlotOf(statueEid);
    Health.current[statueEid] = 0;
    breaks.step(sim);
    assert.equal(pool.state[pool.slotIndexOf(statueHandle)], SlotState.Exhausted);
    assert.equal(hasComponent(sim.ecs, BodyConfig, statueEid), false);
    assert.deepEqual(breaks.repair(sim, 1, playerEid, statueEid), { ok: true });
    assert.equal(pool.state[pool.slotIndexOf(statueHandle)], SlotState.Active);
    assert.equal(pool.liveEid[pool.slotIndexOf(statueHandle)], statueEid);
  });

  it("keeps CivicService.access unchanged and executes zero-alloc steady-state step() polls across all systems", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const clock = { t: 10_000_000 };
    const pool = SpawnPoolSoA.create({ capacity: 128 });

    pool.allocateSlot({
      key: "c/0",
      kind: RespawnKind.Creature,
      archetypeId: "goblin",
      homeX: 5,
      homeZ: 5,
      respawnDelayMs: 60_000,
    });
    const creatures = new CreatureSystem({
      creatures: GAME.rules.creatures.creatures,
      bases: GAME.rules.items.bases,
      pool,
      now: () => clock.t,
    });
    const [goblin] = creatures.instantiateFromPool(
      sim,
      pool,
      (h) => (h === fnv1a32("goblin") >>> 0 ? "goblin" : undefined),
    );
    const death = new DeathSystem(
      GAME.hooks,
      30,
      undefined,
      (s, e) => creatures.place(s, e),
      (e) => creatures.respawnSeconds(e),
      undefined,
      undefined,
      undefined,
      (e) => creatures.poolSlotOf(e),
      new DeathRespawnPool(pool, { slotOf: (e) => creatures.poolSlotOf(e), now: () => clock.t }),
    );
    const gathering = new GatheringSystem({ pool, now: () => clock.t });
    const chests = new ChestSystem({ drop: () => 0, pool, now: () => clock.t });
    const breaks = new BreakSystem(breakDefsOf(PROP_TABLE), { pool, now: () => clock.t });
    const civic = new CivicService({
      rules: makeCivicRules(),
      store: new SqliteCivicStore(":memory:"),
      respawnPool: pool,
      now: () => clock.t,
      sweepEveryTicks: 30,
      countMaterial: () => 0,
      takeMaterial: () => false,
      grantMaterial: () => false,
      hasMaterialRoom: () => false,
      balanceOf: () => 0,
      spendGold: () => false,
      grantGold: () => false,
      hasBagRoom: () => true,
      craftAndGrantItem: () => null,
    });

    assert.deepEqual(civic.access, {
      system: "civic",
      reads: [
        { component: "Transform", fields: ["px", "pz"] },
        { component: "Health", fields: ["current"] },
      ],
      writes: [],
    });

    // Kill creature so DeathSystem exercises its dead-corpse path without allocating Set(ids)
    Health.current[goblin!] = 0;
    sim.beginTick(1);
    death.step(sim);
    sim.endTick();

    // Warm up V8 JIT across all 5 SAB poll paths (including 1 Hz gathering & civic paths)
    for (let t = 1; t <= 3000; t++) {
      sim.beginTick(t + 1);
      death.step(sim);
      gathering.step(sim, 1);
      chests.step();
      breaks.step(sim);
      civic.ensureActiveVeins(clock.t, true);
      sim.endTick();
    }

    // Then warm the exact loop that is measured below (dt 1/30, civic every
    // 30 ticks). Without it V8 compiles that path during the measured window
    // and keeps 20-50 KB of code and feedback metadata, which read as a leak
    // in about one run in six. Later windows of the same loop retain nothing.
    for (let t = 3001; t <= 13_000; t++) {
      sim.beginTick(t);
      death.step(sim);
      gathering.step(sim, 1 / 30);
      chests.step();
      breaks.step(sim);
      if (t % 30 === 0) civic.ensureActiveVeins(clock.t, true);
      sim.endTick();
    }

    const gc = (globalThis as { gc?: () => void }).gc;
    /** 10,000 idle ticks from `from`: heap allocated during them, and heap still held after two full collections. */
    const idleWindow = (from: number): { transient: number; retained: number } => {
      // Two full collections on each side: objects freed by the first are only
      // swept by the second.
      gc?.();
      gc?.();
      const before = process.memoryUsage().heapUsed;
      for (let t = from; t < from + 10_000; t++) {
        sim.beginTick(t);
        death.step(sim);
        gathering.step(sim, 1 / 30);
        chests.step();
        breaks.step(sim);
        if (t % 30 === 0) civic.ensureActiveVeins(clock.t, true);
        sim.endTick();
      }
      const raw = process.memoryUsage().heapUsed;
      gc?.();
      gc?.();
      return { transient: raw - before, retained: process.memoryUsage().heapUsed - before };
    };
    // Retention is judged on the second of two back-to-back windows. The first
    // window after the warm-up swings by +-50 KB on Node 24 (cleanup V8 defers
    // past a synchronous gc(), from the earlier tests in this file); every later
    // window is steady. A leak would show in both.
    const first = idleWindow(13_001);
    const steady = idleWindow(23_001);
    for (const w of [first, steady]) {
      assert.ok(
        w.transient <= 262_144,
        `10,000 idle ticks across all 5 SAB poll paths allocated too much transient heap: ${w.transient} bytes`,
      );
    }
    if (gc) {
      assert.ok(
        steady.retained <= 32_768,
        `10,000 idle ticks across all 5 SAB poll paths retained too much heap: ${steady.retained} bytes (first window ${first.retained})`,
      );
    }

    // Also confirm full CivicService.step() runs cleanly across idle ticks
    for (let t = 33_001; t <= 33_060; t++) {
      sim.beginTick(t);
      civic.step(sim, 1 / 30);
      sim.endTick();
    }
  });

  it("interoperates end-to-end with compileSpawnPool() across all 5 respawn kinds", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const clock = { t: 3_000_000 };
    const civicRules = makeCivicRules();
    civicRules.veins[0]!.spawnAnchors = [
      { x: 60, z: 0 },
      { x: 90, z: 0 },
    ];

    const compiled = compileSpawnPool({
      bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
      groundHeightAt: () => 0,
      spawnTable: PROP_TABLE,
      civicRules,
      creatureSpawns: [{ key: "lair/goblin-0", kind: "goblin", x: -30, z: 15, count: 1, respawnSeconds: 2 }],
      resources: [{ key: "compiled/tree-0", material: "yew-log", x: 10, z: 10, maxStock: 2, regrowHours: 5 / 3600 }],
      chests: [{ key: "compiled/chest-0", x: -10, z: -10, refillSeconds: 3 }],
      breakables: [{ key: "compiled/crate-0", archetypeId: "world:crate", x: 20, z: -20 }],
    });
    assert.equal(compiled.report.accepted, 6); // 2 civic anchors + 1 creature + 1 resource + 1 chest + 1 breakable

    const pool = compiled.pool;
    const creatures = new CreatureSystem({
      creatures: GAME.rules.creatures.creatures,
      bases: GAME.rules.items.bases,
      pool,
      now: () => clock.t,
    });
    const death = new DeathSystem(
      GAME.hooks,
      30,
      undefined,
      (s, e) => creatures.place(s, e),
      (e) => creatures.respawnSeconds(e),
      undefined,
      undefined,
      undefined,
      (e) => creatures.poolSlotOf(e),
      new DeathRespawnPool(pool, { slotOf: (e) => creatures.poolSlotOf(e), now: () => clock.t }),
    );
    const gathering = new GatheringSystem({ pool, now: () => clock.t, cooldownMs: 0 });
    const chests = new ChestSystem({ drop: () => 1, pool, now: () => clock.t });
    const breaks = new BreakSystem(breakDefsOf(PROP_TABLE), { pool, now: () => clock.t });
    const civicStore = new SqliteCivicStore(":memory:");
    const civic = new CivicService({
      rules: civicRules,
      store: civicStore,
      respawnPool: pool,
      now: () => clock.t,
      sweepEveryTicks: 30,
      countMaterial: () => 0,
      takeMaterial: () => false,
      grantMaterial: () => true,
      hasMaterialRoom: () => true,
      balanceOf: () => 0,
      spendGold: () => false,
      grantGold: () => false,
      hasBagRoom: () => true,
      craftAndGrantItem: () => null,
    });

    const [goblin] = creatures.instantiateFromPool(
      sim,
      pool,
      (h) => (h === fnv1a32("goblin") >>> 0 ? "goblin" : undefined),
    );
    assert.ok(goblin !== undefined);
    assert.equal(Transform.px[goblin], -30);
    assert.equal(Transform.pz[goblin], 15);

    const tree = sim.spawn();
    addComponent(sim.ecs, Transform, tree);
    Transform.px[tree] = 10;
    Transform.pz[tree] = 10;
    gathering.register(tree, "compiled/tree-0", TREE_SPEC);

    const chest = sim.spawn();
    addComponent(sim.ecs, Transform, chest);
    Transform.px[chest] = -10;
    Transform.pz[chest] = -10;
    chests.register(chest, "compiled/chest-0", { table: "t", refillSeconds: 3 });

    const crate = spawnWorldCrate(sim, 20, -20);
    breaks.register(sim, crate, "compiled/crate-0", PROP_TABLE.archetypes["world:crate"]!.breakable!);

    assert.ok(civicStore.getVein("civic:redwater-iron:0"), "civic vein seeded from compiled pool");

    // Trigger depletion/death across all 5 and advance past all timers
    const avatar = makeAvatar(sim, 60, 0);
    const player = makeCivicPlayer(5, "Surveyor", avatar);
    civic.onEnter(player);
    civic.onMessage(player, { kind: "civic", op: "extract", veinBatchId: "civic:redwater-iron:0", qty: 2 });

    Health.current[goblin] = 0;
    sim.beginTick(1);
    death.step(sim);
    sim.endTick();

    Transform.px[avatar] = 10;
    Transform.pz[avatar] = 10;
    assert.equal(gathering.gather(sim, 5, avatar, tree).ok, true);
    assert.equal(gathering.gather(sim, 5, avatar, tree).ok, true);

    Transform.px[avatar] = -10;
    Transform.pz[avatar] = -10;
    assert.equal(chests.open(sim, 5, avatar, chest).ok, true);

    Health.current[crate] = 0;
    breaks.step(sim);

    clock.t += 6500;
    sim.beginTick(210);
    death.step(sim);
    gathering.step(sim, 1 / 30);
    chests.step();
    breaks.step(sim);
    civic.step(sim, 1 / 30);
    sim.endTick();

    assert.equal(death.isDead(goblin), false);
    assert.equal(gathering.views(sim)[0]!.stock, 2);
    assert.equal(chests.isOpen(chest), false);
    assert.equal(defineQuery([Breakable])(sim.ecs).length, 1);
    assert.ok(civicStore.listVeins(false).some((v) => v.veinBatchId.startsWith("redwater-iron-")));
  });

  it("emits dead LifeEvent + onDeath when CreatureSystem.step runs before DeathSystem.step and restores BreakSystem key on !p reopen", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const clock = { t: 4_000_000 };
    const pool = SpawnPoolSoA.create({ capacity: 16 });
    const kindByHash = new Map<number, string>([[fnv1a32("goblin") >>> 0, "goblin"]]);

    const cHandle = pool.allocateSlot({
      key: "creature/order-test",
      kind: RespawnKind.Creature,
      archetypeId: "goblin",
      homeX: 10,
      homeZ: 12,
      respawnDelayMs: 2000,
    });
    const creatures = new CreatureSystem({
      creatures: GAME.rules.creatures.creatures,
      bases: GAME.rules.items.bases,
      pool,
      now: () => clock.t,
    });
    const onDeathHits: Array<{ target: number; state: string }> = [];
    const death = new DeathSystem(
      GAME.hooks,
      30,
      () => 777,
      (s, e) => creatures.place(s, e),
      (e) => creatures.respawnSeconds(e),
      (_s, ev) => onDeathHits.push({ target: ev.target, state: ev.state }),
      undefined,
      undefined,
      (e) => creatures.poolSlotOf(e),
      new DeathRespawnPool(pool, { slotOf: (e) => creatures.poolSlotOf(e), now: () => clock.t }),
    );

    const [goblin] = creatures.instantiateFromPool(sim, pool, (h) => kindByHash.get(h));
    assert.ok(goblin !== undefined);

    // Kill creature, then run CreatureSystem.step() BEFORE DeathSystem.step() (server tick order)
    Health.current[goblin] = 0;
    sim.beginTick(1);
    creatures.step(sim);
    assert.equal(pool.state[pool.slotIndexOf(cHandle)], SlotState.CooldownRespawn);
    death.step(sim);
    sim.endTick();

    assert.equal(death.isDead(goblin), true);
    assert.equal(onDeathHits.length, 1, "onDeath fires even when CreatureSystem scheduled CooldownRespawn first");
    const evs1 = death.drainEvents();
    assert.equal(evs1.length, 1);
    assert.equal(evs1[0]!.state, "dead");
    assert.equal(evs1[0]!.target, goblin);
    assert.equal(evs1[0]!.killer, 777);

    // Advance past delay and confirm alive event fires on respawn
    clock.t += 2000;
    sim.beginTick(61);
    creatures.step(sim);
    death.step(sim);
    sim.endTick();
    assert.equal(death.isDead(goblin), false);
    const evs2 = death.drainEvents();
    assert.equal(evs2.length, 1);
    assert.equal(evs2[0]!.state, "alive");
    assert.equal(evs2[0]!.target, goblin);

    // Also test remSec <= 0 immediate respawn on adoption emits dead then alive + onDeath
    const goblin2Handle = pool.allocateSlot({
      key: "creature/order-immediate",
      kind: RespawnKind.Creature,
      archetypeId: "goblin",
      homeX: 20,
      homeZ: 22,
      respawnDelayMs: 500,
    });
    const [goblin2] = creatures.instantiateFromPool(sim, pool, (h) => kindByHash.get(h));
    assert.ok(goblin2 !== undefined);
    Health.current[goblin2] = 0;
    pool.scheduleRespawn(goblin2Handle, clock.t - 1000, 500); // already elapsed
    sim.beginTick(62);
    death.step(sim);
    sim.endTick();
    assert.equal(onDeathHits.length, 2);
    const immEvs = death.drainEvents();
    assert.deepEqual(
      immEvs.map((e) => e.state),
      ["dead", "alive"],
    );
    assert.equal(death.isDead(goblin2), false);

    // Test BreakSystem !p reopen path restores non-scatter key and clears PlacesStore
    const placesStore = new SqlitePlacesStore(new Database(":memory:"));
    const propPool = SpawnPoolSoA.create({ capacity: 8 });
    const propHandle = propPool.allocateSlot({
      key: "places/crate-reopen",
      kind: RespawnKind.BreakableProp,
      state: SlotState.CooldownRespawn,
      modelId: "world:crate",
      stock: 0,
      maxStock: 1,
      homeX: 5,
      homeY: 0,
      homeZ: 7,
      respawnDelayMs: 3000,
      respawnAtMs: clock.t + 1000,
    });
    placesStore.save({ kind: "break", key: "places/crate-reopen", state: "broken", at: clock.t - 2000, respawnAt: clock.t + 1000 });
    const breaks = new BreakSystem(breakDefsOf(PROP_TABLE), {
      store: placesStore,
      pool: propPool,
      now: () => clock.t,
    });

    clock.t += 1000;
    breaks.step(sim);
    const spawnedProps = defineQuery([Breakable])(sim.ecs);
    assert.equal(spawnedProps.length, 1);
    const respawnedEid = spawnedProps[0]!;
    assert.equal(placesStore.load("break", "places/crate-reopen"), undefined, "cleared PlacesStore on !p reopen");
    assert.equal(breaks.poolSlotOf(respawnedEid), propHandle);

    // Breaking it a second time preserves its key in PlacesStore & reuses the pool slot
    Health.current[respawnedEid] = 0;
    breaks.step(sim);
    const savedAgain = placesStore.load("break", "places/crate-reopen");
    assert.ok(savedAgain, "non-scatter key preserved for subsequent break");
    assert.equal(savedAgain!.state, "broken");
    assert.equal(propPool.state[propPool.slotIndexOf(propHandle)], SlotState.CooldownRespawn);
  });
});
