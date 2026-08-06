# Pi session-status format v1

A published, versioned contract for advertising **live Pi session state** on the
local machine. Any tool may read this directory. The shape is meant to be
depended on — it is not an internal implementation detail.

## Why this exists

Pi's own `/resume` browses session *transcripts* on disk, but has no concept of
liveness: it cannot tell you which sessions are running right now, what state
they are in, or what they are doing. Extensions that need that today each
invent a private representation in a private directory, with no documented
shape, so nothing can interoperate.

This is an attempt to fix that with the smallest possible thing: a documented,
versioned JSON file per live session.

## Location

```
~/.pi/king/session-status/<sessionId>.json
```

This path is **fixed by design**, and MUST NOT be derived from
`PI_CODING_AGENT_DIR`.

That variable is per-process: a supervisor may run against a minimal config
directory while the sessions it spawns use the user's normal one. Two
participants deriving the directory from their own environment compute
different paths and never see each other — the failure is silent and total
(an empty list, not an error).

A rendezvous point is the one thing every participant must agree on without
coordinating, so it cannot be configurable per process.

`PI_KING_STATUS_DIR` overrides it for sandboxes and tests. If you set it, set
it for **every** participant.

## Schema

```jsonc
{
  "formatVersion": 1,
  "id": "019fb27c-6804-7fa5-96f3-e63e610950c7",  // Pi session id
  "name": "example-project",                         // user-set name, may be null
  "cwd": "/Users/you/codebase/example-project",
  "project": "example-project",                      // basename(cwd), convenience
  "model": "omni-claude-sonnet-5",                // may be null
  "pid": 58504,                                   // OS pid of the session
  "startedAt": 1785400000000,                     // epoch ms
  "lastActivity": 1785400123456,                  // epoch ms of last state change
  "status": "working",                            // working|idle|background|attention|error|exited
  "activity": "Investigate the failing test",     // human-readable, what it's doing
  "title": "⏳ π · example-project · codebase #019fb27c",
  "sessionFile": "/Users/you/.pi/agent/sessions/.../<id>.jsonl",
  "startupFingerprint": "aac1e12e5b1adae8",  // optional: hash of startup inputs
  "isFork": false,                             // optional: true when /fork-born
  "subagents": [
    { "id": "64ca09e8", "agentType": "general-purpose", "description": "…",
      "status": "running", "startedAt": 1785400100000, "completedAt": null }
  ],
  "visible": true                                 // opted in to being listed
}
```

### Field notes

- **`startupFingerprint`** (optional) — deterministic hash of everything a
  fresh process start in this session's `cwd` would load: the full canonical
  global `settings.json` (so `enabledModels` and package declarations count),
  global `trust.json`/`keybindings.json`, the global resource roots
  (extensions/skills/prompts/themes), one marker per `settings.packages`
  entry, and the project scope (`.pi/settings.json` + `.pi` resource roots).
  Stamped only on a genuine process start, preserved across `/reload`, and
  inherited by a `/fork` (which shares the process). A reader comparing it
  against its own fresh read detects startup-only changes — provider
  registration, model scope, OmniRoute routing — that a reload does not
  apply. Absent means "predates the field" or "never stamped", which the
  dashboard treats the same as a mismatch.
- **`status`** is coarse lifecycle, not a free-form string. `attention` means a
  background result is waiting; `trust` means a permission decision is pending.
- **`activity`** is prose for humans. It is intentionally NOT the same field as
  `lastActivity`.
- **`visible`** is an opt-in flag. A session sets it when the user explicitly
  surfaces it (e.g. a `/bg` command) or when it was spawned by a supervisor.
  Readers building a user-facing list SHOULD respect it; readers doing
  diagnostics MAY ignore it.

## Writer requirements

1. Create the directory if absent (`mkdir -p`). The first participant to start
   wins; the operation is idempotent.
2. Write atomically — `write` to `<id>.json.tmp-<pid>` then `rename` — so a
   reader never observes a partial file.
3. Update on every state transition, not on a timer.
4. Delete your file on clean shutdown.

## Reader requirements

1. **Verify liveness by identity, not existence.** A pid alone is insufficient:
   `process.kill(pid, 0)` proves *some* process holds that pid, not that it is
   the one that wrote the file. Sessions killed abruptly never run their
   shutdown hook, so their file survives until the OS recycles that pid — often
   onto another live session of the same program, at which point a dead entry
   appears healthy. Observed in practice.

   Compare the process start time against the entry's `startedAt` (a small
   tolerance covers the gap between process start and first write). If the
   liveness probe itself fails, prefer showing a possibly-stale entry over
   deleting a live session's file.
