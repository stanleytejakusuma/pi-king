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
`Cmd+Esc` (or `F12`, or `Ctrl+B d`).
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
