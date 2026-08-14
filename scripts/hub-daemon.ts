#!/usr/bin/env node --experimental-strip-types
/**
 * hub-daemon.ts — the detached hub daemon (launchd KeepAlive agent
 * com.stanz.pi-king-hub): owns marker polling (1s tick), injection, macOS
 * banner, and session-window restore 24/7, so a job landing while the user
 * is attached inside tmux still pings — the E2E proved the interactive hub
 * dies on attach and takes the idle-wake loop with it. The TUI dashboard is
 * a view of the same state, attachable on demand; the .injected claim
 * protocol dedupes injections between daemon, dashboard, and session-side
 * pi-jobs watchers.
 *
 * Plain node, not a `pi` process. Originally shipped as `pi --agents-hub
 * --agents-hub-daemon` (a full extension host); moved here 2026-08-10 after
 * confirming there was no hidden dependency worth the runtime: the daemon
 * never calls JobsPanel.resume() (nothing types keypresses at it), which was
 * the only path touching ctx.sessionManager, and every other piece — marker
 * scan/claim/inject, fleet build, tmux spawn — was already pi-API-free (see
 * src/fleet.ts and src/jobs.ts). Importing src/index.ts wholesale instead
 * would have dragged @earendil-works/pi-tui in at runtime purely to reach
 * buildRows()/createTmuxSession() — including pi-tui's own module-scope
 * Intl.Segmenter setup, the exact cost center a live-fleet CPU profile
 * identified during the same investigation. Cutting the pi runtime out
 * removes model-catalog init, tool/extension registration, and the TUI
 * entirely: only fs/child_process, same as any other node script.
 *
 * Run via: node --experimental-strip-types scripts/hub-daemon.ts
 * (wired through bin/pi-king --daemon; see there for the launchd plist).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TMUX, buildRows, isAcpCompactionGatePatched, isPiTuiPatched, restoreMissingSessions } from "../src/fleet.ts";
import { JobsPanel, notifyMacOS, type SessionManagerLike } from "../src/jobs.ts";

// Resolved once at module load, not per-call: this only needs to find
// itself relative to this script, unlike patch-pi-tui.mjs's own `which pi`
// search for a target it doesn't already know the location of.
const ACP_PATCH_TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "patch-acp.mjs");

// The daemon never receives a keypress, so JobsPanel.resume() — the only
// method that reads sessionManager.getEntries() (the goal-mode guard) — is
// never called here. A stub satisfies the type without pretending to be a
// real session; matches jobs.test.mjs's own `noSession` helper.
const noSession: SessionManagerLike = { getEntries: () => [] };

async function main(): Promise<void> {
  // A tmux server with no sessions exits non-zero from has-session but is
  // still "running" — start-server is a no-op when the server already exists.
  spawnSync(TMUX, ["start-server"], { encoding: "utf8", timeout: 3000 });
  const restored = restoreMissingSessions();
  if (restored > 0) {
    notifyMacOS("pi-king hub", `Restored ${restored} session window${restored === 1 ? "" : "s"} after a restart.`);
  }
  console.log(`[pi-king-hub] started ${new Date().toISOString()}${restored > 0 ? ` — restored ${restored} sessions` : ""}`);
  // Content-checked every start (never trust an install-time record — a pi
  // upgrade can silently wipe the patch without the daemon restarting).
  // Fix 1 (client-size spawn) always applies; Fix 2 is opt-in tooling, so
  // an unpatched pi-tui is expected on a fresh install, not an error — just
  // worth a log line so it isn't a silent regression after an upgrade.
  if (!isPiTuiPatched()) {
    console.log("[pi-king-hub] pi-tui unpatched — monolithic sessions will replay full renders under tmux; run `pi-king patch-tui` (docs/PERF-TMUX-SPEC.md Fix 2)");
  }
  // ACP's compaction-gate hand-patch (~/.pi/agent/PATCHES.md) has been
  // silently wiped twice in one evening by mechanisms never fully
  // root-caused; Stanley chose npm-managed updates over an update-proof
  // fork, so re-checking on every tick (not just at daemon start, unlike
  // the pi-tui check above) is the accepted mitigation -- catches a wipe
  // within ~1 minute of it happening instead of whenever someone next
  // notices ACP behaving unsafely.
  let acpPatched = isAcpCompactionGatePatched();
  if (!acpPatched) {
    console.log("[pi-king-hub] ACP compaction-gate patch missing at startup — session_before_compact may unconditionally cancel again; see ~/.pi/agent/PATCHES.md");
  }
  let acpCheckTick = 0;
  const panel = new JobsPanel(noSession, process.env.HOME ?? "/", undefined);
  // Same 1s tick as the dashboard, but buildRows() — ps, tmux list-sessions,
  // git-status caches, i.e. real subprocesses — is passed as a PROVIDER and
  // called only when a marker actually needs an owner resolved. In steady
  // state (nothing to deliver) an idle tick is a readdir plus a stat per
  // marker and forks nothing.
  for (;;) {
    try {
      panel.poll(Date.now(), buildRows);
      // Every ~60 ticks (~60s): re-check the ACP patch marker. A grep over
      // one file every minute is negligible next to the 1s poll's own ps/
      // tmux/git subprocess work; only alert on the true→false transition
      // so a persistently-unpatched install doesn't spam a notification
      // every minute forever.
      if (++acpCheckTick >= 60) {
        acpCheckTick = 0;
        const nowPatched = isAcpCompactionGatePatched();
        if (acpPatched && !nowPatched) {
          console.error("[pi-king-hub] ACP compaction-gate patch just vanished — auto-reapplying via patch-acp.mjs");
          // Auto-heal, not just alert: this has been silently wiped twice in
          // one evening by mechanisms never root-caused, so waiting for a
          // human to notice and rerun `pi-king patch-acp` by hand leaves an
          // unbounded unsafe window. patch-acp.mjs is the same content-based,
          // exact-count-checked, refuse-on-mismatch tool used by hand earlier
          // today — spawnSync here gets the same safety guarantees, just
          // triggered automatically instead of manually.
          const result = spawnSync(process.execPath, [ACP_PATCH_TOOL, "--apply"], { encoding: "utf8", timeout: 5000 });
          const reapplied = result.status === 0 && isAcpCompactionGatePatched();
          if (reapplied) {
            console.log("[pi-king-hub] ACP compaction-gate patch auto-reapplied.");
            notifyMacOS(
              "pi-king hub — ACP patch auto-reapplied",
              "billion-context-pi's compaction-gate patch was wiped and has been automatically reapplied. Sessions already running still hold the OLD unsafe behavior until restarted.",
            );
          } else {
            // patch-acp.mjs refused (exit 2, source no longer matches what
            // it expects — billion-context-pi's code actually changed, not
            // just reverted to it) or crashed. Do NOT retry every tick; that
            // would just spam a refusal forever. Fall back to the old
            // alert-only behavior so a human re-verifies by hand.
            console.error(`[pi-king-hub] ACP auto-reapply failed (exit ${result.status}): ${result.stderr || result.error}. Manual review needed — see ~/.pi/agent/PATCHES.md.`);
            notifyMacOS("pi-king hub — ACP patch reverted, auto-heal FAILED", "billion-context-pi's compaction-gate patch was wiped and auto-reapply failed. Manual fix needed — see ~/.pi/agent/PATCHES.md.");
          }
          acpPatched = reapplied;
        } else {
          acpPatched = nowPatched;
        }
      }
    } catch (err) {
      // One bad tick (tmux restarting, ps unavailable, an unreadable card)
      // must not end the process: launchd would respawn it, and every
      // respawn re-runs restoreMissingSessions(), which spawns sessions.
      // Log and keep ticking.
      console.error(`[pi-king-hub] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main();
