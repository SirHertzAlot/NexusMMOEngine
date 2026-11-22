/**
 * Tests for Track P2: Constraint- & Model-Driven Spawn Pool Solver,
 * Atomic On-Disk Binary Persistence, and `bake-pools` Headless CLI.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreaturesSchema,
  DEFAULT_CIVIC_RULES,
  GatheringSchema,
} from "@mmo-engine/rules";
import { fnv1a32, parseSpawnTableJSON } from "@mmo-engine/scatter";
import {
  DEFAULT_L2_CACHE_BYTES,
  PoolSlotFlags,
  RespawnKind,
  SlotState,
} from "../../src/pools/spawn-pool-soa.js";
import {
  compileSpawnPool,
  DEFAULT_FOOTPRINT_RADIUS_M,
  MIN_RADIUS_M,
  resolveModelFootprintRadius,
} from "../../src/pools/spawn-pool-solver.js";
import {
  loadSpawnPoolFromDisk,
  saveSpawnPoolToDisk,
} from "../../src/pools/spawn-pool-io.js";
import {
  DEFAULT_POOL_FILENAME,
  runBakePoolsCli,
} from "../../src/pools/bake-pools.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-pool-solver-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const WORLD_1K = { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };

describe("Track P2: spawn-pool-solver", () => {
  it("extracts model radii from bounds + collision.fit, clamps <= 0 to MIN_RADIUS_M, and uses fallback", () => {
    const spawnTable = parseSpawnTableJSON({
      version: 1,
      archetypes: {
        oak: {
          asset: "tree-oak",
          category: "tree",
          collision: { shape: "box", fit: 0.4, motion: "static" },
          breakable: { health: 100, into: "remove", respawnS: 45 },
        },
        crate: {
          asset: "crate-01",
          category: "prop",
          collision: { shape: "sphere", fit: 0.5, motion: "static" },
          breakable: { health: 25, into: "remove", respawnS: 10 },
        },
      },
    });

    const modelBounds = new Map<string, { radius?: number; halfExtents?: [number, number, number] }>([
      ["tree-oak", { halfExtents: [5, 8, 3] }], // max(5, 3) * 0.4 = 2.0
      ["crate-01", { radius: 1.6 }], // 1.6 * 0.5 = 0.8
      ["zero-model", { radius: 0 }], // clamped -> MIN_RADIUS_M
      ["neg-model", { radius: -4 }], // clamped -> MIN_RADIUS_M
      ["zero-box", { halfExtents: [0, 3, 0] }], // clamped -> MIN_RADIUS_M
    ]);

    const res = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: (x, z) => x * 0.1 + z * 0.05,
      modelBounds,
      spawnTable,
      resources: [
        { key: "res-oak", material: "wood", modelId: "tree-oak", archetypeId: "oak", x: 10, z: 20, maxStock: 10, regrowHours: 1 },
        { key: "res-zero", material: "ore", modelId: "zero-model", x: 30, z: 20, maxStock: 5, regrowHours: 1 },
        { key: "res-neg", material: "ore", modelId: "neg-model", x: 50, z: 20, maxStock: 5, regrowHours: 1 },
        { key: "res-zero-box", material: "ore", modelId: "zero-box", x: 70, z: 20, maxStock: 5, regrowHours: 1 },
        { key: "res-unknown", material: "herb", modelId: "unlisted-herb", x: 90, z: 20, maxStock: 3, regrowHours: 0.5 },
      ],
      breakables: [
        { key: "brk-crate", archetypeId: "crate", x: -20, z: 40 },
      ],
    });

    assert.equal(res.report.accepted, 6);
    assert.equal(res.report.rejected, 0);
    // 5 candidates resolved from modelBounds; "res-unknown" fell back to default radius
    assert.equal(res.report.modelRadiiResolved, 5);

    const oakSlot = res.pool.slotIndexOf(res.pool.findByKey("res-oak"));
    const crateSlot = res.pool.slotIndexOf(res.pool.findByKey("brk-crate"));
    const zeroSlot = res.pool.slotIndexOf(res.pool.findByKey("res-zero"));
    const negSlot = res.pool.slotIndexOf(res.pool.findByKey("res-neg"));
    const zeroBoxSlot = res.pool.slotIndexOf(res.pool.findByKey("res-zero-box"));
    const unknownSlot = res.pool.slotIndexOf(res.pool.findByKey("res-unknown"));

    assert.ok(Math.abs(res.pool.footprintRadiusM[oakSlot]! - 2.0) < 1e-5);
    assert.ok(Math.abs(res.pool.footprintRadiusM[crateSlot]! - 0.8) < 1e-5);
    assert.ok(Math.abs(res.pool.footprintRadiusM[zeroSlot]! - MIN_RADIUS_M) < 1e-5);
    assert.ok(Math.abs(res.pool.footprintRadiusM[negSlot]! - MIN_RADIUS_M) < 1e-5);
    assert.ok(Math.abs(res.pool.footprintRadiusM[zeroBoxSlot]! - MIN_RADIUS_M) < 1e-5);
    assert.ok(Math.abs(res.pool.footprintRadiusM[unknownSlot]! - DEFAULT_FOOTPRINT_RADIUS_M) < 1e-5);

    // Ground height y = 10*0.1 + 20*0.05 = 2.0
    assert.ok(Math.abs(res.pool.homeY[oakSlot]! - 2.0) < 1e-4);
    assert.equal(res.pool.respawnDelayMs[crateSlot], 10_000);

    // Direct helper check for catalogBounds / pcgBounds tuple format [sizeX, sizeY, sizeZ]
    const fromTuple = resolveModelFootprintRadius({
      modelIds: ["pine"],
      modelBounds: (id) => (id === "pine" ? [6, 12, 4] : undefined),
      archetype: spawnTable.archetypes.oak, // fit = 0.4 -> (6/2)*0.4 = 1.2
    });
    assert.equal(fromTuple.resolved, true);
    assert.ok(Math.abs(fromTuple.radiusM - 1.2) < 1e-6);
  });

  it("rejects spatial model overlaps (dist < rA + rB + clearance) and static obstacles", () => {
    const modelBounds = new Map<string, { radius?: number }>([
      ["boulder", { radius: 2.0 }],
      ["shrine-chest", { radius: 1.5 }],
    ]);

    const res = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: () => 0,
      modelBounds,
      defaultClearanceM: 0.5,
      staticObstacles: [
        { x: 100, z: 0, radiusM: 3.0, label: "pillar" }, // min dist to boulder(2.0) = 2 + 3 + 0.5 = 5.5
      ],
      resources: [
        { key: "boulder-a", material: "stone", modelId: "boulder", x: 0, z: 0, maxStock: 10, regrowHours: 1 },
        // dist = 3.9 < 2.0 + 1.5 + 0.5 = 4.0 -> overlap!
        { key: "chest-too-close", material: "stone", modelId: "boulder", x: 3.9, z: 0, maxStock: 10, regrowHours: 1 },
        // dist to boulder-a = 4.6 >= 2.0 + 2.0 + 0.5 = 4.5 -> accepted!
        { key: "boulder-ok", material: "stone", modelId: "boulder", x: 4.6, z: 0, maxStock: 10, regrowHours: 1 },
        // dist to static pillar at (100, 0) is 5.4 < 2.0 + 3.0 + 0.5 = 5.5 -> overlap!
        { key: "near-pillar-fail", material: "stone", modelId: "boulder", x: 105.4, z: 0, maxStock: 10, regrowHours: 1 },
        // dist to static pillar at (100, 0) is 5.6 >= 5.5 -> accepted!
        { key: "near-pillar-ok", material: "stone", modelId: "boulder", x: 105.6, z: 0, maxStock: 10, regrowHours: 1 },
      ],
      chests: [
        // dist to boulder-a (0,0) = 3.95 < 1.5 + 2.0 + 0.5 = 4.0 -> overlap!
        { key: "chest-overlap", modelId: "shrine-chest", x: 0, z: 3.95, refillSeconds: 120 },
        // dist to boulder-a = 4.1 >= 4.0 -> accepted!
        { key: "chest-clear", modelId: "shrine-chest", x: 0, z: 4.1, refillSeconds: 120 },
      ],
    });

    assert.equal(res.report.accepted, 4);
    assert.equal(res.report.rejected, 3);
    assert.equal(res.report.breakdown.modelOverlap, 3);
    assert.notEqual(res.pool.findByKey("boulder-a"), 0);
    assert.notEqual(res.pool.findByKey("boulder-ok"), 0);
    assert.notEqual(res.pool.findByKey("near-pillar-ok"), 0);
    assert.notEqual(res.pool.findByKey("chest-clear"), 0);
    assert.equal(res.pool.findByKey("chest-too-close"), 0);
    assert.equal(res.pool.findByKey("near-pillar-fail"), 0);
    assert.equal(res.pool.findByKey("chest-overlap"), 0);
  });

  it("rejects placements exceeding maxSlopeRad on a steep cliff function", () => {
    // Flat valley x < 18 (y=0), steep vertical cliff around x=20 (y jumps 0 -> 40), flat plateau x > 22 (y=40)
    const cliffHeight = (x: number, _z: number): number => (x >= 20 ? 40 : 0);

    const res = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: cliffHeight,
      maxSlopeRad: 0.5, // ~28.6 deg
      resources: [
        { key: "valley-node", material: "iron", x: 5, z: 0, maxStock: 5, regrowHours: 1 },
        { key: "cliff-edge-low", material: "iron", x: 19.5, z: 0, maxStock: 5, regrowHours: 1 },
        { key: "cliff-edge-high", material: "iron", x: 20.5, z: 0, maxStock: 5, regrowHours: 1 },
        { key: "plateau-node", material: "iron", x: 30, z: 0, maxStock: 5, regrowHours: 1 },
      ],
    });

    assert.equal(res.report.accepted, 2);
    assert.equal(res.report.rejected, 2);
    assert.equal(res.report.breakdown.slopeTooSteep, 2);
    assert.notEqual(res.pool.findByKey("valley-node"), 0);
    assert.notEqual(res.pool.findByKey("plateau-node"), 0);
    assert.equal(res.pool.findByKey("cliff-edge-low"), 0);
    assert.equal(res.pool.findByKey("cliff-edge-high"), 0);

    // Linear 45-deg ramp (tan(theta) = 1 -> theta = PI/4 ~= 0.785398)
    const rampRes = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: (x) => x,
      maxSlopeRad: 0.75,
      resources: [
        { key: "ramp-node", material: "wood", x: 10, z: 10, maxStock: 1, regrowHours: 1 },
      ],
    });
    assert.equal(rampRes.report.accepted, 0);
    assert.equal(rampRes.report.breakdown.slopeTooSteep, 1);
  });

  it("enforces aquatic (>= 0.4 m) vs dry-land (<= 0.1 m) habitat constraints", () => {
    const { creatures } = CreaturesSchema.parse({
      creatures: {
        shark: {
          name: "Shark",
          health: 120,
          aggroRadius: 15,
          leashRadius: 40,
          respawnSeconds: 90,
          pack: [1, 1],
          weapons: ["bite"],
          chaseSpeed: 0.9,
          attackEverySeconds: 1.4,
          behavior: {
            habitat: "water",
            depthM: [0.5, 20],
          },
        },
        goblin: {
          name: "Goblin",
          health: 60,
          aggroRadius: 12,
          leashRadius: 30,
          respawnSeconds: 60,
          pack: [1, 1],
          weapons: ["dagger"],
          chaseSpeed: 0.9,
          attackEverySeconds: 1.5,
        },
      },
    });

    // x < 0: dry land (depth 0), 0 <= x < 20: shallows (depth 0.25), x >= 20: deep sea (depth 2.0)
    const waterDepthAt = (x: number): number => {
      if (x < 0) return 0;
      if (x < 20) return 0.25;
      return 2.0;
    };

    const res = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: () => 0,
      waterDepthAt,
      creatures,
      creatureSpawns: [
        { key: "shark-land-fail", kind: "shark", x: -30, z: 0 },
        { key: "shark-shallow-fail", kind: "shark", x: 10, z: 0 },
        { key: "shark-sea-ok", kind: "shark", x: 40, z: 0 },
        { key: "goblin-land-ok", kind: "goblin", x: -50, z: 0 },
        { key: "goblin-shallow-fail", kind: "goblin", x: 15, z: 0 },
        { key: "goblin-sea-fail", kind: "goblin", x: 60, z: 0 },
      ],
      civicRules: {
        ...DEFAULT_CIVIC_RULES,
        veins: [
          {
            id: "submerged-vein",
            material: "iron",
            stock: 40,
            isBaseline: true,
            respawnDelayMs: 20_000,
            traitPool: ["bog-standard"],
            spawnAnchors: [
              { x: -80, z: 0 }, // dry land OK
              { x: 50, z: 20 }, // underwater 2.0m -> rejected
            ],
          },
        ],
      },
    });

    assert.equal(res.report.accepted, 3);
    assert.equal(res.report.rejected, 5);
    assert.equal(res.report.breakdown.waterHabitat, 5);

    const sharkSlot = res.pool.slotIndexOf(res.pool.findByKey("shark-sea-ok"));
    const goblinSlot = res.pool.slotIndexOf(res.pool.findByKey("goblin-land-ok"));
    assert.ok((res.pool.flags[sharkSlot]! & PoolSlotFlags.Aquatic) !== 0);
    assert.equal(res.pool.flags[goblinSlot]! & PoolSlotFlags.Aquatic, 0);
    assert.notEqual(res.pool.findByKey("civic:submerged-vein:0"), 0);
    assert.equal(res.pool.findByKey("civic:submerged-vein:1"), 0);
  });

  it("enforces exclusionZones & settlementExclusions, including full-map exclusion without infinite loop", () => {
    const partial = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: () => 0,
      exclusionZones: [{ x: 0, z: 0, radiusM: 25, label: "spawn-hub" }],
      settlementExclusions: [{ x: 200, z: 200, radiusM: 50 }],
      resources: [
        { key: "in-hub", material: "wood", x: 10, z: 10, maxStock: 5, regrowHours: 1 },
        { key: "in-town", material: "wood", x: 170, z: 200, maxStock: 5, regrowHours: 1 },
        { key: "wild-ok", material: "wood", x: -100, z: -100, maxStock: 5, regrowHours: 1 },
      ],
      chests: [
        { key: "chest-outside-town", x: 260, z: 200, refillSeconds: 300 },
      ],
    });

    assert.equal(partial.report.accepted, 2);
    assert.equal(partial.report.rejected, 2);
    assert.equal(partial.report.breakdown.exclusionZone, 2);

    // Extreme exclusion zone covering entire map
    const fullBlocked = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: () => 0,
      exclusionZones: [{ x: 0, z: 0, radiusM: 50_000, label: "global-lockout" }],
      civicRules: DEFAULT_CIVIC_RULES,
      resources: [
        { key: "r1", material: "wood", x: 10, z: 10, maxStock: 5, regrowHours: 1 },
        { key: "r2", material: "iron", x: 50, z: 50, maxStock: 5, regrowHours: 1 },
      ],
    });

    assert.equal(fullBlocked.report.accepted, 0);
    assert.equal(fullBlocked.pool.activeCount, 0);
    assert.equal(fullBlocked.report.rejected, fullBlocked.report.totalCandidates);
    assert.equal(fullBlocked.report.breakdown.exclusionZone, fullBlocked.report.totalCandidates);
    assert.ok(fullBlocked.pool.sab instanceof SharedArrayBuffer);
  });

  it("handles empty inputs, invalid/non-finite coords, out-of-bounds, and duplicateKey cleanly", () => {
    const empty = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: () => 0,
    });
    assert.equal(empty.report.totalCandidates, 0);
    assert.equal(empty.report.accepted, 0);
    assert.equal(empty.report.rejected, 0);
    assert.equal(empty.pool.activeCount, 0);
    assert.equal(empty.pool.encodeBinary().byteLength, 48);

    const mixed = compileSpawnPool({
      bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
      groundHeightAt: (x) => (x === 42 ? Number.NaN : 0),
      resources: [
        { key: "nan-x", material: "wood", x: Number.NaN, z: 0, maxStock: 5, regrowHours: 1 },
        { key: "inf-z", material: "wood", x: 0, z: Number.POSITIVE_INFINITY, maxStock: 5, regrowHours: 1 },
        { key: "oob", material: "wood", x: 150, z: 0, maxStock: 5, regrowHours: 1 },
        { key: "nan-ground", material: "wood", x: 42, z: 0, maxStock: 5, regrowHours: 1 },
        { key: "dup-key", material: "wood", x: 10, z: 10, maxStock: 5, regrowHours: 1 },
        { key: "dup-key", material: "wood", x: 10, z: 10, maxStock: 5, regrowHours: 1 },
      ],
    });

    assert.equal(mixed.report.accepted, 1);
    assert.equal(mixed.report.rejected, 5);
    assert.equal(mixed.report.breakdown.outOfBounds, 4);
    assert.equal(mixed.report.breakdown.duplicateKey, 1);
    assert.equal(mixed.report.breakdown.modelOverlap, 0);
  });

  it("enforces maxSlots and strict L2 cache maxMemoryBytes budget", () => {
    const candidates = Array.from({ length: 120 }, (_, i) => ({
      key: `node-${i.toString().padStart(3, "0")}`,
      material: "iron",
      x: (i % 20) * 10 - 100,
      z: Math.floor(i / 20) * 10 - 100,
      maxStock: 5,
      regrowHours: 1,
    }));

    // 1. Explicit maxSlots cap
    const cappedSlots = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: () => 0,
      resources: candidates,
      maxSlots: 12,
    });
    assert.equal(cappedSlots.report.accepted, 12);
    assert.equal(cappedSlots.report.breakdown.capacityCapped, 108);
    assert.equal(cappedSlots.pool.activeCount, 12);

    // 2. Tight memory ceiling (2 KiB)
    const tightMem = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: () => 0,
      resources: candidates,
      maxMemoryBytes: 2048,
    });
    assert.ok(tightMem.pool.byteLength <= 2048, `byteLength ${tightMem.pool.byteLength} <= 2048`);
    assert.equal(tightMem.report.sabBytes, tightMem.pool.byteLength);
    assert.ok(tightMem.report.utilizationPct <= 100);
    assert.ok(tightMem.report.accepted > 0 && tightMem.report.accepted < 120);
    assert.equal(tightMem.report.accepted + tightMem.report.breakdown.capacityCapped, 120);

    // 3. Default 2 MiB L2 budget enforced even with massive candidate set (30k slots with 24-byte keys > 2 MiB)
    const massive = Array.from({ length: 30_000 }, (_, i) => ({
      key: `massive-world-node-${i.toString().padStart(5, "0")}`,
      material: "wood",
      x: (i % 200) * 4 - 400,
      z: Math.floor(i / 200) * 4 - 400,
      maxStock: 2,
      regrowHours: 1,
    }));
    const l2Enforced = compileSpawnPool({
      bounds: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 },
      groundHeightAt: () => 0,
      resources: massive,
    });
    assert.ok(l2Enforced.pool.byteLength <= DEFAULT_L2_CACHE_BYTES);
    assert.ok(l2Enforced.report.breakdown.capacityCapped > 0);
    assert.equal(
      l2Enforced.report.accepted + l2Enforced.report.rejected,
      30_000,
    );
  });

  it("compiles multi-kind pools (civic veins, gathering regrowHours, creature packs, chests, breakables)", () => {
    const gatheringRules = GatheringSchema.parse({ regrowHourSeconds: 10 }); // sped-up regrow hour
    const { creatures } = CreaturesSchema.parse({
      creatures: {
        wolf: {
          name: "Wolf",
          health: 80,
          aggroRadius: 16,
          leashRadius: 35,
          respawnSeconds: 60,
          pack: [3, 3],
          weapons: ["bite"],
          chaseSpeed: 0.9,
          attackEverySeconds: 1.2,
        },
      },
    });

    const res = compileSpawnPool({
      bounds: WORLD_1K,
      groundHeightAt: () => 3.5,
      civicRules: DEFAULT_CIVIC_RULES,
      gatheringRules,
      creatures,
      creatureSpawns: [{ key: "wolf-pack-north", kind: "wolf", x: -200, z: -200 }],
      resources: [{ key: "ash-tree-1", material: "ash-log", x: 200, z: 200, maxStock: 40, regrowHours: 2 }],
      chests: [{ key: "crypt-chest-1", modelId: "chest-gold", x: -250, z: 250, refillSeconds: 180 }],
      breakables: [{ key: "barrel-1", modelId: "barrel", x: -260, z: 250, respawnSeconds: 25 }],
    });

    // DEFAULT_CIVIC_RULES has 7 vein anchors + 3 wolves + 1 resource + 1 chest + 1 breakable = 13
    assert.equal(res.report.accepted, 13);
    assert.equal(res.report.byKind.civicVein, 7);
    assert.equal(res.report.byKind.creature, 3);
    assert.equal(res.report.byKind.resourceNode, 1);
    assert.equal(res.report.byKind.chest, 1);
    assert.equal(res.report.byKind.breakableProp, 1);

    const veinSlot = res.pool.slotIndexOf(res.pool.findByKey("civic:oakhaven-surface:0"));
    assert.equal(res.pool.kind[veinSlot], RespawnKind.CivicVein);
    assert.equal(res.pool.state[veinSlot], SlotState.Active);
    assert.ok((res.pool.flags[veinSlot]! & PoolSlotFlags.Baseline) !== 0);
    assert.equal(res.pool.archetypeHash[veinSlot], fnv1a32("oakhaven-surface"));

    const ashSlot = res.pool.slotIndexOf(res.pool.findByKey("ash-tree-1"));
    assert.equal(res.pool.respawnDelayMs[ashSlot], 2 * 10 * 1000); // 2 regrowHours * 10s/hour
    assert.equal(res.pool.stock[ashSlot], 40);
    assert.equal(res.pool.maxStock[ashSlot], 40);

    const chestSlot = res.pool.slotIndexOf(res.pool.findByKey("crypt-chest-1"));
    assert.equal(res.pool.respawnDelayMs[chestSlot], 180_000);
    assert.equal(res.pool.modelHash[chestSlot], fnv1a32("chest-gold"));

    const brkSlot = res.pool.slotIndexOf(res.pool.findByKey("barrel-1"));
    assert.equal(res.pool.respawnDelayMs[brkSlot], 25_000);
  });
});

describe("Track P2: spawn-pool-io & bake-pools CLI", () => {
  it("atomically saves & reloads bit-equivalent SAB pools and leaves no temp files", () => {
    withTempDir((dir) => {
      const filePath = path.join(dir, "nested", "world-respawns.sab.bin");
      const compiled = compileSpawnPool({
        bounds: WORLD_1K,
        groundHeightAt: (x, z) => x * 0.25 - z * 0.125,
        civicRules: DEFAULT_CIVIC_RULES,
        resources: [
          { key: "oak-alpha", material: "ash-log", modelId: "oak", x: -150, z: 120, maxStock: 25, regrowHours: 2 },
        ],
        chests: [
          { key: "ruin-chest-1", modelId: "chest-iron", x: 160, z: -140, refillSeconds: 90 },
        ],
      });

      // Mutate one slot into CooldownRespawn so state & timers round-trip too
      const oakHandle = compiled.pool.findByKey("oak-alpha");
      assert.notEqual(oakHandle, 0);
      compiled.pool.scheduleRespawn(oakHandle, 1_700_000_000_000, 30_000);

      const save1 = saveSpawnPoolToDisk(filePath, compiled.pool);
      assert.ok(fs.existsSync(filePath));
      assert.equal(save1.activeCount, compiled.pool.activeCount);

      // Re-save atomically over the same file path
      const save2 = saveSpawnPoolToDisk(filePath, compiled.pool);
      assert.equal(save2.bytesWritten, save1.bytesWritten);
      const entries = fs.readdirSync(path.dirname(filePath));
      assert.deepEqual(entries, ["world-respawns.sab.bin"]);

      // Reload into SharedArrayBuffer-backed SpawnPoolSoA
      const reloaded = loadSpawnPoolFromDisk(filePath);
      assert.ok(reloaded.sab instanceof SharedArrayBuffer);
      assert.equal(reloaded.activeCount, compiled.pool.activeCount);
      assert.equal(reloaded.highWater, compiled.pool.highWater);
      assert.deepEqual(reloaded.encodeBinary(), compiled.pool.encodeBinary());

      const oakSlot = reloaded.slotIndexOf(reloaded.findByKey("oak-alpha"));
      assert.equal(reloaded.state[oakSlot], SlotState.CooldownRespawn);
      assert.equal(reloaded.respawnAtMs[oakSlot], 1_700_000_030_000);
      assert.ok(Math.abs(reloaded.homeX[oakSlot]! - -150) < 1e-4);
      assert.ok(Math.abs(reloaded.homeZ[oakSlot]! - 120) < 1e-4);
      assert.ok(Math.abs(reloaded.homeY[oakSlot]! - (-150 * 0.25 - 120 * 0.125)) < 1e-4);
    });
  });

  it("rejects corrupt, truncated, bad-magic, and missing binary pool files fail-closed", () => {
    withTempDir((dir) => {
      const compiled = compileSpawnPool({
        bounds: WORLD_1K,
        groundHeightAt: () => 0,
        resources: [{ key: "node-1", material: "iron", x: 10, z: 10, maxStock: 10, regrowHours: 1 }],
      });
      const validFile = path.join(dir, "valid.sab.bin");
      saveSpawnPoolToDisk(validFile, compiled.pool);
      const validBytes = fs.readFileSync(validFile);

      // 1. Corrupt payload byte -> CRC-32 checksum mismatch
      const flippedFile = path.join(dir, "flipped.sab.bin");
      const flipped = Buffer.from(validBytes);
      flipped[flipped.length - 1] ^= 0xff;
      fs.writeFileSync(flippedFile, flipped);
      assert.throws(() => loadSpawnPoolFromDisk(flippedFile), /checksum mismatch/i);

      // 2. Bad magic
      const badMagicFile = path.join(dir, "bad-magic.sab.bin");
      const badMagic = Buffer.from(validBytes);
      badMagic.write("NOPE", 0, "ascii");
      fs.writeFileSync(badMagicFile, badMagic);
      assert.throws(() => loadSpawnPoolFromDisk(badMagicFile), /bad magic/i);

      // 3. Truncated header
      const truncFile = path.join(dir, "trunc.sab.bin");
      fs.writeFileSync(truncFile, validBytes.subarray(0, 20));
      assert.throws(() => loadSpawnPoolFromDisk(truncFile), /truncated header/i);

      // 4. Empty pool file save + reload succeeds, while missing path throws ENOENT
      const emptyPool = compileSpawnPool({ bounds: WORLD_1K, groundHeightAt: () => 0 }).pool;
      const emptyFile = path.join(dir, "empty.sab.bin");
      saveSpawnPoolToDisk(emptyFile, emptyPool);
      const loadedEmpty = loadSpawnPoolFromDisk(emptyFile);
      assert.equal(loadedEmpty.activeCount, 0);

      assert.throws(() => loadSpawnPoolFromDisk(path.join(dir, "missing.sab.bin")), /ENOENT/);
    });
  });

  it("runs bake-pools CLI onto <dir>/world-respawns.sab.bin and logs concise ConstraintReport", () => {
    withTempDir((dir) => {
      const configPath = path.join(dir, "pool-config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          modelBounds: {
            "custom-oak": { halfExtents: [3, 6, 3] },
          },
          resources: [
            { key: "cli-oak-1", material: "ash-log", modelId: "custom-oak", x: -400, z: 300, maxStock: 30, regrowHours: 2 },
          ],
          chests: [
            { key: "cli-chest-1", modelId: "chest", x: 350, z: -250, refillSeconds: 120 },
          ],
        }),
      );

      let captured = "";
      const outDir = path.join(dir, "baked-out");
      const res = runBakePoolsCli(
        ["--out", outDir, "--config", configPath],
        (chunk) => {
          captured += chunk;
        },
      );

      const expectedFile = path.join(outDir, DEFAULT_POOL_FILENAME);
      assert.equal(res.outFile, path.resolve(expectedFile));
      assert.ok(fs.existsSync(expectedFile));
      assert.match(captured, /\[bake-pools\] wrote/);
      assert.match(captured, /accepted=9\/9/);
      assert.match(captured, /sabBytes=/);
      assert.match(captured, /utilizationPct=/);
      assert.match(captured, /modelRadiiResolved=/);

      const reloaded = loadSpawnPoolFromDisk(expectedFile);
      assert.equal(reloaded.activeCount, 9);
      assert.notEqual(reloaded.findByKey("cli-oak-1"), 0);
      assert.notEqual(reloaded.findByKey("cli-chest-1"), 0);
      assert.notEqual(reloaded.findByKey("civic:oakhaven-surface:0"), 0);

      // Also verify compiled CLI entrypoint when dist exists, or explicit file --out path
      const explicitOutFile = path.join(dir, "custom.sab.bin");
      let jsonOutput = "";
      runBakePoolsCli(
        ["--out", explicitOutFile, "--json"],
        (chunk) => {
          jsonOutput += chunk;
        },
      );
      const parsed = JSON.parse(jsonOutput) as { outFile: string; bytesWritten: number; report: { accepted: number } };
      assert.equal(parsed.outFile, path.resolve(explicitOutFile));
      assert.equal(parsed.report.accepted, 7);
      assert.ok(fs.existsSync(explicitOutFile));

      const compiledCli = fileURLToPath(new URL("../../src/pools/bake-pools.js", import.meta.url));
      assert.ok(fs.existsSync(compiledCli), `expected compiled CLI at ${compiledCli}`);
      const subOut = path.join(dir, "sub-cli-out");
      const stdout = execFileSync(process.execPath, [compiledCli, "--out", subOut], {
        encoding: "utf8",
      });
      assert.match(stdout, /\[bake-pools\] accepted=/);
      assert.ok(fs.existsSync(path.join(subOut, DEFAULT_POOL_FILENAME)));

      // Also verify --scene test-arena ingests chests and spawners cleanly
      const sceneOut = path.join(dir, "scene-out");
      const sceneRes = runBakePoolsCli(["--out", sceneOut, "--scene", "test-arena"], () => {});
      assert.ok(sceneRes.report.byKind.chest >= 3);
      assert.ok(sceneRes.report.byKind.creature >= 1);
      assert.ok(sceneRes.report.byKind.civicVein === 7);
    });
  });
});
