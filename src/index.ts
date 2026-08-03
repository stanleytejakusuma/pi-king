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
export type TitleState = "working" | "idle" | "attention" | "error" | "exited";

// \u{...} with braces: a bare \u takes exactly four hex digits, so \u1f514
// silently parsed as U+1F51 followed by a literal "4" and the attention icon
// rendered as a Greek vowel with a digit stuck to it. Shipped that way.
export const stateIcon: Record<TitleState, string> = {
  working: "\u23f3", idle: "\u2713", attention: "\u{1f514}", error: "\u26a0", exited: "\u25cb",
};

/** FORMAT.md promises readers tolerate unknown status strings, because the
 * set is additive and a session may be running an older or newer writer than
 * the dashboard. This reader did not: a session still writing the retired
 * "trust" state rendered as the literal text "undefined trust", and its
 * missing sort priority made the comparator return NaN, quietly scrambling
 * row order. Every lookup keyed by a status now goes through here. */
const KNOWN_STATES = new Set<string>(["working", "idle", "attention", "error", "exited"]);

/** States this project used to emit, mapped to what they actually meant.
 *
 * A long-lived session keeps running the extension build it started with, so
 * after a state is retired its cards keep arriving for hours. Translating one
 * of OUR OWN former states is not the same as guessing at a stranger's: the
 * old writer's code is in this repo's history and its meaning is known.
 *
 * `trust` was only ever set from inside a working turn — the old code refused
 * to set it unless the state was already "working" — so every card still
 * carrying it is, by construction, a session mid-turn. It is shown as such.
 * The alternative was a row reading "unknown state: trust", which is honest
 * about the format and useless about the session. */
const RETIRED_STATES: Record<string, TitleState> = { trust: "working" };
export function isKnownState(s: string): s is TitleState {
  return KNOWN_STATES.has(s);
}
/** Icon for any status, known or not. An unknown state keeps its own name on
 * screen — inventing a familiar one would be a worse lie than admitting the
 * dashboard does not recognise it. */
export function iconFor(s: string): string {
  return isKnownState(s) ? stateIcon[s] : "\u25cc";
}

export type SubagentStatus = {
  id: string;
  agentType?: string;
  description: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
};

export type SessionStatusFile = {
  formatVersion: 1;
  id: string;
  name: string | undefined;
  cwd: string;
  project: string;
  model: string | undefined;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status: TitleState;
  activity: string;
  title: string;
  sessionFile: string | undefined;
  subagents: SubagentStatus[];
  visible: boolean;
  /** Context window usage, 0-100, when Pi can report it. A session near the
   * top is about to compact away part of its memory, which is worth knowing
   * before attaching, not after. Absent when unknown — never zero-filled. */
  contextPct?: number;
};

/**
 * Where sessions advertise themselves.
 *
 * Deliberately NOT derived from PI_CODING_AGENT_DIR. That variable is
 * per-process: the supervisor may run against a minimal config dir while the
 * sessions it spawns use the user's normal one, and two participants computing
 * different paths simply never see each other. A rendezvous point must be the
 * same for everyone, so it is a fixed default with one explicit override.
 *
 * PI_KING_STATUS_DIR exists for sandboxes and tests; if you set it, set it for
 * every participant.
 */
export const SESSION_STATUS_DIR =
  process.env.PI_KING_STATUS_DIR?.trim() || join(homedir(), ".pi", "king", "session-status");
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

const REFRESH_MS = 1000;
const STATE_PRIORITY: Record<TitleState, number> = { error: 0, attention: 0, working: 1, idle: 2, exited: 3 };
/** Unknown states sort with the working set rather than at an edge: they are
 * live sessions saying something this dashboard has not learned yet, not
 * emergencies and not corpses. */
function priorityOf(s: string): number {
  return isKnownState(s) ? STATE_PRIORITY[s] : 1;
}
const MESSAGE_LINGER_MS = 4000;
/** Resolved once at load rather than hardcoded. tmux lives in different places
 * depending on how it was installed: /opt/homebrew/bin on Apple Silicon,
 * /usr/local/bin on Intel macOS, /usr/bin on most Linux distributions, and
 * elsewhere again under MacPorts or Nix. A fixed path meant every tmux query
 * returned nothing on any machine that differed, so the dashboard listed no
 * sessions and looked broken rather than misconfigured. Falls back to a bare
 * name so PATH lookup still gets a chance. */
const TMUX = ((): string => {
  const which = spawnSync("/usr/bin/env", ["which", "tmux"], { encoding: "utf8", timeout: 3000 });
  const found = which.status === 0 ? String(which.stdout || "").trim().split("\n")[0].trim() : "";
  return found || "tmux";
})();

type DashboardEntry = {
  sessionId: string;
  /** The pid that wrote this status file. Load-bearing: a tmux session is
   * matched to this session by comparing its pane pid against this. */
  pid: number;
  contextPct: number | undefined;
  shortId: string;
  cwd: string;
  project: string;
  name: string | undefined;
  state: TitleState;
  lastActivity: string;
  updatedAt: number;
  subagents: SubagentStatus[];
  tmuxName: string | undefined; // resolved live tmux session name, if correlated
};

