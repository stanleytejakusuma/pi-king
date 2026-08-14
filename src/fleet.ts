/**
 * fleet.ts -- tmux/session fleet primitives with ZERO pi-API dependency.
 *
 * Split out of index.ts specifically so the hub daemon (scripts/hub-daemon.ts)
 * can run as a plain node process instead of a full `pi` extension host.
 * index.ts imports runtime (not type-only) symbols from @earendil-works/pi-tui
 * (Input, matchesKey, truncateToWidth, visibleWidth) and pi-coding-agent
 * (CustomEditor) for the dashboard's TUI -- importing index.ts wholesale into
 * the daemon would drag pi-tui in at runtime purely to reach these functions,
 * including pi-tui's own module-scope Intl.Segmenter setup (the exact cost
 * center a live-fleet CPU profile identified during the 2026-08-10 lag
 * investigation). Every function here is node stdlib + spawnSync/spawn only,
 * loadable by node's --experimental-strip-types the same way jobs.ts already
 * is (see tools/jobs.test.mjs). The dependency arrow points one way: index.ts
 * and the daemon both import FROM fleet.ts; fleet.ts imports nothing from
 * either.
 *
 * NOT moved here (stayed in index.ts, dashboard/hub-only, never touched by
 * the daemon): stateIcon/iconFor (rendering only -- isKnownState/KNOWN_STATES
 * DID move, since priorityOf/readSessions need them too, and index.ts imports
 * isKnownState back), REFRESH_MS/IDLE_REFRESH_TICKS/MESSAGE_LINGER_MS
 * (dashboard tick/render timing -- STATE_PRIORITY/priorityOf moved, needed by
 * readSessions' own sort), HubAction (dispatch), writeLayout (pin/rename
 * actions), REBOOT_RECOVERY_FILE/bootTimeSec/restoreRebootOrphans (boot-
 * proximity-gated, interactive-hub-only -- the daemon's restoreMissingSessions
 * below is unconditional instead), restartTmuxPane (respawn-in-place,
 * dashboard/ /bg only).
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { clean, selectRestoreCards } from "./jobs.ts";

/** Reads the last assistant reply from a session's transcript JSONL,
 * tail-first (only the last 256KB, not the whole file). Local copy, not an
 * import from data.ts, for the SAME reason jobs.ts keeps its own clean():
 * data.ts's StatsCache uses TS constructor-parameter properties, which
 * node's --experimental-strip-types mode (how the hub daemon runs) rejects
 * outright -- importing data.ts at all would make fleet.ts, and therefore
 * the daemon, fail to load. */
