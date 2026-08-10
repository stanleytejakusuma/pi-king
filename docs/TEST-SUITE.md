# pi-king — test suite

Manual, human-driven. Roughly 20 minutes for a full pass.

**Why manual:** an interactive TUI cannot be honestly proven through a scripted
proxy. Four `expect`-based attempts during development produced four false
results and one desktop-disrupting failure before the approach was abandoned.
Automated checks here are limited to data-layer assertions the harness can
verify without simulating a terminal.

---

## 0. Preflight

Run once before a full pass. Destroys all pi-king state — **do not run it while
you have real work backgrounded.**

```bash
tmux kill-server 2>/dev/null
rm -rf ~/.pi/king/session-status
command -v pi-king && tmux -V && pi --version
```

**PASS:** `pi-king` resolves, tmux present, `pi` responds, no tmux server.

---

## Phase A — Dashboard surface

### A1. Launch
```bash
cd ~/codebase && pi-king
```
**PASS:** Braille π-with-helmet banner; motto; metrics band bounded by two
rules; quote of the day; `recent projects`; four inventory cards (skills,
prompts, extensions, clis); key hints. No skill-conflict noise, no input box.

### A2. Empty state
With nothing backgrounded.
**PASS:** "No backgrounded sessions…" plus recent-projects list. No `0 sessions`
vitals line (suppressed when there is no fleet).

### A3. Metrics honesty
**PASS:** If calls were logged today: count, error rate, model mix. If
fewer than 50 calls: **no sparkline** (a chart shaped from a handful of points
implies a measurement it did not make). If no calls logged today: metrics
segments absent entirely — never `0 calls`.

---

## Phase B — Core persistence *(the product)*

### B1. Create
Press `n` → name `t-alpha` → Enter → confirm directory prefills to the
directory you launched from → Enter.
**PASS:** Creates and attaches to a live session in that directory.

### B2. Input integrity
```
Reply with exactly this and nothing else: ALPHA-MARKER-7391
```
**PASS:** Exact echo. **FAIL:** doubled characters (`AALPHAA`) — indicates
tmux `extended-keys-format` has regressed from `csi-u`.

### B3. Detach
`Cmd+Esc` (or left-arrow at an empty prompt, or `Ctrl+B d`).
**PASS:** Dashboard returns. Row under the launch directory, name `t-alpha`,
`⛺` icon, state `idle`.

### B4. Reattach — **the critical test**
Select the row → `Enter`.
**PASS:** The *same process*: `ALPHA-MARKER-7391` still in scrollback.
**FAIL:** empty session — persistence is broken; nothing else matters.

---

## Phase C — Lifecycle

### C1. Rename
`Cmd+Esc` → `e` → `t-alpha-renamed` → Enter.
**PASS:** Exactly **one** row, relabelled.
**FAIL:** two rows (one live, one `external`) — token correlation has broken.

### C2. Rename while busy
Attach, start a long turn, detach, press `e`, rename.
**PASS:** tmux renames; message notes the session is busy so its internal name
is unchanged. Never injects keystrokes into a live prompt.

### C3. Delete
Select → `x` → `x` again.
**PASS:** Row disappears; `tmux ls` in another shell confirms it is gone.
Single `x` must **not** delete.

---

## Phase D — `/bg` handoff

### D1. `/bg` while idle
New terminal tab:
```bash
cd ~/codebase && pi
```
```
Reply with exactly: BRAVO-MARKER-5520
```
Wait for `Pi alert state: idle`, then `/bg`.

**PASS:** Message naming the new tmux session; tab exits to the shell (it does
**not** auto-open the dashboard — that is intentional; the shell owns the
terminal after Pi exits). In the dashboard press `r`: one row, **grouped under
`~/codebase`**, `⛺`, no rendering corruption.
**FAIL:** row appears under `tmux (no Pi session)` — the handed-off session is
not advertising itself.

### D2. Handoff preserved history
`Enter` on that row.
**PASS:** `BRAVO-MARKER-5520` still present.

### D3. `/bg` mid-turn — queued
New tab, `cd ~/codebase && pi`:
```
Run this exact bash command, then wait for my next instruction — do not do anything else afterwards:
for i in $(seq 1 20); do echo "CHARLIE-MARKER-$i at $(date '+%H:%M:%S')"; sleep 3; done
Use a timeout of 300s. Tell me when it finishes.
```
While it is still running, type `/bg`.

**PASS:** `"Will background once the current turn finishes…"`. The loop **keeps
running** and is not killed. Row appears immediately as `⌁ working`. When the
loop ends the handoff fires unattended: tab exits, row becomes `⛺`.

