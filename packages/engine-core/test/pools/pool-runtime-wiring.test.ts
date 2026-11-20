/**
 * Wave 2 integration test: verifies runtime wiring of `SpawnPoolSoA` across
 * `modules/civic/server.js`, `modules/combat/server.js`, `modules/creatures/server.js`,
 * `assembleServerSystems`, disk persistence (`saveSpawnPoolToDisk`/`loadSpawnPoolFromDisk`),
 * and `server.ts` boot/checkpoint/shutdown pool wiring.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHooks, DEFAULT_CIVIC_RULES, loadRules } from "@mmo-engine/rules";
import { fnv1a32 } from "@mmo-engine/scatter";
import { Health, Transform } from "../../src/components.js";
import type { CreatureSystem } from "../../src/creatures.js";
import type { DeathSystem } from "../../src/death.js";
import type { CivicService } from "../../src/civic/civic-service.js";
import type { ItemService } from "../../src/items/item-service.js";
import { assembleServerSystems, type ServerModuleContext } from "../../src/modules.js";
import { TILE_CACHE_SETTINGS } from "../../src/navigation/chunk-baker.js";
import {
  DEFAULT_L2_CACHE_BYTES,
  DEFAULT_POOL_CAPACITY,
  INVALID_POOL_HANDLE,
  RespawnKind,
  SlotState,
  SpawnPoolSoA,
} from "../../src/pools/spawn-pool-soa.js";
import { compileSpawnPool } from "../../src/pools/spawn-pool-solver.js";
import {
  loadSpawnPoolFromDisk,
  saveSpawnPoolToDisk,
} from "../../src/pools/spawn-pool-io.js";
import { SimWorld } from "../../src/world.js";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const MODULES_DIR = path.join(REPO, "modules");

describe("Wave 2: pool-runtime-wiring across modules/* and server.ts", () => {
  it("assembles physics, combat, creatures, economy, items, civic on a shared SpawnPoolSoA", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-pool-wiring-"));
    try {
      const rules = loadRules(path.join(REPO, "content", "rules"));
      // Shorten goblin respawn for crisp tick-driven respawn test
      rules.creatures.creatures["goblin"] = {
        ...rules.creatures.creatures["goblin"]!,
        respawnSeconds: 1,
        pack: [1, 1],
      };

      const civicRules = structuredClone(DEFAULT_CIVIC_RULES);
      civicRules.surveying.minActivePerRegion = 1;
      civicRules.veins = [
        {
          id: "wiring-iron",
          material: "iron",
          stock: 25,
          isBaseline: true,
          respawnDelayMs: 5000,
          traitPool: ["high-carbon"],
          spawnAnchors: [
            { x: 60, z: -20 },
            { x: 90, z: -30 },
          ],
        },
      ];

      // Pre-compile a shared SpawnPoolSoA with 1 goblin + civic veins
      const { pool: respawnPool } = compileSpawnPool({
        bounds: { minX: -500, maxX: 500, minZ: -500, maxZ: 500 },
        groundHeightAt: () => 0,
        creatures: rules.creatures.creatures,
        creatureSpawns: [{ key: "wiring-goblin-0", kind: "goblin", x: 18, z: 12, count: 1, respawnSeconds: 1 }],
        civicRules,
      });

      const setFile = path.join(tmp, "modules.json");
      fs.writeFileSync(
        setFile,
        JSON.stringify({
          modules: ["physics", "combat", "creatures", "economy", "items", "civic"],
        }),
      );

      const sim = new SimWorld({ stats: rules.stats, movement: rules.movement });
      let creaturesRef: CreatureSystem | null = null;
      let itemsRef: ItemService | null = null;

      const ctx: ServerModuleContext = {
        sim,
        log: () => {},
        config: {
          physics: {
            chunkSize: 16,
            tileCacheSettings: TILE_CACHE_SETTINGS,
          },
          economy: {
            dataDir: tmp,
            itemsOf: () => {
              if (!itemsRef) throw new Error("items not ready");
              return itemsRef;
            },
          },
          items: {
            dataDir: tmp,
            rules,
            tickHz: 30,
            groundHeightAt: () => 0,
            rankOrder: ["poor", "common", "good", "fine", "masterwork"],
            ledger: { load: () => [], maxItemId: () => 0, append: () => {}, flush: () => {} },
            kindOf: (e: number) => creaturesRef?.kindOf(e),
          },
          creatures: {
            rules,
            botCount: 0,
            groundHeightAt: () => 0,
            respawnPool,
            kindResolver: (h: number) =>
              Object.keys(rules.creatures.creatures).find((k) => (fnv1a32(k) >>> 0) === (h >>> 0)),
          },
          combat: {
            rules,
            hooks: createHooks(rules),
            combatSkills: {
              get: () => 0,
              train: () => {},
              techniqueSkill: () => undefined,
              familiarity: () => 0,
              useFamily: () => {},
              knows: () => false,
            },
            getWeaponOf: (e: number) => creaturesRef?.weaponOf(e) ?? null,
            getWornFactor: () => 1,
            getCreaturesPlace: (s: SimWorld, e: number) => creaturesRef?.place(s, e) ?? false,
            getGateway: () => ({ respawnPlayer: () => false }),
            getRespawnSeconds: (e: number) => creaturesRef?.respawnSeconds(e),
            getDropper: () => undefined,
            getQuests: () => undefined,
            getKindOf: (e: number) => creaturesRef?.kindOf(e),
            respawnPool,
          },
          civic: {
            dataDir: tmp,
            rules: civicRules,
            respawnPool,
          },
        },
      };

      const assembled = await assembleServerSystems({
        modulesDir: MODULES_DIR,
        setFile,
        provided: { core: {} },
        ctx,
      });

      try {
        creaturesRef = assembled.byName["creatures"] as CreatureSystem;
        itemsRef = assembled.byName["items"] as ItemService;
        const death = assembled.byName["death"] as DeathSystem;
        const civic = assembled.extensions["civic"] as CivicService;

        assert.ok(creaturesRef, "creatures system assembled");
        assert.ok(death, "death system assembled");
        assert.ok(civic, "civic extension assembled");

        // 1. Verify CivicService seeded/mirrored veins into shared SAB pool
        const veinHandle = respawnPool.findByKey("civic:wiring-iron:0");
        assert.notEqual(veinHandle, INVALID_POOL_HANDLE);
        assert.equal(civic.poolSlotOf("civic:wiring-iron:0"), veinHandle);
        assert.equal(respawnPool.kind[respawnPool.slotIndexOf(veinHandle)], RespawnKind.CivicVein);

        // 2. Instantiate active creature slot from SAB pool via assembled CreatureSystem
        const spawned = creaturesRef.instantiateFromPool(
          sim,
          respawnPool,
          (h) => Object.keys(rules.creatures.creatures).find((k) => (fnv1a32(k) >>> 0) === (h >>> 0)),
        );
        assert.equal(spawned.length, 1);
        const goblinEid = spawned[0]!;
        const goblinHandle = creaturesRef.poolSlotOf(goblinEid);
        assert.notEqual(goblinHandle, INVALID_POOL_HANDLE);
        const goblinSlot = respawnPool.slotIndexOf(goblinHandle);
        assert.equal(respawnPool.liveEid[goblinSlot], goblinEid);
        assert.equal(respawnPool.state[goblinSlot], SlotState.Active);

        // 3. Kill goblin and verify DeathSystem schedules respawn in shared SAB pool
        sim.currentTick = 10;
        Transform.px[goblinEid] = 45;
        Transform.pz[goblinEid] = -15;
        Health.current[goblinEid] = 0;

        death.step(sim);
        assert.equal(death.isDead(goblinEid), true);
        assert.equal(respawnPool.state[goblinSlot], SlotState.CooldownRespawn);
        assert.equal(respawnPool.liveEid[goblinSlot], -1);
        assert.ok(Number.isFinite(respawnPool.respawnAtMs[goblinSlot]!));

        // 4. Advance ticks past 1 s (30 ticks) -> DeathSystem polls SAB pool & respawns at homeX/Z
        for (let t = 11; t <= 42; t++) {
          sim.currentTick = t;
          death.step(sim);
        }
        assert.equal(death.isDead(goblinEid), false);
        assert.equal(respawnPool.state[goblinSlot], SlotState.Active);
        assert.equal(respawnPool.liveEid[goblinSlot], goblinEid);
        assert.equal(Health.current[goblinEid], Health.max[goblinEid]);
        assert.ok(Math.abs(Transform.px[goblinEid]! - 18) < 1e-4);
        assert.ok(Math.abs(Transform.pz[goblinEid]! - 12) < 1e-4);

        // 5. Persist SAB pool to disk and reload bit-equivalently
        const diskPath = path.join(tmp, "pools", "world-respawns.sab.bin");
        saveSpawnPoolToDisk(diskPath, respawnPool);
        const reloaded = loadSpawnPoolFromDisk(diskPath);
        assert.ok(reloaded instanceof SpawnPoolSoA);
        assert.ok(reloaded.sab instanceof SharedArrayBuffer);
        assert.equal(reloaded.activeCount, respawnPool.activeCount);
        assert.deepEqual(reloaded.encodeBinary(), respawnPool.encodeBinary());
        assert.notEqual(reloaded.findByKey("wiring-goblin-0"), INVALID_POOL_HANDLE);
        assert.notEqual(reloaded.findByKey("civic:wiring-iron:0"), INVALID_POOL_HANDLE);
      } finally {
        await assembled.disposeModules();
      }
      assert.equal(ctx.stores?.civicStore, undefined);
      assert.equal(ctx.stores?.walletStore, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("expands tightly-baked compileSpawnPool binary to DEFAULT_POOL_CAPACITY within 2 MiB for runtime allocations", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-pool-expand-"));
    try {
      const { pool: baked, report } = compileSpawnPool({
        bounds: { minX: -500, maxX: 500, minZ: -500, maxZ: 500 },
        groundHeightAt: () => 0,
        civicRules: DEFAULT_CIVIC_RULES,
      });
      assert.equal(report.accepted, 7);
      assert.equal(baked.capacity, 7);
      assert.equal(baked.isFull, true);

      const diskPath = path.join(tmp, "world-respawns.sab.bin");
      saveSpawnPoolToDisk(diskPath, baked);

      // Replicate server.ts boot expansion path
      const loadedTight = loadSpawnPoolFromDisk(diskPath);
      assert.equal(loadedTight.capacity, 7);
      assert.equal(loadedTight.isFull, true);

      const expanded = SpawnPoolSoA.decodeBinary(loadedTight.encodeBinary(), {
        capacity: DEFAULT_POOL_CAPACITY,
        maxBudgetBytes: DEFAULT_L2_CACHE_BYTES,
      });
      assert.equal(expanded.capacity, DEFAULT_POOL_CAPACITY);
      assert.ok(expanded.byteLength <= DEFAULT_L2_CACHE_BYTES);
      assert.equal(expanded.activeCount, 7);
      assert.equal(expanded.isFull, false);
      assert.notEqual(expanded.findByKey("civic:oakhaven-surface:0"), INVALID_POOL_HANDLE);

      // Runtime allocations with longer keys + extra slots succeed cleanly
      const extraRes = expanded.allocateSlot({
        key: "settlement-0001/runtime-allocated-resource-node-with-longer-key-0001",
        kind: RespawnKind.ResourceNode,
        stock: 10,
        maxStock: 10,
        homeX: 120,
        homeZ: 80,
        respawnDelayMs: 60_000,
      });
      const extraChest = expanded.allocateSlot({
        key: "places/runtime-chest-with-extended-scene-node-identifier-0002",
        kind: RespawnKind.Chest,
        homeX: -40,
        homeZ: 90,
        respawnDelayMs: 120_000,
      });
      assert.notEqual(extraRes, INVALID_POOL_HANDLE);
      assert.notEqual(extraChest, INVALID_POOL_HANDLE);
      assert.equal(expanded.activeCount, 9);
      assert.ok(expanded.byteLength <= DEFAULT_L2_CACHE_BYTES);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("wires server.ts to load, expand, share, checkpoint, and shutdown-flush world-respawns.sab.bin", () => {
    const serverSrc = fs.readFileSync(path.join(REPO, "packages", "engine-core", "src", "server.ts"), "utf8");
    assert.match(serverSrc, /path\.join\(DATA_DIR,\s*"pools",\s*"world-respawns\.sab\.bin"\)/);
    assert.match(serverSrc, /loadSpawnPoolFromDisk\(respawnPoolPath\)/);
    assert.match(serverSrc, /DEFAULT_POOL_CAPACITY/);
    assert.match(serverSrc, /SpawnPoolSoA\.decodeBinary\(/);
    assert.match(serverSrc, /new SpawnPoolSoA\(\)/);
    assert.match(serverSrc, /pool:\s*respawnPool/);
    assert.match(serverSrc, /respawnPool,/);
    assert.match(serverSrc, /saveSpawnPoolToDisk\(respawnPoolPath,\s*respawnPool\)/);
  });
});
