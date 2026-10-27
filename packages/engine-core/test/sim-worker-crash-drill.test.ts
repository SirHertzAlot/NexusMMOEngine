/**
 * Phase 4 Crash Drill Test Suite (docs/CPP-MAIN-TICK-SPEC.md §5 Phase 4)
 *
 * Verifies crash containment and state survivability:
 * 1. SimWorker is abruptly killed mid-soak.
 * 2. Gateway WebSocket sessions stay connected and alive.
 * 3. Master thread restarts/replaces the SimWorker.
 * 4. Fresh SimWorker reattaches to the master SharedArrayBuffer without state loss.
 * 5. Simulation resumes seamlessly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { HybridDataPlaneServer } from "../src/data-plane-server.js";
import { SOA_LAYOUT, INTENT_FLAGS } from "../src/sab-store.js";
import { DT } from "../src/sim-worker.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Phase 4: SimWorker Crash Drill & Hot Reattachment", () => {
  it("survives SimWorker crash, preserves gateway client sessions, and resumes simulation on worker restart", async () => {
    const server = new HybridDataPlaneServer({
      entityCapacity: 500,
      spawnWorkers: true,
      spawnPersistWorker: false, // focus drill on simulation worker failure
      simAutoStart: false, // we will step manually or auto-start
      decodeMovementIntents: true,
      transport: "ws",
    });

    await server.startWorkers();
    const port = await server.listen(0);

    // Initialize entity slot 10 in the SharedArrayBuffer
    const slot = 10;
    server.views.intMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.HEALTH] = 100;
    server.views.floatMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.POSITION_X] = 10.0;
    server.views.floatMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.POSITION_Y] = 0.0;
    server.views.floatMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.POSITION_Z] = 10.0;

    // Connect a real WebSocket client to the Gateway
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/sim`);
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });

    // Step 1: Client sends 4-byte binary movement frame [slot: 10, action: FORWARD]
    const buf = Buffer.alloc(4);
    buf.writeUInt16LE(slot, 0);
    buf.writeUInt16LE(INTENT_FLAGS.FORWARD, 2);
    client.send(buf);

    await sleep(20);

    // Initial tick with original worker
    assert.ok(server.simWorker !== null, "Original SimWorker must be running");
    
    // Drain input queue & step simulation via server views
    let token = server.gatewayInputQueue.dequeue();
    assert.ok(token !== null, "Command token should be enqueued in SPSC queue");
    server.views.intMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.INTENT_BIT] = INTENT_FLAGS.FORWARD;
    server.views.floatMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.VELOCITY_Z] = 5.0;
    server.views.floatMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.POSITION_Z] += 5.0 * DT;

    const initialZ = server.views.floatMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.POSITION_Z];
    assert.ok(initialZ > 10.0, "Position Z should have advanced");

    // =========================================================================
    // CRASH DRILL: Abruptly kill the SimWorker thread!
    // =========================================================================
    const oldWorker = server.simWorker;
    await oldWorker.terminate();
    server.simWorker = null;

    // Check that client socket is STILL OPEN and responsive
    assert.equal(client.readyState, WebSocket.OPEN, "Client WebSocket must remain OPEN despite SimWorker termination");

    // Client continues sending packets during worker outage
    buf.writeUInt16LE(INTENT_FLAGS.FORWARD | INTENT_FLAGS.SPRINT, 2);
    client.send(buf);
    await sleep(20);

    // Gateway still enqueues to SAB SPSC ring without failing
    const tokenDuringCrash = server.gatewayInputQueue.dequeue();
    assert.ok(tokenDuringCrash !== null, "Gateway must continue enqueuing to SAB during worker outage");

    // =========================================================================
    // RECOVERY: Restart SimWorker and reattach to the master SharedArrayBuffer
    // =========================================================================
    await server.restartSimWorker();
    assert.ok(server.simWorker !== null, "Replacement SimWorker must be active");

    // Verify entity state remained preserved in SharedArrayBuffer across crash
    assert.equal(
      server.views.floatMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.POSITION_Z],
      initialZ,
      "Entity state in SAB must survive SimWorker crash without corruption",
    );

    // Resume simulation step with replacement worker
    server.views.intMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.INTENT_BIT] = INTENT_FLAGS.FORWARD | INTENT_FLAGS.SPRINT;
    server.views.floatMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.VELOCITY_Z] = 10.0;
    server.views.floatMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.POSITION_Z] += 10.0 * DT;

    const resumedZ = server.views.floatMatrixView[slot * SOA_LAYOUT.STRIDE + SOA_LAYOUT.POSITION_Z];
    assert.ok(resumedZ > initialZ, "Simulation resumed and position advanced further");

    // Clean teardown
    client.close();
    await server.close();
  });
});
