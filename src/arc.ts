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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTmuxSession, SESSION_STATUS_DIR, TMUX, type ClientSize } from "./fleet.ts";

/** Poll interval for the composer-ready and delivery-verification loops.
 * Overridable only so tests need not sleep in real seconds; nothing in normal
 * operation should set it. */
const POLL_SEC = process.env.PI_KING_POLL_SEC?.trim() || "1";
function nap(): void {
  spawnSync("sleep", [POLL_SEC]);
}

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
  // Resolve symlinks FIRST. pi derives this directory from its own resolved
  // cwd, so on macOS "/tmp/x" becomes "/private/tmp/x" and seeding under
  // "--tmp-x--" puts the file somewhere pi will never look: the session comes
  // up with no seed, exits, and the tmux window vanishes seconds after we
  // reported success. Falls back to the raw path when the dir doesn't exist
  // yet, which is the only case realpathSync throws on.
  let resolved = cwd;
  try { resolved = realpathSync(cwd); } catch { /* not on disk yet: use as given */ }
  return join(SESSIONS_ROOT, `--${resolved.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")}--`);
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

/** The visible pane, whitespace-collapsed for comparison. The composer wraps
 * and indents what it holds, so a raw substring test against the pasted text
 * fails on anything longer than the pane is wide.
 *
 * Note for anyone tempted by `capture-pane -S -N` to get "the last N lines":
 * it does not do that. -S is a SCROLLBACK offset, so -S -4 returns the whole
 * visible pane PLUS 4 lines of history -- measured, 44 lines out of a 40-row
 * pane. An earlier version of this file used it as a tail and consequently
 * found the prompt on screen forever (it stays in the transcript after being
 * submitted), reporting every successful delivery as a failure. */
