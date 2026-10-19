/**
 * `npm run bake:all`: its options and the plan (which steps run, in what
 * order, which are already done). Pure, so it is unit-tested; the commands
 * themselves are in scripts/bake-all.mjs.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PATH_FLAGS } from "./bake-paths.mjs";

/** Dependency order: each step reads what the ones before it wrote. */
export const STEPS = [
  { id: "build", title: "compile the TypeScript the bakes run from", art: false },
  { id: "world", title: "terrain: survey, erosion, rivers, biomes -> world.db", art: false },
  { id: "loot", title: "loot pool -> loot/pool.jsonl", art: false },
  { id: "dungeons", title: "dungeon pool -> dungeons/*.dungeon.json", art: false },
  { id: "settlement", title: "town site selection + settlement manifest + scene", art: false },
  { id: "scale-fit", title: "per-model scale fit for the town's art", art: true },
  { id: "wildlife-plan", title: "wildlife ecology plan from the art", art: true },
  { id: "wildlife-models", title: "wildlife species -> model map", art: true },
  { id: "env", title: "the MMO_* block to start the server on this bake", art: false },
];
export const STEP_IDS = STEPS.map((s) => s.id);

const NUMBERS = { seed: [0, 0xffffffff], population: [20, 100000], sites: [1, 200] };

function stepList(name, raw) {
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) if (!STEP_IDS.includes(id)) throw new Error(`--${name}: unknown step "${id}" (steps: ${STEP_IDS.join(", ")})`);
  return ids;
}

/** @returns {{ options: object, pathFlags: Record<string,string> }} */
export function parseBakeArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        force: { type: "boolean" },
        "dry-run": { type: "boolean" },
        "auto-size": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        only: { type: "string" },
        skip: { type: "string" },
        seed: { type: "string" },
        population: { type: "string" },
        sites: { type: "string" },
        "settlement-id": { type: "string" },
        ...Object.fromEntries(PATH_FLAGS.map((f) => [f, { type: "string" }])),
      },
    });
  } catch (e) {
    throw new Error(`${e.message} (npm run bake:all -- --help)`);
  }
  const v = parsed.values;
  const num = (name, dflt) => {
    if (v[name] === undefined) return dflt;
    const n = Number(v[name]);
    const [lo, hi] = NUMBERS[name];
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${name} must be a whole number from ${lo} to ${hi} (got ${v[name]})`);
    return n;
  };
  const only = v.only === undefined ? null : stepList("only", v.only);
  const skip = v.skip === undefined ? [] : stepList("skip", v.skip);
  if (only && only.some((id) => skip.includes(id))) throw new Error(`--only and --skip both name ${only.filter((id) => skip.includes(id)).join(", ")}`);
  const options = {
    force: !!v.force,
    dryRun: !!v["dry-run"],
    autoSize: !!v["auto-size"],
    help: !!v.help,
    only,
    skip,
    seed: num("seed", 1234),
    population: num("population", 600),
    sites: v.sites === undefined || v.sites === "max" ? "max" : num("sites", 1),
    settlementId: v["settlement-id"] ?? "0001",
  };
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(options.settlementId)) throw new Error(`--settlement-id must be letters, digits, - or _ (got ${options.settlementId})`);
  const pathFlags = Object.fromEntries(PATH_FLAGS.filter((f) => v[f] !== undefined).map((f) => [f, v[f]]));
  return { options, pathFlags };
}

/** "0182" x 3 -> 0182, 0183, 0184 (width kept); "town" x 2 -> town, town-2. */
export function settlementIds(base, n) {
  if (n === "max") throw new Error('settlementIds: the site count is still "max" (the settlement step resolves it first)');
  return Array.from({ length: n }, (_, i) => settlementId(base, i));
}

/** The id of town k (0-based): the first is the base, then 0183, 0184 ... (or town-2, town-3). */
export function settlementId(base, k) {
  return /^(\d+)$/.test(base) ? String(Number(base) + k).padStart(base.length, "0") : k === 0 ? base : `${base}-${k + 1}`;
}

/** Populations to try, largest first: the requested size, then the fixed smaller ones with --auto-size. */
export const sizeLadder = (population, autoSize) => (autoSize ? [population, ...[600, 300, 100].filter((s) => s < population)] : [population]);

export const realFs = {
  exists: existsSync,
  hasDungeons: (dir) => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".dungeon.json")),
};

/**
 * @returns {{ id, title, status, reason? }[]} in step order. status: "run", "done" (outputs exist; --force reruns),
 * "unselected" (not in --only), "skipped" (--skip), "no-catalog" (needs the art catalog, which is missing).
 */
export function planSteps(options, paths, fsv = realFs) {
  const chosen = options.only ? new Set(options.only) : new Set(STEP_IDS);
  // The compiled bakes are a prerequisite of every other step, so --only keeps the build unless it is skipped.
  if (options.only && options.only.some((id) => id !== "env")) chosen.add("build");
  // "max" is only known after a survey (the settlement step asks the world), so its outputs can't be checked ahead.
  const ids = options.sites === "max" ? null : settlementIds(options.settlementId, options.sites);
  const done = {
    world: () => fsv.exists(join(paths.dataDir, "world.db")),
    loot: () => fsv.exists(join(paths.dataDir, "loot", "pool.jsonl")),
    dungeons: () => fsv.hasDungeons(join(paths.dataDir, "dungeons")),
    settlement: () => ids !== null && ids.every((id) => fsv.exists(join(paths.settlementOut, `${id}.settlement.json`)) && fsv.exists(join(paths.scenesDir, `settlement-${id}.scene.json`))),
    "scale-fit": () => fsv.exists(paths.scaleOut),
    "wildlife-plan": () => fsv.exists(paths.ecologyOut),
    "wildlife-models": () => fsv.exists(paths.wildlifeModelsOut),
  };
  return STEPS.map(({ id, title, art }) => {
    const step = { id, title };
    if (options.skip.includes(id)) return { ...step, status: "skipped" };
    if (!chosen.has(id)) return { ...step, status: "unselected" };
    if (art && !paths.hasCatalog) return { ...step, status: "no-catalog", reason: `no art catalog at ${paths.catalog} (set MMO_CATALOG or MMO_ASSETS_DIR)` };
    if (!options.force && done[id]?.()) return { ...step, status: "done", reason: "outputs exist; --force rebuilds" };
    return { ...step, status: "run" };
  });
}
