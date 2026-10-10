/**
 * TDD: sidecar lifecycle (EA11).
 *
 * Spawns REAL stub sidecar processes (a tiny HTTP server script written to
 * a tmp dir) so start/health/stop are exercised end to end: the healthy
 * path, the exited-process path, the health-timeout path, isolation
 * between modules, and graceful + synchronous stops.
 */
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarManager, type SidecarModule } from "../src/sidecar-manager.js";

const STUB = `
const http = require("http");
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); }
  else { res.writeHead(404); res.end(); }
}).listen(port, "127.0.0.1");
`;

let dir = "";
const managers: SidecarManager[] = [];
// Distinct high ports per test; collisions are unlikely and a collision
// fails loudly (the stub cannot bind) rather than silently.
let nextPort = 48100 + Math.floor(Math.random() * 500);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "sidecar-test-"));
  writeFileSync(join(dir, "stub.js"), STUB, "utf8");
});

afterEach(async () => {
  while (managers.length > 0) await managers.pop()!.stop();
  // Give the OS a beat to release ports between tests.
  await new Promise((r) => setTimeout(r, 150));
});

const tracked = (m: SidecarManager): SidecarManager => {
  managers.push(m);
  return m;
};

const mod = (name: string, command: string, port: number): SidecarModule => ({
  dir,
  manifest: {
    name,
    sidecar: { command, port, health: "/health" },
  },
});

const stubMod = (name: string, port: number): SidecarModule =>
  mod(name, `node ${JSON.stringify(join(dir, "stub.js"))} ${port}`, port);

const portClosed = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/health", timeout: 1000 }, (res) => {
      res.resume();
      resolve(false);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(true);
    });
    req.on("error", () => resolve(true));
  });

const portClosedSoon = async (port: number, tries = 40): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    if (await portClosed(port)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const portOpenSoon = async (port: number, tries = 40): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    if (!(await portClosed(port))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

describe("SidecarManager", () => {
  it("starts a healthy sidecar and reports healthy", async () => {
    const port = nextPort++;
    const mgr = tracked(new SidecarManager({ healthTimeoutMs: 8000, pollIntervalMs: 100 }));
    const [report] = await mgr.start([stubMod("brain", port)]);
    assert.equal(report.status, "healthy");
    assert.equal(report.port, port);
    assert.equal(mgr.statusOf("brain"), "healthy");
  });

  it("stops a healthy sidecar gracefully and frees its port", async () => {
    const port = nextPort++;
    const mgr = tracked(new SidecarManager({ healthTimeoutMs: 8000, pollIntervalMs: 100 }));
    await mgr.start([stubMod("brain", port)]);
    assert.ok(await portOpenSoon(port), "stub should be listening");
    await mgr.stop();
    assert.equal(mgr.statusOf("brain"), "stopped");
    assert.ok(await portClosedSoon(port), "port should be closed after stop");
  });

  it("marks an exited process unhealthy without killing the healthy one", async () => {
    const goodPort = nextPort++;
    const mgr = tracked(new SidecarManager({ healthTimeoutMs: 8000, pollIntervalMs: 100 }));
    const reports = await mgr.start([
      mod("dead", `node -e "process.exit(3)"`, nextPort++),
      stubMod("brain", goodPort),
    ]);
    const byName = new Map(reports.map((r) => [r.name, r]));
    assert.equal(byName.get("dead")!.status, "unhealthy");
    assert.match(byName.get("dead")!.reason ?? "", /exited/);
    assert.equal(byName.get("brain")!.status, "healthy");
    assert.equal(mgr.statusOf("dead"), "unhealthy");
  });

  it("times out when nothing serves the health endpoint", async () => {
    const port = nextPort++;
    const mgr = tracked(
      new SidecarManager({ healthTimeoutMs: 1200, pollIntervalMs: 100, killTimeoutMs: 1000 }),
    );
    // Runs forever, serves nothing: the health check must time out and the
    // stray process must be reaped.
    const [report] = await mgr.start([mod("mute", `node -e "setInterval(() => {}, 1000)"`, port)]);
    assert.equal(report.status, "unhealthy");
    assert.match(report.reason ?? "", /timed out/);
    assert.equal(mgr.statusOf("mute"), "unhealthy");
    // stop() must resolve promptly: nothing may be left tracked.
    await mgr.stop();
  });

  it("returns no reports when no module declares a sidecar", async () => {
    const mgr = tracked(new SidecarManager());
    const reports = await mgr.start([{ dir, manifest: { name: "plain" } }]);
    assert.deepEqual(reports, []);
    await mgr.stop();
  });

  it("killNow hard-kills without awaiting", async () => {
    const port = nextPort++;
    const mgr = tracked(new SidecarManager({ healthTimeoutMs: 8000, pollIntervalMs: 100 }));
    await mgr.start([stubMod("brain", port)]);
    assert.ok(await portOpenSoon(port), "stub should be listening");
    mgr.killNow();
    assert.ok(await portClosedSoon(port), "port should close after killNow");
  });

  it("statusOf is undefined for unknown names", () => {
    const mgr = tracked(new SidecarManager());
    assert.equal(mgr.statusOf("nope"), undefined);
  });
});
