import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolvePaths } from "../lib/bake-paths.mjs";
import { STEP_IDS, parseBakeArgs, planSteps, settlementIds, sizeLadder } from "../lib/bake-plan.mjs";

const repo = resolve("/r");
const paths = (catalog = true) => resolvePaths({ env: {}, flags: {}, initCwd: repo, repo, exists: (f) => catalog || !f.endsWith("catalog.json") });
const nothing = { exists: () => false, hasDungeons: () => false };
const everything = { exists: () => true, hasDungeons: () => true };
const plan = (argv, fsv = nothing, p = paths()) => planSteps(parseBakeArgs(argv).options, p, fsv);
const ids = (steps, status) => steps.filter((s) => s.status === status).map((s) => s.id);

describe("parseBakeArgs", () => {
  it("defaults and flags", () => {
    const { options, pathFlags } = parseBakeArgs(["--force", "--sites", "2", "--seed", "7", "--data-dir", "d"]);
    assert.equal(options.force, true);
    assert.equal(options.sites, 2);
    assert.equal(options.seed, 7);
    assert.equal(options.population, 600);
    assert.equal(options.settlementId, "0001");
    assert.equal(pathFlags["data-dir"], "d");
  });
  it("--sites defaults to max (as many as the world supports) and takes a number or max", () => {
    assert.equal(parseBakeArgs([]).options.sites, "max");
    assert.equal(parseBakeArgs(["--sites", "max"]).options.sites, "max");
    assert.equal(parseBakeArgs(["--sites", "40"]).options.sites, 40);
    assert.throws(() => parseBakeArgs(["--sites", "201"]), /--sites/);
    assert.throws(() => parseBakeArgs(["--sites", "lots"]), /--sites/);
  });
  it("rejects unknown steps and bad numbers", () => {
    assert.throws(() => parseBakeArgs(["--only", "nope"]), /unknown step "nope".*world/s);
    assert.throws(() => parseBakeArgs(["--skip", "x"]), /unknown step/);
    assert.throws(() => parseBakeArgs(["--sites", "0"]), /--sites/);
    assert.throws(() => parseBakeArgs(["--population", "abc"]), /--population/);
    assert.throws(() => parseBakeArgs(["--only", "world", "--skip", "world"]), /both/);
    assert.throws(() => parseBakeArgs(["--bogus"]), /--bogus/);
  });
});

describe("planSteps", () => {
  it("runs in dependency order", () => {
    assert.deepEqual(STEP_IDS, ["build", "world", "loot", "dungeons", "settlement", "scale-fit", "wildlife-plan", "wildlife-models", "env"]);
    assert.deepEqual(plan([]).map((s) => s.id), STEP_IDS);
    assert.deepEqual(ids(plan([]), "run"), STEP_IDS);
  });
  it("is idempotent: what exists is skipped, unless --force", () => {
    assert.deepEqual(ids(plan(["--sites", "1"], everything), "done"), ["world", "loot", "dungeons", "settlement", "scale-fit", "wildlife-plan", "wildlife-models"]);
    // With max the count is only known after a survey, so the settlement step runs (and skips towns that exist).
    assert.deepEqual(ids(plan([], everything), "done"), ["world", "loot", "dungeons", "scale-fit", "wildlife-plan", "wildlife-models"]);
    assert.deepEqual(ids(plan(["--force", "--sites", "1"], everything), "done"), []);
  });
  it("settlement is done only when every requested town exists", () => {
    const some = { exists: (f) => f.includes("0001"), hasDungeons: () => true };
    assert.equal(plan(["--sites", "2"], some).find((s) => s.id === "settlement").status, "run");
    assert.equal(plan(["--sites", "1"], some).find((s) => s.id === "settlement").status, "done");
  });
  it("--only keeps the named steps, plus the build they need", () => {
    const s = plan(["--only", "settlement,scale-fit"]);
    assert.deepEqual(ids(s, "run"), ["build", "settlement", "scale-fit"]);
    assert.ok(ids(s, "unselected").includes("world"));
    assert.deepEqual(ids(plan(["--only", "env"]), "run"), ["env"]);
  });
  it("--skip drops steps, and --skip build drops the build", () => {
    assert.ok(!ids(plan(["--skip", "dungeons,wildlife-plan"]), "run").includes("dungeons"));
    assert.ok(!ids(plan(["--skip", "build"]), "run").includes("build"));
  });
  it("without a catalog, art steps are skipped with a reason", () => {
    const s = plan([], nothing, paths(false));
    assert.deepEqual(ids(s, "no-catalog"), ["scale-fit", "wildlife-plan", "wildlife-models"]);
    assert.equal(s.find((x) => x.id === "settlement").status, "run");
    assert.match(s.find((x) => x.id === "scale-fit").reason, /catalog/);
  });
});

describe("settlement ids and sizes", () => {
  it("numeric ids count up keeping their width; others get a suffix", () => {
    assert.deepEqual(settlementIds("0182", 3), ["0182", "0183", "0184"]);
    assert.deepEqual(settlementIds("0009", 2), ["0009", "0010"]);
    assert.deepEqual(settlementIds("town", 2), ["town", "town-2"]);
  });
  it("--auto-size tries the requested size, then smaller fixed sizes", () => {
    assert.deepEqual(sizeLadder(600, true), [600, 300, 100]);
    assert.deepEqual(sizeLadder(250, true), [250, 100]);
    assert.deepEqual(sizeLadder(600, false), [600]);
    assert.deepEqual(sizeLadder(80, true), [80]);
  });
});
