/**
 * pi-dashboard.ts — cross-project live supervisor for every active Pi session,
 * with tmux-backed background/attach/create/rename/delete session management.
 *
 * Two entry points:
 *  - `/pi-dashboard` slash command, usable from any existing interactive session.
 *  - The `--agents-hub` flag (wired to the standalone `pi-king` shell wrapper),
 *    which opens the dashboard immediately at session_start and loops on it
 *    until the user quits, instead of dropping into a normal chat prompt.
 *
 * Data layer (unchanged from the original design, per instruction not to rework
 * it): `pi-alerts.ts` owns the per-session state model (working/idle/attention/
 * error/trust) and persists a small JSON snapshot per session to
 * `~/.pi/agent/session-status/<sessionId>.json` on every state transition; this
 * extension only ever *reads* that directory, and prunes entries whose writer
 * PID is gone (honest degradation — a crashed session simply disappears).
 *
 * Session management layer (new): real background/attach is implemented on top
 * of tmux, not reinvented inside Pi's extension API. Checked before building on
 * it: `pi --mode rpc` is a single-client stdin/stdout wrapper, not a multi-client
 * attach server; `--resume`/`--session <id>` starts a *new* process against old
 * history, it does not reattach to an already-running one. Pi has no native
 * attach/detach primitive. tmux does, for free: `tmux detach-client` backgrounds
 * the current pane without disturbing the process inside it; `tmux attach-session`
 * takes over the current terminal with that exact live pane; `tmux new-session`/
 * `rename-session`/`kill-session` cover create/rename/delete. Sessions are
 * correlated between the two data sources (pi-alerts status files and tmux) by
 * name: when a session is created *through* this dashboard, the same string is
 * used as both the tmux session name and the `pi --name` value, so a status
 * file's `name` field matching a live tmux session name means that entry is
 * attach-capable. Ad-hoc sessions started by typing `pi` directly into a plain
 * terminal (not created through the dashboard) have no tmux session to
 * correlate with, so they fall back to the original Ghostty-tab-jump mechanism
 * — a known, accepted tradeoff, not a bug.
 *
 * Navigation fallback (unchanged): Ghostty renders its own tab bar (confirmed
 * empirically — the accessibility tree exposes zero tab UI elements), so
 * System Events / AXRaise tab-matching is impossible. Ghostty's own AppleScript
 * dictionary (`Ghostty.sdef`) is used instead: `tab.title` is broken in Ghostty
 * 1.3.1 (confirmed empirically — raises `-1700` on every read) but
 * `terminal.name` (the same title text) and `terminal.workingDirectory` both
 * work, and `select tab` / `activate window` both work. Matched by the stable
 * `#<shortId>` suffix pi-alerts.ts embeds in every title.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Component, TUI } from "@earendil-works/pi-tui";
/** pi-tui does not export its theme type by name. Structural shape is all this
 * file uses, and pinning it here keeps the typecheck honest instead of
 * disabling it for the whole module. */
