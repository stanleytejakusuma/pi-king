# Spec: making pi-king sessions feel native (tmux perf fixes)

Status: DRAFT — nothing implemented. Audit evidence gathered 2026-08-10,
read-only, sandboxed tmux server only, live fleet untouched.

## Problem

Pi sessions viewed through pi-king (tmux + Ghostty) lag visibly — slow
`⠼ Working…` spinner, delayed keystroke echo — while the *same monolithic
session* run in native Ghostty is smooth. Reported on the pinned session
(Alexandria class: 40MB transcript).

## Root cause (measured, not inferred)

pi-tui's `fullRender` rewrites the **entire rendered transcript** through the
pty. tmux drains those bursts ~6.5× slower than a fast pty, and Node's tty
writes are blocking, so pi's event loop freezes for the whole drain — frozen
spinner, queued keystrokes.

| Measurement | Value | Method |
|---|---|---|
| Full render size, real 40MB session | **10.9MB / 67,555 lines** | real pi, `PI_DEBUG_REDRAW=1`, `pipe-pane` byte tap |
| 5.2MB burst drain, fast pty (≈Ghostty) | **27ms** | sandboxed writer, `hrtime` around blocking write |
| 5.2MB burst drain, tmux (detached / attached) | **~160ms / ~175ms** | same |
| Implied 10.9MB full render under tmux | **~350–550ms frozen event loop** | extrapolation + settle timing (~0.55s observed) |
| Spinner lateness during a burst | ~1ms steady → **135ms spike** | mixed-mode writer |
| Boot, 40MB session (native / tmux) | 3.1s / ~4.1s | pty harness vs sandbox tmux |
| Monolith pi process RSS | 460MB | ps |

`fullRender` triggers (from `tui-main-screen.js` source):

1. First render (boot) — the 10.9MB replay happens on every session start.
2. **Any width or height change** — confirmed: a 1-row resize replays 10.9MB.
3. Any content change **above the current viewport**.
4. Document shrink below max rendered length (`clearOnShrink`) — i.e. tool
   output collapsing after a call completes: fires constantly during agent
   streaming.
5. Kitty-image edge cases.

**pi-king amplifies trigger 2:** `createTmuxSession` passes no `-x/-y`, so
detached sessions sit at tmux default **80×24** (confirmed live: all unviewed
panes). First switch-in resizes 80×24 → 224×63 → full rewrap → whole
transcript replayed *exactly when the user lands in the session*.

Secondary findings: tmux never negotiates the `sync` feature with Ghostty
(client_termfeatures lacks `sync`), so multi-MB replays reach Ghostty as
unbatched partial redraws (tearing); pi-tui has no terminal focus-event
handling, so all 19 background panes render at full rate invisibly.

## Goals

- Switch-in to any session: no full-transcript replay, no visible stall.
- Streaming in a monolithic session under tmux: spinner cadence and keystroke
  echo comparable to native Ghostty (event-loop stalls bounded ≤ ~25ms).
- No behavior change for native (non-tmux) pi sessions.
- Live fleet safety: no restarts or config flips without explicit go-ahead.

## Non-goals

- Splitting monolithic sessions (explicitly ruled out by Stanley).
- Rewriting pi-tui's renderer (windowed/incremental rendering is upstream's
  job; we file the issue, we don't own it).
- Fixing pi's 3.1s native boot parse cost for 40MB transcripts (upstream).

---

## Fix 1 — spawn sessions at client size (pi-king, ships first)

**Change:** `createTmuxSession` (src/fleet.ts) gains explicit `-x <w> -y <h>`.

Size source, in order:

1. Dashboard spawn path (`n`, `/bg`, restart): the dashboard pi process's own
   `process.stdout.columns/rows` — its pane is already exactly client-sized
   (224×63 today). Width = columns, height = rows. No tmux query needed.
2. Daemon restore path (no client attached at login): last-known client size,
   persisted by the dashboard to `~/.pi/king/client-size.json` (written on
   dashboard start and on resize; tiny JSON `{w,h,at}`).
3. Fallback if neither exists: `224×63`.

`restoreMissingSessions` (fleet.ts) passes the same size. `restartTmuxPane`
(index.ts) needs no change (respawn keeps the existing window size) but gets
a pre-respawn `resize-window` to the same target so a session that died at
80×24 doesn't resurrect at 80×24.