function readLastReply(sessionFile: string, tailBytes = 262_144): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(Math.min(tailBytes, size));
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: { type?: string; message?: { role?: string; content?: unknown } };
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const content = Array.isArray(entry.message.content) ? entry.message.content : [];
      for (const c of content) {
        const block = c as { type?: string; text?: string };
        if (block?.type === "text" && typeof block.text === "string") {
          const text = clean(block.text.replace(/[*`_#]/g, "").replace(/\s+/g, " ").trim());
          if (text) return text.length > 200 ? `${text.slice(0, 199)}\u2026` : text;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

export type TitleState = "working" | "idle" | "background" | "attention" | "error" | "exited";
export const RETIRED_STATES: Record<string, TitleState> = { trust: "working" };
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
  /** Short fingerprint of ~/.pi/agent/settings.json's `packages` field,
   * stamped once at session_start (which fires on process launch AND on
   * every /reload). Compared against the dashboard's own fresh read of the
   * same field to flag a session as needing a reload. Absent on a session
   * that predates this field being written at all (an older pi-king build,
   * or one that has not been through session_start since) — the dashboard
   * treats that the same as a real mismatch, not as "unknown, assume fine":
   * every session running right now falls into exactly that bucket until
   * its first reload after this ships. */
  /** Deterministic fingerprint of everything a fresh `pi` process start would
   * load: the full canonical global settings.json (which covers enabledModels,
   * provider/model defaults, AND the packages field), global trust.json and
   * keybindings.json when present, the global resource roots (extensions,
   * skills, prompts, themes), package markers for every settings.packages
   * entry (npm lockfile / git HEAD / local package source), and the session's
   * own project scope (.pi/settings.json + .pi resource roots).
   *
   * Stamped once when the sessionId is first served by THIS process — the one
   * moment registerProvider and the model scope genuinely ran — and then
   * PRESERVED across later /reloads of that same sessionId (a reload re-imports
   * extensions/skills/prompts but does NOT re-run startup registration, so the
   * process's effective startup inputs are still the launch-time ones; see the
   * session_start stamp logic). Absent on a session that predates this field
   * being written at all (an older pi-king build) — the dashboard treats that
   * the same as a real mismatch, because every session running right now falls
   * into exactly that bucket until its first full restart after this ships. */
  startupFingerprint?: string;
  /** True when this exact sessionId originated from Pi's own /fork ("Create a
   * new fork from a previous user message") rather than a normal launch.
   * Determined once when the sessionId is first seen (session_start's own
   * `reason === "fork"`) and then restored unchanged on every later reload
   * of that SAME sessionId, never re-derived from that later reload's own
   * reason -- a naive "set isFork = reason === 'fork'" on every session_start
   * would silently erase this the moment the forked session is itself
   * reloaded (reload's reason is "reload", not "fork"). A fork shares its
   * parent's process (same pid, same tmux pane) and, observed live, its
   * parent's display name too -- two identically-labelled cards with no way
   * to tell which is the long-running original and which just branched off
   * is exactly the ambiguity this field exists to resolve on the card. */
  isFork?: boolean;
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
/** Resolved once at load rather than hardcoded. tmux lives in different places
 * depending on how it was installed: /opt/homebrew/bin on Apple Silicon,
 * /usr/local/bin on Intel macOS, /usr/bin on most Linux distributions, and
 * elsewhere again under MacPorts or Nix. A fixed path meant every tmux query
 * returned nothing on any machine that differed, so the dashboard listed no
 * sessions and looked broken rather than misconfigured. Falls back to a bare
 * name so PATH lookup still gets a chance. */
export const TMUX = ((): string => {
  // Test override, same contract as jobs.ts: PI_KING_TMUX points every
  // tmux call at a fake binary that records invocations.
  const forced = process.env.PI_KING_TMUX?.trim();
  if (forced) return forced;
  const which = spawnSync("/usr/bin/env", ["which", "tmux"], { encoding: "utf8", timeout: 3000 });
  const found = which.status === 0 ? String(which.stdout || "").trim().split("\n")[0].trim() : "";
  return found || "tmux";
})();

export type DashboardEntry = {
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
  /** True when this session's stamped startupFingerprint disagrees with the
   * dashboard's own fresh read of the same startup inputs — or when it has
   * no stamped fingerprint at all, which is the same fact (needs a full
   * restart to catch up) for a different reason: a reload does not re-run
   * startup registration, so "stamped by a reload" and "never stamped"
   * both mean the process is running against launch-time inputs while disk
   * has moved on. Already false for an exited session: nothing to restart.
   * Computed once per readSessions() call, not per render — the startup
   * inputs are read at refresh cadence, not every tick. */
  restartNeeded: boolean;
  /** This sessionId originated from Pi's own /fork, not a normal launch. See
   * the SessionStatusFile.isFork comment for why it is stamped once and
   * preserved across later reloads rather than re-derived every time. The
   * card this most needs to appear on is the one sitting in the SAME pane
   * the user has been looking at the whole time -- /fork switches that
   * pane's active session out from under whatever was previously there, so
   * the thing left unmarked and unattended is the one that quietly stopped
   * being current, not something that visibly moved away. */
  isFork: boolean;
};

export type TmuxSession = { name: string; attached: boolean; windows: number; createdAt: number; panePid: number };

/** A row that's a bare tmux session with no matching pi-alerts status file — an
 * external/non-Pi process, or a Pi session that crashed without cleaning up its
 * tmux wrapper. Still attachable/killable, just with no Pi-side metadata. */
export type OrphanRow = { kind: "orphan"; tmux: TmuxSession };

/** Where a row sits in the arc lineage, precomputed by orderByLineage so the
 * renderer stays dumb: it prepends `prefix` and draws the affordance, and
 * makes no decisions of its own. See docs/ARC-TREE-DESIGN.md. */
export type TreeInfo = {
  /** 0 for a top-level row. */
  depth: number;
  /** Box-drawing prefix, fully assembled ("", "\u251c\u2500 ", "\u2502  \u2514\u2500 "). Drawn INSIDE
   * the name column, never before the row marker: src/index.ts fixes the
   * name column width precisely so activity text lines up down the page,
   * and indenting the whole row would rag every column to its right. */
  prefix: string;
  /** Has at least one child ON THE DASHBOARD. Gates the collapse affordance
   * so ordinary rows are completely unchanged by this feature. */
  hasArcs: boolean;
  /** Children exist but are hidden by the user. */
  collapsed: boolean;
  /** This arc lives somewhere other than its PARENT, so the row has to name
   * its own project. Compared against the parent rather than the section
   * header: a pinned parent's header reads "pinned", which matches no cwd,
   * so heading-based comparison tagged every nested row and truncated its
   * name to make room for a suffix that said nothing. */
  showProject: boolean;
};
export type SessionRow = { kind: "session"; entry: DashboardEntry; tree?: TreeInfo };
export type Row = SessionRow | OrphanRow;
export function livePiPids(pids: number[]): Map<number, number> | undefined {
  // 99999 is the real ceiling, not a round guess: binary-searched against this
  // machine's own ps -p, which accepts pid 99999 but rejects 100000 outright
  // ("process id too large", killing the whole query, not just that pid) --
  // the traditional BSD/macOS PID_MAX. An earlier version of this filter used
  // 99,999,999 on the theory that any generously-large number was safely
  // "obviously not a real pid"; that bound was 1000x too permissive and the
  // exact failure it was meant to prevent still reproduced live during
  // verification, from nothing more exotic than "a real pid plus a few
  // million" — a value a corrupted status file could plausibly contain.
  const safe = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0 && p <= 99_999);
  if (safe.length === 0) return new Map();
  const res = spawnSync("/bin/ps", ["-p", safe.join(","), "-o", "pid=,lstart=,command="], { encoding: "utf8", timeout: 3000 });
  if (res.error || typeof res.stdout !== "string") return undefined; // ps itself did not run — unknown, do not prune
  const pidsOut = new Map<number, number>();
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
      if (Number.isFinite(started)) pidsOut.set(Number(m[1]), started);
    }
  }
  return pidsOut;
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
export function readSessions(): DashboardEntry[] {
  let files: string[];
  try {
    files = readdirSync(SESSION_STATUS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  // Two passes: the pid list livePiPids() needs to target has to be known
  // BEFORE it is called, so every status file is parsed once up front (cheap
  // -- measured 0.2ms for this fleet's file count) and the identity check
  // below runs against the already-parsed results, rather than parsing twice.
  const parsed: SessionStatusFile[] = [];
  for (const file of files) {
    const full = join(SESSION_STATUS_DIR, file);
    try {
      const raw = JSON.parse(readFileSync(full, "utf8")) as SessionStatusFile;
      // Nothing validates what is in a status file: the directory is writable by
      // anything running as this user, and these fields are rendered straight
      // into the terminal. Strip control sequences at the boundary rather than
      // at each render site, where one missed call reopens it.
      for (const k of ["name", "activity", "cwd", "project", "title", "model", "tmuxName"] as const) {
        const v = (raw as Record<string, unknown>)[k];
        if (typeof v === "string") (raw as Record<string, unknown>)[k] = clean(v);
      }
      parsed.push(raw);
    } catch {
      // Rare race with the writer's atomic tmp+rename, or a leftover .tmp file.
      // Skip this cycle; it resolves itself on the next poll.
    }
  }
  const live = livePiPids(parsed.map((raw) => raw.pid));
  // Hoisted above the loop (was previously read once, further down, purely
  // for the pin/order sort) so the same read also backs the name override
  // below — one readLayout() call per refresh either way.
  const layout = readLayout();
  // One fingerprint per distinct cwd per readSessions() call: the global
  // inputs (settings.json, resource roots, packages) are shared by every
  // session and the project-scope inputs depend only on the session's own
  // working dir, so memoizing by cwd avoids recomputing the shared part N
  // times — 14 cards in the same handful of projects is a handful of
  // computes, not 14.
  const fpMemo = new Map<string, string | undefined>();
  const fpFor = (cwd: string): string | undefined => {
    if (!fpMemo.has(cwd)) fpMemo.set(cwd, computeStartupFingerprint(cwd));
    return fpMemo.get(cwd);
  };
  const entries: DashboardEntry[] = [];
  for (const raw of parsed) {
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
      // The dashboard's own rename wins over whatever Pi's status file says
      // — see the Layout.names comment for why the status file's own name
      // cannot be trusted to reflect a rename promptly. raw.name may
      // legitimately be undefined (never named), which rowLabel() falls back
      // to entry.project for — an empty override map entry must not turn
      // that into "" and silently defeat the fallback, so this only touches
      // name when an override actually exists. clean() again on the override
      // even though raw.name was already cleaned above: layout.json is this
      // process's own file, but the override value came from a composer
      // typed by whatever ends up calling renameTmuxSession, and this is the
      // one place it reaches the terminal.
      name: layout.names[raw.id] ? clean(layout.names[raw.id]) : raw.name,
      state: raw.status,
      contextPct: typeof raw.contextPct === "number" && Number.isFinite(raw.contextPct)
        ? Math.max(0, Math.min(999, Math.round(raw.contextPct))) : undefined,
      lastActivity: PLACEHOLDER_ACTIVITY.has(raw.activity) || RETIRED_ACTIVITY.test(raw.activity)
        ? (() => { const r = lastReplyFor(typeof raw.sessionFile === "string" ? raw.sessionFile : undefined); return r ? `\u203a ${r}` : raw.activity; })()
        : raw.activity,
      updatedAt: raw.lastActivity || Date.now(),
      subagents: raw.subagents ?? [],
      tmuxName: undefined,
      // Exited already excludes it: nothing to restart. fp undefined means
      // the dashboard could not read the startup inputs this cycle -- fail
      // closed to "not restartNeeded" rather than flag a fleet on a read
      // that did not happen. raw.startupFingerprint undefined (no stamp yet,
      // an older build or a session that has not been through a real process
      // start since) counts the same as a real mismatch, not as "unknown,
      // assume fine" -- see the startupFingerprint field comment.
      restartNeeded: raw.status !== "exited" && (() => {
        const fp = fpFor(raw.cwd);
        return fp !== undefined && (raw.startupFingerprint === undefined || raw.startupFingerprint !== fp);
      })(),
      isFork: raw.isFork === true,
    });
  }
  // Pinned sessions leave their directory group and form one section at the
  // top, in the order the user put them in. Everything else groups by
  // directory, then by urgency, then by recency. (layout was already read
  // above, before the entries loop, for the name override.)
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
export type Layout = { pinned: string[]; order: string[]; lastSelected?: string; names: Record<string, string>; collapsed: string[] };
export const LAYOUT_FILE = join(SESSION_STATUS_DIR, "..", "layout.json");

export function readLayout(): Layout {
  try {
    const raw = JSON.parse(readFileSync(LAYOUT_FILE, "utf8")) as Partial<Layout>;
    const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const names: Record<string, string> = {};
    if (raw.names && typeof raw.names === "object") {
      for (const [k, v] of Object.entries(raw.names)) if (typeof v === "string") names[k] = v;
    }
    return { pinned: strs(raw.pinned), order: strs(raw.order), lastSelected: typeof raw.lastSelected === "string" ? raw.lastSelected : undefined, names, collapsed: strs(raw.collapsed) };
  } catch {
    return { pinned: [], order: [], names: {}, collapsed: [] };
  }
}

/** The arc ledger, keyed by session ID rather than by path: pi's own
 * parentSession pointer is a filesystem PATH and paths rot -- that is
 * literally why Alexandria's lineage was invisible until this file existed.
 * Read here rather than imported from arc.ts, which already imports this
 * module; the dependency runs arc -> fleet and must not become a cycle. */
// Anchored to HOME, deliberately NOT derived from SESSION_STATUS_DIR the way
// LAYOUT_FILE is: this is exactly where arc.ts wrote it before the constant
// moved here, and a supervisor pointed at an alternate status dir must not
// silently strand an existing ledger. HOME is what the arc tests sandbox.
export const LINEAGE_FILE = join(homedir(), ".pi", "king", "lineage.json");

/** child session id -> parent session id. A missing or unreadable ledger is
 * not an error: it just means nothing has ever been spawned as an arc. */
export function readParentMap(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(LINEAGE_FILE, "utf8")) as { arcs?: unknown };
    if (!Array.isArray(raw.arcs)) return m;
    for (const a of raw.arcs) {
      if (!a || typeof a !== "object") continue;
      const rec = a as { id?: unknown; parentId?: unknown };
      // An empty parentId is what dispatchSession writes for a session that
      // is nobody's child; it must not become an edge to "".
      if (typeof rec.id === "string" && typeof rec.parentId === "string" && rec.parentId) m.set(rec.id, rec.parentId);
    }
  } catch { /* no ledger yet */ }
  return m;
}

/** Reorders rows so every arc sits directly beneath the session that spawned
 * it, recursively, and annotates each with its TreeInfo.
 *
 * Pure on purpose -- all three inputs are passed in -- because the ordering
 * is the part with edge cases worth testing (cycles, absent parents,
 * collapse) and none of them need the filesystem to reproduce.
 *
 * Relative order within a level is preserved from the caller's sort, so
 * pinned-first / cwd / manual-order / urgency / recency all still hold
 * WITHIN a sibling group. This is deliberately a post-pass rather than a
 * comparator rewrite: the existing comparator is load-bearing and this only
 * needs to relocate descendants, not re-rank anything. */
export function orderByLineage(
  rows: SessionRow[],
  parentOf: Map<string, string>,
  collapsed: ReadonlySet<string>,
): SessionRow[] {
  const byId = new Map<string, SessionRow>();
  for (const r of rows) byId.set(r.entry.sessionId, r);
  const kids = new Map<string, SessionRow[]>();
  const roots: SessionRow[] = [];
  for (const r of rows) {
    const p = parentOf.get(r.entry.sessionId);
    // A parent that is not itself a row cannot be nested under. That is not
    // a hole to patch with a placeholder: an arc inherits its parent's
    // visibility at spawn, so the only rows landing here with an absent
    // parent are ones whose parent card was dismissed after the fact. They
    // degrade to top level rather than vanish.
    if (p !== undefined && p !== r.entry.sessionId && byId.has(p)) {
      const list = kids.get(p);
      if (list) list.push(r); else kids.set(p, [r]);
    } else roots.push(r);
  }
  const out: SessionRow[] = [];
  const seen = new Set<string>();
  //
  // `hidden` walks a collapsed subtree without rendering it. Returning early
  // instead would leave those rows unvisited, and the cycle sweep below
  // would then "rescue" them straight back to top level -- a collapse that
  // relocates its own children rather than hiding them. Found by test, not
  // by reading.
  const emit = (r: SessionRow, depth: number, base: string, isLast: boolean, hidden: boolean, parentCwd?: string): void => {
    const id = r.entry.sessionId;
    if (seen.has(id)) return;
    seen.add(id);
    const children = kids.get(id) ?? [];
    const isCollapsed = collapsed.has(id);
    if (!hidden) {
      out.push({
        ...r,
        tree: {
          depth,
          prefix: depth === 0 ? "" : base + (isLast ? "\u2514\u2500 " : "\u251c\u2500 "),
          hasArcs: children.length > 0,
          collapsed: isCollapsed,
          showProject: parentCwd !== undefined && parentCwd !== r.entry.cwd,
        },
      });
    }
    // Depth 1 hangs off a root that draws no prefix of its own, so its
    // children start from an empty base rather than inheriting indentation
    // that was never rendered.
    const childBase = depth === 0 ? "" : base + (isLast ? "   " : "\u2502  ");
    const childHidden = hidden || isCollapsed;
    children.forEach((c, i) => emit(c, depth + 1, childBase, i === children.length - 1, childHidden, r.entry.cwd));
  };
  roots.forEach((r) => emit(r, 0, "", true, false));
  // A cycle in the ledger (a -> b -> a) leaves both nodes parented and
  // neither reachable from a root, which would silently delete live rows
  // from the dashboard. Losing sight of a running session is far worse than
  // rendering it flat, so anything the walk missed is appended.
  for (const r of rows) {
    if (!seen.has(r.entry.sessionId)) out.push({ ...r, tree: { depth: 0, prefix: "", hasArcs: false, collapsed: false, showProject: false } });
  }
  return out;
}
/** Lists live tmux sessions. No server running is not an error — just zero sessions. */
export function listTmuxSessions(): TmuxSession[] {
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
export function buildRows(): Row[] {
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
  // Lineage is applied last, over the fully sorted list, so an arc keeps its
  // parent's company no matter which section that parent ended up in.
  return [...orderByLineage(sessionRows, readParentMap(), new Set(readLayout().collapsed)), ...orphanRows];
}

export function tmuxError(result: ReturnType<typeof spawnSync>): string {
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
export const NORMAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || `${process.env.HOME ?? ""}/.pi/agent`;

/** The pi binary every spawn site launches. Override with PI_KING_PI_BIN to
 * run the fleet on an alternate install -- e.g. the patched clone at
 * ~/.pi-lab reachable as `pix` (docs/PI-LAB.md).
 *
 * Safe with liveness detection: pi overwrites its command line via
 * process.title, so a `pix`-launched session still reports as bare "pi" to
 * ps and matches the check at fleet.ts:252. Verified empirically 2026-08-13 --
 * do not assume it, the detector would silently mark the whole fleet dead.
 *
 * Only affects NEWLY spawned sessions: Node caches modules at require time, so
 * a running session keeps whichever renderer it started with until restarted.
 *
 * Prefer an absolute path. tmux resolves a bare name against the tmux SERVER's
 * PATH, which was inherited whenever that server started and may predate a
 * shim in ~/.local/bin. */
export const PI_BIN = process.env.PI_KING_PI_BIN?.trim() || "pi";
/** Fix 2 of the 2026-08-10 tmux perf audit (docs/PERF-TMUX-SPEC.md): caps how
 * many lines pi-tui's fullRender replays into the terminal, once
 * tools/patch-pi-tui.mjs has been applied to the installed pi-tui dist
 * (unpatched, this env var is simply inert — pi-tui ignores env vars it
 * doesn't read). Only wired into tmux-spawned sessions: tmux is the slow
 * drain path this exists for (measured ~6.5x slower than a fast pty), and
 * native (non-tmux) pi sessions must stay byte-identical to upstream.
 * Overridable via PI_KING_FULL_RENDER_CAP for experimentation; 3000 is the
 * shipped default (Stanley, 2026-08-10: ~490KB/~16ms full-render bursts,
 * ~48 screens of post-replay tmux scrollback). */
const FULL_RENDER_CAP = process.env.PI_KING_FULL_RENDER_CAP?.trim() || "3000";

/** The -e environment arguments every tmux-spawned pi process needs, shared
 * by new-session (createTmuxSession) and respawn-pane (restartTmuxPane) so
 * the two launch paths cannot drift: a restart that forgot the status dir
 * would write its card where the dashboard never looks. */
export function tmuxLaunchEnv(visible = true): string[] {
  return [
    // A new process inherits the tmux SERVER's environment, which may lack
    // our PATH entirely. Pin it so `pi` resolves regardless of how the
    // server started.
    "-e", `PATH=${process.env.PATH ?? ""}`,
    // Dashboard-spawned sessions auto-opt-in to appearing on the dashboard
    // (the session tracker below reads this at session_start) — an ad-hoc
    // `pi` typed directly into a plain terminal does not set this, and stays
    // invisible to the dashboard unless it runs /bg itself.
    //
    // visible=false is how an arc inherits an unmanaged parent: a session
    // the user never put on the dashboard is a one-off, and its children are
    // one-offs too. Withholding the flag (rather than setting it to 0) is
    // what makes them indistinguishable from an ad-hoc `pi`, which is
    // exactly the intended meaning. /bg from inside still surfaces one.
    ...(visible ? ["-e", "PI_DASHBOARD_SPAWNED=1"] : []),
    "-e", `PI_TUI_MAX_FULL_RENDER_LINES=${FULL_RENDER_CAP}`,
    // ACP (billion-context-pi) has its own internal self-updater that runs
    // `npm install` independent of `pi update`/settings.json pins — it
    // controls context-compaction safety logic, so silent unreviewed
    // updates are a real risk (2026-08-11 incident: fired from a 2-day-old
    // stale session despite acp.json's autoUpdate:false + a version pin).
    // This documented env killswitch (checked before ACP's own config) is
    // the only fix that reaches already-cached in-memory sessions' future
    // respawns; `pi update --extension npm:billion-context-pi` remains the
    // sole, reviewable update path.
    "-e", "ACP_AUTO_UPDATE=0",
    // Same class of bug /bg once had: a supervisor pointed at a non-default
    // status dir must pass it on, or the session it starts writes its card
    // where this dashboard will never look.
    ...(process.env.PI_KING_STATUS_DIR ? ["-e", `PI_KING_STATUS_DIR=${process.env.PI_KING_STATUS_DIR}`] : []),
  ];
}

/** Terminal cell dimensions. Its own tiny type rather than reusing a
 * DashboardEntry-adjacent shape: this is a *client* fact (what Ghostty is
 * showing right now), unrelated to session state. */
export type ClientSize = { w: number; h: number };

function validSize(s: ClientSize | undefined): s is ClientSize {
  return s !== undefined && Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0;
}

/** Last-known real client size, persisted so the headless daemon (no
 * attached terminal, no DashboardView to read a live number from) can still
 * spawn sessions close to the right size instead of tmux's 80x24 default.
 * Written by the dashboard whenever its tracked size changes (see
 * DashboardView.setTermSize in index.ts); read by resolveSpawnSize below
 * whenever a caller has no better, live number to hand it. */
// Own override rather than deriving from SESSION_STATUS_DIR's parent: a test
// pointing PI_KING_STATUS_DIR at an arbitrary scratch dir would otherwise
// walk ".." into that scratch dir's real, unrelated, uncleaned-up parent
// (e.g. the OS tmp root) instead of staying isolated.
export const CLIENT_SIZE_FILE =
  process.env.PI_KING_CLIENT_SIZE_FILE?.trim() || join(homedir(), ".pi", "king", "client-size.json");

export function readClientSize(): ClientSize | undefined {
  try {
    const raw = JSON.parse(readFileSync(CLIENT_SIZE_FILE, "utf8")) as Partial<ClientSize>;
    const size = { w: Number(raw.w), h: Number(raw.h) };
    return validSize(size) ? size : undefined;
  } catch {
    return undefined;
  }
}

export function writeClientSize(size: ClientSize): void {
  if (!validSize(size)) return;
  try {
    const prev = readClientSize();
    if (prev && prev.w === size.w && prev.h === size.h) return; // unchanged: skip the write
    mkdirSync(dirname(CLIENT_SIZE_FILE), { recursive: true });
    writeFileSync(CLIENT_SIZE_FILE, JSON.stringify({ w: size.w, h: size.h, at: Date.now() }));
  } catch {
    // best-effort: a failed write here must not crash the dashboard
  }
}

/** Sessions used to spawn at tmux's bare default (80x24, tmux's built-in
 * fallback when nothing else is known) and only reach the real client size
 * on first attach -- which under `window-size latest` forces a full
 * rewrap-and-replay of the entire rendered transcript at exactly the
 * moment a user switches into a session (measured: 10.9MB / 67,555 lines
 * on a real 40MB session, ~350-550ms of frozen UI, 2026-08-10 tmux perf
 * audit). Every caller of createTmuxSession should now start the window as
 * close to the real client size as possible so that first attach has
 * little or nothing left to resize. Three-tier fallback, in order: (1) a
 * live size the caller already has in hand (DashboardView tracks its own
 * from the layout engine's visible(w,h) hook -- more current than the
 * persisted file within the same process); (2) the persisted last-known
 * client size (the daemon's only option, since it has no attached
 * terminal); (3) 224x63, this machine's normal full-screen Ghostty size,
 * chosen over tmux's 80x24 as a strictly better first guess. */
export const DEFAULT_SPAWN_SIZE: ClientSize = { w: 224, h: 63 };

export function resolveSpawnSize(live?: ClientSize): ClientSize {
  if (validSize(live)) return live;
  return readClientSize() ?? DEFAULT_SPAWN_SIZE;
}

export function createTmuxSession(name: string, dir: string, resumeSessionId?: string, liveSize?: ClientSize, visible = true): { ok: boolean; message: string } {
  const size = resolveSpawnSize(liveSize);
  const result = spawnSync(TMUX, [
    "new-session", "-d", "-s", name,
    "-x", String(size.w), "-y", String(size.h),
    "-e", `PI_CODING_AGENT_DIR=${NORMAL_AGENT_DIR}`,
    ...tmuxLaunchEnv(visible),
    "-c", dir, "--", PI_BIN, "--name", name,
    // Resuming continues an existing transcript in place: same session id,
    // same file. The new process overwrites the exited card with a live one.
    ...(resumeSessionId ? ["--session", resumeSessionId] : []),
  ], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return { ok: false, message: `Failed to create session: ${tmuxError(result)}` };
  return { ok: true, message: resumeSessionId ? `Resumed "${name}" in ${dir}.` : `Created "${name}" in ${dir}.` };
}
/** The hub daemon's boot restore. Unlike restoreRebootOrphans it is NOT
 * gated on reboot proximity: the daemon starts with launchd at login (and
 * restarts on crash via KeepAlive), when the tmux server is down and every
 * window is gone — the user's intent on daemon start is "windows back".
 * Every visible card whose process is confirmably gone (dead, or a recycled
 * pid) and whose window does not already exist gets a fresh window, exactly
 * like the fleet recovery done by hand after the 2026-08-07 kill-server
 * accident. Deliberate: a session killed with X does come back — the card
 * is the only tombstone-free record; hit X again. */
export function restoreMissingSessions(): number {
  let files: string[];
  try {
    files = readdirSync(SESSION_STATUS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return 0;
  }
  const parsed: SessionStatusFile[] = [];
  for (const file of files) {
    try {
      parsed.push(JSON.parse(readFileSync(join(SESSION_STATUS_DIR, file), "utf8")) as SessionStatusFile);
    } catch {
      // rare write race; skip, resolves next run
    }
  }
  const live = livePiPids(parsed.map((raw) => raw.pid));
  if (live === undefined) return 0; // ps unavailable: do not guess at liveness
  let restored = 0;
  for (const raw of selectRestoreCards(parsed, live)) {
    if (!existsSync(raw.cwd)) continue;
    const base = (raw.name ?? raw.project ?? "").trim() || raw.id.slice(0, 8);
    const names = [base, `${base}-${raw.id.slice(0, 8)}`];
    if (names.some((n) => tmuxSessionExists(TMUX, n))) continue; // window already there
    let result = createTmuxSession(base, raw.cwd, raw.id);
    if (!result.ok) result = createTmuxSession(names[1], raw.cwd, raw.id);
    if (result.ok) restored++;
  }
  return restored;
}
/** Exact-name existence check. `has-session -t <name>` does NOT do this:
 * tmux target resolution falls back to prefix and fnmatch matching, so
 * asking for "proj" returns success when only "proj-a1b2c3d4" exists —
 * verified against tmux 3.7b. Compare against the real list instead. */
export function tmuxSessionExists(tmux: string, name: string): boolean {
  const r = spawnSync(tmux, ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 3000 });
  // A tmux server with no sessions exits non-zero; that is "no", not an error.
  if (r.status !== 0) return false;
  return String(r.stdout || "").split("\n").some((l) => l === name);
}

/** Same marker strings tools/patch-pi-tui.mjs writes on apply -- duplicated
 * rather than imported (that script is deliberately standalone, runnable
 * even if this module fails to load) but must never drift, since this is
 * the ONLY thing that decides whether the daemon/dashboard warn.
 *
 * BOTH must be present to count as patched: they are independent fixes to
 * different files (tui-main-screen.js's full-render write cap, utils.js's
 * width-cache size) and a pi upgrade can clobber one while leaving the
 * other, so a partial state must warn rather than average out to healthy. */
const PI_TUI_PATCH_SITES: ReadonlyArray<{ file: string; marker: string }> = [
  { file: "tui-main-screen.js", marker: "pi-king-tui-patch:v1" },
  { file: "utils.js", marker: "pi-king-tui-patch:widthcache-v1" },
];

/** Best-effort yes/no: is the installed pi-tui's fullRender patched for
 * Fix 2 (docs/PERF-TMUX-SPEC.md)? Always content-based -- scans the actual
 * installed file, never trusts tools/patch-pi-tui.mjs's ~/.pi/king/
 * tui-patch.json record, which a pi upgrade can silently invalidate without
 * touching. Never throws: an unresolvable pi install, a missing file, or
 * any other surprise all mean "can't confirm patched" -- treated the same
 * as unpatched for warning purposes. The precise unpatched-vs-needs-review
 * distinction lives in patch-pi-tui.mjs --check; this only answers the
 * boolean the daemon and dashboard warnings need. */
export function isPiTuiPatched(): boolean {
  try {
    // Follows PI_BIN so the warning describes the install the fleet actually
    // runs. Pointing sessions at a patched clone while checking the system
    // install would report the exact opposite of the truth.
    const which = spawnSync("/usr/bin/env", ["which", PI_BIN], { encoding: "utf8", timeout: 3000 });
    if (which.status !== 0) return false;
    const piBin = String(which.stdout || "").trim().split("\n")[0];
    if (!piBin) return false;
    let dir = dirname(realpathSync(piBin));
    for (let i = 0; i < 12 && dir !== "/" && dir !== "."; i++) {
      const dist = join(dir, "node_modules", "@earendil-works", "pi-tui", "dist");
      if (existsSync(join(dist, "tui-main-screen.js"))) {
        return PI_TUI_PATCH_SITES.every((site) => {
          try {
            return readFileSync(join(dist, site.file), "utf8").includes(site.marker);
          } catch {
            return false;
          }
        });
      }
      dir = dirname(dir);
    }
    return false;
  } catch {
    return false;
  }
}

/** Same marker string ~/.pi/agent/PATCHES.md documents for the compaction-
 * gate redesign -- duplicated (not imported) for the same reason as the
 * pi-tui marker above: this must be able to detect the patch is gone even
 * if something about the ACP package itself is broken. Content-based only,
 * matching isPiTuiPatched()'s contract: this hand-patch has now been
 * silently wiped twice in one evening (2026-08-11) by mechanisms never
 * fully root-caused, and Stanley explicitly chose to keep npm-managed
 * auto-updates over forking it immune -- so detecting a silent revert
 * quickly is the accepted mitigation, not prevention. */
const ACP_COMPACTION_PATCH_MARKER = "SAFETY_CEILING_PCT";

/** Best-effort yes/no: is billion-context-pi's session_before_compact hook
 * still patched with the safe escape hatches, or has it silently reverted
 * to upstream's unconditional cancel:true? Always content-based, never
 * trusts an install-time record -- same contract as isPiTuiPatched(). Path
 * is fixed (not resolved via `which pi` like pi-tui) because ACP is
 * installed into pi's own agent npm dir, not hoisted alongside the pi
 * binary. Never throws: a missing/unreadable file means "can't confirm
 * patched", treated as unpatched for warning purposes. */
export function isAcpCompactionGatePatched(): boolean {
  try {
    const candidate = join(process.env.HOME ?? "/", ".pi", "agent", "npm", "node_modules", "billion-context-pi", "dist", "index.js");
    if (!existsSync(candidate)) return false;
    return readFileSync(candidate, "utf8").includes(ACP_COMPACTION_PATCH_MARKER);
  } catch {
    return false;
  }
}

export const KNOWN_STATES = new Set<string>(["working", "idle", "background", "attention", "error", "exited"]);

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
export function isKnownState(s: string): s is TitleState {
  return KNOWN_STATES.has(s);
}

export const STATE_PRIORITY: Record<TitleState, number> = { error: 0, attention: 0, working: 1, background: 1, idle: 2, exited: 3 };
/** Unknown states sort with the working set rather than at an edge: they are
 * live sessions saying something this dashboard has not learned yet, not
 * emergencies and not corpses. */
export function priorityOf(s: string): number {
  return isKnownState(s) ? STATE_PRIORITY[s] : 1;
}

const startupDigestCache = new Map<string, { mtimeMs: number; ctimeMs: number; size: number; digest: string }>();

function digestFile(p: string): string | undefined {
  try {
    const st = statSync(p);
    const hit = startupDigestCache.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs && hit.size === st.size) return hit.digest;
    const digest = createHash("sha256").update(readFileSync(p)).digest("hex");
    startupDigestCache.set(p, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, digest });
    return digest;
  } catch {
    return undefined;
  }
}

/** Recursively hashes every file under `root` that passes `filter`, paths
 * sorted for determinism, skipping .git and node_modules. Missing roots
 * contribute nothing. Used for the global and project resource roots (the
 * dirs a fresh process start actually loads) — NOT for transcripts, media,
 * or the rest of the agent dir, which startup never reads. */
function hashTree(h: ReturnType<typeof createHash>, root: string, filter: (full: string) => boolean): void {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && filter(full)) files.push(full);
    }
  };
  walk(root);
  files.sort();
  for (const f of files) {
    const d = digestFile(f);
    if (d !== undefined) h.update(`${f}:${d}\n`);
  }
}

/** Marker for one settings.packages entry: a digest of whatever changes when
 * that package is installed/updated, WITHOUT walking its whole tree.
 *  - npm: hash the single lockfile that covers every npm install — version
 *    bumps change it, one stat+read covers all npm packages.
 *  - git: hash the repo's .git/HEAD plus its package.json — `pi update`
 *    moves HEAD, so the ref change is caught even though settings.json's
 *    spec string is unchanged.
 *  - local path (relative to the agent dir, e.g. ../../codebase/pi-king):
 *    hash package.json + the source/resource dirs a fresh process start
 *    loads from it. This is how an edit to pi-king's own src/index.ts flags
 *    every session for restart — the package is a settings.packages entry. */
function packageMarker(spec: string): string | undefined {
  if (spec.startsWith("npm:")) {
    const lock = join(NORMAL_AGENT_DIR, "npm", "package-lock.json");
    return existsSync(lock) ? digestFile(lock) : undefined;
  }
  if (spec.startsWith("git:")) {
    const repo = spec.slice(4).replace(/@[^/]+$/, ""); // strip @ref suffix
    const dir = join(NORMAL_AGENT_DIR, "git", repo);
    const h = createHash("sha256");
    const head = join(dir, ".git", "HEAD");
    if (existsSync(head)) h.update("head:" + (digestFile(head) ?? "") + "\n");
    const pj = join(dir, "package.json");
    if (existsSync(pj)) h.update("pkg:" + (digestFile(pj) ?? "") + "\n");
    return h.digest("hex").slice(0, 12);
  }
  // Local path entry — resolve relative to the agent dir.
  const dir = join(NORMAL_AGENT_DIR, spec);
  if (!existsSync(dir)) return undefined;
  const h = createHash("sha256");
  const pj = join(dir, "package.json");
  if (existsSync(pj)) h.update("pkg:" + (digestFile(pj) ?? "") + "\n");
  hashTree(h, join(dir, "src"), (f) => /\.(ts|js|mjs|cjs)$/.test(f));
  hashTree(h, join(dir, "extensions"), (f) => /\.(ts|js|mjs|cjs)$/.test(f));
  hashTree(h, join(dir, "skills"), (f) => f.endsWith("/SKILL.md") || f.endsWith("\\SKILL.md"));
  hashTree(h, join(dir, "prompts"), (f) => f.endsWith(".md"));
  return h.digest("hex").slice(0, 12);
}

/** Deterministic fingerprint of everything a fresh `pi` process start in
 * `cwd` would load: the full canonical global settings.json (covers
 * enabledModels, provider/model defaults, packages, everything startup
 * reads), trust.json and keybindings.json when present, the global resource
 * roots, one marker per settings.packages entry, and the project scope
 * (.pi/settings.json + .pi resource roots) for this specific working dir.
 *
 * undefined means "could not read/parse a startup input right now", not "no
 * inputs" — callers must treat that as "cannot judge", never as a mismatch
 * against every session. Used identically on both sides of the comparison:
 * stamped by each session's own process at session_start (below), and read
 * fresh by the dashboard on every readSessions() call. */
export function computeStartupFingerprint(cwd: string): string | undefined {
  try {
    const h = createHash("sha256");
    const agent = NORMAL_AGENT_DIR;
    const settingsPath = join(agent, "settings.json");
    // ONE parsed snapshot, used for both the settings hash and the packages
    // loop below. Reading the file twice (once for each) could hash a hybrid
    // if pi rewrites settings.json between the two reads (Red review, risk
    // #4) — a false fingerprint from a moment of write-in-progress.
    const settingsRaw = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown[] };
    // Hash the parsed+stringified form, not the raw bytes: a format-only
    // rewrite of settings.json must not flag a restart nothing needs.
    h.update("settings:" + JSON.stringify(settingsRaw) + "\n");
    for (const f of ["trust.json", "keybindings.json"]) {
      const p = join(agent, f);
      if (existsSync(p)) h.update(`${f}:${digestFile(p) ?? ""}\n`);
    }
    const isTsJs = (f: string) => /\.(ts|js|mjs|cjs)$/.test(f);
    const isSkillMd = (f: string) => f.endsWith("/SKILL.md") || f.endsWith("\\SKILL.md");
    hashTree(h, join(agent, "extensions"), isTsJs);
    hashTree(h, join(agent, "skills"), isSkillMd);
    hashTree(h, join(agent, "prompts"), (f) => f.endsWith(".md"));
    hashTree(h, join(agent, "themes"), () => true);
    for (const spec of settingsRaw.packages ?? []) {
      const marker = packageMarker(String(spec));
      if (marker !== undefined) h.update(`pkg:${spec}:${marker}\n`);
    }
    // Project scope: the same inputs a fresh process start in THIS directory
    // would additionally load (project settings override global ones).
    const projSettings = join(cwd, ".pi", "settings.json");
    if (existsSync(projSettings)) h.update("proj-settings:" + (digestFile(projSettings) ?? "") + "\n");
    hashTree(h, join(cwd, ".pi", "extensions"), isTsJs);
    hashTree(h, join(cwd, ".pi", "skills"), isSkillMd);
    hashTree(h, join(cwd, ".pi", "prompts"), (f) => f.endsWith(".md"));
    hashTree(h, join(cwd, ".pi", "themes"), () => true);
    return h.digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

