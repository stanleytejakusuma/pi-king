# Dispatch (task -> new session), Phase 1

Written 2026-08-13, after implementing it. Records what was **measured** versus
what was assumed, and where `/tmp/pi-king-PRD-native.md` turned out to be wrong.
The PRD was written before implementation; several of its load-bearing claims
did not survive contact.

## What shipped

Pressing `d` on the dashboard asks for **task -> name -> directory**, then
creates a normal tmux-hosted `pi` session, pastes the task into its composer,
submits it, confirms the turn actually started, and returns you to the
dashboard.

`n` is untouched: it still creates an empty session and drops you into it. `d`
is the other half of the same idea -- you supply the task instead of typing it
on arrival.

The name step is kept deliberately. `slugForTask()` prefills a heuristic slug
from the task text purely as a starting point to type over; it is string
manipulation with a stopword list and never a model call, because a dispatch
must not wait on (or fail because of) a round trip just to fill in a text field.

`spawnArc()` and `dispatchSession()` are now one function,
`spawnSessionWithPrompt()`. An arc **is** a dispatch that records a parent: the
only differences are that an arc seeds a session file carrying a
`parentSession` pointer and appends to `lineage.json`, and that its caller jumps
into the window afterwards. Everything else -- name sanitising, the duplicate
check, waiting for the composer, delivery, verification -- is shared, because
the delivery half is subtle enough that a second copy would drift out of sync.

## Verified empirically

Live runs used a **private tmux server** (`tmux -L kingdispatch`, reached
through a wrapper pinned by `PI_KING_TMUX`) and a scratch cwd, with
`PI_KING_STATUS_DIR` redirected into the scratch tree. The real fleet's 23
sessions and 37 status cards were never touched.

- **Dispatch works end to end against a real `pi`.** Session created, task
  delivered as ONE user turn, agent executed it, wrote the file it was asked
  for, and answered `DISPATCH-OK`. Returned `{state: "submitted"}` in 15s.
- **The session outlives its spawner.** The spawning node process exited;
  the session and its `pi` process (pid 42577) kept running. Under tmux this is
  tmux's job rather than something pi-king has to arrange -- which is exactly
  why the tmux substrate was kept.
- **A dispatched session is indistinguishable from any other session.** It
  writes a normal status card: `name: "zz-live-dispatch"`, `visible: true`,
  `status: "attention"`, `activity: "Done: Create a file called done.txt..."`.
  No new status plumbing was needed, and none was added.
- **`capture-pane -S -N` does NOT mean "the last N lines".** `-S` is a
  scrollback offset: `-S -4` on a 40-row pane returned **44 lines** -- the whole
  visible pane plus 4 lines of history. See the bug below, which this caused.
- **Delivery is confirmable from the status card.** The card's `activity` field
  is set from the prompt when the turn starts, so the card carrying the prompt
  IS proof the turn started.
- **`spawnArc`'s seed is invisible for any cwd containing a symlink**, and the
  failure is fatal and silent. See "pre-existing bug" below.

## The bug this found in my own first attempt

The first implementation verified submission by checking that the prompt had
left "the composer region", using `capture-pane -S -4` as a tail. It reported
`unsubmitted` for a dispatch that had **provably succeeded** -- the agent had
already run the task and written the file.

Two compounding errors:

