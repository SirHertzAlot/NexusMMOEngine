// Ragdoll cost gate: builds bench/ragdoll-cost.cpp against the addon's
// compiled Jolt objects, runs it, prints a table, and writes
// docs/ragdoll-cost-results.json.
//
// Needs the addon built first (`npx node-gyp rebuild` in this package) and a
// C++17 compiler: $CXX, or `c++`. Linux and macOS.
//
//   npm run bench:ragdoll               full sweep; writes the results file
//   npm run bench:ragdoll -- --quick    three counts, one repeat; no file

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
const raw = execFileSync(binary, quick ? ["--quick"] : [], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  maxBuffer: 1 << 26,
});
const { repeats, rows } = JSON.parse(raw);

const round = (value) => Number(value.toFixed(2));
const baseline = new Map(
  rows.filter((row) => row.ragdolls === 0).map((row) => [row.scenario, row.meanUs]),
);
const table = rows.map((row) => ({
  ...row,
  msPerStep: round(row.meanUs / 1000),
  usPerRagdoll:
    row.ragdolls === 0
      ? 0
      : round((row.meanUs - baseline.get(row.scenario)) / row.ragdolls),
  tickShare: round(row.meanUs / 1000 / TICK_MS),
}));

console.log(
  "scenario  ragdolls   bodies  ms/step  p95 ms  us/ragdoll  tick share  max m/s",
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
      `${((row.tickShare * 100).toFixed(1)).padStart(9)}%`,
      row.maxSpeed.toFixed(1).padStart(7),
    ].join("  "),
  );
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
    rows: table,
  };
  writeFileSync(resultsFile, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${relative(repo, resultsFile)}`);
}
