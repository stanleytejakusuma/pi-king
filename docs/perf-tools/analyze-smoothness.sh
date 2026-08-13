#!/bin/bash
# Quantifies terminal "smoothness" from a screen recording, objectively.
#
# Method: extract per-frame change scores with timestamps, then measure the
# GAPS between meaningful screen updates. Typing at a steady cadence should
# produce steady updates; "choppy" means updates arrive in irregular bursts
# with long dead gaps between them.
#
# Usage: ./analyze-smoothness.sh recording.mov [label]
set -euo pipefail
MOV="$1"
LABEL="${2:-$(basename "$MOV")}"

ffmpeg -loglevel error -i "$MOV" -vf "select='gt(scene,0)',metadata=print:file=-" -f null - 2>/dev/null \
  | paste - - \
  | sed 's/.*pts_time:\([0-9.]*\).*lavfi.scene_score=\([0-9.]*\)/\1 \2/' \
  > /tmp/pi-audit/_scores.txt

python3 - "$LABEL" <<'PY'
import sys
label = sys.argv[1]
rows = []
for line in open('/tmp/pi-audit/_scores.txt'):
    parts = line.split()
    if len(parts) == 2:
        try:
            rows.append((float(parts[0]), float(parts[1])))
        except ValueError:
            pass

if not rows:
    print(f"{label}: no frame data")
    sys.exit(0)

# "Meaningful update" = a frame whose change score clears the noise floor.
# Typing a character changes a small screen region, so the threshold is low,
# but above the ~0.0005 idle-jitter floor seen in idle captures.
THRESH = 0.002
updates = [t for t, s in rows if s > THRESH]
duration = rows[-1][0] - rows[0][0]

print(f"=== {label} ===")
print(f"  duration: {duration:.1f}s, frames analyzed: {len(rows)}, meaningful updates: {len(updates)}")

if len(updates) < 2:
    print("  (too few updates to measure cadence)")
    sys.exit(0)

gaps = [(updates[i+1] - updates[i]) * 1000 for i in range(len(updates) - 1)]
gaps_sorted = sorted(gaps)
n = len(gaps_sorted)
p50 = gaps_sorted[n // 2]
p95 = gaps_sorted[int(n * 0.95)]
mx = gaps_sorted[-1]
# Stutter = gaps long enough to be perceived as a hitch (>100ms ~ 6 frames @60fps)
stutters = [g for g in gaps if g > 100]
big = [g for g in gaps if g > 250]

print(f"  update gap: p50={p50:.1f}ms p95={p95:.1f}ms max={mx:.1f}ms")
print(f"  stutters >100ms: {len(stutters)}/{n} ({100*len(stutters)/n:.1f}%)")
print(f"  stalls   >250ms: {len(big)}/{n} ({100*len(big)/n:.1f}%)")
print(f"  updates/sec: {len(updates)/duration:.1f}")
PY
