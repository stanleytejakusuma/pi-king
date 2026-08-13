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
## BIGGEST WIN — 1Hz unconditional repaints (2026-08-13)

**Fleet idle CPU: 1.29 cores -> ~0.003 cores (>99% reduction).** Found by a
research pass after the render work, in STANLEY'S OWN extension, not upstream.

`~/.pi/agent/extensions/pi-alerts.ts` ran
`setInterval(() => ctx.ui.setStatus("pi-alerts", formatAlertStatus(...)), 1000)`
UNCONDITIONALLY for a session's whole life. `setStatus` -> `setExtensionStatus`
-> footerDataProvider invalidation schedules a render, and a pi render walks the
retained component tree (pi#6665: `Box.render()` renders every child BEFORE its
cache comparison). So every session repainted its entire tree once per second,
forever, with nothing on screen changing. Across 18 sessions that was 18
whole-tree repaints per second at idle.

Fix (6 lines): remember the last published string and skip `setStatus` when the
newly formatted text is identical. `formatAlertStatus` is pure, so its output is
a safe proxy for "would this repaint show anything different?". During an active
run the embedded timer string changes each second so behaviour is unchanged;
only the idle case goes quiet.

Verified after a full fleet restart: 4 samples over 40s all read 0.2-0.4% total
across 18 sessions; panes confirmed alive, rendering, status lines intact
(`pi alert: idle ... ponytail: FULL`), resize still repaints.

**Generalisable lesson:** any extension calling `setStatus`/`setWidget`/
`setFooter` on a timer costs a FULL TREE REPAINT per tick in this TUI. Publish
only on change. `pi-session-timer.ts` was initially suspected too but is
innocent — its 1Hz `render()` only writes a string to
`globalThis.__piSessionTimerLine` and never calls `requestRender()`.

**Also evaluated and NOT installed** (research pass): `fan56/pi-turbo` targets
startup + footer/context computation, not the streaming render path — low
benefit here. `hisence999/pi-tool-renderer` caches tool-output rendering
(moderate relevance) but declares three different scoped npm names, NONE of
which resolve on the public registry, and pins pi-tui ^0.82.1 (unverified on
0.84.1) — supply-chain smell, not installed. pi 0.84.1 ships NO config surface
for render cost (no settings key for animations/thinking/highlighting/
scrollback); the dist patches remain the only lever. Upstream PR #7921
("avoid full transcript work during active renders") proposed exactly the
stable/dynamic split our box.js finding implies and was auto-closed FOR PROCESS
(maintainer wants a reproduced report + agreed solution on the issue first) --
so filing our differential CPU profile on #6665/#7730 is the useful next move.

## STREAMING CPU — ROOT CAUSE IS UPSTREAM, PARTIAL FIX SHIPPED (2026-08-13)

**It is pi's own render pipeline, not tmux.** Differential `node --cpu-prof`
(load-only run vs load+stream run of the SAME 21,371-entry session, on a raw
pty with NO tmux) isolated streaming cost with no idle dilution:

- streaming added **20.0s of active CPU**; measured **62% CPU median, 112%
  peak** — over a full core, tmux absent.
- Where that 20s went: box.js cache-compare **16.6%**, GC **13.2%**,
  `truncateToWidth` **11.3%**, `parseKittyImageHeader` **8.1%**, `isImageLine`
  **7.8%**, `doRender` **6.6%**, tui `render` **6.1%** → **~65% render
  pipeline + 13% GC churn from it = ~78%**.

**Mechanism (read from the installed source):** `Box.render()` renders ALL
children FIRST, then calls `matchCache()`, which compares every child line
(`cache.childLines.every((line, i) => line === childLines[i])` — box.js:44, the
single hottest frame). The cache is checked AFTER the expensive work, so it only
saves the padding/background step; children re-render every frame regardless.