type Theme = {
  fg(colour: string, text: string): string;
  bold(text: string): string;
};
import { Input, isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

/* ---------------------------------------------------------------- state -- */
/** Coarse session lifecycle. Owned here so pi-king depends on stock Pi only. */

// \u{...} with braces: a bare \u takes exactly four hex digits, so \u1f514
// silently parsed as U+1F51 followed by a literal "4" and the attention icon
// rendered as a Greek vowel with a digit stuck to it. Shipped that way.
// One geometric family, all U+25xx, all text presentation and single width.
// The old set mixed \u23f3 and \u{1f514} -- both emoji-presentation, so Ghostty painted
// them in colour at double width beside crisp single-width marks, and the two
// loudest glyphs in the column were decided by which codepoints happened to
// have emoji fonts rather than by which states matter. Hue already encodes
// urgency and the state word is printed alongside, so shape only has to be
// distinguishable, not descriptive. Angular = wants a human (attention,
// error); round = running itself.
export const stateIcon: Record<TitleState, string> = {
  // background: the main agent has settled but subagents are still running —
  // the session is neither working (nothing to wait on at the prompt) nor idle
  // (work is genuinely still happening on its behalf). pi-alerts has drawn
  // this distinction in its own state model since before this file existed;
  // the dashboard calling the same moment "idle" was simply less true.
  working: "\u25d0", idle: "\u25cf", background: "\u25d2", attention: "\u25c6", error: "\u25b2", exited: "\u25cb",
};

/** FORMAT.md promises readers tolerate unknown status strings, because the
 * set is additive and a session may be running an older or newer writer than
 * the dashboard. This reader did not: a session still writing the retired
 * "trust" state rendered as the literal text "undefined trust", and its
 * missing sort priority made the comparator return NaN, quietly scrambling
 * row order. Every lookup keyed by a status now goes through here. */
/** Icon for any status, known or not. An unknown state keeps its own name on
 * screen — inventing a familiar one would be a worse lie than admitting the
 * dashboard does not recognise it. */
export function iconFor(s: string): string {
  return isKnownState(s) ? stateIcon[s] : "\u25cc";
}

import {
  clean,
  compactNum,
  netTokens,
  tokenComparison,
  PI_ART,
  StatsCache,
  sparkline,
  readInventory,
  readLastReply,
  readRecentProjects,
  quoteOfTheDay,
  type Inventory,
  type RecentProject,
  type UsageStats,
  type DayTotal,
} from "./data.ts";
import { Type } from "typebox";
import { allArcs, arcsOf, closeArc, dispatchSession, extractConversation, findArc, slugForTask, spawnArc } from "./arc.ts";
import { JobsPanel, notifyMacOS, scanJobs, selectRestoreCards, type SessionManagerLike } from "./jobs.ts";
import {
  RETIRED_STATES,
  TMUX,
  SESSION_STATUS_DIR,
  buildRows,
  computeStartupFingerprint,
  createTmuxSession,
  isKnownState,
  isPiTuiPatched,
  livePiPids,
  readLayout,
  readSessions,
  tmuxError,
  tmuxLaunchEnv,
  tmuxSessionExists,
  writeClientSize,
  NORMAL_AGENT_DIR,
  PI_BIN,
  LAYOUT_FILE,
  type ClientSize,
  type DashboardEntry,
  type Layout,
  type OrphanRow,
  type Row,
  type SessionRow,
  type SessionStatusFile,
  type SubagentStatus,
  type TitleState,
  type TmuxSession,
} from "./fleet.ts";

const REFRESH_MS = 1000;
/** Ticks of REFRESH_MS between a full data refresh (ps, tmux list-sessions,
 * any git-status cache misses) while nothing on the fleet is actively
 * changing. The render tick itself stays at REFRESH_MS regardless — elapsed-
 * time labels ('3m ago') are computed at render time from stored timestamps,
 * so they keep advancing smoothly even on a tick that skips the data pull —
 * only the underlying ps/tmux/git work slows down. Worth doing even after
 * targeting ps -p at just the tracked pids (see livePiPids): most of a long
 * session's wall-clock time, with 13+ concurrent sessions, has at most one or
 * two "working" at once, so the fixed per-tick cost was being paid every
 * second for a fleet that was not changing every second. 4 ticks is a
 * deliberately small multiplier — worst case an idle session's death takes 4s
 * longer to notice than before, which is a fine trade next to a 4x cut in
 * background churn during the (common) stretches when nothing is happening. */
const IDLE_REFRESH_TICKS = 4;
const MESSAGE_LINGER_MS = 4000;

type HubAction =
  | { type: "attach"; tmuxName: string; expectedPid?: number }
  | { type: "create"; name: string; dir: string; size?: ClientSize }
  // Dispatch differs from create in exactly one way that matters to the hub
  // loop: it does NOT hand the terminal to tmux. The session is created and
  // handed a task, and the user stays on the dashboard watching it work.
  | { type: "dispatch"; name: string; dir: string; task: string; size?: ClientSize };

/**
 * Liveness verified by *identity*, not mere existence.
 *
 * `process.kill(pid, 0)` only proves some process holds that pid — not that it
 * is ours. Sessions killed with `tmux kill-session` never run their shutdown
 * hook, so their status file survives; the OS later recycles that pid onto an
 * unrelated process and the dead row springs back to life claiming to run.
 * Observed directly: a finished session's file reported ALIVE on pid 2304
 * after the pid had been reused.
 *
 * Targeted at exactly the pids the caller already knows about (from status
 * files it just read), via `ps -p`, rather than scanning every process on the
 * machine. Measured on this machine: 20ms for `-eo` against 624 processes,
 * 1.5ms for `-p` against a handful of known pids — the scan was paying for
 * every OTHER process on the system to answer a question about a known,
 * small set. Empty input returns immediately without spawning anything.
 *
 * `ps -p` with NONE of the requested pids alive exits 1 with empty stdout —
 * verified live, and a completely normal result (every tracked session just
 * crashed), not a sign ps itself is broken. That is why failure is judged by
 * `res.error` (spawn could not even start the process — genuinely unknown,
 * e.g. ps missing or unreadable) rather than by exit code, which for `-p` — 
 * unlike the old `-eo` scan, where any nonzero exit really was suspicious —
 * conflates "zero matches" with "broken" if trusted the same way.
 *
 * pids are bounds-checked before being handed to ps: nothing validates what a
 * status file contains, and one corrupted pid value in an unfiltered `-p`
 * list makes ps reject the ENTIRE query ("process id too large"), which would
 * fail identity verification for every OTHER session in the same call —
 * observed directly while building this. A pid that fails the sanity check is
 * simply left out of the query and therefore absent from the result, which is
 * the correct answer anyway: no real process has a pid shaped like that.
 */

/* -------------------------------------------------------------- layout -- */
/** Pins and manual ordering. Deliberately NOT stored in the status files:
 * those are written by each session's own process, and the dashboard writing
 * into them would put two processes on one file. This is a dashboard concern,
 * so the dashboard owns the file. */
/** lastSelected is the session id the cursor sat on when the dashboard was
 * last closed — restored on the next open so leaving a session and coming
 * back does not reset you to the top of the list. Not a strong preference
 * like pin/order: a stale id (its card was since dismissed) just fails the
 * lookup and falls back to row 0, same as never having one. */
/** names: sessionId -> the display name the dashboard's own rename composer
 * set. This is the source of truth for a renamed row's label, not a cache of
 * it. Renaming used to work by sending `/name <newName>` into the pane so Pi
 * would rewrite its OWN status file with the new name for the dashboard to
 * later read back — verified live (sandboxed session, PI_KING_STATUS_DIR)
 * that this is broken in a specific way: `/name` updates Pi's in-session
 * state immediately (its own title bar and composer footer change right
 * away), but that state is only serialized into the status file on the
 * SESSION'S OWN NEXT UNRELATED ACTIVITY WRITE, not on `/name` itself — a
 * session renamed and then left alone (never given another prompt) shows
 * the stale pre-rename name forever. Same failure class as the pid-token
 * comment two sections up: trusting a second process's own timing for a
 * value this dashboard can just own outright. `/name` is still sent (kept
 * below in renameTmuxSession) so Pi's own UI stays in sync too, but it is
/** Records which boot generation reboot recovery has already run for, so a
 * second dashboard opened moments after the first does not race it into
 * resuming the same transcript twice — see restoreRebootOrphans. */
const REBOOT_RECOVERY_FILE = join(SESSION_STATUS_DIR, "..", "reboot-recovery.json");

function writeLayout(l: Layout): void {
  try {
    mkdirSync(dirname(LAYOUT_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${LAYOUT_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(l, null, 2), { mode: 0o600 });
    renameSync(tmp, LAYOUT_FILE);
  } catch {
    // Ordering is a preference, not state. Losing it must never break a view.
  }
}


/** Content-digest cache: path -> {mtimeMs, ctimeMs, size, digest}. A file is
 * only re-read when its mtime, ctime, or size changed; every other read of
 * the same startup input is a stat() plus a map hit. This is what keeps the
 * per-refresh cost of fingerprinting a whole fleet bounded by how many
 * startup inputs actually changed, instead of re-reading every file every
 * second. ctimeMs is load-bearing, not belt-and-suspenders: mtime+size alone
 * miss a same-size write that preserves its own mtime (a tool rewriting a
 * file in place with -p), which would leave the cached digest stale and
 * fingerprint a file as unchanged when it changed — a false negative. ctime
 * changes on any inode update, including one that preserves mtime and size.
 * A file that disappears (or fails to stat) has no cache entry and
 * contributes nothing to the fingerprint — absent and unreadable are the
 * same "not loaded" fact. */


/** Full startup restart of the pi process inside an existing tmux pane, in
 * place: `tmux respawn-pane -k` kills the pane's current process and starts
 * the new one under the same session name, same directory, same env — no
 * new tmux session, no shell, and critically no text injected into the pane
 * (unlike sending /reload, which is what this replaces for startup-only
 * changes: /reload re-imports extensions/skills/prompts but does NOT re-run
 * startup pi.registerProvider() calls, model-scope construction, or
 * OmniRoute routing). Resuming the SAME session id keeps the transcript
 * history: the new process continues the same JSONL file.
 *
 * Sandbox-proven: respawning a settled session yields a new pid, the same
 * sessionId and sessionFile on the card, and a subsequent prompt works.
 * Known ceiling, stated rather than hidden: an unsent draft in the editor of
 * an otherwise-settled session is lost — the dashboard cannot inspect a
 * remote editor. Accepted trade (Option A) for headless fleet sessions. */
export function restartTmuxPane(name: string, dir: string, sessionId: string): { ok: boolean; message: string } {
  // pi --session <id> fails with "No session found matching" when the
  // transcript JSONL does not exist yet — a session that has never received
  // a prompt has no JSONL. respawn-pane -k kills the pane's current process
  // BEFORE the new pi starts, so firing into that state would kill a live
  // session and fail to bring it back, taking the whole tmux session down
  // with it (observed live). Verify resumability from the card before
  // touching the pane: no card, or a card whose sessionFile is missing,
  // means "nothing to resume" — skip, keep the live process.
  try {
    const card = JSON.parse(readFileSync(join(SESSION_STATUS_DIR, `${sessionId}.json`), "utf8")) as { sessionFile?: string };
    if (typeof card.sessionFile !== "string" || !existsSync(card.sessionFile)) {
      return { ok: false, message: `"${name}" has no transcript yet — nothing to resume, left running.` };
    }
  } catch {
    return { ok: false, message: `"${name}" has no status card — cannot restart.` };
  }
  const result = spawnSync(TMUX, [
    "respawn-pane", "-k", "-t", `=${name}:0.0`,
    "-c", dir,
    "-e", `PI_CODING_AGENT_DIR=${NORMAL_AGENT_DIR}`,
    ...tmuxLaunchEnv(),
    "--", PI_BIN, "--name", name, "--session", sessionId,
  ], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return { ok: false, message: `Failed to restart "${name}": ${tmuxError(result)}` };
  return { ok: true, message: `Restarted "${name}" in ${dir}.` };
}

/** Seconds since the epoch this machine last booted, or undefined when it
 * cannot be determined — macOS only; anything else degrades to "reboot
 * recovery does not engage" rather than guessing. `sysctl -n kern.boottime`
 * prints `{ sec = 1785800818, usec = 776947 } Tue Aug  4 06:46:58 2026`. */
function bootTimeSec(): number | undefined {
  const r = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 2000 });
  if (r.status !== 0 || !r.stdout) return undefined;
  const m = /sec\s*=\s*(\d+)/.exec(r.stdout);
  return m ? Number(m[1]) : undefined;
}

/** How long after boot a card's last write can still count as "killed by this
 * reboot" rather than "already exited for an unrelated reason, long before
 * today". Generous margin for a slow shutdown sequence; measured on a real
 * restart the actual gap was 33s. */
const REBOOT_WINDOW_SEC = 600;

/**
 * Recreates every card that stopped existing at the same moment the machine
 * did, so opening the dashboard after a restart looks like nothing happened
 * rather than presenting thirteen cards to individually resume.
 *
 * The signal is proximity to boot, not the on-disk status field. A plain
 * Restart from the Apple menu gives running processes a SIGTERM before the new
 * boot completes, and this project's own shutdown hook catches that and
 * writes status:"exited" cleanly — verified live: every card here was
 * exited exactly 33s before this machine's own boot time. A hard power-cut
 * or `kill -9` skips that hook entirely, leaving whatever status was current
 * (idle, working) on disk. Both are "the machine ended this", and both look
 * identical under one test: the pid is confirmably dead AND the card's last
 * write falls in a short window immediately before boot. A card that has
 * simply been sitting exited for hours or days, unrelated to today's reboot,
 * fails that proximity test regardless of what its status field says, and is
 * left exactly as the user left it — this function only ever restores what
 * the reboot itself took.
 *
 * Guarded by a marker file, not just an in-memory flag: two dashboards opened
 * within the same boot (this hub, plus any tracked session with the overlay
 * bound to a key) would otherwise both see the same pre-restore state and
 * could both resume the same session id onto two live processes — the one
 * outcome this project must never cause. The marker is written before the
 * restore work runs, not after, to keep that window as small as possible.
 * ponytail: not a true lock (two processes could still both pass the read in
 * the same instant); acceptable because it requires two hub-opening
 * processes launched within milliseconds of each other, which does not
 * happen from a human clicking around a terminal. A real flock would close
 * it fully if this ever becomes a real collision.
 */
export function restoreRebootOrphans(): { restored: number; failed: number } {
  const boot = bootTimeSec();
  if (boot === undefined) return { restored: 0, failed: 0 };

  try {
    const marker = JSON.parse(readFileSync(REBOOT_RECOVERY_FILE, "utf8")) as { bootSec?: number };
    if (marker.bootSec === boot) return { restored: 0, failed: 0 }; // this boot already handled
  } catch { /* no marker yet, or unreadable: proceed */ }
  try {
    mkdirSync(dirname(REBOOT_RECOVERY_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(REBOOT_RECOVERY_FILE, JSON.stringify({ bootSec: boot }), { mode: 0o600 });
  } catch { return { restored: 0, failed: 0 }; } // cannot claim the marker: do not risk a double-resume

  let files: string[];
  try { files = readdirSync(SESSION_STATUS_DIR).filter((f) => f.endsWith(".json")); }
  catch { return { restored: 0, failed: 0 }; }
  // Same two-pass shape as readSessions(): the pid list has to be known before
  // livePiPids() is called, so every file is parsed once up front.
  const parsed: SessionStatusFile[] = [];
  for (const file of files) {
    try { parsed.push(JSON.parse(readFileSync(join(SESSION_STATUS_DIR, file), "utf8")) as SessionStatusFile); }
    catch { /* rare write race; skip, resolves next run */ }
  }
  const live = livePiPids(parsed.map((raw) => raw.pid));
  if (live === undefined) return { restored: 0, failed: 0 }; // ps unavailable: do not guess at liveness

  let restored = 0;
  let failed = 0;
  for (const raw of parsed) {
    if (!raw.visible || !raw.lastActivity) continue;
    const ageBeforeBoot = boot - raw.lastActivity / 1000;
    if (ageBeforeBoot < 0 || ageBeforeBoot > REBOOT_WINDOW_SEC) continue; // not this reboot's doing
    // Same identity check as everywhere else in this file: a recycled pid must
    // never be mistaken for the original process still running.
    const procStart = live.get(raw.pid);
    const identityMismatch = procStart !== undefined && raw.startedAt > 0 && Math.abs(procStart - raw.startedAt) > 60_000;
    if (procStart !== undefined && !identityMismatch) continue; // genuinely still alive: leave it alone
    if (!existsSync(raw.cwd)) { failed++; continue; }
    const base = (raw.name ?? raw.project ?? "").trim() || raw.id.slice(0, 8);
    let result = createTmuxSession(base, raw.cwd, raw.id);
    if (!result.ok) result = createTmuxSession(`${base}-${raw.id.slice(0, 8)}`, raw.cwd, raw.id);
    if (result.ok) restored++; else failed++;
  }
  return { restored, failed };
}


/** The detached hub daemon moved out of this process entirely (2026-08-10):
 * see scripts/hub-daemon.ts, wired through bin/pi-king --daemon. It shares
 * fleet.ts and jobs.ts with the dashboard below; nothing here builds it. */

/** True when it is safe to type text into this session's live pane right
 * now: the main agent is not mid-turn, AND no subagent behind it is running
 * or queued either. Broader than "state === idle" on purpose -- attention
 * and error both mean the main agent has already stopped and the prompt is
 * empty and waiting, exactly like idle, just flagged for a different
 * reason; "working" is the only state where text typed now would land
 * inside an in-flight response. Subagents are checked directly rather than
 * trusted to "background" state naming them correctly in every case: this
 * gates literal send-keys text injection into a live process, and getting
 * it wrong risks corrupting a real session's input, not just a rendering
 * glitch. Shared by every send-keys call site (rename, reload, immediate
 * and queued) so the rule only needs to be right in one place. */
function isSettled(entry: DashboardEntry): boolean {
  return entry.state !== "working" &&
    !entry.subagents.some((s) => s.status === "running" || s.status === "queued");
}

/** tmux name -> desired Pi session name, applied once that session goes idle.
 * send-keys types into the live pane, so it must never fire mid-turn. */
const pendingRenames = new Map<string, string>();

/** Applies any queued rename whose session has since settled. Called on refresh. */
function flushPendingRenames(rows: Row[]): void {
  if (pendingRenames.size === 0) return;
  for (const [tmuxName, desired] of [...pendingRenames]) {
    const row = rows.find((r) => r.kind === "session" && r.entry.tmuxName === tmuxName);
    // Gone, not just unsettled — the session exited (or its tmux pane did)
    // before ever going idle. Nothing will ever match this tmuxName again, so
    // leaving it queued was a permanent leak: found live, still growing
    // slowly for the life of this dashboard process, one entry per rename
    // that happened to land on a session that then exited before settling.
    // Caught reviewing the analogous reload queue below, same bug, same fix.
    if (!row || row.kind !== "session") { pendingRenames.delete(tmuxName); continue; }
    if (!isSettled(row.entry)) continue;
    spawnSync(TMUX, ["send-keys", "-t", tmuxName, `/name ${clean(desired)}`, "Enter"], { encoding: "utf8", timeout: 3000 });
    pendingRenames.delete(tmuxName);
  }
}

/** sessionId -> queued for a full process restart (respawn-pane) once
 * settled. Keyed by session id, not tmux name: session id survives a rename
 * that might happen to the same session while a restart is still queued
 * behind it. A respawn does not type into the pane (unlike the /reload this
 * replaces), but killing a mid-turn process still loses whatever it was
 * doing, so it must never fire mid-turn — same invariant as pendingRenames. */
const pendingRestarts = new Set<string>();

/** sessionId -> pid observed when the restart was fired. Cleared once the
 * card shows a different pid (the successor process has claimed the file) or
 * the row disappears entirely — this is what stops a second `r` from
 * respawning a session that is already mid-restart: between firing
 * respawn-pane and the new process's first status write the card still shows
 * the OLD pid and the OLD fingerprint, so without this guard a refresh would
 * judge it "still stale, fire again" and kill the just-started successor. */
const restartingSessions = new Map<string, number>();

/** Applies any queued restart whose session has since settled. Called on
 * refresh, same as flushPendingRenames, and shares its three failure modes
 * by construction rather than by parallel maintenance:
 *   - gone: pruned, not left to leak.
 *   - already fresh: re-checks entry.restartNeeded at FIRE time, not queue
 *     time — rows is rebuilt fresh every refresh(), so a session restarted
 *     some other way already shows restartNeeded:false here, and the queued
 *     fire is skipped as a no-op rather than sent redundantly.
 *   - still busy: left queued, tried again next cycle.
 * A restart failure (tmux refused, directory gone) also prunes: a broken
 * config must not loop-respawn forever — the card keeps its restartNeeded
 * badge, so the user still sees it needs a restart and can retry with r. */
function flushPendingRestarts(rows: Row[]): void {
  if (pendingRestarts.size === 0) return;
  for (const id of [...pendingRestarts]) {
    const row = rows.find((r) => r.kind === "session" && r.entry.sessionId === id);
    if (!row || row.kind !== "session") { pendingRestarts.delete(id); continue; }
    if (!row.entry.restartNeeded) { pendingRestarts.delete(id); continue; }
    if (!isSettled(row.entry)) continue;
    const tmuxName = row.entry.tmuxName;
    if (!tmuxName) { pendingRestarts.delete(id); continue; }
    const result = restartTmuxPane(tmuxName, row.entry.cwd, row.entry.sessionId);
    if (result.ok) restartingSessions.set(id, row.entry.pid);
    pendingRestarts.delete(id);
  }
}

/** Clears restartingSessions entries whose successor has acknowledged itself.
 * Called on refresh ahead of flushPendingRestarts so a completed restart is no
 * longer in-flight when the queued sweep runs. "Acknowledged" is stricter
 * than "pid changed": the new process publishes its pid and its fingerprint
 * in one session_start persist, so a card whose pid changed but whose
 * fingerprint still disagrees (or is absent) has not finished initializing —
 * clearing on pid alone would let a second `r` kill the half-started
 * successor (Red review, risk #2). Row gone entirely = the restart failed and
 * took the tmux session with it; clear so the card renders exited instead of
 * hanging in "restarting" forever. */
function pruneRestarting(rows: Row[]): void {
  if (restartingSessions.size === 0) return;
  for (const [id, oldPid] of [...restartingSessions]) {
    const row = rows.find((r) => r.kind === "session" && r.entry.sessionId === id);
    if (!row || row.kind !== "session") { restartingSessions.delete(id); continue; }
    if (row.entry.pid !== oldPid && !row.entry.restartNeeded) restartingSessions.delete(id);
  }
}

function renameTmuxSession(oldName: string, newName: string, settled: boolean, sessionId: string | undefined): { ok: boolean; message: string } {
  const result = spawnSync(TMUX, ["rename-session", "-t", oldName, newName], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) return { ok: false, message: `Failed to rename: ${tmuxError(result)}` };

  // The label's correctness lives here, not in the /name call below. See the
  // Layout.names comment: /name's effect on Pi's own status file is delayed
  // until that session's next unrelated activity, sometimes indefinitely, so
  // it cannot be what a rename's success depends on. Written immediately,
  // synchronously, before this function returns — the row is correct on the
  // very next render, not eventually. sessionId is undefined for an orphan
  // (a tmux pane with no Pi session behind it, so no status-file name to
  // override in the first place, and rowLabel() reads row.tmux.name for
  // those directly).
  if (sessionId) {
    const layout = readLayout();
    writeLayout({ ...layout, names: { ...layout.names, [sessionId]: newName } });
  }

  // Also rename the Pi session living inside it, via Pi's own /name command.
  // Best-effort now, not load-bearing: this keeps Pi's OWN in-session state
  // (its title bar, its composer footer) in sync with the dashboard's choice,
  // but the row's label above no longer waits on it.
  //
  // Only when that session is settled at its prompt: send-keys types into the
  // live pane, and injecting text mid-turn would land in an in-flight prompt.
  if (settled) {
    spawnSync(TMUX, ["send-keys", "-t", newName, `/name ${clean(newName)}`, "Enter"], { encoding: "utf8", timeout: 3000 });
    return { ok: true, message: `Renamed to "${newName}".` };
  }
  // Busy: queue the Pi-side nicety rather than dropping it. It applies
  // automatically once the session settles.
  pendingRenames.set(newName, newName);
  return { ok: true, message: `Renamed to "${newName}" \u2014 session is busy; its own name will follow once it settles.` };
}

/** Frees any client attached to a session without ending it. The Pi process
 * keeps running and the session stays listed; this is the safe counterpart to
 * killing, for when you only want the terminal back. */
function detachTmuxSession(name: string): { ok: boolean; message: string } {
  const attached = spawnSync(TMUX, ["display-message", "-p", "-t", name, "#{session_attached}"], { encoding: "utf8", timeout: 3000 });
  const count = Number(String(attached.stdout || "").trim()) || 0;
  if (count === 0) {
    return { ok: true, message: `"${name}" has no attached client — it is already running unattended.` };
  }
  const result = spawnSync(TMUX, ["detach-client", "-s", name], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) return { ok: false, message: `Failed to detach: ${tmuxError(result)}` };
  return { ok: true, message: `Detached ${count} client${count === 1 ? "" : "s"} from "${name}". Still running.` };
}

function killTmuxSession(name: string): { ok: boolean; message: string } {
  const result = spawnSync(TMUX, ["kill-session", "-t", name], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) return { ok: false, message: `Failed to delete: ${tmuxError(result)}` };
  return { ok: true, message: `Killed "${name}". Its card stays; select it and press enter to resume.` };
}

/**
 * Hands a chosen action back to the `pi-king` wrapper script, which runs the
 * actual tmux command *after this process has fully exited*.
 *
 * This indirection is load-bearing, not ceremony. The original implementation
 * spawned `tmux attach-session` as a child with `stdio: "inherit"` while Pi's
 * own TUI was still live — which left two processes (Pi's TUI event loop and
 * the tmux client) concurrently reading the same terminal stdin and writing
 * the same stdout. Keystrokes were split nondeterministically between them and
 * terminal-mode state was fought over, which is what actually produced the
 * "server exited unexpectedly" client death on a keypress. Pi exposes no API
 * to suspend/release its TUI mid-session (verified — no suspend/releaseTerminal
 * in the extension or interactive-mode surface), so the only correct fix is to
 * ensure exactly one process owns the terminal at a time: Pi writes the action
 * and exits; the wrapper then execs tmux with the terminal entirely to itself;
 * when tmux detaches, the wrapper relaunches the hub.
 */
function requestWrapperAction(action: HubAction): boolean {
  const target = process.env.PI_KING_ACTION_FILE;
  if (!target) return false;
  try {
    // First line: the RAW tmux session name, never JSON-escaped. The wrapper
    // reads exactly this line; a JSON-escaped name breaks sed extraction — a
    // quote inside the name arrives as \" and the old sed stopped at that
    // first quote, leaving a stray backslash as the attach target (observed
    // live as `can't find session: \`). tmux rejects control characters in
    // session names, so a single raw line is unambiguous. The JSON stays on
    // line two for any future consumer that wants the full action.
    const tmuxName = action.type === "attach" ? action.tmuxName : "";
    writeFileSync(target, `${tmuxName}\n${JSON.stringify(action)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort "jump to the terminal tab running this session".
 *
 * This is the only platform-specific code in pi-king, and it is strictly a
 * convenience for sessions that are NOT tmux-backed. It is feature-detected
 * and degrades to a message that points at the real fix (/bg), so a user on
 * Linux, or in any terminal but Ghostty, loses a nicety rather than hitting an
 * error.
 *
 * Ghostty is used because it exposes a real AppleScript object model; its own
 * tab bar is invisible to the accessibility tree, so generic UI scripting
 * cannot see tabs at all. `tab.title` is broken in Ghostty 1.3.1 (raises
 * -1700), hence matching on `terminal.name` instead.
 */
function jumpSupported(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    statSync("/Applications/Ghostty.app");
    statSync("/usr/bin/osascript");
    return true;
  } catch {
    return false;
  }
}

function jumpToGhosttyTab(shortId: string): { ok: boolean; message: string } {
  if (!jumpSupported()) {
    return {
      ok: false,
      message: "Jump-to-tab needs macOS + Ghostty. Run /bg in that session to make it attachable from here instead.",
    };
  }
  const marker = `#${shortId}`;
  const script = `
tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      try
        set term to terminal 1 of t
        if (name of term) contains "${marker}" then
          select tab t
          activate window w
          return "matched"
        end if
      end try
    end repeat
  end repeat
  return "not-found"
end tell`;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8", timeout: 5000 });
  } catch (err) {
    return { ok: false, message: `Could not run osascript: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (result.error) return { ok: false, message: `osascript error: ${result.error.message}` };
  if (result.status !== 0) return { ok: false, message: String(result.stderr || "osascript exited non-zero").trim() };
  return String(result.stdout || "").trim() === "matched"
    ? { ok: true, message: "Switched to that session's tab." }
    : { ok: false, message: "Tab not found \u2014 it may have been closed. Run /bg there to make it attachable." };
}

function subagentSummary(subagents: SubagentStatus[]): string {
  if (subagents.length === 0) return "";
  const running = subagents.filter((s) => s.status === "running" || s.status === "queued").length;
  const done = subagents.filter((s) => s.status === "completed").length;
  const failed = subagents.filter((s) => s.status === "failed").length;
  const parts: string[] = [];
  if (running > 0) parts.push(`🤖${running} running`);
  if (failed > 0) parts.push(`✗${failed}`);
  if (done > 0) parts.push(`✓${done}`);
  return parts.join(" ");
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** Wall-clock span between two timestamps (for durations, unlike elapsed). */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function clockLine(): string {
  const d = new Date();
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} · ${time}`;
}

/** One-line usage ticker, colour-coded by meaning rather than decoration:
 * error rate takes its colour from a threshold (so a bad number is visible
 * without reading it), and the top three models get descending emphasis so
 * rank is legible at a glance. An empty today says so in words and still
 * shows the history — a fresh morning used to blank the whole band, hiding a
 * week of figures that exist regardless of whether today has started. "0
 * calls" is still never printed: absence of logs is not a measurement. */
function tickerParts(th: Theme, stats: UsageStats | undefined, daily: DayTotal[], loaded: boolean, budget = Infinity): string | undefined {
  if (!loaded) return th.fg("dim", "\u2026");
  if (!stats && daily.length < 3) return undefined;
  const modelColors = ["accent", "success", "muted"] as const;

  const segs: string[] = [];
  if (!stats) segs.push(th.fg("dim", "no calls yet today"));
  if (stats) {
    const rate = stats.calls > 0 ? (stats.errors / stats.calls) * 100 : 0;
    // Thresholds: <2% routine, <5% worth noticing, above that is a problem.
    const rateColor = rate < 2 ? "success" : rate < 5 ? "warning" : "error";
    segs.push(
      th.fg("accent", th.bold(stats.calls.toLocaleString())) + th.fg("dim", " calls today"),
      th.fg(rateColor, `${stats.errors} err`) + th.fg("dim", ` (${rate.toFixed(1)}%)`),
    );
    // The rest of the band is day-cumulative, which reads the same at a busy
    // noon and a dead midnight. The trailing hour is the "now" signal. A zero
    // here is a measurement — the whole day's logs were scanned and none fell
    // in the window — so quiet is stated, not hidden.
    segs.push(stats.lastHour.calls > 0
      ? th.fg("dim", "1h ") + th.fg("accent", String(stats.lastHour.calls)) +
        th.fg("dim", " calls \u00b7 ") + th.fg("accent", compactNum(stats.lastHour.tokensIn)) + th.fg("dim", " in")
      : th.fg("dim", "1h quiet"));
    // Which part of the day carried the traffic, in four coarse buckets
    // (morning/afternoon/evening/night) rather than a raw hour count — "peak
    // 585/h" answers a question nobody asked; "busiest afternoon" answers the
    // one people actually have (when am I busiest). Replaces the old per-hour
    // sparkline, which packed the same shape into less legible ground.
    if (stats.peakPeriod) {
      segs.push(th.fg("dim", "busiest ") + th.fg("accent", stats.peakPeriod.label) +
        th.fg("dim", ` ${stats.peakPeriod.pct}%`));
    }
  }
  // Daily NET-token history — cache re-reads excluded, so a chatty week of
  // re-sent history doesn't flatten the shape of how much new ground was
  // actually covered each day. Lives outside the `if (stats)` block on
  // purpose: history renders even on a fresh morning with zero calls yet.
  // When today has data it is the last bar and is dimmed — a partial day
  // ranked against completed ones is a false signal. When today is empty it
  // is absent from the series, so every bar is a completed day.
  if (daily.length >= 3) {
    const bars = sparkline(daily.map((d) => netTokens(d.tokensIn, d.tokensCacheRead)));
    if (bars) {
      segs.push(th.fg("dim", `${daily.length}d `) + (stats
        ? th.fg("accent", bars.slice(0, -1)) + th.fg("muted", bars.slice(-1))
        : th.fg("accent", bars)));
    }
  }
  // Order matters: shedding drops from the end, so these sit ahead of the model
  // mix. Token volume and cache share survive a narrow terminal; which model
  // served them is the first thing worth losing.
  if (stats && (stats.tokensIn > 0 || stats.tokensOut > 0)) {
    // out/in: rising share means the agents are generating more than they are
    // reading, which is the difference between writing code and combing through
    // a repository. Both numbers are already here; the ratio is what is read.
    const outShare = stats.tokensIn > 0 ? (stats.tokensOut / stats.tokensIn) * 100 : 0;
    // Net is input with cache reads taken out: the text actually sent fresh
    // this session rather than the history re-sent on every turn. On a long
    // day the two differ by an order of magnitude, and net is the one that
    // tracks how much new ground was covered.
    const net = netTokens(stats.tokensIn, stats.tokensCacheRead);
    // Every neighbouring segment names its own window ("calls today", "7d"):
    // this was the one silent one, sitting between them, and read as
    // ambiguous — all-time or today? It is today only, same as the rest of
    // the band; readUsageStats() scans exactly one day's directory and never
    // touches the others. Made explicit rather than inferred from position.
    segs.push(
      th.fg("dim", "tok today: in ") + th.fg("accent", compactNum(stats.tokensIn)) +
      th.fg("dim", " \u00b7 out ") + th.fg("accent", compactNum(stats.tokensOut)) +
      th.fg("dim", " \u00b7 net ") + th.fg("accent", compactNum(net)) +
      th.fg("dim", ` (${outShare < 1 ? outShare.toFixed(1) : Math.round(outShare)}% out)`),
    );
  }
  // Today's most-used model, no share number: the ticker already spent its
  // percentages on error rate and busiest period, and "which model" is
  // answered completely by the name alone — the runner-up's share never
  // changed what anyone did next either, which is why only the leader ever
  // showed up here at all.
  const lead = stats?.topModels[0];
  if (lead) segs.push(th.fg("dim", "favorite ") + th.fg(modelColors[0], lead.model));
  // Mean over COMPLETED days only. Including a partial today drags the
  // average down by however much of the day is left.
  if (daily.length >= 3) {
    const done = stats ? daily.slice(0, -1) : daily;
    if (done.length >= 2) {
      const mean = done.reduce((sum, d) => sum + d.tokensIn, 0) / done.length;
      segs.push(th.fg("dim", "avg ") + th.fg("accent", compactNum(Math.round(mean))) + th.fg("dim", "/day"));
    }
  }
  if (stats?.partial) segs.push(th.fg("warning", "(partial)"));
  // p95 goes dead last, on purpose: it is the first segment dropped when the
  // row does not fit. Tail latency is real but the least actionable figure
  // next to what's ahead of it in the band — volume, errors, when you're
  // busiest, cache economics — worth showing, not worth the room to protect.
  const p95 = stats && stats.durations.length > 0
    ? stats.durations[Math.min(stats.durations.length - 1, Math.floor(stats.durations.length * 0.95))]
    : 0;
  if (p95 > 0) {
    segs.push(th.fg("dim", "p95 ") + th.fg(p95 > 30_000 ? "warning" : "accent", `${(p95 / 1000).toFixed(1)}s`));
  }
  // The band shares its row with a right-flushed clock. If the segments overrun
  // the space left for it, the clock is pushed past the terminal edge and
  // silently truncated, so shed the least important segments (p95 first, see
  // above) until what remains fits.
  const joiner = th.fg("dim", "  │  ");
  while (segs.length > 1 && visibleWidth(segs.join(joiner)) > budget) segs.pop();
  return segs.join(joiner);
}

class Composer {
  readonly input: Input;
  constructor(prefill: string, private onSubmit: (value: string) => void, private onCancel: () => void) {
    this.input = new Input();
    this.input.focused = true;
    // pi-tui marks these private in its declarations but assigns them at
    // runtime; there is no public setter for an initial value.
    const editable = this.input as unknown as { value: string; cursor: number };
    editable.value = prefill;
    editable.cursor = prefill.length;
    this.input.onSubmit = (value: string) => this.onSubmit(value.trim());
    this.input.onEscape = () => this.onCancel();
  }
}

type ComposerStep =
  | { kind: "new-name" }
  | { kind: "new-dir"; name: string }
  // Task first, so the name step can prefill a slug guessed from it. The name
  // step is kept rather than auto-naming: Stanley names sessions himself for
  // "a more clear directory naming and to avoid confusion", so the slug is a
  // default to type over, not a decision.
  | { kind: "dispatch-task" }
  | { kind: "dispatch-name"; task: string }
  | { kind: "dispatch-dir"; task: string; name: string }
  | { kind: "rename"; row: SessionRow | OrphanRow };

class DashboardView implements Component {
  private rows: Row[] = [];
  private selected = 0;
  /** The stats screen replaces the session list rather than sitting under it:
   * both are full-height, and stacking them would push one off the terminal. */
  private showStats = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticksSinceRefresh = 0;
  private messageTimer: ReturnType<typeof setTimeout> | undefined;
  private message: string | undefined;
  private deleteArmedFor: string | undefined;
  private composer: Composer | undefined;
  private composerStep: ComposerStep | undefined;
  /** Usage stats: 60s TTL, refreshed off the render path so first paint and
   * navigation are never blocked by the ~0.5s aggregation. */
  private statsCache = new StatsCache(() => this.tui.requestRender());
  /** Snapshot taken once at open — static between config edits, so no TTL. */
  private inventory: Inventory | undefined;
  /** Landing-page fallback when nothing is backgrounded. */
  private recent: RecentProject[] = [];
  /** Stable for the whole day; resolved once at open. */
  private quote = quoteOfTheDay();
  /** Offload-job markers: polling lives on the existing REFRESH_MS tick (one
   * cadence, no second timer), the panel replaces the session body while
   * open, and /jobs parity in the hub routes through the same instance. */
  private jobs: JobsPanel;
  /** Checked once at open, not per-render — a pi upgrade silently wiping the
   * Fix 2 patch (docs/PERF-TMUX-SPEC.md) is a rare, deliberate event; the
   * user just needs to notice on the next dashboard open, not mid-session. */
  private piTuiUnpatched = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private done: (result: HubAction | undefined) => void,
    sessionManager: SessionManagerLike,
    private invocationCwd: string,
    initialMessage?: string,
    /** macOS fallback notification: the dashboard's detached-in-tmux osascript
     * helper, bound to the live ExtensionContext by showDashboardInner. */
    notifyFallback?: (body: string) => void,
  ) {
    this.jobs = new JobsPanel(sessionManager, invocationCwd, notifyFallback);
    this.refresh();
    // Restores the cursor to wherever it was left last time, rather than
    // always opening on row 0 — leaving "Homelab Setup" and coming straight
    // back should put the cursor back on Homelab Setup, not reset to the top
    // of the pinned section. A dismissed or since-vanished card's id simply
    // fails this lookup and falls back to row 0, which is exactly the old
    // behaviour, so there is no failure mode here worse than doing nothing.
    const lastId = readLayout().lastSelected;
    if (lastId) {
      const idx = this.rows.findIndex((r) => r.kind === "session" && r.entry.sessionId === lastId);
      if (idx >= 0) this.selected = idx;
    }
    if (initialMessage) this.showMessage(initialMessage);
    this.piTuiUnpatched = !isPiTuiPatched();
    // Both are cheap and static for the lifetime of the overlay: an inventory
    // snapshot (readdir + stat) and a recent-projects scan that reads only the
    // first 512 bytes of one transcript per project.
    try { this.inventory = readInventory(); } catch { this.inventory = undefined; }
    try { this.recent = readRecentProjects(8); } catch { this.recent = []; }
    this.timer = setInterval(() => {
      this.ticksSinceRefresh++;
      // Jobs poll on the SAME tick, unconditionally: completion detection is
      // bounded by REFRESH_MS even on an idle fleet where the heavier data
      // refresh below is throttled to every IDLE_REFRESH_TICKS. The scan is
      // a stat-cached readdir — cheap enough for 1s — and the panel's seen
      // set guarantees exactly one injection per marker per hub run.
      this.jobs.poll(Date.now(), () => this.rows);
      // Fast cadence (every tick) while a turn is actively streaming or a
      // subagent is running — the only states where a fresher read shows
      // something genuinely new. Everything else (idle, background,
      // attention, error, exited) is static until something external changes
      // it, so a slower cadence loses nothing but promptness in noticing that
      // change, bounded by IDLE_REFRESH_TICKS.
      const anyActive = this.rows.some((r) => r.kind === "session" &&
        (r.entry.state === "working" || r.entry.subagents.some((s) => s.status === "running" || s.status === "queued")));
      if (anyActive || this.ticksSinceRefresh >= IDLE_REFRESH_TICKS) {
        this.refresh();
        this.ticksSinceRefresh = 0;
      }
      this.tui.requestRender();
    }, REFRESH_MS);
  }

  /** Terminal size, fed in by the overlay each render cycle from the layout
   * engine's own visible(w,h) hook — the one place both dimensions are
   * known reliably, tmux or not (reading process.stdout.columns/rows
   * directly misses resizes on a multiplexed or piped stdout). Zero height
   * means "not known yet", which renders everything unwindowed — the
   * previous behaviour. Persisted (deduped, best-effort) so the headless
   * daemon and the next dashboard boot can spawn sessions close to this
   * size instead of tmux's 80x24 default — see fleet.ts's
   * resolveSpawnSize/CLIENT_SIZE_FILE. */
  private termWidth = 0;
  private termHeight = 0;
  setTermSize(w: number, h: number): void {
    if (Number.isFinite(h) && h > 0) this.termHeight = h;
    if (Number.isFinite(w) && w > 0) this.termWidth = w;
    if (this.termWidth > 0 && this.termHeight > 0) writeClientSize({ w: this.termWidth, h: this.termHeight });
  }
  /** The live client size this DashboardView is currently rendering at, for
   * any createTmuxSession call made from here — more current than the
   * persisted file within this same process. undefined before the first
   * render (falls through to fleet.ts's persisted-or-default tiers). */
  clientSize(): ClientSize | undefined {
    return this.termWidth > 0 && this.termHeight > 0 ? { w: this.termWidth, h: this.termHeight } : undefined;
  }

  private refresh(): void {
    this.rows = buildRows();
    flushPendingRenames(this.rows);
    pruneRestarting(this.rows);
    flushPendingRestarts(this.rows);
    if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
    if (this.jobs.selected >= this.jobs.list.length) this.jobs.selected = Math.max(0, this.jobs.list.length - 1);
    this.refreshGitDrift();
  }

  /** `r`: restart every session whose startup inputs changed, in one keypress,
   * without ever killing a pane mid-turn. Settled sessions (idle/background)
   * are respawned immediately; busy ones are queued and picked up
   * automatically by flushPendingRestarts on a later refresh, the moment they
   * settle — one press converges the whole fleet instead of firing once and
   * leaving whatever was busy to be caught manually later. A full restart
   * (not /reload) is required for startup-only changes: /reload re-imports
   * extensions/skills/prompts but does NOT re-run pi.registerProvider(),
   * model-scope construction, or OmniRoute routing. */
  private restartStaleSessions(): void {
    // Refresh BEFORE deciding, not just after: this.rows otherwise reflects
    // whatever the last periodic tick happened to see, which on an idle
    // fleet can be up to IDLE_REFRESH_TICKS old. A press landing in that
    // window would judge restartNeeded and settledness against stale data
    // and could act on nothing even though the badge on screen already shows
    // restartNeeded (the render loop reads live off this.rows too, so the
    // two would visibly disagree for a moment).
    this.refresh();
    let firedNow = 0;
    let queued = 0;
    for (const row of this.rows) {
      if (row.kind !== "session" || !row.entry.restartNeeded) continue;
      const tmuxName = row.entry.tmuxName;
      if (!tmuxName) continue; // no live pane to restart
      if (restartingSessions.has(row.entry.sessionId)) continue; // already in flight
      const settled = isSettled(row.entry);
      if (settled) {
        const result = restartTmuxPane(tmuxName, row.entry.cwd, row.entry.sessionId);
        if (result.ok) {
          restartingSessions.set(row.entry.sessionId, row.entry.pid);
          firedNow++;
        }
      } else {
        pendingRestarts.add(row.entry.sessionId);
        queued++;
      }
    }
    if (firedNow === 0 && queued === 0) this.showMessage("No sessions need restarting.");
    else this.showMessage(
      `Restarting ${firedNow} session${firedNow === 1 ? "" : "s"}` +
      (queued > 0 ? `, ${queued} queued — will restart once settled.` : "."),
    );
    this.tui.requestRender();
  }

  /** Uncommitted-change counts per project directory, refreshed lazily. A
   * returning user's second question after "what did it do" is "did it leave
   * work uncommitted", and the directory header is where that belongs. */
  private gitDrift = new Map<string, { n: number; at: number }>();
  /** Directories with a check in flight, so a slow git process (cold FS
   * cache, a monorepo) is never fired twice concurrently for the same dir
   * while a previous refresh() tick is still waiting on it. */
  private gitDriftInFlight = new Set<string>();
  /**
   * Async and fire-and-forget by design: this runs on the SAME timer as
   * keystroke handling (one Node event loop for the whole process), so a
   * synchronous git spawn here freezes typing and scrolling for as long as
   * git takes to answer. Measured live on this fleet: 11 project dirs, ~95ms
   * each, ~1.0s TOTAL for one serial spawnSync sweep -- and because every
   * directory's 10s cache entry is stamped in the same cold sweep, they
   * expire together, so that full-second freeze recurred roughly every 10s
   * for as long as any session was mid-turn (refresh() runs every tick, not
   * just the idle cadence, while anyActive). spawn() + a completion callback
   * keeps every check off the input path; results land whenever git answers
   * and requestRender() picks them up on the next paint, same as any other
   * async update in this file. */
  private refreshGitDrift(): void {
    const dirs = new Set<string>();
    for (const r of this.rows) if (r.kind === "session") dirs.add(r.entry.cwd);
    for (const dir of dirs) {
      const hit = this.gitDrift.get(dir);
      if (hit && Date.now() - hit.at < 10_000) continue;
      if (this.gitDriftInFlight.has(dir)) continue;
      this.gitDriftInFlight.add(dir);
      let out = "";
      let settled = false;
      const finish = (n: number) => {
        if (settled) return; // 'close' then 'error', or a timeout race -- only the first result counts
        settled = true;
        this.gitDriftInFlight.delete(dir);
        this.gitDrift.set(dir, { n, at: Date.now() });
        this.tui.requestRender();
      };
      try {
        const child = spawn("git", ["-C", dir, "status", "--porcelain"], { stdio: ["ignore", "pipe", "ignore"] });
        // Same 1500ms budget as the old spawnSync timeout, just not blocking
        // anything while it counts down.
        const killer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 1500);
        child.stdout?.on("data", (d) => { out += d; });
        child.on("error", () => { clearTimeout(killer); finish(-1); });
        child.on("close", (code) => {
          clearTimeout(killer);
          // Not a repo, or git unhappy: record the miss so it is not retried
          // every second, and render nothing rather than a guessed zero.
          finish(code === 0 ? out.split("\n").filter((l) => l.trim().length > 0).length : -1);
        });
      } catch {
        this.gitDriftInFlight.delete(dir);
        this.gitDrift.set(dir, { n: -1, at: Date.now() });
      }
    }
  }

  /** The only exit from this view, on every path — attach, resume, cancel.
   * Persists which row the cursor was on before handing control back, so the
   * next open can restore it. A no-op write when the row hasn't changed since
   * the last save, and silently skipped for an orphan row (no session id to
   * remember against). */
  private closeDashboard(result: HubAction | undefined): void {
    const row = this.rows[this.selected];
    if (row?.kind === "session") {
      const l = readLayout();
      if (l.lastSelected !== row.entry.sessionId) writeLayout({ ...l, lastSelected: row.entry.sessionId });
    }
    this.done(result);
  }

  private showMessage(msg: string): void {
    this.message = msg;
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      this.message = undefined;
      this.tui.requestRender();
    }, MESSAGE_LINGER_MS);
    this.tui.requestRender();
  }

  /** Opens/closes the offload-job panel (`j`). Opening does a fresh poll so
   * the list is current the instant it appears, not a tick later. Public:
   * the hub's /jobs command routes through the live view via this. */
  toggleJobsPanel(): void {
    this.jobs.open = !this.jobs.open;
    this.jobs.deleteArmedFor = null;
    if (this.jobs.open) this.jobs.poll(Date.now(), () => this.rows);
    this.tui.requestRender();
  }

  /** Moves the selected session one place within its own section, and keeps
   * the cursor on it. Only sessions can be moved: an orphan tmux row has no
   * session id to remember a position against. */
  private moveSelected(delta: number): void {
    const row = this.rows[this.selected];
    if (!row || row.kind !== "session") {
      this.showMessage("Only Pi sessions can be reordered.");
      return;
    }
    const layout = readLayout();
    const pinned = layout.pinned.includes(row.entry.sessionId);
    // A row may only move among its peers: within the pinned section, or
    // within its own directory group. Moving across a boundary would silently
    // change what the row means — its directory, or its pinned-ness — and
    // those are what the other two keys are for.
    const peers = this.rows.filter((r): r is SessionRow =>
      r.kind === "session" &&
      layout.pinned.includes(r.entry.sessionId) === pinned &&
      (pinned || r.entry.cwd === row.entry.cwd));
    const at = peers.findIndex((r) => r.entry.sessionId === row.entry.sessionId);
    const to = at + delta;
    if (at === -1 || to < 0 || to >= peers.length) {
      this.showMessage(pinned ? "Already at the edge of the pinned section." : "Already at the edge of this project.");
      return;
    }
    const ids = peers.map((r) => r.entry.sessionId);
    ids.splice(to, 0, ids.splice(at, 1)[0]);
    if (pinned) {
      // The pinned list IS the pinned order; rewrite that slice in place.
      const rest = layout.pinned.filter((id) => !ids.includes(id));
      writeLayout({ ...layout, pinned: [...ids, ...rest] });
    } else {
      // Explicit order for this group's ids; other groups keep theirs.
      const rest = layout.order.filter((id) => !ids.includes(id));
      writeLayout({ ...layout, order: [...rest, ...ids] });
    }
    this.refresh();
    // Follow the row rather than the index: the sort has just changed under us.
    const moved = this.rows.findIndex((r) => r.kind === "session" && r.entry.sessionId === row.entry.sessionId);
    if (moved >= 0) this.selected = moved;
    this.tui.requestRender();
  }

  /** Pins or unpins the selected session. Pinned sessions leave their
   * directory group and sit in one section at the top, whatever their state. */
  private togglePin(): void {
    const row = this.rows[this.selected];
    if (!row || row.kind !== "session") {
      this.showMessage("Only Pi sessions can be pinned.");
      return;
    }
    const id = row.entry.sessionId;
    const layout = readLayout();
    const now = layout.pinned.includes(id)
      ? layout.pinned.filter((x) => x !== id)
      : [...layout.pinned, id];
    writeLayout({ ...layout, pinned: now });
    this.showMessage(now.includes(id)
      ? `Pinned "${this.rowLabel(row)}" to the top.`
      : `Unpinned "${this.rowLabel(row)}".`);
    this.refresh();
    const moved = this.rows.findIndex((r) => r.kind === "session" && r.entry.sessionId === id);
    if (moved >= 0) this.selected = moved;
    this.tui.requestRender();
  }

  private rowTmuxName(row: Row): string | undefined {
    return row.kind === "orphan" ? row.tmux.name : row.entry.tmuxName;
  }

  private rowLabel(row: Row): string {
    return row.kind === "orphan" ? row.tmux.name : (row.entry.name ?? row.entry.project);
  }

  private startComposer(step: ComposerStep, prefill: string): void {
    this.deleteArmedFor = undefined;
    this.composerStep = step;
    this.composer = new Composer(
      prefill,
      (value) => this.handleComposerSubmit(value),
      () => {
        this.composer = undefined;
        this.composerStep = undefined;
        this.tui.requestRender();
      },
    );
    this.tui.requestRender();
  }

  private handleComposerSubmit(value: string): void {
    const step = this.composerStep;
    this.composer = undefined;
    this.composerStep = undefined;
    if (!step) return;
    if (!value) {
      this.showMessage("Cancelled — empty input.");
      return;
    }
    if (step.kind === "new-name") {
      this.startComposer({ kind: "new-dir", name: value }, process.env.PI_KING_CWD?.trim() || this.invocationCwd);
      return;
    }
    if (step.kind === "new-dir") {
      this.closeDashboard({ type: "create", name: step.name, dir: value, size: this.clientSize() });
      return;
    }
    if (step.kind === "dispatch-task") {
      this.startComposer({ kind: "dispatch-name", task: value }, slugForTask(value));
      return;
    }
    if (step.kind === "dispatch-name") {
      // The single-writer rule of src/index.ts:406 in its cheapest form: a
      // session that already exists is one somebody may be attached to and
      // mid-turn in, and dispatch would send-keys into it. Refuse by name
      // BEFORE creating anything. (arc.ts re-checks with tmux has-session,
      // which is the authority; this one exists to fail in the composer,
      // where the user can just retype, rather than after the dashboard has
      // closed.)
      const taken = this.rows.some((r) => this.rowTmuxName(r) === value.replace(/[:.]/g, "-").trim());
      if (taken) {
        this.showMessage(`"${value}" already exists \u2014 dispatch only creates new sessions.`);
        return;
      }
      this.startComposer({ kind: "dispatch-dir", task: step.task, name: value }, process.env.PI_KING_CWD?.trim() || this.invocationCwd);
      return;
    }
    if (step.kind === "dispatch-dir") {
      this.closeDashboard({ type: "dispatch", name: step.name, task: step.task, dir: value, size: this.clientSize() });
      return;
    }
    if (step.kind === "rename") {
      const tmuxName = this.rowTmuxName(step.row);
      if (!tmuxName) {
        this.showMessage("That session has no tmux name to rename.");
        return;
      }
      const settled = step.row.kind === "session" && isSettled(step.row.entry);
      const sessionId = step.row.kind === "session" ? step.row.entry.sessionId : undefined;
      const result = renameTmuxSession(tmuxName, value, settled, sessionId);
      this.showMessage(result.message);
      this.refresh();
      this.tui.requestRender();
      return;
    }
  }

  handleInput(data: string): void {
    if (this.composer) {
      this.composer.input.handleInput(data);
      this.tui.requestRender();
      return;
    }
    // Jobs mode owns the keyboard: every key below is a JOB action, never a
    // session action, while the panel is open. Unhandled keys clear the
    // delete arm and stop — session keys must not leak through.
    if (this.jobs.open) {
      if (matchesKey(data, "escape") || data === "j" || data === "J") {
        this.jobs.open = false;
        this.jobs.deleteArmedFor = null;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "down")) {
        this.jobs.deleteArmedFor = null;
        this.jobs.selected =
          this.jobs.list.length === 0 ? -1 : Math.min(this.jobs.list.length - 1, this.jobs.selected + 1);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "up")) {
        this.jobs.deleteArmedFor = null;
        this.jobs.selected = this.jobs.list.length === 0 ? -1 : Math.max(0, this.jobs.selected - 1);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "right")) {
        const job = this.jobs.list[this.jobs.selected];
        if (job) {
          const json = this.jobs.markerJson(job.id);
          // Full marker JSON (like /jobs show): the max valid marker is
          // ~2.7KB (500+1024+500 caps), so the cap must clear that or
          // "show the full marker" truncates mid-string.
          if (json) this.showMessage(clean(json, 4096));
        }
        return;
      }
      if (data === "r" || data === "R") {
        const job = this.jobs.list[this.jobs.selected];
        if (!job) return;
        void this.jobs.resume(job.id, this.rows).then((msg) => {
          this.showMessage(msg);
          this.tui.requestRender();
        });
        return;
      }
      if (data === "c" || data === "C") {
        const removed = this.jobs.clearFinished();
        this.showMessage(`Removed ${removed} finished job marker${removed === 1 ? "" : "s"}.`);
        this.tui.requestRender();
        return;
      }
      if (data === "x") {
        const job = this.jobs.list[this.jobs.selected];
        if (!job) return;
        this.jobs.deleteArmedFor = job.id;
        this.showMessage("Press X again to delete this marker (the ack goes too).");
        this.tui.requestRender();
        return;
      }
      if (data === "X") {
        const job = this.jobs.list[this.jobs.selected];
        if (!job) return;
        if (this.jobs.deleteArmedFor === job.id) {
          this.jobs.deleteArmedFor = null;
          this.showMessage(this.jobs.deleteMarker(job.id));
        } else {
          this.jobs.deleteArmedFor = job.id;
          this.showMessage("Press X again to delete this marker (the ack goes too).");
        }
        this.tui.requestRender();
        return;
      }
      this.jobs.deleteArmedFor = null;
      return;
    }
    // Esc (and the terminal's own Ctrl+C/Ctrl+D) are the only ways to quit —
    // "q" is deliberately not a quit key here: it's too easy to hit by
    // accident while navigating (e.g. inside a session name), and this is a
    // dashboard people rely on staying open, not a pager.
    if (matchesKey(data, "escape")) {
      this.closeDashboard(undefined);
      return;
    }
    // Reorder before plain movement: shift+arrow must not fall through to the
    // arrow handler, or the row would move and the cursor would move again.
    if (matchesKey(data, "shift+up") || matchesKey(data, "shift+down")) {
      this.moveSelected(matchesKey(data, "shift+up") ? -1 : 1);
      return;
    }
    if (matchesKey(data, "ctrl+t")) {
      this.togglePin();
      return;
    }
    if (matchesKey(data, "down")) {
      this.deleteArmedFor = undefined;
      this.selected = Math.min(this.rows.length - 1, this.selected + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      this.deleteArmedFor = undefined;
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
      return;
    }
    if (data === "s" || data === "S") {
      this.showStats = !this.showStats;
      this.tui.requestRender();
      return;
    }
    if (data === "r" || data === "R") {
      this.restartStaleSessions();
      return;
    }
    if (data === "n" || data === "N") {
      this.startComposer({ kind: "new-name" }, "");
      return;
    }
    // `n` creates an empty session and drops you into it, and you type the
    // task yourself. `d` is the other half: you supply the task up front and
    // stay here while the session goes and does it.
    if (data === "d" || data === "D") {
      this.startComposer({ kind: "dispatch-task" }, "");
      return;
    }
    const row = this.rows[this.selected];
    // Collapse the selected row's arcs. Persisted rather than held in memory
    // because bin/pi-king re-runs this extension after every detach -- an
    // in-memory toggle would forget itself several times an hour. `right` is
    // not available for this (already bound to attach), and space is the key
    // people press to scroll.
    if (data === "a" || data === "A") {
      if (!row || row.kind !== "session") return;
      if (!row.tree?.arcCount) {
        this.showMessage("That session has no arcs.");
        this.tui.requestRender();
        return;
      }
      const id = row.entry.sessionId;
      const l = readLayout();
      const now = l.collapsed.includes(id) ? l.collapsed.filter((x) => x !== id) : [...l.collapsed, id];
      writeLayout({ ...l, collapsed: now });
      this.refresh();
      this.tui.requestRender();
      return;
    }
    if (data === "e" || data === "E") {
      if (!row) return;
      const tmuxName = this.rowTmuxName(row);
      if (!tmuxName) {
        this.showMessage("Only tmux-backed sessions can be renamed here.");
        return;
      }
      this.startComposer({ kind: "rename", row }, tmuxName);
      return;
    }
    // j opens the offload-job panel (markers in ~/.pi/jobs); J closes it the
    // same way j does when open. Verified unbound before taking it. The
    // session delete-arm (X) is untouched by either.
    if (data === "j" || data === "J") {
      this.toggleJobsPanel();
      return;
    }
    // x detaches, X kills. The destructive action no longer sits on the key a
    // hand reaches for first: detaching is what you usually want (take the
    // terminal back, leave the session running), and killing ends a live
    // process whose in-flight work cannot be recovered.
    if (data === "x") {
      if (!row) return;
      const tmuxName = this.rowTmuxName(row);
      if (!tmuxName) {
        this.showMessage("Only tmux-backed sessions can be detached.");
        return;
      }
      const result = detachTmuxSession(tmuxName);
      this.showMessage(result.message);
      this.refresh();
      this.tui.requestRender();
      return;
    }
    if (data === "X") {
      if (!row) return;
      // An exited card holds no process; X here removes the card itself.
      // Armed like kill — not because it is dangerous, but because one
      // consistent rhythm for X is worth more than saving a keypress.
      if (row.kind === "session" && row.entry.state === "exited") {
        const id = row.entry.sessionId;
        if (this.deleteArmedFor === id) {
          this.deleteArmedFor = undefined;
          try {
            unlinkSync(join(SESSION_STATUS_DIR, `${id}.json`));
            // The card is the only thing a pin or manual position refers to;
            // once it is gone, the layout entry is a dangling id that would
            // otherwise accumulate forever.
            const l = readLayout();
            if (l.pinned.includes(id) || l.order.includes(id) || l.lastSelected === id || id in l.names) {
              const names = { ...l.names };
              delete names[id];
              writeLayout({
                ...l,
                pinned: l.pinned.filter((x) => x !== id),
                order: l.order.filter((x) => x !== id),
                lastSelected: l.lastSelected === id ? undefined : l.lastSelected,
                names,
              });
            }
            this.showMessage(`Card removed. The transcript is untouched: pi --session ${id}`);
          } catch {
            this.showMessage("Could not remove the card.");
          }
          this.refresh();
          this.tui.requestRender();
        } else {
          this.deleteArmedFor = id;
          this.showMessage("Press X again to remove this card. The transcript survives either way.");
        }
        return;
      }
      const tmuxName = this.rowTmuxName(row);
      if (!tmuxName) {
        this.showMessage("Only tmux-backed sessions can be killed here.");
        return;
      }
      if (this.deleteArmedFor === tmuxName) {
        this.deleteArmedFor = undefined;
        const result = killTmuxSession(tmuxName);
        this.showMessage(result.message);
        this.refresh();
        this.tui.requestRender();
      } else {
        this.deleteArmedFor = tmuxName;
        this.showMessage(`Press X again to KILL "${tmuxName}" — ends the running process. x detaches instead.`);
      }
      return;
    }
    if (this.deleteArmedFor) this.deleteArmedFor = undefined;
    // right is an alternative to enter, not a distinct gesture: it goes
    // through the exact same branch below (resurrect-if-exited, then
    // attach), so a row behaves identically no matter which key opens it.
    // Not bound on orphan-tmux rows specially — it falls through to the same
    // rowTmuxName/attach path enter already uses for those.
    if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      if (!row) return;
      // Enter on an exited card resurrects it: a fresh tmux session resuming
      // the same transcript in the same directory, then attach as usual.
      if (row.kind === "session" && row.entry.state === "exited") {
        const e = row.entry;
        // Re-check liveness AT PRESS TIME, not at render time. "Exited" here
        // is a verdict computed up to a refresh-cycle ago from a card that any
        // bug upstream can mis-stamp — and one did: /reload used to reset the
        // card's startedAt, failing the identity check, so a session could sit
        // here marked exited while its process ran fine. Resuming that spawns
        // a second process on the same transcript, which is the one disaster
        // this tool must never cause. A resurrect is not latency-sensitive;
        // one ps call is cheap insurance against it.
        if (e.pid && spawnSync("/bin/ps", ["-p", String(e.pid)], { encoding: "utf8", timeout: 2000 }).status === 0) {
          this.showMessage(`Card says exited, but pid ${e.pid} is alive right now — not resuming onto a live transcript. Refresh (r) and re-check.`);
          this.refresh();
          this.tui.requestRender();
          return;
        }
        if (!existsSync(e.cwd)) {
          this.showMessage(`Directory is gone: ${e.cwd}. Resume by hand: pi --session ${e.sessionId}`);
          return;
        }
        const base = (e.name ?? e.project).trim() || e.shortId;
        let target = base;
        let result = createTmuxSession(target, e.cwd, e.sessionId, this.clientSize());
        // A live session may already hold this name; retry once, disambiguated.
        if (!result.ok) {
          target = `${base}-${e.shortId}`;
          result = createTmuxSession(target, e.cwd, e.sessionId, this.clientSize());
        }
        if (!result.ok) {
          this.showMessage(result.message);
          return;
        }
        this.closeDashboard({ type: "attach", tmuxName: target, expectedPid: undefined });
        return;
      }
      const tmuxName = this.rowTmuxName(row);
      if (tmuxName) {
        // Pass the pid this row is believed to belong to, so the attach path can
        // re-confirm with tmux directly instead of trusting the bulk listing it
        // was built from. Orphan rows have no Pi process to verify against.
        const expectedPid = row.kind === "session" ? row.entry.pid : undefined;
        this.closeDashboard({ type: "attach", tmuxName, expectedPid });
        return;
      }
      if (row.kind === "session") {
        const result = jumpToGhosttyTab(row.entry.shortId);
        this.showMessage(result.message);
      }
      return;
    }
  }

  render(width: number): string[] {
    if (width < 40) return [];
    const th = this.theme;
    const W = width;
    const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleWidth(s)));
    /** Left content, right content, flush to the full terminal width. */
    // Full terminal width. Earlier versions capped this on the theory that a
    // label and its right-flushed value stop reading as a pair once the gap
    // grows, but in practice the cap just left most of a wide screen empty,
    // which is the more obvious defect.
    const MEASURE = W;
    const split = (left: string, right: string): string =>
      left + " ".repeat(Math.max(1, MEASURE - visibleWidth(left) - visibleWidth(right))) + right;

    const lines: string[] = [];
    const { stats, daily, loaded } = this.statsCache.get();

    // ---- banner: art beside identity, row-for-row ----------------------
    const side = [
      "",
      th.fg("accent", th.bold("p i - k i n g")),
      th.fg("muted", "There are many agent harnesses"),
      th.fg("muted", "but ") + th.fg("accent", th.bold("this one is yours")),
      "",
      th.fg("dim", "background a session \u00b7 come back later"),
    ];
    const artRamp = ["warning", "warning", "accent", "accent", "accent", "muted"] as const;
    const artW = Math.max(...PI_ART.map((l) => l.length));
    lines.push("");
    for (let i = 0; i < PI_ART.length; i++) {
      lines.push("  " + th.fg(artRamp[i] ?? "dim", pad(PI_ART[i], artW)) + "    " + (side[i] ?? ""));
    }
    lines.push("");

    // Everything above this point is decoration. It is the first thing shed
    // when the terminal is too short to hold the whole layout.
    const artLines = lines.length;

    // ---- ticker + quote -------------------------------------------------
    // Budget: split() lays the row out as "  " + ticker + pad(>=1) + clock +
    // "  ", so the most the ticker can be without split() forcing pad past its
    // 1-space minimum (which would overflow the row by however much) is
    // MEASURE - 2 (left margin) - 2 (right margin) - 1 (minimum pad) = -5. A
    // previous -8 reserved 3 unnecessary characters, coarse-shedding a whole
    // extra segment (e.g. "avg 356.9M/day") on renders that missed the tighter
    // budget by only 1-2 characters — verified against a real 224-col render
    // where correcting this alone was the difference between 7 and 8 segments
    // surviving.
    const clockText = clockLine();
    const ticker = tickerParts(th, stats, daily, loaded, Math.max(20, MEASURE - visibleWidth(clockText) - 5));
    const rule = th.fg("dim", "\u2500".repeat(Math.max(0, MEASURE - 4)));
    lines.push("  " + rule);
    lines.push(split("  " + (ticker ?? th.fg("dim", "no router activity today")), th.fg("dim", clockText) + "  "));
    lines.push("  " + rule);
    if (this.piTuiUnpatched) {
      lines.push("  " + th.fg("warning", "pi-tui unpatched \u2014 monolith sessions replay full renders under tmux; run: pi-king patch-tui"));
    }
    // A human-scale comparison for today's distinct tokens, on its own row
    // instead of competing with the ticker's other segments for width — it
    // used to live there and lost the room to things people check more often
    // (volume, errors, when they're busiest). Full phrasing here, unlike the
    // trimmed ticker version this replaced: nothing else is on this line to
    // compete with. Small/early days show nothing, same as everywhere else
    // that reads tokenComparison — absence of logs is not a measurement.
    if (stats) {
      const distinctToday = netTokens(stats.tokensIn, stats.tokensCacheRead) + stats.tokensOut;
      const cmp = tokenComparison(distinctToday);
      if (cmp) lines.push("  " + th.fg("accent", cmp));
    }
    lines.push("  " + th.fg("dim", `\u201c${this.quote}\u201d`));
    lines.push("");

    // ---- stats screen ----------------------------------------------------
    // Compact money: cents below $100, rounded dollars above. The lifetime
    // figure runs to thousands; today's per-model figures are often cents.
    const fmtMoney = (n: number): string =>
      n >= 100 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `$${n.toFixed(2)}`;
    if (this.showStats) {
      const life = this.statsCache.lifetime();
      if (!life) {
        lines.push("  " + th.fg("dim", "No usage history. Set PI_KING_CALL_LOGS to a directory of call logs."));
      } else {
        const total = life.tokensIn + life.tokensOut;
        const cell = (label: string, value: string): string =>
          th.fg("dim", label.padEnd(16)) + th.fg("accent", th.bold(value));
        const pairs: [string, string][] = [
          ["total tokens", compactNum(total)],
          ["calls", life.calls.toLocaleString()],
          ["active days", String(life.activeDays)],
          ["current streak", `${life.currentStreak}d`],
          ["longest streak", `${life.longestStreak}d`],
          ["tokens in", compactNum(life.tokensIn)],
          ["tokens out", compactNum(life.tokensOut)],
          ["net tokens", compactNum(netTokens(life.tokensIn, life.tokensCacheRead))],
          ["cache reads", `${compactNum(life.tokensCacheRead)} (${life.tokensIn > 0 ? Math.round((life.tokensCacheRead / life.tokensIn) * 100) : 0}%)`],
        ];
        // API-equivalent cost, from the pipeline's cost-prices.json. Only shown
        // when a price is actually known — absence of prices is not a $0 bill.
        if (life.cost > 0) pairs.push(["API-equiv", fmtMoney(life.cost)]);
        // Cache leverage: how many times each token written into the cache was
        // served back out. This is the number that justifies (or indicts) the
        // whole caching story — read share alone cannot say whether writes paid.
        if (life.tokensCacheWrite > 0) {
          pairs.push(["cache leverage", `${(life.tokensCacheRead / life.tokensCacheWrite).toFixed(1)}x re-read`]);
        }
        // Reasoning beside output, never as a share derived from it: measured
        // not to be a strict subset of out (7 of 9,058 sampled records exceed
        // it), so a percentage would occasionally read above 100.
        if (life.tokensReasoning > 0) {
          pairs.push(["reasoning", `${compactNum(life.tokensReasoning)} vs ${compactNum(life.tokensOut)} out`]);
        }
        // Biggest and median day, from the same per-day rows the heatmap uses.
        // The mean is skipped deliberately: these days span a seventy-fold
        // range, and a mean over that distribution describes no actual day.
        const activeDays = life.days.filter((d) => d.calls > 0);
        if (activeDays.length >= 2) {
          const byVolume = [...activeDays].sort((a, b) => a.tokensIn - b.tokensIn);
          const biggest = byVolume[byVolume.length - 1];
          const median = byVolume[Math.floor(byVolume.length / 2)];
          pairs.push(
            ["biggest day", `${compactNum(biggest.tokensIn)} (${biggest.day})`],
            ["median day", compactNum(median.tokensIn)],
          );
        }
        for (let i = 0; i < pairs.length; i += 2) {
          const a = cell(pairs[i][0], pairs[i][1]);
          const b = pairs[i + 1] ? cell(pairs[i + 1][0], pairs[i + 1][1]) : "";
          lines.push("  " + a + " ".repeat(Math.max(2, 40 - visibleWidth(a))) + b);
        }
        lines.push("");
        // Daily volume as a heatmap row, oldest to newest. Density is relative
        // to the busiest day, so a quiet week still shows its own shape.
        const peak = Math.max(...life.days.map((d) => d.tokensIn), 1);
        const shades = " \u2591\u2592\u2593\u2588";
        const heat = life.days.map((d) => shades[Math.min(4, Math.ceil((d.tokensIn / peak) * 4))]).join("");
        lines.push("  " + th.fg("dim", "daily volume  ") + th.fg("accent", heat) +
          th.fg("dim", `  ${life.days[0]?.day ?? ""} \u2192 ${life.days[life.days.length - 1]?.day ?? ""}`));
        // Distinct tokens only: input minus cache reads, plus output. Cache
        // reads are the same history re-sent each turn, and counting them here
        // would inflate the comparison by however chatty the sessions were
        // rather than by how much text actually passed through.
        const distinct = netTokens(life.tokensIn, life.tokensCacheRead) + life.tokensOut;
        const cmp = tokenComparison(distinct);
        if (cmp) {
          lines.push("");
          lines.push("  " + th.fg("muted", `You have pushed ${cmp} through this machine.`));
        }
      }
      // ---- today, in detail ----------------------------------------------
      // The band answers "how much"; this answers "which model, what kind of
      // errors, and what made you wait". Only rendered when today has calls —
      // an empty section would just be furniture.
      const { stats: todayStats } = this.statsCache.get();
      if (todayStats) {
        lines.push("");
        lines.push("  " + th.fg("dim", "── today ──"));
        for (const m of todayStats.perModel.slice(0, 4)) {
          const bits = [
            `${m.calls} call${m.calls === 1 ? "" : "s"}`,
            `${compactNum(m.tokensIn)} in`,
            m.cost > 0 ? fmtMoney(m.cost) : "",
            m.p95 > 0 ? `p95 ${(m.p95 / 1000).toFixed(1)}s` : "",
            m.errors > 0 ? `${m.errors} err` : "",
          ].filter(Boolean).join(" · ");
          lines.push("  " + th.fg("accent", m.model.padEnd(22)) + th.fg("muted", bits));
        }
        if (todayStats.errorsByStatus.length > 0) {
          const kinds = todayStats.errorsByStatus.map(([code, n]) => `${code} \u00d7${n}`).join("  ");
          lines.push("  " + th.fg("dim", "errors".padEnd(22)) + th.fg("error", kinds));
        }
        if (todayStats.slowest) {
          lines.push("  " + th.fg("dim", "slowest call".padEnd(22)) +
            th.fg("warning", `${(todayStats.slowest.duration / 1000).toFixed(1)}s`) +
            th.fg("muted", ` (${todayStats.slowest.model})`));
        }
      }
      lines.push("");
      lines.push("  " + th.fg("dim", "s") + th.fg("muted", " back to sessions"));
      return lines;
    }

    // ---- fleet vitals ---------------------------------------------------
    const sessions = this.rows.filter((r): r is SessionRow => r.kind === "session");
    const byState = (s: TitleState) => sessions.filter((r) => r.entry.state === s).length;
    const running = sessions.reduce((n, r) =>
      n + r.entry.subagents.filter((s) => s.status === "running" || s.status === "queued").length, 0);
    const vitals: string[] = [th.bold(String(this.rows.length)) + th.fg("dim", ` session${this.rows.length === 1 ? "" : "s"}`)];
    const add = (n: number, label: string, hue: string) => { if (n > 0) vitals.push(th.fg(hue, String(n)) + th.fg("dim", ` ${label}`)); };
    add(byState("working"), "working", "accent");
    add(byState("background"), "background", "accent");
    add(byState("idle"), "idle", "success");
    add(byState("attention"), "attention", "warning");
    add(byState("error"), "error", "error");
    add(running, "subagents running", "accent");
    if (this.rows.length > 0) {
      lines.push("  " + vitals.join(th.fg("dim", "  \u00b7  ")));
      lines.push("");
    }

    // ---- sessions, grouped by directory ---------------------------------
    // From here to the inventory, lines go into `body`: this is the only zone
    // allowed to scroll. Everything above is pinned context and everything
    // below is the key map, which is useless if a long list pushes it off the
    // screen — which it did, at 21 sessions.
    const body: string[] = [];
    /** Index in `body` of the currently selected row, so the window can be
     * centred on it rather than on the top of the list. */
    let selectedLine = 0;
    if (this.jobs.open) {
      // Jobs panel: the session body is replaced by the marker list. Marker
      // content is UNTRUSTED data — every field passes through clean() +
      // truncateToWidth before it is rendered.
      body.push("  " + th.fg("accent", "Jobs") + th.fg("dim", " — j/esc back · enter show · r resume · c clear · X delete"));
      const jobs = this.jobs.list;
      if (jobs.length === 0) {
        body.push("  " + th.fg("dim", "No job markers in ~/.pi/jobs."));
      } else {
        const idW = Math.min(28, Math.max(12, Math.floor(MEASURE * 0.2)));
        const statusW = 10;
        const timeW = 9;
        const spawnerW = 16;
        // sessionId → display name, from the live rows (the dashboard's own
        // read of the fleet, same source the injector targets against).
        const spawnerName = new Map<string, string>();
        for (const r of this.rows) {
          if (r.kind !== "session") continue;
          const e = r.entry;
          if (e?.sessionId) {
            const nm = e.name?.trim();
            spawnerName.set(e.sessionId, nm ? `${nm} #${e.sessionId.slice(0, 8)}` : `#${e.sessionId.slice(0, 8)}`);
          }
        }
        jobs.forEach((j, i) => {
          const sel = i === this.jobs.selected;
          if (sel) selectedLine = body.length;
          const marker = sel ? th.fg("accent", "\u276f") : " ";
          // A dead worker is a FAILURE, not a dim maybe: the job is never
          // completing, so it reads as an error rather than a stale guess.
          const hue = j.orphaned ? "error" : j.stale ? "dim" : j.marker.status === "done" ? "success"
            : j.marker.status === "failed" ? "error" : "accent";
          const id = pad(truncateToWidth(clean(j.id), idW, "\u2026", true), idW);
          // "pending (stale)" is 15 chars — must truncate or it overflows
          // the status column and shoves the summary right. "died" replaces
          // the status outright: "pending" would be a lie about a job whose
          // worker no longer exists.
          const statusText = j.orphaned ? "died" : j.marker.status + (j.stale ? " (stale)" : "");
          const status = pad(truncateToWidth(statusText, statusW, "\u2026", true), statusW);
          // Time elapsed: live count-up since createdAt while pending;
          // total runtime (completedAt − createdAt) once terminal. Ticks
          // with the panel's 1s refresh.
          let timeText = "\u2014";
          if (j.marker.createdAt) {
            const start = Date.parse(j.marker.createdAt);
            const end = j.marker.status === "pending"
              ? Date.now()
              : j.marker.completedAt ? Date.parse(j.marker.completedAt) : Date.now();
            if (Number.isFinite(start) && Number.isFinite(end)) timeText = duration(end - start);
          }
          const time = th.fg("muted", pad(truncateToWidth(timeText, timeW, "\u2026", true), timeW));
          // Spawner provenance: which session this job came from (job_spawn
          // stamps spawnerSessionId since 0.2.5). Lets a misroute be spotted
          // in the panel itself — a job delivered elsewhere while its
          // "spawned by" column names a different session is a red flag.
          const spawner = j.marker.spawnerSessionId
            ? th.fg("dim", pad(
                truncateToWidth(
                  spawnerName.get(j.marker.spawnerSessionId) ?? `#${j.marker.spawnerSessionId.slice(0, 8)}`,
                  spawnerW, "\u2026", true,
                ),
                spawnerW,
              ))
            : th.fg("dim", pad("\u2014", spawnerW));
          const summary = j.marker.summary
            ? truncateToWidth(clean(j.marker.summary), Math.max(10, MEASURE - idW - statusW - timeW - spawnerW - 24), "\u2026", true)
            : "";
          const right = j.marker.resultPath
            ? th.fg("dim", truncateToWidth(clean(j.marker.resultPath), 40, "\u2026", true))
            : "";
          body.push(split(
            `  ${marker} ${sel ? th.bold(th.fg(hue, id)) : th.fg(hue, id)} ${th.fg(hue, status)} ${time} ${spawner} ` + th.fg("muted", summary),
            right,
          ));
        });
      }
    } else if (this.rows.length === 0) {
      body.push("  " + th.fg("dim", "No backgrounded sessions. Press ") + th.fg("muted", "n") +
        th.fg("dim", " to start one, or run ") + th.fg("muted", "/bg") + th.fg("dim", " inside a session to surface it here."));
      if (this.recent.length > 0) {
        body.push("");
        body.push("  " + th.fg("success", "recent projects"));
        for (const p of this.recent) {
          const parent = p.path.slice(0, Math.max(0, p.path.length - p.project.length)).replace(process.env.HOME ?? "~", "~");
          body.push(split("     " + th.fg("dim", parent) + th.fg("accent", p.project), th.fg("dim", `${elapsed(p.lastActive)} ago`) + "  "));
        }
      }
    } else {
      // Column geometry: name and status columns are fixed so activity text
      // lines up down the page instead of ragging against variable-width names.
      // Two cells wider than it was historically: the session glyph that used
      // to sit outside it is gone, and the lineage rail now lives inside it,
      // so nested names need the room the glyph used to take.
      const nameW = Math.min(36, Math.max(20, Math.floor(MEASURE * 0.22) + 2));
      const statusW = 13;  // "● background" is the longest state at 12 cells; 22 wasted 10 columns on every row
      let lastGroup: string | undefined;
      const pinnedIds = readLayout().pinned;
      this.rows.forEach((r, i) => {
        // A nested arc never opens a section of its own: it belongs to
        // whatever section its parent landed in, even when it was spawned in
        // a different directory. Emitting a header for it would split the
        // tree in half and claim the child lives somewhere its parent does
        // not -- the row itself carries the project instead (below).
        const nested = r.kind === "session" && (r.tree?.depth ?? 0) > 0;
        const ownGroup = r.kind === "orphan" ? "tmux (no Pi session)"
          : pinnedIds.includes(r.entry.sessionId) ? "pinned"
          : r.entry.cwd.replace(process.env.HOME ?? "~", "~");
        const group = nested && lastGroup !== undefined ? lastGroup : ownGroup;
        if (group !== lastGroup) {
          if (lastGroup !== undefined) body.push("");
          // A pinned row keeps its own project visible on the row itself,
          // since the section header no longer says where it lives.
          const drift = r.kind === "session" && group !== "pinned" ? this.gitDrift.get(r.entry.cwd) : undefined;
          const driftBadge = drift && drift.n > 0
            ? th.fg("warning", `  \u25cf ${drift.n} uncommitted`)
            : "";
          body.push("  " + (group === "pinned" ? th.fg("accent", "pinned") : th.fg("muted", group)) + driftBadge);
          lastGroup = group;
        }
        const sel = i === this.selected;
        if (sel) selectedLine = body.length;
        const marker = sel ? th.fg("accent", "\u276f") : " ";
        if (r.kind === "orphan") {
          const nm = pad(truncateToWidth(r.tmux.name, nameW, "\u2026", true), nameW);
          body.push(split(`  ${marker} ${th.fg("accent", "\u26fa")} ${sel ? th.bold(nm) : nm} ` +
            pad(th.fg("dim", "external"), statusW) + th.fg("muted", "attach or delete only"),
            th.fg("dim", elapsed(r.tmux.createdAt)) + "  "));
          return;
        }
        const e = r.entry;
        const hue = e.state === "error" ? "error"
          : e.state === "attention" ? "warning"
          : e.state === "working" || e.state === "background" ? "accent"
          : e.state === "exited" ? "dim"
          : e.state === "idle" ? "success"
          : "muted"; // unknown: visible, unstyled, not dressed as anything
        const isPinned = pinnedIds.includes(e.sessionId);
        // The Pi session's own name wins over its tmux container's. Renaming
        // from inside a session (/name) is the deliberate act; the tmux name is
        // just what the session happened to be created as, and only the
        // dashboard's own rename keeps the two in step. Preferring tmux meant a
        // rename typed inside a session never appeared here at all.
        // The whole left column is assembled here, glyph included, so the
        // lineage rail is the FIRST thing on the row. It used to sit to the
        // right of the session glyph, which made the tree look like
        // decoration floating inside a column instead of the thing giving the
        // rows their shape. truncateToWidth is ANSI-aware, so the pieces can
        // carry their own colour and the column still lands on nameW.
        const tree = r.tree;
        const rail = tree?.prefix ? th.fg("dim", tree.prefix) : "";
        // The twisty OCCUPIES the session-glyph slot rather than sitting
        // beside it. Carrying both produced three glyphs ahead of a parent's
        // name ("\u25be \u233f \u2691 Alexandria") and the eye had to sort out which one
        // meant what. A row that owns arcs is by definition a live session,
        // so the glyph it gives up was the predictable one. Muted, not
        // accent: the row's one accent already belongs to its state.
        // SIGNAL BY EXCEPTION, AT ZERO COST. \u26fa has emoji presentation, so
        // Ghostty drew a full-colour glyph on every row -- and since nearly
        // every session is tmux-hosted it was identical everywhere, making
        // the loudest thing on the row the one carrying no information.
        // Reserving two blank cells for it instead just moved the waste, so
        // the state it encoded now rides on the name: a session with no tmux
        // pane -- one `enter` cannot attach to -- is dimmed. Orphan rows keep
        // the tent, which is how it comes to mean something.
        // A collapsed parent states what is hidden rather than that something
        // is: \u25b8 says "there is more", "(2)" says how much more. An expanded
        // parent needs no marker at all -- its children are directly below it.
        const badge = tree && tree.collapsed && tree.arcCount > 0
          ? th.fg("muted", ` (${tree.arcCount})`) : "";
        // Same reasoning as a pinned row keeping its project: once the section
        // header no longer describes where this row lives, the row says so
        // itself. tree.showProject compares against the actual PARENT, so an
        // arc sitting in its parent's own directory stays unlabelled.
        const bareName = e.name ?? e.tmuxName ?? e.project;
        const nameStyled = e.tmuxName ? bareName : th.fg("dim", bareName);
        // A project suffix that merely restates the name ("Alexandria \u00b7
        // alexandria") is pure noise AND it steals width from the name, which
        // then truncates. Only append when it actually carries information.
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const wantProject = (isPinned || tree?.showProject) && norm(e.project) !== norm(bareName);
        // Glyph precedes the rail because it is per-row metadata, not tree
        // structure; keeping it out of the rail lets the lineage lines form
        // one unbroken vertical run down the column. The pinned flag is gone:
        // every row under the "pinned" header is pinned, so it restated its
        // own section header once per row.
        const base = rail + (sel ? th.bold(nameStyled) : nameStyled) + badge;
        const suffix = th.fg("dim", ` \u00b7 ${e.project}`);
        // All or nothing. A narrow terminal used to truncate the suffix into a
        // dangling "\u00b7\u2026", which costs two cells of the name to say nothing at
        // all; dropping it lets the name itself use the space instead.
        const label = wantProject && visibleWidth(base) + visibleWidth(suffix) <= nameW
          ? base + suffix : base;
        const nm = truncateToWidth(label, nameW, "\u2026", true);
        const status = pad(`${iconFor(e.state)} ${th.fg(hue, e.state)}`, statusW);
        const sub = subagentSummary(e.subagents);
        // Context climbs toward compaction, and compaction discards memory the
        // user may be counting on. Colour turns before it happens, not after.
        const ctxBadge = e.contextPct !== undefined && e.state !== "exited"
          ? th.fg(e.contextPct >= 85 ? "error" : e.contextPct >= 65 ? "warning" : "dim", `ctx ${e.contextPct}%`)
          : "";
        // e.restartNeeded already excludes exited (see the
        // DashboardEntry.restartNeeded comment). In-flight reads differently
        // from queued reads differently from stale-and-untouched so pressing
        // `r` visibly does something even for the sessions it could not fire
        // into immediately, instead of looking like nothing happened.
        const restartBadge = e.restartNeeded
          ? (restartingSessions.has(e.sessionId) ? th.fg("warning", "↻ restarting")
            : pendingRestarts.has(e.sessionId) ? th.fg("warning", "↻ queued")
            : th.fg("warning", "↻ restart"))
          : "";
        // Plain text, no glyph -- unlike stale/queued this is not an action
        // item, and a fork-shaped Unicode symbol is not confidently
        // renderable everywhere. "accent" rather than "warning": nothing is
        // wrong here, this is an identity fact, not something to fix. Placed
        // ahead of ctx%/stale on purpose -- "what is this session" reads
        // before "what is it doing right now".
        const forkBadge = e.isFork ? th.fg("accent", "fork") : "";
        const right = [sub ? th.fg("dim", sub) : "", forkBadge, ctxBadge, restartBadge, th.fg("dim", elapsed(e.updatedAt))]
          .filter(Boolean).join(th.fg("dim", " \u00b7 ")) + "  ";
        const left = `  ${marker} ` + nm + " " + status +
          th.fg("muted", truncateToWidth(e.lastActivity, Math.max(10, MEASURE - nameW - statusW - visibleWidth(right) - 12), "\u2026", true));
        body.push(split(left, right));
      });
    }

    // ---- inventory ------------------------------------------------------
    // Foot zone, in two parts: the inventory is reference material and is
    // droppable; the key map is not. A dashboard whose keys have scrolled off
    // is a dashboard you cannot operate, which is what 21 sessions produced.
    const inventory: string[] = [];
    if (this.inventory) {
      inventory.push("");
      for (const l of this.renderInventoryCards(MEASURE - 4)) inventory.push("  " + l);
    }

    // ---- composer / message / keys --------------------------------------
    const foot: string[] = [];
    foot.push("");
    if (this.composer) {
      const label = this.composerStep?.kind === "new-name" ? "New session name:"
        : this.composerStep?.kind === "new-dir" ? "Directory:"
        : this.composerStep?.kind === "dispatch-task" ? "Task to dispatch:"
        : this.composerStep?.kind === "dispatch-name" ? "Session name:"
        : this.composerStep?.kind === "dispatch-dir" ? "Directory:" : "Rename to:";
      foot.push("  " + th.fg("accent", label) + " " + (this.composer.input.render(Math.max(10, MEASURE - visibleWidth(label) - 6))[0] ?? ""));
      foot.push("  " + th.fg("dim", "Enter confirm \u00b7 Esc cancel"));
    } else if (this.message) {
      foot.push("  " + th.fg("accent", this.message));
    } else {
      const k = (s: string) => th.fg("muted", s);
      const l = (s: string) => th.fg("dim", s);
      const sel = this.rows[this.selected];
      const verb = sel?.kind === "session" && sel.entry.state === "exited" ? "resume"
        : !sel || this.rowTmuxName(sel) ? "attach" : "jump";
      foot.push("  " +
        `${k("\u2191\u2193")}${l(" select ")}${k("enter")}${l(` ${verb}`)}` + l("   \u2502   ") +
        `${k("\u21e7\u2191\u2193")}${l(" move ")}${k("^t")}${l(" pin")}` + l("   \u2502   ") +
        `${k("n")}${l(" new ")}${k("d")}${l(" dispatch ")}${k("e")}${l(" rename ")}${k("x")}${l(" detach ")}${th.fg("error", "X")}${l(" kill")}` + l("   \u2502   ") + `${k("s")}${l(" stats")}` + l("   \u2502   ") +
        `${k("r")}${l(" restart stale ")}${k("esc")}${l(" close")}`);
    }

    // ---- assemble: pinned head, scrolling body, pinned foot -------------
    // Without a known terminal height there is nothing to fit to, so render
    // everything and let the terminal behave as it did before. Degrading to
    // the old behaviour is correct; guessing a height would clip real rows.
    const H = this.termHeight;
    if (H <= 0) return [...lines, ...body, ...inventory, ...foot];

    // Shed in priority order until the sessions have room to be useful. The
    // key map is never shed; the sessions never drop below MIN_BODY, because a
    // list showing one row is not a list.
    const MIN_BODY = 3;
    // The two marker rows live INSIDE the body zone, so the zone needs room for
    // them as well. Budgeting only for the rows themselves overshot the
    // terminal by exactly two lines, and since the footer is last, the two
    // lines pushed off the bottom were the key map — the one thing that must
    // never be shed. Observed at 20 rows.
    const MIN_ZONE = MIN_BODY + 2;
    let head = lines;
    let inv = inventory;
    const avail = () => H - head.length - inv.length - foot.length;
    if (avail() < MIN_ZONE) inv = [];                     // reference material first
    if (avail() < MIN_ZONE) head = lines.slice(artLines); // then the wordmark art
    if (avail() < MIN_ZONE) head = [];                    // then the band itself
    const budget = Math.max(1, avail());
    if (body.length <= budget) {
      // Pad so the footer sits on the bottom edge rather than floating
      // directly under the last session. Without this the key map moves up
      // and down the screen as sessions come and go, which is the opposite of
      // pinned: the whole point is that the keys are always in the same place.
      const room = Math.max(0, H - head.length - body.length - inv.length - foot.length);
      // Detail sits directly under the list it describes, and only claims
      // room the pad would have left blank anyway.
      const detail = this.renderSelectedDetail(MEASURE, Math.min(room, 5));
      const pad = Math.max(0, room - detail.length);
      return [...head, ...body, ...detail, ...Array<string>(pad).fill(""), ...inv, ...foot];
    }

    // Two rows of the budget go to the more-above/more-below markers, so the
    // list never continues past an edge without saying so. The subtraction is
    // what keeps the total at exactly H: head + 2 + window + inv + foot.
    const window = Math.max(1, budget - 2);
    let start = Math.max(0, selectedLine - Math.floor(window / 2));
    start = Math.min(start, body.length - window);
    const above = start;
    const below = body.length - (start + window);
    const marker = (n: number, arrow: string) => "  " + th.fg("dim", `${arrow} ${n} more`);
    return [
      ...head,
      above > 0 ? marker(above, "\u2191") : "",
      ...body.slice(start, start + window),
      below > 0 ? marker(below, "\u2193") : "",
      ...inv,
      ...foot,
    ];
  }

  /** The one thing the row had to cut: the selected session's activity, in
   * full. Built ONLY from space the layout was already going to waste as
   * padding, so it cannot push the footer off and costs nothing whenever the
   * list is long enough to fill the screen -- the case where render cost
   * would actually matter. No new I/O: every field is already in memory. */
  private renderSelectedDetail(width: number, maxLines: number): string[] {
    const row = this.rows[this.selected];
    if (!row || row.kind !== "session" || maxLines < 3) return [];
    const th = this.theme;
    const e = row.entry;
    const arcs = row.tree?.arcCount ?? 0;
    const facts = [
      e.cwd.replace(process.env.HOME ?? "~", "~"),
      `#${e.shortId}`,
      e.pid ? `pid ${e.pid}` : "",
      arcs > 0 ? `${arcs} arc${arcs > 1 ? "s" : ""}` : "",
    ].filter(Boolean).join(" \u00b7 ");
    const out = ["", "  " + th.fg("accent", e.name ?? e.project) + "  " + th.fg("dim", facts)];
    const text = (e.lastActivity ?? "").trim();
    if (!text) return out;
    // Greedy wrap. The row truncates this to a single line, which for a real
    // activity string is exactly where the useful half begins. Every line is
    // pushed through truncateToWidth as a guarantee rather than trusting the
    // arithmetic: guessing two cells too wide does not wrap, it gets
    // hard-clipped by the renderer, and a clip mid-word looks like corrupt
    // text rather than like an ellipsis.
    const w = Math.max(20, width - 10);
    const put = (s: string, more: boolean) =>
      out.push("  " + th.fg("muted", truncateToWidth(more ? `${s} \u2026` : s, w, "\u2026", false)));
    let line = "";
    let clipped = false;
    for (const word of text.split(/\s+/)) {
      if (line && visibleWidth(line) + visibleWidth(word) + 1 > w) {
        if (out.length >= maxLines - 1) { clipped = true; break; }
        put(line, false);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) put(line, clipped);
    return out;
  }

  /** Lays inventory categories out as bordered, content-sized cards.
   * Category title is embedded in the top border (╭─ skills ──╮) so it costs
   * no interior line, and each category keeps its own hue for fast scanning. */
  private renderInventoryCards(innerW: number): string[] {
    const th = this.theme;
    const inv = this.inventory;
    if (!inv) return [];
    const groups: Array<[string, string[], string]> = [
      ["skills", inv.skills, "accent"],
      ["prompts", inv.prompts, "success"],
      ["extensions", inv.extensions, "warning"],
      ["clis", inv.clis, "muted"],
    ];
    const present = groups.filter(([, items]) => items.length > 0);
    if (present.length === 0) return [];

    const cols = innerW >= 150 ? 2 : 1;
    const gutter = 2;
    const cardW = Math.floor((innerW - gutter * (cols - 1)) / cols);
    const textW = cardW - 4;

    const buildCard = ([label, items, hue]: [string, string[], string]): string[] => {
      // Wrap items into lines that fit the card interior.
      const wrapped: string[] = [];
      let cur = "";
      for (const item of items) {
        const next = cur ? `${cur}, ${item}` : item;
        if (visibleWidth(next) > textW && cur) {
          wrapped.push(cur);
          cur = item;
        } else {
          cur = next;
        }
      }
      if (cur) wrapped.push(cur);

      const title = ` ${label} ${th.fg("dim", String(items.length))} `;
      const titleW = visibleWidth(title);
      const fill = Math.max(0, cardW - 2 - titleW - 1);
      const top = th.fg("dim", "\u256d\u2500") + th.fg(hue, title) + th.fg("dim", "\u2500".repeat(fill) + "\u256e");
      const bot = th.fg("dim", `\u2570${"\u2500".repeat(Math.max(0, cardW - 2))}\u256f`);
      const body = wrapped.map((w) => {
        const padded = w + " ".repeat(Math.max(0, textW - visibleWidth(w)));
        return th.fg("dim", "\u2502") + " " + th.fg("dim", padded) + " " + th.fg("dim", "\u2502");
      });
      return [top, ...body, bot];
    };

    const cards = present.map(buildCard);
    const out: string[] = [];
    for (let i = 0; i < cards.length; i += cols) {
      const rowCards = cards.slice(i, i + cols);
      const height = Math.max(...rowCards.map((c) => c.length));
      for (let ln = 0; ln < height; ln++) {
        const segs = rowCards.map((c) => c[ln] ?? " ".repeat(cardW));
        out.push(segs.join(" ".repeat(gutter)));
      }
      if (i + cols < cards.length) out.push("");
    }
    return out;
  }

  invalidate(): void {
    /* no cached state to clear */
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.messageTimer) {
      clearTimeout(this.messageTimer);
      this.messageTimer = undefined;
    }
    if (dashboardView === this) dashboardView = undefined;
  }
}

