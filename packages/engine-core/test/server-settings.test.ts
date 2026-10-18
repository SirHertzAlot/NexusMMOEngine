/** Server settings (EG13): content/server/persistence.json, its defaults (the old constants) and a bad file falling back. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PERSISTENCE_SETTINGS, DEFAULT_WORLD_SETTINGS, loadPersistenceSettings, loadWorldSettings, PersistenceSettingsSchema, WorldSettingsSchema } from "../src/server-settings.js";
import { DEFAULT_KEEP_SNAPSHOTS, DEFAULT_SAVE_EVERY_TICKS, DEFAULT_WAL_SIZE_LIMIT_BYTES } from "../src/persist/store.js";
import { QUERY_DEFAULT_ROWS, QUERY_DEFAULT_TIMEOUT_MS, QUERY_MAX_ROWS } from "../src/persist/persistence-core.js";

describe("persistence settings (EG13)", () => {
  it("the defaults are the old constants, and our file is the defaults", () => {
    const d = DEFAULT_PERSISTENCE_SETTINGS;
    assert.equal(d.saveEverySeconds * 30, DEFAULT_SAVE_EVERY_TICKS);
    assert.equal(d.keepSnapshots, DEFAULT_KEEP_SNAPSHOTS);
    assert.equal(d.walLimitMb * 1024 * 1024, DEFAULT_WAL_SIZE_LIMIT_BYTES);
    assert.equal(d.queryDefaultRows, QUERY_DEFAULT_ROWS);
    assert.equal(d.queryMaxRows, QUERY_MAX_ROWS);
    assert.equal(d.queryTimeoutSeconds * 1000, QUERY_DEFAULT_TIMEOUT_MS);
    assert.deepEqual(loadPersistenceSettings(), { settings: d, problem: null });
  });

  it("an absent file is the defaults; a bad one is reported and the defaults used", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-"));
    try {
      assert.deepEqual(loadPersistenceSettings(dir), { settings: DEFAULT_PERSISTENCE_SETTINGS, problem: null });
      fs.writeFileSync(path.join(dir, "persistence.json"), JSON.stringify({ saveEverySeconds: 30, keepSnapshots: 0 }));
      const r = loadPersistenceSettings(dir);
      assert.deepEqual(r.settings, DEFAULT_PERSISTENCE_SETTINGS);
      assert.match(r.problem ?? "", /keepSnapshots/);
      fs.writeFileSync(path.join(dir, "persistence.json"), JSON.stringify({ saveEverySeconds: 30 }));
      assert.equal(loadPersistenceSettings(dir).settings.saveEverySeconds, 30);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a default above the most rows", () => {
    const r = PersistenceSettingsSchema.safeParse({ queryDefaultRows: 600, queryMaxRows: 500 });
    assert.ok(!r.success && r.error.issues.some((i) => i.path.join(".") === "queryDefaultRows"));
  });
});

describe("world settings (EG14)", () => {
  it("the defaults are the old environment defaults, and our file is the defaults", () => {
    const d = DEFAULT_WORLD_SETTINGS;
    assert.equal(d.daySeconds, 2400);
    assert.equal(d.dayOffset, 0.35);
    assert.deepEqual(d.bots, { count: 0, home: null, radiusM: 18 });
    assert.deepEqual(loadWorldSettings(), { settings: d, problem: null });
  });

  it("an absent file is the defaults; a bad one is reported and the defaults used", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "world-"));
    try {
      assert.deepEqual(loadWorldSettings(dir), { settings: DEFAULT_WORLD_SETTINGS, problem: null });
      fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({ daySeconds: 600, dayOffset: 1.5 }));
      const r = loadWorldSettings(dir);
      assert.deepEqual(r.settings, DEFAULT_WORLD_SETTINGS);
      assert.match(r.problem ?? "", /dayOffset/);
      fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({ daySeconds: 600, bots: { count: 4, home: [10, -20] } }));
      const ok = loadWorldSettings(dir).settings;
      assert.equal(ok.daySeconds, 600);
      assert.deepEqual(ok.bots, { count: 4, home: [10, -20], radiusM: 18 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses unknown keys and a home that isn't two numbers", () => {
    assert.ok(!WorldSettingsSchema.safeParse({ seed: 5 }).success);
    assert.ok(!WorldSettingsSchema.safeParse({ bots: { home: [1] } }).success);
  });
});