1. `-S -4` returned the whole pane (see above), not the last 4 rows.
2. Even with correct slicing, screen position cannot answer this question. The
   prompt is visible *before* submission (in the composer) and *after* it (as
   the user's message in the transcript). Which rows it occupies depends on how
   much the agent has printed since, so any fixed window is a race.

Fixed by confirming from the session's own status card instead. The delivery
state is now `submitted | unconfirmed | not-pasted | failed`. Note
`unconfirmed`, not `unsubmitted`: from outside the session the negative is not
provable -- a session whose pi-king extension failed to load looks identical to
one that never submitted -- and claiming otherwise would be a lie in a message
whose entire job is to be trustworthy when nobody is watching the pane.

This matters more for dispatch than for arcs. An arc drops you into the window,
where you would see a stuck prompt immediately. A dispatch returns you to the
dashboard, where a prompt sitting unsent in a composer looks exactly like a
session that finished quickly.

## Pre-existing bug found (NOT fixed here)

`sessionDirFor()` in `src/arc.ts` does not resolve symlinks. For a cwd of
`/tmp/x/work` it computes `--tmp-x-work--`, while `pi` resolves the real path
first and uses `--private-tmp-x-work--` (macOS `/tmp` -> `/private/tmp`).
Measured side by side.

Consequence: `spawnArc()` seeds the session file where `pi` will never look,
`pi --session <id>` cannot find that id, **pi exits immediately, and the tmux
window disappears** -- so the arc vanishes seconds after being created, with a
success message already returned to the caller.

Production arcs use `~/codebase/...` paths, which contain no symlink, which is
why this has never been seen. Left alone deliberately: it is arc behaviour,
out of scope for an additive Phase 1, and `src/arc.ts` is being edited
concurrently on another branch. Dispatch is unaffected because it does not seed
-- `pi` picks its own session id and writes its own file.

## Where the PRD is wrong

- **§3 / §4: "state detection needs no new plumbing, it has never scraped tmux
  panes."** True as stated, but for the WRONG reason, and it is load-bearing in
  the PRD's original headless design where it is false. Card writing is gated on
  `ctx.mode === "tui"` (`src/index.ts:2232`). A `pi -p` session is mode
  `"print"` and writes **no card at all**, so a headless dispatched session
  would have been invisible on the dashboard. Measured before the pivot. Under
  the tmux design the claim holds trivially, because a dispatched session is a
  genuine interactive TUI session.
- **§2: "there is no fourth option."** There is, and it is what Claude Code
  actually does: a supervisor that HOLDS sessions with an attach/detach client
  on top -- i.e. a purpose-built multiplexer. They did not eliminate tmux; they
  wrote their own. The PRD's premise that "there is no live interactive process
  to reattach to" is a downgrade from what we are trying to match, not a
  simplification of it.
- **§5 Phase 1: `pi -p --session-id <uuid>` as the dispatch mechanism.**
  Abandoned. It works (a detached `pi -p` with `stdio[0]='ignore'` survives its
  spawner, reparents to PID 1, and completes its turn), but it buys a session
  you cannot attach to, that writes no status card, and whose liveness
  `livePiPids()` may not even recognise -- to replace a mechanism that already
  works.
- **§6 risk #4 (two writers on one transcript).** Real, but cheaper to satisfy
  than the PRD assumes. No lock is needed: dispatch only ever creates a NEW
  session, refuses a name that already exists (`has-session`, plus a dashboard
  row check so it fails in the composer where the user can retype), and
  therefore never sends keys into a session anybody could be attached to.
- **§6 risk #3 (`/goal` blocking under `pi -p`).** Untested and now moot; the
  single blocking `ui.confirm()` in `goal-mode.ts` is only reachable in a mode
  we no longer use.
- **`-ne` is a trap** worth recording for whoever tries a headless probe next:
  it disables the provider extension that registers the model catalogue, so pi
  dies in ~2s with `Codex error: The 'gpt-5.3-codex-spark' model is not
  supported when using Codex with a ChatGPT account.` A first survival test
  measured exactly this and nearly recorded it as "detached processes die".

## Delivery mechanics worth not re-deriving

`paste-buffer` needs **both** `-p` and `-r`. Without `-r`, tmux rewrites every
LF to CR and pi's composer reads CR as submit: a 43-line brief arrived as 43
separate submitted user turns (measured by the `fullscreen-perf` arc,
2026-08-13, session `019ffa8f-6dd9-7e61-ae8b-ce3babd99baa`). There is a
regression test pinning both flags. That fix and this extraction touch the same
line on two branches -- they are the same change, not a conflict to resolve by
picking one.

`Enter` must be a separate `send-keys`; `paste-buffer` alone leaves the text
sitting in the composer.

## Tests

`tools/arc-dispatch.test.mjs`, 13 tests, all against a fake tmux (bash, not
node -- a node fake put enough load on the box to make the timing-sensitive
`claimInjected` test in `jobs.test.mjs` flake when the suite runs its files in
parallel) and a scratch `HOME`. `npm run check`: 68 pass, 0 fail.
