# Work Order: Package/Skill Reload Propagation Across pi-king Sessions

**Status:** Open — proposal only, not yet built
**Filed:** 2026-08-04
**Filed by:** Pi (handoff from session `019fcc02-4ce1-7512-b87e-9d51d028fdb1`)
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

## Open decisions for Stanley

1. Does the staleness badge belong on the main dashboard card, or only in an
   expanded/detail view? (Affects how much dashboard-real-estate this costs for
   something that's rare — one event per `pi install`.)
2. Should Option B's reload action require a confirmation click, or fire
   immediately when the settled-check passes? (Precedent: `/name` fires
   immediately once settled, no confirmation.)
3. Timeframe — is this worth building now, or does the Option A badge alone
   (giving visibility without automation) close the gap well enough for how
   infrequently packages get installed?

## Acceptance criteria (once built)

- [ ] Installing any package while N sessions are running results in a visible
      staleness indicator on all N stale session cards within one dashboard
      refresh cycle.
- [ ] The indicator clears correctly once a session is reloaded or restarted.
- [ ] No `/reload` or `send-keys` ever fires into a session mid-turn — verified
      by the same settled-at-prompt guard already proven for `/name`.
- [ ] False-positive rate on staleness detection is zero across a manual
      cross-check against `ps -o lstart=` (the method used to produce today's
      evidence).
