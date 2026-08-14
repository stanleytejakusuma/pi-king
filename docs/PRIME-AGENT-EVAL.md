# Prime Agent vs pi — evaluation for pi-king

Date: 2026-08-14 · prime-agent @ `9bf49d8` (clone in `/tmp/prime-agent`) · pi baseline: Stanley's pi 0.84.1 supervised by pi-king (`47c98a2`)

Evidence marks: **VERIFIED** = read in the repo/blog myself. **INFERRED** = reasoned from verified facts. Sources cited as repo `file:line` (lines from the `/tmp/prime-agent` clone) or blog section names.

---

## Headline

**prime-agent is a fork of pi, not a rival implementation.** README.md: "Our agent and TUI is built on top of pi" (MIT-licensed); the blog's acknowledgements say "Prime Agent is built on top of pi". The workspace packages keep the `@earendil-works/*` names at **version 0.7.2** (VERIFIED `package.json`), so the fork point predates Stanley's pi 0.84.1. This reframes the whole evaluation: migration cost is porting Stanley's customization surface to an *older pi*, not learning a foreign harness.

What's genuinely new is not the TUI or CLI — it's the **daemon** (a background supervisor owning sessions over a socket) and **RLM** (a persistent Python kernel where subagents are spawned like function calls). Those are real architectural differences. Everything else is pi.

## 1. How different is prime-agent from pi?

**Identity and language.** Same language, same stack: TypeScript, `@earendil-works/ai/agent/coding-agent/tui`. prime-agent additionally ships a bun entry (`src/bun/cli.ts`, VERIFIED). Fork package version 0.7.2 vs Stanley's pi 0.84.1.

