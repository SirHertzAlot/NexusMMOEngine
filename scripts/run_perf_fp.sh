#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------------
BENCH_CMD="npm run bench:transport -- --seconds 30"   # benchmark command (30 s run)
PERF_DURATION=20                     # seconds to record
TMP_DIR="/tmp"
PERF_DATA="${TMP_DIR}/gateway-uws-fp.perf.data"
SELF_REPORT="${TMP_DIR}/gateway-uws-fp.self.txt"
CHILD_REPORT="${TMP_DIR}/gateway-uws-fp.children.txt"
FLAME_SVG="${TMP_DIR}/gateway-uws-fp.svg"
STAT_OUT="${TMP_DIR}/gateway-uws-fp.stat.txt"

# ------------------------------------------------------------------------
# 1️⃣ Run the benchmark under perf (captures full run)
# ------------------------------------------------------------------------
echo "[▶] Starting benchmark under perf..."
# Run the benchmark command via bash -c so we can redirect its output
sudo perf record \
  -F 9973 \
  -g --call-graph fp,16384 \
  -o "$PERF_DATA" \
  -- bash -c "$BENCH_CMD" &
BENCH_PID=$!
# Wait for the benchmark to finish (PERF_DURATION + a buffer)
wait $BENCH_PID

# After perf record finishes, the benchmark log is already captured inside the command
# (we redirect inside BENCH_CMD). No need for separate PID handling.


# ------------------------------------------------------------------------
# 4️⃣ Quick perf‑stat summary (CPU, context switches, etc.)
# ------------------------------------------------------------------------
echo "[▶] Gathering perf‑stat summary…"
# Use the benchmark PID as the target for perf stat
GATEWAY_PID=$BENCH_PID
sudo perf stat -p "$GATEWAY_PID" \
  -e task-clock,context-switches,cpu-migrations,page-faults \
  -- sleep "$PERF_DURATION" > "$STAT_OUT" 2>&1

# ------------------------------------------------------------------------
# 5️⃣ Generate self‑/inclusive reports
# ------------------------------------------------------------------------
echo "[▶] Generating self‑only report…"
sudo perf report -i "$PERF_DATA" --stdio \
  --no-children --show-nr-samples --percent-limit 0.01 \
  --sort comm,pid,dso,symbol > "$SELF_REPORT"

echo "[▶] Generating inclusive (children) report…"
sudo perf report -i "$PERF_DATA" --stdio \
  --children --percent-limit 0.1 \
  --sort comm,pid,dso,symbol > "$CHILD_REPORT"

# ------------------------------------------------------------------------
# 6️⃣ Build a flame‑graph (requires the FlameGraph repo in $HOME/FlameGraph)
# ------------------------------------------------------------------------
FLAME_DIR="${HOME}/FlameGraph"
if [[ -d "$FLAME_DIR" ]]; then
  echo "[▶] Creating flame‑graph…"
  sudo perf script -i "$PERF_DATA" | \
    "$FLAME_DIR"/stackcollapse-perf.pl | \
    "$FLAME_DIR"/flamegraph.pl > "$FLAME_SVG"
else
  echo "[⚠] FlameGraph not found at $FLAME_DIR – skipping SVG generation."
fi

# ------------------------------------------------------------------------
# 7️⃣ Clean‑up
# ------------------------------------------------------------------------
echo "[✔] Perf capture complete. Artefacts:"
echo "  • Benchmark log      : ${TMP_DIR}/gateway-uws-fp.bench.log"
echo "  • Perf data          : $PERF_DATA"
echo "  • Self report        : $SELF_REPORT"
echo "  • Inclusive report   : $CHILD_REPORT"
echo "  • Perf‑stat summary  : $STAT_OUT"
if [[ -f "$FLAME_SVG" ]]; then
  echo "  • Flame‑graph (SVG)  : $FLAME_SVG"
fi

# Optionally stop the benchmark after profiling
# kill "$BENCH_PID" || true