**Edge cases:**

- Ghostty window resized since spawn (fullscreen ↔ windowed): one replay on
  attach, same as native resize. Accepted; unavoidable without upstream Fix 2.
- Multiple clients with different sizes: use the most recent size stamp.
- `window-size` tmux option stays default (`latest`); spec assumes no manual
  override exists (verify in implementation PR).

**Acceptance:**

- New session via dashboard `n` in sandbox: `list-panes` shows client size
  immediately, detached.
- Attach to a monolith copy with `PI_DEBUG_REDRAW=1`: **zero**
  `terminal width/height changed` fullRender entries at attach; pane byte tap
  shows no multi-MB burst.
- Daemon restore in sandbox with no client: sessions come up at persisted
  size.

**Rollback:** revert commit; sessions spawn at 80×24 again. No data risk.

---## Fix 2 — tail-cap vendored patch for pi-tui full renders (+ upstream issue)

**Change:** in `tui-main-screen.js` `fullRender`, when
`PI_TUI_MAX_FULL_RENDER_LINES` (int > 0) is set and
`newLines.length > cap`, start the write loop at
`newLines.length - cap` instead of 0. Clear variant keeps `2J/H/3J`
(clean, bounded scrollback). Unset/0 = today's behavior, byte-identical.

**DECIDED (2026-08-10): cap = 3000 lines** (~490KB ≈ ~16ms drain, ~48
screens of scrollback after a full render).

**Why it's safe (from source audit):**

- All internal bookkeeping (`previousLines`, `previousViewportTop`,
  `hardwareCursorRow`, cursor math) stays in document space — untouched.
- Cursor movement is viewport-clamped by design: any diff above the viewport
  already falls back to `fullRender`, so relative moves never reference
  unwritten rows.
- Final screen state (last `height` rows + cursor position) is identical with
  or without the cap. Only scrollback above the tail differs.
- Kitty-image cleanup deletes-by-id are no-ops for never-written placements.

**Knob wiring:** pi-king's `tmuxLaunchEnv()` adds
`-e PI_TUI_MAX_FULL_RENDER_LINES=<cap>` so **only tmux-spawned sessions** get
capped; native pi is untouched even after the dist is patched. Cap default
3000 lines (decided); configurable via `PI_KING_FULL_RENDER_CAP`.

**Tradeoff (explicit):** tmux copy-mode scrollback holds only the tail after
each full render. Today's behavior already wipes scrollback (`3J`) on every
full render and refills with ≤50k lines; the cap shrinks that refill to
3000. Deep copy-mode scrolling of ancient history is the one UX loss.

**Persistence across pi upgrades:** a pi upgrade replaces the dist and
silently unpatches. Plan:

**DECIDED (2026-08-10): manual apply, hardened.** Requirements for
"persistent and robust":

- `tools/patch-pi-tui.mjs`, exposed as `pi-king patch-tui`:
  - Locates the installed pi-tui dist by resolving through the real pi
    install (`which pi` → package root), not a hardcoded path — survives
    homebrew/npm layout changes.
  - Verifies an exact source signature of the patch site before editing;
    refuses with a clear message on mismatch (new pi-tui version needs
    human re-review of the patch site).
  - Idempotent: running against an already-patched file is a no-op success.
  - Backs up the pristine file next to it (`.orig`) and supports
    `pi-king patch-tui --revert`.
  - `--check` mode: exit 0 patched / 1 unpatched / 2 unknown-version, for
    scripting.
  - Records `{piVersion, piTuiVersion, patchedAt, signature}` to
    `~/.pi/king/tui-patch.json` for audit — but detection is always
    **content-based** (scan the installed file for the knob marker), never
    trust the record file alone.
- Detection in BOTH long-lived processes, so an upgrade can't slip by:
  - Hub daemon: content-check on every start; logs a warning line to
    hub.log when unpatched.
  - Dashboard: content-check on start; renders a persistent warning row
    ("pi-tui unpatched — monolith lag is back; run `pi-king patch-tui`")
    until resolved. Loud, not a footnote.
- Auto-patching on daemon start remains rejected: silent mutation of a
  global install is not worth the convenience, and after a real upgrade the
  signature usually mismatches anyway (human review required regardless).

