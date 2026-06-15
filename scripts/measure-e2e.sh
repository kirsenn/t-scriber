#!/usr/bin/env bash
# Measure CPU/RAM during the full E2E transcription pipeline.
# Usage: bash scripts/measure-e2e.sh [results-dir]
#
# Spawns a background sampler (2 s interval), runs the E2E suite, then prints
# per-process peak/avg stats and a combined total.
set -euo pipefail

RESULTS_DIR="${1:-/tmp/tscriber-bench}"
mkdir -p "$RESULTS_DIR"

CSV="$RESULTS_DIR/e2e-procs.csv"
E2E_LOG="$RESULTS_DIR/e2e.log"
SUMMARY="$RESULTS_DIR/e2e-summary.txt"

echo "timestamp_s,name,pid,cpu_pct,rss_mb" > "$CSV"

# ── background sampler ────────────────────────────────────────────────────────
_sample() {
  while true; do
    local ts
    ts=$(date +%s)
    # Match node --test / whisper-cli / llama-completion; skip grep/awk itself
    ps aux | awk -v ts="$ts" '
      /[n]ode --test|[n]ode .*\/node |[w]hisper-cli|[l]lama-completion/ {
        name = $11; sub(".*/", "", name)
        printf "%d,%s,%s,%s,%.1f\n", ts, name, $2, $3, $6/1024
      }
    ' >> "$CSV"
    sleep 2
  done
}

_sample &
SAMPLER_PID=$!
trap 'kill "$SAMPLER_PID" 2>/dev/null || true' EXIT INT TERM

# ── run tests ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../electron"

echo "=== E2E resource measurement ==="
echo "Sampler PID : $SAMPLER_PID"
echo "Results dir : $RESULTS_DIR"
echo ""

START_TS=$(date +%s)
RUN_E2E=1 node --test test/e2e/*.e2e.js 2>&1 | tee "$E2E_LOG"
END_TS=$(date +%s)
ELAPSED=$(( END_TS - START_TS ))

kill "$SAMPLER_PID" 2>/dev/null || true

# ── summarise ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Resource usage (wall time: ${ELAPSED}s) ===" | tee "$SUMMARY"
echo "" | tee -a "$SUMMARY"

awk -F, 'NR==1{next}
{
  key=$2
  cpu=$4+0; rss=$5+0
  if (cpu > max_cpu[key]) max_cpu[key]=cpu
  if (rss > max_rss[key]) max_rss[key]=rss
  sum_rss[key]+=rss; sum_cpu[key]+=cpu; cnt[key]++
  # accumulate per-timestamp totals for combined peak
  ts=$1
  ts_rss[ts]+=rss
}
END {
  # combined peak RAM (sum across all processes at the same second)
  peak_total=0
  for (ts in ts_rss) if (ts_rss[ts]>peak_total) peak_total=ts_rss[ts]

  fmt="%-22s %10s %10s %10s %10s\n"
  printf fmt, "Process", "Peak CPU%", "Peak RAM", "Avg CPU%", "Avg RAM"
  printf fmt, "-------", "---------", "--------", "--------", "-------"
  for (k in max_cpu) {
    avg_cpu = (cnt[k]>0 ? sum_cpu[k]/cnt[k] : 0)
    avg_rss = (cnt[k]>0 ? sum_rss[k]/cnt[k] : 0)
    printf "%-22s %9.1f%% %7.0f MB %9.1f%% %7.0f MB\n",
           k, max_cpu[k], max_rss[k], avg_cpu, avg_rss
  }
  printf "\n%-22s %10s %9.0f MB\n", "TOTAL (peak sum)", "", peak_total
}' "$CSV" | tee -a "$SUMMARY"

echo ""
echo "CSV  : $CSV"
echo "Log  : $E2E_LOG"
echo "Summary: $SUMMARY"
