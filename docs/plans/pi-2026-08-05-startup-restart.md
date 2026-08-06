# Startup-Relevant Session Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` task-by-task. Steps use checkbox syntax.

**Goal:** Make `r` converge stale tmux-backed Pi sessions by restarting their Pi process from the same transcript, so startup-only provider/model/extension changes apply without manual session-by-session work.

**Architecture:** Replace the packages-only stamp with a startup-input fingerprint stamped by each Pi process at process start. The dashboard recomputes that fingerprint for each session directory; `r` restarts sessions needing it through tmux's native pane respawn rather than typing `/reload`. It uses the existing settled/main-subagent gate and a pending queue, so no restart occurs during an active main turn or active subagent work.

**Tech Stack:** TypeScript, Node standard library, Pi extension API, tmux.

## Global Constraints

- Preserve the exact Pi transcript/session ID: relaunch with `pi --session <id>`.
- Never type `/reload`, `Ctrl+D`, or any other text/control character into target panes.
- Never restart `working` sessions or sessions with running/queued subagents; retain them in a queue and retry during dashboard refresh.
- Do not create a second live Pi process for one transcript.
- Do not publish npm.
- `tmux respawn-pane -k` is only the restart primitive because it was sandbox-proven: same transcript/session ID, a new Pi PID, and a subsequent prompt worked.
- Known ceiling requiring an explicit product decision before implementation: an idle but unsent Pi editor draft cannot be observed externally. A direct respawn preserves history but discards that draft. A resident request/ack protocol using `ctx.ui.getEditorText()` plus `ctx.shutdown()` is the only no-draft-loss design; sessions running the pre-protocol extension require one manual bootstrap or an explicit forced-restart choice.

---

### Task 1: Establish the no-draft-loss policy

**Files:**
- Modify: `docs/plans/pi-2026-08-05-startup-restart.md`

**Interfaces:**
- Consumes: Pi `ExtensionContext.ui.getEditorText()` and `ExtensionContext.shutdown()`.
- Produces: One selected restart policy: force-respawn for unattended/settled sessions, or resident request/ack for empty-editor verification.

- [x] **Step 1: Decide the trade-off explicitly**

**DECISION (Stanley, 2026-08-05): Option A — force respawn.** `r` performs `tmux respawn-pane -k` after the existing settled check; unsent-draft loss is the accepted ceiling for detached/headless fleet sessions, which is what pi-king is for. The draft-safe request/ack protocol (Option B) stays as documented future work if a draft ever demonstrably matters.

- [x] **Step 2: Record the selected policy in this plan before source changes**

Selected: **Option A (force respawn)**, chosen 2026-08-05 by Stanley. User-visible message on `r`: "Restarted N session(s), M queued — will restart once settled." Unsent-draft loss is documented in the README and in the Task 3 code comment as the known ceiling.

### Task 2: Add restart-relevant fingerprinting

**Files:**
- Modify: `src/index.ts:SessionStatusFile`, `src/index.ts:DashboardEntry`, `src/index.ts:computePackagesHash`, `src/index.ts:installSessionTracker`
- Test: sandboxed tmux session/status directory

**Interfaces:**
- Consumes: a session working directory and Pi startup resource configuration.
- Produces: `startupFingerprint?: string` on `SessionStatusFile`; `restartNeeded: boolean` on `DashboardEntry`.

- [ ] **Step 1: Write a sandbox assertion that a changed startup input causes a mismatch**

Start a session under a temporary agent directory containing a settings file and one extension file. Change `enabledModels`, then separately change extension source. Assert the dashboard’s computed fingerprint differs from the session’s stamp in both cases.

- [ ] **Step 2: Implement deterministic startup-input fingerprinting**

Hash sorted path plus file metadata/content for:

- the full global `settings.json` (covers `enabledModels`, provider/default-model configuration, and package declarations);
- global `trust.json` and `keybindings.json` when present;
- global Pi resource roots: `extensions`, `skills`, `prompts`, and `themes`;
- the current project’s `.pi/settings.json` and corresponding resource roots;
- configured local package resource roots resolved relative to the settings file, including the local `../../codebase/pi-king` package’s `package.json` and `src/**/*.ts`.

Exclude transcripts, `.git`, `node_modules`, generated media, and unrelated agent state. Cache per-directory inputs during one dashboard read so 14 cards do not rehash the global tree 14 times.

- [ ] **Step 3: Stamp only on process start, not `/reload`**

`session_start` fires on both process start and `/reload`. Preserve an existing stamp when `event.reason === "reload"`; otherwise write a fresh `startupFingerprint`. A reload must never make a process look startup-fresh when its provider registry is still old.

- [ ] **Step 4: Run typecheck and sandbox mismatch proof**

Run `npm run typecheck` and the focused sandbox proof. Confirm unchanged inputs produce no badge and either `enabledModels` or an extension change produces one.

### Task 3: Reuse the launch contract for session respawn

**Files:**
- Modify: `src/index.ts:createTmuxSession` and new restart helper near it
- Test: sandboxed tmux session

