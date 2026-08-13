#!/usr/bin/env python3
"""4-condition harness: {regular, fullscreen} TUI x {native pty, tmux}.

Answers: what does ONE render event cost pi in a monolithic session, and how
much of that cost is WRITING the frame vs BUILDING it?

  * write cost -- bytes pi (or tmux) pushes at the terminal during the load
    window, plus the burst/gap distribution over those bytes. Direct test of
    "fullscreen only paints a viewport".
  * build cost -- %CPU of the pi process, derived from cumulative CPU time
    deltas (macOS `ps -o cputime` has 1/100s resolution; `ps -o pcpu` is a
    DECAYING LIFETIME AVERAGE and is wrong for a 60s window).

LOAD GENERATORS (all model-free and deterministic -- see the spec section
"TUI MODE (fullscreen)" for why a model-driven stream is not usable on a
monolith: every available provider rejects the context):
  typing  -- one keystroke every --type-interval s. pi-tui deliberately
             bypasses its 16ms render throttle for keyboard input
             (requestImmediateRender), so each keystroke forces one
             synchronous whole-document render. This is the documented
             pathological path.
  resize  -- toggles the terminal height by one row every 2s. In regular mode
             a resize triggers fullRender, which rewrites the ENTIRE rendered
             transcript. pi-king hits this on every attach (Fix 1).
  stream  -- sends a fixed prompt and lets the model answer. Requires a
             session small enough for the provider; kept for future use.

Both transports drive input through a pty we own, so keystrokes are
byte-identical between conditions; under tmux that pty belongs to a real
attached tmux CLIENT, i.e. the process that would paint pixels.

SAFETY: tmux work happens on a scratch socket (-L pikingperf) and never
touches the fleet's default socket.
"""
import argparse, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time

# Overridable so the same harness can A/B two INSTALLS, not just two TUI modes:
# `PI_PERF_CLI=~/.pi-lab/pi-coding-agent/dist/cli.js` runs the arm against a
# patched clone while the default arm runs the untouched system install.
CLI = os.environ.get(
    "PI_PERF_CLI",
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
)
PROMPT = "List the numbers 1 through 300, one per line, nothing else. Do not use any tools."
SOCKET = "pikingperf"
TMUX_SESSION = "perf"
COLS, ROWS = 196, 58
# Observed status bar: "... TURNS 6199  UNTRK 57  CTX 175k/1.0M (17.5%)".
# A bare "CTX " also occurs inside transcript TEXT, which regular mode dumps to
# scrollback on boot -- matching that declared readiness ~20s early on two runs
# and polluted a whole measurement pass. Match the used/total pair instead.
READY_RE = re.compile(r"CTX\s+[\d.]+[kKmMgG]?/[\d.]+[kKmMgG]?")
SYNC_END = b"\x1b[?2026l"   # END_SYNCHRONIZED_OUTPUT: exactly one per frame