**This is a known, still-open upstream bug: earendil-works/pi#6665** — "TUI pins
a full core while streaming: uncached Intl.Segmenter + per-chunk Markdown
rebuild". Same hot path (render timer → Markdown.render → wrap →
Intl.Segmenter), reported at ~105% of a core. Causes named there: (1) grapheme
segmentation uncached in wrap/truncate, (2) `AssistantMessageComponent
.updateContent()` does `clear()` + `new Markdown(...)` per `message_update`, so
pi-tui's `cachedLines` never hits while streaming — cost grows with answer
length. **We are on 0.84.1 which IS latest**, so the CLOSED perf issues' fixes
are already in (#7385 tool-result-renderer cache bypass, #5014 per-keystroke
full re-render, #6478 per-frame cost vs transcript length, #7332 streaming
slowdown, #7541 input latency, #7769 idle redraws); #6665 + #7730 (High CPU on
macOS with long session) + #8029 (slow prompt editor) remain open.

**SHIPPED: `~/.pi/agent/extensions/static-working-indicator.ts`** — replaces the
default ~80ms animated "Working" spinner with one static frame, so no
timer-driven render fires merely to advance an animation (each such frame
traverses the retained TUI/history tree, so animating costs more the longer the
session). Verified by **A/B/A** on the real session:

| run | condition | CPU p50 |
|---|---|---|
| B | no extension | 62.0% |
| C | extension ACTIVE | **41.5%** |
| D | extension present, disabled via `PI_STATIC_WORKING_INDICATOR=0` | 62.4% |

