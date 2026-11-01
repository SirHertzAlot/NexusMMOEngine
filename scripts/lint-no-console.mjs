#!/usr/bin/env node
/**
 * `node scripts/lint-no-console.mjs`: the hygiene guard for the SAB logging
 * layer (docs/SAB-LOGGING-LAYER-SPEC.md §2.6).
 *
 * Diagnostics flow through the lock-free ring into the log worker; `console.*`
 * calls compete with the tick for the calling thread (formatting + stdio in a
 * syscall-class trap) and are therefore keyed to explicit, budgeted boundary
 * files only:
 *
 *  - the logger's own package (@mmo-engine/logging: codegen, stdio fallbacks),
 *  - CLI process boundaries whose stdout IS the product (bake tools, bench
 *    harnesses, seed-user, the sim's final report),
 *  - the two server entrypoints' boot banners and fatal handlers (the spec
 *    keeps boot banners and fatal errors on stdio on purpose: they must be
 *    visible even when the log worker is not up).
 *
 * Budgets pin the exact number of console occurrences per file. A NEW
 * console call anywhere else fails the run; a new call in a budgeted file
 * fails too until its number is raised deliberately. The count only moves
 * one way (down or with a comment explaining why).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** packages whose server sources the guard owns. */
const GUARDED = ["packages/engine-core", "packages/world-server"];

/** The logger's own tree: console here is the implementation of stdio. */
const EXEMPT_DIRS = [join(root, "packages", "logging", "src")];

/**
 * Process-boundary files, budgeted per current count. `justification` is why
 * stdio is correct there; budgets may only be RAISED together with it.
 */
const BUDGETS = [
  // Boot banners + fatal handler (docs/SAB-LOGGING-LAYER-SPEC.md §2.1 note in server.ts):
  // visible even when the log worker is not up.
  { file: "packages/engine-core/src/server.ts", budget: 36, justification: "boot banners + fatal, spec-kept on stdio; + the enemy models file problem line (EM1, boot only)" },
  { file: "packages/world-server/src/server.ts", budget: 6, justification: "boot banners + fatal, spec-kept on stdio" },
  // CLI products: stdout is the report.
  { file: "packages/engine-core/src/sim.ts", budget: 12, justification: "CLI: the verification report is the product" },
  { file: "packages/engine-core/src/bake-world.ts", budget: 16, justification: "CLI: bake progress report" },
  { file: "packages/engine-core/src/preview-world.ts", budget: 6, justification: "CLI: survey report" },
  { file: "packages/engine-core/src/items/rebake.ts", budget: 1, justification: "CLI: one-line bake report" },
  { file: "packages/engine-core/src/auth/seed-user.ts", budget: 5, justification: "CLI: seed tool usage/report" },
  { file: "packages/engine-core/src/procgen/wildlife-plan.ts", budget: 1, justification: "CLI: one-line table report" },
  { file: "packages/engine-core/src/procgen/wildlife-table.ts", budget: 2, justification: "CLI: artisan table report" },
  { file: "packages/engine-core/src/hybrid-data-plane-bench.ts", budget: 1, justification: "bench output as JSON" },
  { file: "packages/engine-core/src/sab-contention-bench.ts", budget: 17, justification: "bench report tables" },
  { file: "packages/engine-core/src/net/transport-bench.ts", budget: 2, justification: "bench report" },
  { file: "packages/world-server/src/host-sidecar.ts", budget: 5, justification: "standalone CLI process (no ring of its own)" },
];

const CONSOLE_CALL = /(?:^|[^\w$.])console\.(log|error|warn|info|debug|trace)\s*\(/;
// Comment-only hits still count: a console call is a line that exists, and a
// commented-out one is noise the count must not hide.

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

let failures = 0;
const budgetByAbs = new Map(
  BUDGETS.map((b) => [join(root, b.file), b]),
);

for (const pkg of GUARDED) {
  const files = walk(join(root, pkg, "src"), []);
  for (const file of files) {
    if (EXEMPT_DIRS.some((d) => file.startsWith(d))) continue;
    const rel = relative(root, file).split(sep).join("/");
    let count = 0;
    for (const [i, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
      if (CONSOLE_CALL.test(line)) {
        count++;
        // Budgeted files are checked once at the file level, below.
        if (!budgetByAbs.has(file)) {
          console.error(`[lint-no-console] ${rel}:${i + 1}: console call outside the logging layer (no budget recorded; see scripts/lint-no-console.mjs)`);
          failures++;
        }
      }
    }
    const b = budgetByAbs.get(file);
    if (b && count > b.budget) {
      console.error(`[lint-no-console] ${rel}: ${count} console calls, budget ${b.budget} (${b.justification}) — a new stdio line landed here; migrate it to the ring or raise the deliberately.`);
      failures++;
    }
    if (count === 0 && b) {
      console.log(`[lint-no-console] ${rel}: now at 0 stdio calls — drop it from BUDGETS.`);
    }
  }
}

// Budgeted paths that no longer exist (renames) must be pruned, not miss.
for (const [abs, b] of budgetByAbs) {
  if (!statSync(abs, { throwIfNoEntry: false })) {
    console.error(`[lint-no-console] stale budget entry: ${b.file} (file gone; prune BUDGETS)`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`[lint-no-console] FAILED: ${failures} problem(s).`);
  process.exit(1);
}
console.log("[lint-no-console] OK: stdio is confined to the logging layer and budgeted boundary files.");
