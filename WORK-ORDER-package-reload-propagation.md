# Work Order: Package/Skill Reload Propagation Across pi-king Sessions

**Status:** Built and shipped — 2026-08-05
**Filed:** 2026-08-04
**Filed by:** Pi (handoff from session `019fcc02-4ce1-7512-b87e-9d51d028fdb1`)
**Reviewed:** two red-thinker rounds (design + design-fork follow-up), see "What actually shipped" below
**Scope:** pi-king (~/codebase/pi-king, v0.2.0)

## Problem

`pi install <package>` writes to the **global** `~/.pi/agent/settings.json`, but each
running `pi` process only reads that file (and discovers the resulting
skills/extensions/prompts) at **process start** or on an explicit `/reload`. There is
no live-reload-on-write. Any package installed while pi-king sessions are already
running leaves every one of those sessions silently stale — same binary, same
doctrine, but missing whatever skill/extension/prompt the install added — until each
is individually `/reload`ed or restarted.

This is not an Engram-specific issue. Engram surfaced it today only because it was
the package being installed. **Every future `pi install` will reproduce this exact
gap** against every session that predates the install.

## Evidence (2026-08-04, this session)

- Engram installed 2026-08-04T10:32:50+07:00, registered globally, selftest 302/302.
- 15 tmux sessions live under pi-king at install time.
- Checked each session's actual `pi` process start time (`ps -o lstart=` on the
  child PID under the pane, not tmux's `session_created`, which can lag the real
  process): **12 of 15 predated the install and were stale**; only 3 (Alexandria,
  Job Hunting, pk-rename-probe) had been (re)spawned after 10:32:50 and picked
  up Engram automatically.
- Doctrine changes (edits to `~/.pi/agent/AGENTS.md`) do **not** have this problem —
  doctrine is read fresh each turn, not cached at process start. Only
  package-sourced skills/extensions/prompts are affected.

## Root cause

Package discovery is a **process-start-time** operation in Pi's current design.
pi-king has no visibility into "this session's loaded-package-set is older than the
global settings.json," and no safe way to force a refresh from outside the pane.

`send-keys` exists (`pi-king/src/index.ts`) but pi-king's own code comments are
explicit that it **must never fire mid-turn** — it is only used today for `/name`
renames, gated on the session being "settled at its prompt." A blind broadcast of
`/reload` across all panes on every install would violate that same-turn safety
invariant and risks corrupting live input in a busy session.

## Non-goals

- Live hot-reload of packages without any `/reload` at all (upstream Pi behavior,
  out of scope for pi-king).
- Auto-firing `/reload` into a session that is mid-turn, under any circumstances.
- A mechanism that requires Stanley to remember to do anything manually per-install
  (defeats the purpose — that's the exact failure mode this Work Order exists to
  close).

## Proposed fix, ranked cheapest-first

**Option A — Staleness badge only (recommended starting point).**
pi-king already tracks package registration state is readable from
`~/.pi/agent/settings.json` (`packages` array — currently 7 entries) and each
session's process start time is already computable the way this session computed
it manually. Add: on dashboard render, compare each session's process-start
timestamp against the newest `mtime` of `~/.pi/agent/settings.json`. If the
session predates the file, show a small "packages updated — reload to apply"
indicator on that session's card. Zero automation risk: Stanley reloads when he's
next in the pane anyway, now with visibility instead of guessing. This is the
~15-line version and should ship first.

**Option B — One-click "reload this session" from the dashboard.**
Given Option A's badge, add a dashboard action that does the same
settled-at-prompt check pi-king already performs before `/name` send-keys, then
sends `/reload` + Enter only if that check passes. Falls back to "session busy,
try again" if not settled. This turns the manual `/reload` into a single click
without ever touching a busy pane.

**Option C — Opportunistic bulk reload.**
A "reload all stale + idle sessions" bulk action: iterate all sessions, apply
Option B's per-session settled-check to each, reload the ones that pass, skip and
re-flag the ones that don't (they'll pick it up next natural idle poll). This is
the closest thing to "all sessions reloaded" without violating the never-mid-turn
invariant — it converges over time rather than forcing it instantly.

**Explicitly rejected:** any broadcast that skips the settled-at-prompt check.
pi-king's own code already learned this lesson once (see the `/name` send-keys
guard comments in `src/index.ts`); reintroducing an unguarded broadcast for
package reloads would be the same mistake in a new location.

## Recommended sequencing

