/**
 * build-profiles: profile files under content/build/profiles are validated
 * before they are written, and a refused save writes nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteProfileFile, profilesDir, saveProfileFile, ProfileError } from "../src/build-profiles.js";
import { createBuildHost, loadProfiles } from "../src/build-host.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "build-profiles-"));
  mkdirSync(join(root, "content", "rules"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  return root;
}

const doc = (over: Record<string, unknown> = {}) => ({
  name: "quick",
  stages: [{ id: "test", command: "npm test", inputs: ["package.json", "content/rules"] }],
  ...over,
});

describe("saveProfileFile", () => {
  it("writes a valid profile where loadProfiles finds it", () => {
    const root = repo();
    try {
      saveProfileFile(root, doc());
      assert.deepEqual(JSON.parse(readFileSync(join(profilesDir(root), "quick.json"), "utf8")), doc());
      assert.deepEqual(loadProfiles(root).map((p) => p.name), ["default", "quick"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses each kind of bad profile and writes nothing", () => {
    const root = repo();
    try {
      const bad: Array<[unknown, RegExp]> = [
        [doc({ name: "Quick Build" }), /name:/],
        [doc({ name: "default" }), /built-in/],
        [doc({ stages: [] }), /stages/],
        [doc({ stages: [{ id: "a", command: "x", inputs: ["../outside"] }] }), /inside the repo/],
        [doc({ stages: [{ id: "a", command: "x", inputs: ["/etc/passwd"] }] }), /inside the repo/],
        [doc({ stages: [{ id: "a", command: "x", inputs: ["nope.txt"] }] }), /does not exist/],
        [doc({ stages: [{ id: "a", command: "x", inputs: [] }, { id: "a", command: "y", inputs: [] }] }), /unique/],
        [null, /./],
      ];
      for (const [raw, why] of bad) {
        assert.throws(() => saveProfileFile(root, raw), (e: unknown) => e instanceof ProfileError && why.test(e.message), JSON.stringify(raw));
      }
      assert.equal(existsSync(profilesDir(root)), false, "nothing written");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes a profile file, but never the built-in one", () => {
    const root = repo();
    try {
      saveProfileFile(root, doc());
      assert.equal(deleteProfileFile(root, "quick"), true);
      assert.equal(deleteProfileFile(root, "quick"), false);
      assert.throws(() => deleteProfileFile(root, "default"), ProfileError);
      assert.throws(() => deleteProfileFile(root, "../x"), ProfileError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the build host and profile files", () => {
  it("saving and deleting changes the listed profiles; a run can bypass the cache", async () => {
    const root = repo();
    try {
      const seen: Array<boolean | undefined> = [];
      const h = createBuildHost({
        rootDir: root,
        profiles: loadProfiles(root),
        runner: async (_r, _p, _on, opts) => void seen.push(opts?.fresh),
        deployer: async () => ({ ok: true, rolledBack: false }),
      });
      h.saveProfile(doc());
      assert.deepEqual(h.listProfiles().map((p) => p.name), ["default", "quick"]);
      h.saveProfile(doc({ description: "again" }));
      assert.equal(h.listProfiles().filter((p) => p.name === "quick").length, 1, "saving replaces by name");
      await h.waitFor(h.startRun("quick", { fresh: true }).id);
      await h.waitFor(h.startRun("quick").id);
      assert.deepEqual(seen, [true, undefined]);
      h.deleteProfile("quick");
      assert.deepEqual(h.listProfiles().map((p) => p.name), ["default"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
