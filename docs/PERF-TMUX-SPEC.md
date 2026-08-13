# Spec: making pi-king sessions feel native (tmux perf fixes)

Status: Fixes 1, 2 and 5 IMPLEMENTED (2026-08-10/11). Fix 3 is Stanley's
config line; Fix 4 is upstream. Audit evidence originally gathered
2026-08-10, read-only, sandboxed tmux server only, live fleet untouched.

**Read Fix 5 first if you are here about typing lag.** The original audit
below blamed the full-render WRITE path, and that is real but is NOT what
caused the reported lag on the pinned session — a 2026-08-11 profile found
the cost is in BUILDING each frame, not writing it. Fix 2 does not address
it; Fix 5 does, and is a 328x measured win.

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

## Fix 5 — pi-tui width-cache thrash (the BUILD cost) — IMPLEMENTED 2026-08-11

**This is the fix for the reported typing lag.** Fixes 1-2 target the cost of
*writing* a frame; this targets the cost of *building* one, which turned out
to dominate by orders of magnitude on a large session.

**How the original diagnosis was falsified.** The pinned session
'Alexandria (RAG Design)' (45MB transcript, 12,269 rendered lines) showed
visible keystroke lag. A 15s screen recording gave a **166.7ms freeze**
against an 8.3ms base frame cadence (two consecutive extracted frames were
byte-identical while the user typed continuously). But `PI_DEBUG_REDRAW=1`
was live on that session, and **every one of pi-tui's 8 fullRender call
sites is preceded by a logRedraw** (verified by reading the source) — the
log recorded **zero fullRender events during the entire recording**. The
write path was not involved.

**What a `sample`(1) profile of the live process actually showed** (4s,
215 main-thread samples):

| Cost centre | Share |
|---|---|
| `uv__run_timers` (the render tick) | 69% |
| ICU (`icu_78::*`, mostly `RuleBasedBreakIterator::clone()`) | **33%** |
| GC | 26% |
| pty writes | **0%** |

**Root cause.** `utils.js`'s `visibleWidth()` memoises grapheme-aware widths
in a Map bounded by `WIDTH_CACHE_SIZE = 512` with FIFO eviction. It fast-
paths pure-ASCII strings, but **100% of real rendered lines carry ANSI
colour escapes** (measured directly off the live pane: 38/38 visible lines),
so nothing takes that fast path and the working set is the entire document.
512 entries against 12,269 lines is 24x over capacity, and under the
renderer's sequential full-document scan a FIFO that small collapses to a
~0% hit rate: every entry is evicted just before it is needed again. Every
line then re-runs `Intl.Segmenter`, cloning an ICU BreakIterator per call.

The differential renderer is what drives this: it receives `newLines` — the
whole document, already rendered — and diffs it against `previousLines`. So
even when the write is tiny, the **build is O(document) on every tick**.

**This is a cliff, not a slope.** Under capacity is ~100% hits; one entry
over is ~0%. That is why one session lags badly while a smaller one is
perfectly smooth, with no gradual degradation in between to warn you.

**Change:** `WIDTH_CACHE_SIZE` 512 -> 65536, in `utils.js`, applied by
`tools/patch-pi-tui.mjs` as its second patch site (same content-verified,
idempotent, revertible machinery as Fix 2; both sites apply and revert as
one unit, and a partial state reports unpatched rather than healthy).

Unconditional, unlike Fix 2's env gate: this is pure memoisation of a pure
function, so there is no behaviour to opt into — only how often a width is
recomputed. An env knob would just add a way to leave the bug switched on.

**Measured on the real installed dist, 12,269 real ANSI-styled lines:**

| | per full-document pass |
|---|---|
| 512 (shipped, from the `.orig` backup) | **983.7 ms** |
| 65536 (patched) | **3.0 ms** |

328x. That single number explains all three observed symptoms: the 166.7ms
freeze, the sustained ~82% CPU on an idle-looking TUI, and why it presents
as the UI locking rather than slowing.

**Correctness:** 12,269 lines x {`visibleWidth`, `truncateToWidth`},
**0 mismatches** against the unpatched module. A larger memo cache cannot
change a result, only how often one is recomputed. Cost: ~0.6MB heap
(against 941MB process RSS).

**KNOWN CEILING — do not call this solved.** 65536 is flat, giving ~8x
headroom over today's 12,269-line working set; the same cliff returns near
~65k distinct rendered lines. LRU would NOT help: a sequential full-document
scan is LRU's pathological case too, so only capacity > working set matters.
Adaptive sizing was rejected as over-engineering for a one-number patch to
someone else's dist. The real fix is upstream (Fix 4.1): layout must not be
recomputed for every line of an unchanged document on every tick. This buys
headroom; it does not fix the architecture. The boring mitigation for the
ceiling is the same one that always applied: restart long-lived sessions.

**Acceptance:** re-run `sample`(1) on the pinned session after it restarts;
the ICU share should collapse from 33% toward ~0. Evidence before "fixed" —
the patch is verified at rest, not yet observed on a live restarted session.

