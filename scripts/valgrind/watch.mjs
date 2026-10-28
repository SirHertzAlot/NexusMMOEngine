#!/usr/bin/env node
/**
 * node scripts/valgrind/watch.mjs [--once] [--force] [--dry-run]
 *                                 [--threshold 3] [--worktree <path>]
 *
 * Merge watcher for the valgrind gate. Run it on a schedule (Task
 * Scheduler, cron — see WATCH.md); each run:
 *
 *   1. fetches origin/main and compares it with the last commit this
 *      watcher profiled (valgrind-out/watch/state.json). Unchanged:
 *      log one line and exit — no build, no valgrind, no report.
 *   2. on a new commit, resets a DEDICATED worktree (a sibling of this
 *      checkout, `<repo>-watch`) to that commit. Your working tree is
 *      never touched. The watcher never commits and never pushes.
 *   3. runs the gate pipeline in the worktree: valgrind:build-debug,
 *      valgrind:memcheck, valgrind:perf, valgrind:record, then
 *      valgrind:check as the verdict.
 *   4. writes a report (valgrind-out/watch/report-<sha>.md, copied to
 *      latest.md) diffing the new snapshot against the previous one:
 *      new/resolved memcheck errors in our code, callgrind workloads
 *      that moved more than --threshold percent.
 *
 * Exit codes: 0 pass (or nothing new), 1 the gate failed, 2 the
 * watcher or pipeline itself failed. Valgrind is Linux-only: on
 * Windows, run this inside WSL2 (WATCH.md has the Task Scheduler
 * setup that does exactly that).
 *
 * VALGRIND_WATCH_SKIP_PIPELINE=1 skips install + the npm pipeline
 * (worktree, snapshot diff and report still run). It exists to test
 * the watcher's own plumbing without a full valgrind pass.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const watchDir = join(root, "valgrind-out", "watch");
const stateFile = join(watchDir, "state.json");
const lockFile = join(watchDir, "watch.lock");
const LOCK_STALE_MS = 12 * 60 * 60 * 1000;

const fmt = new Intl.NumberFormat("en-US");
const short = (sha) => (sha ?? "").slice(0, 8);

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested in watch.test.mjs)                        */
/* ------------------------------------------------------------------ */

/** Diff two record.mjs snapshots (the shape in valgrind-out/history/). */
export function diffSnapshots(prev, next, thresholdPct = 3) {
  const d = { nodeMismatch: false, memcheck: null, callgrind: [] };
  if (!prev || !next) return d;
  d.nodeMismatch = Boolean(prev.node && next.node && prev.node !== next.node);
  const pm = prev.memcheck ?? {}, nm = next.memcheck ?? {};
  const pKeys = new Set(pm.engineKeys ?? []), nKeys = new Set(nm.engineKeys ?? []);
  const pVia = new Set(pm.viaKeys ?? []), nVia = new Set(nm.viaKeys ?? []);
  d.memcheck = {
    prev: { errors: pm.errors ?? 0, leakedBytes: pm.leakedBytes ?? 0, engineErrors: pm.engineErrors ?? 0, viaErrors: pm.viaErrors ?? 0 },
    next: { errors: nm.errors ?? 0, leakedBytes: nm.leakedBytes ?? 0, engineErrors: nm.engineErrors ?? 0, viaErrors: nm.viaErrors ?? 0 },
    newEngine: [...nKeys].filter((k) => !pKeys.has(k)),
    goneEngine: [...pKeys].filter((k) => !nKeys.has(k)),
    newVia: [...nVia].filter((k) => !pVia.has(k)),
  };
  const names = new Set([...Object.keys(prev.callgrind ?? {}), ...Object.keys(next.callgrind ?? {})]);
  for (const name of names) {
    const p = prev.callgrind?.[name], n = next.callgrind?.[name];
    if (p && n) {
      const deltaPct = ((n.irPerOp - p.irPerOp) / p.irPerOp) * 100;
      d.callgrind.push({
        name, unit: n.unit ?? p.unit, prevIr: p.irPerOp, nextIr: n.irPerOp, deltaPct,
        regression: !d.nodeMismatch && deltaPct > thresholdPct,
        improved: !d.nodeMismatch && deltaPct < -thresholdPct,
      });
    } else if (n) d.callgrind.push({ name, unit: n.unit, nextIr: n.irPerOp, added: true });
    else d.callgrind.push({ name, unit: p.unit, prevIr: p.irPerOp, missing: true });
  }
  d.callgrind.sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0));
  return d;
}

const keyLine = (k) => k.split("|").join("  ");

