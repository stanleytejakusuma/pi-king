#!/usr/bin/env python3
"""Differential CPU profiling of pi: LOAD-ONLY vs LOAD+STREAM.

Both runs are identical up to the prompt, so subtracting per-function self
time isolates what STREAMING costs -- no idle dilution, no guessing where the
streaming window starts inside one profile.

Runs on a raw pty (NOT tmux) so this measures pi's own cost with tmux removed
as a variable.
"""
import fcntl, os, pty, select, struct, subprocess, sys, termios, time

CLI = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
PROMPT = "List the numbers 1 through 300, one per line, nothing else. Do not use any tools."

def drive(session_file, prof_dir, do_stream, load_wait=28, stream_wait=70):
    os.makedirs(prof_dir, exist_ok=True)
    m, s = pty.openpty()
    fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 58, 196, 0, 0))
    env = dict(os.environ)
    env["PI_TUI_MAX_FULL_RENDER_LINES"] = "3000"
    p = subprocess.Popen(
        ["node", "--cpu-prof", f"--cpu-prof-dir={prof_dir}", CLI, "--session", session_file],
        stdin=s, stdout=s, stderr=s, close_fds=True, env=env)
    os.close(s)

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([m], [], [], 0.2)
            if r:
                try: os.read(m, 1 << 20)
                except OSError: return

    def cpu():
        try:
            out = subprocess.run(["ps","-p",str(p.pid),"-o","pcpu="],
                                 capture_output=True, text=True).stdout.strip()
            return float(out) if out else 0.0
        except Exception:
            return 0.0

    pump(load_wait)
    samples = []
    if do_stream:
        os.write(m, PROMPT.encode())
        time.sleep(0.7)
        os.write(m, b"\r")
        end = time.time() + stream_wait
        while time.time() < end:
            r, _, _ = select.select([m], [], [], 0.2)
            if r:
                try: os.read(m, 1 << 20)
                except OSError: break
            samples.append(cpu())
    # graceful exit so --cpu-prof flushes
    os.write(m, b"\x03")
    time.sleep(0.5)
    os.write(m, b"\x03")
    time.sleep(2)
    p.send_signal(subprocess.signal.SIGINT)
    try: p.wait(timeout=25)
    except Exception:
        p.terminate()
        try: p.wait(timeout=10)
        except Exception: p.kill()
    live = [x for x in samples if x > 0]
    if live:
        live.sort()
        print(f"  cpu during stream: p50={live[len(live)//2]:.1f}% max={live[-1]:.1f}% (n={len(live)})")
    return prof_dir

if __name__ == "__main__":
    mode = sys.argv[1]           # load | stream
    sess = sys.argv[2]
    out  = sys.argv[3]
    drive(sess, out, do_stream=(mode == "stream"))
    print(f"  profile written to {out}")