/** The hub never accepts chat input — the dashboard overlay owns all keyboard
 * focus while open. A visible empty prompt row underneath it doesn't make
 * sense for a dedicated tool, so it's blanked out rather than left showing. */
class BlankEditor extends CustomEditor {
  render(): string[] {
    return [];
  }
}

async function showDashboardOnce(ctx: ExtensionContext): Promise<HubAction | undefined> {
  // The tracker's left-arrow-detach listener stands down while the overlay
  // owns the keyboard (see dashboardOpen at module scope). try/finally rather
  // than an event bus: both sides live in this module, a reload re-evaluates
  // it with the flag correctly false, and there is no listener to leak.
  dashboardOpen = true;
  try {
    return await showDashboardInner(ctx);
  } finally {
    dashboardOpen = false;
  }
}

/** True while this process's own dashboard overlay is open. Raw input
 * listeners run BEFORE overlay/focus routing in pi-tui, and the editor under
 * an overlay is empty by construction — so without this gate, pressing
 * left-arrow while browsing dashboard rows sailed through the empty-prompt
 * check and silently detached the client out from under the dashboard the
 * user was looking at. */
let dashboardOpen = false;
/** The live DashboardView, while one is open. The hub's /jobs command routes
 * through this to open the jobs panel; cleared on dispose. */
