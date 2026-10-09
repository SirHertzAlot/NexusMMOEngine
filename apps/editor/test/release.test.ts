/** Release (EA19): profile validation, the cached pipeline, the package, and the local target's deploy/rollback. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyProfile, manifestDiff, stepsFor, validateProfile, type BuildProfile, type PackageManifest } from "../src/release-model.js";
import { listProfiles, saveProfile } from "../src/release-host.js";
import { runPipeline, type Command, type PipelineDeps } from "../src/release-pipeline.js";
import { deploy, readState, rollback, type Health, type TargetDeps } from "../src/release-targets.js";

const put = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

function fakeRepo(): string {
  const r = mkdtempSync(join(tmpdir(), "mmo-release-"));
  put(join(r, "package.json"), JSON.stringify({ workspaces: ["packages/engine-core"] }));
  put(join(r, "packages/engine-core/package.json"), JSON.stringify({ name: "@mmo-engine/engine-core", version: "1.0.0", main: "dist/src/server.js" }));
  put(join(r, "packages/engine-core/tsconfig.json"), "{}");
  put(join(r, "packages/engine-core/src/server.ts"), "// server");
  put(join(r, "packages/engine-core/dist/src/server.js"), "// built");
  put(join(r, "packages/engine-core/dist/test/x.test.js"), "// test");
  // A developer's world and accounts: must never reach a package.
  put(join(r, "packages/engine-core/data/users.csv"), "SECRET");
  put(join(r, "packages/engine-core/data/world.db"), "SECRET");
  put(join(r, "packages/schema/mmo_engine.fbs"), "table T {}");
  put(join(r, "content/modules.json"), '{"modules":["core"]}');
  put(join(r, "content/rules/items.json"), "{}");
  put(join(r, "content/users.csv"), "SECRET");
  put(join(r, "modules/core/module.json"), "{}");
  return r;
}

const profile = (over: Partial<BuildProfile> = {}): BuildProfile => ({
  ...emptyProfile("t"),
  bakes: ["world"],
  modules: ["core", "characters"],
  ...over,
});

function deps(repoRoot: string, opts: { failOn?: string; valgrind?: boolean } = {}): PipelineDeps & { ran: string[] } {
  const ran: string[] = [];
  let clock = 1000;
  return {
    repoRoot,
    ran,
    now: () => (clock += 10),
    git: () => ({ commit: "abc1234", dirty: false }),
    hasValgrind: () => opts.valgrind ?? false,
    async exec(cmd: Command, onLine) {
      ran.push(cmd.label);
      onLine(`ran ${cmd.label}`);
      if (opts.failOn && cmd.label.includes(opts.failOn)) return 3;
      if (cmd.label === "node scripts/codegen.mjs") put(join(repoRoot, "packages/schema/generated/ts/x.ts"), "//");
      if (cmd.label === "bake-world") {
        // Like the real bake: it will not overwrite a world, so the pipeline must clear its own old one.
        if (existsSync(join(cmd.env?.MMO_DATA_DIR ?? "", "world.db"))) return 1;
        put(join(cmd.env?.MMO_DATA_DIR ?? "", "world.db"), "baked");
      }
      return 0;
    },
  };
}

describe("build profiles", () => {
  it("the shipped profiles are valid", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const found = listProfiles(root);
    assert.ok(found.length >= 2);
    for (const p of found) assert.deepEqual(p.issues, [], p.name);
  });

  it("validation lists every problem", () => {
    const bad = { ...emptyProfile("t"), name: "Other", target: "staging", build: [], modules: ["characters"], env: { PATH: "x", MMO_PORT: "99999", MMO_DATA_DIR: "/x" }, edge: "yes" };
    const issues = validateProfile(bad, "t").join("\n");
    for (const part of ["name", "target must be", "build needs", 'must include "core"', "env.PATH", "env.MMO_PORT", "env.MMO_DATA_DIR", "edge must be"]) assert.match(issues, new RegExp(part));
    assert.deepEqual(validateProfile(emptyProfile("t"), "t"), []);
  });

  it("a refused save writes nothing; a valid one round-trips", () => {
    const root = mkdtempSync(join(tmpdir(), "mmo-profiles-"));
    assert.throws(() => saveProfile(root, "t", { ...emptyProfile("t"), build: [] }), /invalid profile/);
    assert.ok(!existsSync(join(root, "content", "build", "t.json")));
    saveProfile(root, "t", emptyProfile("t"));
    assert.deepEqual(listProfiles(root).map((p) => [p.name, p.issues.length]), [["t", 0]]);
    rmSync(root, { recursive: true });
  });

  it("steps follow the profile", () => {
    assert.deepEqual(stepsFor(profile()), ["codegen", "build", "bake:world", "package"]);
    assert.deepEqual(stepsFor(profile({ tests: ["@mmo-engine/scene"], valgrind: { memcheck: [], perf: true, required: false }, bakes: ["world", "loot"] })), ["codegen", "build", "bake:world", "bake:loot", "test", "valgrind", "package"]);
  });
});

describe("pipeline", () => {
  it("runs every step once, then skips the unchanged ones, and reruns only what changed", async () => {
    const repo = fakeRepo();
    const d = deps(repo);
    const first = await runPipeline(d, profile());
    assert.equal(first.status, "passed");
    assert.deepEqual(first.steps.map((s) => s.status), ["passed", "passed", "passed", "passed"]);
    assert.ok(first.steps[1].log.some((l) => l.line.includes("npm run build")));

    d.ran.length = 0;
    const second = await runPipeline(d, profile());
    assert.deepEqual(second.steps.map((s) => s.status), ["cached", "cached", "cached", "cached"]);
    assert.deepEqual(d.ran, []);
    assert.equal(second.package, undefined);

    // Changing a content file reruns the bake and the package, not the build.
    put(join(repo, "content/rules/items.json"), '{"changed":1}');
    const third = await runPipeline(d, profile());
    assert.deepEqual(third.steps.map((s) => s.status), ["cached", "cached", "passed", "passed"]);
    assert.deepEqual(d.ran, ["bake-world"]);

    // A source change reruns the build too.
    put(join(repo, "packages/engine-core/src/server.ts"), "// edited");
    d.ran.length = 0;
    const fourth = await runPipeline(d, profile());
    assert.equal(fourth.steps[0].status, "cached");
    assert.equal(fourth.steps[1].status, "passed");

    // Force ignores the cache; a deleted bake output reruns that bake alone.
    d.ran.length = 0;
    await runPipeline(d, profile(), { force: true });
    assert.equal(d.ran.length, 3);
    rmSync(join(repo, ".release/work/t/data/world.db"));
    d.ran.length = 0;
    await runPipeline(d, profile());
    assert.deepEqual(d.ran, ["bake-world"]);
    rmSync(repo, { recursive: true });
  });

  it("a failing step stops the run, is not cached, and skips the rest", async () => {
    const repo = fakeRepo();
    const run = await runPipeline(deps(repo, { failOn: "npm run build" }), profile());
    assert.equal(run.status, "failed");
    assert.deepEqual(run.steps.map((s) => s.status), ["passed", "failed", "skipped", "skipped"]);
    assert.match(run.steps[1].summary, /exited with code 3/);
    const again = await runPipeline(deps(repo), profile());
    assert.deepEqual(again.steps.map((s) => s.status), ["cached", "passed", "passed", "passed"]);
    rmSync(repo, { recursive: true });
  });

  it("valgrind is skipped, not passed, on a machine without it, and fails a profile that requires it", async () => {
    const repo = fakeRepo();
    const withV = profile({ valgrind: { memcheck: ["physics"], perf: false, required: false } });
    const run = await runPipeline(deps(repo), withV);
    const v = run.steps.find((s) => s.id === "valgrind");
    assert.equal(v?.status, "skipped");
    assert.match(v?.summary ?? "", /not installed/);
    assert.equal(run.status, "passed");
    const strict = await runPipeline(deps(repo), { ...withV, valgrind: { ...withV.valgrind, required: true } });
    assert.equal(strict.status, "failed");
    const ok = await runPipeline(deps(repo, { valgrind: true }), withV);
    assert.equal(ok.steps.find((s) => s.id === "valgrind")?.status, "passed");
    rmSync(repo, { recursive: true });
  });

  it("the package mirrors the runtime layout, carries the profile's modules and never a developer's accounts or world", async () => {
    const repo = fakeRepo();
    const run = await runPipeline(deps(repo), profile());
    const dir = join(repo, ".release/packages", run.package ?? "none");
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as PackageManifest;
    assert.equal(m.commit, "abc1234");
    assert.deepEqual(m.modules, ["core", "characters"]);
    assert.deepEqual(m.workspaces, ["@mmo-engine/engine-core"]);
    assert.ok(existsSync(join(dir, "packages/engine-core/dist/src/server.js")));
    assert.ok(!existsSync(join(dir, "packages/engine-core/dist/test")));
    assert.ok(!existsSync(join(dir, "packages/engine-core/src")));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "content/modules.json"), "utf8")), { modules: ["core", "characters"] });
    assert.equal(readFileSync(join(dir, "data/world.db"), "utf8"), "baked");
    assert.ok(existsSync(join(dir, "start.mjs")) && existsSync(join(dir, "env.json")));
    const all: string[] = [];
    const walk = (p: string): void => readdirSync(p, { withFileTypes: true }).forEach((e) => (e.isSymbolicLink() ? undefined : e.isDirectory() ? walk(join(p, e.name)) : all.push(e.name)));
    walk(dir);
    assert.ok(!all.includes("users.csv"), "users.csv copied");
    assert.ok(!readFileSync(join(dir, "data/world.db"), "utf8").includes("SECRET"));
    assert.ok(existsSync(join(dir, "node_modules/@mmo-engine/engine-core/package.json")), "workspace link");
    rmSync(repo, { recursive: true });
  });
});

describe("manifest diff", () => {
  const base: PackageManifest = { version: 1, name: "a", profile: "t", commit: "1", dirty: false, builtAt: 1, steps: { build: "x" }, modules: ["core"], env: { MMO_BOTS: "20" }, edge: false, workspaces: [], thirdParty: [], files: 1, bytes: 1 };
  it("lists what changed since the live release", () => {
    assert.deepEqual(manifestDiff(null, base), ["first deploy to this target"]);
    assert.deepEqual(manifestDiff(base, base), ["no changes"]);
    const d = manifestDiff(base, { ...base, commit: "2", modules: ["core", "goblin-ai"], env: { MMO_BOTS: "40" }, steps: { build: "y" } }).join("|");
    for (const part of ["commit 1 to 2", "modules added: goblin-ai", "MMO_BOTS: 20 to 40", "build inputs changed"]) assert.match(d, new RegExp(part));
  });
});

describe("local target", () => {
  async function setup(): Promise<{ repo: string; fake: TargetDeps & { started: string[]; stopped: number[]; broken: Set<string> } }> {
    const repo = fakeRepo();
    const names: string[] = [];
    for (const [i, bots] of ["20", "40", "60"].entries()) {
      const r = await runPipeline(deps(repo), profile({ env: { MMO_PORT: "7790", MMO_BOTS: bots } }));
      names.push(r.package ?? "");
      void i;
    }
    assert.equal(new Set(names).size, 3);
    const broken = new Set<string>();
    let pid = 100;
    const started: string[] = [];
    const stopped: number[] = [];
    const byPid = new Map<number, string>();
    const fake = {
      repoRoot: repo,
      started,
      stopped,
      broken,
      healthTimeoutMs: 50,
      now: Date.now,
      start(pkgDir: string) {
        const name = pkgDir.split(/[\\/]/).pop() as string;
        started.push(name);
        byPid.set(++pid, name);
        return pid;
      },
      async stop(p: number) {
        stopped.push(p);
        byPid.delete(p);
      },
      async health(): Promise<Health> {
        const live = [...byPid.values()].at(-1);
        const ok = live !== undefined && !broken.has(live);
        return { ok, server: { ok, detail: ok ? "up" : "down", port: 7790 } };
      },
    };
    (fake as unknown as { names: string[] }).names = names;
    return { repo, fake };
  }

  it("deploys, seeds the target's own data, keeps a history and rolls back", async () => {
    const { repo, fake } = await setup();
    const names = (fake as unknown as { names: string[] }).names;
    const a = await deploy(fake, names[0]);
    assert.equal(a.ok, true);
    assert.ok(existsSync(join(repo, ".release/targets/local/data/world.db")));
    assert.ok(!existsSync(join(repo, ".release/targets/local/data/users.csv")));
    const b = await deploy(fake, names[1]);
    assert.equal(b.live, names[1]);
    assert.equal(fake.stopped.length, 1, "the old release was stopped before the new one started");
    assert.deepEqual(readState(repo).releases.map((r) => [r.package, r.outcome]), [[names[1], "live"], [names[0], "replaced"]]);
    const back = await rollback(fake);
    assert.equal(back.ok, true);
    assert.equal(readState(repo).current, names[0]);
    assert.equal(readState(repo).releases[0].rollback, true);
    await assert.rejects(rollback(fake, "no-such-package"), /no package/);
    rmSync(repo, { recursive: true });
  });

  it("a release that fails its health check is stopped and the previous one runs again", async () => {
    const { repo, fake } = await setup();
    const names = (fake as unknown as { names: string[] }).names;
    await deploy(fake, names[0]);
    fake.broken.add(names[1]);
    const r = await deploy(fake, names[1]);
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, true);
    assert.equal(r.live, names[0]);
    assert.match(r.error ?? "", /failed its health check/);
    const s = readState(repo);
    assert.equal(s.current, names[0]);
    assert.deepEqual(s.releases.map((x) => [x.package, x.outcome]), [[names[1], "failed"], [names[0], "live"]]);
    rmSync(repo, { recursive: true });
  });
});
