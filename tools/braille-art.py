#!/usr/bin/env python3
"""Regenerate pi-king's Braille wordmark.

Braille (U+2800) packs a 2x4 pixel grid into one character cell, giving 8x the
effective resolution of block-drawing characters -- which is why the mark reads
as a real glyph rather than a blocky approximation.

The pi is DRAWN, not rendered from a font: crossbar, legs and flared foot as
explicit rectangles, a helmet arc seated directly on the crossbar, and horns as
thick tapered crescents. Font-rendering a pi and overlaying a helmet was tried
first and looked like a mushroom on a stick.

    python3 tools/braille-art.py 11      # 6 rows, the size used in src/data.ts

Requires Pillow.
"""
import sys
from PIL import Image, ImageDraw

DOT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]


def to_braille(img, threshold=140):
    w, h = img.size
    px = img.load()
    out = []
    for cy in range(0, h, 4):
        row = ""
        for cx in range(0, w, 2):
            bits = 0
            for dy in range(4):
                for dx in range(2):
                    x, y = cx + dx, cy + dy
                    if x < w and y < h and px[x, y] < threshold:
                        bits |= DOT[dy][dx]
            row += chr(0x2800 + bits)
        out.append(row.rstrip())
    return [r for r in out if r.strip("\u2800 ")]


def king(cols=11, scale=6):
    W, H = cols * 2, int(cols * 2 * 1.05)
    img = Image.new("L", (W * scale, H * scale), 255)
    d = ImageDraw.Draw(img)
    w, h = W * scale, H * scale
    R = lambda x0, y0, x1, y1: d.rectangle([x0 * w, y0 * h, x1 * w, y1 * h], fill=0)

    BAR_T, BAR_B = 0.46, 0.565
    R(0.10, BAR_T, 0.90, BAR_B)          # crossbar
    R(0.255, BAR_B, 0.375, 0.96)         # left leg
    R(0.635, BAR_B, 0.755, 0.96)         # right leg
    d.polygon([(0.755 * w, 0.86 * h), (0.90 * w, 0.96 * h), (0.755 * w, 0.96 * h)], fill=0)

    HX0, HX1 = 0.26, 0.74
    d.pieslice([HX0 * w, 0.155 * h, HX1 * w, (BAR_T + 0.10) * h], start=180, end=360, fill=0)
    R(HX0 - 0.015, BAR_T - 0.075, HX1 + 0.015, BAR_T)   # brow band

    for sign, ax in ((-1, HX0 + 0.01), (1, HX1 - 0.01)):
        y0 = BAR_T - 0.085
        for t in range(121):
            u = t / 120
            cx = ax + sign * (0.235 * u)
            cy = y0 - 0.30 * (u ** 1.55) + 0.045 * (1 - u) ** 2
            r = 0.052 * (1 - 0.72 * u)
            d.ellipse([(cx - r) * w, (cy - r * 1.6) * h, (cx + r) * w, (cy + r * 1.6) * h], fill=0)

    return img.resize((W, H), Image.LANCZOS)


if __name__ == "__main__":
    cols = int(sys.argv[1]) if len(sys.argv) > 1 else 11
    art = to_braille(king(cols))
    lead = min(len(l) - len(l.lstrip("\u2800 ")) for l in art)
    art = [l[lead:].rstrip("\u2800 ") for l in art]
    print(f"# {len(art)} rows x {max(len(l) for l in art)} cols", file=sys.stderr)
    for line in art:
        print("  " + '"' + "".join(f"\\u{ord(c):04x}" for c in line) + '",')
