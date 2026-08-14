# Handoff: Prime Intellect's prime-agent eval (arc closed)

Written by the arc that ran this evaluation, for the main pi-king session. That
session spawned this arc and has no memory of what happened in it — treat this
as the only record.

## 1. Summary

Stanley asked an arc to evaluate whether to migrate off pi onto Prime
Intellect's `prime-agent` (https://github.com/PrimeIntellect-ai/prime-agent),
and what its "RLM" angle actually is. Verdict: **prime-agent is a fork of pi**
(README: "Our agent and TUI is built on top of pi"), currently pinned at pi
`0.7.2` vs Stanley's `0.84.1` — so it's an older pi with a daemon + Python
kernel bolted on, not a foreign harness. **Decision: no pi-king migration.**
Install it standalone, run one real trial (foundry K8-FAIL investigation, see
§5), and revisit. The interesting part isn't the TUI (same as pi's) — it's
RLM: a persistent Python kernel + agent-spawns-agent primitive that's a
plausible substrate for long-horizon work, but currently untrained (no RL
model behind it yet — you'd be feeling raw architecture, not a tuned model).

## 2. What's installed and where

- Binary: `prime-agent` **0.7.2**, installed via the official `install.sh`
  (not `npm install` — their `coding-agent` package's bin is literally `"pi"`
  and would have shadowed the real pi binary). Lives at
  `/opt/homebrew/bin/prime-agent`. Your pi `0.84.1` install is untouched.
- Config dir: `~/.prime/agent/` — `settings.json`, `models.json`,
  `auth.json`, `sessions/`, `kernel-venv/`. Zero path overlap with
  `~/.pi/agent`.
- OmniRoute wiring (mirrors your pi settings): `models.json` carries 64
  OmniRoute models with `baseUrl` pointed at `localhost:20128`, gateway key
  in `auth.json` (chmod 600, never printed). `settings.json` has
  `defaultProvider: "omniroute"`, `defaultModel: "omniroute/deepseek-v4-pro"`,
  `enabledModels: ["omniroute/*"]` (hides Prime's built-in unauthenticated
  providers from the picker). Model families audited against the live
  1698-model gateway catalog and bumped to latest: `claude-opus-4-8` →
  `claude-opus-5`, `qwen3.6-plus` → `qwen3.7-plus`; DeepSeek/GLM/GPT/Kimi
  entries were already current.
- Verified working: `--print` canary resolves through omniroute correctly,
  Claude family (`claude-opus-5`, `-sonnet-5`, `-haiku-4-5`, `-fable-5`)
  selectable and confirmed in the Ctrl+L picker, `model-resolver.ts:296-299`
  glob semantics confirmed collision-safe for `omniroute/*`.

## 3. Full eval report (not yet merged)

`docs/PRIME-AGENT-EVAL.md`, on branch `eval/prime-agent`, in a worktree at
`.worktrees/prime-agent-eval` — commits `f4411c7`, `0c70ec9`, `1bfedc2`. Main
is **untouched** at `043de5e`. Nobody has decided whether to merge this report
into main or leave it as reference-only — that decision is still open.

## 4. Operational gotchas (learned the hard way)

- **Bare model ids collide with prime-agent's built-in catalog** and silently
  resolve to unauthenticated built-in providers instead of OmniRoute. Always
  use scoped refs: `omniroute/claude-sonnet-5`, never bare `claude-sonnet-5`.
- **Every invocation leaves a resident daemon + Python kernel running**, even
  `prime-agent --print` one-shots. `kill -TERM` on the daemon just triggers
  its own crash-recovery (auto-reconnect at 250ms/1s/5s) and it respawns
  immediately with new worker/kernel processes. The correct stop is
  `prime-agent shutdown --force`.
- **`settings.json` writes are non-atomic** (matches upstream GitHub #983,
  fix #1380 still open). A live prime-agent process holds an in-memory copy
  and will clobber external edits on its next write — this happened twice
  live during the eval. Only edit `~/.prime/agent/settings.json` while no
  `prime-agent` process is running (check with `ps`, and watch for multiple
  Ghostty tabs each running their own daemon+kernel tree).

## 5. Decisions made and why

- **No pi-king integration this pass.** prime-agent's own daemon is currently
  *less* reliable than tmux: GitHub #1148 — after ~3 days of daemon uptime on
  macOS, `os.tmpdir()` pruning kills the supervisor registry and the only fix
  (daemon restart) drops all resident sessions; also #1072, #1291. tmux +
  pi-king's ps-liveness probing remains the sturdier layer for now.
- **First real trial: foundry K8-FAIL investigation** at
  `~/codebase/systematic-trading/foundry`, handoff at
  `systematic-trading/.claude/handoff.md`. Chosen because it's non-capital,
  Python (kernel-native), multi-hypothesis (good fit for fanning subagents
  one-per-hypothesis), and stalled — a real outcome is needed, not a toy.
  Install + config prep done; the task itself was **not launched** this pass
  (Stanley: "No need to launch the task").
- **RLM (Recursive Language Model)** — persistent Python kernel is the one
  built-in tool; `rlm("prompt")` spawns a child agent and returns a handle
  immediately (like a future, not a blocking call); parent keeps working;
  `agent_message.send(receiver_role=parent|child)` is the IPC; topology is
  nuclear-family (parent/sibling/child); kernel state survives compaction.
  This is the actual differentiator worth exploring — nothing in pi 0.84.1
  has kernel + subagent IPC. The TUI itself is not differentiated (same pi
  TUI, just older).
- **Charon: explicit hard stop for now.** Charon is live-signer-adjacent on
  beelink; a subagent tree means N agents with tool access near live keys.
  Doctrine (author freely, fire never) scales badly with N agents instead of
  one. Trial RLM on non-capital work first; charon only after the failure
  modes are understood from that trial.

## 6. Open loop (explicitly deprioritized, not resolved)

Stanley asked to confirm DeepSeek `v4-flash` = checkpoint `0731` and `v4-pro`
= `0813`. Investigated and **found unanswerable from OmniRoute's gateway**:
the full 1698-model catalog has only 3 deepseek ids total
(`deepseek-v4-flash`, `deepseek-v4-pro`, one `opencode-go/` proxy route) — no
dated variants exist anywhere. Both bare ids' `/v1/models` metadata share an
identical `created: 1786677369` timestamp, which is almost certainly
OmniRoute's alias-registration time, not a model release date — it can't
distinguish 0731 from 0813. Stanley said "let's disregard this" — it was
**not resolved**, just dropped. If it matters later: check OmniRoute's own
routing config directly (not the aggregated `/v1/models` view), or drop it
permanently.

## 7. Grill questions — status

The eval report ends with 5 grill questions. Status after the arc's
interactive back-and-forth:

1. **"What is the actual pain with pi that made you look?"** — still open.
   Stanley never answered this framing directly; he pivoted straight to
   curiosity about RLM rather than naming a concrete pi pain point.
2. **"Runtime or TUI?"** — partially answered. Stanley confirmed the runtime
   (RLM/daemon) is the draw, not the TUI (same pi TUI either way). But the
   harder follow-up — "does pi-king vNext stop being a tmux dashboard?" —
   is still open; he deferred it: "for this pass... just install and prepare
   prime agent," no pi-king patch.
3. **"Would agent-spawns-agent do anything real for trading-journal or
   ventura?"** — still open, deliberately untested. Foundry was chosen as a
   safer non-capital proxy first; trading-journal/ventura weren't touched.
4. **"Two fork lines — does Prime have any plan to sync with upstream pi?"**
   — **answered** via `gh api`: no wholesale-sync plan. Track-and-cherry-pick
   model; issue #1182 gates their v0.8 on upstream prereqs #838/#850/#851/
   #852; ~492-commit divergence from a beta tag.
5. **"What flips 'watch' to 'adopt' in 6 months?"** — still open. Stanley's
   answer was "No clue. Curious to see how significant of a difference RLM
   has" — no milestone was named. Whoever picks this up next should press
   for one before the foundry trial, so there's a stopping condition.