function paneText(target: string): string {
  const r = spawnSync(TMUX, ["capture-pane", "-t", target, "-p"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return "";
  return (r.stdout ?? "").replace(/\s+/g, " ");
}

/** The newest status card belonging to a tmux session of this name. This is
 * the same file the dashboard renders from, so agreeing with it is the point:
 * it reports what the user will actually see. */
function cardForName(name: string): { activity?: string; status?: string } | undefined {
  let best: { activity?: string; status?: string; lastActivity: number } | undefined;
  try {
    for (const f of readdirSync(SESSION_STATUS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = JSON.parse(readFileSync(join(SESSION_STATUS_DIR, f), "utf8")) as
          { name?: string; activity?: string; status?: string; lastActivity?: number };
        if (c.name !== name) continue;
        const at = Number(c.lastActivity ?? 0);
        if (!best || at > best.lastActivity) best = { activity: c.activity, status: c.status, lastActivity: at };
      } catch { /* a half-written card is not an error, just not yet readable */ }
    }
  } catch { return undefined; }
  return best;
}

/** A short, distinctive fragment of the prompt to look for on screen. First
 * non-empty line, because that is what the composer shows first and what
 * survives wrapping most predictably. */
function probeFor(prompt: string): string {
  const first = prompt.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return first.replace(/\s+/g, " ").slice(0, 40).trim();
}

export type Delivery =
  /** The session's own status card came back carrying this prompt: the turn
   * demonstrably started. */
  | { state: "submitted" }
  /** The text reached the composer, Enter was sent, but no card ever
   * confirmed a turn. Deliberately NOT called "unsubmitted": the negative is
   * not provable from outside, and a session whose pi-king extension is
   * missing would look identical to one that never submitted. */
  | { state: "unconfirmed" }
  /** Text never appeared on screen at all. */
  | { state: "not-pasted" }
  /** tmux refused a command outright. */
  | { state: "failed"; step: string };

/**
 * Put `prompt` into a pane's composer and submit it, then VERIFY both halves
 * actually happened by reading the pane back.
 *
 * Verification is not ceremony here. Dispatch hands a task to a session and
 * returns you to the dashboard, so nobody is looking at the pane: a prompt
 * that lands but is never submitted leaves a session sitting idle forever
 * with its work still in the composer, and the dashboard card cannot tell
 * that apart from a session that finished quickly. An arc at least drops you
 * into the window where you would see it.
 *
 * Both halves are checked because they fail differently and are fixed
 * differently -- "attach and press Enter" versus "attach and paste it
 * yourself" -- and a caller that cannot say which one happened has to tell
 * the user to go and look.
 */
function deliverPrompt(target: string, sessionName: string, prompt: string, token: string): Delivery {
  // load-buffer + paste-buffer rather than send-keys: prompts are multi-line
  // and contain characters send-keys would interpret. paste-buffer delivers
  // the text verbatim as one unit.
  const tmp = join(KING_DIR, `prompt-${token}.txt`);
  try {
    mkdirSync(KING_DIR, { recursive: true });
    writeFileSync(tmp, prompt);
  } catch {
    return { state: "failed", step: "write the prompt to a temp file" };
  }
  const buf = `piking-${token}`;
  const load = spawnSync(TMUX, ["load-buffer", "-b", buf, tmp], { encoding: "utf8", timeout: 5000 });
  if (load.status !== 0) return { state: "failed", step: "load the prompt into a tmux buffer" };

  // -p AND -r are both required, not just -p. paste-buffer replaces every LF
  // in the buffer with CR by default (a separate step from bracket-wrapping),
  // and pi's composer treats CR as Enter/submit. -p wraps the (still
  // CR-laden) stream in bracketed-paste codes, which pi's editor.js currently
  // repairs by normalizing \r -> \n on paste -- but that is pi papering over
  // tmux's mangling, not a guarantee. -r makes paste-buffer emit LF so the
  // bytes are byte-faithful either way.
  //
  // Origin: measured by the fullscreen-perf arc, 2026-08-13, session
  // 019ffa8f-6dd9-7e61-ae8b-ce3babd99baa -- a 43-line brief without both
  // flags arrived as 43 SEPARATE submitted user turns. That fix and this
  // extraction touch the same line on two branches; they are the same change.
  // Dispatch is where it matters most: the shredding happens off-screen.
  const paste = spawnSync(TMUX, ["paste-buffer", "-p", "-r", "-b", buf, "-t", target, "-d"], { encoding: "utf8", timeout: 5000 });
  if (paste.status !== 0) return { state: "failed", step: "paste the prompt into the pane" };

  const probe = probeFor(prompt);
  // Did the text actually arrive? Polled, not assumed: paste-buffer exiting 0
  // only means tmux accepted the command.
  let pasted = false;
  for (let i = 0; i < 10 && !pasted; i++) {
    if (probe && paneText(target).includes(probe)) pasted = true;
    else nap();
  }
  if (!pasted) return { state: "not-pasted" };

  // Enter as a separate send-keys: paste-buffer alone leaves the text in the
  // composer unsubmitted.
  const enter = spawnSync(TMUX, ["send-keys", "-t", target, "Enter"], { encoding: "utf8", timeout: 5000 });
  if (enter.status !== 0) return { state: "failed", step: "send Enter to submit the prompt" };

  // Submission is confirmed from the session's own status card rather than
  // from the screen. Screen position cannot answer this: the prompt is
  // visible both before submission (in the composer) and after (as the user's
  // message in the transcript), and which rows it occupies depends on how
  // much the agent has since printed. The card's `activity` field is set from
  // the prompt when the turn starts, so its appearance IS the turn starting.
  // Measured 2026-08-13: activity came back as
  // "Done: Create a file called done.txt in the current directory...".
  for (let i = 0; i < 15; i++) {
    nap();
    const card = cardForName(sessionName);
    if (card?.activity && card.activity.replace(/\s+/g, " ").includes(probe)) return { state: "submitted" };
  }
  return { state: "unconfirmed" };
}

export type SpawnResult = {
  ok: boolean;
  message: string;
  id?: string;
  sessionFile?: string;
  tmuxName?: string;
  delivery?: Delivery;
};

/**
 * Create a fresh tmux-hosted pi session and give it a first prompt.
 *
 * The shared core of `spawnArc` and `dispatchSession`, which differ in only
 * two things: an arc has a PARENT (so it seeds a session file carrying a
 * parentSession pointer and records lineage), and dispatch comes from the
 * dashboard (so it knows the client size to spawn at). Everything else --
 * name sanitation, the duplicate check, waiting for the composer, delivery,
 * verification -- is one implementation on purpose. The delivery half is
 * fiddly enough that a second copy would drift, and the CR-shredding bug
 * above is exactly what drift looks like.
 */
function spawnSessionWithPrompt(opts: {
  name: string;
  prompt: string;
  cwd: string;
  /** Arc mode. Present: seed a session file pointing at this parent and
   * record the relationship in lineage.json. Absent: let pi create its own
   * session, and record nothing -- a dispatched session is not anyone's
   * child. */
  parent?: { sessionFile?: string; id?: string };
  /** Spawn geometry. The dashboard knows the real client size and passes it
   * (Fix 1 of the tmux perf audit); arcs keep tmux's default. */
  liveSize?: ClientSize;
  readyTimeoutSec?: number;
  /** Word for this thing in user-facing messages: "Arc" or "Session". */
  label: string;
}): SpawnResult {
  const { name, prompt, cwd, label } = opts;
  if (!name.trim()) return { ok: false, message: `${label} needs a name.` };
  if (!prompt.trim()) return { ok: false, message: `${label} needs a prompt \u2014 that is the whole point of dispatching one.` };
  if (!existsSync(cwd)) return { ok: false, message: `cwd does not exist: ${cwd}` };
  // tmux session names are the addressing key for every later operation; a
  // name with ':' or '.' would be parsed as window/pane coordinates.
  const safeName = name.replace(/[:.]/g, "-").trim();

  const exists = spawnSync(TMUX, ["has-session", "-t", `=${safeName}`], { encoding: "utf8", timeout: 5000 });
  if (exists.status === 0) return { ok: false, message: `A tmux session named "${safeName}" already exists.` };

  // Seeding exists only to plant the parentSession pointer, so it is bound to
  // parent mode. Without it pi picks its own id and writes its own file --
  // which also avoids having to reproduce pi's cwd canonicalization, where
  // sessionDirFor("/tmp/x") yields "--tmp-x--" but pi, resolving the symlink
  // first, writes "--private-tmp-x--" (measured 2026-08-13; a seed in the
  // wrong directory is ignored and the id then exists twice on disk).
  const seed = opts.parent ? writeSeedSession(cwd, opts.parent.sessionFile) : undefined;
  const created = createTmuxSession(safeName, cwd, seed?.id, opts.liveSize);
  if (!created.ok) return { ok: false, message: created.message };

  // Record lineage BEFORE the prompt is sent: if delivery fails, the arc
  // still exists and must remain discoverable/attributable rather than
  // becoming an untracked orphan window.
  if (seed && opts.parent) {
    const l = readLineage();
    l.arcs.push({
      id: seed.id,
      parentId: opts.parent.id ?? "",
      name: safeName,
      cwd,
      brief: prompt,
      sessionFile: seed.file,
      createdAt: Date.now(),
      closedAt: null,
    });
    writeLineage(l);
  }

  const base = { id: seed?.id, sessionFile: seed?.file, tmuxName: safeName };
  const target = `=${safeName}:0.0`;
  const deadline = Date.now() + (opts.readyTimeoutSec ?? 90) * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    if (paneReady([], target)) { ready = true; break; }
    nap();
  }
  if (!ready) {
    return { ...base, ok: true, delivery: { state: "not-pasted" },
      message: `${label} "${safeName}" created, but its composer never became ready \u2014 the prompt was NOT sent. Attach and paste it yourself.` };
  }

  const delivery = deliverPrompt(target, safeName, prompt, seed?.id ?? `${safeName}-${Date.now()}`);
  if (delivery.state === "submitted") {
    return { ...base, ok: true, delivery,
      message: `${label} "${safeName}" started in ${cwd} and the prompt was delivered.` };
  }
  if (delivery.state === "unconfirmed") {
    return { ...base, ok: true, delivery,
      message: `${label} "${safeName}" created and the prompt reached its composer, but no turn was confirmed. Attach and check \u2014 press Enter if it is still sitting there.` };
  }
  if (delivery.state === "not-pasted") {
    return { ...base, ok: true, delivery,
      message: `${label} "${safeName}" created, but the prompt never reached its composer. Attach and paste it yourself.` };
  }
  return { ...base, ok: true, delivery,
    message: `${label} "${safeName}" created, but tmux failed to ${delivery.step}. Attach and paste it yourself.` };
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "do", "does",
  "for", "from", "get", "have", "how", "i", "if", "in", "into", "is", "it", "its", "make",
  "me", "my", "of", "on", "or", "our", "please", "should", "so", "than", "that", "the",
  "their", "then", "there", "this", "to", "up", "us", "use", "was", "we", "what", "when",
  "which", "why", "will", "with", "would", "you", "your",
]);

