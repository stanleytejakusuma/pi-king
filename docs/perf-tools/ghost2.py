#!/usr/bin/env python3
"""Pass 1: cache per-frame bright-block positions to JSON.
Pass 2 (separate): classify static UI vs transient ghost artifacts."""
import glob, json, os
import numpy as np
from PIL import Image

CACHE = "/tmp/pi-audit/blocks.json"

if not os.path.exists(CACHE):
    files = sorted(glob.glob("/tmp/pi-audit/frames/f*.png"))
    out = []
    for idx, path in enumerate(files):
        a = np.asarray(Image.open(path).convert("L"))
        mask = a > 235
        boxes = []
        if mask.any():
            ys, xs = np.nonzero(mask)
            grid = {}
            for y, x in zip(ys, xs):
                grid.setdefault((y // 24, x // 24), []).append((int(y), int(x)))
            for members in grid.values():
                m = np.array(members)
                y0, x0 = int(m[:, 0].min()), int(m[:, 1].min())
                h = int(m[:, 0].max() - y0 + 1)
                w = int(m[:, 1].max() - x0 + 1)
                if 8 <= h <= 60 and 4 <= w <= 40 and len(members) > (h * w * 0.5):
                    boxes.append([y0, x0, h, w])
        out.append(boxes)
    json.dump(out, open(CACHE, "w"))
    print(f"cached {len(out)} frames")

frames = json.load(open(CACHE))
n = len(frames)

# Bucket block positions coarsely; count how many frames each position appears in.
from collections import Counter
pos_count = Counter()
for boxes in frames:
    seen = set()
    for y, x, h, w in boxes:
        seen.add((y // 30, x // 30))
    for p in seen:
        pos_count[p] += 1

static = {p for p, c in pos_count.items() if c > n * 0.5}
print(f"\nframes: {n}")
print(f"static UI positions (present in >50% of frames): {len(static)}")
print(f"total distinct positions: {len(pos_count)}")

# Transient = appears in a small minority of frames -> candidate artifacts
transient = {p: c for p, c in pos_count.items() if c <= n * 0.15 and c > 0}
print(f"transient positions (<=15% of frames): {len(transient)}")
print("\n=== TRANSIENT BRIGHT-BLOCK APPEARANCES (ghost candidates) ===")
for p, c in sorted(transient.items(), key=lambda kv: -kv[1])[:20]:
    y, x = p[0] * 30, p[1] * 30
    fr = [i for i, boxes in enumerate(frames)
          if any((by // 30, bx // 30) == p for by, bx, _, _ in boxes)]
    span = f"frames {fr[0]}-{fr[-1]}" if len(fr) > 1 else f"frame {fr[0]}"
    print(f"  y~{y:4d} x~{x:4d}: {c:3d}/{n} frames ({100*c/n:4.1f}%)  {span}")
