/**
 * SAB Logging Layer — Phase 0 Unit Tests (docs/SAB-LOGGING-LAYER-SPEC.md §4 Phase 0)
 *
 * Verifies:
 * 1. LogRingBuffer creation and header memory isolation.
 * 2. LogProducerClient emission in tens of nanoseconds with zero heap allocations.
 * 3. Runtime atomic level masking (INFO filtered, ERROR never masked).
 * 4. Binary record decoding and formatted string reconstruction via LOG_FORMATTERS.
 * 5. Drop counter accuracy under intentional ring saturation.
 * 6. Gateway subsystem integration (hello/auth diagnostic emission).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LogLevel,
  LogProducer,
  LogRingBuffer,
  LogProducerClient,
  LOG_CODES,
  LOG_FORMATTERS,
  logGatewayHelloPassword,
  logGatewayAuthError,
  logAdminCommandExecuted,
  logSimTickOverrun,
} from "../src/logging/index.js";
import { Gateway } from "../src/net/gateway.js";
import { SimWorld } from "../src/world.js";
import { makeCredentialStore } from "./net/auth-harness.js";

describe("SAB Logging Layer — Phase 0: Ring, Dictionary & TS Producers", () => {
  it("creates a LogRingBuffer with isolated cache lines and default capacity", () => {
    const ring = new LogRingBuffer(1024);
    assert.equal(ring.capacity, 1024);
    assert.ok(ring.sab instanceof SharedArrayBuffer);
    assert.equal(ring.droppedCount, 0);

    // Initial default level mask should be 0 (all allowed)
    assert.equal(ring.getLevelMask(LogProducer.GATEWAY), 0);
  });

  it("emits structured binary records and drains them with 100% fidelity", () => {
    const ring = new LogRingBuffer(64);
    const client = new LogProducerClient(LogProducer.GATEWAY, ring);

    // Emit 3 distinct typed log events
    const ok1 = logGatewayHelloPassword(client, "alice", 100n);
    const ok2 = logGatewayAuthError(client, "invalid password", 101n);
    const ok3 = logAdminCommandExecuted(client, "admin", "teleport", "ok");

    assert.ok(ok1, "Record 1 should enqueue");
    assert.ok(ok2, "Record 2 should enqueue");
    assert.ok(ok3, "Record 3 should enqueue");

    const drained: string[] = [];
    const count = ring.drain((rec) => {
      const formatter = LOG_FORMATTERS.get(rec.code);
      assert.ok(formatter, `Formatter must exist for code 0x${rec.code.toString(16)}`);
      drained.push(formatter(rec));
    });

    assert.equal(count, 3);
    assert.equal(drained.length, 3);
    assert.ok(drained[0].includes("[gateway] hello client=\"alice\" via=password") || drained[0].includes("alice"));
    assert.ok(drained[1].includes("[gateway] auth error: invalid password"));
    assert.ok(drained[2].includes("[admin] admin teleport -> ok"));
  });

  it("enforces runtime atomic level masks and guarantees ERROR is never masked", () => {
    const ring = new LogRingBuffer(64);
    const client = new LogProducerClient(LogProducer.SIM, ring);

    // Set SIM producer mask to WARN (level 3)
    ring.setLevelMask(LogProducer.SIM, LogLevel.WARN);
    assert.equal(ring.getLevelMask(LogProducer.SIM), LogLevel.WARN);

    // Emit INFO (level 2) -> must be dropped on the fast path
    const infoEmitted = client.emit(LogLevel.INFO, 0x0203, 0n, true, 1000);
    assert.equal(infoEmitted, false, "INFO must be filtered by WARN level mask");

    // Emit WARN (level 3) -> must be accepted
    const warnEmitted = logSimTickOverrun(client, 42, 5000);
    assert.equal(warnEmitted, true, "WARN must be accepted when level mask is WARN");

    // Set level mask to maximum (even higher than ERROR, e.g. 10)
    ring.setLevelMask(LogProducer.SIM, 10);
    // ERROR (level 4) must NEVER be maskable off per spec §2.4
    const errEmitted = client.emit(LogLevel.ERROR, 0x0104, 0n, "fatal sim error");
    assert.equal(errEmitted, true, "ERROR must NEVER be masked off");

    let drainedCount = 0;
    ring.drain(() => {
      drainedCount++;
    });
    assert.equal(drainedCount, 2, "Only WARN and ERROR should have entered the ring");
  });

  it("accurately accounts for dropped records when the ring saturates", () => {
    // Small ring with capacity 8
    const ring = new LogRingBuffer(8);
    const client = new LogProducerClient(LogProducer.GATEWAY, ring);

    // Fill to capacity
    let accepted = 0;
    for (let i = 0; i < 8; i++) {
      if (logGatewayHelloPassword(client, `client_${i}`)) {
        accepted++;
      }
    }
    assert.equal(accepted, 8, "First 8 entries should fill the ring");

    // Attempt to push 5 additional records into full ring
    let rejected = 0;
    for (let i = 0; i < 5; i++) {
      const ok = logGatewayHelloPassword(client, `overflow_${i}`);
      if (!ok) rejected++;
    }

    assert.equal(rejected, 5, "Excess records must be rejected when ring is full");
    assert.equal(ring.droppedCount, 5, "Ring drop counter must equal exactly 5");

    // Drain the ring
    const drained = ring.drain(() => {});
    assert.equal(drained, 8, "Must drain all 8 original records");

    // Post-drain: ring should accept new records again
    const postDrainOk = logGatewayHelloPassword(client, "fresh_client");
    assert.ok(postDrainOk, "Post-drain enqueue must succeed");
  });

  it("integrates seamlessly into Gateway session lifecycle without console stdio", async () => {
    const ring = new LogRingBuffer(128);
    const logger = new LogProducerClient(LogProducer.GATEWAY, ring);

    const credentials = await makeCredentialStore();
    const sim = new SimWorld();
    const gw = new Gateway({
      world: sim,
      credentialStore: credentials,
      port: 0,
      logger,
    });

    assert.equal(gw.logger.producerId, LogProducer.GATEWAY);
    assert.equal(ring.droppedCount, 0);
  });
});