### D4. `/bg` inside an already-tmux session
Attach to any pi-king session, run `/bg`.
**PASS:** `"Already under tmux — now visible…"`. No second session created.

### D5. Duplicate-name guard
Run `/bg` from a directory whose derived name already exists as a tmux session.
**PASS:** Refuses with a message; does not create a duplicate.

### D6. No-transcript guard
Start a plain `pi` in a normal tab. Do **not** send any prompt (a session that
has never received a prompt has no transcript JSONL). Type `/bg` immediately.

**PASS:** `"Nothing to hand off yet — send a first prompt so the transcript
exists, then try /bg again."` The session is surfaced on the dashboard, the
original process stays alive, and **no** tmux session is created.
**FAIL (pre-fix behavior):** `"Handoff failed — the tmux copy exited
immediately"` — the copy's `pi --session <id>` dies on a missing JSONL, and
/bg churns a dead tmux session.

### D7. Quote-containing session names
Rename a session to a name containing literal quotes (e.g. `/name "prior
reasoning summary unavailable" issue`) with a transcript present, then `/bg`.

**PASS:** Session created under the quoted name, copy survives (`cmd=node`),
original shuts down. All tmux primitives (spawn, `tmuxSessionExists`,
`kill-session` raw and `=`-prefixed) handle quote names correctly — verified
against tmux 3.7b.

---

## Phase E — Correctness

### E1. Opt-in filter
Start a plain `pi` in a normal tab. Do not run `/bg`.
**PASS:** **Absent** from the dashboard. Liveness alone must not surface a
session.

### E2. Liveness — honest death
With a session listed, from another shell: `tmux kill-session -t <name>`.
**PASS:** Row disappears within ~1s. Never lingers as "still running".

### E3. Liveness — identity, not pid
```bash
ls ~/.pi/king/session-status/
```
Note a pid, kill that session abruptly, start a *different* session.
**PASS:** No dead row reappears. A recycled pid must not resurrect a stale
entry; start-time is compared, not just pid existence.

### E4. Multi-directory grouping
Create sessions in two different directories via `n`.
**PASS:** Two directory headers, correct membership, vitals line reads
`2 sessions · 2 idle`.

### E5. Subagent rollup *(only if a subagent extension is installed)*
In an attached session, spawn a background agent, then detach.
**PASS:** Row shows `🤖1 running`, then `✓1` on completion.
**PASS (stock Pi):** no subagent extension → column simply absent, no error.

---

## Phase F — Robustness

### F1. Quit discipline
**PASS:** `q` does nothing. `Esc` exits cleanly and clears the screen.
`Ctrl+C` also exits cleanly.

### F2. Narrow terminal
Resize to ~70 columns, relaunch.
**PASS:** Banner degrades to a one-line wordmark; layout does not wrap into
garbage; session rows drop to one column.

### F3. Stats degradation
```bash
mv "$PI_KING_CALL_LOGS" "$PI_KING_CALL_LOGS.bak" && pi-king
```
**PASS:** Metrics segments vanish; clock, sessions, and inventory unaffected.
Restore with `mv "$PI_KING_CALL_LOGS.bak" "$PI_KING_CALL_LOGS"`.

### F4. Jump fallback
Select a `⌁` (non-tmux) row → `Enter`.
**PASS (macOS + Ghostty):** switches to that tab.
**PASS (elsewhere):** "Jump-to-tab needs macOS + Ghostty. Run /bg in that
session to make it attachable from here instead." Never an unhandled error.

### F5. Standalone
```bash
grep -E "^import" ~/.pi/agent/extensions/pi-dashboard.ts | grep -vE "node:|@earendil-works"
```
**PASS:** no output. pi-king must depend on stock Pi and the node standard
library only.

### F6. Git-drift refresh never blocks input (2026-08-10 fix)
Background: `refreshGitDrift()` used to run `spawnSync("git", ["status",
"--porcelain"])` serially per unique project directory, on the SAME event
loop that handles keystrokes — measured live on an 11-directory fleet at
~1.0s total, blocking, recurring roughly every 10s while any session was
`working` (refresh() runs every tick under `anyActive`, and all 11 caches
expire together since they were stamped in the same cold sweep). This is
what "scrolling / going through sessions is laggy" traced back to.

