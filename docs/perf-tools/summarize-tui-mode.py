#!/usr/bin/env python3
"""Fold tui-mode-ab.py results into one comparison table.

Latency is derived from the merged timeline (`*-timeline.txt`), which carries
keystroke sends and terminal reads on one clock. Two numbers per keystroke:

  first-byte : keystroke -> first byte back. What the cursor/echo feels like.
  settle     : keystroke -> last byte of that burst. When the screen actually
               STOPPED changing. Under tmux the two diverge hard, because tmux
               acks quickly and then spends tens of ms draining the frame --
               reporting first-byte alone would flatter tmux badly.

Usage: summarize-tui-mode.py <outdir> [<outdir> ...]
"""
import glob, json, os, sys

BURST_GAP = 0.020   # reads closer together than this belong to one frame drain


def read_timeline(path):
    ev = []
    if not os.path.exists(path):
        return ev
    for line in open(path):
        p = line.split()
        if len(p) >= 4:
            ev.append((float(p[0]), p[1], int(p[2]), int(p[3])))
    return ev


def latencies(ev):
    """-> (first_byte_ms[], settle_ms[], burst_bytes[])"""
    fb, st, bursts = [], [], []
    n = len(ev)
    i = 0
    while i < n:
        if ev[i][1] != "key":
            i += 1
            continue
        tk = ev[i][0]
        j = i + 1
        while j < n and ev[j][1] != "out":
            j += 1
        if j >= n:
            break
        fb.append((ev[j][0] - tk) * 1000.0)
        last, total = ev[j][0], ev[j][2]
        k = j + 1
        while k < n and ev[k][1] == "out" and ev[k][0] - last <= BURST_GAP:
            last, total = ev[k][0], total + ev[k][2]
            k += 1
        st.append((last - tk) * 1000.0)
        bursts.append(total)
        i = k
    return fb, st, bursts


def stats(xs):
    xs = sorted(xs)
    if not xs:
        return {}
    n = len(xs)
    q = lambda p: round(xs[min(n - 1, int(n * p))], 1)
    return {"n": n, "p50": round(xs[n // 2], 1), "p90": q(0.9), "p99": q(0.99),
            "max": round(xs[-1], 1)}


def pct(xs, thr):
    return round(100.0 * sum(1 for x in xs if x > thr) / max(1, len(xs)), 1)


def row(d):
    lc = (d.get("load_cpu") or {}).get("pi") or {}
    tc = (d.get("load_cpu") or {}).get("tmux") or {}
    ic = (d.get("idle_cpu") or {}).get("pi") or {}
    fb, st, bursts = latencies(read_timeline(d.get("events_file", "")))
    F, S = stats(fb), stats(st)
    keys = max(1, d.get("keystrokes") or 1)
    return {
        "tag": d["tag"], "mode": d["mode"], "transport": d["transport"],
        "cap": d["cap"], "boot_s": d["boot_s"], "settle_s": d.get("settle_s"),
        "landed": d.get("keystrokes_landed_on_screen"), "keys": keys,
        "cpu_p50": lc.get("p50"), "cpu_p90": lc.get("p90"),
        "cpu_max": lc.get("max"), "cpu_mean": lc.get("mean"),
        "idle_p50": ic.get("p50"),
        "tmux_p50": tc.get("p50"), "tmux_max": tc.get("max"),
        "fb_p50": F.get("p50"), "fb_p99": F.get("p99"),
        "set_p50": S.get("p50"), "set_p90": S.get("p90"),
        "set_p99": S.get("p99"), "set_max": S.get("max"),
        "set>100ms%": pct(st, 100), "set>250ms%": pct(st, 250),
        "set>500ms": sum(1 for x in st if x > 500),
        "kb_out": round(d["bytes_to_terminal"] / 1024.0, 1),
        "kb_per_key": round(d["bytes_to_terminal"] / 1024.0 / keys, 2),
        "burst_kb_max": round(max(bursts or [0]) / 1024.0, 1),
        "frames": d.get("frames_sync_marked"),
    }


COLS = [("tag", 38), ("boot_s", 7), ("settle_s", 9), ("landed", 7), ("keys", 5),
        ("cpu_p50", 8), ("cpu_p90", 8), ("cpu_max", 8), ("idle_p50", 9),
        ("tmux_p50", 9), ("fb_p50", 7), ("fb_p99", 7),
        ("set_p50", 8), ("set_p90", 8), ("set_p99", 8), ("set_max", 8),
        ("set>100ms%", 11), ("set>250ms%", 11), ("set>500ms", 10),
        ("kb_out", 9), ("kb_per_key", 11), ("burst_kb_max", 13)]

rows = []
for d in sys.argv[1:]:
    for f in sorted(glob.glob(os.path.join(d, "*.json"))):
        rows.append(row(json.load(open(f))))

print("".join(c.ljust(w) for c, w in COLS))
for r in rows:
    print("".join(str(r.get(c, "")).ljust(w) for c, w in COLS))
json.dump(rows, open("/tmp/pi-fs-arc/summary.json", "w"), indent=2)
