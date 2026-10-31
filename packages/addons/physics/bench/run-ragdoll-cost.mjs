// Ragdoll cost gate: builds bench/ragdoll-cost.cpp against the addon's
// compiled Jolt objects, runs it for every configuration and ragdoll count,
// prints a table per configuration, and writes docs/ragdoll-cost-results.json.
//
// Needs the addon built first (`npx node-gyp rebuild` in this package) and a
// C++17 compiler: $CXX, or `c++`. Linux and macOS.
//
//   npm run bench:ragdoll               full sweep; writes the results file
//   npm run bench:ragdoll -- --quick    three counts, one repeat, every run; no file

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const repo = join(pkg, "..", "..", "..");
const objRoot = join(pkg, "build", "Release", "obj.target");
const joltDir = join(pkg, "third_party", "JoltPhysics");
const source = join(here, "ragdoll-cost.cpp");
const outDir = join(pkg, "build", "bench");
const binary = join(outDir, "ragdoll-cost");
const resultsFile = join(repo, "docs", "ragdoll-cost-results.json");
const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;
const quick = process.argv.includes("--quick");
const cxx = process.env.CXX ?? "c++";

// `production` is the engine's own tick: two substeps (engine-core's
// PhysicsSystem runs subSteps = 2) and the addon's limits. `main` is the
// bench's own default: one substep and its own limits. `substeps2` isolates the
// substeps (against `main`) and the limits (against `production`). The other
// runs change one thing from `production`, so their row against it reads as
// that change's measured effect.
const RUNS = [
  {
    name: "main",
    about: "Bench defaults: one substep, 64 MB temp allocator, 65,536 contacts",
    args: [],
  },
  {
    name: "substeps2",
    about: "Two substeps with the bench's own limits",
    args: ["--substeps", "2"],
  },
  {
    name: "production",
    about: "The engine's tick: two substeps, 10 MB temp allocator, 10,240 contacts",
    args: ["--substeps", "2", "--production-limits"],
  },
  {
    name: "threads4",
    about: "Production on a four-thread Jolt job pool",
    args: ["--substeps", "2", "--production-limits", "--threads", "4"],
  },
  {
    name: "light",
    about: "Production with the five-body rig: no arms, one capsule per leg",
    args: ["--substeps", "2", "--production-limits", "--rig", "light"],
  },
  {
    name: "sleep0.1",
    about: "Production with bodies asleep after 0.1 s at rest, not 0.5 s",
    args: ["--substeps", "2", "--production-limits", "--sleep-time", "0.1"],
  },
];
const COUNTS = quick ? [0, 16, 64] : [0, 8, 16, 32, 64, 128, 256, 512, 1000];

// EPhysicsUpdateError bits, lowest first: the caches and buffers that filled.
const LIMIT_NAMES = ["manifold", "pairs", "contacts"];

if (!existsSync(objRoot)) {
  throw new Error(
    "The physics addon is not built. Run `npx node-gyp rebuild` in packages/addons/physics first.",
  );
}

// The Jolt objects of the addon build. The N-API shim and the wrapper are left
// out: the bench sets up its own world, so it links neither.
function objectFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return objectFiles(path);
    return entry.name.endsWith(".o") ? [path] : [];
  });
}
const joltObjects = objectFiles(objRoot).filter((file) => {
  const top = relative(objRoot, file).split(sep)[1];
  return top !== "src" && top !== "native";
});

mkdirSync(outDir, { recursive: true });
execFileSync(
  cxx,
  [
    "-std=c++17",
    "-O3",
    "-DNDEBUG",
    "-fno-exceptions",
    "-pthread",
    "-I",
    joltDir,
    source,
    ...joltObjects,
    "-o",
    binary,
  ],
  { stdio: "inherit" },
);

const compiler = execFileSync(cxx, ["--version"], { encoding: "utf8" }).split(
  "\n",
)[0];

// One process per configuration and ragdoll count, so a count that aborts is
// recorded as a failure and the sweep goes on.
function runCount(run, count) {
  const args = [...run.args, "--counts", String(count)];
  if (quick) args.push("--quick");
  try {
    const raw = execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 1 << 26,
    });
    return { report: JSON.parse(raw) };
  } catch (error) {
    const reason = error.signal ? `signal ${error.signal}` : `exit ${error.status}`;
    console.log(`  ${run.name}: ${count} ragdolls failed (${reason})`);
    return { failure: { ragdolls: count, reason } };
  }
}

const round = (value) => Number(value.toFixed(2));

// Ms per step, cost per ragdoll (against the same scenario's zero-rig row) and
// the share of the 30 Hz tick.
function tabulate(rows) {
  const baseline = new Map(
    rows.filter((row) => row.ragdolls === 0).map((row) => [row.scenario, row.meanUs]),
  );
  return rows.map((row) => ({
    ...row,
    msPerStep: round(row.meanUs / 1000),
    usPerRagdoll:
      row.ragdolls === 0
        ? 0
        : round((row.meanUs - baseline.get(row.scenario)) / row.ragdolls),
    tickShare: round(row.meanUs / 1000 / TICK_MS),
  }));
}

function limitText(bits) {
  const names = LIMIT_NAMES.filter((_, bit) => bits & (1 << bit));
  return names.length > 0 ? names.join("+") : "-";
}

function printTable(table) {
  console.log(
    "scenario  ragdolls   bodies  ms/step  p95 ms  us/ragdoll  tick share  max m/s     limits hit",
  );
  for (const row of table) {
    console.log(
      [
        row.scenario.padEnd(8),
        String(row.ragdolls).padStart(8),
        String(row.bodies).padStart(8),
        row.msPerStep.toFixed(3).padStart(7),
        (row.p95Us / 1000).toFixed(3).padStart(6),
        row.usPerRagdoll.toFixed(1).padStart(10),
        `${(row.tickShare * 100).toFixed(1)}%`.padStart(10),
        row.maxSpeed.toFixed(1).padStart(7),
        limitText(row.updateErrors).padStart(14),
      ].join("  "),
    );
  }
}

const runs = [];
let repeats = null;
for (const run of RUNS) {
  console.log(`\n${run.name}: ${run.about}`);
  const rows = [];
  const failures = [];
  let options = null;
  for (const count of COUNTS) {
    const result = runCount(run, count);
    if (result.failure) {
      failures.push(result.failure);
      continue;
    }
    const { report } = result;
    repeats ??= report.repeats;
    options ??= {
      rig: report.rig,
      rigBodies: report.rigBodies,
      substeps: report.substeps,
      threads: report.threads,
      sleepTime: report.sleepTime,
      productionLimits: report.productionLimits,
    };
    rows.push(...report.rows);
  }
  const table = tabulate(rows);
  printTable(table);
  runs.push({ name: run.name, about: run.about, options, rows: table, failures });
}

if (!quick) {
  const doc = {
    generated: new Date().toISOString(),
    machine: {
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      node: process.version,
      compiler,
    },
    tickHz: TICK_HZ,
    repeats,
    counts: COUNTS,
    runs,
  };
  writeFileSync(resultsFile, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nwrote ${relative(repo, resultsFile)}`);
}
