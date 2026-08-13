/**
 * arc — spawn a fresh, FAST child session for one unit of work, linked to the
 * session that spawned it.
 *
 * WHY THIS EXISTS (measured 2026-08-13, docs/PERF-TMUX-SPEC.md):
 * pi's TUI render cost scales with retained session size, and typing latency in
 * long sessions is an OPEN upstream bug (earendil-works/pi#6665) whose fix must
 * happen in pi's core. A 21,471-entry session is permanently laggy and there is
 * no local fix. The only durable answer is to stop growing single sessions.
 *
 * WHY NOT /fork OR /clone: both COPY history. `SessionManager
 * .createBranchedSession(leafId)` calls getBranch(leafId) — the full ancestor
 * path — and writes every one of those entries into the new file. A clone of a
 * 21k-entry session is a 21k-entry session: same size, same lag, zero benefit.
 * Verified by reading the installed dist, and confirmed empirically (a real
 * fork's first message IDs are byte-identical to its parent's).
 *
 * WHAT THIS DOES INSTEAD: writes a session file containing ONLY a header whose
 * `parentSession` points at the spawning session, then starts pi on it. pi
 * accepts a header-only file and builds a working session from it (verified:
 * a seeded child answered a prompt at CTX 3.7% while its parent sat at 21,470
 * entries). Because `buildSessionTree()` in pi's session-selector groups purely
 * by `parentSessionPath` — it does not care whether a child was forked or born
 * empty — the child ALSO renders indented under its parent in /resume. Full
 * lineage display, none of the weight.
 *
 * CWD AND THE /resume TREE: pi's resume picker has two views — one scoped to the
 * current cwd's session directory (SessionManager.list) and an all-sessions view
 * (SessionManager.listAll). Sessions are stored per-cwd, so an arc given a
 * DIFFERENT cwd than its parent lands in a different directory and their tree
 * link is only visible in the all-sessions view. That is why cwd defaults to the
 * parent's: the lineage then shows in both views. Overriding cwd is supported
 * and safe (lineage.json still records it) — the link just becomes less visible.
 *
 * ROBUSTNESS: pi's own parentSession is a filesystem PATH, and paths rot —
 * Alexandria's own parent pointer is already dead, which is why its lineage is
 * invisible. So the durable record here is by session ID in
 * ~/.pi/king/lineage.json; the header path is only the display layer for
 * /resume. Losing the file never loses the relationship.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTmuxSession, TMUX } from "./fleet.ts";

const KING_DIR = join(homedir(), ".pi", "king");
const LINEAGE_FILE = join(KING_DIR, "lineage.json");
const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

export type ArcRecord = {
  /** Child session id — the durable key. */
  id: string;
  /** Spawning session's id. Survives the parent's FILE moving or being deleted. */
  parentId: string;
  name: string;
  cwd: string;
  /** The brief the parent sent as the child's first prompt, kept so a later
   * digest can judge the work against what was actually ASKED, not against
   * what the child later decided the job was. */
  brief: string;
  sessionFile: string;
  createdAt: number;
  /** Set when the arc is closed out; null while open. */
  closedAt?: number | null;
};

type Lineage = { arcs: ArcRecord[] };

function readLineage(): Lineage {
  try {
    const raw = JSON.parse(readFileSync(LINEAGE_FILE, "utf8")) as Lineage;
    return Array.isArray(raw?.arcs) ? raw : { arcs: [] };
  } catch {
    return { arcs: [] };
  }
}

function writeLineage(l: Lineage): void {
  mkdirSync(KING_DIR, { recursive: true });
  // Write-then-rename: a torn lineage.json would silently orphan every arc,
  // and this file is the ONLY durable record of the relationships.
  const tmp = `${LINEAGE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(l, null, 1));
  execFileSync("mv", [tmp, LINEAGE_FILE]);
}

/** pi's on-disk session directory for a cwd: the absolute path with every
 * non-alphanumeric run collapsed to "-", wrapped in "--". Mirrors pi's own
 * layout (observed: /Users/stanz/codebase/alexandria ->
 * --Users-stanz-codebase-alexandria--). */
export function sessionDirFor(cwd: string): string {
  return join(SESSIONS_ROOT, `--${cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")}--`);
}

/** UUIDv7-shaped id, matching the format pi generates (time-ordered prefix so
 * sessions sort chronologically by id). */
function newSessionId(): string {
  const ms = Date.now();
  const h = ms.toString(16).padStart(12, "0");
  const b = Array.from({ length: 10 }, () => Math.floor(Math.random() * 256));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${(b[0] & 0x0f).toString(16)}${hex(b[1])}-${hex((b[2] & 0x3f) | 0x80)}${hex(b[3])}-${hex(b[4])}${hex(b[5])}${hex(b[6])}${hex(b[7])}${hex(b[8])}${hex(b[9])}`;
}

function stamp(d: Date): { iso: string; file: string } {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}Z`;
  return { iso: base.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d\d\d)Z/, "T$1:$2:$3.$4Z"), file: base };
}