/** Render the per-merge markdown report. */
export function renderReport({ sha, time, node, verdict, checkLines = [], prev, next, diff, thresholdPct = 3, logName }) {
  const L = [];
  L.push(`# Valgrind watch — ${short(sha)}`);
  L.push("");
  L.push(`- commit: \`${sha}\``);
  L.push(`- profiled: ${time}`);
  L.push(`- node: ${node ?? "unknown"}`);
  L.push(`- **gate: ${verdict}**`);
  if (logName) L.push(`- full pipeline log: \`valgrind-out/watch/${logName}\``);
  L.push("");
  if (!next) {
    L.push("No snapshot was produced — the pipeline did not reach `valgrind:record`. See the log.");
    return L.join("\n") + "\n";
  }
  const m = next.memcheck ?? {};
  L.push("## Memcheck");
  L.push("");
  L.push(`${m.errors ?? 0} errors, ${fmt.format(m.leakedBytes ?? 0)} bytes leaked, ` +
    `**${m.engineErrors ?? 0} in our code**, ${m.viaErrors ?? 0} through our code faulting in Node/V8.`);
  if (diff?.memcheck) {
    const dm = diff.memcheck;
    for (const k of dm.newEngine) L.push(`- NEW error in our code: ${keyLine(k)}`);
    for (const k of dm.goneEngine) L.push(`- resolved since last run: ${keyLine(k)}`);
    for (const k of dm.newVia) L.push(`- note, through our code but fault in Node/V8: ${keyLine(k)}`);
    if (!dm.newEngine.length && !dm.goneEngine.length) {
      L.push(`- no change in our-code errors vs ${prev ? short(prev.commit) : "the previous snapshot"}.`);
    }
  } else {
    L.push("- first snapshot for this watcher — no previous run to diff against.");
  }
  L.push("");
  L.push("## Callgrind");
  L.push("");
  if (diff?.nodeMismatch) {
    L.push(`Node changed between runs (${prev.node} -> ${next.node}); instruction counts are not comparable, so no regressions are flagged.`);
    L.push("");
  }
  const rows = (diff?.callgrind ?? []).filter((w) => w.added || w.missing || Math.abs(w.deltaPct ?? 0) > 1);
  if (rows.length === 0) {
    L.push(`No workload moved more than 1% versus the previous snapshot.`);
  } else {
    L.push("| workload | before | after | delta | |");
    L.push("|---|---|---|---|---|");
    for (const w of rows) {
      const flag = w.regression ? `**REGRESSION (> ${thresholdPct}%)**` : w.improved ? "improved" : w.added ? "new" : w.missing ? "no result" : "";
      L.push(`| ${w.name} | ${w.prevIr != null ? fmt.format(Math.round(w.prevIr)) : "—"} | ${w.nextIr != null ? fmt.format(Math.round(w.nextIr)) : "—"} | ${w.deltaPct != null ? `${w.deltaPct >= 0 ? "+" : ""}${w.deltaPct.toFixed(1)}%` : "—"} | ${flag} |`);
    }
  }
  L.push("");
  if (checkLines.length) {
    L.push("## Gate output");
    L.push("");
    for (const line of checkLines) L.push(`- ${line}`);
    L.push("");
  }
  return L.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* IO / process plumbing                                               */
/* ------------------------------------------------------------------ */

function log(msg) {
  const line = `[watch] ${msg}`;
  console.log(line);
  try {
    mkdirSync(watchDir, { recursive: true });
    appendFileSync(join(watchDir, "watch.log"), `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never kill the run */ }
}

function run(cmd, args, cwd, { captureTo = null } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (captureTo) appendFileSync(captureTo, `\n$ ${cmd} ${args.join(" ")}\n${out}`);
  return { status: r.status ?? -1, out };
}

const git = (args, cwd = root) => run("git", args, cwd);

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  mkdirSync(watchDir, { recursive: true });
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, stateFile);
}

function readSnapshots(worktreeDir) {
  const dir = join(worktreeDir, "valgrind-out", "history");
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(readFileSync(join(dir, f), "utf8"))); } catch { /* skip corrupt */ }
  }
  return out;
}

function ensureWorktree(worktreeDir, targetSha) {
  const listed = git(["worktree", "list", "--porcelain"]).out
    .split("\n").filter((l) => l.startsWith("worktree ")).map((l) => resolve(l.slice(9)));
  if (listed.includes(resolve(worktreeDir))) return; // already registered
  if (existsSync(worktreeDir)) {
    throw new Error(`${worktreeDir} exists but is not a git worktree. Move it aside or pass --worktree <path>.`);
  }
  const r = git(["worktree", "add", "--detach", worktreeDir, targetSha]);
  if (r.status !== 0) throw new Error(`git worktree add failed:\n${r.out.slice(-800)}`);
}

function takeLock() {
  mkdirSync(watchDir, { recursive: true });
  if (existsSync(lockFile)) {
    const age = Date.now() - statSync(lockFile).mtimeMs;
    if (age < LOCK_STALE_MS) return false;
    log(`taking over a stale lock (${Math.round(age / 3600000)}h old)`);
  }
  writeFileSync(lockFile, `${process.pid} ${new Date().toISOString()}\n`);
  return true;
}

/* ------------------------------------------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const skipPipeline = process.env.VALGRIND_WATCH_SKIP_PIPELINE === "1";
  const tAt = argv.indexOf("--threshold");
  const thresholdPct = tAt >= 0 ? Number(argv[tAt + 1]) : 3;
  const wAt = argv.indexOf("--worktree");
  const worktreeDir = wAt >= 0
    ? resolve(argv[wAt + 1])
    : resolve(process.env.VALGRIND_WATCH_WORKTREE ?? join(dirname(root), `${basename(root)}-watch`));

  if (process.platform === "win32" && !dryRun) {
    console.error("[watch] valgrind does not run on Windows. Run this inside WSL2 — see WATCH.md.");
    return 2;
  }

  const fetched = git(["fetch", "origin", "main"]);
  if (fetched.status !== 0) { log(`git fetch failed:\n${fetched.out.slice(-500)}`); return 2; }
  const targetSha = git(["rev-parse", "origin/main"]).out.trim();
  if (!targetSha) { log("could not resolve origin/main"); return 2; }

  const state = readState();
  if (!force && state.lastProfiledSha === targetSha) {
    log(`origin/main unchanged at ${short(targetSha)} — nothing to profile.`);
    return 0;
  }

  log(`new origin/main: ${short(targetSha)} (last profiled: ${state.lastProfiledSha ? short(state.lastProfiledSha) : "none"})`);
  log(`worktree: ${worktreeDir}`);
  if (dryRun) {
    log("dry run — would reset the worktree, install if the lockfile changed, and run: valgrind:build-debug, valgrind:memcheck, valgrind:perf, valgrind:record, valgrind:check.");
    return 0;
  }
  if (!takeLock()) { log("another watch run holds the lock — exiting."); return 0; }

  const logName = `run-${short(targetSha)}.log`;
  const logPath = join(watchDir, logName);
  let verdict = "PIPELINE FAILED";
  let exitCode = 2;
  try {
    ensureWorktree(worktreeDir, targetSha);
    const wtHeadBefore = git(["rev-parse", "HEAD"], worktreeDir).out.trim();
    const reset = git(["reset", "--hard", targetSha], worktreeDir);
    if (reset.status !== 0) throw new Error(`worktree reset failed:\n${reset.out.slice(-500)}`);

    let checkLines = [];
    if (skipPipeline) {
      log("VALGRIND_WATCH_SKIP_PIPELINE=1 — skipping install and pipeline (plumbing test).");
      verdict = "SKIPPED (plumbing test)";
      exitCode = 0;
    } else {
      const lockChanged = !wtHeadBefore || git(["diff", "--name-only", wtHeadBefore, targetSha, "--", "package-lock.json", "package.json"]).out.trim().length > 0;
      if (lockChanged || !existsSync(join(worktreeDir, "node_modules"))) {
        log("installing dependencies (npm ci)…");
        const ci = run("npm", ["ci", "--no-audit", "--no-fund"], worktreeDir, { captureTo: logPath });
        if (ci.status !== 0) throw new Error(`npm ci failed — see ${logName}`);
      }
      const steps = [
        ["valgrind:build-debug", true],
        ["valgrind:memcheck", false],
        ["valgrind:perf", false],
        ["valgrind:record", false],
      ];
      let buildFailed = false;
      for (const [script, abortOnFail] of steps) {
        log(`running npm run ${script} …`);
        const r = run("npm", ["run", script], worktreeDir, { captureTo: logPath });
        if (r.status !== 0) {
          log(`npm run ${script} exited ${r.status} (continuing; details in ${logName})`);
          if (abortOnFail) { buildFailed = true; break; }
        }
      }
      if (buildFailed) {
        verdict = "PIPELINE FAILED (valgrind:build-debug)";
      } else {
        const check = run("npm", ["run", "valgrind:check", "--", "--threshold", String(thresholdPct)], worktreeDir, { captureTo: logPath });
        checkLines = check.out.split("\n").map((l) => l.trim())
          .filter((l) => l.startsWith("FAIL:") || l.startsWith("note:") || l.startsWith("[check]"));
        if (check.status === 0) { verdict = "PASS"; exitCode = 0; }
        else if (check.status === 1) { verdict = "FAIL — gate"; exitCode = 1; }
        else { verdict = `UNKNOWN (valgrind:check exited ${check.status})`; }
      }
    }

    const snaps = readSnapshots(worktreeDir);
    const next = snaps[snaps.length - 1] ?? null;
    const prev = next ? (snaps.filter((s) => s.id !== next.id).at(-1) ?? null) : null;
    const diff = diffSnapshots(prev, next, thresholdPct);
    const report = renderReport({
      sha: targetSha, time: new Date().toISOString(), node: next?.node ?? process.version,
      verdict, checkLines, prev, next, diff, thresholdPct, logName,
    });
    const reportName = `report-${short(targetSha)}.md`;
    writeFileSync(join(watchDir, reportName), report);
    writeFileSync(join(watchDir, "latest.md"), report);
    writeState({
      ...state,
      lastProfiledSha: targetSha,
      lastRunAt: new Date().toISOString(),
      lastVerdict: verdict,
      lastReport: reportName,
    });
    log(`profiled ${short(targetSha)} — gate: ${verdict}. Report: valgrind-out/watch/${reportName}`);
    return exitCode;
  } catch (err) {
    log(`watcher failed: ${err.message}`);
    return 2;
  } finally {
    try { rmSync(lockFile, { force: true }); } catch { /* best effort */ }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`[watch] ${err.stack ?? err.message}`);
    process.exit(2);
  });
}
