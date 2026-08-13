#!/usr/bin/env python3
"""Measures the tmux SERVER's CPU cost of parsing/modeling heavily-styled
output vs coalesced output carrying identical visible text.

tmux relays screen state, so relayed bytes are a bad proxy. What actually
costs is: parse every SGR -> update per-cell attributes -> recompute damage.
This feeds identical text N times under both styling schemes and compares the
tmux server's consumed CPU time.
"""
import os, subprocess, time

SOCK = "pi-style-cpu"
PINK = "\x1b[38;2;255;152;165m"
RESET = "\x1b[39m"
WORDS = ("the quick brown fox jumps over the lazy dog " * 6).split(" ")

def build(mode, lines=40):
    rows = []
    for _ in range(lines):
        if mode == "heavy":
            rows.append("".join(f"{PINK}{w}{RESET} " for w in WORDS))
        else:
            rows.append(PINK + " ".join(WORDS) + RESET)
    return "\r\n".join(rows) + "\r\n"

def server_cpu(pid):
    out = subprocess.run(["ps", "-p", str(pid), "-o", "time="],
                         capture_output=True, text=True).stdout.strip()
    # format mm:ss.ss or hh:mm:ss
    parts = out.split(":")
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        pass
    return 0.0

def run(mode, reps=60):
    subprocess.run(["tmux", "-L", SOCK, "kill-server"], stderr=subprocess.DEVNULL)
    subprocess.run(["tmux", "-f", os.path.expanduser("~/.tmux.conf"), "-L", SOCK,
                    "new-session", "-d", "-s", "st", "-x", "196", "-y", "58", "cat"],
                   stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    pid = int(subprocess.run(["tmux", "-L", SOCK, "display-message", "-p", "#{pid}"],
                             capture_output=True, text=True).stdout.strip())
    fn = f"/tmp/pi-audit/_cpu_{mode}.txt"
    open(fn, "w").write(build(mode))
    payload_size = os.path.getsize(fn)

    subprocess.run(["tmux", "-L", SOCK, "load-buffer", "-b", "b1", fn])
    before = server_cpu(pid)
    t0 = time.perf_counter()
    for _ in range(reps):
        subprocess.run(["tmux", "-L", SOCK, "paste-buffer", "-b", "b1", "-t", "st", "-d"],
                       stderr=subprocess.DEVNULL)
        subprocess.run(["tmux", "-L", SOCK, "load-buffer", "-b", "b1", fn])
    time.sleep(1.5)  # let the server finish processing
    wall = time.perf_counter() - t0
    after = server_cpu(pid)
    subprocess.run(["tmux", "-L", SOCK, "kill-server"], stderr=subprocess.DEVNULL)
    return payload_size, after - before, wall

print(f"{'variant':<12}{'payload B':>11}{'tmux CPU s':>12}{'wall s':>9}{'CPU per MB':>12}")
print("-" * 56)
res = {}
for mode in ("heavy", "coalesced"):
    size, cpu, wall = run(mode)
    mb = (size * 60) / (1024 * 1024)
    res[mode] = cpu
    print(f"{mode:<12}{size:>11}{cpu:>12.2f}{wall:>9.1f}{cpu/max(mb,0.001):>12.2f}")
if res.get("coalesced", 0) > 0:
    print(f"\nheavy costs {res['heavy']/res['coalesced']:.2f}x the tmux CPU of coalesced "
          f"(identical visible text)")