/**
 * A short name guessed from the task text \u2014 a DEFAULT for the dispatch name
 * prompt, not a replacement for it. Stanley names sessions himself ("I prefer
 * using `n` for a more clear directory naming and to avoid confusion"), so
 * this only has to be a decent starting point he can type over.
 *
 * Deliberately a heuristic and never a model call: a dispatch must not wait
 * on a round-trip \u2014 or fail \u2014 just to prefill a text field.
 */
export function slugForTask(task: string): string {
  const words = task
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    kept.push(w);
    if (kept.length === 3) break;
  }
  // Every word was a stopword ("do it for me"): fall back to the raw words
  // rather than returning an empty name the caller has to special-case.
  const use = kept.length > 0 ? kept : words.slice(0, 3);
  return use.join("-").slice(0, 32).replace(/-+$/, "") || "task";
}

/**
 * Dispatch: hand a task to a NEW tmux-hosted session and stay where you are.
 *
 * The dashboard's `n` creates an empty session and drops you into it; you
 * then type the task yourself. This is the other half \u2014 you supply the task
 * and the session goes and does it. Same substrate as every other pi-king
 * session (tmux is the broker), so it attaches, detaches, renames, restarts
 * and reports state exactly like one, because it IS one.
 */
export function dispatchSession(opts: {
  name: string;
  task: string;
  cwd: string;
  liveSize?: ClientSize;
  readyTimeoutSec?: number;
}): SpawnResult {
  return spawnSessionWithPrompt({
    name: opts.name,
    prompt: opts.task,
    cwd: opts.cwd,
    liveSize: opts.liveSize,
    readyTimeoutSec: opts.readyTimeoutSec,
    label: "Session",
  });
}

