# Making tmux invisible

Goal: match Claude Code's agent view — a supervisor that holds sessions and a
client that attaches/detaches, with `Ctrl+z to detach` — while keeping tmux as
the multiplexer. Nothing here is applied. Apply it yourself when the
`fullscreen-perf` arc reports.

All evidence below was gathered on a **private socket** (`tmux -L scratch`, plus
a second `tmux -L outer` server used purely as a keystroke robot so real key
tables are exercised instead of `send-keys`, which bypasses them). The live
server and `~/.tmux.conf` were never written to. tmux 3.7b, pi 0.84.1, Ghostty.

---

## The block to apply

Append to `~/.tmux.conf`:

```tmux
# ── invisible multiplexer (pi-king) ──────────────────────────────────────
# The bar duplicates what Pi's own footer already carries, and its hint text
# is what forces prefix-awareness. Also returns one row to the pane.
set -g status off

# #S has no other home once the bar is gone: Pi's footer shows cwd, not the
# session name, and Pi sets pane_title to "π - <cwd>". Push the session name
# into the host terminal's window/tab title instead — costs zero rows.
set -g set-titles on
set -g set-titles-string "#S"

# Ctrl+z returns to the dashboard, prefix-free, exactly like Claude Code.
# Not a new mechanism: it is the same detach that `C-\` and Pi's Left-arrow
# handler (src/index.ts:2481) already use, plus the switch-client half that
# goToSession (src/index.ts:2113) needs. -F means the condition is a format,
# evaluated in-process — no shell fork per keypress.
#   entered via switch-client (dashboard hosted in tmux) → go back to it
#   attached directly (bin/pi-king:173 wrapper)          → detach as before
bind-key -n C-z if-shell -F "#{client_last_session}" "switch-client -l" "detach-client"

# -n C-z takes ^Z away from every pane, including bare shells. Give job
# control back on the prefix. NOTE: this replaces tmux's default
# `prefix C-z` = suspend-client. Drop this line if you want that back.
bind-key C-z send-keys C-z
```

Keep `bind-key -n "C-\\" detach-client`. It is unchanged, works from a bare
shell, and is muscle memory. `C-z` is additive.

---

## Evidence

### 1. `Ctrl+z` collides with Pi — and the collision already strands sessions

Pi binds it: `dist/core/keybindings.js:11` maps `app.suspend` → `"ctrl+z"`;
`dist/modes/interactive/interactive-mode.js:2225` wires it to `handleCtrlZ()`,
which at `:3216-3217` does `process.kill(0, "SIGTSTP")` and at `:3207`
registers `process.once("SIGCONT", ...)` to restore the TUI.

That handler assumes a job-control shell will `fg` it. pi-king gives it none:
`createTmuxSession` spawns `new-session -d ... -- pi --session ...`
(src/index.ts:2775), so **Pi is the pane's own process with no shell
underneath**. Observed on the scratch socket, in both TUI modes:

| | before ^Z | after ^Z |
|---|---|---|
| `pi --tui-mode fullscreen` | `alternate_on=1` | `alternate_on=0`, frozen frame |
| `pi` (default, what pi-king spawns) | `alternate_on=0` | frozen frame |

In both cases the process stayed `Ss+` (never actually reached `T`), the TUI
stopped painting, and subsequent keystrokes echoed as **raw text below the
footer** (`AFTERCTRLZ` appeared as literal text). Enter did nothing. A resize
forced a partial repaint onto the *normal* screen. Only an external
`kill -CONT <pid>` from another terminal restored it (`alternate_on` → 1).

So today, one keystroke bricks a pane and there is no keyboard route back.
**The binding does not create this risk — it removes it**, because a root-table
binding consumes the key before the pane ever sees it. Verified end to end:
with the binding active, typing `typed-before-ctrlz` into a live Pi composer
then pressing `C-z` printed `[detached (from session pi2)]`, left Pi `Ss+`, and
on reattach the TUI painted normally with `typed-before-ctrlz` still in the
composer.

Side effect: Pi's own footer hint ("`ctrl+z` to suspend",
`interactive-mode.js:669`) becomes a lie inside tmux. Cosmetic, and arguably
a correction — that hint currently advertises the brick.

### 2. Both routes back to the dashboard work

`client_last_session` exists in 3.7b and is empty for a directly-attached
client, which is what makes the one-liner cover both hosting modes:

- **Direct attach** (`bin/pi-king:173` runs `tmux attach-session`, blocking):
  `last=""` → `detach-client` → `[detached (from session pidef)]` → control
  returns to the wrapper loop → dashboard. Identical to `C-\` today.
- **switch-client** (dashboard itself inside tmux, `goToSession`,
  src/index.ts:2113): client on `dash`, `switch-client -t pidef` sets
  `last=dash`; `C-z` moved the client back to `dash`. This is the case the
  existing `detach-client`-only routes get **wrong** — from a tmux-hosted
  dashboard, `C-\` and Left-arrow drop you out of tmux entirely instead of
  returning to the dashboard session.
- It toggles: a second `C-z` returns to the session (`last` flips each time).
  Matches Claude Code; also means `C-z` inside the dashboard bounces you back
  into the last agent.

### 3. Fullscreen makes tmux's scrollback irrelevant — confirmed, not assumed

| | `alternate_on` | `history_size` |
|---|---|---|
| `pi --tui-mode fullscreen` | 1 | **0** |
| `pi` (default) | 0 | grows |

In fullscreen tmux's scrollback is *empty*: forcing copy-mode (what `⌃B [`
does) showed `[0/3]` — only the pre-alt-screen startup lines, nothing of the
transcript. Mouse wheel-up (SGR button 64) in that pane left `pane_in_mode=0`:
tmux did not enter copy-mode, Pi got the wheel. So in fullscreen the prefix's
main daily use disappears, which is the whole argument for hiding the bar.

**In default mode this is not true** — scrollback is real and `⌃B [` still
matters. Hiding the hint there costs discoverability.

### 4. `status off` regression checks

- **Copy-mode still works, including scrolled-up mouse selection.** Wheel-up ×3
  → `pane_in_mode=1`, `scroll_position=10`; SGR press/drag/release across rows
  5–7 produced `buffer0: 8 bytes: "\n365\n366"` and cancelled cleanly. No
  snap-to-composer. (This is the failure mode the removed
  `terminal-features xterm-ghostty:sync` line coincided with; `status off`
  touches no mouse setting, and the check confirms it.)
- **The copy-mode position indicator survives** — `19:43 [10/369]` is drawn in
  the pane's top-right, not on the status line.
- **tmux messages survive**: `display-message` rendered on the bottom row with
  `status off`.
- **The command prompt survives**: `prefix :` drew `:` on the bottom row.
- **Pane gains a row**: `pane_height` 32 on a 32-row client (was client-1).

---

## What you lose by turning the bar off

1. **Session name `#S`** — the only item with no other home. Pi's footer shows
   cwd (`/private/tmp`) and model, never the name; `pane_title` is `π - tmp`.
   Mitigated by the `set-titles` lines, which move it to the Ghostty
   window/tab title (verified: the host terminal's title became `scroll`).
   Note `set-titles` is currently `off` on the live server too.
2. **The hint text** `Cmd+Esc/Left dashboard · ⌃B [ scroll` — deliberate, it is
   the chrome. But it was also the only place `C-z`'s replacement could be
   discovered. Put the hint on the dashboard instead. If the bar is ever turned
   back on, update `status-right` to say `⌃Z` — today it does not even mention
   `C-\`, which has been the real binding for a while.
3. **The window list** `#I:#W`. pi-king sessions are single-window, so this is
   theoretical — but a session that ever grows a second window becomes invisible.
4. **The clock**, and `pane_current_path`. Pi's footer carries cwd.
5. **`prefix C-z` = suspend-client**, only if you take the optional passthrough
   line.
6. **Shell `^Z` job control in every pane** — a root binding is unconditional.
   The passthrough line makes it `C-b C-z` (verified: `zsh: suspended sleep 300`).

## Accepted, not solved

Pi hard-disables inline images whenever `$TMUX` is set
(`pi-tui/dist/terminal-image.js:43-45`, "Image protocols are unreliable under
tmux"), with no override in 0.84.1. Hiding chrome does not recover it. Not
attempted.

## Not verified without the live server

- Whether Ghostty renders `set-titles` output the way you want across tabs —
  confirmed only that the OSC propagates and the host terminal's title changes.
- Behaviour across all 18 real sessions, and the perf effect of one fewer
  drawn row per client. `if-shell -F` forks nothing, so the binding itself
  should not register in the `fullscreen-perf` numbers.
- `Cmd+Esc` is a Ghostty-level binding and was out of reach here; the block
  does not touch it.

## Reproducing

```sh
tmux -L scratch new-session -d -s pifs -x 120 -y 30 \
  -e PI_CODING_AGENT_DIR=/tmp/piscratch-agent -c /tmp -- pi --tui-mode fullscreen
tmux -L outer  new-session -d -s host -x 120 -y 32
tmux -L outer  send-keys -t host 'TMUX= TERM=xterm-256color tmux -L scratch attach -t pifs' Enter
tmux -L outer  send-keys -t host C-z          # a REAL keystroke into the inner client
tmux -L scratch display -p -t pifs '#{alternate_on} #{history_size}'
```

`tmux -L outer send-keys ... -H <hex>` injects SGR mouse events (press
`\033[<0;5;5M`, drag `\033[<32;20;7M`, release `\033[<0;20;7m`).
Tear down with `tmux -L scratch kill-server; tmux -L outer kill-server`.