| Surface | pi (Stanley's) | prime-agent | Port cost |
|---|---|---|---|
| Config dir | `~/.pi/agent` | `~/.prime/agent` (`package.json` `piConfig: { name: "prime-agent", configDir: ".prime/agent" }`, VERIFIED) | none — side-by-side installs don't collide |
| Process name | `pi` | `prime-agent` (`process.title = APP_NAME`, `src/cli-main.ts:18`, `src/bun/cli.ts:4`, VERIFIED) | breaks pi-king's `ps` probe (see §2) |
| Session files | `~/.pi/agent/sessions/*.jsonl` | `~/.prime/agent/sessions/*.jsonl` | same JSONL tree + leaf-pointer format family (VERIFIED docs/sessions.md) |
| **Extensions** | ~20 in `~/.pi/agent/extensions` | same API, superset of events (`docs/extensions.md`, VERIFIED) | **copy + path tweaks** |
| **Skills** | ~25 in `~/.pi/agent/skills` | same agentskills.io SKILL.md standard; settings `skills` array can point at any dir, incl. `~/.pi/agent/skills` (VERIFIED `docs/extensions.md` snippet) | **zero copy** |
| settings.json | models via OmniRoute local gateway | same schema family; `models` + `baseUrl` for custom local providers (VERIFIED `docs/models.md`, `docs/custom-provider.md`); `packages` supports `npm:`/`git:` | retype, hours |
| tmux/keybindings | extended-keys, ctrl-z safety binding | same keybinding-id system in `~/.prime/agent/keybindings.json`; `app.suspend` = ctrl+z by default (VERIFIED `docs/keybindings.md`); Kitty keyboard protocol guidance (`docs/terminal-setup.md`) | retype, minutes; INFERRED his tmux extended-keys setup applies similarly |
| pi-king | dashboard + fleet + extensions | no equivalent | see §2 |
| pix (patched pi-tui lab) | patches on pi 0.84.x TUI | fork TUI is at 0.7.2 | INFERRED: rebase or drop; it's a lab, not prod |
| **MCP** | MCP servers as tools | **rearchitected**: each MCP integration is a Python-backed *skill* run inside the kernel (`import linear; await linear.list_issues(...)`), not an agent tool; `mcpServers` key in settings, creds in `auth.json`, `/mcp login` (VERIFIED `docs/mcp-integrations.md`) | MCP configs don't port 1:1; you get built-in Linear/Notion instead |
| CLI verbs | `--session <id> --name <name> --continue --fork --autonomous --goal ...` | same base verbs **minus `--session <id>` / `--name`** (grep over `src/cli/args.ts` found none; only `/new --name` slash-cmd `src/core/new-session-command.ts:15` and daemon spawn `--name`, VERIFIED); **plus** a daemon command surface: `agents`, `attach <agent>`, `status [--json]`, `list [--all] [--json]`, `doctor [--fix]`, `schedule`, `update`, `shutdown` (VERIFIED `src/cli/command-registry.ts`) | n/a |

**Migration cost verdict: hours, not days** — for everything except pi-king. Extensions copy over with path/env tweaks, skills point at the existing dir, settings retype, keybindings retype. The only genuinely different surface is MCP. And the fork being at 0.7.2 means you'd be giving up ~0.7.2→0.84.1 of upstream pi fixes.

## 2. Could pi-king supervise prime-agent sessions?

Split the question, per the brief: **supervise** (spawn, liveness, status, attach) vs **integrate** (status cards, /bg, arcs).

### Supervise — yes, with a two-file patch

| pi-king coupling point | prime-agent reality | Verdict |
|---|---|---|
| Spawn: `tmux new-session -- pi --session <id> --name <name>` (`src/index.ts` ~2814, `src/fleet.ts` ~656) | no `--session`/`--name` flags. Headless spawn = daemon: run `prime-agent --mode daemon`, then `prime-agent agents <name> [args]` (VERIFIED `src/cli/daemon-command.ts` parseSessionArgs ~340-400); or interactive `/new --name` | **patch `createTmuxSession` command string**; small, real |
| Liveness: `ps` command must be exactly `pi` + pane-pid match (`src/fleet.ts` ~252, ~637) | process title is `prime-agent` | **patch, or better: delete the probe.** `prime-agent status --json` / `list --json` (VERIFIED `src/cli/daemon-list-format.ts`) is a strictly better liveness source than ps+pids |
| Attach: `tmux attach-session`, input gated by `isSettled()` | daemon keeps sessions alive across detach; TUI becomes a socket client (`prime-agent attach <agent>`) — run it inside the tmux pane | works; `isSettled()` gating unchanged |
| Status: dashboard reads JSON cards from `SESSION_STATUS_DIR` written by in-process extensions | extensions API intact: `ctx.ui.setStatus/setWidget/custom`, `ctx.sessionManager`, events `turn_start/turn_end/tool_execution_start/end` (VERIFIED `docs/extensions.md`) | **pi-alerts ports** to `~/.prime/agent/extensions/`; card contract (FORMAT.md v1) is pi-king's own env-based convention, not pi's — keep it |

So: spawn + liveness patches in `src/fleet.ts` (~2 call sites), port pi-alerts, done. An evening. But note the irony: prime-agent's daemon already does what pi-king's tmux layer provides (session persistence, detach/reattach), and its `status --json` replaces ps-probing — so a "supervised prime-agent" would actually *simplify* pi-king's fleet code.

### Integrate — don't

- **Status cards**: port of pi-alerts as above — fine, but only if he cares.
- **`/bg`**: pi-king's extension backgrounds a session into tmux. The daemon IS the backgrounder — residents keep running, clients attach/detach over the socket. `/bg` is redundant under prime-agent; delete or no-op it.
- **Arcs**: pi-king spawns a fresh empty pi session with `--session <id>` + lineage in `~/.pi/king/lineage.json`. Breaks at spawn (no `--session` flag). And prime-agent has a *native* equivalent — `rlm(...)` subagents and `agent_message` IPC with parent/child topology — so reimplementing pi-king arcs on prime-agent means writing a foreign object model over a capability the fork already has. Skip.

**Verdict: supervise = cheap patch; integrate = wrong move.** The features pi-king integrates *on top of* pi are the features prime-agent's daemon *absorbs into the core*. Integrating them twice is exactly the kind of customization spiral he's been trying to escape.

## 3. What role could prime-agent play here?

Constraints: pi-only fleet, tmux-hosted, local, no remote.

- **As a second supervised harness: viable, cheap.** `~/.prime/agent` doesn't collide with `~/.pi/agent`; the two can run side by side under one pi-king after the §2 patch. A week-long trial on one project costs one evening of setup.
- **As a migration: no.** It's an older pi with a different config dir. Nothing in his customization inventory gets *better* by moving; most of it ports sideways.
- **RLM angle — this is the only real reason to care.** RLM ("Recursive Language Model") is a persistent Python kernel that is the one built-in tool: `rlm(...)` spawns a child agent and returns a handle (never the answer), `agent_message.send()` does agent-to-agent IPC, kernel state survives compaction, skills are importable inside the kernel (VERIFIED `docs/rlm.md`, runtime at `/tmp/prime-agent/prime-agent-runtime/src/rlm`). The blog positions this as Prime's RL-data-generation harness: the **Continual Harness** (CRUD over prompt-notes/memory/skills/subagents, `/refine` two-phase apply-at-turn-boundary) is how an agent accumulates learned tooling; **PRIME-RL** (their multi-agent RL infra, 365k environments) is what consumes it. The blog is candid: *"no model has been trained around Prime Agent or its core feature set"* yet, and their Factorio run reward-hacked via an RCON teleport (VERIFIED blog "Benchmark" section caveats). So RLM is a bet on where agent harnesses are going — agents that spawn agents inside a compute context, not a chat context — not a finished product.
- **Fork-line risk (INFERRED).** Two lines to track: upstream pi (earendil) vs Prime's fork at 0.7.2 with their own fixes and divergence. Running both means dual config upkeep — the exact thing he just spent days on.

**Net: not a landing spot; a supervised experiment at most, and even that is only worth it if the RLM/kernel direction is something he'd actually use.**

---

## Grill questions

(One at a time — answer the first and I'll drill in.)

1. **What is the actual pain with pi that made you look?** If the pain is "harness hopping," prime-agent is another hop, not a landing — it's an *older* pi with Prime's extras. What would have to be true for you to declare the harness question *settled*?
2. **Do you want an agent *runtime* or an agent *TUI*?** The daemon + RLM kernel are the only non-pi parts of prime-agent, and they make half of pi-king (tmux persistence, ps probing) redundant. If the runtime is the draw, the decision isn't "which harness" — it's "does pi-king vNext stop being a tmux dashboard."
3. **Would agent-spawns-agent actually do anything for trading-journal or ventura work?** RLM is built for RL-era workflows (subagent-per-subtask inside a kernel, harness CRUD). If the honest answer is "curiosity," the evening of setup is better spent on pi.
4. **Are you willing to maintain two fork lines?** Upstream pi vs Prime's 0.7.2 fork with divergence — dual config upkeep is the customization tax you were trying to stop paying.
5. **What would make the answer obvious in 6 months?** Prime published the blog 9 days ago (2026-08-05), admits no model is trained around the harness yet, and the fork is pre-0.8. A re-check later costs nothing. What milestone (upstream merge, trained model, your own RLM use case) would flip this from "watch" to "adopt"?