**33% reduction, cleanly attributed** (the control reproduces baseline). Takes
effect on a session's NEXT START. Upstream's commenter reported a larger win
(89-101% → ~15%); ours is smaller because this fleet also runs status-line
extensions (voidfang-footer, pi-alerts, pi-session-timer) that schedule their
own renders, and because the per-chunk Markdown rebuild (#6665 cause 2) is
untouched — extensions cannot reach it.

**NOT fixed by this, needs an upstream core fix:** typing latency in long
sessions. Per #6665's closing comment, every editor update still schedules a
render that traverses the whole retained tree; the fix needs render coalescing
plus editor-only invalidation or history virtualization, which "extensions
cannot implement".

## SETTLED (2026-08-13): controlled A/B proves tmux is the amplifier

**THE ANSWER. Everything below this section is superseded where it conflicts.**

Controlled experiment, everything held constant except tmux: the SAME 53MB /
21,371-line Alexandria transcript copied twice with rewritten sessionIds, same
prompt ("List the numbers 1 through 300, one per line, nothing else. Do not use
any tools."), same continuous typing during the stream, same
`PI_TUI_MAX_FULL_RENDER_LINES=3000`, same 196x58 size, back-to-back on an
otherwise identical machine state. Measured by VFR screen recording
(inter-frame gap == real repaint event):

| metric | A: tmux | B: native | ratio |
|---|---|---|---|
| repaint fps | 17.1 | 28.8 | 1.7x |
| p50 gap | 25.0 ms | 25.0 ms | IDENTICAL |
| p90 gap | 116.7 ms | 75.0 ms | 1.6x |
| p99 gap | 425.0 ms | 100.0 ms | 4.3x |
| max gap | 550.0 ms | 475.0 ms | |
| stutters >100ms | 72/511 (14.1%) | 8/863 (0.9%) | **15x** |
| stalls >250ms | 13 (2.5%) | 2 (0.23%) | 11x |
| freezes >500ms | 3 | 0 | |

**The median is IDENTICAL; the entire difference is in the TAIL.** This is why
every earlier measurement came back "clean": they measured medians and
byte-echo. Humans perceive the tail, not the median — one frame in seven
hitching >100ms IS the sensation of "choppy", and tmux additionally produced
three outright >500ms freezes that native never produced.

**Consequence for the "unthrottled render" lead below: pi's render cost is the
LOAD, but tmux is the AMPLIFIER.** The identical render cost exists in both
conditions, yet native is 15x cleaner on stutters — so a render-throttle patch
to pi-tui would NOT have fixed this. The prediction stated below ("typing in a
large session natively WHILE it streams should also be choppy") was TESTED AND
FALSIFIED: native under full streaming load is smooth (0.9% stutters).

**Therefore removing tmux IS justified by evidence**, not by preference. See
the `pi --mode rpc` option recorded further below — verified working — as the
lightweight path (Stanley's stated constraint).

**Method note for reproducing:** copies MUST have their embedded sessionId
rewritten (it appears ~57x inside the transcript, including the
`{"type":"session","id":...}` header). A byte-identical copy makes two
processes claim one sessionId; when the impostor exits it DELETES the shared
status card in ~/.pi/king/session-status/, and the real session drops off the
dashboard into "tmux (no Pi session)" and appears unpinned (pin state in
~/.pi/king/layout.json is NOT lost — orphans just cannot sort into the pinned
group). Recovery: rebuild the card with visible:true and the real pid, and OMIT
startupFingerprint (fleet.ts:395-401 treats undefined as "assume fine").
This happened live on 2026-08-13 and is the same failure class already
documented at src/index.ts:2382 from 2026-08-07.

## SUPERSEDED LEAD (2026-08-13): unthrottled per-keystroke render in big sessions

**Kept for the measurements, but see SETTLED above — its central prediction was
falsified.** Evidence chain:

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

## SOLVED — ghost white-block artifact (root cause 2026-08-13 evening)

**ROOT CAUSE: `~/.pi/agent/settings.json` had `"showHardwareCursor": true`.**
pi's own default is FALSE (`pi-tui/dist/tui.js:111`,
`showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1"`; the settings key
overrides it via `settings-manager.js:873`). With it on, every render ends —
**outside** pi's synchronized-output block — with relative cursor moves plus
`\x1b[?25h` (`tui-main-screen.js:519-546 positionHardwareCursor`). Under tmux,
tmux owns the terminal cursor and re-emits its own show/hide: captured client
stream shows small incremental updates of the form
`\x1b[?25l …damaged cells… \x1b[?12l \x1b[?25h` with **no reposition before the
next frame is presented** (and unwrapped by sync — only 5 of 15 updates in a
14KB capture were inside `?2026h/l`). Ghostty then legitimately paints the
cursor for one frame at tmux's last write position. Fix applied: setting flipped
to `false`. Cost is zero — `/settings` → "Show hardware cursor" is literally
described as "Show the terminal cursor **while still positioning it for IME
support**", i.e. IME placement survives, and the composer's visible cursor is
drawn in software regardless (`pi-tui/dist/components/input.js:368`, inverse
video `\x1b[7m…\x1b[27m`, ungated).

**The earlier KEY INSIGHT below was wrong, and this is why:** it argued "a
terminal paints exactly ONE hardware cursor, the screenshot shows two blocks,
therefore it is not a cursor". The premise is right; the missing fact is that pi
draws its OWN composer cursor in software. Two blocks = one software cursor
(composer) + one hardware cursor (parked by tmux). Not two cursors.

**Evidence (recording `Screen Recording 2026-08-13 at 15.50.45.mov`, 632 frames,
19.6s, 3144x2116):** 23 frames carry a second cursor-shaped block
(`/tmp/pi-audit/ghost3.py`: scipy connected components, 35x17px = exactly one
cell). Frame-to-frame delta is decisive: 517→518 changes **594 px total, one
region**, `(1624,2071,35,17)` — the block appears and NOTHING else on screen
changes; 518→519 it vanishes and reappears at `(1794,2775)`, then `(1930,1576)`.
Content updates never accompany it, so it is not a stale cell: it is a cursor
being painted at hopping positions. Ghost positions land anywhere — mid
transcript, inside pi's own status footer (`HIT 0.0%█ ACTIVE`).

**Native Ghostty is clean for a real reason, not luck:** without tmux, pi's own
write positions the cursor immediately after each frame, so the stale-position
window never spans a presented frame.

**Byte-level A/B, reproducible (`docs/perf-tools/cursor-ab.sh`)** — measures what
pi WRITES, so it needs no screen recording, and runs on a private tmux socket so
the fleet is never touched. Same workload, same 8083 B of pane output both arms:

| `showHardwareCursor` | `\x1b[?25h` (show) | `\x1b[?25l` (hide) | ghost |
|---|---|---|---|
| `true`  | **15** | 0  | POSSIBLE |
| `false` | 0  | **15** | impossible |

A clean inversion: with the setting off pi never asks for a visible cursor, so
tmux has no cursor to park and the artifact cannot be painted at all.
Gotcha that cost two runs: do NOT attach a `script`-wrapped capture client to the
scratch session — `script` sends `^D` at stdin EOF, pi takes it as quit, and the
session dies ~3s in looking like "pi never came up". pi writes to its pty with no
client attached anyway, so `pipe-pane` alone is enough.

**Verification path (do this before claiming it fixed):** re-record ~20s of
typing in a large streaming session and re-run `ghost3.py` — expect 0 frames
with a second cursor-shaped block, versus 23 in the baseline. A live per-session
toggle is available without restart: `/settings` → "Show hardware cursor" → off.

**Also disproven along the way:** synchronized output was NOT the missing piece.
tmux 3.7b already emits `\x1b[?2026h/l` to Ghostty **without** the `sync`
terminal-feature, because xterm-ghostty terminfo declares `Sync` — measured A/B
on a private socket (`/tmp/pi-audit/sync-ab.sh`): 39 BSU/39 ESU with no feature
vs 38/38 with `xterm-ghostty:sync`. Do not re-add that config line for this.

---

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

---

## Fix 7 — `[box-child-memo]`: stop rebuilding unchanged messages every frame (2026-08-13)

**Status: IMPLEMENTED**, branch `perf/box-child-memo`. Fourth patch site in
`tools/patch-pi-tui.mjs`, target `components/box.js`. Complementary to
`--tui-mode fullscreen`, not competing with it: fullscreen changes the *write*
path, this changes the *build* path. `tui-alt-screen.js:157` still calls
`this.render(width)` for the whole document under fullscreen, so both land.

### Mechanism

The brief for this work suggested memoising each child's rendered lines in a
`WeakMap` and "freezing" a child after its output had been byte-identical for
N frames. **Reading the real code showed that design is both unnecessary and
strictly worse than what the code already makes possible**, so it was not
built. The reason:

`Text`, `Markdown` and `Image` — the only three components in pi-tui 0.84.1
that cache at all — already memoise internally and return **the same array
object** while their text and width are unchanged:

```js
// components/text.js
render(width) {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width)
        return this.cachedLines;   // ← same array object, every time
```

So the leaf re-render was never the expensive part, and a frame-counting
freeze heuristic would have been guessing at something the components already
report exactly. What actually costs is what `Box.render()` does *with* those
lines, at `components/box.js:53`:

```js
const leftPad = " ".repeat(this.paddingX);
const childLines = [];
for (const child of this.children) {
    const lines = child.render(contentWidth);
    for (const line of lines) childLines.push(leftPad + line);  // fresh string per line, per frame
}
...
if (this.matchCache(width, childLines, bgSample)) return this.cache.lines;  // then compares them all
```

Every frame, for every message that ever scrolled by, `Box` allocates a new
string for every line (`leftPad + line`), pushes it into a fresh array, and
then `matchCache` (`box.js:39`) walks the whole array with
`cache.childLines.every((line, i) => line === childLines[i])` only to conclude
nothing changed. **The cache is consulted after the expensive work has already
been done.** That is the 16.6% box.js cache-compare and a large share of the
13.2% GC in the differential profile.

The patch checks reference identity of the child line-arrays *before* doing any
per-line work. If every child handed back the same array object as last frame,
and width, `bgSample` and `paddingX` are unchanged, the flattened padded
document is provably identical and the cached frame is returned untouched.
Per-frame cost per Box goes from O(lines) to O(children).

Correctness argument: on a fast-path hit, upstream would have built
`childLines` from the same arrays with the same `leftPad`, so `matchCache`
would have returned true and upstream would have returned `this.cache.lines`
— exactly what the patch returns, without building or comparing anything.

### Topology note (this is why the win is large)

Verified against `dist/modes/interactive/interactive-mode.js:350-352`: the
transcript is a **`Container`** (`tui.js:57`) holding one entry per message,
and each entry (`user-message.js`, `tool-execution.js`, `custom-message.js`)
wraps its own small **`Box`**. So there are *thousands* of Boxes, each cheap
individually — the cost is the multiplication. In a transcript every message
except the last is immutable, so essentially every Box takes the fast path on
every frame while streaming.

### Measured effect

Wall-clock timing was deliberately **not** used: the `fullscreen-perf` arc was
measuring streaming CPU on this machine throughout, and a benchmark would have
poisoned its numbers. Instead the patch is measured by *work done* — the count
of line-operations (the `leftPad + line` concat loop plus the `matchCache`
line compare), which is deterministic and immune to CPU contention.

Simulated on the real topology — 2,000 messages × ~15 lines, 200 streamed
frames, last message growing by a token per frame, everything else immutable:

|                                   | slow-path entries | line-operations |            |
|-----------------------------------|------------------:|----------------:|------------|
| upstream                          |           400,000 |       6,754,828 | —          |
| `box-child-memo`                  |             8,196 |         139,436 | **48.4x**  |
| (same, revalidation removed)      |             2,199 |          38,180 | 176.9x     |

**97.94% of per-frame line work removed.** The third row is not shippable — it
is there to price the safety net: forcing a revalidation costs 48.4x instead of
176.9x, i.e. the guarantee below is bought for ~1.5 percentage points.

### The hazard, and how the test proves it is handled

Reference identity proves "unchanged" only while no component **mutates its
cached array in place**. A component that kept its array object and rewrote its
contents would keep passing the identity check while its content changed — and
unlike the other three patches, whose failure mode is slowness, this one's
failure mode is **wrong text on the user's screen**.

Grepped across the whole 0.84.1 dist: no shipped component does this (`text`,
`markdown` and `image` all build a fresh `result` array and reassign). But this
file is re-applied *blindly* after every pi upgrade, so the patch does not rely
on that holding forever. `cache.hits < 60` forces a full content re-verify at
least every 61st render, bounding staleness to 60 frames instead of infinity.

Tests in `tools/patch-pi-tui.test.mjs` (63 total, was 57):

- **Differential equivalence**: patched vs unpatched `Box` rendered
  side-by-side across **60,000 randomised frames** — random padding, widths,
  `bgFn`, add/remove/invalidate, caching and non-caching children — asserted
  byte-identical. **0 divergences.**
- **`box-child-memo ADVERSARIAL: in-place child mutation cannot pin stale text
  forever`** — a Box whose only child keeps its array and mutates it in place,
  with no sibling churn to break the reference match by accident. This is the
  case that fails without the invalidation logic: with `hits < 60` stripped out
  of the patch, the box **never** picks up the mutation (verified stale for 500
  frames, i.e. permanently) and the test fails with `STALE FOREVER`. With the
  counter, it recovers in 60 frames. Verified failing-then-passing, not assumed.
- Non-caching child (fresh array every render) must never be served from the
  reference cache; `addChild`/`removeChild`/width changes must be picked up
  immediately, not after the window.
- The `original` match target is the **entire** `render()` method, so any
  upstream edit anywhere inside it drops the patch to `unknown` and asks a
  human rather than half-rewriting a method whose bug shape is stale text.

### On the profile attribution in the brief

The attribution given (box.js cache-compare 16.6%, GC 13.2%, truncateToWidth
11.3%, doRender 6.6%, render 6.1%) is **consistent with what the code does**,
and the mechanism above explains it: `matchCache`'s full-document string
compare is the cache-compare entry, the per-line `leftPad + line` allocation
feeds GC, and `applyBg`→`visibleWidth` per line feeds the width functions. One
correction of emphasis, not of measurement: the brief framed the cost as
"recursive re-render of every child", but the recursion into `Text`/`Markdown`
is already memoised upstream and is nearly free. The cost is in `Box`'s own
per-line flatten-and-compare, which is why the fix is a reference check in
`Box` rather than a freeze applied to children.

### Known ceiling / not done

- `Container.render()` (`tui.js:57`) has the **same pathology and no cache at
  all** — it rebuilds a full-document array every frame from its children's
  lines. It is untouched here. It is the obvious next patch, and the reference
  trick applies to it unchanged now that `Box` returns a stable array on the
  fast path. Left out to keep this patch's review surface to one file.
- Real-world CPU effect on a live session is **not yet measured** (deliberately
  deferred so as not to contaminate the `fullscreen-perf` arc). The numbers
  above are operation counts on a simulated transcript, not a live profile.