**Upstream:** file issue on pi-tui with the measurement table + patch as PR
candidate. Framing: "full renders are O(document), not O(viewport); under
tmux this blocks the event loop for hundreds of ms on large sessions."

**Acceptance:**

- Sandbox monolith copy, resize test: burst drops 10.9MB → ≤ ~400KB; settle
  well under 50ms; `PI_DEBUG_REDRAW` still logs the fullRender (behavior
  unchanged, size capped).
- Mixed-mode writer under tmux with capped-size bursts: spinner lateness max
  < 20ms (was 135ms at 5.2MB).
- Native pi (no env): byte-identical output vs unpatched (diff a pane tap).
- Stanley's real-feel test on the pinned session after opt-in restart.

**Rollback:** unset the env in `tmuxLaunchEnv()` (instant, per-session on
next spawn) or restore the dist file (`npm ci`-equivalent reinstall of pi).

---

## Fix 3 — tmux `sync` feature for Ghostty (~/.tmux.conf, 1 line)

**Change:** `set -as terminal-features 'xterm-ghostty:sync'`

tmux then wraps client redraws in `?2026` synchronized-output — Ghostty
applies frames atomically instead of rendering partial states during big
replays. Removes tearing/flicker; does **not** shorten drains (that's Fix 2).

**Verify:** after config reload + client detach/reattach,
`tmux list-clients -F '#{client_termfeatures}'` includes `sync`.

**Rollback:** delete the line, reattach.

---

## Fix 4 — upstream asks (filed, not owned)

1. pi-tui: viewport-bounded/incremental full renders (the real fix for
   monoliths; our tail-cap is the stopgap).
2. pi-tui: honor terminal focus events (`CSI I/O`, tmux `focus-events on`) to
   pause spinner-driven renders while unfocused — with 19 panes, all but one
   render invisibly at full rate today.

## Considered and rejected

- `history-limit` 50000 → lower: marginal once Fix 2 bounds refills; loses
  copy-mode depth for nothing.
- Auto-enabling `PI_DEBUG_REDRAW=1` fleet-wide: useful diagnostic, but log
  grows unboundedly in `~/.pi/agent/pi-debug.log`; opt-in only, per session.
- Splitting sessions: ruled out by user.

## Rollout order

1. Fix 3 (config line) — instant, zero risk, Stanley applies + reattaches.
2. Fix 1 (pi-king spawn size) — normal branch/test/review; new spawns only;
   existing 80×24 windows keep old behavior until restarted.
3. Fix 2 (vendored patch + env knob + upstream issue) — after Fix 1 lands;
   Stanley validates real-feel on the pinned session; sessions pick up the
   env on next spawn/restart only.
4. Fix 4 (upstream issues) — parallel, no dependency.

Live-fleet effects are opt-in at every step: no session restarts happen
implicitly; capped rendering reaches a session only when it is respawned
with the new env.

## Implementation notes for the executor

Written for an implementer with no access to the audit conversation.

**Scope: Fixes 1 and 2 only.** Fix 3 (`~/.tmux.conf`) and Fix 4 / the
upstream issue are Stanley's to apply/file — do not edit his tmux config,
do not touch GitHub.

**Repo conventions (pi-king, `~/codebase/pi-king`):**

- Verification gate: `npm run check` (typecheck + `tools/check-exports.mjs`
  + `tools/jobs.test.mjs`, currently 29 tests) must stay green. Add tests
  for new pure logic (size resolution, patch signature check) there.
- Manual TUI phases live in `docs/TEST-SUITE.md` — add entries for the
  attach-without-replay check and the patch-warning row.
- `src/fleet.ts` must stay pi-API-free and `--experimental-strip-types`
  loadable (the daemon imports it; no TS parameter properties).
- Never `npm publish`. Commit to a branch; Stanley merges.
- The em-dash rule: never write literal `\u2014` escape sequences into
  source via heredocs; use real characters.

**Live-fleet safety (hard rules):**

- 19 live tmux sessions + a launchd daemon (`com.stanz.pi-king-hub`) are
  running. Test ONLY against a private socket (`tmux -L <name>`) with
  fabricated status dirs (`PI_KING_STATUS_DIR`, `PI_KING_TMUX` overrides
  exist for this). Never write markers into `~/.pi/jobs` during tests —
  the live daemon injects them into real sessions.
- Fix 1 touches `fleet.ts`, which the daemon imports → the live daemon
  needs a restart to pick it up (`bin/pi-king --daemon-uninstall` +
  `--daemon-install`). Do NOT restart it yourself — report the diff and
  the exact commands; Stanley (or the supervising session) fires them.
  Verify after any approved restart: `tmux list-sessions | wc -l`
  unchanged, `~/.pi/king/hub.log` clean start.
- The pinned session 'Alexandria (RAG Design)' parents live pi-jobs
  workers — nothing in this work may respawn its pane.

**Pinned facts the code should encode:**

- Patch target (pi 0.84.1):
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui-main-screen.js`
  — but resolve it dynamically (Fix 2 requirements), never hardcode.
  Upstream source anchor: `packages/tui/src/tui-main-screen.ts`,
  `fullRender` at ~line 210, `maxLinesRendered` tracking at ~240.
- Size semantics for Fix 1: the dashboard's `process.stdout.rows` IS the
  window height (status line already excluded) — persist and pass `{w,h}`
  exactly as read; no ±1 adjustments anywhere. `-x/-y` on `new-session`
  set detached window size; `window-size latest` then tracks the client
  on attach (no SIGWINCH when sizes already match — that's the whole
  point).
- `PI_DEBUG_REDRAW=1` writes to the shared `~/.pi/agent/pi-debug.log`;
  sandbox pi runs pollute it — note offsets before relying on it in
  acceptance tests.

## Decisions log

- 2026-08-10: cap = **3000** (Stanley).
- 2026-08-10: patch persistence = **manual, hardened** per Fix 2 (Stanley).
- 2026-08-10: upstream = **file the issue** (Stanley), via the Contribution
  Proposal template; PR only if a maintainer grants `lgtm`. Draft at
  `docs/UPSTREAM-ISSUE-DRAFT.md`; Stanley personalizes (own-voice rule) and
  submits manually — never via automation (their blocking policy).
- 2026-08-11: **Fix 3 applied to ~/.tmux.conf** (Stanley approved, agent
  applied): (1) `terminal-overrides` RGB pattern corrected from
  `xterm-256color` (never matched, dead config) to `tmux-256color` (what
  `default-terminal` actually is); (2) `update-environment` gained
  `COLORTERM TERM_PROGRAM GHOSTTY_RESOURCES_DIR` -- these were never
  forwarded into panes at all before (found live: absent from every real
  session's env), so nothing inside a session could detect it was really
  running under Ghostty's true-color/feature set; (3) the originally-
  proposed `terminal-features 'xterm-ghostty:sync'` line. All three
  verified end-to-end in a sandbox (private socket, real attach, real new
  pane) before touching the live server: COLORTERM=truecolor and
  GHOSTTY_RESOURCES_DIR correctly propagate to newly spawned panes after a
  real attach (TERM_PROGRAM does not -- tmux always stamps its own "tmux"
  value for spawned panes, a tmux behavior with no config workaround; note
  terminal-image.js's own Ghostty-detection already has a
  GHOSTTY_RESOURCES_DIR fallback for exactly this reason). Live reload via
  `tmux source-file`: 19 sessions before/after, zero broken cards.
  Honest caveat: measured round-trip keystroke-echo latency through tmux
  vs native is statistically identical (both <0.1ms p50, n=60) -- these are
  real capability-signaling correctness fixes (color fidelity, feature
  detection, atomic large-redraw passthrough), not a proven fix for
  subjective "choppy typing"; that raw-transport measurement found no gap
  to close there. Real-feel verification is Stanley's alone to judge.
- 2026-08-10: diagnostic = **yes** (Stanley). `PI_DEBUG_REDRAW=1` staged via
  `tmux set-environment` on 'Alexandria (RAG Design)' — inert until the
  session's next natural respawn (NOT forced: the pane's pi currently
  parents two live pi-jobs workers, alx-enrich-full7 + monitor, ~7h in; a
  respawn would kill them). Log baseline: ~/.pi/agent/pi-debug.log at 301
  bytes (3 sandbox entries from this audit — offset past them when
  analyzing). Passive pipe-pane byte-tap remains the zero-touch fallback
  whenever a monolith streams.
