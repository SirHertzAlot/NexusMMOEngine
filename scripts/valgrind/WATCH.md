# Valgrind merge watch

`watch.mjs` profiles every new merge to `main` with the repo's own
valgrind gate — memcheck over all native addons, callgrind instruction
counts for the headless workloads, and `valgrind:check` as the verdict —
and writes one report per profiled merge. It is built to run on a
schedule and stay silent when there is nothing new.

## What a run does

1. `git fetch origin main`. If `origin/main` is the commit the watcher
   last profiled, it logs one line and exits. No build, no valgrind.
2. Otherwise it resets a **dedicated worktree** — a sibling of your
   checkout named `<repo>-watch` — to the new commit. Your working
   tree is never touched. The watcher never commits and never pushes.
3. In the worktree it runs `npm ci` (only when the lockfile changed),
   then `valgrind:build-debug`, `valgrind:memcheck`, `valgrind:perf`,
   `valgrind:record`, and finally `valgrind:check`.
4. The report lands in `valgrind-out/watch/` (gitignored):
   `report-<sha>.md` per merge, `latest.md` always the newest, plus a
   full pipeline log per run. The report diffs the new snapshot
   against the previous one: new or resolved memcheck errors in our
   code, and callgrind workloads that moved more than the threshold
   (default 3%).

Exit codes: `0` pass or nothing new, `1` the gate failed, `2` the
watcher or pipeline itself failed.

## Prerequisites

- **Linux, or WSL2 on Windows.** Valgrind does not run on Windows;
  on Windows the watcher must run inside WSL (the Task Scheduler
  setup below does that for you). The repo clone the watcher runs
  from must be the WSL-side clone, on the WSL filesystem.
- `valgrind` installed: `sudo apt install -y valgrind`
- **Node matching the committed baseline.** `perf/callgrind-baseline.json`
  records the Node it was measured with; `valgrind:check` refuses to
  gate instruction counts across Node versions (it prints both when
  they differ). Keep the watcher's Node on that version.

## First run

From the repo root, inside WSL/Linux:

```bash
node scripts/valgrind/watch.mjs --once
```

The first run profiles the current `origin/main` and seeds its state,
so it takes as long as a full memcheck + callgrind pass (memcheck runs
the addon tests 20–50× slower than native). Later runs only work when
`main` has moved. Useful flags:

- `--dry-run` — fetch and report what *would* happen; runs nothing.
- `--force` — profile `origin/main` even if it was already profiled.
- `--threshold <pct>` — callgrind regression threshold (default 3).
- `--worktree <path>` — where the profiling worktree lives
  (default: sibling `<repo>-watch`; or set `VALGRIND_WATCH_WORKTREE`).

## Scheduling on Windows (recommended): Task Scheduler via WSL

From PowerShell, in the repo's Windows path:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\valgrind\install-watch-task.ps1 -RepoWslPath /home/<you>/nexus-engine -EveryHours 6
```

`-RepoWslPath` is the repo's path *inside* WSL. Add `-Distro Ubuntu`
if your default WSL distro is not the one with the repo. The task
runs `wsl.exe -> bash -> node scripts/valgrind/watch.mjs --once` every
N hours, does not start a second instance while one is running, and
catches up after the PC was asleep or off. It runs while you are
logged on (WSL needs your session).

Remove it with the same command plus `-Remove`. Change the cadence by
re-running without `-Remove` and a new `-EveryHours`.

## Scheduling in WSL/Linux: cron

WSL's cron only runs while WSL is up, which is why Task Scheduler is
the reliable route on Windows. On a Linux host (or a WSL distro you
keep alive):

```bash
sudo service cron start   # WSL only; a plain Linux host already runs it
crontab -e
```

```cron
17 */6 * * * cd /path/to/nexus-engine && node scripts/valgrind/watch.mjs --once >> valgrind-out/watch/cron.log 2>&1
```

## Codespaces

`--once` works in a codespace while it is awake, but codespaces
auto-stop when idle, so no persistent schedule can live there. Run
the watcher on a machine that is actually on — your PC via Task
Scheduler, or any Linux box via cron.

## Reading the results

Open `valgrind-out/watch/latest.md` after a run, or the dashboard
(`npm run valgrind:dashboard`) in the profiling worktree for the raw
memcheck/callgrind detail. A FAIL means `valgrind:check` found a new
error in our code or a workload more than the threshold over its
baseline — the report lists exactly which.
