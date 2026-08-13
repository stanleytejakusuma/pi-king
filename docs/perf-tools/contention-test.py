#!/usr/bin/env python3
"""2x2: {native, tmux} x {idle, loaded}.

A generator emits a styled frame every 30ms (like pi streaming). We attach a
real client and measure INTER-ARRIVAL GAPS of relayed output. Perfect delivery
= steady 30ms gaps. Tail blowups = the pathology Stanley perceives.
"""
import fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time

SOCK = "pi-contend"
GEN = "/tmp/pi-audit/framegen.mjs"

def spawn_load(n):
    procs = []
    for _ in range(n):
        procs.append(subprocess.Popen(
            ["node", "-e", "for(;;){Math.sqrt(Math.random())}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    return procs

def measure(use_tmux, load_n, label, secs=8):
    loaders = spawn_load(load_n)
    time.sleep(1.0)
    try:
        if use_tmux:
            subprocess.run(["tmux", "-L", SOCK, "kill-server"], stderr=subprocess.DEVNULL)
            subprocess.run(["tmux", "-f", os.path.expanduser("~/.tmux.conf"), "-L", SOCK,
                            "new-session", "-d", "-s", "c", "-x", "196", "-y", "58",
                            "node", GEN], stderr=subprocess.DEVNULL)
            time.sleep(1.0)
            m, s = pty.openpty()
            fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 58, 196, 0, 0))
            p = subprocess.Popen(["tmux", "-L", SOCK, "attach-session", "-t", "c"],
                                 stdin=s, stdout=s, stderr=subprocess.DEVNULL, close_fds=True)
            os.close(s)
        else:
            m, s = pty.openpty()
            fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 58, 196, 0, 0))
            p = subprocess.Popen(["node", GEN], stdin=s, stdout=s,
                                 stderr=subprocess.DEVNULL, close_fds=True)
            os.close(s)

        time.sleep(1.2)
        drain_end = time.perf_counter() + 1.0   # BOUNDED: generator never goes quiet
        while time.perf_counter() < drain_end:
            r, _, _ = select.select([m], [], [], 0.05)
            if not r: continue
            try: os.read(m, 1 << 20)
            except OSError: break

        arrivals = []
        end = time.perf_counter() + secs
        while time.perf_counter() < end:
            r, _, _ = select.select([m], [], [], 0.2)
            if r:
                try: chunk = os.read(m, 1 << 20)
                except OSError: break
                if chunk:
                    arrivals.append(time.perf_counter())
        p.terminate()
        if use_tmux:
            subprocess.run(["tmux", "-L", SOCK, "kill-server"], stderr=subprocess.DEVNULL)
    finally:
        for l in loaders:
            l.kill()

    if len(arrivals) < 5:
        print(f"{label:<22} insufficient data ({len(arrivals)} arrivals)")
        return
    gaps = sorted((arrivals[i+1]-arrivals[i])*1000 for i in range(len(arrivals)-1))
    n = len(gaps)
    over = lambda t: sum(1 for g in gaps if g > t)
    print(f"{label:<22}{n:>7}{gaps[n//2]:>9.1f}{gaps[int(n*0.9)]:>9.1f}"
          f"{gaps[int(n*0.99)]:>9.1f}{gaps[-1]:>9.1f}{100*over(100)/n:>9.1f}%")

print(f"{'condition':<22}{'n':>7}{'p50':>9}{'p90':>9}{'p99':>9}{'max':>9}{'>100ms':>10}")
print("-" * 76)
measure(False, 0,  "native  idle")
measure(False, 10, "native  loaded(10)")
measure(True,  0,  "tmux    idle")
measure(True,  10, "tmux    loaded(10)")