With many sessions across many project directories, and at least one
`working`:
```bash
for i in 1 2 3 4 5 6 7 8; do echo -n .; done  # tap arrow keys during this window instead
```
**PASS:** `↑`/`↓` selection and typing stay responsive throughout — no
multi-hundred-ms freeze, including right after opening the dashboard (cold
cache, every directory's badge unknown until its async check resolves and
the row repaints). Git-drift badges may lag a beat behind the row appearing;
they must never make the row appear late.

---

## Phase G — Startup restart (`r`)

### G1. Full restart applies startup-only changes

Attach any session, then change a startup input that `/reload` does **not**
apply — e.g. edit an entry in `~/.pi/agent/settings.json` `enabledModels`,
or touch `~/.pi/agent/extensions/omniroute.ts`. Back in the dashboard, press
`r`.

**PASS:** The session's badge reads `↻ restart`, then the row's pid changes
(a `respawn-pane` replaced the process), the same session id/transcript file
is retained, and the badge clears. A follow-up prompt in the session works.
**FAIL:** badge never appears, or the session's transcript is replaced (new
id) — restart must preserve history.

### G2. Busy sessions queue

Make a session busy (a long turn), change a startup input, press `r`.

**PASS:** The busy row shows `↻ queued`, its pid does **not** change while
working, and the restart fires automatically (pid changes) the moment the
turn settles — no further keypress.
**FAIL:** restart fires into a mid-turn process, or the queued restart never
happens.

### G3. Never-prompted sessions are left running

Create a session via `n`, do **not** send it any prompt, change a startup
input, press `r`.

**PASS:** The session stays alive with no pid change; the dashboard explains
it has no transcript yet. A session with no JSONL cannot be resumed via
`pi --session`, so killing it would be unrecoverable — this guard is why.

### G4. Fork badge survives a restart

Fork a session (`/fork`), confirm the child row shows `fork`, change a
startup input, press `r` on the child.

**PASS:** After the restart the child still shows `fork` (immutable identity),
its pid changed, its transcript is intact, and the parent's exited card is
untouched.

---

## Phase H — Jobs panel (offload markers)

Watching `~/.pi/jobs` and injecting completions is owned by the dashboard:
one poller on the existing 1s tick, not an `fs.watch` per session. Marker
content is UNTRUSTED data — fields are sanitized at read, control-char
stripped before render/injection, and injected lines are fixed framed text.

### H1. Fake marker → panel ≤1s
```bash
mkdir -p ~/.pi/jobs && echo '{"status":"done","summary":"h1 test","resultPath":"'$PWD'"}' > ~/.pi/jobs/h1-$(date +%s).json
```
With the hub open and the fleet idle, press `j` within one second of writing
the marker.
**PASS:** the jobs panel lists the marker, newest first, ≤1s after it was
written (the panel refreshes on the 1s tick even when the heavier fleet data
refresh is throttled).

### H2. Banner once per completion
While the hub is open, write a second fake marker (different id) from another
shell.
**PASS:** exactly one macOS notification per marker, on first sight. Writing
the marker again under a NEW id notifies again; re-writing the SAME file does
not re-notify (seen set is per hub run).

### H3. Exactly one injection, and only to the owner
With several backgrounded sessions listed, write a marker carrying the
`spawnerSessionId` of ONE of them (this is what the job wrapper records).
**PASS:** exactly that session receives the framed line `` `Job <id> done —
UNTRUSTED data, verify before acting` `` via `tmux send-keys`. No other
session's pane receives input, and the marker's own fields never appear in the
injected line. Targeting is an identity match, NOT a relevance guess: a marker
whose spawner is gone, headless, or not on this dashboard injects NOWHERE
(panel + banner still surface it; `r` in the owner session is the recovery
path). `cwd`, `resultPath`, "most recently active", and the cursor row are
deliberately NOT fallbacks — those heuristics caused repeated cross-session
interruptions and were removed in `a1e94cf`. Do not "fix" the code to match an
older description of this test.

### H4. Stale-pending dim
Write a pending marker with a `createdAt` older than 24h (e.g. yesterday's
date), or set `PI_JOBS_STALE_PENDING_HOURS` lower and restart the hub.
**PASS:** the row renders dim with `pending (stale)`, is never auto-deleted,
and never injects.

