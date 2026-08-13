#!/bin/bash
# Drive the {regular,fullscreen} x {native,tmux} matrix for one load type.
#
# Every run gets a FRESH copy of the source transcript with a rewritten
# sessionId, so (a) no run shares a sessionId with another run or with the live
# fleet session, and (b) run N+1 does not inherit run N's appended output.
#
# Usage: run-tui-mode-matrix.sh <src-session.jsonl> <outdir> <load> [pass]
#   load: typing | resize
set -euo pipefail
SRC="$1"; OUT="$2"; LOAD="${3:-typing}"; PASS="${4:-p1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH=/tmp/pi-fs-arc/sessions
SECS="${PI_PERF_LOAD_SECS:-60}"
mkdir -p "$OUT" "$SCRATCH"

run() {
  local mode="$1" transport="$2" cap="$3"
  local tag="${mode}-${transport}-${LOAD}-cap${cap}"
  local sess="$SCRATCH/${PASS}-${tag}.jsonl"
  echo "=== $PASS $tag ===" >&2
  node "$HERE/mk-scratch-session.mjs" "$SRC" "$sess" >/dev/null
  python3 "$HERE/tui-mode-ab.py" --mode "$mode" --transport "$transport" \
    --load "$LOAD" --cap "$cap" --session "$sess" --out "$OUT" \
    --load-secs "$SECS" >/dev/null || echo "RUN FAILED: $tag" >&2
  rm -f "$sess"
  sleep 5
}

# 4 core conditions. cap=3000 is what pi-king ships today (fleet.ts:548).
run regular    native 3000
run fullscreen native 3000
run regular    tmux   3000
run fullscreen tmux   3000

# reference: unpatched-equivalent regular mode, no render cap
run regular    native none
run regular    tmux   none

echo "=== done: $OUT ===" >&2
