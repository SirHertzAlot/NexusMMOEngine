/**
 * TDD: EA19 build pipeline — profiles, input-hash caching, package
 * manifest, health check.
 *
 * A build profile is a named list of stages (codegen, build, bakes,
 * tests, package). Each stage declares its input files; the pipeline
 * hashes them and skips stages whose inputs haven't changed. A package
 * manifest records what shipped; the health check verifies a local
 * target is actually serving.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createHash } from "node:crypto";
import { defaultProfile, loadProfile } from "../src/profile.js";
import { hashFiles } from "../src/hash.js";
import { readStageCache, stageNeedsRun, writeStageCache } from "../src/cache.js";
import { buildManifest, verifyManifest } from "../src/manifest.js";
import { checkHealth } from "../src/health.js";

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-pipe-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe("loadProfile", () => {
  it("loads a valid profile", () => {
    const p = loadProfile({
      name: "test",
      stages: [{ id: "codegen", command: "npm run codegen", inputs: ["scripts/codegen.mjs"] }],
    });
    assert.equal(p.name, "test");
    assert.equal(p.stages[0]?.id, "codegen");
  });

  it("rejects a profile with no stages", () => {
    assert.throws(() => loadProfile({ name: "bad", stages: [] }));
  });

  it("rejects a stage with no command", () => {
    assert.throws(() => loadProfile({ name: "bad", stages: [{ id: "x", inputs: [] }] }));
  });

  it("rejects duplicate stage ids", () => {
    assert.throws(() =>
      loadProfile({
        name: "bad",
        stages: [
          { id: "x", command: "a", inputs: [] },
          { id: "x", command: "b", inputs: [] },
        ],
      }),
    );
  });
});

describe("defaultProfile", () => {
  it("covers the full pipeline: codegen, build, bakes, tests, package", () => {
    const ids = defaultProfile().stages.map((s) => s.id);
    for (const want of ["codegen", "build", "bake", "test", "package"]) {
      assert.ok(ids.includes(want), `missing stage ${want}`);
    }
  });
});

describe("hashFiles", () => {
  it("is stable for the same files", () => {
    write("h/a.txt", "hello");
    write("h/b.txt", "world");
    assert.equal(hashFiles(tmp, ["h/a.txt", "h/b.txt"]), hashFiles(tmp, ["h/b.txt", "h/a.txt"]), "order independent");
  });

  it("changes when content changes", () => {
    write("h2/a.txt", "hello");
    const beforeHash = hashFiles(tmp, ["h2/a.txt"]);
    write("h2/a.txt", "goodbye");
    assert.notEqual(hashFiles(tmp, ["h2/a.txt"]), beforeHash);
  });

  it("distinguishes same-named files in different dirs", () => {
    write("d1/same.txt", "one");
    write("d2/same.txt", "one");
    // Same content, different paths: the path is part of the hash.
    assert.notEqual(hashFiles(tmp, ["d1/same.txt"]), hashFiles(tmp, ["d2/same.txt"]));
  });

  it("throws on a missing file (a wrong profile, not a silent skip)", () => {
    assert.throws(() => hashFiles(tmp, ["nope.txt"]));
  });
});

describe("stage cache", () => {
  it("misses on first run, hits after write, misses on changed hash", () => {
    const dir = path.join(tmp, "cache");
    assert.equal(readStageCache(dir, "build"), null);
    assert.equal(stageNeedsRun(dir, "build", "abc"), true);
    writeStageCache(dir, "build", "abc");
    assert.equal(readStageCache(dir, "build"), "abc");
    assert.equal(stageNeedsRun(dir, "build", "abc"), false);
    assert.equal(stageNeedsRun(dir, "build", "def"), true);
  });
});

describe("manifest", () => {
  it("round-trips: build then verify passes", () => {
    write("m/a.txt", "data");
    const m = buildManifest(tmp, "test", ["m/a.txt"]);
    assert.equal(m.profile, "test");
    assert.equal(m.files.length, 1);
    const v = verifyManifest(tmp, m);
    assert.equal(v.ok, true);
    assert.deepEqual(v.problems, []);
  });

  it("detects a tampered file", () => {
    write("m2/a.txt", "data");
    const m = buildManifest(tmp, "test", ["m2/a.txt"]);
    write("m2/a.txt", "tampered");
    const v = verifyManifest(tmp, m);
    assert.equal(v.ok, false);
    assert.ok(v.problems.length > 0);
  });

  it("detects a missing file", () => {
    write("m3/a.txt", "data");
    const m = buildManifest(tmp, "test", ["m3/a.txt"]);
    fs.rmSync(path.join(tmp, "m3/a.txt"));
    const v = verifyManifest(tmp, m);
    assert.equal(v.ok, false);
  });
});

describe("checkHealth", () => {
  let server: http.Server;
  let url200: string;
  let url500: string;
  before(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url === "/health") {
            res.writeHead(200).end("ok");
          } else if (req.url === "/sick") {
            res.writeHead(500).end("bad");
          } else if (req.url === "/slow") {
            // never responds: client must time out
          } else {
            res.writeHead(404).end();
          }
        });
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          url200 = `http://127.0.0.1:${port}/health`;
          url500 = `http://127.0.0.1:${port}/sick`;
          resolve();
        });
      }),
  );
  after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it("true on 200", async () => {
    assert.equal(await checkHealth(url200), true);
  });

  it("false on 500", async () => {
    assert.equal(await checkHealth(url500), false);
  });

  it("false on refused connection", async () => {
    assert.equal(await checkHealth("http://127.0.0.1:1/health", 500), false);
  });

  it("false on timeout", async () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    assert.equal(await checkHealth(`http://127.0.0.1:${port}/slow`, 300), false);
  });
});

describe("sha256 format", () => {
  it("is documented: sha256 over sorted 'relPath\\n' + bytes per file", () => {
    write("s/a.txt", "abc");
    const manual = createHash("sha256").update("s/a.txt\n").update("abc").digest("hex");
    assert.equal(hashFiles(tmp, ["s/a.txt"]), manual);
  });
});