Ship A now (pure visibility, no behavior change, near-zero risk). Ship B once A's
badge has been live long enough to confirm the staleness detection itself is
accurate across a few real installs. Defer C until B is trusted — bulk actions
built on an unproven single-session primitive are how the "never mid-turn" rule
gets violated by accident.

## Open decisions for Stanley — resolved

1. **Main dashboard card**, same row as the existing subagent-count/ctx%/
   elapsed-time badge cluster. No detail view exists anywhere in this
   dashboard today; building one for a single badge would be inventing
   structure nothing else uses.
2. **No confirmation** — fires immediately once the settled-check passes,
   same trust model as `/name`. A confirmation dialog adds friction with no
   safety benefit the settled-check does not already provide.
3. **Build now, as a real bulk action, not just a badge.** Stanley's own
   framing settled this: "the problem with only relying on /reload is that
   the UX sucks" — a per-session badge plus a lone Option B click-through
   still means babysitting N sessions by hand. Shipped as one keypress (`r`)
   that fires into everything settled right now and queues everything else,
   converging automatically as sessions finish their turns — press once,
   walk away.

## What actually shipped (differs from the original proposal in two ways)

1. **Staleness signal is a content hash of settings.json's `packages` field,
   not a process-start timestamp.** The original proposal (compare session
   start time vs. settings.json mtime) fails its own AC#2 and AC#4 below as
   originally written: `startedAt` is deliberately frozen across `/reload`
   (a real, separate bug fix already in this codebase, for orphan-detection
   false positives — reloading a session was never meant to change when the
   OS process was born), so a timestamp-based badge could never clear after
   a successful reload, and cross-checking against `ps -o lstart=` would be
   validating against exactly the signal that cannot move. Separately, mtime
   alone is a bad proxy regardless of the reload issue: any write to
   settings.json (a model switch, a theme change, a Syncthing touch with no
   content change) would false-flag every running session. A hash of just
   the `packages` field, stamped by each session at `session_start` (which
   fires at process launch AND on every `/reload` — exactly the two moments
   this process's own loaded package set can change) and compared against
   the dashboard's own fresh read of the same field, has neither problem.
2. **Option C shipped as a converging queue, not a one-shot sweep.** Pressing
   `r` fires `/reload` immediately into every stale session that is settled
   right now, and queues the rest (`pendingReloads`, mirroring the existing
   `pendingRenames` pattern used for dashboard-driven `/name`) — a shared
   `flushPendingReloads()` on every refresh cycle re-checks staleness (not
   just settledness) before firing, so a session reloaded some other way in
   the meantime is a no-op instead of a redundant reload, and a session that
   exits while queued is pruned rather than leaking forever. The identical
   leak (queued rename, session exits before settling, entry never removed)
   was found and fixed in the pre-existing rename queue in the same pass.

## Acceptance criteria

- [x] Installing any package while N sessions are running results in a
      visible staleness indicator on all N stale session cards within one
      dashboard refresh cycle. Verified live (sandboxed session + sandboxed
      dashboard, cleaned up after): a real hash mismatch produces the ⟳
      stale badge on the very next refresh.
- [x] The indicator clears correctly once a session is reloaded or
      restarted. Verified live: badge clears the moment the target
      session's own `session_start` re-stamps a matching hash after
      `/reload` completes.
- [x] No `/reload` or `send-keys` ever fires into a session mid-turn.
      Verified live: corrupting a busy session's hash and pressing `r`
      queues it (⟳ queued badge, no text sent to the pane) rather than
      firing; the queued reload only fires once flushPendingReloads next
      observes that session as idle or background.
- [x] Bulk action converges without further manual action. Verified live:
      a queued reload on a busy session fired automatically, with zero
      further keypresses, the moment that session's own turn completed —
      confirmed via the /reload confirmation text appearing in that
      session's pane and its packagesHash matching the real current value
      afterward.
- [x] A session that exits while a reload is queued does not leak the
      pending entry or error the dashboard. Verified live: killed a probed
      session mid-turn with a reload queued; next dashboard action
      completed cleanly with no stale/queued badge left on the now-exited
      card.
- [x] False-positive rate on staleness detection is zero for a session that
      has not actually gone stale. Verified live: a freshly started session
      (matching the real, unmodified settings.json at the time) showed no
      badge; only an artificially introduced hash mismatch produced one.
      (The original `ps -o lstart=` cross-check was dropped from this
      criterion — see "What actually shipped" above for why that signal
      cannot validate a reload-clearing badge in the first place.)