def sh(*args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def cputime(pid):
    """Cumulative CPU seconds for pid (1/100s resolution), or None if gone."""
    out = sh("ps", "-p", str(pid), "-o", "cputime=").stdout.strip()
    if not out:
        return None
    try:
        parts = [float(p) for p in out.split(":")]
    except ValueError:
        return None
    total = 0.0
    for p in parts:
        total = total * 60 + p
    return total


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def open_pty():
    m, s = pty.openpty()
    set_winsize(s, ROWS, COLS)
    return m, s


def make_ctty():
    """preexec: give the child its own session with the pty slave as ctty.

    Without this the kernel delivers NO SIGWINCH on TIOCSWINSZ, because the
    slave is not the child's controlling terminal -- it silently inherits ours.
    Cost me a whole resize matrix that reported 0 bytes and 0% CPU and looked
    like "resize is free".
    """
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def scratch_env(status_dir, cap):
    env = dict(os.environ)
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    env["PI_KING_STATUS_DIR"] = status_dir
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    # pi-king spawns fleet sessions with PI_TUI_MAX_FULL_RENDER_LINES=3000
    # (fleet.ts:548/565), which arms the vendored render-cap patch. The honest
    # "regular" baseline is therefore the CAPPED one; cap=none shows what
    # upstream pi does with no pi-king patching at all.
    if cap and cap != "none":
        env["PI_TUI_MAX_FULL_RENDER_LINES"] = cap
    else:
        env.pop("PI_TUI_MAX_FULL_RENDER_LINES", None)
    return env


def pi_argv(session, mode, model):
    argv = ["node", CLI, "--session", session, "--tui-mode", mode, "-a"]
    if model:
        argv += ["--model", model]
    return argv


def tmux(*args):
    return sh("tmux", "-L", SOCKET, *args)


def tmux_cleanup(strict=True):
    ls = tmux("ls").stdout.strip()
    if not ls:
        return
    names = [line.split(":")[0] for line in ls.splitlines()]
    unexpected = [n for n in names if n != TMUX_SESSION]
    if unexpected and strict:
        raise SystemExit(f"REFUSING to clean: scratch socket has unexpected sessions {unexpected}")
    if TMUX_SESSION in names:
        tmux("kill-session", "-t", TMUX_SESSION)


def find_pi_pid(transport, child_pid):
    """pid of the pi process.

    pi rewrites its process title to bare "pi", so `ps -o command=` shows NO
    argv -- it cannot be found by session path or by "cli.js". Identify it
    structurally: native, the process we spawned IS pi; tmux, descend from the
    pane pid.
    """
    if transport == "native":
        return child_pid
    panes = tmux("list-panes", "-t", TMUX_SESSION, "-F", "#{pane_pid}").stdout.split()
    if not panes:
        return None
    queue, seen = [int(panes[0])], set()
    while queue:
        pid = queue.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        comm = os.path.basename(sh("ps", "-p", str(pid), "-o", "comm=").stdout.strip())
        if comm in ("pi", "node"):
            return pid
        queue += [int(c) for c in sh("pgrep", "-P", str(pid)).stdout.split()]
    return None


class Reader:
    """Timestamped reads off the pty master.

    Two independent cadence signals:
      * read bursts   -- reads separated by an idle gap == a terminal update.
      * sync-end marks-- pi wraps each frame in \\e[?2026h ... \\e[?2026l, so
        counting the closer counts FRAMES exactly. tmux does NOT forward these
        to a client whose terminfo lacks Sync, so frames==0 under tmux is
        expected and the burst signal is used instead.
    """

    def __init__(self, fd):
        self.fd = fd
        self.events = []          # (t, nbytes, nframes)
        self.tail = ""
        self.recording = False
        self.total = 0
        self.frames = 0
        self._carry = b""
        self.marks = []           # (t, "key") keystroke send times

    def pump(self, seconds, keep_tail=True, slice_s=0.02):
        end = time.time() + seconds
        while True:
            left = end - time.time()
            if left <= 0:
                return True
            r, _, _ = select.select([self.fd], [], [], min(slice_s, left))
            if not r:
                continue
            try:
                data = os.read(self.fd, 1 << 20)
            except OSError:
                return False
            if not data:
                return False
            t = time.time()
            if self.recording:
                nf = (self._carry + data).count(SYNC_END)
                self._carry = data[-8:]
                self.frames += nf
                self.events.append((t, len(data), nf))
                self.total += len(data)
            if keep_tail:
                self.tail = (self.tail + data.decode("utf8", "replace"))[-40000:]


def wait_quiet(reader, pid, threshold=15.0, need=4, timeout=120.0):
    """Block until pi's CPU has been below `threshold`% for `need` samples.

    Replaces a fixed settle. Boot does transcript layout, extension loading and
    session indexing whose duration varies by 4x between conditions, so a flat
    sleep leaves some runs still busy when idle sampling starts -- which shows
    up as a fake idle-CPU floor and inflates that condition's load numbers.
    """
    t0 = time.time()
    last, last_w, run = cputime(pid), time.time(), 0
    while time.time() - t0 < timeout:
        reader.pump(1.0)
        now = time.time()
        cur = cputime(pid)
        if cur is None:
            return None
        pct = 100.0 * (cur - last) / max(1e-6, now - last_w)
        last, last_w = cur, now
        run = run + 1 if pct < threshold else 0
        if run >= need:
            return round(time.time() - t0, 1)
    return None


def stats(xs):
    xs = sorted(x for x in xs if x >= 0)
    if not xs:
        return None
    n = len(xs)
    q = lambda p: round(xs[min(n - 1, int(n * p))], 1)
    return {"n": n, "p50": round(xs[n // 2], 1), "p90": q(0.9), "p99": q(0.99),
            "max": round(xs[-1], 1), "mean": round(sum(xs) / n, 1)}


def screen_text(transport, reader):
    if transport == "tmux":
        return tmux("capture-pane", "-p", "-t", TMUX_SESSION).stdout
    return reader.tail


def run_load(args, reader, m, pid, tmux_pid):
    """Apply the load while sampling CPU. Returns (cpu, keystrokes, resizes)."""
    interval = 0.5
    samples, tsamples = [], []
    last, lastt = cputime(pid), (cputime(tmux_pid) if tmux_pid else None)
    last_w = time.time()
    end = last_w + args.load_secs
    next_type = last_w + (args.type_interval if args.load == "typing" else 1e9)
    next_resize = last_w + (args.resize_interval if args.load == "resize" else 1e9)
    keystrokes = resizes = 0
    tall = True

    if args.load == "stream":
        os.write(m, PROMPT.encode())
        time.sleep(0.7)
        os.write(m, b"\r")

    while time.time() < end:
        # Pump only up to the next scheduled event, so keystroke timing is not
        # quantised by the pump slice (an earlier version pumped a flat 0.25s
        # and silently turned a 10Hz metronome into ~3Hz).
        nxt = min(next_type, next_resize, last_w + interval, end)
        reader.pump(max(0.0, min(nxt - time.time(), interval)), slice_s=0.005)
        now = time.time()
        # Only close a CPU window when it is wide enough that `ps` cputime's
        # 10ms quantisation cannot manufacture a fake spike.
        if now - last_w >= interval * 0.8:
            cur = cputime(pid)
            if cur is not None and last is not None:
                samples.append(100.0 * (cur - last) / (now - last_w))
            last = cur
            if tmux_pid:
                curt = cputime(tmux_pid)
                if curt is not None and lastt is not None:
                    tsamples.append(100.0 * (curt - lastt) / (now - last_w))
                lastt = curt
            last_w = now
        if now >= next_type:
            try:
                os.write(m, b"x")
                reader.marks.append((time.time(), "key"))
                keystrokes += 1
            except OSError:
                pass
            next_type = now + args.type_interval
        if now >= next_resize:
            tall = not tall
            set_winsize(m, ROWS if tall else ROWS - 1, COLS)
            reader.marks.append((time.time(), "key"))
            resizes += 1
            next_resize = now + args.resize_interval
            if resizes == 1:
                probe_t = time.time()
                reader.pump(1.0, slice_s=0.005)
                if not reader.events or reader.events[-1][0] < probe_t:
                    print("WARNING: first resize produced no output -- SIGWINCH "
                          "is not reaching the child", file=sys.stderr)
    return {"pi": stats(samples), "tmux": stats(tsamples) if tmux_pid else None}, keystrokes, resizes


def run(args):
    os.makedirs(args.out, exist_ok=True)
    status_dir = os.path.join(args.out, "status")
    os.makedirs(status_dir, exist_ok=True)
    env = scratch_env(status_dir, args.cap)
    m, s = open_pty()
    reader = Reader(m)
    cwd = json.loads(open(args.session).readline()).get("cwd") or os.getcwd()

    if args.transport == "native":
        proc = subprocess.Popen(pi_argv(args.session, args.mode, args.model),
                                stdin=s, stdout=s, stderr=s, close_fds=True,
                                env=env, cwd=cwd, preexec_fn=make_ctty)
        os.close(s)
    else:
        tmux_cleanup()
        cmd = " ".join(f"'{a}'" for a in pi_argv(args.session, args.mode, args.model))
        r = tmux("new-session", "-d", "-s", TMUX_SESSION, "-x", str(COLS), "-y", str(ROWS),
                 "-c", cwd, cmd)
        if r.returncode != 0:
            raise SystemExit(f"tmux new-session failed: {r.stderr}")
        proc = subprocess.Popen(["tmux", "-L", SOCKET, "attach", "-t", TMUX_SESSION],
                                stdin=s, stdout=s, stderr=s, close_fds=True,
                                env=env, preexec_fn=make_ctty)
        os.close(s)

    # ---- wait for boot (extensions take 10-30s; poll, never sleep blindly)
    t0 = time.time()
    boot = None
    while time.time() - t0 < args.boot_timeout:
        reader.pump(0.5)
        if READY_RE.search(screen_text(args.transport, reader)):
            boot = time.time() - t0
            break
    if boot is None:
        print("NOT READY. tail:\n" + screen_text(args.transport, reader)[-1500:], file=sys.stderr)
        raise SystemExit("pi never reached a ready prompt")

    pid = find_pi_pid(args.transport, proc.pid)
    if not pid:
        raise SystemExit("could not locate pi pid")
    tmux_pid = None
    if args.transport == "tmux":
        tp = sh("pgrep", "-f", f"tmux -L {SOCKET}").stdout.split()
        tmux_pid = int(tp[0]) if tp else None
    print(f"[pi pid {pid}, boot {boot:.1f}s]", file=sys.stderr)

    settle = wait_quiet(reader, pid)   # measured quiescence, not a fixed sleep
    if settle is None:
        print("WARNING: pi never went quiet after boot", file=sys.stderr)
    idle, _, _ = run_load(argparse.Namespace(**{**vars(args), "load": "none",
                                               "load_secs": args.idle_secs}),
                          reader, m, pid, tmux_pid)

    # ---- load window
    size_before = os.path.getsize(args.session)
    reader.recording = True
    load_t0 = time.time()
    cpu, keystrokes, resizes = run_load(args, reader, m, pid, tmux_pid)
    load_dur = time.time() - load_t0
    reader.recording = False
    reader.pump(1.0)

    # ---- PROVE the load actually reached the application. A run where the
    # keystrokes never landed would look like a spectacular perf win.
    screen = screen_text(args.transport, reader)
    landed = bool(re.search(r"x{20,}", screen))
    streamed = False
    if args.load == "stream":
        with open(args.session, "rb") as f:
            f.seek(size_before)
            blob = f.read().decode("utf8", "replace")
        for line in blob.splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") == "message" and d.get("message", {}).get("role") == "assistant":
                text = "".join(p.get("text", "") for p in d["message"].get("content", []))
                if "297" in text and "300" in text:
                    streamed = True

    tag = f"{args.mode}-{args.transport}-{args.load}-cap{args.cap}"
    result = {
        "tag": tag, "mode": args.mode, "transport": args.transport,
        "load": args.load, "cap": args.cap, "session": args.session,
        "session_bytes": os.path.getsize(args.session),
        "boot_s": round(boot, 2), "settle_s": settle,
        "load_s": round(load_dur, 2),
        "keystrokes": keystrokes, "resizes": resizes,
        "keystrokes_landed_on_screen": landed,
        "streamed_ok": streamed if args.load == "stream" else None,
        "bytes_to_terminal": reader.total,
        "frames_sync_marked": reader.frames,
        "read_events": len(reader.events),
        "idle_cpu": idle, "load_cpu": cpu,
        "cols": COLS, "rows": ROWS,
    }
    if args.load == "typing" and not landed:
        print("WARNING: typed characters never appeared on screen", file=sys.stderr)

    # One merged timeline: keystrokes and terminal reads on the same clock, so
    # both first-byte latency and frame-settle latency are derivable offline.
    ev_path = os.path.join(args.out, f"{tag}-timeline.txt")
    tl = [(t, "key", 0, 0) for t, _ in reader.marks]
    tl += [(t, "out", n, nf) for t, n, nf in reader.events]
    tl.sort()
    with open(ev_path, "w") as f:
        for t, kind, n, nf in tl:
            f.write(f"{t - load_t0:.6f} {kind} {n} {nf}\n")
    result["events_file"] = ev_path

    # ---- shutdown
    try:
        os.write(m, b"\x03")
        time.sleep(0.4)
        os.write(m, b"\x03")
    except OSError:
        pass
    time.sleep(1.5)
    if args.transport == "tmux":
        tmux_cleanup(strict=False)
    if proc.poll() is None:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=15)
        except Exception:
            proc.terminate()
    # verify-before-kill: only a pid the harness itself spawned
    if args.transport == "native" and pid == proc.pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    out_json = os.path.join(args.out, f"{tag}.json")
    with open(out_json, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["regular", "fullscreen"], required=True)
    ap.add_argument("--transport", choices=["native", "tmux"], required=True)
    ap.add_argument("--load", choices=["typing", "resize", "stream", "none"], default="typing")
    ap.add_argument("--session", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=None)
    ap.add_argument("--cap", default="3000", help="PI_TUI_MAX_FULL_RENDER_LINES, or 'none'")
    ap.add_argument("--boot-timeout", type=float, default=240)
    ap.add_argument("--idle-secs", type=float, default=10)
    ap.add_argument("--load-secs", type=float, default=60)
    ap.add_argument("--type-interval", type=float, default=0.1)
    ap.add_argument("--resize-interval", type=float, default=2.0)
    run(ap.parse_args())
