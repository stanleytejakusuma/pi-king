#!/usr/bin/env python3
"""Measure keystroke->echo latency with and without a CPU-bound render loop,
both NATIVE (bare pty) and under TMUX, to separate the two variables."""
import fcntl, os, pty, select, struct, subprocess, sys, termios, time

def raw(fd):
    a = termios.tcgetattr(fd)
    a[0] &= ~(termios.IXON | termios.ICRNL | termios.INLCR | termios.IGNCR)
    a[3] &= ~(termios.ECHO | termios.ICANON | termios.ISIG | termios.IEXTEN)
    a[6][termios.VMIN] = 0
    a[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, a)

def measure(cmd, use_tmux, label, n=20):
    sock = "pi-king-starve"
    if use_tmux:
        subprocess.run(["tmux", "-L", sock, "kill-server"], stderr=subprocess.DEVNULL)
        subprocess.run(["tmux", "-f", os.path.expanduser("~/.tmux.conf"), "-L", sock,
                        "new-session", "-d", "-s", "st", "-x", "224", "-y", "63"] + cmd)
        time.sleep(0.8)
        m, s = pty.openpty()
        fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 63, 224, 0, 0))
        raw(s)
        p = subprocess.Popen(["tmux", "-L", sock, "attach-session", "-t", "st"],
                             stdin=s, stdout=s, stderr=subprocess.DEVNULL, close_fds=True)
        os.close(s)
    else:
        m, s = pty.openpty()
        fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 63, 224, 0, 0))
        raw(s)
        p = subprocess.Popen(cmd, stdin=s, stdout=s, stderr=subprocess.DEVNULL, close_fds=True)
        os.close(s)

    time.sleep(1.0)
    while True:
        r, _, _ = select.select([m], [], [], 0.1)
        if not r:
            break
        try: os.read(m, 65536)
        except OSError: break

    times = []
    for i in range(n):
        t0 = time.perf_counter()
        os.write(m, b"x")
        deadline = t0 + 1.0
        got = b""
        while time.perf_counter() < deadline:
            r, _, _ = select.select([m], [], [], 0.01)
            if r:
                try: chunk = os.read(m, 65536)
                except OSError: break
                got += chunk
                if len(got) > 0:
                    break
        times.append((time.perf_counter() - t0) * 1000)
        time.sleep(0.02)

    p.terminate()
    if use_tmux:
        subprocess.run(["tmux", "-L", sock, "kill-server"], stderr=subprocess.DEVNULL)
    times.sort()
    k = len(times)
    print(f"{label:38s} p50={times[k//2]:7.2f}ms p90={times[int(k*0.9)]:7.2f}ms max={times[-1]:7.2f}ms")
    sys.stdout.flush()
    return times[k//2]

SIM = "/tmp/pi-audit/eventloop-starve.mjs"
print("=== keystroke -> echo latency ===")
measure(["node", SIM, "idle"], False, "native  + idle render loop")
measure(["node", SIM, "busy", "60"], False, "native  + BUSY render loop (60ms)")
measure(["node", SIM, "idle"], True,  "tmux    + idle render loop")
measure(["node", SIM, "busy", "60"], True,  "tmux    + BUSY render loop (60ms)")
