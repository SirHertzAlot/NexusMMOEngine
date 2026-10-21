/**
 * Persistence layer P5: the host sidecar's report shaping.
 *
 * The shaping half is pure and unit-tested here (fields, hostId
 * defaulting, clamping, the post's wire shape). The process loop in
 * host-sidecar.ts itself is smoke-level only: it is an interval
 * around these functions plus signal handlers, with no logic of its
 * own to assert on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHostReport,
  postHostReport,
  resolveHostId,
  sampleHost,
  type HostOsSource,
} from "../src/sidecar-report.js";

const GIB = 1024 * 1024 * 1024;

const fakeOs: HostOsSource = {
  cpus: () => Array.from({ length: 8 }, () => ({})),
  totalmem: () => 16 * GIB,
  freemem: () => 4 * GIB,
  hostname: () => "fake-host-01",
};

test("resolveHostId: explicit wins (trimmed), otherwise the OS hostname", () => {
  assert.equal(resolveHostId("  my-host  ", fakeOs), "my-host");
  assert.equal(resolveHostId(undefined, fakeOs), "fake-host-01");
  assert.equal(resolveHostId("", fakeOs), "fake-host-01");
  assert.equal(resolveHostId("   ", fakeOs), "fake-host-01");
});

test("sampleHost reads cores and RAM from the os source", () => {
  assert.deepEqual(sampleHost(fakeOs), {
    cpuCores: 8,
    ramTotalBytes: 16 * GIB,
    ramFreeBytes: 4 * GIB,
  });
});

test("buildHostReport shapes every field, defaults the hostId, and omits an absent shardLoad", () => {
  const report = buildHostReport({ sample: sampleHost(fakeOs), source: fakeOs });
  assert.deepEqual(report, {
    hostId: "fake-host-01",
    cpuCores: 8,
    ramTotalBytes: 16 * GIB,
    ramFreeBytes: 4 * GIB,
  });
  const loaded = buildHostReport({
    hostId: "explicit-host",
    sample: { ...sampleHost(fakeOs), shardLoad: 0.4 },
    source: fakeOs,
  });
  assert.equal(loaded.hostId, "explicit-host");
  assert.equal(loaded.shardLoad, 0.4);
});

test("buildHostReport clamps a racing sample into the world's valid range", () => {
  const report = buildHostReport({
    hostId: "h",
    sample: { cpuCores: 0, ramTotalBytes: 100, ramFreeBytes: 250 },
    source: fakeOs,
  });
  assert.equal(report.cpuCores, 1);
  assert.equal(report.ramFreeBytes, 100, "free never exceeds total");
});

test("postHostReport posts the report + apiKey to the webrpc endpoint and never throws", async () => {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const okFetch = (async (url: string, init: { body: string }) => {
    seen.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  const report = buildHostReport({ sample: sampleHost(fakeOs), source: fakeOs });
  assert.equal(
    await postHostReport({ worldUrl: "http://world:7780/", apiKey: "secret-key-123", report, fetchFn: okFetch }),
    true,
  );
  assert.equal(seen[0].url, "http://world:7780/rpc/World/ReportHostResources");
  assert.deepEqual(seen[0].body, {
    input: {
      hostId: "fake-host-01",
      cpuCores: 8,
      ramTotalBytes: 16 * GIB,
      ramFreeBytes: 4 * GIB,
      apiKey: "secret-key-123",
    },
  });

  const failFetch = (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch;
  assert.equal(
    await postHostReport({ worldUrl: "http://world:7780", apiKey: "k", report, fetchFn: failFetch }),
    false,
  );
  const downFetch = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  assert.equal(
    await postHostReport({ worldUrl: "http://world:7780", apiKey: "k", report, fetchFn: downFetch }),
    false,
    "a dead world costs one report, never a crash",
  );
});
