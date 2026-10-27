/**
 * B3 Load Test with Network-Profile Injection & Edge-Trigger Re-Fire Test
 * (docs/CPP-MAIN-TICK-SPEC.md §5 Phase 4)
 *
 * Requirements:
 * - 1,000 real-client fan-out streams
 * - 51,000 entities (1,000 players + 50,000 NPCs) in SharedArrayBuffer
 * - Network-profile injection: 45ms latency, ±15ms jitter, 2% packet loss
 * - PlayerIntent edge-trigger re-fire test (press -> release -> re-press across tick boundaries)
 * - Gate verification: p99 tick <= 25% of 33.33ms budget (<= 8.33ms), zero dropped steps
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
  loadNativeKernel,
} from "../../dist/src/sim-worker.js";
import { packCommandToken } from "../../dist/src/lockless-ring.js";

// Network profile configuration
const NETWORK_PROFILE = {
  baseLatencyMs: 45,
  jitterMs: 15,
  packetLossRate: 0.02, // 2% loss
};

/** Simulate network delay with jitter and packet loss */
function simulateNetworkPacket(token, sendTimeMs, packetLossRate, baseLatencyMs, jitterMs) {
  if (Math.random() < packetLossRate) {
    return null; // Dropped packet
  }
  const jitter = (Math.random() * 2 - 1) * jitterMs;
  const deliveryTime = sendTimeMs + Math.max(5, baseLatencyMs + jitter);
  return { token, deliveryTime };
}

