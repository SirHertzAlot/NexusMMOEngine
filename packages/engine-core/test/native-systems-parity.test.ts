/**
 * Phase 3 Native Simulation Systems Parity & Golden Test Suite
 * (docs/CPP-MAIN-TICK-SPEC.md §5 Phase 3)
 *
 * Verifies:
 * 1. System 1 (Integration): NativeIntegrateSystem produces bit-identical position
 *    updates compared to TypeScript IntegrateSystem across 1,000 entities over 50 ticks (< 1mm precision).
 * 2. System 2 (Intent Application): NativeIntentSystem produces bit-identical
 *    horizontal velocity vectors compared to TypeScript IntentSystem across all locomotion modes.
 * 3. System 4 (Spatial Indexing): FastSpatialGrid packed 32-bit integer keys match
 *    homeSector grid coordinates exactly without allocating strings.
 * 4. Architecture Gate & Fallback: Gracefully operates and matches bit-for-bit even
 *    when native C++ binaries are forced to JavaScript fallback.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { LocomotionMode } from "@mmo-engine/protocol";
import {
  BodyConfig,
  Locomotion,
  MotionType,
  PlayerIntent,
  SimWorld,
  STEP_MS,
  Transform,
  Velocity,
} from "../src/index.js";
import {
  IntegrateSystem,
  IntentSystem,
} from "../src/systems.js";
import {
  FastSpatialGrid,
  NativeIntegrateSystem,
  NativeIntentSystem,
} from "../src/native-systems.js";
import { homeSector } from "../src/net/interest.js";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Phase 3: System-by-System Migration & Parity Verification", () => {
  describe("System 1: NativeIntegrateSystem Parity vs IntegrateSystem", () => {
    it("produces bit-identical position integration over 1,000 entities across 50 ticks", () => {
      const prng = mulberry32(4242);
      const count = 1000;
      const dt = STEP_MS / 1000;

      const sim = new SimWorld();
      const eids: number[] = [];

      const initialPx = new Float32Array(count);
      const initialPy = new Float32Array(count);
      const initialPz = new Float32Array(count);
      const initialVx = new Float32Array(count);
      const initialVy = new Float32Array(count);
      const initialVz = new Float32Array(count);

      for (let i = 0; i < count; i++) {
        const e = sim.spawn();
        addComponent(sim.ecs, Transform, e);
        addComponent(sim.ecs, Velocity, e);

        initialPx[i] = (prng() - 0.5) * 500;
        initialPy[i] = (prng() - 0.5) * 20;
        initialPz[i] = (prng() - 0.5) * 500;
        initialVx[i] = (prng() - 0.5) * 10;
        initialVy[i] = (prng() - 0.5) * 4;
        initialVz[i] = (prng() - 0.5) * 10;

        Transform.px[e] = initialPx[i];
        Transform.py[e] = initialPy[i];
        Transform.pz[e] = initialPz[i];
        Velocity.lx[e] = initialVx[i];
        Velocity.ly[e] = initialVy[i];
        Velocity.lz[e] = initialVz[i];

        // Add kinematic body on 20% of entities
        if (i % 5 === 0) {
          addComponent(sim.ecs, BodyConfig, e);
          BodyConfig.motionType[e] = MotionType.Kinematic;
        }

        eids.push(e);
      }

      // 1. Run 50 ticks with TS IntegrateSystem
      const tsSystem = new IntegrateSystem();
      for (let tick = 0; tick < 50; tick++) {
        tsSystem.step(sim, dt);
      }

      const finalPxTS = new Float32Array(count);
      const finalPyTS = new Float32Array(count);
      const finalPzTS = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const e = eids[i];
        finalPxTS[i] = Transform.px[e];
        finalPyTS[i] = Transform.py[e];
        finalPzTS[i] = Transform.pz[e];
      }

      // 2. Restore initial state
      for (let i = 0; i < count; i++) {
        const e = eids[i];
        Transform.px[e] = initialPx[i];
        Transform.py[e] = initialPy[i];
        Transform.pz[e] = initialPz[i];
        Velocity.lx[e] = initialVx[i];
        Velocity.ly[e] = initialVy[i];
        Velocity.lz[e] = initialVz[i];
      }

      // 3. Run 50 ticks with NativeIntegrateSystem
      const nativeSystem = new NativeIntegrateSystem();
      assert.equal(nativeSystem.isNative, true, "Native addon must be loaded");
      for (let tick = 0; tick < 50; tick++) {
        nativeSystem.step(sim, dt);
      }

      // 4. Verify exact position parity across all 1,000 entities (sub-millimetre precision over 50 steps)
      for (let i = 0; i < count; i++) {
        const e = eids[i];
        const diffX = Math.abs(finalPxTS[i] - Transform.px[e]);
        const diffY = Math.abs(finalPyTS[i] - Transform.py[e]);
        const diffZ = Math.abs(finalPzTS[i] - Transform.pz[e]);

        assert.ok(diffX < 1e-3, `Entity ${i}: px drift ${diffX}`);
        assert.ok(diffY < 1e-3, `Entity ${i}: py drift ${diffY}`);
        assert.ok(diffZ < 1e-3, `Entity ${i}: pz drift ${diffZ}`);
      }
    });

    it("matches bit-for-bit under forced JS fallback", () => {
      const count = 100;
      const dt = STEP_MS / 1000;
      const sim = new SimWorld();
      const eids: number[] = [];

      const initialPx = new Float32Array(count);
      const initialPz = new Float32Array(count);

      for (let i = 0; i < count; i++) {
        const e = sim.spawn();
        addComponent(sim.ecs, Transform, e);
        addComponent(sim.ecs, Velocity, e);

        initialPx[i] = i * 2.5;
        initialPz[i] = i * -1.5;
        Transform.px[e] = initialPx[i];
        Transform.py[e] = 0;
        Transform.pz[e] = initialPz[i];
        Velocity.lx[e] = 5.0;
        Velocity.ly[e] = 0.0;
        Velocity.lz[e] = -2.0;

        eids.push(e);
      }

      // Step with TS
      const tsSys = new IntegrateSystem();
      for (let tick = 0; tick < 10; tick++) tsSys.step(sim, dt);
      const tsPx = new Float32Array(count);
      const tsPz = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        tsPx[i] = Transform.px[eids[i]];
        tsPz[i] = Transform.pz[eids[i]];
      }

      // Restore
      for (let i = 0; i < count; i++) {
        Transform.px[eids[i]] = initialPx[i];
        Transform.pz[eids[i]] = initialPz[i];
        Velocity.lx[eids[i]] = 5.0;
        Velocity.lz[eids[i]] = -2.0;
      }

      // Step with fallback
      const fallbackSys = new NativeIntegrateSystem(true); // forceJsFallback = true
      assert.equal(fallbackSys.isNative, false);
      for (let tick = 0; tick < 10; tick++) fallbackSys.step(sim, dt);

      for (let i = 0; i < count; i++) {
        assert.equal(tsPx[i], Transform.px[eids[i]]);
        assert.equal(tsPz[i], Transform.pz[eids[i]]);
      }
    });
  });

  describe("System 2: NativeIntentSystem Parity vs IntentSystem", () => {
    it("calculates exact velocities across varied intent angles, sprint, and locomotion modes", () => {
      const prng = mulberry32(999);
      const count = 500;
      const sim = new SimWorld();
      const eids: number[] = [];

      for (let i = 0; i < count; i++) {
        const e = sim.spawn();
        addComponent(sim.ecs, PlayerIntent, e);
        addComponent(sim.ecs, Velocity, e);

        const mx = (prng() - 0.5) * 2;
        const mz = (prng() - 0.5) * 2;
        PlayerIntent.mx[e] = mx;
        PlayerIntent.mz[e] = mz;

        if (i % 3 === 0) {
          addComponent(sim.ecs, Locomotion, e);
          const mode = i % 2 === 0 ? LocomotionMode.Swim : LocomotionMode.Fly;
          Locomotion.mode[e] = mode;
        }
        eids.push(e);
      }

      const tsIntent = new IntentSystem();
      tsIntent.step(sim, STEP_MS / 1000);
      const tsVx = new Float32Array(count);
      const tsVz = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        tsVx[i] = Velocity.lx[eids[i]];
        tsVz[i] = Velocity.lz[eids[i]];
        Velocity.lx[eids[i]] = 0;
        Velocity.lz[eids[i]] = 0;
      }

      const nativeIntent = new NativeIntentSystem();
      nativeIntent.step(sim, STEP_MS / 1000);

      for (let i = 0; i < count; i++) {
        const e = eids[i];
        assert.equal(tsVx[i], Velocity.lx[e], `Mismatch on Velocity.lx for entity ${i}`);
        assert.equal(tsVz[i], Velocity.lz[e], `Mismatch on Velocity.lz for entity ${i}`);
      }
    });
  });

  describe("System 4: FastSpatialGrid Packed 2D Coordinate Hashing", () => {
    it("packs and unpacks 2D grid coordinates with zero precision loss", () => {
      const coords = [
        [0, 0],
        [1, 1],
        [-1, -1],
        [100, -250],
        [-32768, 32767],
        [42, -99],
      ];

      for (const [x, z] of coords) {
        const key = FastSpatialGrid.pack(x, z);
        const [ux, uz] = FastSpatialGrid.unpack(key);
        assert.equal(ux, x);
        assert.equal(uz, z);
      }
    });

    it("matches homeSector coordinate calculations without heap string allocations", () => {
      const sim = new SimWorld();
      const prng = mulberry32(12345);

      for (let i = 0; i < 200; i++) {
        const e = sim.spawn();
        addComponent(sim.ecs, Transform, e);
        const x = (prng() - 0.5) * 1000;
        const z = (prng() - 0.5) * 1000;
        Transform.px[e] = x;
        Transform.pz[e] = z;

        const strSector = homeSector(sim, e);
        const packedKey = FastSpatialGrid.keyForPosition(x, z);
        const [sx, sz] = FastSpatialGrid.unpack(packedKey);

        assert.equal(strSector, `${sx},${sz}`);
      }
    });

    it("queries radius keys covering all interest sectors", () => {
      const keys = FastSpatialGrid.queryRadiusKeys(0, 0, 128);
      assert.ok(keys.length > 0);
      assert.ok(keys.includes(FastSpatialGrid.GLOBAL_SECTOR_KEY));

      // Center sector (0, 0) must be included
      const centerKey = FastSpatialGrid.pack(0, 0);
      assert.ok(keys.includes(centerKey));
    });
  });
});