**Rollback:** `pi-king patch-tui --revert` (restores both sites byte-exact
from their `.orig` backups).

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
## STRONGEST LEAD (2026-08-13): unthrottled per-keystroke render in big sessions

**This supersedes the tmux-transport framing.** Evidence chain:

1. **Live capture while the pane "looked frozen"** (Alexandria, agent running):
   `tmux capture-pane` twice 4s apart showed tmux's screen model WAS updating
   (spinner advancing, timer 112.7s→116.8s, tokens 166.5k→196.0k). So the pane
   is NOT frozen at the tmux layer — tmux has correct fresh content while the
   user sees stale pixels. Byte volume was trivial: **13.5 KB/s** (vs 10 B/s
   for a small idle session), 22 sync-output frames in 5s, p50 frame 338 B.
   13 KB/s cannot congest tmux (it handles MB/s). Transport is NOT the problem.
2. **CPU correlates with ACTIVITY, not with tmux**: Alexandria 77%, Charon
   41.8% (both actively streaming with running sub-agents); every idle session
   1-6%. pi burns most of a core while streaming.
3. **PROVEN by controlled experiment** (`/tmp/pi-audit/eventloop-starve.mjs` +
   `starve-test.py`, native pty, raw mode): a 60 ms synchronous work burst
   every 100 ms raises keystroke→echo latency from p50 0.15 ms / p90 0.50 ms
   to **p50 13.50 ms / p90 54.63 ms / max 55.54 ms** — i.e. echo is delayed by
   almost exactly the blocking-work duration. Node is single-threaded, so
   synchronous render work starves input handling. This needs NO tmux.
4. **Code confirms the amplifier** (`pi-tui/dist/tui.js`): normal renders are
   throttled to 60fps (`static MIN_RENDER_INTERVAL_MS = 16`, line 110), BUT
   keyboard input calls `requestImmediateRender()` (line ~620) which cancels
   the render timer and renders synchronously on `process.nextTick`,
   deliberately bypassing the throttle — comment: *"Keyboard input is
   latency-sensitive. Avoid the throttled timer path."*
   So while typing during a streaming turn: streaming renders fire at up to
   60fps AND every keystroke forces an ADDITIONAL unthrottled full render.
   The responsiveness optimization removes the only rate limit on the most
   expensive operation, exactly when the event loop is already saturated.
   Cost per render scales with document size (Container.render, tui.js:58,
   walks every child).

**Why the native A/B was CONFOUNDED (important):** Stanley reported native
Ghostty on the same huge Alexandria session felt perfectly smooth — but he
explicitly never typed into it ("I haven't attempted conversing with the long
ass Alexandria session on the native Ghostty", to avoid concurrent writes to
the session JSONL). He only SCROLLED an IDLE session. So the comparison was
tmux+big+STREAMING+typing vs native+big+IDLE+scrolling. Streaming/CPU load was
never controlled for. **Prediction to test: typing in a large session natively
WHILE it streams should also be choppy.** If true, removing tmux does NOT fix
this, matching the workflow synthesis's warning.

**Proposed fix (NOT yet implemented, needs the prediction tested first):**
make the immediate-render bypass adaptive — keep it for small/cheap documents,
but fall back to the 16 ms throttle (or coalesce) when the previous render
exceeded some budget (e.g. >8 ms). Bounded, reversible, same shape as the
existing `PI_TUI_MAX_FULL_RENDER_LINES` cap, so it can ship through
`pi-king patch-tui`. Note pi-tui exposes NO render-throttle env knob today
(only PI_CLEAR_ON_SHRINK, PI_DEBUG_REDRAW, PI_HARDWARE_CURSOR, PI_TUI_DEBUG,
PI_TUI_WRITE_LOG, PI_TUI_MAX_FULL_RENDER_LINES — the last one added by us).

**MEASUREMENT LESSON — earlier latency numbers were invalid.** The first
"tmux and native are identical, sub-millisecond" results measured the KERNEL
PTY ECHO, not the application's render: the test pty was left in canonical
mode with ECHO on, so the terminal driver echoed the byte before the app ever
saw it. Any future keystroke-latency test MUST put the pty in raw mode
(clear ECHO|ICANON, set VMIN=0/VTIME=0) — see `raw()` in
`docs/perf-tools/starve-test.py`. Under tmux the same test still misreads
(it returns pre-buffered tmux output; tmux+busy measured "faster" than
tmux+idle, which is impossible) — tmux-side echo timing remains UNSOLVED and
those numbers must not be trusted.

## OPEN — ghost white-block artifact (2026-08-13, unresolved)

**Symptom (Stanley, reproducible in daily use, screenshot captured):** while
typing in a tmux-hosted session — especially a large/active one (Alexandria)
and notably while the agent is STREAMING (`Working...`) — a stray white block
appears transiently at a wrong position, "mostly bottom side of screen". Also
reports cursor style flipping between a bar and a normal block. NEVER happens
in native Ghostty (no tmux), where the same huge session scrolls and types
perfectly smoothly (confirmed by scrolling a long Alexandria history natively).