let dashboardView: DashboardView | undefined;

async function showDashboardInner(ctx: ExtensionContext): Promise<HubAction | undefined> {
  // render(width) is given a width and no height, so the view cannot fit
  // itself to the terminal on its own. `visible` is the one hook called every
  // render cycle WITH both dimensions: capture the height there and always
  // return true. Reading process.stdout.rows instead would miss resizes on a
  // multiplexed or piped stdout, and this number is the one the layout engine
  // is itself using.
  // Runs once per boot generation (guarded on disk, see REBOOT_RECOVERY_FILE),
  // synchronously, before the first frame paints — so a restart-orphaned
  // fleet is already back by the time the dashboard is visible, not restored
  // out from under a rendered "exited" row a moment later.
  const recovery = restoreRebootOrphans();
  const initialMessage = recovery.restored > 0
    ? `Restored ${recovery.restored} session${recovery.restored === 1 ? "" : "s"} after a restart.${recovery.failed > 0 ? ` ${recovery.failed} could not be restored.` : ""}`
    : undefined;
  let view: DashboardView | undefined;
  return ctx.ui.custom<HubAction | undefined>(
    (tui, theme, _keybindings, done) => {
      view = new DashboardView(tui, theme, done, ctx.sessionManager, ctx.cwd, initialMessage,
        (body) => notifyDetached(ctx, body));
      dashboardView = view;
      return view;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-center",
        width: "100%",
        maxHeight: "100%",
        visible: (w, h) => { view?.setTermSize(w, h); return true; },
      },
    },
  );
}