**Interfaces:**
- Consumes: tmux session name, session working directory, Pi session ID.
- Produces: `restartTmuxPane(name, cwd, sessionId): { ok: boolean; message: string }`.

- [ ] **Step 1: Write a sandbox assertion for transcript-preserving respawn**

Create a background Pi session, record its status ID/PID/transcript file, run the helper, wait for a changed PID, and assert the same session ID and transcript file are reported. Send one prompt and assert it receives a reply.

- [ ] **Step 2: Centralize launch environment**

Extract the `PI_CODING_AGENT_DIR`, `PATH`, `PI_DASHBOARD_SPAWNED`, and optional `PI_KING_STATUS_DIR` setup shared by `createTmuxSession()` and the restart helper. Preserve current behavior exactly for ordinary new/resumed sessions.

- [ ] **Step 3: Implement the selected restart policy**

For force respawn, invoke tmux without a shell:

```ts
tmux respawn-pane -k -t `=${tmuxName}:0.0` -c cwd -e environment -- pi --name tmuxName --session sessionId
```

For request/ack, implement a separate request directory and have the resident tracker own the safe shutdown decision; only relaunch after status/PID prove the old process has exited.

- [ ] **Step 4: Run typecheck and full respawn proof**

Run `npm run typecheck`, then the focused sandbox. Verify the old PID is dead, the new PID owns the same card, no second Pi process has the session ID, and a prompt after restart works.

### Task 4: Replace reload queue/UI semantics

**Files:**
- Modify: `src/index.ts:pendingReloads`, `flushPendingReloads`, `Dashboard.reloadStaleSessions`, card badge renderer, footer key help
- Test: sandboxed dashboard with idle and busy target sessions

**Interfaces:**
- Consumes: `restartNeeded`, `isSettled`, tmux correlation, selected restart policy.
- Produces: `pendingRestarts`, restart-now/queued badges, and `r` completion message.

- [ ] **Step 1: Write the busy-queue regression proof**

Make a target session fingerprint stale while it is working. Press `r`; assert the target PID does not change, its card reads queued, and it restarts exactly once after becoming eligible.

- [ ] **Step 2: Replace reload-specific queue state and naming**

Replace `pendingReloads` and `/reload` send-keys paths with a restart queue. At fire time, re-read `restartNeeded`, liveness, tmux correlation, and the settled predicate. Prune exited/missing/already-fresh entries. Do not start a repeated respawn loop when a restart fails.

- [ ] **Step 3: Update card and footer text**

Replace `⟳ stale`/`⟳ queued` with `↻ restart`/`↻ queued` (or the selected policy’s explicit safe-wait label). Change the footer from `r reload stale` to `r restart stale`.

- [ ] **Step 4: Verify duplicate action and failure behavior**

Press `r` twice during the same restart. Confirm one PID replacement only. Break the sandbox launch command or remove the target tmux session and confirm the queue stops with an actionable dashboard message instead of retrying forever.

### Task 5: Preserve immutable session identity through PID replacement

**Files:**
- Modify: `src/index.ts:session_start` continuity restoration
- Test: sandbox fork then restart

**Interfaces:**
- Consumes: old status card for the same, now-dead session ID.
- Produces: restarted sessions retain `visible` and `isFork` metadata.

- [ ] **Step 1: Write a fork-restart regression proof**

Fork a sandbox session, record that the child card has `isFork: true`, restart the child, then assert it still has `isFork: true` and still renders the fork badge.

- [ ] **Step 2: Restore immutable metadata from a dead predecessor only**

Keep the existing live-foreign-PID duplicate-transcript warning unchanged. When the prior owner PID is proven dead and the status file’s session ID matches the new process session ID, restore immutable `isFork`/visibility data without restoring old working state or subagent state.

- [ ] **Step 3: Verify old-process shutdown cannot erase successor state**

Force a timing-close restart in sandbox and confirm the old process cannot overwrite the new card as exited after the successor has claimed it.

### Task 6: Correct docs and final verification

**Files:**
- Modify: `README.md:Updating`
- Modify: `docs/FORMAT.md` if the session status contract gains a fingerprint field
- Modify: `docs/TEST-SUITE.md`
- Modify: `WORK-ORDER-package-reload-propagation.md`

**Interfaces:**
- Consumes: final source behavior.
- Produces: documentation that distinguishes `/reload` from full startup restart.

- [ ] **Step 1: Replace the incorrect `/reload` claim**

Document that `/reload` refreshes resources but does not re-run extension startup provider registration; `r` is the dashboard’s full restart path.

- [ ] **Step 2: Add restart coverage to the manual test suite**

Cover settings scope changes, OmniRoute extension edits, local pi-king extension edits, busy/subagent queueing, preserving session ID/transcript, preserving a fork badge, and the selected draft-safety behavior.

- [ ] **Step 3: Run completion gates**

Run `npm run check`, `npm run verify`, the focused restart sandbox, and inspect `git diff --check`. Confirm sandbox teardown and that the real tmux fleet count is unchanged.