**KEY INSIGHT (2026-08-13): it is NOT a second cursor.** A terminal paints
exactly ONE hardware cursor. The screenshot shows the real cursor after the
typed text AND a second white block on the composer's top border
simultaneously. Therefore the ghost must be a CELL rendered with inverse/white
background — i.e. a STALE, UNCLEARED CELL left behind by a differential
update (or a tmux damage-tracking miss), not a cursor-positioning error.
Future investigation should target line-clearing / damage tracking in the
differential render path, NOT cursor math.

**Hypotheses TESTED AND DISPROVEN (do not re-run these):**
1. *Raw transport latency through tmux.* Measured keystroke round-trip echo,
   native pty vs tmux-attached client, n=60 each: statistically identical,
   both sub-millisecond (native p50=0.019ms, tmux p50=0.020ms).
2. *tmux status-line redraw perturbing the cursor.* Disabled `status` on a
   live laggy session (Kairos); Stanley confirmed blipping persisted. Also
   `monitor-activity` is off, `focus-events` off — neither is a trigger.
3. *pi-tui `Container.render()` O(document-size) cost.* Benchmarked the REAL
   installed class (`pi-tui/dist/tui.js:58`) at Alexandria's true scale
   (20,809 transcript entries) vs a small session (134): p50=0.149ms vs
   0.010ms. 15.4x ratio but absolute cost is far below perceptible. A
   workflow agent claimed this was the root cause; direct measurement does
   NOT support that claim.
4. *Relative cursor positioning desyncing under tmux when content scrolls.*
   Built a step-gated harness (`/tmp/pi-audit/cursor-desync-sim.mjs` +
   `run-desync-test.sh`) mirroring `positionHardwareCursor()`
   (tui-main-screen.js:504-535) exactly — relative `ESC[{n}A`/`ESC[{n}B`
   moves computed from self-tracked `hardwareCursorRow` — inside a real
   tmux pane sized to force scrolling, comparing pi-tui's assumed column
   against tmux's own `#{cursor_x}`/`#{cursor_y}`. **Result: 0/25 steps
   diverged.** Rows pinned correctly at 10 once scrolling started. Relative
   positioning does NOT desync under tmux.
5. *tmux history-buffer size.* Filled a pane to ~48K lines (near the 50K
   `history-limit`) then measured keystroke latency: p50=0.146ms. Not a factor.
6. *tmux server load across the 19-session fleet.* One 139ms spike observed
   once, but 3 follow-up runs (50 samples each) showed max 34/11/20ms and
   zero spikes >50ms. Not reliably reproducible; retracted as an explanation.

**Measurement instrument that DOES work (use this next time):** macOS
`screencapture -v -V <secs> out.mov` records the screen from the CLI (no user
paste needed, permission already granted) and — critically — records
VARIABLE frame rate: a frame is emitted only when the screen actually
changes. Therefore inter-frame gaps ARE screen-repaint events, directly
measuring perceived smoothness with no threshold guessing. Extract with
`ffprobe -select_streams v:0 -show_entries frame=pts_time -of csv=p=0`.
Scene-score thresholding was a dead end — a single character glyph is ~1e-5
of a 3600x2338 screen, far below any usable scene threshold.
Measured: laggy tmux typing p50=25ms/p90=108ms/max=392ms repaint gaps vs a
cleaner recording at p50=16.7ms/p90=66.7ms/max=167ms. Helper scripts:
`/tmp/pi-audit/analyze-smoothness.sh`, `ghost2.py` (transient-vs-static
bright-block classifier — correctly traced the real cursor advancing
left-to-right while typing; found no ghost in that particular recording).

**NEXT STEP when resumed:** capture a screen recording at the exact moment
the artifact appears (it is transient, so record continuously while typing in
a large streaming session and search frames afterward with `ghost2.py`), then
inspect the raw tmux byte stream for that pane at the same timestamp
(`tmux pipe-pane -o 'cat >> /tmp/x.raw'`) to see whether the stale cell is
(a) written by pi-tui and never cleared, or (b) an artifact tmux introduces
when relaying. That distinction determines whether the fix belongs in
`pi-king patch-tui` or in tmux config.

**Also still open:** dashboard status for "Solagin Live" showed `exited`
while its tmux pane was actually alive and healthy — pi-king status-tracking
bug, unrelated to rendering, not yet investigated.

**Architectural option researched (2026-08-12), not started:** `pi --mode rpc`
EXISTS and works — verified directly: `echo '{"type":"get_state"}' | node
.../dist/cli.js --mode rpc --no-session` returns clean structured JSON
(model, sessionId, messageCount, etc). A dashboard could spawn `pi --mode rpc`
per session and render its own UI from the event stream, removing tmux AND
pty/terminal emulation entirely. This is the lightest-weight path to "no
tmux" (Stanley's stated preference: lightweight if possible) because
fan-out becomes broadcasting small JSON messages rather than relaying raw
pty bytes with cursor-state tracking. Cost: pi-king would need its own
renderer. Reports also covered dtach/abduco as a middle path (real
detach/reattach, but NO server-side scrollback — a regression vs tmux's
`history-limit 50000`, which would have to be built).

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