type TmuxSession = { name: string; attached: boolean; windows: number; createdAt: number; panePid: number };

/** A row that's a bare tmux session with no matching pi-alerts status file — an
 * external/non-Pi process, or a Pi session that crashed without cleaning up its
 * tmux wrapper. Still attachable/killable, just with no Pi-side metadata. */
type OrphanRow = { kind: "orphan"; tmux: TmuxSession };
type SessionRow = { kind: "session"; entry: DashboardEntry };
type Row = SessionRow | OrphanRow;

type HubAction =
  | { type: "attach"; tmuxName: string; expectedPid?: number }
  | { type: "create"; name: string; dir: string };

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
 * One `ps` snapshot per refresh, requiring the pid to still belong to a Pi
 * process. Also cheaper than a kill(2) syscall per entry.
 */
function livePiPids(): Map<number, number> | undefined {
  const res = spawnSync("/bin/ps", ["-eo", "pid=,lstart=,command="], { encoding: "utf8", timeout: 3000 });
  if (res.status !== 0 || !res.stdout) return undefined; // unknown — do not prune
  const pids = new Map<number, number>();
  for (const line of res.stdout.split("\n")) {
    // pid, lstart, then command. lstart is FIXED-WIDTH, not single-spaced: ps
    // pads the day to two columns, so the first nine days of any month print
    // "Mon Aug  3" with TWO spaces. The original pattern allowed at most one,
    // so on the 1st through the 9th every process started that day failed to
    // parse and was reported as not running. The dashboard then showed live
    // sessions as "exited" beside their own tmux sessions as orphans. It was
    // correct on the 10th through the 31st, which is why it shipped. Accept a
    // run of whitespace between every field.
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    // Pi sets process.title, so ps reports the command as bare "pi" (or
    // "pi-rpc") — never the node/cli.js command line. Verified empirically:
    // matching on cli.js rejected every live session. Trailing space is
    // significant: process.title pads the original argv buffer.
    const cmd = m[3].trim();
    if (cmd === "pi" || cmd.startsWith("pi-")) {
      const started = Date.parse(m[2]);
      if (Number.isFinite(started)) pids.set(Number(m[1]), started);
    }
  }
  return pids;
}

/** Cache for last-reply lookups, keyed by transcript path. Reading a tail is
 * cheap but not free, and refresh runs every second; size+mtime make a exact
 * staleness key, so an idle fleet costs one stat per session per tick. */
const lastReplyCache = new Map<string, { size: number; mtimeMs: number; reply: string | undefined }>();
function lastReplyFor(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  try {
    const st = statSync(sessionFile);
    const hit = lastReplyCache.get(sessionFile);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.reply;
    const reply = readLastReply(sessionFile);
    lastReplyCache.set(sessionFile, { size: st.size, mtimeMs: st.mtimeMs, reply });
    return reply;
  } catch {
    return undefined;
  }
}

/** Activity strings that say nothing. When one of these is all the tracker
 * has, the transcript's last assistant reply is strictly better — it is what
 * Claude Code's agent list shows, and it answers "what did this session last
 * say" instead of "a session exists". Meaningful activities (a prompt, an
 * error, Done:, Approval needed:) are kept; they carry intent the reply may
 * not. */
const PLACEHOLDER_ACTIVITY = new Set(["Session started.", "Waiting for input.", "Session ended."]);

/** Activity text produced by the retired approval heuristic. It is not merely
 * stale, it was measured wrong — a 25-second ungated bash reported this for 22
 * of those seconds — so a card still carrying it is repeating a claim this
 * project has already withdrawn. Treated as a placeholder, which means the
 * row falls back to the session's last reply. */
const RETIRED_ACTIVITY = /^Approval needed: /;

/** Reads every session-status file. A card whose writer process is gone is
 * not deleted: the transcript it points at survives, and the card is the only
 * thing that remembers how to resume it. It renders as "exited" instead. */
