/**
 * TDD: EA19 local target — assemble a package (files + manifest) and
 * deploy it locally: swap in the new package, start it, health-check,
 * roll back to the previous package on failure.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assemblePackage } from "../src/package.js";
import { verifyManifest } from "../src/manifest.js";
import { deployLocal } from "../src/deploy.js";

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-deploy-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** A fake "server": answers /health with 200 unless its own fail-flag.txt says 1. */
const FAKE_SERVER = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const fail = fs.readFileSync(path.join(__dirname, "fail-flag.txt"), "utf8").trim() === "1";
const s = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(fail ? 500 : 200).end("ok"); }
  else { res.writeHead(404).end(); }
});
s.listen(Number(process.env.PORT || "18799"), "127.0.0.1");
`;

describe("assemblePackage", () => {
  it("copies files preserving relative paths and writes a verifiable manifest", () => {
    const root = path.join(tmp, "root1");
    write(root, "dist/server.js", "console.log(1)");
    write(root, "content/rules/a.json", "{}");
    const out = path.join(tmp, "pkg1");
    const manifest = assemblePackage(root, out, "test", ["dist/server.js", "content/rules/a.json"]);
    assert.ok(fs.existsSync(path.join(out, "dist/server.js")));
    assert.ok(fs.existsSync(path.join(out, "content/rules/a.json")));
    const onDisk = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.equal(onDisk.profile, "test");
    const v = verifyManifest(out, manifest);
    assert.equal(v.ok, true);
  });

  it("refuses to assemble when a listed file is missing", () => {
    const root = path.join(tmp, "root2");
    fs.mkdirSync(root, { recursive: true });
    assert.throws(() => assemblePackage(root, path.join(tmp, "pkg2"), "test", ["nope.js"]));
  });
});

describe("deployLocal", () => {
  function pkgDir(name: string, failHealth: boolean): string {
    const root = path.join(tmp, name);
    write(root, "server.cjs", FAKE_SERVER);
    write(root, "fail-flag.txt", failHealth ? "1" : "0");
    return root;
  }

  const startCmd = (port: string) => `PORT=${port} node server.cjs`;

  it("deploys a healthy package: starts it and passes the health check", async () => {
    const deployDir = path.join(tmp, "dep1");
    const port = "18791";
    const res = await deployLocal(pkgDir("good1", false), {
      deployDir,
      startCommand: startCmd(port),
      healthUrl: `http://127.0.0.1:${port}/health`,
    });
    assert.equal(res.ok, true);
    assert.equal(res.rolledBack, false);
    assert.ok(fs.existsSync(path.join(deployDir, "server.cjs")));
    await res.stop();
  });

  it("rolls back to the previous package when the new one fails health", async () => {
    const deployDir = path.join(tmp, "dep2");
    const port = "18792";
    // First deploy the good package.
    const first = await deployLocal(pkgDir("good2", false), {
      deployDir,
      startCommand: startCmd(port),
      healthUrl: `http://127.0.0.1:${port}/health`,
    });
    assert.equal(first.ok, true);
    await first.stop();

    // Now deploy the bad one: health fails, previous package is restored and running.
    const second = await deployLocal(pkgDir("bad2", true), {
      deployDir,
      startCommand: startCmd(port),
      healthUrl: `http://127.0.0.1:${port}/health`,
      healthTimeoutMs: 500,
      healthRetries: 3,
    });
    assert.equal(second.ok, false);
    assert.equal(second.rolledBack, true);
    // The deploy dir holds the previous (good) package again.
    assert.equal(fs.readFileSync(path.join(deployDir, "fail-flag.txt"), "utf8"), "0");
    await second.stop();
  });
});