/** Moves the caller to a session, by whichever route is available.
 *
 * Inside tmux there is no terminal-ownership problem at all: `switch-client`
 * relocates tmux's own client, so no second process ever contends for the tty,
 * and the calling session keeps running in its own tmux session rather than
 * being exited. That makes it strictly better than the wrapper handoff, and it
 * is the only route that works for someone who installed the extension through
 * `pi install` and therefore has no wrapper on PATH.
 *
 * Outside tmux the wrapper is still required, because a process cannot hand its
 * controlling terminal to a child without both fighting over stdin. */
/** Confirms a tmux session really is the one running `expectedPid`, by asking
 * tmux about that session directly instead of trusting a line from a bulk
 * listing. The listing can be polluted by a forged row; a targeted query cannot,
 * because a session that does not exist returns nothing and a session the
 * attacker does own reports its own pid. */
function tmuxSessionOwnsPid(name: string, expectedPid: number): boolean {
  if (!expectedPid) return false;
  const r = spawnSync(TMUX, ["display-message", "-p", "-t", name, "#{pane_pid}"], { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) return false;
  return Number(String(r.stdout || "").trim()) === expectedPid;
}

function goToSession(action: HubAction): boolean {
  if (action.type === "attach" && process.env.TMUX) {
    // Re-verify against tmux before moving the user. buildRows worked from a
    // bulk listing that a forged row can pollute; this asks about the one
    // session we are about to enter.
    if (action.expectedPid !== undefined && !tmuxSessionOwnsPid(action.tmuxName, action.expectedPid)) {
      return false;
    }
    const r = spawnSync(TMUX, ["switch-client", "-t", action.tmuxName], { encoding: "utf8", timeout: 3000 });
    if (r.status === 0) return true;
    // Fall through: switch-client fails if the target died between listing and
    // selection, and the wrapper path reports that more usefully.
  }
  return requestWrapperAction(action);
}

/** Creates the session if needed, then moves the caller into it. Returns false
 * when neither route is available, so the caller can tell the user what to run. */
function dispatchHubAction(action: HubAction): { deferred: boolean; message?: string; level?: "info" | "error" } {
  if (action.type === "create") {
    const created = createTmuxSession(action.name, action.dir, undefined, action.size);
    if (!created.ok) return { deferred: false, message: created.message };
    return { deferred: goToSession({ type: "attach", tmuxName: action.name }), message: created.message };
  }
  if (action.type === "dispatch") {
    // Runs with the dashboard overlay CLOSED, which is why it may block: it
    // waits for the new session's composer to come up (tens of seconds on a
    // cold start) and then verifies the prompt actually landed. Returning
    // deferred:false sends the hub loop straight back to the dashboard, so
    // the user's next sight is the fleet with the new session in it.
    const r = dispatchSession({ name: action.name, task: action.task, cwd: action.dir, liveSize: action.size });
    return { deferred: false, message: r.message, level: r.ok && r.delivery?.state === "submitted" ? "info" : "error" };
  }
  return { deferred: goToSession(action) };
}

/* ------------------------------------------------- self-tracking ---------- */
/**
 * pi-king tracks its own session state from stock Pi lifecycle events and
 * writes its own status file. It deliberately depends on nothing but Pi:
 * no notification extension, no subagent package, no terminal-specific tools.
 * Optional integrations are feature-detected and degrade to absent.
 */
/** True only when this session lives in tmux AND no client is attached —
 * the one situation where the user cannot be watching this terminal.
 * undefined = not in tmux, or tmux did not answer; treated as attended,
 * because notifying someone who is already looking is noise. Hoisted to
 * module scope so the jobs panel's macOS fallback notification can share
 * it (see showDashboardInner). */
function detachedInTmux(): boolean {
  if (!process.env.TMUX) return false;
  try {
    const r = spawnSync(TMUX, ["display-message", "-p", "#{session_attached}"], { encoding: "utf8", timeout: 2000 });
    return r.status === 0 && String(r.stdout || "").trim() === "0";
  } catch { return false; }
}
let osascriptOk: boolean | undefined;
/** Desktop notification, only when nobody is watching (in tmux, detached).
 * Attached-session alerting belongs to whatever notifier the user runs;
 * this fires precisely in the gap that tool cannot see a need for.
 * stdlib-only: osascript on macOS, feature-detected once; elsewhere this is
 * a no-op rather than a dependency. Text goes through argv, never spliced
 * into the AppleScript source — prompts are attacker-adjacent input. */
function notifyDetached(ctx: ExtensionContext, body: string): void {
  if (process.platform !== "darwin" || !detachedInTmux()) return;
  if (osascriptOk === undefined) osascriptOk = existsSync("/usr/bin/osascript");
  if (!osascriptOk) return;
  const title = `Pi — ${ctx.sessionManager.getSessionName() ?? basename(ctx.cwd)}`;
  try {
    const child = spawn("/usr/bin/osascript", [
      "-e", "on run argv\n  display notification (item 1 of argv) with title (item 2 of argv)\nend run",
      clean(body).slice(0, 200), title,
    ], { stdio: "ignore" });
    child.unref();
  } catch { /* notification is best-effort, never worth disturbing the session */ }
}

function installSessionTracker(pi: ExtensionAPI) {
  let state: TitleState = "idle";
  let activity = "Session started.";
  let visible = process.env.PI_DASHBOARD_SPAWNED === "1";
  // The card's startedAt participates in the dashboard's IDENTITY check: pid
  // plus process start time, 60s tolerance, so a recycled pid cannot wear a
  // dead session's card. That means startedAt must be the PROCESS's birth,
  // never "when this extension instance initialised": /reload rebuilds the
  // ExtensionRunner and re-fires session_start hours into a process's life,
  // and stamping Date.now() there made every reloaded session fail its own
  // identity check — alive, working, and rendered as exited beside its own
  // tmux session as an orphan (observed live: a reloaded session 12.5h old
  // carried a card 44,888s newer than its ps lstart). Derived from uptime,
  // the value is identical no matter how many times this module re-evaluates.
  const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;
  let startedAt = PROCESS_STARTED_AT;
  // Stamped fresh in session_start below ONLY on a genuine process start
  // (reason !== "reload"), and preserved across /reload of the same
  // sessionId by the restore block: a reload re-imports extensions and
  // skills but does NOT re-run startup pi.registerProvider()/model-scope
  // construction, so the process's effective startup inputs are still the
  // launch-time ones. Persisted with every snapshot so the dashboard can
  // compare it against a fresh read of its own, without this session doing
  // anything beyond what it already does on every status write.
  let startupFingerprint: string | undefined;
  // Determined fresh in session_start whenever the sessionId itself changes
  // (a genuinely new/forked/resumed transcript), and otherwise RESTORED from
  // the card rather than recomputed -- see the restore block below and the
  // DashboardEntry.isFork comment for why: this same handler also fires on
  // every later /reload of this exact sessionId, with reason "reload" not
  // "fork", and recomputing from reason on every firing would silently wipe
  // the fact the moment a forked session is itself reloaded.
  let isFork = false;
  let hadRun = false;
  /** Set when /bg is requested mid-turn; fires the moment the session settles. */
  let bgQueued = false;
  /** True once another process has taken ownership of this session id.
   * Handoff resumes the SAME id, so the replacement writes the SAME status
   * file. Without this flag our shutdown hook then deletes the file the new
   * process just wrote, and the session vanishes from the dashboard despite
   * running perfectly — observed exactly that. */
  let handedOff = false;
  /** Timers we own. Pi replaces the whole ExtensionRunner on /reload and does
   * not unwind side effects made outside its registries, so anything started
   * here must be cleared in session_shutdown or it survives as a zombie
   * alongside the freshly loaded instance. */
  const timers = new Set<ReturnType<typeof setInterval>>();
  const subagents = new Map<string, SubagentStatus>();
  /** Unsubscribes the left-arrow → detach listener registered in session_start.
   * Cleared in session_shutdown alongside timers, for the same reason: /reload
   * rebuilds the ExtensionRunner but does not unwind hooks registered outside
   * its own registries, so a stale listener would survive as a zombie
   * alongside the freshly loaded instance and fire twice. */
  let unsubscribeLeftArrow: (() => void) | undefined;
  /** The prompt that started the current turn, kept so settling can say what
   * finished instead of erasing it with a generic "Waiting for input.". */
  let lastPrompt = "";
  let ctxRef: ExtensionContext | undefined;

  const isInteractive = (ctx: ExtensionContext) =>
    ctx.mode === "tui" && Boolean(ctx.sessionManager.getSessionFile());
  const statusPath = (ctx: ExtensionContext) =>
    join(SESSION_STATUS_DIR, `${ctx.sessionManager.getSessionId()}.json`);

  function persist(ctx: ExtensionContext): void {
    if (!isInteractive(ctx)) return;
    // Once handed off, the card belongs to the successor. This process lives
    // on for a moment while the TUI winds down, and any settle or message
    // event in that window would otherwise stamp this dead-to-be pid over the
    // new process's card — the dashboard then shows an exited session beside
    // a live orphan tmux, which is what it did.
    if (handedOff) return;
    try {
      // 0700/0600: these files carry session names, absolute working directories and
      // pids. Default permissions expose all of that to every other account on a
      // shared host for no benefit; nothing but this user needs to read them.
      mkdirSync(SESSION_STATUS_DIR, { recursive: true, mode: 0o700 });
      const cutoff = Date.now() - 5 * 60_000;
      for (const [id, s] of subagents) if (s.completedAt && s.completedAt < cutoff) subagents.delete(id);
      let contextPct: number | undefined;
      try {
        const u = ctx.getContextUsage();
        if (u && typeof u.percent === "number" && Number.isFinite(u.percent)) contextPct = Math.round(u.percent);
      } catch { /* absent is honest; zero would be a lie */ }
      const snap: SessionStatusFile = {
        formatVersion: 1,
        id: ctx.sessionManager.getSessionId(),
        name: ctx.sessionManager.getSessionName(),
        cwd: ctx.cwd,
        project: basename(ctx.cwd) || ctx.cwd,
        model: ctx.model?.id,
        pid: process.pid,
        startedAt,
        lastActivity: Date.now(),
        status: state,
        activity,
        title: `${iconFor(state)} ${ctx.sessionManager.getSessionName() ?? basename(ctx.cwd)}`,
        sessionFile: ctx.sessionManager.getSessionFile(),
        subagents: [...subagents.values()],
        visible,
        contextPct,
        startupFingerprint,
        isFork,
      };
      const target = statusPath(ctx);
      const tmp = `${target}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
      renameSync(tmp, target);
    } catch {
      // Status is best-effort; it must never disrupt the session it describes.
    }
  }

  const set = (next: TitleState, ctx: ExtensionContext) => { state = next; persist(ctx); };
  /** True when the card on disk is ours to write: absent counts as not ours,
   * because the fix for both cases is the same write. */
  function ownsStatusFile(ctx: ExtensionContext): boolean {
    try {
      const raw = JSON.parse(readFileSync(statusPath(ctx), "utf8")) as { pid?: number };
      return raw.pid === process.pid;
    } catch {
      return false;
    }
  }

  pi.on("session_start", (e, ctx) => {
    if (!isInteractive(ctx)) return;
    ctxRef = ctx;
    state = "idle"; activity = "Session started."; startedAt = PROCESS_STARTED_AT;
    hadRun = false; bgQueued = false; subagents.clear();
    // Fresh guess for a sessionId never seen before (fork/new/resume/startup
    // all land here on first read-failure below); overwritten from the card
    // just below when this is instead a reload of a sessionId already ours.
    isFork = e.reason === "fork";
    visible = process.env.PI_DASHBOARD_SPAWNED === "1";
    // One read of our own card serves two purposes, and it MUST happen before
    // the first persist() — persist() stamps our own pid into that card, so
    // reading afterwards can only ever see ourselves. (The collision guard
    // shipped with the order reversed and was dead on arrival: the one
    // incident it existed for sailed straight past it.)
    //
    // Purpose one, collision: if another LIVE process claims this session id,
    // a resume is about to put two processes on one transcript — say so.
    //
    // Purpose two, continuity: if the card is OURS — same pid, meaning this
    // start is a /reload or a same-process session switch, not a fresh launch
    // — the card is the durable state and this handler's defaults above are
    // amnesia. Restoring visible closes a real hole: /bg sets visible=true at
    // runtime, but the env var this handler consults reflects only how the
    // process was LAUNCHED, so a reload used to silently drop a /bg'd session
    // off the dashboard. State and activity are restored for the same reason
    // at lower stakes: a session that was attention/'Done: fix the parser'
    // should not greet a returning user as 'idle/Session started.'.
    try {
      // Read the file directly rather than the dashboard listing, which
      // filters to sessions marked visible and would miss a duplicate.
      const myId = ctx.sessionManager.getSessionId();
      const card = JSON.parse(readFileSync(join(SESSION_STATUS_DIR, `${myId}.json`), "utf8")) as SessionStatusFile;
      const owner = Number(card.pid) || 0;
      if (owner && owner !== process.pid && livePiPids([owner])?.has(owner)) {
        ctx.ui.notify(
          `Session ${myId.slice(0, 8)} is already running as pid ${owner}. ` +
          `Two processes appending to one transcript will corrupt its history. ` +
          `Attach to the existing one rather than continuing here.`,
          "error",
        );
      } else if (owner === process.pid) {
        visible = Boolean(card.visible);
        // Same sessionId as before -- this start's own reason is "reload",
        // not "fork", so the guess just above would be wrong here. The card
        // already recorded whether THIS sessionId originated from a fork,
        // back when it was first created; that fact does not change on a
        // reload and must come from the card, not from this firing's reason.
        isFork = Boolean(card.isFork);
        // Skip death-flavoured activity text: a reload out of an OLD build
        // arrives here with the card already stamped "Ended. Last: …" by that
        // build's shutdown handler, and restoring it verbatim would caption a
        // live session with its own obituary.
        if (typeof card.activity === "string" && card.activity && !card.activity.startsWith("Ended.")) activity = card.activity;
        // exited maps back to idle: we are demonstrably alive. Retired states
        // go through the same translation table the dashboard applies to every
        // other card — restoring is just another read.
        const restored = RETIRED_STATES[card.status] ?? card.status;
        if (isKnownState(restored) && restored !== "exited") state = restored;
        // The subagent roster survives the reload too: the in-memory map is
        // fresh, but the card carries the same records this module wrote a
        // moment ago. Without this, a session reloaded mid-subagent showed
        // idle with its running-agents badge gone, and the completion event
        // later updated an entry that no longer existed.
        for (const s of card.subagents ?? []) {
          if (s && typeof s.id === "string") subagents.set(s.id, s);
        }
        if ((state === "idle") && hasLiveSubagents() > 0) state = "background";
        // Same class as isFork above: the startup fingerprint records what
        // THIS sessionId ran with at process launch, and a reload does not
        // re-run startup registration — preserve the card's stamp rather than
        // recomputing a fresh one that would claim a reload made the process
        // startup-fresh when it did not.
        startupFingerprint = card.startupFingerprint;
      } else if (owner && !livePiPids([owner])?.has(owner)) {
        // Dead predecessor: this is a restart (respawn-pane replacing a dead
        // process) or a plain resume of a transcript whose previous process
        // is gone. Immutable identity facts — dashboard visibility (a /bg'd
        // session must not drop off the dashboard) and fork origin — belong
        // to the sessionId, not the pid, so they survive the process swap.
        // The env var WINS over the old card: a /bg handoff launches the
        // copy with PI_DASHBOARD_SPAWNED=1, but the predecessor card was
        // written by the plain-terminal original (visible=false), and a
        // copy that boots slower than the original's shutdown lands in this
        // branch and previously had its env-driven true clobbered back to
        // false — the session then vanished off the dashboard into "tmux
        // (no Pi session)" (observed live 2026-08-07: codebase and
        // hustle-ops both). The card remains the fallback for plain resumes
        // where the env var is absent.
        visible = process.env.PI_DASHBOARD_SPAWNED === "1" || Boolean(card.visible);
        isFork = Boolean(card.isFork);
        // NOT restored here: state/activity/subagents (they describe a
        // process that is gone) and startupFingerprint (this process DID run
        // startup registration — it gets a fresh stamp below).
      }
    } catch { /* no file, unreadable, or first run: nothing to warn about */ }
    // Stamped here, at the end of session_start rather than the top: this is
    // as close as this handler gets to "extension setup for this run is
    // done", the same reasoning /reload's own comments elsewhere in this
    // handler already apply to state/activity/subagents restoration above.
    // A reload preserves the card's stamp (restored above — the process did
    // not re-run startup registration). A fork inherits its parent's stamp:
    // it shares this process, so it shares the parent's launch-time startup
    // inputs — claiming a fresh compute would silently hide a stale parent's
    // missing providers behind a badge-free fork card. Only a genuinely
    // fresh process start (startup/new/resume, including a restart via
    // respawn-pane) computes a new one.
    if (e.reason === "fork") {
      // First choice: this process's own stamp. The fork is the SAME process
      // (same pid, same tmux pane), so if the module was not re-evaluated for
      // the fork, the closure variable still holds the exact stamp this
      // process stamped at launch — the true source of truth, no filesystem
      // involved (Red review: "the process already knows its own startup
      // fingerprint"). If the module WAS re-evaluated (the closure is fresh
      // undefined), fall back to the parent's card: the parent session id is
      // embedded in the previous session file name <timestamp>_<id>.jsonl,
      // and its card (still live, or already exited by the fork's own
      // shutdown — exited cards keep their fields) carries the stamp.
      if (startupFingerprint === undefined && typeof e.previousSessionFile === "string") {
        const m = /_([0-9a-f-]+)\.jsonl$/.exec(e.previousSessionFile);
        if (m) {
          try {
            const parent = JSON.parse(readFileSync(join(SESSION_STATUS_DIR, `${m[1]}.json`), "utf8")) as SessionStatusFile;
            startupFingerprint = parent.startupFingerprint;
          } catch { /* parent card gone: leave unstamped — the dashboard reads
                     that as restart-needed, the safe direction */ }
        }
      }
    } else if (e.reason !== "reload") {
      startupFingerprint = computeStartupFingerprint(ctx.cwd);
    }
    persist(ctx);

    // Left-arrow at an empty prompt detaches this pane's tmux client — a
    // second, gated route back to the dashboard alongside Cmd+Esc, replacing
    // the tmux-level F12 binding this project used to ship (~/.tmux.conf).
    //
    // F12 worked because tmux's `-n` (no-prefix) binding fires unconditionally
    // on every keypress in every pane, and function keys are never claimed by
    // an interactive program, so nothing was ever lost by taking F12 away from
    // the terminal. A bare arrow key has no such guarantee: it is the single
    // most commonly used key in any text-editing context, including this very
    // composer. Binding it at the tmux level, unconditionally, would swallow
    // every left-arrow keystroke in the pane forever — cursor movement inside
    // Pi's own prompt, inside vim, inside shell line-editing, everywhere.
    //
    // So this is NOT a tmux binding. It is registered here, inside the running
    // Pi session, gated on `getEditorText() === ""` exactly like pi-subagents'
    // own fleet-list activator (verified by reading its source) — the same
    // pattern that already proves this is safe: outside an empty prompt the
    // handler declines and the key reaches the editor untouched.
    //
    // Trade-off, stated rather than hidden: unlike F12, this only exists while
    // a Pi session with this extension loaded is actually running and idle in
    // the pane. Drop to a bare shell in that same pane (exit Pi, or a
    // subprocess is running) and there is no quick detach left except tmux's
    // own default `prefix d`. F12 covered that case; this does not.
    if (unsubscribeLeftArrow) { unsubscribeLeftArrow(); unsubscribeLeftArrow = undefined; }
    unsubscribeLeftArrow = ctx.ui.onTerminalInput((data) => {
      // The kitty keyboard protocol reports both press and release for the
      // same physical keystroke; matchesKey matches either, so acting on both
      // would detach twice per press. Act on press only.
      if (isKeyRelease(data)) return undefined;
      if (!matchesKey(data, "left")) return undefined;
      if (dashboardOpen) return undefined;
      if (ctx.ui.getEditorText() !== "") return undefined;
      if (!process.env.TMUX) return undefined;
      // No explicit target: tmux resolves "the current client" from this
      // process's own $TMUX context, exactly as running `tmux detach-client`
      // by hand inside this same pane would — the identical effect F12 had,
      // just reached through a gated key instead of an unconditional one.
      spawnSync(TMUX, ["detach-client"], { encoding: "utf8", timeout: 3000 });
      return { consume: true };
    });

    // Retry briefly: on a resumed session the session file may not resolve on
    // the first tick, and an idle session produces no further events to
    // piggyback on. Cheap, bounded, and stops as soon as a write lands.
    let attempts = 0;
    const settle = setInterval(() => {
      attempts++;
      try {
        if (isInteractive(ctx)) { persist(ctx); clearInterval(settle); timers.delete(settle); }
      } catch { /* keep trying */ }
      if (attempts >= 10) { clearInterval(settle); timers.delete(settle); }
    }, 1000);
    timers.add(settle);

    // Heartbeat. A supervisor prunes status files whose owner looks dead, and
    // that judgement can be wrong — a session mid-handoff briefly advertises
    // the pid of the process that just exited. Without this one bad prune
    // makes a live session invisible permanently, since an idle session emits
    // no further events to trigger another write. Re-assert only when the file
    // is actually missing, so steady-state cost is a single stat.
    const heartbeat = setInterval(() => {
      try {
        if (handedOff || !isInteractive(ctx)) return;
        // Reclaim the card if it is missing OR if it is not ours. "Missing"
        // alone was sufficient only while the supervisor pruned dead cards:
        // it deleted a stale one, the file vanished, and this rewrote it.
        // Cards are never deleted now, so a stale card from this session's
        // PREVIOUS process (a /bg handoff resumes the same id, so the same
        // path) would otherwise sit there reading "exited" with a dead pid
        // while this very process runs — which is precisely what the
        // dashboard then shows: an exited card beside an orphan tmux session.
        // Same path means same session id, so a foreign pid here is always a
        // predecessor of ours, never a rival.
        if (!ownsStatusFile(ctx)) persist(ctx);
        // Attention means "finished while nobody was attached". The moment a
        // client attaches, the user has seen it — typing is not required to
        // acknowledge a result you read with your eyes.
        if (state === "attention" && process.env.TMUX && !detachedInTmux()) {
          set("idle", ctx);
        }
      } catch { /* transient fs error; retry next tick */ }
    }, 15000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    timers.add(heartbeat);

    // Optional: subagent rollup, only if a subagent extension is present.
    // Absent on a stock install, and its absence is not an error.
    try {
      const track = (status: SubagentStatus["status"]) => (data: unknown) => {
        const a = data as { id?: string; type?: string; description?: string };
        if (!a?.id || !ctxRef) return;
        const prev = subagents.get(a.id);
        subagents.set(a.id, {
          id: a.id,
          agentType: a.type ?? prev?.agentType,
          description: (a.description ?? prev?.description ?? "background agent").slice(0, 100),
          status,
          startedAt: prev?.startedAt ?? Date.now(),
          completedAt: status === "completed" || status === "failed" ? Date.now() : undefined,
        });
        if (status === "completed" || status === "failed") {
          state = "attention";
          notifyDetached(ctxRef, `Subagent ${status}: ${(a.description ?? "background agent").slice(0, 80)}`);
        }
        persist(ctxRef);
      };
      pi.events?.on?.("subagents:created", track("queued"));
      pi.events?.on?.("subagents:started", track("running"));
      pi.events?.on?.("subagents:completed", track("completed"));
      pi.events?.on?.("subagents:failed", track("failed"));
    } catch {
      // No subagent extension installed — rollup simply stays empty.
    }
  });

  pi.on("before_agent_start", (e, ctx) => {
    if (!isInteractive(ctx)) return;
    const p = typeof e.prompt === "string" ? e.prompt.trim() : "";
    if (p) {
      lastPrompt = p.length > 140 ? `${p.slice(0, 139)}\u2026` : p;
      activity = lastPrompt;
    }
    // A new prompt means the user is here; whatever demanded attention got it.
  });
  pi.on("agent_start", (_e, ctx) => { if (isInteractive(ctx)) { hadRun = true; set("working", ctx); } });
  // No approval detection. Pi exposes no "waiting for approval" event, and the
  // gap between tool_call and tool_execution_start looked like a usable proxy:
  // an auto-approved tool crosses it in milliseconds, so a call still sitting
  // there after two seconds ought to mean a human is being asked.
  //
  // It does not. Measured against a 25-second bash command that was never
  // gated, the session reported "Approval needed: bash" for twenty-two of
  // those seconds. Whatever clears that gap does not arrive in time to be
  // relied on, so the inference gave a confident wrong answer about the most
  // ordinary thing a session does: run a slow command.
  //
  // A dashboard that says "go approve something" when nothing is waiting is
  // worse than one that stays quiet: it spends attention, and it hides the
  // true state, which was simply "working". Missing data renders as nothing
  // here. When Pi emits a real approval event this becomes three lines.
  pi.on("tool_execution_end", (e, ctx) => {
    if (!isInteractive(ctx) || !e.isError) return;
    activity = `${e.toolName} failed`;
    set("error", ctx);
    notifyDetached(ctx, `${e.toolName} failed`);
  });
  pi.on("after_provider_response", (e, ctx) => {
    if (!isInteractive(ctx) || e.status < 400) return;
    activity = `Provider error: HTTP ${e.status}`;
    set("error", ctx);
    notifyDetached(ctx, `Provider error: HTTP ${e.status}`);
  });
  pi.on("message_end", (e, ctx) => {
    if (!isInteractive(ctx)) return;
    const m = e.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (!m || m.role !== "assistant") return;
    // The assistant produced output, so no tool call is sitting at a dialog —
    // including a call the user just denied, which never executes and would
    // otherwise leave the trust state stuck.
    const failure = m.stopReason === "error"
      ? (m.errorMessage || "Provider/agent request failed")
      : /^(length|max_tokens|max_output_tokens)$/i.test(String(m.stopReason ?? ""))
        ? `Output ceiling reached (${m.stopReason})` : undefined;
    if (failure) {
      activity = failure.length > 140 ? `${failure.slice(0, 139)}\u2026` : failure;
      set("error", ctx);
      notifyDetached(ctx, failure);
      return;
    }
    // A later successful assistant message means an earlier transient error
    // (an auto-retried provider hiccup) already resolved itself.
    if (state === "error") set("working", ctx);
  });
  pi.on("agent_settled", (_e, ctx) => {
    if (!isInteractive(ctx) || !hadRun) return;
    // Say what finished, not that nothing is happening. The returning user's
    // first question is "what did it just do", and the prompt is the best
    // one-line answer this file has without fabricating a summary.
    activity = lastPrompt ? `Done: ${lastPrompt}` : "Waiting for input.";
    if (state !== "error" && state !== "attention") {
      if (hasLiveSubagents() > 0) {
        // Settled at the prompt, but subagents are still running on this
        // session's behalf: neither working nor idle. No notification either
        // way — nothing needs the user yet, and the subagent-completion
        // handler below raises attention (and notifies, if detached) the
        // moment one actually finishes.
        set("background", ctx);
      } else if (detachedInTmux()) {
        // Finishing while nobody is attached is the event this tool exists
        // for. Attended settling stays a quiet idle; unattended settling must
        // survive until the user actually comes back (see the heartbeat,
        // which demotes it once a client attaches).
        set("attention", ctx);
        notifyDetached(ctx, activity);
      } else {
        set("idle", ctx);
      }
    } else {
      persist(ctx);
    }
    // Deferred /bg: run it now that nothing is in flight.
    if (bgQueued) { bgQueued = false; void runBackgroundHandoff(ctx); }
  });
  pi.on("session_shutdown", (e, ctx) => {
    // Fires for reason "reload" as well as a real exit — which is precisely
    // when orphaned timers would otherwise accumulate, since Pi builds a new
    // ExtensionRunner and never unwinds side effects made outside its own
    // registries. Clear unconditionally, before any early return.
    for (const t of timers) clearInterval(t);
    timers.clear();
    if (unsubscribeLeftArrow) { unsubscribeLeftArrow(); unsubscribeLeftArrow = undefined; }
    // A reload is not a death. The process survives, the session id stays
    // served, and the new runner's session_start re-persists within the same
    // second — but between the old runner's "exited" stamp and that rewrite
    // there was a window in which the dashboard read a live session as a
    // corpse. Tonight's duplicate-process incident walked in through exactly
    // that window. On reload, leave the card precisely as it is: cleanup
    // above, nothing else. Every other reason (quit, new, resume, fork) means
    // this process genuinely stops serving the transcript, and the exited
    // stamp below is the truth.
    if (e.reason === "reload") return;
    if (!isInteractive(ctx)) return;
    // Do not touch the file if a handoff transferred this id to another
    // process; that file is now theirs, not ours.
    if (handedOff) return;
    // Never clobber a card another process already owns. A handoff resumes
    // the same session id, so the successor writes the SAME path: if it has
    // already claimed the card, this exiting process writing "exited" over it
    // would kill a session that is running fine — the mirror image of the
    // stale-card bug, and the reason the ordering of these two exits cannot be
    // relied on.
    if (!ownsStatusFile(ctx)) return;
    // A session that never appeared on the dashboard leaves nothing behind:
    // its card was invisible, so an exited card would be unreachable — a file
    // that accumulates forever with no way to see or dismiss it. The
    // transcript itself is Pi's and survives regardless.
    if (!visible) {
      try { unlinkSync(statusPath(ctx)); } catch { /* already gone */ }
      return;
    }
    // The card outlives the process. It is the only pointer that knows how to
    // resume this transcript, and deleting it on exit made every ended session
    // unreachable from the dashboard. Written as exited rather than left at
    // whatever state was current, so a crash and a clean quit read the same.
    state = "exited";
    activity = lastPrompt ? `Ended. Last: ${lastPrompt}` : "Session ended.";
    persist(ctx);
  });

  function hasLiveSubagents(): number {
    return [...subagents.values()].filter((s) => s.status === "running" || s.status === "queued").length;
  }

  async function runBackgroundHandoff(ctx: ExtensionContext): Promise<void> {
    if (process.env.TMUX) {
      visible = true; persist(ctx);
      ctx.ui.notify("Already under tmux \u2014 now visible on the pi-king dashboard.", "info");
      return;
    }
    // TMUX is resolved at module load; probe it rather than re-resolving, so
    // this agrees with what every other tmux call in the file will use.
    const probe = spawnSync(TMUX, ["-V"], { encoding: "utf8", timeout: 3000 });
    const tmux = probe.status === 0 ? TMUX : "";
    if (!tmux) {
      visible = true; persist(ctx);
      ctx.ui.notify("tmux not found on PATH \u2014 surfaced on the dashboard, but this session still ends with its terminal.", "warning");
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const name = clean(ctx.sessionManager.getSessionName() || `${basename(ctx.cwd) || "session"}-${sessionId.slice(0, 8)}`)
      // tmux's -t argument is a TARGET, not a name: '.' and ':' are its
      // window and pane separators. A session legitimately created as
      // "foo.bar" cannot then be found by `has-session -t foo.bar`, which
      // reads as a handoff that failed while the copy is in fact alive — two
      // processes on one transcript, the exact damage the collision guard
      // exists to warn about. Replace them at the source.
      .replace(/[.:]/g, "-").trim() || `session-${sessionId.slice(0, 8)}`;
    if (tmuxSessionExists(tmux, name)) {
      ctx.ui.notify(`A tmux session named "${name}" already exists \u2014 not creating a duplicate. Attach to it from pi-king.`, "warning");
      return;
    }
    // A session that has never received a prompt has no transcript JSONL yet.
    // The copy runs `pi --session <id>`, which fails with "No session found
    // matching" when the JSONL does not exist, and dies immediately — /bg then
    // misreports it as a handoff failure and kills the tmux session it just
    // created. Same hazard restartTmuxPane guards against; same fix: verify
    // resumability from the card before spawning anything.
    try {
      const card = JSON.parse(readFileSync(join(SESSION_STATUS_DIR, `${sessionId}.json`), "utf8")) as { sessionFile?: string };
      if (typeof card.sessionFile !== "string" || !existsSync(card.sessionFile)) {
        visible = true; persist(ctx);
        ctx.ui.notify("Nothing to hand off yet \u2014 send a first prompt so the transcript exists, then try /bg again.", "warning");
        return;
      }
    } catch {
      visible = true; persist(ctx);
      ctx.ui.notify("No status card for this session \u2014 cannot background yet. Try again after the session has started.", "warning");
      return;
    }
    const created = spawnSync(tmux, [
      "new-session", "-d", "-s", name,
      "-e", "PI_DASHBOARD_SPAWNED=1",
      // Pin the agent dir explicitly. A new tmux session inherits the tmux
      // SERVER's environment, not ours \u2014 and that server may have been started
      // by a process using a different PI_CODING_AGENT_DIR (the pi-king hub
      // runs against a minimal one). The resumed Pi would then look for this
      // session's transcript under the wrong root, fail to find it, and exit
      // instantly. Verified: inheriting the hub's dir DIES, passing ours SURVIVES.
      "-e", `PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent")}`,
      // Same reasoning for PATH: the server may not have ours.
      "-e", `PATH=${process.env.PATH ?? ""}`,
      // And for the status directory. Without this the resumed session writes
      // its status file to the default location while the supervisor that
      // handed it off reads an overridden one, so a successfully backgrounded
      // session never appears on the dashboard that backgrounded it.
      ...(process.env.PI_KING_STATUS_DIR?.trim()
        ? ["-e", `PI_KING_STATUS_DIR=${process.env.PI_KING_STATUS_DIR.trim()}`]
        : []),
      // The child reads its own usage figures from here. Unpinned, a session
      // backgrounded from a shell that exports it lands in a tmux server that
      // does not, and its metrics band goes blank for no visible reason.
      ...(process.env.PI_KING_CALL_LOGS?.trim()
        ? ["-e", `PI_KING_CALL_LOGS=${process.env.PI_KING_CALL_LOGS.trim()}`]
        : []),
      // HOME decides where Pi looks for everything. A server started under a
      // different HOME resolves a different transcript root, which fails the
      // same way the agent dir did.
      ...(process.env.HOME ? ["-e", `HOME=${process.env.HOME}`] : []),
      "-c", ctx.cwd, "--", PI_BIN, "--session", sessionId, "--name", name,
    ], { encoding: "utf8", timeout: 8000 });
    if (created.status !== 0) {
      ctx.ui.notify(`Could not hand off to tmux: ${String(created.stderr || "unknown").trim()}`, "error");
      return;
    }
    // Verify the replacement actually survived before destroying this copy.
    await new Promise((r) => setTimeout(r, 2500));
    if (!tmuxSessionExists(tmux, name)) {
      // Nothing to clean up in this branch — the session is gone, which is how
      // we got here. But if it half-exists (created, then died leaving a shell)
      // it would block every later attempt with a false "already exists", so
      // clear the name unconditionally rather than reasoning about which.
      spawnSync(tmux, ["kill-session", "-t", `=${name}`], { encoding: "utf8", timeout: 3000 });
      ctx.ui.notify("Handoff failed \u2014 the tmux copy exited immediately, so this session was kept alive. Try /bg again.", "error");
      return;
    }
    // Ownership of this session id now belongs to the tmux-hosted process.
    // Deliberately do NOT unlink: it has already written its own status under
    // this same id, and removing it here would erase a live session.
    handedOff = true;
    // Deliberately does NOT open the dashboard for you.
    //
    // When Pi exits, the shell reclaims the terminal. Anything we leave behind
    // then fights the shell for stdin \u2014 observed as interleaved, corrupted
    // rendering. Node cannot exec-replace itself, so the only way to win that
    // race is a wrapper process, and a second command to remember is worse
    // than typing `pi-king` when you actually want it.
    ctx.ui.notify(
      `Backgrounded as "${name}" \u2014 history came with it.\n` +
      `Reattach from pi-king, or: tmux attach -t ${name}`,
      "info",
    );
    setTimeout(() => ctx.shutdown(), 1200);
  }

  // ---- arc: spawn a fresh child session for one unit of work ----------------
  // Rationale in src/arc.ts. Short version: pi's render cost scales with
  // retained session size (upstream #6665, core fix only), /fork and /clone
  // COPY history so they cannot make a small session, and a header-only seed
  // file with a parentSession pointer produces a child that is both EMPTY and
  // correctly parented in /resume's tree.
  pi.registerTool({
    name: "arc_spawn",
    label: "Spawn arc",
    description:
      "Spawn a NEW, empty, fast child session in its own tmux window to carry out one unit of work (an 'arc'), linked back to this session. " +
      "Use when work is substantial enough to run many turns — a feature, a spec, a phase, an investigation — rather than something answerable here. " +
      "The child starts with NO history: the brief is everything it will know, so it must be self-contained (what to build, where, what done looks like, what to read first). " +
      "The child appears indented under this session in /resume and as its own window in pi-king, and the user steers it directly there. " +
      "It does NOT report back automatically — the user decides when it is done.",
    promptSnippet: "arc_spawn: hand a substantial unit of work to a fresh child session instead of growing this one",
    promptGuidelines: [
      "Session hygiene: this agent's typing and render latency scale with how much history the session retains, and that cost is permanent — it cannot be compacted away. Before starting substantial multi-turn work (a feature, a spec, a phase, a long investigation), offer to spawn an arc with arc_spawn instead of doing it inline.",
      "Write the arc brief as if for someone who has never seen this conversation, because that is literally true — the child inherits no history. State the goal, the working directory, what to read first (AGENTS.md, any spec or state file), what 'done' means, and any constraint that would otherwise be discovered the hard way.",
      "Do not spawn an arc for something you can finish in a turn or two; the overhead is not worth it. Do not spawn one silently either — say what you are spawning and why.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short window name for the arc, e.g. 'search-api'. Becomes the tmux session name." }),
      brief: Type.String({ description: "The FIRST PROMPT sent to the child. Self-contained: goal, what to read first, definition of done, constraints. The child knows nothing else." }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the arc. Defaults to this session's cwd." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const cwd = params.cwd || ctx.cwd;
      const r = spawnArc({
        name: params.name,
        brief: params.brief,
        cwd,
        parentSessionFile: ctx.sessionManager.getSessionFile(),
        parentId: ctx.sessionManager.getSessionId(),
      });
      return { content: [{ type: "text", text: r.message }], details: {} };
    },
  });

  pi.registerTool({
    name: "arc_digest",
    label: "Digest arc",
    description:
      "Prepare a finished arc's transcript for digestion. Strips tool calls/results (measured: 85% of a transcript's bytes) and writes ONLY the conversation to a file, returning its PATH — never its contents. " +
      "Hand that path to a subagent to distill decisions, rationale, caveats and dead ends; do NOT read the file into this session, which would defeat the point of having split the work out.",
    promptSnippet: "arc_digest: prepare a finished arc's transcript for a subagent to distill",
    parameters: Type.Object({
      arc: Type.String({ description: "Arc name, session id, or id prefix." }),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      const a = findArc(params.arc);
      if (!a) return { content: [{ type: "text", text: `No arc matching "${params.arc}".` }], details: {} };
      if (!existsSync(a.sessionFile)) return { content: [{ type: "text", text: `Arc "${a.name}" has no transcript on disk at ${a.sessionFile}.` }], details: {} };
      const x = extractConversation(a.sessionFile);
      const out = join(homedir(), ".pi", "king", `arc-digest-${a.id}.txt`);
      writeFileSync(out, `# arc: ${a.name}\n# brief given to it:\n${a.brief}\n\n---- transcript (conversation only) ----\n\n${x.text}`);
      const text =
          `Wrote ${a.name}'s conversation to ${out} ` +
          `(${(x.keptChars / 1024).toFixed(0)} KB kept from a ${(x.rawBytes / 1048576).toFixed(1)} MB transcript` +
          `${x.truncated ? ", TRUNCATED to the most recent portion — the arc was scoped too big" : ""}).\n` +
          `Now delegate to a subagent: have it read that file and write the distilled decisions, rationale, caveats and dead ends into the project repo. ` +
          `Do not read the file yourself.`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerCommand("arc", {
    description: "Jump to an arc spawned from this session (pi-king). `/arc close <name>` marks one done.",
    handler: async (args, ctx) => {
      if (!isInteractive(ctx)) return;
      // Bookkeeping only: closing flags the arc in lineage.json so /arc stops
      // offering it as live work. The window and transcript are left alone.
      const closeTarget = args.trim().replace(/^close\s*/, "");
      if (args.trim().startsWith("close")) {
        if (!closeTarget) { ctx.ui.notify("Usage: /arc close <name>", "info"); return; }
        const r = closeArc(closeTarget);
        ctx.ui.notify(r.message, r.ok ? "info" : "error");
        return;
      }
      const mine = arcsOf(ctx.sessionManager.getSessionId());
      const rows = mine.length > 0 ? mine : allArcs().slice(0, 10);
      if (rows.length === 0) {
        ctx.ui.notify("No arcs yet. Ask for one when work gets substantial, or call arc_spawn.", "info");
        return;
      }
      // Live state per arc, read from the card rather than from lineage.json:
      // lineage records the RELATIONSHIP, the card records what the session is
      // doing right now. "attention" is the one that matters — it means the arc
      // is blocked waiting on the user, which is invisible from a plain list
      // and is exactly why this command needed to be more than a printout.
      const state = (id: string): string => {
        try {
          const c = JSON.parse(readFileSync(join(SESSION_STATUS_DIR, `${id}.json`), "utf8")) as { status?: string; pid?: number };
          return c.status ?? "?";
        } catch { return "gone"; }
      };
      const pidOf = (id: string): number | undefined => {
        try {
          const c = JSON.parse(readFileSync(join(SESSION_STATUS_DIR, `${id}.json`), "utf8")) as { pid?: number };
          return typeof c.pid === "number" ? c.pid : undefined;
        } catch { return undefined; }
      };
      const labels = rows.map((a) => {
        const age = Math.round((Date.now() - a.createdAt) / 60000);
        const st = a.closedAt ? "closed" : state(a.id);
        const mark = st === "attention" ? "⚠ waiting on you" : st;
        return `${a.closedAt ? "○" : "●"} ${a.name} — ${mark} — ${age}m — ${a.cwd}`;
      });
      const picked = await ctx.ui.select(
        mine.length > 0 ? "Arcs from this session" : "Recent arcs (none from this session)",
        labels,
      );
      if (!picked) return;
      const arc = rows[labels.indexOf(picked)];
      if (!arc) return;
      // Reuse the dashboard's own attach path: inside tmux it relocates the
      // client with switch-client (no tty contention); outside tmux it defers to
      // the wrapper. It also re-verifies the target's pid against tmux before
      // moving the user, which a hand-rolled `tmux attach` here would not.
      const r = dispatchHubAction({ type: "attach", tmuxName: arc.name, expectedPid: pidOf(arc.id) });
      if (!r.deferred) {
        // Outside tmux, try opening a new tab in the current Ghostty window via
        // AppleScript + System Events. This is the only way to get a tab in the
        // same window on macOS — Ghostty's +new-window action is unsupported on
        // macOS and `open -na` opens a new application instance, not a window.
        // The Cmd+T keystroke is fragile (focus-dependent) but works in practice.
        const asA = spawnSync("osascript", ["-e", `
          tell application "Ghostty" to activate
          delay 0.3
          tell application "System Events" to keystroke "t" using command down
          delay 0.5
          tell application "System Events" to keystroke "tmux attach-session -t ${arc.name}"
          delay 0.1
          tell application "System Events" to keystroke return
        `], { encoding: "utf8", timeout: 8000 });
        if (asA.status !== 0) {
          ctx.ui.notify(
            `Could not open a new tab automatically. Run: tmux attach-session -t ${arc.name}`,
            "info",
          );
        }
      }
    },
  });

  pi.registerCommand("bg", {
    description: "Background this session into tmux (queues until the current turn finishes)",
    handler: async (_args, ctx) => {
      if (!isInteractive(ctx)) return;
      const busy = !ctx.isIdle();
      const running = hasLiveSubagents();
      if (busy || running > 0) {
        // Queue rather than refuse. A handoff mid-turn would discard the
        // in-flight response and kill running subagents, so it waits for the
        // session to settle and fires itself — no second command to remember.
        bgQueued = true;
        visible = true; persist(ctx);
        const why = busy && running > 0 ? `the current turn and ${running} subagent(s)`
          : busy ? "the current turn" : `${running} running subagent(s)`;
        ctx.ui.notify(`Will background once ${why} finish\u2026 (surfaced on the dashboard meanwhile)`, "info");
        return;
      }
      await runBackgroundHandoff(ctx);
    },
  });
}

export default function piDashboard(pi: ExtensionAPI) {
  installSessionTracker(pi);
  pi.registerFlag("agents-hub", {
    description: "Launch directly into the cross-session tmux-backed dashboard hub, looping until quit",
    type: "boolean",
  });

  // /jobs is registered inside the hub's session_start (see the agents-hub
  // branch below), never from the factory: the hub runs --no-tools
  // --no-extensions so pi-jobs' own /jobs never loads there, but in normal
  // sessions both extensions load, and pi suffixes duplicate command names
  // to jobs:1/jobs:2 — neither reachable as /jobs. Hub-only registration
  // leaves /jobs to pi-jobs in normal sessions.
  pi.registerCommand("pi-dashboard", {
    description: "Live cross-project dashboard: attach/create/rename/delete tmux-backed Pi sessions",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The dashboard requires an interactive TUI session.", "error");
        return;
      }
      try {
        const action = await showDashboardOnce(ctx);
        if (action) {
          // Invoked as a slash command from inside somebody's real working
          // session — there is no wrapper to hand the terminal to, and we must
          // not fight that session's TUI for stdin. Tell the user how to attach
          // instead of hijacking their terminal.
          const tmuxName = action.type === "attach" ? action.tmuxName : action.name;
          const result = dispatchHubAction(action);
          if (!result.deferred) {
            ctx.ui.notify(
              `${result.message ? `${result.message}\n` : ""}Run this from a shell to attach: tmux attach-session -t ${tmuxName}`,
              "info",
            );
          }
        }
      } catch (err) {
        ctx.ui.notify(`Dashboard failed: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!pi.getFlag("agents-hub")) return;
    // /jobs lives HERE, not in the factory: the hub runs --no-tools
    // --no-extensions so pi-jobs' own /jobs never loads in this process,
    // but normal sessions load both extensions, and pi suffixes duplicate
    // command names to jobs:1/jobs:2 — neither reachable as /jobs. Hub-only
    // registration leaves /jobs to pi-jobs in normal sessions.
    pi.registerCommand("jobs", {
      description:
        "Offload-job markers: open the jobs panel (enter show · r resume · c clear · X delete), or list markers when no dashboard is open",
      handler: async (_args, ctx) => {
        if (dashboardView) {
          dashboardView.toggleJobsPanel();
          return;
        }
        const jobs = scanJobs();
        if (jobs.length === 0) {
          ctx.ui.notify("No job markers in ~/.pi/jobs", "info");
          return;
        }
        ctx.ui.notify(
          jobs.map((j) => `${clean(j.id)} [${j.marker.status}${j.marker.summary ? ` | ${j.marker.summary}` : ""}]`).join("\n"),
          "info",
        );
      },
    });
    // Daemon mode moved to scripts/hub-daemon.ts (plain node, not a pi
    // process) — see bin/pi-king --daemon. This session_start no longer has
    // a headless branch to dispatch to.
    if (ctx.mode !== "tui") {
      ctx.ui.notify("pi-king requires an interactive terminal.", "error");
      ctx.shutdown();
      return;
    }
    // This is a dedicated dashboard app, not a chat session — replace Pi's
    // default chat header/footer chrome (irrelevant here: cwd, model, token
    // stats) with a one-line identity banner and a blank footer, rather than
    // leaving Pi's own chat UI visibly underneath the overlay.
    // The banner now lives inside the dashboard panel itself (see render()),
    // not in a separate header surface. Previously they were two detached
    // objects: the header pinned top-left, the overlay centred ~250px below
    // and indented, which read as unrelated. Header is blanked instead.
    ctx.ui.setHeader(() => ({ render: () => [], invalidate: () => {} }));
    ctx.ui.setFooter(() => ({ render: () => [], invalidate: () => {} }));
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new BlankEditor(tui, theme, keybindings));
    // The hub loops on the dashboard: attach/create hand the terminal to tmux,
    // and once the user detaches, control returns here and the dashboard
    // re-opens — a persistent home base, not a one-shot view.
    for (;;) {
      let action: HubAction | undefined;
      try {
        action = await showDashboardOnce(ctx);
      } catch (err) {
        ctx.ui.notify(`Dashboard failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        break;
      }
      if (!action) break;
      const result = dispatchHubAction(action);
      // Deferred to the wrapper: exit now so tmux gets the terminal to itself.
      // The wrapper relaunches this hub once the user detaches.
      if (result.deferred) break;
      // Dispatch reports success here too, not just failure: the user is not
      // going to see the session's pane, so this notification is the only
      // confirmation that the task was actually delivered rather than left
      // sitting in a composer nobody is watching.
      if (result.message) ctx.ui.notify(result.message, result.level ?? "error");
    }
    ctx.shutdown();
  });
}