async function runB3LoadBenchmark() {
  console.log("==================================================================");
  console.log("      NEXUS MMO ENGINE — B3 LOAD TEST & NETWORK INJECTION         ");
  console.log("==================================================================\n");

  const TOTAL_ENTITIES = 51000;
  const PLAYER_COUNT = 1000;
  const NPC_COUNT = TOTAL_ENTITIES - PLAYER_COUNT;
  const SOAK_TICKS = 100;

  console.log(`Entities: ${TOTAL_ENTITIES.toLocaleString()} (${PLAYER_COUNT} players + ${NPC_COUNT.toLocaleString()} NPCs)`);
  console.log(`Network Profile: Latency ${NETWORK_PROFILE.baseLatencyMs}ms (±${NETWORK_PROFILE.jitterMs}ms jitter), Loss ${NETWORK_PROFILE.packetLossRate * 100}%\n`);

  // 1. Initialize 51,000 entity plane in SharedArrayBuffer
  const sab = createSharedMemoryPlane(TOTAL_ENTITIES, 64);
  const kernel = loadNativeKernel();
  console.log(`Native C++ Kernel Loaded: ${kernel.isNative ? "YES (Hardware AVX2)" : "NO (Pure JS Fallback)"}`);

  const runtime = new SimWorkerRuntime({
    sharedMemory: sab,
    entityCapacity: TOTAL_ENTITIES,
    inputRingCapacity: 4096,
    mode: "matrix",
    decodeMovementIntents: true,
    kernel,
  });

  // Populate health and initial transforms for 51k entities
  for (let i = 0; i < TOTAL_ENTITIES; i++) {
    const base = i * SOA_LAYOUT.STRIDE;
    runtime.views.intMatrixView[base + SOA_LAYOUT.HEALTH] = 100;
    runtime.views.floatMatrixView[base + SOA_LAYOUT.POSITION_X] = (i % 200) * 2.0;
    runtime.views.floatMatrixView[base + SOA_LAYOUT.POSITION_Y] = 0.0;
    runtime.views.floatMatrixView[base + SOA_LAYOUT.POSITION_Z] = Math.floor(i / 200) * 2.0;
  }

  // 2. Part A: PlayerIntent Edge-Trigger Re-Fire Verification
  console.log("\n--- Part A: PlayerIntent Edge-Trigger Re-Fire Verification ---");
  const testPlayerSlot = 42;
  const edgeLog = [];

  // Sequence: Press FORWARD -> Release -> Re-press FORWARD within sub-tick window
  // Tick 0: Press
  runtime.inputQueue.enqueue(packCommandToken(testPlayerSlot, INTENT_FLAGS.FORWARD));
  runtime.tick(DT);
  const velZ1 = runtime.views.floatMatrixView[testPlayerSlot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.VELOCITY_Z];
  edgeLog.push(velZ1 > 0 ? "PRESSED" : "IDLE");

  // Tick 1: Release
  runtime.inputQueue.enqueue(packCommandToken(testPlayerSlot, 0));
  runtime.tick(DT);
  const velZ2 = runtime.views.floatMatrixView[testPlayerSlot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.VELOCITY_Z];
  edgeLog.push(velZ2 === 0 ? "RELEASED" : "MOVING");

  // Tick 2: Re-press with SPRINT
  runtime.inputQueue.enqueue(packCommandToken(testPlayerSlot, INTENT_FLAGS.FORWARD | INTENT_FLAGS.SPRINT));
  runtime.tick(DT);
  const velZ3 = runtime.views.floatMatrixView[testPlayerSlot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.VELOCITY_Z];
  edgeLog.push(velZ3 > velZ1 ? "RE-PRESSED (SPRINT)" : "IDLE");

  console.log(`Edge Trigger Sequence: ${edgeLog.join(" -> ")}`);
  if (edgeLog[0] === "PRESSED" && edgeLog[1] === "RELEASED" && edgeLog[2] === "RE-PRESSED (SPRINT)") {
    console.log("✔ Edge-Trigger Re-Fire Test: PASS (Accurate state transitions on tick boundaries)");
  } else {
    throw new Error("Edge-Trigger Re-Fire Test Failed!");
  }

  // 3. Part B: 1,000 Real-Client Injected Fan-Out Simulation (51k Entities over 100 Ticks)
  console.log("\n--- Part B: 1,000-Client Fan-Out Simulation over 100 Soak Ticks ---");

  const flightTimes = [];
  const inFlightPackets = [];
  let packetsSent = 0;
  let packetsDelivered = 0;
  let packetsLost = 0;

  let virtualTimeMs = 0;

  for (let tick = 0; tick < SOAK_TICKS; tick++) {
    virtualTimeMs += FRAME_BUDGET_MS;

    // Each of the 1,000 clients generates intent packets with network jitter/loss
    for (let p = 0; p < PLAYER_COUNT; p++) {
      packetsSent++;
      const actionCode =
        INTENT_FLAGS.FORWARD |
        ((tick + p) % 5 === 0 ? INTENT_FLAGS.SPRINT : 0) |
        (p % 3 === 0 ? INTENT_FLAGS.RIGHT : 0);

      const packet = simulateNetworkPacket(
        packCommandToken(p, actionCode),
        virtualTimeMs,
        NETWORK_PROFILE.packetLossRate,
        NETWORK_PROFILE.baseLatencyMs,
        NETWORK_PROFILE.jitterMs,
      );

      if (packet) {
        inFlightPackets.push(packet);
      } else {
        packetsLost++;
      }
    }

    // Deliver all packets whose deliveryTime <= virtualTimeMs into the Gateway SPSC ring
    for (let i = inFlightPackets.length - 1; i >= 0; i--) {
      if (inFlightPackets[i].deliveryTime <= virtualTimeMs) {
        const item = inFlightPackets.splice(i, 1)[0];
        runtime.inputQueue.enqueue(item.token);
        packetsDelivered++;
      }
    }

    // Step the 51,000 entity simulation tick and measure precise execution duration
    const t0 = performance.now();
    runtime.tick(DT);
    const durationMs = performance.now() - t0;
    flightTimes.push(durationMs);
  }

  // Calculate telemetry statistics
  flightTimes.sort((a, b) => a - b);
  const meanMs = flightTimes.reduce((acc, v) => acc + v, 0) / flightTimes.length;
  const p50Ms = flightTimes[Math.floor(flightTimes.length * 0.50)];
  const p95Ms = flightTimes[Math.floor(flightTimes.length * 0.95)];
  const p99Ms = flightTimes[Math.floor(flightTimes.length * 0.99)];
  const maxMs = flightTimes[flightTimes.length - 1];

  const budgetBudgetMs = FRAME_BUDGET_MS;
  const p99BudgetPercent = (p99Ms / budgetBudgetMs) * 100;
  const maxBudgetThresholdMs = budgetBudgetMs * 0.25; // 25% of 33.33ms = 8.33ms

  console.log("\n--- B3 SOAK TELEMETRY RESULTS (51,000 Entities @ 30Hz) ---");
  console.log(`Ticks Run: ${SOAK_TICKS}`);
  console.log(`Packets Sent: ${packetsSent.toLocaleString()} | Delivered: ${packetsDelivered.toLocaleString()} | Lost: ${packetsLost.toLocaleString()} (${((packetsLost / packetsSent) * 100).toFixed(2)}%)`);
  console.log(`Mean Tick Duration:   ${meanMs.toFixed(3)} ms`);
  console.log(`p50 (Median) Tick:    ${p50Ms.toFixed(3)} ms`);
  console.log(`p95 Tick:             ${p95Ms.toFixed(3)} ms`);
  console.log(`p99 Tick:             ${p99Ms.toFixed(3)} ms (${p99BudgetPercent.toFixed(1)}% of 33.33ms budget)`);
  console.log(`Max Tick:             ${maxMs.toFixed(3)} ms`);
  console.log(`Dropped Steps:        ${runtime.stats().spiralEvents}`);

  console.log("\n--- Phase 4 Gate Evaluation ---");
  const p99Pass = p99Ms <= maxBudgetThresholdMs;
  const spiralPass = runtime.stats().spiralEvents === 0;

  console.log(`- Gate 1: p99 Tick <= 25% of 33.33ms Budget (<= 8.33ms): ${p99Pass ? "PASS" : "FAIL"} (${p99Ms.toFixed(3)}ms <= 8.333ms)`);
  console.log(`- Gate 2: Zero Dropped Steps Across Soak Window:         ${spiralPass ? "PASS" : "FAIL"} (${runtime.stats().spiralEvents} drops)`);

  if (p99Pass && spiralPass) {
    console.log("\n>>> ALL PHASE 4 GATING CRITERIA SATISFIED! <<<");
  } else {
    throw new Error("Phase 4 Gating criteria not satisfied!");
  }
}

runB3LoadBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
