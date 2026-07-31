<div align="center">

```
⢦⡀⠀⠀⠀⣀⠀⠀⠀⢀⡴
⠈⢷⣄⣴⣿⣿⣿⣦⣠⡾⠁
⠀⣨⣿⣿⣿⣿⣿⣿⣿⣅
⠀⠉⢹⣿⠉⠉⠉⣿⡏⠉
⠀⠀⢸⣿⠀⠀⠀⣿⡇
⠀⠀⠘⠛⠀⠀⠀⠛⠛⠂
```

# pi-king

**Background a Pi session and come back to it later.**

A local control plane for long-running [Pi](https://pi.dev) sessions.

[![npm](https://img.shields.io/npm/v/pi-king?style=flat-square)](https://www.npmjs.com/package/pi-king)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

## The problem

You cannot currently background a Pi session and reattach to the running
process later.

That is a capability gap, not a preference:

- **`/resume`** browses session transcripts and can list sessions from every
  project — but it starts a **new process** against old history. The original
  is gone: in-memory state, running subagents, and the live agent loop with it.
- A long-running session is therefore trapped in the terminal tab that spawned
  it. Close the tab and the work dies. Walk away and you lose track of what is
  still running.

## What pi-king does

- **Persistence.** Sessions run inside tmux. Detach and the session keeps
  working headless; reattach later and you are back in the *same process*.
- **Supervision.** A live TUI listing every opted-in session across every
  project — state, what it is doing, and its background subagents.
- **Lifecycle.** Create, rename, and delete sessions from the TUI.
- **Honest liveness.** Sessions are verified by process identity. A crashed
  session disappears rather than lying about its state.

The loop is: **dashboard → attach → work → detach → dashboard.**

## Credit

pi-king is heavily inspired by
[Claude Code's Agent View](https://code.claude.com/docs/en/agent-view), which
made the case that when you run several agents, the supervisory view is a
first-class surface rather than an afterthought.

The difference is scope. Agent View — and Pi's closest equivalent,
[`pi-subagents`](https://www.npmjs.com/package/@tintinweb/pi-subagents)'
FleetView — are **session-scoped**: they show the subagents *inside* one
session. pi-king is **process-scoped**: it supervises whole Pi sessions across
every project on the machine, and can put you back inside one.

## Install

```bash
pi install npm:pi-king
```

Requires [tmux](https://github.com/tmux/tmux) for persistence. Without it,
pi-king still runs and lists sessions — it just cannot background them, and
says so.

### Recommended tmux settings

Pi negotiates the kitty keyboard protocol. Without these, modified keys
(Shift+Enter and friends) misbehave inside tmux, and keystrokes can duplicate:

```tmux
set -s extended-keys on
set -s extended-keys-format csi-u
```

## Use

```bash
pi-king          # open the dashboard
```

| Key | Action |
|---|---|
| `↑` `↓` | select |
| `enter` | attach (tmux-backed) or jump to its terminal tab |
| `n` | new session |
| `e` | rename |
| `x` `x` | delete (two presses) |
| `r` | refresh |
| `esc` | close |

Inside any Pi session:

```
/bg     # background this session into tmux and surface it on the dashboard
```

`/bg` is safe to run mid-turn: it **queues** and fires once the session
settles, so an in-flight response and any running subagents finish normally
rather than being killed.

Detach from an attached session with tmux's own `Ctrl+B d`.

## Design notes

**Explicit opt-in.** A session appears only if it was spawned by pi-king or
surfaced with `/bg`. Being alive is not enough — most sessions have no business
on a supervisory view.

**No fabricated numbers.** There are no progress bars, because Pi exposes no
completion percentage for a session or a subagent. Elapsed time and subagent
counts carry the same signal honestly. Missing data renders as nothing, never
as a zero that implies a measurement.

**Liveness is identity, not existence.** A pid alone proves only that *some*
process holds it. Sessions killed abruptly leave their status file behind, and
the OS later recycles that pid — often onto another live Pi. pi-king compares
process start times, so a dead entry cannot masquerade as a healthy one.

**Standalone.** Depends on stock Pi and the Node standard library. Subagent
rollup is feature-detected: with a subagent extension installed you get the
counts, without one the column is simply absent.

## Interoperating

pi-king publishes the format sessions use to advertise themselves:
**[docs/FORMAT.md](docs/FORMAT.md)** — versioned, with writer and reader
requirements. Anything may read or write it.

It exists because Pi has no lifecycle hook for "session started / state
changed / stopped", so every extension that needs live session state invents
its own private representation. This is an attempt at a documented one.

## Platform support

| | |
|---|---|
| macOS | developed and tested here |
| Linux | should work; **not yet verified** |
| Windows | untested; tmux dependency likely makes it WSL-only |

Jump-to-tab for non-tmux sessions is macOS + Ghostty only, feature-detected,
and degrades to a message pointing at `/bg`. Everything else is portable.

## Docs

- **[docs/FORMAT.md](docs/FORMAT.md)** — the session-status contract
- **[docs/SPEC.md](docs/SPEC.md)** — design decisions and what is deliberately
  *not* novel
- **[docs/TEST-SUITE.md](docs/TEST-SUITE.md)** — 28 manual tests

The wordmark is generated, not a magic constant:
`python3 tools/braille-art.py 11`.

## License

MIT
