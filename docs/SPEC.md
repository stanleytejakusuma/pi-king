# pi-king — spec

> **Background a Pi session and come back to it later.**
> A local control plane for long-running [Pi](https://pi.dev/) sessions.

Status: draft. Intended to be open-sourced as `pi-king` (npm name verified
available).

## Credit where it's due

**pi-king is heavily inspired by [Claude Code's Agent
View](https://code.claude.com/docs/en/agent-view).** That interface is the
reason this exists: it made the case that when you are running multiple agents,
the supervisory view is a first-class surface rather than an afterthought.

The difference is scope. Claude Code's Agent View — and the closest thing in
Pi's ecosystem, `@tintinweb/pi-subagents`' FleetView — are **session-scoped**:
they show the subagents *inside one session*. pi-king is **process-scoped**: it
supervises whole Pi sessions across every project on the machine, and it can
put you back inside one.

## The problem

You cannot currently background a Pi session and reattach to the running
process later.

This is a capability gap, not a UX preference:

- **Pi's own `/resume`** browses session transcripts and has a `Current Folder |
  All` scope toggle — but starts a **new process** against old history. The
  original process is gone: in-memory state, running subagents, and the live
  agent loop are all lost. (Verified: its session selector contains zero
  liveness checks — no `pid`, `isRunning`, or `process.kill` anywhere.)
- **`pi-intercom`** can *message* a live session but cannot put you inside it.
- **`overstory`** offered `tmux attach`, but explicitly as an "escape hatch"
  from its web UI — and it is now archived.

So a long-running Pi session is trapped in the terminal tab that birthed it.
Close the tab and the work dies. Walk away and you lose track of what is still
running.

## What pi-king does

1. **Persistence.** Sessions run inside tmux. Detach and the session keeps
   working headless; reattach later and you are back in the *same* process with
   full state intact.
2. **Supervision.** A live TUI listing every opted-in session across every
   project: state (working / idle / attention / error), what it is currently
   doing, and its background subagents.
3. **Lifecycle.** Create, rename, and delete sessions from the TUI.
4. **Honest liveness.** Sessions are PID-verified. A crashed session disappears
   rather than lying about its state forever.

The interaction loop is: **dashboard → attach → work → detach → dashboard.**

## Positioning, stated plainly

This is *not* pitched as "a fleet view for Pi". That framing invites comparison
with prior art it would lose against, and collides with the existing `pi-fleet`
package (which does cross-*device* orchestration over Tailscale). The pitch is
**persistence and reattachment**; the supervisory view is how you drive it.

### What is genuinely new

- **Backgrounding and reattaching to a running Pi session.** Nothing in the
  ecosystem does this.
- **Session lifecycle CRUD from a TUI.**
- **Cross-session subagent rollup** — `pi-subagents` shows subagents within one
  session; nothing aggregates them across sessions.
- **A documented, versioned session-state contract** (`FORMAT.md`) — the first
  in the ecosystem.
- **tmux as the primary control plane.** `overstory` inverted this: a web app
  that reluctantly dropped to a terminal. pi-king is a terminal tool where tmux
  *is* the mechanism.

### What is not new, and should not be claimed as such

| Component | Prior art |
|---|---|
| Cross-project session listing | Pi core `/resume` (`All` scope) |
| Live session discovery + status | `pi-intercom`, `pi-messenger` |
| File registry + PID liveness | `pi-messenger` (independently identical) |
| Usage statistics | `@oh-my-pi/omp-stats` (richer: cost, TTFT) |
| Subagent fleet widget | `@tintinweb/pi-subagents` FleetView |

Five of six components have prior art. The product is the persistence
capability; the rest is supporting cast. Any pitch that leads with "dashboard"
is describing the duplicated part.

## Architecture

### Session state — file registry (decided)

Each session writes a versioned JSON snapshot to
`$PI_CODING_AGENT_DIR/session-status/<id>.json` on every state transition. The
supervisor polls, PID-checks, and unlinks dead entries. Schema and requirements
are published in **`FORMAT.md`**.

**Rejected: consuming `pi-intercom`'s IPC broker.** It is a *messaging*
extension whose presence roster is a side effect, not a contract. Its
`SessionInfo` lacks `subagents`, `tmuxName`, and `visible`, so we would need our
own store *anyway* — a dependency plus a registry is strictly worse than a
registry. Its roster also auto-registers every session, conflicting with our
opt-in requirement, and `INTERCOM_PROTOCOL_VERSION` is an internal constant, not
a published contract.

**Rejected: hybrid.** Logically inverted — our registry is the *superset*, so
the broker would be the degraded path, not the fallback.

Field names converge with `pi-intercom`'s `SessionInfo` where semantics genuinely
match (`id`, `name`, `cwd`, `model`, `pid`, `startedAt`). This is convergent
naming, **not** protocol compliance. One deliberate divergence: their
`lastActivity` is a numeric timestamp, so ours matches that, and the
human-readable description moved to `activity` — a same-name/different-meaning
collision would be worse than a different name.

### Persistence — tmux

tmux provides detach/attach semantics that Pi has no primitive for. Sessions
created through pi-king are `tmux new-session -d` with
`PI_DASHBOARD_SPAWNED=1` (opt-in marker) and `PI_CODING_AGENT_DIR` propagated so
they inherit the user's normal configuration.

**Terminal ownership is load-bearing.** Exactly one process may own the
terminal. The supervisor writes the chosen action to a file and **exits**; a
wrapper script then execs tmux, which owns the terminal outright; on detach the
wrapper relaunches the supervisor. Spawning tmux as a child of the live TUI
instead causes both processes to read the same stdin and fight over terminal
mode — observed in practice as the tmux client dying on a keypress.

### Visibility — explicit opt-in

A session appears only if spawned by pi-king or surfaced by the user with
`/bg`. Being alive is not sufficient. Every interactive session writes a status
file for other purposes; most have no business on a supervisory view.

## Open-source requirements

These are requirements, not aspirations — the current implementation violates
several and must be fixed before release.

1. **No hardcoded absolute paths.** `/opt/homebrew/bin/tmux`, Ghostty's bundle
   ID, and `terminal-notifier` are all machine-specific. Resolve via `PATH`,
   degrade gracefully when absent.
2. **No assumed terminal.** Ghostty-specific tab-jumping must be optional and
   feature-detected; the tool must be fully usable in any terminal.
3. **Configurable.** Poll interval, opt-in default, tmux binary, keybindings,
   and which panels render should come from config, not constants.
4. **Optional stats.** The usage panel reads the directory named by `PI_KING_CALL_LOGS`, which is
   specific to one router. It must be off by default and pluggable.
5. **Degrade, never fabricate.** Missing data renders nothing — never a zero
   that implies a measurement. No progress bars, because Pi exposes no
   completion percentage.

## UI

Secondary to the capability, but it is the whole interface, so it matters.

- **Banner** — Braille-rendered π (generated by `tools/pi-braille-art.py`, not a
  hardcoded constant, so it is resizable) plus wordmark, inside the panel so it
  shares the panel's edges rather than floating.
- **Session cards** in a responsive grid: 3 columns ≥160 cols, 2 ≥110, else 1.
  A card needs ~45 columns before truncation makes it useless.
- **Colour encodes meaning, never decoration**: state severity on the card
  border and status word, threshold colouring on error rate, descending
  emphasis for model rank.
- **Inventory** (skills / prompts / extensions / CLIs) as content-sized cards
  below the sessions.
- **Landing page** when nothing is backgrounded: how to start, plus recent
  projects with last-active times.
- **Footer** grouped by consequence — navigate │ manage │ meta — with the
  destructive key coloured.

## Verification

Live and human-driven, in real turns. Scripted `expect`-based testing of an
interactive TUI produced four false results and one desktop-disrupting failure
before being abandoned; a live terminal UI cannot be honestly proven through a
scripted proxy.

| # | Check | Pass condition |
|---|---|---|
| 1 | Launch | Clean banner, no input box, no startup noise |
| 2 | Create | `n` → prefills invoking cwd → attaches to a live session |
| 3 | Type | Real prompt and response inside the tmux-hosted session |
| 4 | Detach | `Cmd+Esc` returns to the supervisor; session persists as `⛺` |
| 5 | Reattach | Same process, history intact — not a fresh session |
| 6 | Rename / delete | `e` renames; `x` twice removes; `tmux ls` confirms |
| 7 | Opt-in filter | Ad-hoc `pi` absent until `/bg`, then present as `⌁` |
| 8 | Liveness | `kill -9` a session → it disappears, not "still running" |
| 9 | Subagent rollup | Spawn a background subagent → appears on its card |
| 10 | Quit discipline | `q` does nothing; `Esc` and `Ctrl+C` exit cleanly |
| 11 | Degradation | Remove the stats source → panel vanishes, rest unaffected |
| 12 | Portability | Runs with Ghostty features unavailable |

## Open questions

1. Which usage metrics survive into the ambient line, given `omp-stats` covers
   this space more thoroughly.
2. Whether to propose a session-lifecycle hook upstream to Pi core, so
   extensions stop each inventing a polling directory (`FORMAT.md` is the
   interim answer).
3. Multi-window tmux: currently one window per session. Panes/splits unhandled.

## Invariants

These are load-bearing. Violating any of them causes silent damage rather than a
visible error, which is why they are written down.

**One live process per transcript.** A Pi session's transcript is append-only and
has no locking. Two processes resuming the same session id both append, and the
result is a transcript whose parent chain forks. Nothing detects this at write
time. `/bg` prints a resume command that is correct only after the backgrounded
session ends; running it while that session is alive is the realistic way to
break this, so the extension checks on startup whether its own session id is
already claimed by a live process and says so.

**Identity is a process, not a label.** Correlation between a Pi session and a
tmux session is by pane pid, matched against the pid recorded in the status file
and verified by process start time. Earlier versions correlated by a token
stored in a tmux user option; a tmux option is writable by anything running as
the same user, so it could be moved onto an attacker's session, and following
that pairing would attach the user to a pane they did not choose. A pid cannot
be moved.

**Ambiguity fails closed.** When two rows claim the same pane pid, both are
discarded rather than one being chosen. There is deliberately no fallback to
name matching: pairing on resemblance is the same mistake as pairing on a token,
and an unmatched session rendering as unmatched is harmless.

**Missing data renders as nothing.** Never a zero. A zero asserts a measurement
that was not made.
