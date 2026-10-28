/**
 * SAB Logging Layer — Phase 1 tests (docs/SAB-LOGGING-LAYER-SPEC.md §4 Phase 1)
 *
 * Covers: batched file sink + rotation, metrics page, worker core
 * (size/time flush boundaries), runtime level control, the real worker
 * thread, and the crash drill (kill the worker mid-stream; the producer
 * never notices and no record already in the ring is lost).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LogLevel,
  LogProducer,
  LogRingBuffer,
  LogProducerClient,
  LogMetricsPage,
  FileSink,
  LogWorkerCore,
  LogWorkerSupervisor,
  runLogLevelCommand,
  logGatewayHelloPassword,
  logGatewayAuthError,
  logSimTickOverrun,
} from "../src/logging/index.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mmo-log-"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const readAll = (dir: string): string =>
  fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

describe("SAB Logging Phase 1: file sink", () => {
  it("stages many lines and writes them in one batched flush", () => {
    const dir = tmp();
    const sink = new FileSink({ dir });
    for (let i = 0; i < 500; i++) sink.append(`line ${i}`);
    assert.ok(sink.pendingBytes > 0);
    assert.equal(fs.existsSync(sink.activePath), false, "nothing is written until flush");
    const n = sink.flush();
    assert.ok(n > 0);
    assert.equal(sink.pendingBytes, 0);
    sink.close();
    const lines = fs.readFileSync(path.join(dir, "engine.log"), "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 500);
    assert.equal(lines[0], "line 0");
    assert.equal(lines[499], "line 499");
  });

  it("rotates by size and keeps at most maxFiles rotated files", () => {
    const dir = tmp();
    const sink = new FileSink({ dir, maxBytes: 1000, maxFiles: 2 });
    for (let i = 0; i < 40; i++) {
      sink.append(`record-${String(i).padStart(3, "0")} ${"x".repeat(40)}`);
      sink.flush();
    }
    sink.close();
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ["engine.1.log", "engine.2.log", "engine.log"]);
    assert.ok(sink.rotations >= 2);
    for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 1000 + 100);
    // Newest record is in the active file.
    assert.ok(fs.readFileSync(path.join(dir, "engine.log"), "utf8").includes("record-039"));
  });

  it("counts a failing disk as a sink error and never throws", () => {
    const dir = tmp();
    const sink = new FileSink({ dir });
    // Make the active path a directory so open() fails.
    fs.mkdirSync(path.join(dir, "engine.log"));
    sink.append("doomed");
    assert.doesNotThrow(() => sink.flush());
    assert.equal(sink.errors, 1);
  });
});

describe("SAB Logging Phase 1: metrics page", () => {
  it("counts records by level and code and renders Prometheus text", () => {
    const m = new LogMetricsPage();
    m.recordConsumed(LogLevel.INFO, 0x0101);
    m.recordConsumed(LogLevel.INFO, 0x0101);
    m.recordConsumed(LogLevel.ERROR, 0x0104);
    m.setDropped(7);
    m.recordFlush(123);
    assert.equal(m.total, 3);
    assert.equal(m.levelCount(LogLevel.INFO), 2);
    assert.equal(m.levelCount(LogLevel.ERROR), 1);
    assert.equal(m.codeCount(0x0101), 2);
    assert.equal(m.codeCount(0x0104), 1);
    assert.equal(m.codeCount(0x0999), 0);
    const text = m.renderLogMetrics();
    assert.match(text, /mmo_log_records_total\{level="info"\} 2/);
    assert.match(text, /mmo_log_records_total\{level="error"\} 1/);
    assert.match(text, /mmo_log_dropped_total 7/);
    assert.match(text, /mmo_log_file_bytes_total 123/);
    assert.match(text, /mmo_log_code_total\{code="0x0101"\} 2/);
  });

  it("is readable from a second view over the same SAB (the edge's view)", () => {
    const writer = new LogMetricsPage();
    const reader = new LogMetricsPage(writer.sab);
    writer.recordConsumed(LogLevel.WARN, 0x0201);
    assert.equal(reader.levelCount(LogLevel.WARN), 1);
    assert.equal(reader.codeCount(0x0201), 1);
  });
});

describe("SAB Logging Phase 1: worker core", () => {
  it("drains, formats once, and writes plain-text lines with epoch timestamps", () => {
    const dir = tmp();
    const ring = new LogRingBuffer(256);
    const client = new LogProducerClient(LogProducer.GATEWAY, ring);
    const metrics = new LogMetricsPage();
    const file = new FileSink({ dir });
    const core = new LogWorkerCore({ ring, file, metrics, flushMs: 0 });

    logGatewayHelloPassword(client, "alice");
    logGatewayAuthError(client, "bad password");
    core.pump();
    core.stop();

    const text = readAll(dir);
    assert.match(text, /INFO\s+gateway .*alice/);
    assert.match(text, /ERROR gateway .*bad password/);
    const ts = Date.parse(text.split(" ")[0]);
    assert.ok(Math.abs(ts - Date.now()) < 10_000, "timestamp is wall-clock, comparable across threads");
    assert.equal(metrics.total, 2);
    assert.equal(metrics.levelCount(LogLevel.ERROR), 1);
  });

  it("flushes on the time boundary but not before it (size threshold unmet)", () => {
    const dir = tmp();
    const ring = new LogRingBuffer(256);
    const client = new LogProducerClient(LogProducer.GATEWAY, ring);
    let clock = 0;
    const file = new FileSink({ dir });
    const core = new LogWorkerCore({ ring, file, flushMs: 50, flushBytes: 1 << 20, now: () => clock });

    logGatewayHelloPassword(client, "a");
    core.pump();
    assert.equal(fs.existsSync(file.activePath), false, "inside the 50 ms window: staged only");
    clock = 49;
    core.pump();
    assert.equal(fs.existsSync(file.activePath), false);
    clock = 51;
    logGatewayHelloPassword(client, "b");
    core.pump();
    assert.ok(fs.readFileSync(file.activePath, "utf8").includes("via=password"));
    core.stop();
  });

  it("flushes on the size boundary even inside the time window", () => {
    const dir = tmp();
    const ring = new LogRingBuffer(1024);
    const client = new LogProducerClient(LogProducer.GATEWAY, ring);
    const file = new FileSink({ dir });
    const core = new LogWorkerCore({ ring, file, flushMs: 1_000_000, flushBytes: 2000, now: () => 0 });
    for (let i = 0; i < 100; i++) logGatewayHelloPassword(client, `client-${i}`);
    core.pump();
    assert.ok(fs.existsSync(file.activePath), "size threshold forced a flush");
    core.stop();
  });

  it("hands each formatted batch to the onBatch hook (Phase 3 live-sink seam)", () => {
    const ring = new LogRingBuffer(64);
    const client = new LogProducerClient(LogProducer.SIM, ring);
    const batches: Array<{ text: string; n: number }> = [];
    const core = new LogWorkerCore({ ring, flushMs: 0, onBatch: (text, n) => batches.push({ text, n }) });
    logSimTickOverrun(client, 42, 9000);
    core.pump();
    core.stop();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].n, 1);
    assert.match(batches[0].text, /sim/);
  });

  it("renders an unknown code instead of throwing", () => {
    const ring = new LogRingBuffer(64);
    const client = new LogProducerClient(LogProducer.SIM, ring);
    const lines: string[] = [];
    const core = new LogWorkerCore({ ring, flushMs: 0, onBatch: (t) => lines.push(t) });
    client.emit(LogLevel.INFO, 0x7fff, 0n, 1);
    core.pump();
    core.stop();
    assert.match(lines[0], /unknown code 0x7fff/);
  });
});

describe("SAB Logging Phase 1: runtime level control", () => {
  it("shows thresholds, sets one producer, sets all, and clamps above ERROR", () => {
    const ring = new LogRingBuffer(64);
    assert.match(runLogLevelCommand(ring, undefined).message, /gateway=trace/);

    const r1 = runLogLevelCommand(ring, { producer: "sim", level: "warn" });
    assert.ok(r1.ok);
    assert.equal(ring.getLevelMask(LogProducer.SIM), LogLevel.WARN);
    assert.equal(ring.getLevelMask(LogProducer.GATEWAY), LogLevel.TRACE);

    runLogLevelCommand(ring, { level: "debug" });
    assert.equal(ring.getLevelMask(LogProducer.GATEWAY), LogLevel.DEBUG);
    assert.equal(ring.getLevelMask(LogProducer.ADMIN), LogLevel.DEBUG);

    runLogLevelCommand(ring, { producer: 1, level: 99 });
    assert.equal(ring.getLevelMask(LogProducer.SIM), LogLevel.ERROR, "clamped: ERROR is the ceiling");
  });

  it("rejects unknown producers/levels without changing anything", () => {
    const ring = new LogRingBuffer(64);
    assert.equal(runLogLevelCommand(ring, { producer: "nope", level: "info" }).ok, false);
    assert.equal(runLogLevelCommand(ring, { level: "loud" }).ok, false);
    assert.equal(runLogLevelCommand(ring, { producer: "sim" }).ok, false);
    assert.equal(ring.getLevelMask(LogProducer.SIM), LogLevel.TRACE);
  });

  it("a raised mask filters INFO at the producer but never ERROR", () => {
    const ring = new LogRingBuffer(64);
    const client = new LogProducerClient(LogProducer.GATEWAY, ring);
    runLogLevelCommand(ring, { producer: "gateway", level: "error" });
    assert.equal(logGatewayHelloPassword(client, "x"), false, "INFO masked");
    assert.equal(logGatewayAuthError(client, "boom"), true, "ERROR never masked");
  });
});

describe("SAB Logging Phase 1: worker thread + crash drill", () => {
  it("a real worker thread drains the ring into the file and shuts down clean", async () => {
    const dir = tmp();
    const ring = new LogRingBuffer(1024);
    const client = new LogProducerClient(LogProducer.GATEWAY, ring);
    const sup = new LogWorkerSupervisor({ ring, logDir: dir, flushMs: 10 });
    await sup.start();

    for (let i = 0; i < 300; i++) logGatewayHelloPassword(client, `c${i}`);
    await waitFor(() => sup.metrics.total >= 300);
    await sup.stop();

    const lines = readAll(dir).trimEnd().split("\n");
    assert.equal(lines.length, 300);
    assert.equal(sup.metrics.total, 300);
    assert.equal(ring.droppedCount, 0);
    assert.ok(sup.metrics.heartbeatCount > 0);
  });

  it("killing the worker mid-stream costs the producer nothing; a restart resumes", async () => {
    const dir = tmp();
    const ring = new LogRingBuffer(4096);
    const client = new LogProducerClient(LogProducer.GATEWAY, ring);
    const sup = new LogWorkerSupervisor({ ring, logDir: dir, flushMs: 10, restartBackoffMs: 20 });
    await sup.start();

    for (let i = 0; i < 200; i++) logGatewayHelloPassword(client, `pre${i}`);
    await waitFor(() => sup.metrics.total >= 200);
    // Consumed != durable: records staged in the worker but not yet flushed are the
    // documented in-flight window (<= flushMs). Wait for the flush, then kill.
    await waitFor(() => fs.existsSync(path.join(dir, 'engine.log')) && readAll(dir).includes('pre199'));

    await sup.killForDrill();
    assert.equal(sup.alive, false);

    // The producer keeps emitting while no worker is alive: every call succeeds
    // (ring has room) and none throws or blocks.
    let failed = 0;
    for (let i = 0; i < 500; i++) if (!logGatewayHelloPassword(client, `mid${i}`)) failed++;
    assert.equal(failed, 0, "producer path is unaffected by worker death");

    // Supervisor restarts the worker, which resumes from the dequeue index in the SAB header.
    await waitFor(() => sup.restarts >= 1 && sup.alive);
    await waitFor(() => sup.metrics.total >= 700);
    await sup.stop();

    const text = readAll(dir);
    assert.ok(text.includes("pre199"));
    assert.ok(text.includes("mid0") && text.includes("mid499"), "records written during the outage were drained after restart");
    assert.equal(ring.droppedCount, 0);
  });

  it("a full ring while the worker is down drops visibly (counted), never blocks", async () => {
    const dir = tmp();
    const ring = new LogRingBuffer(64);
    const client = new LogProducerClient(LogProducer.GATEWAY, ring);
    // No worker running at all.
    let accepted = 0;
    for (let i = 0; i < 200; i++) if (logGatewayHelloPassword(client, `n${i}`)) accepted++;
    assert.equal(accepted, 64);
    assert.equal(ring.droppedCount, 136);
    void dir;
  });
});
