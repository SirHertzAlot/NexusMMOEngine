#!/usr/bin/env node
/**
 * Phase 0 item 2: JS production tick re-baseline at 51k entities.
 * (docs/CPP-MAIN-TICK-SPEC.md §4, Phase 0 item 2)
 *
 * Measures the JS fallback kernel path through SimWorkerRuntime at
 * 51,000 entities (1,000 players + 50,000 NPCs), with intent pressure from
 * the 1,000 player clients every tick. Reports mean / p99 / max tick
 * duration and spiral-event count against the 33.33 ms frame budget.
 *
 * Run: node packages/engine-core/test/bench/js-tick-baseline.mjs
 */

import { performance } from "node:perf_hooks";
import {
  createSharedMemoryPlane,
  SOA_LAYOUT,
  INTENT_FLAGS,
} from "../../dist/src/sab-store.js";
import {
  SimWorkerRuntime,
  DT,
  FRAME_BUDGET_MS,
} from "../../dist/src/sim-worker.js";
import { packCommandToken } from "../../dist/src/lockless-ring.js";

const TOTAL_ENTITIES = 51000;
const PLAYER_COUNT = 1000;
const SOAK_TICKS = 200;
const WARMUP_TICKS = 20;

function makeJsKernel(fmv, intMatrix) {
  return {
    isNative: false,
    stepSimulation(fmv_, entityCount, dt) {
      const dtf = Math.fround(dt);
      for (let i = 0; i < entityCount; i++) {
        const b = i * SOA_LAYOUT.STRIDE;
        if (intMatrix[b + SOA_LAYOUT.HEALTH] <= 0) continue;
        fmv_[b + SOA_LAYOUT.POSITION_X] = Math.fround(fmv_[b + SOA_LAYOUT.POSITION_X] + fmv_[b + SOA_LAYOUT.VELOCITY_X] * dtf);
        fmv_[b + SOA_LAYOUT.POSITION_Y] = Math.fround(fmv_[b + SOA_LAYOUT.POSITION_Y] + fmv_[b + SOA_LAYOUT.VELOCITY_Y] * dtf);
        fmv_[b + SOA_LAYOUT.POSITION_Z] = Math.fround(fmv_[b + SOA_LAYOUT.POSITION_Z] + fmv_[b + SOA_LAYOUT.VELOCITY_Z] * dtf);
      }
    },
    stepSimulationSoA(px, py, pz, vx, vy, vz, hp, entityCount, dt) {
      const dtf = Math.fround(dt);
      for (let i = 0; i < entityCount; i++) {
        if (hp[i] <= 0) continue;
        px[i] = Math.fround(px[i] + vx[i] * dtf);
        py[i] = Math.fround(py[i] + vy[i] * dtf);
        pz[i] = Math.fround(pz[i] + vz[i] * dtf);
      }
    },
    applyIntentsAndStep(fmv_, entityCount, dt, baseSpeed) {
      const dtf = Math.fround(dt);
      const moveMask =
        INTENT_FLAGS.FORWARD | INTENT_FLAGS.BACKWARD | INTENT_FLAGS.LEFT |
        INTENT_FLAGS.RIGHT | INTENT_FLAGS.UP | INTENT_FLAGS.DOWN;
      for (let i = 0; i < entityCount; i++) {
        const b = i * SOA_LAYOUT.STRIDE;
        const intent = intMatrix[b + SOA_LAYOUT.INTENT_BIT];
        if (intent === 0) {
          fmv_[b + SOA_LAYOUT.POSITION_X] = Math.fround(fmv_[b + SOA_LAYOUT.POSITION_X] + fmv_[b + SOA_LAYOUT.VELOCITY_X] * dtf);
          fmv_[b + SOA_LAYOUT.POSITION_Y] = Math.fround(fmv_[b + SOA_LAYOUT.POSITION_Y] + fmv_[b + SOA_LAYOUT.VELOCITY_Y] * dtf);
          fmv_[b + SOA_LAYOUT.POSITION_Z] = Math.fround(fmv_[b + SOA_LAYOUT.POSITION_Z] + fmv_[b + SOA_LAYOUT.VELOCITY_Z] * dtf);
          continue;
        }
        if ((intent & moveMask) !== 0) {
          const speed = (intent & INTENT_FLAGS.SPRINT) !== 0 ? baseSpeed * 2.0 : baseSpeed;
          let vx = 0, vy = 0, vz = 0;
          if (intent & INTENT_FLAGS.RIGHT) vx += speed;
          if (intent & INTENT_FLAGS.LEFT) vx -= speed;
          if (intent & INTENT_FLAGS.UP) vy += speed;
          if (intent & INTENT_FLAGS.DOWN) vy -= speed;
          if (intent & INTENT_FLAGS.FORWARD) vz += speed;
          if (intent & INTENT_FLAGS.BACKWARD) vz -= speed;
          fmv_[b + SOA_LAYOUT.VELOCITY_X] = vx;
          fmv_[b + SOA_LAYOUT.VELOCITY_Y] = vy;
          fmv_[b + SOA_LAYOUT.VELOCITY_Z] = vz;
        } else {
          fmv_[b + SOA_LAYOUT.VELOCITY_X] = 0;
          fmv_[b + SOA_LAYOUT.VELOCITY_Y] = 0;
          fmv_[b + SOA_LAYOUT.VELOCITY_Z] = 0;
        }
        fmv_[b + SOA_LAYOUT.POSITION_X] = Math.fround(fmv_[b + SOA_LAYOUT.POSITION_X] + fmv_[b + SOA_LAYOUT.VELOCITY_X] * dtf);
        fmv_[b + SOA_LAYOUT.POSITION_Y] = Math.fround(fmv_[b + SOA_LAYOUT.POSITION_Y] + fmv_[b + SOA_LAYOUT.VELOCITY_Y] * dtf);
        fmv_[b + SOA_LAYOUT.POSITION_Z] = Math.fround(fmv_[b + SOA_LAYOUT.POSITION_Z] + fmv_[b + SOA_LAYOUT.VELOCITY_Z] * dtf);
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runJsTickBaseline() {
  console.log("========================================================================");
  console.log("   NEXUS MMO ENGINE — PHASE 0 JS TICK BASELINE (51k entities, JS fallback)");
  console.log("========================================================================\n");

  console.log("Kernel: JS fallback (pure TypeScript, no native addon)");

  const sab = createSharedMemoryPlane(TOTAL_ENTITIES, 64);
  const runtime = new SimWorkerRuntime({
    sharedMemory: sab,
    entityCapacity: TOTAL_ENTITIES,
    inputRingCapacity: 4096,
    mode: "matrix",
    decodeMovementIntents: true,
    kernel: null,
  });
  const fmv = runtime.views.floatMatrixView;
  const intMatrix = runtime.views.intMatrixView;
  runtime.kernel = makeJsKernel(fmv, intMatrix);

  for (let i = 0; i < TOTAL_ENTITIES; i++) {
    const b = i * SOA_LAYOUT.STRIDE;
    intMatrix[b + SOA_LAYOUT.HEALTH] = 100;
    fmv[b + SOA_LAYOUT.POSITION_X] = (i % 200) * 2.0;
    fmv[b + SOA_LAYOUT.POSITION_Y] = 0.0;
    fmv[b + SOA_LAYOUT.POSITION_Z] = Math.floor(i / 200) * 2.0;
    fmv[b + SOA_LAYOUT.VELOCITY_X] = 0;
    fmv[b + SOA_LAYOUT.VELOCITY_Y] = 0;
    fmv[b + SOA_LAYOUT.VELOCITY_Z] = 0;
  }

  console.log(
    `Entities: ${TOTAL_ENTITIES.toLocaleString()} (${PLAYER_COUNT} players + ${(TOTAL_ENTITIES - PLAYER_COUNT).toLocaleString()} NPCs)`,
  );
  console.log(`Frame budget: ${FRAME_BUDGET_MS.toFixed(2)} ms (30 Hz)`);
  console.log(`Ticks: ${SOAK_TICKS} measured after ${WARMUP_TICKS} warm-up\n`);

  for (let tick = 0; tick < WARMUP_TICKS; tick++) {
    for (let p = 0; p < PLAYER_COUNT; p++) {
      const actionCode = INTENT_FLAGS.FORWARD | ((tick + p) % 5 === 0 ? INTENT_FLAGS.SPRINT : 0);
      runtime.inputQueue.enqueue(packCommandToken(p, actionCode));
    }
    runtime.tick(DT);
  }

  const times = [];
  for (let tick = 0; tick < SOAK_TICKS; tick++) {
    for (let p = 0; p < PLAYER_COUNT; p++) {
      const actionCode = INTENT_FLAGS.FORWARD |
        ((tick + p) % 5 === 0 ? INTENT_FLAGS.SPRINT : 0) |
        (p % 3 === 0 ? INTENT_FLAGS.RIGHT : 0);
      runtime.inputQueue.enqueue(packCommandToken(p, actionCode));
    }
    const t0 = performance.now();
    runtime.tick(DT);
    times.push(performance.now() - t0);
  }

  times.sort((a, b) => a - b);
  const meanMs = times.reduce((acc, v) => acc + v, 0) / times.length;
  const p50Ms = times[Math.floor(times.length * 0.50)];
  const p95Ms = times[Math.floor(times.length * 0.95)];
  const p99Ms = times[Math.floor(times.length * 0.99)];
  const maxMs = times[times.length - 1];
  const stats = runtime.stats();

  console.log("--- JS TICK BASELINE RESULTS ---");
  console.log(`Ticks run:        ${SOAK_TICKS}`);
  console.log(`Mean tick:        ${meanMs.toFixed(3)} ms (${((meanMs / FRAME_BUDGET_MS) * 100).toFixed(1)}% of budget)`);
  console.log(`p50 tick:         ${p50Ms.toFixed(3)} ms`);
  console.log(`p95 tick:         ${p95Ms.toFixed(3)} ms`);
  console.log(`p99 tick:         ${p99Ms.toFixed(3)} ms (${((p99Ms / FRAME_BUDGET_MS) * 100).toFixed(1)}% of budget)`);
  console.log(`Max tick:         ${maxMs.toFixed(3)} ms`);
  console.log(`Spiral events:    ${stats.spiralEvents}`);
  console.log(`Dropped ms:       ${stats.droppedMs}`);
  console.log(`Budget overruns:  ${stats.budgetOverruns}`);

  const p99BudgetPercent = (p99Ms / FRAME_BUDGET_MS) * 100;
  const overBudget = p99Ms > FRAME_BUDGET_MS;
  console.log(`\n--- Phase 0 Gate Evaluation ---`);
  console.log(`p99 tick <= 33.33 ms budget: ${!overBudget ? "PASS" : "FAIL"} (${p99Ms.toFixed(3)} ms, ${p99BudgetPercent.toFixed(1)}% of budget)`);
  console.log(`Zero spiral events:          ${stats.spiralEvents === 0 ? "PASS" : "FAIL"} (${stats.spiralEvents} drops)`);

  console.log(`\n--- Caveats ---`);
  console.log(`- Measured on Node.js v25.9.0 (sandbox, 2 vCPUs shared). Numbers are labeled [sandbox].`);
  console.log(`- JS fallback kernel path (no native addon). Native path is measured by B3 bench.`);
  console.log(`- One kernel pass per tick, not a full gateway tick (no delta encode, no network I/O).`);
  console.log(`- These are the "before" numbers for the C++ main tick migration.`);

  process.exit(0);
}

runJsTickBaseline().catch((err) => {
  console.error(err);
  process.exit(1);
});