/** Kept as a distinct name because the arc tool and the /arc command are
 * typed against it. Structurally a SpawnResult. */
export type SpawnArcResult = SpawnResult;

/**
 * Spawn an arc: fresh child session in its own tmux window, first prompt sent
 * by the parent.
 *
 * Thin wrapper over spawnSessionWithPrompt -- an arc IS a dispatch that
 * records its parent. Keeping one implementation is deliberate: the delivery
 * half is subtle (see the -p -r note in deliverPrompt) and a second copy is
 * exactly where that subtlety would rot back out.
 */
export function spawnArc(opts: {
  name: string;
  brief: string;
  cwd: string;
  parentSessionFile?: string;
  parentId?: string;
  /** Seconds to wait for the child's composer before giving up on auto-sending
   * the brief. The session still exists on timeout -- only the auto-send is
   * skipped, and the caller is told so it can paste by hand. */
  readyTimeoutSec?: number;
}): SpawnArcResult {
  if (!opts.brief.trim()) {
    return { ok: false, message: "Arc needs a brief \u2014 the child starts with no context but this." };
  }
  return spawnSessionWithPrompt({
    name: opts.name,
    prompt: opts.brief,
    cwd: opts.cwd,
    parent: { sessionFile: opts.parentSessionFile, id: opts.parentId },
    readyTimeoutSec: opts.readyTimeoutSec,
    label: "Arc",
  });
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

/** Exact names of the tmux sessions that exist right now. One list-sessions
 * call for the whole listing rather than a has-session per arc, and exact
 * because tmux target resolution falls back to prefix matching (see
 * fleet.tmuxSessionExists). */
function liveSessionNames(): Set<string> {
  const r = spawnSync(TMUX, ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 3000 });
  // A tmux server with no sessions exits non-zero; that is "none", not an error.
  if (r.status !== 0) return new Set();
  return new Set(String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean));
}

