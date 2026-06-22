#!/usr/bin/env bash
# Captures memory, CPU, and disk metrics for Cairn runtime processes.
# Run while Cairn (and optional LLM/embeddings workloads) are active.
# Output: scripts/runtime-baselines/<label>-<timestamp>.txt
# Usage: ./scripts/capture-runtime-baseline.sh [label]
#
# Captures:
#   1. Process snapshot (RSS, %MEM, %CPU, command)
#   2. RSS summary per process family (Electron helpers, runtime-server, llama-server, MCP)
#   3. Total RSS across all Cairn-related processes
#   4. On-disk footprint (LLM models, embedding models, binary, runtime binary)
#   5. Individual model files (GGUF + ONNX)
#   6. Port usage (listening sockets)
#   7. Child process count (if CAIRN_PID env var is set)

set -uo pipefail

LABEL="${1:-baseline}"
TS=$(date +%Y%m%d-%H%M%S)
OUT="scripts/runtime-baselines/${LABEL}-${TS}.txt"

# In dev (npm run dev) userData is under "Electron"; packaged macOS app uses "cairn";
# packaged Windows/Linux uses "Cairn". A dev's machine often has both — scan all matches.
USERDATA_DIRS=()
for d in \
  "$HOME/Library/Application Support/Electron" \
  "$HOME/Library/Application Support/cairn" \
  "$HOME/Library/Application Support/Cairn" \
  "${APPDATA:-/nonexistent}/Cairn" \
  "$HOME/.config/Cairn"; do
  [ -d "$d" ] || continue
  if [ -d "$d/llama-models" ] || [ -d "$d/embedding-models" ] || [ -d "$d/llama-bin" ] || [ -d "$d/runtime-bin" ]; then
    USERDATA_DIRS+=("$d")
  fi
done
# For sections that use $USERDATA, default to cairn (packaged app most common).
USERDATA="${USERDATA_DIRS[0]:-$HOME/Library/Application Support/cairn}"

mkdir -p "$(dirname "$OUT")"

section() { echo "================================================" | tee -a "$OUT"; echo "$1" | tee -a "$OUT"; echo "================================================" | tee -a "$OUT"; }

echo "Cairn Runtime Baseline Capture" > "$OUT"
echo "Label: $LABEL" >> "$OUT"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT"
echo "Host: $(uname -s) $(uname -m) | $(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'unknown CPU')" >> "$OUT"
echo "RAM: $(( ($(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 / 1024 ))) GB" >> "$OUT"
echo "Cairn version: $(node -p 'require("./package.json").version' 2>/dev/null || echo 'unknown')" >> "$OUT"
echo "" >> "$OUT"

section "1. PROCESS SNAPSHOT (RSS in KB, %MEM, %CPU, CMD)"
ps aux | grep -iE "cairn|llama|embed|onnx|transformers|runtime-server|Cairn Helper|Cairn.app" \
  | grep -v grep \
  | grep -v "opencode" \
  | grep -v "capture-runtime" \
  | awk '{printf "%-12s %8s KB  %5s%%  %5s%%  %s\n", $1, $6, $4, $3, substr($0, index($0,$11))}' \
  | tee -a "$OUT" || echo "(no matching processes)" | tee -a "$OUT"

section "2. RSS SUMMARY PER PROCESS FAMILY"
for fam in "Cairn Helper" "runtime-server" "llama-server" "cairn-mcp" "node.*runtime-server"; do
  rss=$(ps aux | grep -iE "$fam" | grep -v grep | awk '{sum+=$6} END {print sum}')
  if [ -n "$rss" ] && [ "$rss" != "0" ]; then
    echo "  $fam: $(( rss / 1024 )) MB" | tee -a "$OUT"
  fi
done

section "3. TOTAL RSS (all Cairn-related)"
total_rss=$(ps aux | grep -iE "cairn|llama|Cairn Helper|Cairn.app|runtime-server" | grep -v grep | grep -v "opencode" | awk '{sum+=$6} END {print sum}')
echo "  Total: $(( ${total_rss:-0} / 1024 )) MB" | tee -a "$OUT"

