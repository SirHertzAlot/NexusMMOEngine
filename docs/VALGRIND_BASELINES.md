# Valgrind Baselines

This document records the valgrind memory-check (memcheck) and performance (callgrind) baselines for all native addons.

## Overview

Valgrind is used to detect memory errors (use-after-free, buffer overflows, leaks) in the native C++ addons, and to measure instruction counts for performance-critical paths.

**Important**: Valgrind only runs on Linux. The native addons in this repo are built with MSVC on Windows. To run valgrind:
- Build the addons on Linux (using g++/clang via node-gyp)
- Run valgrind in a Linux environment (CI, WSL with Linux node, or Docker)

## Addon Valgrind Scripts

Each addon in `packages/addons/` has a `valgrind:memcheck` script in its `package.json`:

```json
"valgrind:memcheck": "valgrind --tool=memcheck --leak-check=full --show-leak-kinds=definite --errors-for-leak-kinds=definite --num-callers=40 --xml=yes --xml-file=valgrind-out/memcheck/<addon>.xml node --experimental-test-isolation=none --test \"test/*.test.js\""
```

Addons with scripts:
- `@mmo-engine/addon-physics`
- `@mmo-engine/addon-integrate`
- `@mmo-engine/addon-navigation`
- `@mmo-engine/addon-picg`
- `@mmo-engine/addon-procgen`
- `@mmo-engine/addon-scatter`
- `@mmo-engine/addon-geometry`

## Running Memcheck Baselines

### Prerequisites (Linux)
```bash
sudo apt-get update && sudo apt-get install -y valgrind nodejs npm python3 python3-dev pkg-config build-essential
```

### Build Addons on Linux
```bash
# For each addon, build in a Linux-native directory (not /mnt/c/)
mkdir -p ~/build
cp -r packages/addons/<addon> ~/build/
cd ~/build/<addon>
npm install  # runs node-gyp rebuild
```

### Run Memcheck
```bash
# From repo root (Linux)
npm run valgrind:memcheck -- <addon>

# Or run individual addon script
cd ~/build/<addon>
npm run valgrind:memcheck
```

The root script (`scripts/valgrind/memcheck.mjs`) runs all addons' tests under memcheck and reports only errors in our code (filtering out Node/V8 internal noise).

## Running Performance Baselines (Callgrind)

### Prerequisites
Same as memcheck, plus the engine-core built.

### Run Perf Baselines
```bash
# Measure and update baseline
npm run valgrind:perf -- --update

# Measure and compare with baseline (exit 1 if >3% slower)
npm run valgrind:perf -- --check --threshold 3

# Just measure
npm run valgrind:perf
```

The perf script runs workloads defined in `scripts/valgrind/workloads.mjs`:
- `sim-tick-1000` - Engine tick with 1000 entities
- `physics-step-200` - Jolt physics step with 200 bodies
- `crowd-tick-100` - DetourCrowd with 100 agents
- `paths-batch-100` - Detour pathfinding batch
- `procgen-chunk` - FastNoise2 terrain chunk
- `picg-cook-staircase` - PICG procedural cooking
- `meshopt-staircase` - meshoptimizer LOD generation
- `dungeon-shell-30` - manifold/Clipper2 dungeon shell

Results are stored in `perf/callgrind-baseline.json` with format:
```json
{
  "format": "mmo-callgrind-baseline/1",
  "node": "v22.x.x",
  "platform": "linux-x64",
  "workloads": {
    "sim-tick-1000": { "irPerOp": 1234567, "unit": "tick", "n": 60 }
  }
}
```

## Baseline Results

### Memcheck Baselines (memcheck)
*Run on: [DATE] | Node: [VERSION] | Platform: [PLATFORM]*

| Addon | Status | Errors (ours) | Leaks (definite) | Notes |
|-------|--------|---------------|------------------|-------|
| physics | PENDING | - | - | Requires Linux build |
| integrate | PENDING | - | - | Requires Linux build |
| navigation | PENDING | - | - | Requires Linux build |
| picg | PENDING | - | - | Requires Linux build |
| procgen | PENDING | - | - | Requires Linux build |
| scatter | PENDING | - | - | Requires Linux build |
| geometry | PENDING | - | - | Requires Linux build |

### Performance Baselines (callgrind)
*Run on: [DATE] | Node: [VERSION] | Platform: [PLATFORM]*

| Workload | Instructions/Op | Unit | Baseline (Ir/Op) | Change |
|----------|-----------------|------|------------------|--------|
| sim-tick-1000 | PENDING | tick | - | - |
| physics-step-200 | PENDING | step | - | - |
| crowd-tick-100 | PENDING | tick | - | - |
| paths-batch-100 | PENDING | batch | - | - |
| procgen-chunk | PENDING | chunk | - | - |
| picg-cook-staircase | PENDING | cook | - | - |
| meshopt-staircase | PENDING | mesh | - | - |
| dungeon-shell-30 | PENDING | shell | - | - |

## Updating Baselines

### Memcheck
When a memory error is fixed, re-run memcheck to confirm clean:
```bash
npm run valgrind:memcheck -- <addon>
```
No baseline file to update; the goal is always zero errors in our code.

### Callgrind
When a deliberate performance change is made:
```bash
npm run valgrind:perf -- --update
```
This updates `perf/callgrind-baseline.json`. Commit the updated baseline with the PR.

## CI Integration

Recommended: Add a GitHub Actions workflow to run valgrind on Linux on every PR that touches native code:

```yaml
# .github/workflows/valgrind.yml
name: Valgrind
on:
  pull_request:
    paths:
      - 'packages/addons/**'
      - 'packages/engine-core/**'
jobs:
  valgrind:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install valgrind
        run: sudo apt-get update && sudo apt-get install -y valgrind
      - name: Build addons
        run: |
          for addon in packages/addons/*/; do
            cd "$addon" && npm install && cd -
          done
      - name: Run memcheck
        run: npm run valgrind:memcheck
      - name: Run perf
        run: npm run valgrind:perf -- --check --threshold 3
```

## Troubleshooting

### "valgrind isn't on PATH"
Install valgrind: `sudo apt-get install -y valgrind`

### "no built addons with tests"
Build the addons first: `npm install` in each addon directory on Linux.

### Build fails on Linux (BMI2, SIMD, etc.)
Add appropriate compiler flags to `binding.gyp`:
```json
"cflags": ["-mbmi2", "-mpopcnt", "-msse4.2"],
"cflags_cc": ["-mbmi2", "-mpopcnt", "-msse4.2"]
```

### Tests fail under valgrind (timing)
Tests run 20-50x slower under valgrind. Timing-sensitive tests may fail; this is reported but doesn't fail the memcheck run.

### XML reports not found
Check `valgrind-out/memcheck/` for XML files. Ensure the output directory is writable.

## References

- `scripts/valgrind/memcheck.mjs` - Memcheck runner
- `scripts/valgrind/perf.mjs` - Callgrind perf runner
- `scripts/valgrind/workloads.mjs` - Performance workloads
- `scripts/valgrind/lib.mjs` - Shared parsing utilities
- `perf/callgrind-baseline.json` - Instruction count baselines
- `valgrind-out/memcheck/*.xml` - Raw memcheck XML reports
- `valgrind-out/callgrind/` - Callgrind output files