/** Write the header-only session file that becomes the child. */
export function writeSeedSession(cwd: string, parentSessionFile: string | undefined): { id: string; file: string } {
  const id = newSessionId();
  const now = new Date();
  const { iso, file } = stamp(now);
  const dir = sessionDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${file}_${id}.jsonl`);
  const header: Record<string, unknown> = { type: "session", version: 3, id, timestamp: iso, cwd };
  // Only claim a parent when the file is really there: pi's buildSessionTree
  // silently promotes a child whose parent path does not resolve to a ROOT, so
  // a dangling pointer would quietly look like an unrelated top-level session.
  if (parentSessionFile && existsSync(parentSessionFile)) header.parentSession = parentSessionFile;
  writeFileSync(path, `${JSON.stringify(header)}\n`);
  return { id, file: path };
}

/** True once the pane's pi is past boot and showing its composer. Polled rather
 * than slept-on because a large parent repo (or a cold model catalogue) makes
 * boot time vary by seconds, and pasting the brief into a not-yet-ready
 * composer silently drops it. */
function paneReady(sock: string[], target: string): boolean {
  const r = spawnSync(TMUX, [...sock, "capture-pane", "-t", target, "-p"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return false;
  const out = r.stdout ?? "";
  return out.includes("escape interrupt") || out.includes("/ commands");
}

export type SpawnArcResult = { ok: boolean; message: string; id?: string; sessionFile?: string };

/**
 * Spawn an arc: fresh child session in its own tmux window, first prompt sent
 * by the parent.
 */
export function spawnArc(opts: {
  name: string;
  brief: string;
  cwd: string;
  parentSessionFile?: string;
  parentId?: string;
  /** Seconds to wait for the child's composer before giving up on auto-sending
   * the brief. The session still exists on timeout — only the auto-send is
   * skipped, and the caller is told so it can paste by hand. */
  readyTimeoutSec?: number;
}): SpawnArcResult {
  const { name, brief, cwd } = opts;
  if (!name.trim()) return { ok: false, message: "Arc needs a name." };
  if (!brief.trim()) return { ok: false, message: "Arc needs a brief — the child starts with no context but this." };
  if (!existsSync(cwd)) return { ok: false, message: `cwd does not exist: ${cwd}` };
  // tmux session names are the addressing key for every later operation; a
  // name with ':' or '.' would be parsed as window/pane coordinates.
  const safeName = name.replace(/[:.]/g, "-").trim();

  const exists = spawnSync(TMUX, ["has-session", "-t", `=${safeName}`], { encoding: "utf8", timeout: 5000 });
  if (exists.status === 0) return { ok: false, message: `A tmux session named "${safeName}" already exists.` };

  const seed = writeSeedSession(cwd, opts.parentSessionFile);
  const created = createTmuxSession(safeName, cwd, seed.id);
  if (!created.ok) return { ok: false, message: created.message };

  // Record lineage BEFORE the brief is sent: if the paste fails, the arc still
  // exists and must remain discoverable/attributable rather than becoming an
  // untracked orphan window.
  const l = readLineage();
  l.arcs.push({
    id: seed.id,
    parentId: opts.parentId ?? "",
    name: safeName,
    cwd,
    brief,
    sessionFile: seed.file,
    createdAt: Date.now(),
    closedAt: null,
  });
  writeLineage(l);

  const target = `=${safeName}:0.0`;
  const deadline = Date.now() + (opts.readyTimeoutSec ?? 90) * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    if (paneReady([], target)) { ready = true; break; }
    spawnSync("sleep", ["1"]);
  }
  if (!ready) {
    return { ok: true, id: seed.id, sessionFile: seed.file,
      message: `Arc "${safeName}" created, but its composer never became ready — the brief was NOT sent. Attach and paste it yourself.` };
  }

  // load-buffer + paste-buffer rather than send-keys: briefs are multi-line and
  // contain characters send-keys would interpret. paste-buffer delivers the text
  // verbatim as one unit.
  //
  // -p -r are both required, not just -p: tmux's paste-buffer replaces every LF
  // in the buffer with CR by default (a separate step from bracket-wrapping),
  // and pi's composer treats CR as Enter/submit. -p wraps the (still CR-laden)
  // stream in bracketed-paste codes, which pi's editor.js currently repairs by
  // normalizing \r -> \n on paste -- but that's pi papering over tmux's mangling,
  // not a guarantee. -r makes paste-buffer emit LF (not CR) so the bytes are
  // byte-faithful regardless of whether pi's paste handler keeps doing that
  // normalization. Without both flags, a multi-paragraph brief gets shredded
  // into one submitted message per line (confirmed 2026-08-13, session
  // 019ffa8f-6dd9-7e61-ae8b-ce3babd99baa: 43 lines -> 43 separate user turns).
  const tmp = join(KING_DIR, `arc-brief-${seed.id}.txt`);
  writeFileSync(tmp, brief);
  const buf = `arcbrief-${seed.id}`;
  const load = spawnSync(TMUX, ["load-buffer", "-b", buf, tmp], { encoding: "utf8", timeout: 5000 });
  if (load.status !== 0) {
    return { ok: true, id: seed.id, sessionFile: seed.file,
      message: `Arc "${safeName}" created, but the brief could not be loaded into tmux. Attach and paste it yourself.` };
  }
  const paste = spawnSync(TMUX, ["paste-buffer", "-p", "-r", "-b", buf, "-t", target, "-d"], { encoding: "utf8", timeout: 5000 });
  if (paste.status !== 0) {
    return { ok: true, id: seed.id, sessionFile: seed.file,
      message: `Arc "${safeName}" created, but the brief could not be pasted into the pane. Attach and paste it yourself.` };
  }
  // Enter as a separate send-keys: paste-buffer alone leaves the text in the
  // composer unsubmitted.
  spawnSync("sleep", ["1"]);
  const enter = spawnSync(TMUX, ["send-keys", "-t", target, "Enter"], { encoding: "utf8", timeout: 5000 });
  if (enter.status !== 0) {
    return { ok: true, id: seed.id, sessionFile: seed.file,
      message: `Arc "${safeName}" created, the brief is in the composer, but Enter could not be sent to submit it. Attach and press Enter yourself.` };
  }

  return { ok: true, id: seed.id, sessionFile: seed.file,
    message: `Arc "${safeName}" spawned in ${cwd} and the brief was sent. Attach it from the dashboard to steer it.` };
}

/** Arcs spawned by a given parent session id (open ones first, newest first). */
export function arcsOf(parentId: string): ArcRecord[] {
  return readLineage().arcs
    .filter((a) => a.parentId === parentId)
    .sort((a, b) => (Number(a.closedAt != null) - Number(b.closedAt != null)) || b.createdAt - a.createdAt);
}

export function allArcs(): ArcRecord[] {
  return readLineage().arcs.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export function findArc(idOrName: string): ArcRecord | undefined {
  const arcs = readLineage().arcs;
  return arcs.find((a) => a.id === idOrName)
    ?? arcs.find((a) => a.name === idOrName)
    ?? arcs.find((a) => a.id.startsWith(idOrName));
}

export function closeArc(idOrName: string): { ok: boolean; message: string } {
  const l = readLineage();
  const a = l.arcs.find((x) => x.id === idOrName || x.name === idOrName || x.id.startsWith(idOrName));
  if (!a) return { ok: false, message: `No arc matching "${idOrName}".` };
  if (a.closedAt) return { ok: true, message: `Arc "${a.name}" was already closed.` };
  a.closedAt = Date.now();
  writeLineage(l);
  return { ok: true, message: `Arc "${a.name}" marked closed. Its window and transcript are untouched — kill it yourself when you're done reading.` };
}

/**
 * Extract just the conversation from an arc's transcript, for digestion.
 *
 * Measured on a real 29.2MB transcript: user+assistant text is 4.4MB — 14.9%.
 * Tool calls and their results are the other 85%, and they are exactly what a
 * digest should NOT re-read (the receipt and the git history already carry the
 * mechanical record; what is lost otherwise is REASONING).
 */
export function extractConversation(sessionFile: string, maxChars = 200_000): { text: string; truncated: boolean; rawBytes: number; keptChars: number } {
  const raw = readFileSync(sessionFile, "utf8");
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "message") continue;
    const msg = e.message ?? e;
    const role = msg?.role ?? e?.role;
    if (role !== "user" && role !== "assistant") continue;
    const c = msg?.content ?? e?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
    if (text.trim()) parts.push(`[${role}] ${text.trim()}`);
  }
  const joined = parts.join("\n\n");
  return {
    text: joined.length > maxChars ? joined.slice(-maxChars) : joined,
    truncated: joined.length > maxChars,
    rawBytes: Buffer.byteLength(raw),
    keptChars: Math.min(joined.length, maxChars),
  };
}