/** The arc's own status card, keyed by session id (the dashboard's file).
 * undefined means NO CARD — a different thing from a card saying "exited". */
function statusOf(id: string): string | undefined {
  try {
    const c = JSON.parse(readFileSync(join(SESSION_STATUS_DIR, `${id}.json`), "utf8")) as { status?: string };
    return typeof c.status === "string" ? c.status : "?";
  } catch { return undefined; }
}

export type ArcState = ArcRecord & {
  /** "closed", the card's own status, or "gone" when there is neither a card
   * nor a window to ask. */
  status: string;
  /** Closed on purpose, or provably over. */
  finished: boolean;
};

/** Decorate lineage records with what is actually true right now.
 *
 * lineage.json records the RELATIONSHIP and is only written when someone types
 * /arc close, so it drifts: it read 6 arcs open while 4 were live. An arc with
 * no status card AND no tmux session is finished whether or not anyone said
 * so, and is reported as such — but NOT written back. Listing stays a read;
 * a `/arc` that silently rewrote lineage would surprise the next reader. */
export function arcStates(arcs: ArcRecord[]): ArcState[] {
  const live = liveSessionNames();
  return arcs.map((a) => {
    const card = statusOf(a.id);
    const gone = card === undefined && !live.has(a.name);
    return {
      ...a,
      status: a.closedAt ? "closed" : card ?? (gone ? "gone" : "no card"),
      finished: a.closedAt != null || gone,
    };
  });
}

/** What `/arc` lists: open arcs only, unless `all`. */
export function listArcs(opts: { parentId?: string; all?: boolean } = {}): ArcState[] {
  const states = arcStates(opts.parentId ? arcsOf(opts.parentId) : allArcs());
  return opts.all ? states : states.filter((a) => !a.finished);
}

/**
 * Close an arc: kill its tmux session, keep its transcript.
 *
 * Closing used to be bookkeeping only, so every closed arc left a live pi
 * process idling in the fleet and the list only ever grew. The transcript is
 * the artifact worth keeping (arc_digest reads it); the window is not.
 */
export function closeArc(idOrName: string): { ok: boolean; message: string } {
  const l = readLineage();
  const a = l.arcs.find((x) => x.id === idOrName || x.name === idOrName || x.id.startsWith(idOrName));
  if (!a) return { ok: false, message: `No arc matching "${idOrName}".` };
  // Same rule /bg enforces before a handoff: killing mid-turn discards the
  // in-flight response and any subagents it started. "attention" is NOT
  // refused — nothing is running, the arc is parked on a question — but the
  // picker labels it so choosing it is deliberate.
  if (statusOf(a.id) === "working") {
    return { ok: false, message: `Arc "${a.name}" is mid-turn — closing now would discard its in-flight response and kill its subagents. Let it finish, then close.` };
  }
  const running = liveSessionNames().has(a.name);
  if (running) {
    // "=name" is an EXACT target. Without the "=" tmux falls back to prefix and
    // fnmatch matching, so closing "arc-fix" could kill "arc-fix-smoketest".
    const r = spawnSync(TMUX, ["kill-session", "-t", `=${a.name}`], { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) {
      return { ok: false, message: `Could not kill tmux session "${a.name}": ${String(r.stderr || "").trim() || `tmux exited ${r.status}`}` };
    }
  } else if (a.closedAt) {
    return { ok: true, message: `Arc "${a.name}" was already closed.` };
  }
  if (!a.closedAt) {
    a.closedAt = Date.now();
    writeLineage(l);
  }
  return {
    ok: true,
    message: `Arc "${a.name}" closed — ${running ? "tmux session killed" : "no tmux session was running"}. Transcript kept at ${a.sessionFile}; \`/arc all\` still lists it.`,
  };
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