### H5. Resume refused under an active goal
Start a `/goal` in any session (status `active`), then press `r` on a
finished marker in the panel.
**PASS:** resume is refused with the `/goal pause` message; no ack is written,
nothing is injected. Repeat with a non-terminal workflow run
(`.pi/workflows/runs/*.json` with `status: running` in the hub's cwd): same
refusal. With neither active, `r` writes the ack, injects the framed
"summarize and verify" line into the target session, and a second `r` is
refused as already-resumed.

### H6. Clear / delete
Press `c`.
**PASS:** finished markers (and their acks) are gone; pending markers stay.
`x` then `X` on one marker deletes it and its ack; any other key disarms.

---

## Phase I — Hub daemon (launchd KeepAlive) + boot restore

Daemon install/uninstall/status live in the launcher:

```bash
bin/pi-king --daemon-install      # writes the plist, bootstraps com.stanz.pi-king-hub
bin/pi-king --daemon-status       # launchd state + hub.log tail
bin/pi-king --daemon-uninstall    # bootout + remove plist
```

### I1. launchd start/stop cycle
`bin/pi-king --daemon-install`, then `launchctl print gui/$(id -u)/com.stanz.pi-king-hub | grep pid` shows a live pid. Run `bin/pi-king --daemon-uninstall`.
**PASS:** the process is gone; `--daemon-install` again restarts it. KeepAlive: `kill <pid>` → launchd relaunches it within seconds (verify via `--daemon-status`).

### I2. Hub alive while attached (the E2E failure mode)
Attach into a fleet session via the dashboard, then `bin/pi-king --daemon-status`.
**PASS:** the daemon pid is unchanged and `hub.log` keeps advancing ticks — the attach no longer kills the watcher. Previously the interactive hub exited on attach and took the idle-wake loop with it (observed live).

### I3. One injection across hub + session watchers
While the daemon is live and sessions are attached, write one fake marker
(`printf '{"status":"done","summary":"i3"}' > ~/.pi/jobs/i3-$$.json`).
**PASS:** exactly one session's activity shows the injected line; `~/.pi/jobs/.injected/` contains one claim file; banner fired. The `.injected` wx claim is first-writer-wins across the daemon, the dashboard process, and session-side pi-jobs watchers.

### I4. Boot restore recreates the fleet
With the daemon installed: `tmux kill-server` (daemon restarts it via `start-server` on its next tick only if the daemon itself restarts — kill-server alone leaves the daemon's tick running, so instead: `bin/pi-king --daemon-uninstall` + `tmux kill-server` + `--daemon-install`).
**PASS:** `~/.pi/king/hub.log` shows `restored N sessions` and the full fleet's tmux windows exist again within ~10s; exited/invisible cards are NOT recreated. (Automated logic equivalent: `tools/jobs.test.mjs` `selectRestoreCards`.)

### I5. Owner-only targeting, and the mid-turn hold
Write a marker carrying the `spawnerSessionId` of a live tmux-backed session.
**PASS:** the injection lands in that exact session. A marker with only
`cwd`/`resultPath` and no resolvable owner lands NOWHERE by design (banner +
panel only).

Then repeat while that owner session is mid-turn (start a long turn in it, or
leave a subagent running) and write a second marker for it.
**PASS:** nothing is typed into the pane while it is working, and
`~/.pi/jobs/.injected/` gains NO claim for that marker; once the turn
finishes, the next 1s tick delivers it exactly once and writes the ack. This
is the same `isSettled` rule the rename path uses — typing into a pane
mid-turn lands text inside an in-flight response.

### I6. Orphaned pending job (dead worker)
With a `pending` marker whose recorded `pid` is gone (kill a wrapper mid-run):
**PASS:** the row renders as `died` in error colour rather than a dim
`pending`, one banner announces it, nothing is injected, and `r` explains that
the worker is gone and no report was ever written (`x` then `X` deletes it).
The marker file is never rewritten — its sha256 is the ack/claim identity.

---

## Phase J — tmux perf fixes (docs/PERF-TMUX-SPEC.md, Fix 1 + Fix 2)

2026-08-10 tmux perf audit: pi-tui's fullRender replays the ENTIRE rendered
transcript through the terminal on boot/resize/differential-bailout
(measured: 67,555 lines / 10.9MB on a real 40MB session), and tmux drains
those bursts ~6.5x slower than a fast pty — hundreds of ms of frozen UI per
occurrence. pi-king spawning sessions at tmux's bare 80x24 default made it
worse: the first attach forced a resize (80x24 -> real client size), which
is itself a fullRender trigger, so the very moment you switch into a
session it replayed the whole thing. Automated logic coverage:
`tools/fleet.test.mjs` (resolveSpawnSize's 3-tier fallback, the persisted
client-size.json round-trip, createTmuxSession actually emitting -x/-y).

### J1. New sessions spawn near client size, not 80x24
Open the dashboard at a known terminal size (e.g. resize Ghostty, confirm
with `tmux display-message -p '#{client_width}x#{client_height}'` after
attaching once), then create a new session (`n`).
**PASS:** `tmux list-panes -t <name> -F '#{pane_width}x#{pane_height}'`
shows the real client size immediately, detached — not 80x24. Repeat via
`/bg`-style resume of an exited row (same createTmuxSession call, same
expectation).

### J2. Attach no longer forces a resize-triggered full render
With `PI_DEBUG_REDRAW=1` set on a session (see docs/PERF-TMUX-SPEC.md's
staged diagnostic), attach to it fresh right after J1's spawn.
**PASS:** `~/.pi/agent/pi-debug.log` shows no `terminal width/height
changed` fullRender line at attach — the window was already born at the
right size, so there is nothing to resize. Before this fix, every fresh
spawn logged exactly one such line at first attach.

### J3. Daemon restore uses the persisted size, not tmux's default
With the daemon installed and a dashboard having run at least once (so
`~/.pi/king/client-size.json` exists): `bin/pi-king --daemon-uninstall` +
`tmux kill-server` + `--daemon-install` (same drill as I4).
**PASS:** restored sessions come up at the persisted size
(`tmux list-panes -F '#{pane_width}x#{pane_height}'` matches
`cat ~/.pi/king/client-size.json`), not 80x24. Delete that file first to
confirm the tier-3 fallback: restored sessions then come up at 224x63
(`DEFAULT_SPAWN_SIZE`), still never 80x24.

### J4. patch-tui CLI: apply / check / revert / refuse-on-mismatch
```bash
bin/pi-king patch-tui --check    # unpatched: prints "unpatched", exit 1
bin/pi-king patch-tui            # applies; prints target + .orig backup path
bin/pi-king patch-tui --check    # now: prints "patched", exit 0
bin/pi-king patch-tui            # idempotent: "Already patched", exit 0
bin/pi-king patch-tui --revert   # restores from .orig
bin/pi-king patch-tui --check    # back to "unpatched", exit 1
```
**PASS:** all six behave as printed above; `diff` the file against a fresh
`npm install`/reinstall of the real package after `--revert` shows zero
difference (byte-exact restore). Corrupting the patch site (edit one
character inside the targeted block) makes `apply` refuse with exit 2 and a
clear message instead of guessing — this is the pi-upgrade-changed-the-code
case, and it must never silently misapply.

### J5. Unpatched pi-tui is visible, not silent
With pi-tui unpatched (`patch-tui --revert` first if needed): open the
dashboard.
**PASS:** a warning row reading "pi-tui unpatched — ... run: pi-king
patch-tui" renders persistently (not a lingering `showMessage` — it stays
until the dashboard is reopened after patching). Restart the daemon in the
same unpatched state: `~/.pi/king/hub.log` gets one
`pi-tui unpatched` line at startup. Patch, then repeat both — the warnings
are gone next open/restart. Detection is content-based
(`isPiTuiPatched()` in `src/fleet.ts`) — it must keep working even if
`~/.pi/king/tui-patch.json` (the CLI's own audit record) is deleted or
stale.

### J6. The env knob is tmux-only and no-ops when unpatched
`tmux show-environment -t <any pi-king-spawned session> PI_TUI_MAX_FULL_RENDER_LINES`
**PASS:** set (default 3000) on every tmux-spawned session. A session run
directly (not through pi-king, no tmux) never sees this var, and unpatched
pi-tui ignores it silently either way (it's an env var pi-tui's own code
doesn't read yet) — never a behavior change for anyone who hasn't run
`patch-tui`.

---

## Failure protocol

On any failure: **stop, change nothing, capture the scene.**

```bash
tmux list-sessions -F '#{session_name} token=[#{@pi_king_token}]'
ls -la ~/.pi/king/session-status/
for f in ~/.pi/king/session-status/*.json; do echo "--- $f"; cat "$f"; done
tmux list-panes -a -F '#{session_name}: pid=#{pane_pid} cmd=#{pane_current_command}'
```

Report the phase ID plus that output. Cleaning up first destroys the evidence —
two bugs in this project (the rename fork, the pid-recycling stale row) were
only found because the failing state was left intact.

---

## Teardown

```bash
tmux kill-server 2>/dev/null
rm -rf ~/.pi/king/session-status
```

---

## Coverage notes

**Not covered, and why:**
- Multi-window/multi-pane tmux sessions — pi-king assumes one window per
  session; panes are unhandled.
- Concurrent supervisors — two dashboards open at once is untested.
- Non-macOS — no Linux/Windows verification has been performed at all.
- Crash recovery mid-handoff — killing the parent between spawn and verify.