section "4. ON-DISK FOOTPRINT"
for d in "${USERDATA_DIRS[@]:-$USERDATA}"; do
  echo "  userData dir: $d" | tee -a "$OUT"
  echo "    LLM models:     $(du -sh "$d/llama-models/" 2>/dev/null | cut -f1 || echo 'n/a')" | tee -a "$OUT"
  echo "    LLM binary:     $(du -sh "$d/llama-bin/" 2>/dev/null | cut -f1 || echo 'n/a')" | tee -a "$OUT"
  echo "    Embed models:   $(du -sh "$d/embedding-models/" 2>/dev/null | cut -f1 || echo 'n/a')" | tee -a "$OUT"
  echo "    Runtime binary: $(du -sh "$d/runtime-bin/" 2>/dev/null | cut -f1 || echo 'n/a')" | tee -a "$OUT"
  echo "    Runtime port:   $(cat "$d/runtime-port.json" 2>/dev/null || echo 'not written')" | tee -a "$OUT"
done
echo "  (dev bundle: transformers.js+onnxruntime-node bundled into runtime-server.bundle.js)" | tee -a "$OUT"

section "5. INDIVIDUAL MODEL FILES"
for d in "${USERDATA_DIRS[@]:-$USERDATA}"; do
  echo "  -- $d --" | tee -a "$OUT"
  find "$d/llama-models/" -name '*.gguf' -type f 2>/dev/null | while IFS= read -r f; do
    echo "  $(du -h "$f" | cut -f1)  $(basename "$f")" | tee -a "$OUT"
  done || echo "  (no gguf files)" | tee -a "$OUT"
  find "$d/embedding-models/" -type f 2>/dev/null | while IFS= read -r f; do
    rel="${f#"$d"/embedding-models/}"
    echo "  $(du -h "$f" | cut -f1)  $rel" | tee -a "$OUT"
  done || echo "  (no embedding files)" | tee -a "$OUT"
done

section "6. PORT USAGE"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null \
  | grep -iE "cairn|llama|embed|node|Electron|runtime" \
  | grep -v "^COMMAND" \
  | awk '{print "  " $1 " pid=" $2 " " $9}' \
  | tee -a "$OUT" || echo "  (none)" | tee -a "$OUT"

section "7. CHILD PROCESS COUNT"
if [ -n "${CAIRN_PID:-}" ]; then
  count=$(pgrep -P "$CAIRN_PID" 2>/dev/null | wc -l | tr -d ' ')
  echo "  Cairn (pid=$CAIRN_PID) has $count direct child processes" | tee -a "$OUT"
  # Also list children's children (grandchildren)
  children=$(pgrep -P "$CAIRN_PID" 2>/dev/null)
  gc_total=0
  for child in $children; do
    gc=$(pgrep -P "$child" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$gc" -gt 0 ]; then
      gc_name=$(ps -p "$child" -o comm= 2>/dev/null || echo "pid=$child")
      echo "    └─ $gc_name has $gc children" | tee -a "$OUT"
      gc_total=$((gc_total + gc))
    fi
  done
  echo "  Total descendants (children + grandchildren): $((count + gc_total))" | tee -a "$OUT"
else
  echo "  (set CAIRN_PID env var for child-process count)" | tee -a "$OUT"
fi

section "8. RUNTIME HEALTH CHECK"
RUNTIME_PORT=""
for d in "${USERDATA_DIRS[@]:-$USERDATA}"; do
  port_file="$d/runtime-port.json"
  if [ -f "$port_file" ]; then
    RUNTIME_PORT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['port'])" "$port_file" 2>/dev/null || echo "")
    if [ -n "$RUNTIME_PORT" ]; then
      echo "  Runtime port: $RUNTIME_PORT (from $port_file)" | tee -a "$OUT"
      break
    fi
  fi
done
if [ -n "$RUNTIME_PORT" ]; then
  echo "  /health response:" | tee -a "$OUT"
  curl -s --max-time 5 "http://127.0.0.1:$RUNTIME_PORT/health" 2>/dev/null | python3 -m json.tool 2>/dev/null | sed 's/^/    /' | tee -a "$OUT" || echo "    (failed to reach runtime)" | tee -a "$OUT"
else
  echo "  (runtime port file not found — runtime may not be running)" | tee -a "$OUT"
fi

echo "" >> "$OUT"
echo "Saved to: $OUT" | tee -a "$OUT"