function readSessions(): DashboardEntry[] {
  let files: string[];
  try {
    files = readdirSync(SESSION_STATUS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const live = livePiPids();
  const entries: DashboardEntry[] = [];
  for (const file of files) {
    const full = join(SESSION_STATUS_DIR, file);
    let raw: SessionStatusFile;
    try {
      raw = JSON.parse(readFileSync(full, "utf8")) as SessionStatusFile;
      // Nothing validates what is in a status file: the directory is writable by
      // anything running as this user, and these fields are rendered straight
      // into the terminal. Strip control sequences at the boundary rather than
      // at each render site, where one missed call reopens it.
      for (const k of ["name", "activity", "cwd", "project", "title", "model", "tmuxName"] as const) {
        const v = (raw as Record<string, unknown>)[k];
        if (typeof v === "string") (raw as Record<string, unknown>)[k] = clean(v);
      }
    } catch {
      // Rare race with the writer's atomic tmp+rename, or a leftover .tmp file.
      // Skip this cycle; it resolves itself on the next poll.
      continue;
    }
    // Identity, not just existence. A pid alone is not proof: you have many Pi
    // sessions open, so a dead session's leftover file can name a pid that now
    // belongs to a *different* live Pi. Require the process start time to match
    // what the session recorded for itself (60s tolerance covers the gap
    // between process start and the first status write).
    const procStart = live?.get(raw.pid);
    const identityMismatch = procStart !== undefined && raw.startedAt > 0 &&
      Math.abs(procStart - raw.startedAt) > 60_000;
    // Same identity check as before — pid AND process start time — so a
    // recycled pid cannot resurrect a dead card as live. What changed is only
    // what death means: the card stays, marked exited, because deleting it
    // would delete the one pointer that knows how to resume the transcript.
    const dead = live !== undefined && (procStart === undefined || identityMismatch);
    if (dead) raw.status = "exited";
    else if (RETIRED_STATES[raw.status]) raw.status = RETIRED_STATES[raw.status];
    // Only sessions that explicitly opted in — spawned through the dashboard
    // or backgrounded via /bg — appear here. Being alive with a status file
    // is not enough; every interactive session has one for pi-alerts' own
    // notification purposes, most of which have nothing to do with this view.
    if (!raw.visible) continue;
    entries.push({
      sessionId: raw.id,
      // Load-bearing: this is what a tmux session is matched against.
      pid: raw.pid,
      shortId: raw.id.slice(0, 8),
      cwd: raw.cwd,
      project: raw.project,
      name: raw.name,
      state: raw.status,
      contextPct: typeof raw.contextPct === "number" && Number.isFinite(raw.contextPct)
        ? Math.max(0, Math.min(999, Math.round(raw.contextPct))) : undefined,
      lastActivity: PLACEHOLDER_ACTIVITY.has(raw.activity) || RETIRED_ACTIVITY.test(raw.activity)
        ? (() => { const r = lastReplyFor(typeof raw.sessionFile === "string" ? raw.sessionFile : undefined); return r ? `\u203a ${r}` : raw.activity; })()
        : raw.activity,
      updatedAt: raw.lastActivity || Date.now(),
      subagents: raw.subagents ?? [],
      tmuxName: undefined,
    });
  }
  // Pinned sessions leave their directory group and form one section at the
  // top, in the order the user put them in. Everything else groups by
  // directory, then by urgency, then by recency.
  const layout = readLayout();
  const rank = (id: string) => {
    const i = layout.order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  entries.sort((a, b) => {
    const ap = layout.pinned.includes(a.sessionId);
    const bp = layout.pinned.includes(b.sessionId);
    if (ap !== bp) return ap ? -1 : 1;
    if (ap && bp) return layout.pinned.indexOf(a.sessionId) - layout.pinned.indexOf(b.sessionId);
    return a.cwd.localeCompare(b.cwd) ||
      // A manual position, when one has been set, outranks urgency: the user
      // moving a row is a stronger statement about what matters than the
      // state machine's opinion.
      rank(a.sessionId) - rank(b.sessionId) ||
      priorityOf(a.state) - priorityOf(b.state) ||
      b.updatedAt - a.updatedAt;
  });
  return entries;
}

/* -------------------------------------------------------------- layout -- */
/** Pins and manual ordering. Deliberately NOT stored in the status files:
 * those are written by each session's own process, and the dashboard writing
 * into them would put two processes on one file. This is a dashboard concern,
 * so the dashboard owns the file. */
type Layout = { pinned: string[]; order: string[] };
const LAYOUT_FILE = join(SESSION_STATUS_DIR, "..", "layout.json");

function readLayout(): Layout {
  try {
    const raw = JSON.parse(readFileSync(LAYOUT_FILE, "utf8")) as Partial<Layout>;
    const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return { pinned: strs(raw.pinned), order: strs(raw.order) };
  } catch {
    return { pinned: [], order: [] };
  }
}

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

/** Lists live tmux sessions. No server running is not an error — just zero sessions. */
function listTmuxSessions(): TmuxSession[] {
  const result = spawnSync(TMUX, ["list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{pane_pid}"], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.trim().split("\n").filter(Boolean).flatMap((line) => {
    // tmux rejects control characters in session names but NOT in user option
    // values, so a value containing a newline splits into what looks like an
    // extra session with attacker-chosen fields. Requiring the exact field
    // count discards those fragments: a forged line cannot also carry the right
    // number of tabs once the real value has consumed the line.
    const parts = line.split("\t");
    if (parts.length !== 5) return [];
    const [name, attached, windows, created, panePid] = parts;
    return [{
      name,
      attached: attached === "1",
      windows: Number(windows) || 0,
      createdAt: (Number(created) || 0) * 1000,
      panePid: Number(panePid) || 0,
    }];
  });
}

/** Cross-references pi-alerts status entries with live tmux sessions by name. */
function buildRows(): Row[] {
  const entries = readSessions();
  const tmuxSessions = listTmuxSessions();
  // Correlation is by PROCESS, not by token.
  //
  // The token lived in a tmux user option, and a tmux option is a sticker
  // rather than a lock: any process running as this user can read one session's
  // token, write it onto a session it controls, and overwrite the original. The
  // token then appears exactly once, on the wrong session, so counting
  // duplicates does not detect it. Following that pairing would attach the user
  // to a pane chosen by whoever moved the sticker.
  //
  // A pid cannot be moved. /bg execs pi as the pane command, so the pane's pid
  // IS the Pi process, and the status file records the pid of the process that
  // wrote it. Requiring those to agree makes the pairing unforgeable by anything
  // that cannot already impersonate the process itself.
  // A pane pid is unique by construction: one pane, one process. Two rows
  // claiming the same one therefore cannot both be real, and the surplus row is
  // a forgery smuggled in through a newline in a user option value. Map
  // building would silently keep the last writer, handing the attacker the
  // pairing. Drop every row involved instead: an unresolvable identity must
  // fail closed, because the fallback is attaching the user to a pane chosen by
  // whoever tampered.
  const panePidCounts = new Map<number, number>();
  for (const t of tmuxSessions) if (t.panePid > 0) panePidCounts.set(t.panePid, (panePidCounts.get(t.panePid) ?? 0) + 1);
  const tmuxByPanePid = new Map<number, TmuxSession>();
  for (const t of tmuxSessions) {
    if (t.panePid > 0 && panePidCounts.get(t.panePid) === 1) tmuxByPanePid.set(t.panePid, t);
  }
  const matchedTmuxNames = new Set<string>();
  const sessionRows: SessionRow[] = entries.map((entry) => {
    // No name fallback. Matching on a name that merely looks right is the same
    // class of mistake as trusting the token: it pairs on resemblance instead of
    // identity, and it is exactly what an attacker gets to choose. An unmatched
    // session renders as unmatched, which is honest and harmless.
    // An exited card's pid belongs to nobody; the OS may hand it to any new
    // process, including one that is a tmux pane. Matching it would attach a
    // dead card to a random live session.
    const match = entry.pid && entry.state !== "exited" ? tmuxByPanePid.get(entry.pid) : undefined;
    if (match) {
      matchedTmuxNames.add(match.name);
      return { kind: "session", entry: { ...entry, tmuxName: match.name } };
    }
    return { kind: "session", entry };
  });
  const orphanRows: OrphanRow[] = tmuxSessions
    .filter((t) => !matchedTmuxNames.has(t.name))
    .map((t) => ({ kind: "orphan", tmux: t }));
  return [...sessionRows, ...orphanRows];
}

function tmuxError(result: ReturnType<typeof spawnSync>): string {
  if (result.error) return result.error.message;
  return String(result.stderr || result.stdout || "tmux command failed").trim();
}

// Sessions created through the dashboard always get the normal, full
// ~/.pi/agent config (skills, prompts, all extensions) regardless of what
// env the tmux *server* itself inherited when it first started (which, if
// started from the minimal pi-king hub process, would otherwise be
// PI_CODING_AGENT_DIR=~/.pi/agent-hub — the hub's own lean config, wrong
// for a real working session). `-e` on `new-session` sets the env for that
// specific new session's process, independent of server-inherited env —
// confirmed empirically, not assumed.
/** The agent directory a newly created session should use: the one in force
 * here, not a fixed path. Hardcoding it meant a session created from the
 * dashboard silently ignored the user's PI_CODING_AGENT_DIR and started against
 * a configuration they had not chosen. */
const NORMAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || `${process.env.HOME ?? ""}/.pi/agent`;

function createTmuxSession(name: string, dir: string, resumeSessionId?: string): { ok: boolean; message: string } {
  const result = spawnSync(TMUX, [
    "new-session", "-d", "-s", name,
    "-e", `PI_CODING_AGENT_DIR=${NORMAL_AGENT_DIR}`,
    // A new session inherits the tmux SERVER's environment, which may lack our
    // PATH entirely. Pin it so `pi` resolves regardless of how the server started.
    "-e", `PATH=${process.env.PATH ?? ""}`,
    // Dashboard-spawned sessions auto-opt-in to appearing on the dashboard
    // (the session tracker below reads this at session_start) — an ad-hoc `pi`
    // typed directly into a plain terminal does not set this, and stays
    // invisible to the dashboard unless it runs /bg itself.
    "-e", "PI_DASHBOARD_SPAWNED=1",
    // Same class of bug /bg once had: a supervisor pointed at a non-default
    // status dir must pass it on, or the session it starts writes its card
    // where this dashboard will never look.
    ...(process.env.PI_KING_STATUS_DIR ? ["-e", `PI_KING_STATUS_DIR=${process.env.PI_KING_STATUS_DIR}`] : []),
    "-c", dir, "--", "pi", "--name", name,
    // Resuming continues an existing transcript in place: same session id,
    // same file. The new process overwrites the exited card with a live one.
    ...(resumeSessionId ? ["--session", resumeSessionId] : []),
  ], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return { ok: false, message: `Failed to create session: ${tmuxError(result)}` };
  return { ok: true, message: resumeSessionId ? `Resumed "${name}" in ${dir}.` : `Created "${name}" in ${dir}.` };
}

/** tmux name -> desired Pi session name, applied once that session goes idle.
 * send-keys types into the live pane, so it must never fire mid-turn. */
const pendingRenames = new Map<string, string>();

/** Applies any queued rename whose session has since settled. Called on refresh. */
function flushPendingRenames(rows: Row[]): void {
  if (pendingRenames.size === 0) return;
  for (const [tmuxName, desired] of [...pendingRenames]) {
    const row = rows.find((r) => r.kind === "session" && r.entry.tmuxName === tmuxName);
    if (!row || row.kind !== "session") continue;
    if (row.entry.state !== "idle") continue;
    spawnSync(TMUX, ["send-keys", "-t", tmuxName, `/name ${clean(desired)}`, "Enter"], { encoding: "utf8", timeout: 3000 });
    pendingRenames.delete(tmuxName);
  }
}

function renameTmuxSession(oldName: string, newName: string, piIsIdle: boolean): { ok: boolean; message: string } {
  const result = spawnSync(TMUX, ["rename-session", "-t", oldName, newName], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) return { ok: false, message: `Failed to rename: ${tmuxError(result)}` };

  // Also rename the Pi session living inside it, via Pi's own /name command,
  // so both halves agree and the rename is not half-applied.
  //
  // Only when that session is idle: send-keys types into the live pane, and
  // injecting text mid-turn would land in an in-flight prompt. A tmux-only
  // rename still displays correctly (the row prefers the tmux name), so
  // skipping this is a cosmetic mismatch inside Pi, not a broken row.
  if (piIsIdle) {
    spawnSync(TMUX, ["send-keys", "-t", newName, `/name ${clean(newName)}`, "Enter"], { encoding: "utf8", timeout: 3000 });
    return { ok: true, message: `Renamed to "${newName}".` };
  }
  // Busy: queue the Pi-side rename rather than dropping it. It applies
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
    writeFileSync(target, JSON.stringify(action));
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
    // A sparkline over a handful of calls is noise shaped like a chart; below a
    // floor it says less than the number it sits next to, so it is omitted.
    // Leading zero-hours are trimmed and replaced by a start label: zeros
    // render as spaces (a measured zero is not a bar), and a morning of them
    // put nine columns of blank ahead of the first bar, which read as a
    // rendering bug rather than as a quiet night.
    if (stats.calls >= 50 && stats.hourly.length >= 4) {
      const first = stats.hourly.findIndex((n) => n > 0);
      const trimmed = first > 0 ? stats.hourly.slice(first) : stats.hourly;
      const tspark = sparkline(trimmed);
      if (tspark) {
        const from = first > 0 ? th.fg("dim", `${first}h `) : "";
        segs.push(from + th.fg("accent", tspark) + th.fg("dim", ` peak ${stats.peakHour}/h`));
      }
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
  if (stats && stats.tokensCacheRead > 0) {
    const cacheShare = stats.tokensIn > 0 ? Math.round((stats.tokensCacheRead / stats.tokensIn) * 100) : 0;
    // Cache share is why a large input count can still be cheap, so it gets the
    // same threshold colouring as the error rate: good reads green.
    const cacheColor = cacheShare >= 80 ? "success" : cacheShare >= 50 ? "warning" : "muted";
    segs.push(th.fg(cacheColor, `${cacheShare}%`) + th.fg("dim", " cached"));
  }
  const p95 = stats && stats.durations.length > 0
    ? stats.durations[Math.min(stats.durations.length - 1, Math.floor(stats.durations.length * 0.95))]
    : 0;
  if (p95 > 0) {
    // The mean hides the tail, and the tail is what someone waiting on a session
    // actually experiences.
    segs.push(th.fg("dim", "p95 ") + th.fg(p95 > 30_000 ? "warning" : "accent", `${(p95 / 1000).toFixed(1)}s`));
  }
  // Daily input-token history. When today has data it is the last bar and is
  // dimmed — a partial day ranked against completed ones is a false signal.
  // When today is empty it is absent from the series, so every bar is a
  // completed day and none is set apart.
  if (daily.length >= 3) {
    const bars = sparkline(daily.map((d) => d.tokensIn));
    if (bars) {
      segs.push(th.fg("dim", `${daily.length}d `) + (stats
        ? th.fg("accent", bars.slice(0, -1)) + th.fg("muted", bars.slice(-1))
        : th.fg("accent", bars)));
    }
    // Mean over COMPLETED days only. Including a partial today drags the
    // average down by however much of the day is left.
    const done = stats ? daily.slice(0, -1) : daily;
    if (done.length >= 2) {
      const mean = done.reduce((sum, d) => sum + d.tokensIn, 0) / done.length;
      segs.push(th.fg("dim", "avg ") + th.fg("accent", compactNum(Math.round(mean))) + th.fg("dim", "/day"));
    }
  }
  if (stats?.peakPeriod) {
    segs.push(th.fg("dim", "busiest ") + th.fg("accent", stats.peakPeriod.label) +
      th.fg("dim", ` ${stats.peakPeriod.pct}%`));
  }
  // Only the leader. The runner-up's share does not change what anyone does
  // next, and it was the first thing shed on a narrow terminal anyway.
  const lead = stats?.topModels[0];
  if (lead) segs.push(th.fg(modelColors[0], lead.model) + th.fg("dim", ` ${lead.pct}%`));
  if (stats?.partial) segs.push(th.fg("warning", "(partial)"));
  // The band shares its row with a right-flushed clock. If the segments overrun
  // the space left for it, the clock is pushed past the terminal edge and
  // silently truncated, so shed the least important segments (trailing models
  // first) until what remains fits.
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
  | { kind: "rename"; row: SessionRow | OrphanRow };

class DashboardView implements Component {
  private rows: Row[] = [];
  private selected = 0;
  /** The stats screen replaces the session list rather than sitting under it:
   * both are full-height, and stacking them would push one off the terminal. */
  private showStats = false;
  private timer: ReturnType<typeof setInterval> | undefined;
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

  constructor(
    private tui: TUI,
    private theme: Theme,
    private done: (result: HubAction | undefined) => void,
    private selfSessionId: string,
    private invocationCwd: string,
  ) {
    this.refresh();
    // Both are cheap and static for the lifetime of the overlay: an inventory
    // snapshot (readdir + stat) and a recent-projects scan that reads only the
    // first 512 bytes of one transcript per project.
    try { this.inventory = readInventory(); } catch { this.inventory = undefined; }
    try { this.recent = readRecentProjects(8); } catch { this.recent = []; }
    this.timer = setInterval(() => {
      this.refresh();
      this.tui.requestRender();
    }, REFRESH_MS);
  }

  /** Terminal rows, fed in by the overlay each render cycle. Zero means "not
   * known yet", which renders everything unwindowed — the previous behaviour. */
  private termHeight = 0;
  setTermHeight(h: number): void {
    if (Number.isFinite(h) && h > 0) this.termHeight = h;
  }

  private refresh(): void {
    this.rows = buildRows();
    flushPendingRenames(this.rows);
    if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
    this.refreshGitDrift();
  }

  /** Uncommitted-change counts per project directory, refreshed lazily. A
   * returning user's second question after "what did it do" is "did it leave
   * work uncommitted", and the directory header is where that belongs. */
  private gitDrift = new Map<string, { n: number; at: number }>();
  private refreshGitDrift(): void {
    const dirs = new Set<string>();
    for (const r of this.rows) if (r.kind === "session") dirs.add(r.entry.cwd);
    for (const dir of dirs) {
      const hit = this.gitDrift.get(dir);
      if (hit && Date.now() - hit.at < 10_000) continue;
      try {
        const r = spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8", timeout: 1500 });
        if (r.status === 0) {
          const n = String(r.stdout || "").split("\n").filter((l) => l.trim().length > 0).length;
          this.gitDrift.set(dir, { n, at: Date.now() });
        } else {
          // Not a repo, or git unhappy: record the miss so it is not retried
          // every second, and render nothing rather than a guessed zero.
          this.gitDrift.set(dir, { n: -1, at: Date.now() });
        }
      } catch {
        this.gitDrift.set(dir, { n: -1, at: Date.now() });
      }
    }
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
      this.done({ type: "create", name: step.name, dir: value });
      return;
    }
    if (step.kind === "rename") {
      const tmuxName = this.rowTmuxName(step.row);
      if (!tmuxName) {
        this.showMessage("That session has no tmux name to rename.");
        return;
      }
      const idle = step.row.kind === "session" && step.row.entry.state === "idle";
      const result = renameTmuxSession(tmuxName, value, idle);
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
    // Esc (and the terminal's own Ctrl+C/Ctrl+D) are the only ways to quit —
    // "q" is deliberately not a quit key here: it's too easy to hit by
    // accident while navigating (e.g. inside a session name), and this is a
    // dashboard people rely on staying open, not a pager.
    if (matchesKey(data, "escape")) {
      this.done(undefined);
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
      this.refresh();
      this.showMessage("Refreshed.");
      return;
    }
    if (data === "n" || data === "N") {
      this.startComposer({ kind: "new-name" }, "");
      return;
    }
    const row = this.rows[this.selected];
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
    if (matchesKey(data, "enter")) {
      if (!row) return;
      // Enter on an exited card resurrects it: a fresh tmux session resuming
      // the same transcript in the same directory, then attach as usual.
      if (row.kind === "session" && row.entry.state === "exited") {
        const e = row.entry;
        if (!existsSync(e.cwd)) {
          this.showMessage(`Directory is gone: ${e.cwd}. Resume by hand: pi --session ${e.sessionId}`);
          return;
        }
        const base = (e.name ?? e.project).trim() || e.shortId;
        let target = base;
        let result = createTmuxSession(target, e.cwd, e.sessionId);
        // A live session may already hold this name; retry once, disambiguated.
        if (!result.ok) {
          target = `${base}-${e.shortId}`;
          result = createTmuxSession(target, e.cwd, e.sessionId);
        }
        if (!result.ok) {
          this.showMessage(result.message);
          return;
        }
        this.done({ type: "attach", tmuxName: target, expectedPid: undefined });
        return;
      }
      const tmuxName = this.rowTmuxName(row);
      if (tmuxName) {
        // Pass the pid this row is believed to belong to, so the attach path can
        // re-confirm with tmux directly instead of trusting the bulk listing it
        // was built from. Orphan rows have no Pi process to verify against.
        const expectedPid = row.kind === "session" ? row.entry.pid : undefined;
        this.done({ type: "attach", tmuxName, expectedPid });
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
    // Budget: the row is "  " + ticker ... clock + "  ", so the ticker may use
    // everything except the clock, the two-space margins and a separating gap.
    const clockText = clockLine();
    const ticker = tickerParts(th, stats, daily, loaded, Math.max(20, MEASURE - visibleWidth(clockText) - 8));
    const rule = th.fg("dim", "\u2500".repeat(Math.max(0, MEASURE - 4)));
    lines.push("  " + rule);
    lines.push(split("  " + (ticker ?? th.fg("dim", "no router activity today")), th.fg("dim", clockText) + "  "));
    lines.push("  " + rule);
    lines.push("  " + th.fg("dim", `\u201c${this.quote}\u201d`));
    lines.push("");

    // ---- stats screen ----------------------------------------------------
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
    if (this.rows.length === 0) {
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
      const nameW = Math.min(34, Math.max(18, Math.floor(MEASURE * 0.22)));
      const statusW = 22;
      let lastGroup: string | undefined;
      const pinnedIds = readLayout().pinned;
      this.rows.forEach((r, i) => {
        const group = r.kind === "orphan" ? "tmux (no Pi session)"
          : pinnedIds.includes(r.entry.sessionId) ? "pinned"
          : r.entry.cwd.replace(process.env.HOME ?? "~", "~");
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
          : e.state === "working" ? "accent"
          : e.state === "exited" ? "dim"
          : e.state === "idle" ? "success"
          : "muted"; // unknown: visible, unstyled, not dressed as anything
        const isPinned = pinnedIds.includes(e.sessionId);
        // The Pi session's own name wins over its tmux container's. Renaming
        // from inside a session (/name) is the deliberate act; the tmux name is
        // just what the session happened to be created as, and only the
        // dashboard's own rename keeps the two in step. Preferring tmux meant a
        // rename typed inside a session never appeared here at all.
        const label = (isPinned ? "\u2691 " : "") +
          (e.name ?? e.tmuxName ?? e.project) +
          (isPinned ? ` \u00b7 ${e.project}` : "");
        const nm = pad(truncateToWidth(label, nameW, "\u2026", true), nameW);
        const status = pad(`${iconFor(e.state)} ${th.fg(hue, e.state)}`, statusW);
        const sub = subagentSummary(e.subagents);
        // Context climbs toward compaction, and compaction discards memory the
        // user may be counting on. Colour turns before it happens, not after.
        const ctxBadge = e.contextPct !== undefined && e.state !== "exited"
          ? th.fg(e.contextPct >= 85 ? "error" : e.contextPct >= 65 ? "warning" : "dim", `ctx ${e.contextPct}%`)
          : "";
        const right = [sub ? th.fg("dim", sub) : "", ctxBadge, th.fg("dim", elapsed(e.updatedAt))]
          .filter(Boolean).join(th.fg("dim", " \u00b7 ")) + "  ";
        const left = `  ${marker} ${e.tmuxName ? th.fg("accent", "\u26fa") : th.fg("dim", "\u233f")} ` +
          (sel ? th.bold(nm) : nm) + " " + status +
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
        : this.composerStep?.kind === "new-dir" ? "Directory:" : "Rename to:";
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
        `${k("n")}${l(" new ")}${k("e")}${l(" rename ")}${k("x")}${l(" detach ")}${th.fg("error", "X")}${l(" kill")}` + l("   \u2502   ") + `${k("s")}${l(" stats")}` + l("   \u2502   ") +
        `${k("r")}${l(" refresh ")}${k("esc")}${l(" close")}`);
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
      const pad = Math.max(0, H - head.length - body.length - inv.length - foot.length);
      return [...head, ...body, ...Array<string>(pad).fill(""), ...inv, ...foot];
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

  /** Lays inventory categories out as bordered, content-sized cards.
   * Category title is embedded in the top border (â•­â”€ skills â”€â”€â•®) so it costs
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
  // render(width) is given a width and no height, so the view cannot fit
  // itself to the terminal on its own. `visible` is the one hook called every
  // render cycle WITH both dimensions: capture the height there and always
  // return true. Reading process.stdout.rows instead would miss resizes on a
  // multiplexed or piped stdout, and this number is the one the layout engine
  // is itself using.
  let view: DashboardView | undefined;
  return ctx.ui.custom<HubAction | undefined>(
    (tui, theme, _keybindings, done) => {
      view = new DashboardView(tui, theme, done, ctx.sessionManager.getSessionId(), ctx.cwd);
      return view;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-center",
        width: "100%",
        maxHeight: "100%",
        visible: (_w, h) => { view?.setTermHeight(h); return true; },
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
function dispatchHubAction(action: HubAction): { deferred: boolean; message?: string } {
  if (action.type === "create") {
    const created = createTmuxSession(action.name, action.dir);
    if (!created.ok) return { deferred: false, message: created.message };
    return { deferred: goToSession({ type: "attach", tmuxName: action.name }), message: created.message };
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
function installSessionTracker(pi: ExtensionAPI) {
  let state: TitleState = "idle";
  let activity = "Session started.";
  let visible = process.env.PI_DASHBOARD_SPAWNED === "1";
  let startedAt = Date.now();
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
  let osascriptOk: boolean | undefined;
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
  /** True only when this session lives in tmux AND no client is attached —
   * the one situation where the user cannot be watching this terminal.
   * undefined = not in tmux, or tmux did not answer; treated as attended,
   * because notifying someone who is already looking is noise. */
  function detachedInTmux(): boolean {
    if (!process.env.TMUX) return false;
    try {
      const r = spawnSync(TMUX, ["display-message", "-p", "#{session_attached}"], { encoding: "utf8", timeout: 2000 });
      return r.status === 0 && String(r.stdout || "").trim() === "0";
    } catch { return false; }
  }
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

  pi.on("session_start", (_e, ctx) => {
    if (!isInteractive(ctx)) return;
    ctxRef = ctx;
    state = "idle"; activity = "Session started."; startedAt = Date.now();
    hadRun = false; bgQueued = false; subagents.clear();
    visible = process.env.PI_DASHBOARD_SPAWNED === "1";
    persist(ctx);
      // Collision guard. pi-king is what makes this reachable: before it, a
      // session's liveness was visible because it sat in an open terminal. Now a
      // session can be alive, headless, for days, and /bg prints a resume
      // command that is correct only after that session ends. Running it while
      // the session still lives puts a second process on one transcript, both
      // appending, and the damage is silent.
      //
      // The extension loads inside the duplicate too, so it can catch itself:
      // if this session id is already claimed by a process that is verifiably
      // alive and is not us, say so immediately.
      try {
        // Read our own status file directly rather than the dashboard listing,
        // which filters to sessions marked visible and would miss a duplicate.
        const myId = ctx.sessionManager.getSessionId();
        const claimed = JSON.parse(readFileSync(join(SESSION_STATUS_DIR, `${myId}.json`), "utf8")) as SessionStatusFile;
        const owner = Number(claimed.pid) || 0;
        if (owner && owner !== process.pid && livePiPids()?.has(owner)) {
          ctx.ui.notify(
            `Session ${myId.slice(0, 8)} is already running as pid ${owner}. ` +
            `Two processes appending to one transcript will corrupt its history. ` +
            `Attach to the existing one rather than continuing here.`,
            "error",
          );
        }
      } catch { /* no file, unreadable, or first run: nothing to warn about */ }

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
      // Finishing while nobody is attached is the event this tool exists for.
      // Attended settling stays a quiet idle; unattended settling must survive
      // until the user actually comes back (see the heartbeat, which demotes
      // it once a client attaches).
      if (detachedInTmux()) {
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
  pi.on("session_shutdown", (_e, ctx) => {
    // Fires for reason "reload" as well as a real exit — which is precisely
    // when orphaned timers would otherwise accumulate, since Pi builds a new
    // ExtensionRunner and never unwinds side effects made outside its own
    // registries. Clear unconditionally, before any early return.
    for (const t of timers) clearInterval(t);
    timers.clear();
    if (unsubscribeLeftArrow) { unsubscribeLeftArrow(); unsubscribeLeftArrow = undefined; }
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

  /** Exact-name existence check. `has-session -t <name>` does NOT do this:
   * tmux target resolution falls back to prefix and fnmatch matching, so
   * asking for "proj" returns success when only "proj-a1b2c3d4" exists —
   * verified against tmux 3.7b. On a machine running ten related session
   * names that reports a duplicate that is not there, which is exactly the
   * shape of an intermittent failure. Compare against the real list instead. */
  function tmuxSessionExists(tmux: string, name: string): boolean {
    const r = spawnSync(tmux, ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 3000 });
    // A tmux server with no sessions exits non-zero; that is "no", not an error.
    if (r.status !== 0) return false;
    return String(r.stdout || "").split("\n").some((l) => l === name);
  }

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
      "-c", ctx.cwd, "--", "pi", "--session", sessionId, "--name", name,
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
      if (result.message) ctx.ui.notify(result.message, "error");
    }
    ctx.shutdown();
  });
}