2. Readers MAY unlink files whose pid is gone.
3. Tolerate unparseable files by skipping them — a write may be in flight.
4. Ignore unknown fields. Reject `formatVersion` values you do not understand
   rather than guessing.

## Relationship to other extensions

This format **converges deliberately** with
[`pi-intercom`](https://www.npmjs.com/package/pi-intercom)'s internal
`SessionInfo` on the fields where semantics genuinely match — `id`, `name`,
`cwd`, `model`, `pid`, `startedAt` — so a reader can treat both alike.

This is convergent naming, **not** an implementation of pi-intercom's protocol.
No part of its broker or wire protocol is spoken here. `pi-intercom` solves
message routing between sessions; this solves advertising session state to
observers. Different problems.

One divergence is deliberate: pi-intercom's `lastActivity` is a numeric
timestamp. An earlier draft of this format used that name for a text
description, which would have been a same-name/different-meaning collision —
worse than simply choosing a different name. The timestamp therefore keeps
`lastActivity` (matching pi-intercom) and the prose moved to `activity`.

[`pi-messenger`](https://www.npmjs.com/package/pi-messenger) independently
arrived at the same underlying pattern (one JSON file per session in a registry
directory, pid-based liveness, unlink-on-stale), which is good evidence this is
the right shape for the problem.

## Versioning

`formatVersion` is bumped on any breaking change. Additive optional fields do
not bump it.

## Usage metrics (optional)

The metrics band reads per-day call logs from the directory named by
`PI_KING_CALL_LOGS`. Unset means the band is absent, which is the default: no
stock Pi install writes this format, and inventing a default path would name one
vendor's tool in a general-purpose package.

Each file is JSON with a `summary` object. Fields read:

- `status` (number) HTTP status. 400 and above counts as an error.
- `model` (string) for the model mix.
- `timestamp` (ISO-8601 UTC) for the hourly sparkline.
- `tokens.in`, `tokens.out`, `tokens.cacheRead` (numbers) for token totals and
  cache share. `cacheRead` is a subset of `in`, not additive: verified across
  2,124 sampled records, the ratio never exceeds 1.0. Anything comparing token
  volume to something outside the system should subtract it, since cache reads
  are the same history re-sent each turn rather than new text. Cache share is reported against input tokens, because cached
  input is billed at a fraction of fresh input and is what makes a large token
  count cheap.
- `duration` (ms) for p95. The mean hides the tail; the tail is what a person
  waiting on a session experiences.

Unknown fields are ignored. A file that fails to parse marks the day partial
rather than being counted as zero.

Net tokens are reported as `in` minus `cacheRead`. Input alone counts the same
conversation history re-sent on every turn, which on a long day differs from
new text by an order of magnitude. Net is the figure that tracks how much fresh
ground was covered; input is the figure that tracks what was billed.

Status values are additive over time; readers must tolerate unknown strings.
`background` means the main agent has settled but subagents are still running
on the session's behalf — neither working nor idle.
`attention` means the session finished a turn while no tmux client was attached.
`trust` means a tool call has sat unexecuted long enough that a human is being
asked to approve it. `exited` means the writing process is gone; the file
remains, because it is the only pointer that knows how to resume the transcript
(`pi --session <id>`). Files are removed only by an explicit dismiss in the
dashboard, or at clean shutdown of a session that never appeared on it.

A day in the daily series and today's band figures are always LOCAL calendar
days, computed from each call record's own timestamp — never from the name of
the call-log directory it sits in. The router names directories by UTC
calendar day, which disagrees with a human's day by the local UTC offset; for
anyone not on UTC, a single directory's records routinely split across two
local dates, and for part of every day the directory named after local
"today" does not exist yet. Trusting the directory name produced a real bug:
at UTC+7, the band reported no activity for the first seven hours of every
day despite calls having already happened.

The day cache is an archive, not just an accelerator. The router rotates old
log directories away; a cached day that carries every field keeps counting
toward lifetime figures after its logs are gone, because it was measured while
they existed. A cached day missing fields whose logs are gone can never be
completed and is kept in the file but excluded from the series.

Pins and manual ordering live in `~/.pi/king/layout.json` (`{ pinned: [id],
order: [id] }`), NOT in the status files. A status file is written by that
session's own process; the dashboard writing into one would put two processes
on a single file. Ordering is a view preference and belongs to the viewer.

The band's token segment scans today's call-log directory only, same as
every other figure in the band except the 7d sparkline and the average, which
are explicitly labelled with their own window. It read as ambiguous sitting
unlabelled between two segments that both name theirs, so it now reads
"tok today: in ... out ... net ..." rather than leaving the window to be
inferred from position.

Cost is deliberately not reported. The logs carry no price data, and a hardcoded
price table would silently rot into wrong numbers.
