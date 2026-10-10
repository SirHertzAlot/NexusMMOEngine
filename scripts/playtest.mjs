/**
 * EA26 playtest CLI: run scenario documents headlessly.
 *
 * Usage:
 *   node scripts/playtest.mjs [scenario.json ...] [--replay-dir <dir>]
 *   node scripts/playtest.mjs --all [--replay-dir <dir>]
 *
 * Exit 0 when every scenario passes, 1 otherwise. Failures save a replay
 * (scenario + seed) that reproduces the failure tick for tick.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const replayDir = join(root, "dist", "replays");

async function main() {
  // Dynamic imports: the workspace must be built first.
  const { loadScenario, runScenario, saveReplay } = await import(
    "../packages/playtest/dist/src/index.js"
  );

  let files;
  if (args.includes("--all")) {
    const dir = join(root, "content", "playtests");
    if (!existsSync(dir)) {
      console.error("playtest: no content/playtests directory");
      process.exit(2);
    }
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(dir, f));
  } else {
    files = args.filter((a) => !a.startsWith("--")).map((a) => resolve(a));
  }
  if (files.length === 0) {
    console.error("playtest: no scenarios (pass files or --all)");
    process.exit(2);
  }

  let failed = 0;
  for (const file of files) {
    const scenario = loadScenario(JSON.parse(readFileSync(file, "utf8")));
    process.stdout.write(`playtest: ${scenario.name} ... `);
    const result = await runScenario(scenario);
    if (result.passed) {
      console.log(`PASS (${result.ticks} ticks)`);
    } else {
      failed++;
      console.log(`FAIL`);
      for (const f of result.failures) console.log(`  - ${f}`);
      const replay = saveReplay(replayDir, scenario, {
        tick: result.ticks,
        reason: result.failures[0] ?? "unknown",
      });
      console.log(`  replay: ${replay}`);
    }
  }
  console.log(`playtest: ${files.length - failed}/${files.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`playtest: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
