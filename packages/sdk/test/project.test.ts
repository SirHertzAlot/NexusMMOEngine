import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import {
  ENGINE_ROOT,
  GAME_MANIFEST_ENV,
  ManifestError,
  SEAMS,
  SEAM_BY_KEY,
  SEAM_KEYS,
  findManifest,
  loadManifest,
  openGameProject,
} from "../src/index.js";

/** A project folder with a manifest in it. */
const withManifest = (manifest: unknown, extra: readonly string[] = []): string => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-game-"));
  writeFileSync(join(dir, "game.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
  for (const d of extra) mkdirSync(join(dir, d), { recursive: true });
  return dir;
};

describe("the seam table", () => {
  it("has a unique key per seam and no empty default", () => {
    assert.equal(new Set(SEAM_KEYS).size, SEAM_KEYS.length);
    for (const seam of SEAMS) {
      assert.ok(seam.rel.length > 0, `${seam.key} has no default`);
      assert.ok(!seam.rel.startsWith("/"), `${seam.key}'s default should be relative`);
      assert.ok(!seam.rel.includes("\\"), `${seam.key}'s default should be POSIX form`);
      assert.ok(seam.what.length > 0, `${seam.key} says nothing about what it is`);
    }
  });

  it("never gives one variable to two seams", () => {
    const seen = new Map<string, string>();
    for (const seam of SEAMS) {
      for (const name of seam.env) {
        const other = seen.get(name);
        assert.equal(other, undefined, `${name} is read by both ${other} and ${seam.key}`);
        seen.set(name, seam.key);
      }
    }
  });
});

describe("no manifest", () => {
  it("resolves every seam under the checkout, and says so", () => {
    const p = openGameProject({ env: {}, cwd: ENGINE_ROOT, exists: () => false });
    assert.equal(p.manifestFile, undefined);
    assert.equal(p.name, "engine defaults");
    assert.equal(p.root, ENGINE_ROOT);
    assert.equal(p.contentDir, join(ENGINE_ROOT, "content"));
    assert.equal(p.assetsDir, join(ENGINE_ROOT, "assets"));
    assert.equal(p.engineContentDir, join(ENGINE_ROOT, "packages", "engine-core", "content"));
    for (const key of SEAM_KEYS) {
      assert.equal(p.sources[key], "default", `${key} should be a default here`);
      assert.equal(resolve(p.paths[key]), p.paths[key], `${key} should be absolute`);
    }
    assert.match(p.summary, /^game: engine defaults, content /);
    assert.doesNotMatch(p.summary, /paths? moved/);
  });

  it("is what MMO_GAME=0 forces, even with a manifest beside the engine", () => {
    const withGame = findManifest({}, ENGINE_ROOT, ENGINE_ROOT, () => true);
    assert.equal(withGame, join(ENGINE_ROOT, "game.json"));
    assert.equal(findManifest({ [GAME_MANIFEST_ENV]: "0" }, ENGINE_ROOT, ENGINE_ROOT, () => true), undefined);
  });

  it("stops rather than quietly ignoring a manifest that is not there", () => {
    assert.throws(
      () => findManifest({ [GAME_MANIFEST_ENV]: "elsewhere/game.json" }, ENGINE_ROOT, ENGINE_ROOT, () => false),
      /MMO_GAME=elsewhere\/game\.json: no manifest at /,
    );
  });
});

describe("a manifest", () => {
  it("moves the content root, and every content seam with it", () => {
    const dir = withManifest({ name: "survival", content: "game/content" });
    const p = openGameProject({ dir, env: {}, cwd: dir });
    assert.equal(p.name, "survival");
    assert.equal(p.root, dir);
    assert.equal(p.contentDir, join(dir, "game", "content"));
    assert.equal(p.paths.rulesDir, join(dir, "game", "content", "rules"));
    assert.equal(p.paths.scenesDir, join(dir, "game", "content", "scenes"));
    assert.equal(p.paths.combatFile, join(dir, "game", "content", "combat", "moves.json"));
    assert.equal(p.sources.contentDir, "manifest");
    // Seams that are the engine's own stay the engine's.
    assert.equal(p.paths.biomesFile, join(ENGINE_ROOT, "packages", "engine-core", "content", "biomes.json"));
    assert.equal(p.paths.modulesDir, join(ENGINE_ROOT, "modules"));
  });

  it("takes a per-seam path, relative to the content root or absolute", () => {
    const dir = withManifest({ name: "g", paths: { rulesDir: "my-rules", biomesFile: "/srv/biomes.json" } });
    const p = openGameProject({ dir, env: {}, cwd: dir });
    assert.equal(p.paths.rulesDir, join(dir, "content", "my-rules"));
    assert.equal(p.sources.rulesDir, "manifest");
    assert.equal(p.paths.biomesFile, resolve("/srv/biomes.json"));
    assert.equal(p.sources.biomesFile, "manifest");
    assert.equal(p.sources.scenesDir, "default");
  });

  it("names its hooks module, relative to the content root", () => {
    const dir = withManifest({ name: "g", hooks: "rules/hooks.mjs" });
    assert.equal(openGameProject({ dir, env: {}, cwd: dir }).hooksFile, join(dir, "content", "rules", "hooks.mjs"));
    const none = withManifest({ name: "g" });
    assert.equal(openGameProject({ dir: none, env: {}, cwd: none }).hooksFile, undefined);
  });

  it("reports every problem at once, by field", () => {
    const dir = withManifest({ content: "", paths: { nonsense: "x" }, extra: 1 });
    let err: ManifestError | undefined;
    try {
      openGameProject({ dir, env: {}, cwd: dir });
    } catch (caught) {
      assert.ok(caught instanceof ManifestError, `expected a ManifestError, got ${String(caught)}`);
      err = caught;
    }
    assert.ok(err, "a manifest with three problems should not load");
    const all = err.problems.join("\n");
    assert.match(all, /name/);
    assert.match(all, /content: must not be empty/);
    assert.match(all, /unknown key/);
    assert.ok(err.problems.length >= 3, `expected several problems, got ${err.problems.length}: ${all}`);
  });

  it("names the file when it is not JSON", () => {
    const dir = withManifest("{ not json");
    assert.throws(() => openGameProject({ dir, env: {}, cwd: dir }), /game\.json: is not valid JSON/);
  });

  it("is found beside the engine when nothing names one", () => {
    const dir = withManifest({ name: "beside" });
    const p = openGameProject({ dir, env: {}, cwd: dir });
    assert.equal(p.manifestFile, join(dir, "game.json"));
    assert.equal(p.manifest?.name, "beside");
    assert.ok(p.summary.startsWith(`game: beside (${join(dir, "game.json")}), content `), p.summary);
  });
});

describe("the variables still win", () => {
  it("over a manifest, per seam", () => {
    const dir = withManifest({ name: "g", content: "game", paths: { rulesDir: "manifest-rules" } });
    const p = openGameProject({ dir, env: { MMO_RULES: "/etc/rules" }, cwd: dir });
    assert.equal(p.paths.rulesDir, resolve("/etc/rules"));
    assert.equal(p.sources.rulesDir, "env:MMO_RULES");
    assert.equal(p.paths.scenesDir, join(dir, "game", "scenes"));
  });

  it("over the content root", () => {
    const dir = withManifest({ name: "g", content: "game" });
    const p = openGameProject({ dir, env: { MMO_CONTENT_DIR: "/srv/content" }, cwd: dir });
    assert.equal(p.contentDir, resolve("/srv/content"));
    assert.equal(p.sources.contentDir, "env:MMO_CONTENT_DIR");
    assert.equal(p.paths.lessonsFile, resolve("/srv/content/lessons.json"));
  });

  it("resolve a relative value from where the command was run, not the repo", () => {
    const p = openGameProject({ env: { MMO_RULES: "./rules" }, cwd: "/tmp/run-here", exists: () => false });
    assert.equal(p.paths.rulesDir, join(`${sep}tmp`, "run-here", "rules"));
  });

  it("read the aliases in the order the engine always has", () => {
    assert.deepEqual(SEAM_BY_KEY.scenesDir.env, ["MMO_SCENES", "MMO_SCENES_DIR"]);
    const both = openGameProject({ env: { MMO_SCENES: "/a", MMO_SCENES_DIR: "/b" }, cwd: "/", exists: () => false });
    assert.equal(both.paths.scenesDir, resolve("/a"));
    const second = openGameProject({ env: { MMO_SCENES_DIR: "/b" }, cwd: "/", exists: () => false });
    assert.equal(second.paths.scenesDir, resolve("/b"));
    assert.equal(second.sources.scenesDir, "env:MMO_SCENES_DIR");
  });

  it("ignore an empty value, which has always counted as unset", () => {
    const p = openGameProject({ env: { MMO_RULES: "" }, cwd: ENGINE_ROOT, exists: () => false });
    assert.equal(p.paths.rulesDir, join(ENGINE_ROOT, "content", "rules"));
    assert.equal(p.sources.rulesDir, "default");
  });

  it("ignore an on/off value where the variable is also a flag", () => {
    // MMO_WILDLIFE=1 means "plan the table", not "read ./1".
    assert.equal(SEAM_BY_KEY.wildlifeTableFile.flagLike, true);
    const on = openGameProject({ env: { MMO_WILDLIFE: "1" }, cwd: ENGINE_ROOT, exists: () => false });
    assert.equal(on.paths.wildlifeTableFile, join(ENGINE_ROOT, "packages", "engine-core", "content", "wildlife", "wildlife.json"));
    assert.equal(on.sources.wildlifeTableFile, "default");
    const file = openGameProject({ env: { MMO_WILDLIFE: "/srv/wild.json" }, cwd: ENGINE_ROOT, exists: () => false });
    assert.equal(file.paths.wildlifeTableFile, resolve("/srv/wild.json"));
  });

  it("refuse a value that cannot be a path", () => {
    assert.throws(() => openGameProject({ env: { MMO_RULES: "a\0b" }, cwd: "/", exists: () => false }), /MMO_RULES: not a path/);
  });
});

describe("the layout hash", () => {
  const hashOf = (env: NodeJS.ProcessEnv, dir?: string): string => openGameProject({ dir, env, cwd: dir ?? ENGINE_ROOT, exists: dir ? undefined : () => false }).layoutHash;

  it("is stable for the same layout and changes when a path moves", () => {
    const a = hashOf({});
    assert.equal(a, hashOf({}));
    assert.notEqual(a, hashOf({ MMO_RULES: "/srv/rules" }));
  });

  it("is the same for two regions started with the same relative layout", () => {
    const one = withManifest({ name: "same", content: "game/content" });
    const two = withManifest({ name: "same", content: "game/content" });
    assert.notEqual(one, two);
    assert.equal(hashOf({}, one), hashOf({}, two));
  });

  it("differs when the game's name differs, so a mismatched region shows", () => {
    const one = withManifest({ name: "nexus", content: "game/content" });
    const two = withManifest({ name: "other", content: "game/content" });
    assert.notEqual(hashOf({}, one), hashOf({}, two));
  });

  it("is in the summary, with what moved", () => {
    const p = openGameProject({ env: { MMO_RULES: "/srv/rules" }, cwd: ENGINE_ROOT, exists: () => false });
    assert.match(p.summary, /1 path moved: rulesDir/);
    assert.match(p.summary, new RegExp(`layout ${p.layoutHash.slice(0, 12)}$`));
  });
});

describe("per-module settings", () => {
  it("are empty with no manifest, and spreadable either way", () => {
    const p = openGameProject({ env: {}, cwd: ENGINE_ROOT, exists: () => false });
    assert.deepEqual(p.moduleConfig, {});
    assert.deepEqual({ ...p.moduleSettings("residents") }, {});
  });

  it("reach the host by module name, with the module's own keys", () => {
    const dir = withManifest({
      name: "g",
      modules: { residents: { maxEntities: 1200, fullM: 60 }, "my-own-module": { anything: [1, 2] } },
    });
    const p = openGameProject({ dir, env: {}, cwd: dir });
    assert.deepEqual({ ...p.moduleSettings("residents") }, { maxEntities: 1200, fullM: 60 });
    assert.deepEqual({ ...p.moduleSettings("my-own-module") }, { anything: [1, 2] });
    assert.deepEqual({ ...p.moduleSettings("not-configured") }, {});
  });

  it("are frozen, so one module cannot edit another's settings at runtime", () => {
    const dir = withManifest({ name: "g", modules: { residents: { maxEntities: 1200 } } });
    const p = openGameProject({ dir, env: {}, cwd: dir });
    assert.throws(() => {
      (p.moduleSettings("residents") as Record<string, unknown>).maxEntities = 1;
    }, TypeError);
  });

  it("refuse a block that is not an object of settings", () => {
    const dir = withManifest({ name: "g", modules: { residents: 1200 } });
    assert.throws(() => openGameProject({ dir, env: {}, cwd: dir }), /modules\.residents/);
  });

  it("stay out of the layout hash, which is about where files are read from", () => {
    const plain = withManifest({ name: "same", content: "c" });
    const tuned = withManifest({ name: "same", content: "c", modules: { residents: { maxEntities: 9 } } });
    assert.equal(
      openGameProject({ dir: plain, env: {}, cwd: plain }).layoutHash,
      openGameProject({ dir: tuned, env: {}, cwd: tuned }).layoutHash,
    );
  });
});

describe("loadManifest", () => {
  it("accepts a manifest with nothing but a name", () => {
    assert.deepEqual(loadManifest("x.json", () => '{"name":"bare"}'), { name: "bare" });
  });

  it("keeps every path key the table knows", () => {
    const paths = Object.fromEntries(SEAM_KEYS.map((k) => [k, `somewhere/${k}`]));
    const m = loadManifest("x.json", () => JSON.stringify({ name: "all", paths }));
    assert.deepEqual(Object.keys(m.paths ?? {}).sort(), [...SEAM_KEYS].sort());
  });
});
