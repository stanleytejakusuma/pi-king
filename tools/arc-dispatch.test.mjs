// Tests for dispatch (task -> new tmux session) and the shared spawn core it
// now has in common with arcs.
//
// Everything runs against a FAKE tmux binary (PI_KING_TMUX) and a scratch HOME,
// so no real fleet session, no real ~/.pi/king/lineage.json, and no real tmux
// server is touched. The fake logs every argv line so the tests can assert on
// the exact command sequence, and answers capture-pane from scriptable frame
// files so composer state can be driven call by call.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, chmodSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "king-dispatch-test-"));
const LOG = join(scratch, "tmux.log");
const HOME = join(scratch, "home");
const STATUS = join(scratch, "status");
mkdirSync(HOME, { recursive: true });
mkdirSync(STATUS, { recursive: true });

// The fake is bash rather than node on purpose: the spawn core shells out ~15
// times per dispatch, and a node-based fake put enough load on the box to make
// the timing-sensitive claimInjected test in jobs.test.mjs flake when the suite
// runs its files in parallel. Bash keeps each call to one cheap fork.
//
// capture-pane prints frame.<n> then advances n, so a test can stage the screen
// call by call ("composer ready" -> "text pasted" -> "composer cleared"). The
// index clamps down to the highest frame that exists, so the final frame
// repeats forever and a test only describes the frames it cares about.
const FAKE = join(scratch, "tmux");
writeFileSync(
  FAKE,
  [
    "#!/bin/bash",
    `D=${JSON.stringify(scratch)}`,
    'echo "$*" >> "$D/tmux.log"',
    'case "$1" in',
    '  has-session) [ -f "$D/session_exists" ] && exit 0 || exit 1 ;;',
    '  new-session) [ -f "$D/new_session_fails" ] && exit 1 || exit 0 ;;',
    '  load-buffer) [ -f "$D/load_fails" ] && exit 1 || exit 0 ;;',
    "  capture-pane)",
    '    n=$(cat "$D/frame" 2>/dev/null || echo 0)',
    '    echo $((n + 1)) > "$D/frame"',
    '    while [ "$n" -gt 0 ] && [ ! -f "$D/frame.$n" ]; do n=$((n - 1)); done',
    '    cat "$D/frame.$n" 2>/dev/null',
    "    exit 0 ;;",
    "esac",
    "exit 0",
  ].join("\n"),
);
chmodSync(FAKE, 0o755);

const flag = (name, on) => {
  const f = join(scratch, name);
  if (on) writeFileSync(f, "");
  else rmSync(f, { force: true });
};
/** Stage the screens capture-pane will return, in order, and rewind. */
const setFrames = (frames) => {
  for (let i = 0; i < 12; i++) rmSync(join(scratch, `frame.${i}`), { force: true });
  frames.forEach((f, i) => writeFileSync(join(scratch, `frame.${i}`), f));
  writeFileSync(join(scratch, "frame"), "0");
};
const reset = ({ sessionExists = false } = {}) => {
  writeFileSync(LOG, "");
  flag("session_exists", sessionExists);
};
const log = () => readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
/** Stand in for the dispatched session's own status card. Delivery is
 * confirmed from this file, not from the screen -- see deliverPrompt. */
const writeCard = (name, activity) =>
  writeFileSync(join(STATUS, `${name}.json`), JSON.stringify({ name, activity, status: "working", lastActivity: Date.now() }));
const clearCards = () => {
  for (const f of readdirSync(STATUS)) rmSync(join(STATUS, f), { force: true });
};

// Env must be set BEFORE the import: arc.ts resolves KING_DIR/TMUX/POLL_SEC at
// module load. HOME is redirected so KING_DIR lands in the scratch tree --
// Node's os.homedir() honours $HOME on POSIX.
process.env.HOME = HOME;
process.env.PI_KING_TMUX = FAKE;
process.env.PI_KING_STATUS_DIR = STATUS;
process.env.PI_KING_POLL_SEC = "0";
const { dispatchSession, sessionDirFor, slugForTask, spawnArc } = await import("../src/arc.ts");

const READY = "escape interrupt";
const TASK = "Fix the flaky retry test in the uploader";
// probeFor() takes the first 40 chars of the first non-empty line.
const HAPPY = [READY, `${READY}\n> ${TASK}`, READY];
/** The happy path needs BOTH halves: the text visible on the pane (paste
 * landed) and a card carrying it (turn started). */
const happyPath = (name) => {
  reset();
  setFrames(HAPPY);
  clearCards();
  writeCard(name, `Done: ${TASK}`);
};

test("slugForTask makes a typeable default from the task, skipping stopwords", () => {
  assert.equal(slugForTask("Fix the flaky retry test in the uploader"), "fix-flaky-retry");
  assert.equal(slugForTask("Please could you refactor the auth middleware"), "refactor-auth-middleware");
  // All-stopword input must still yield something rather than an empty name.
  assert.equal(slugForTask("do it for me"), "do-it-for");
  assert.equal(slugForTask("!!!"), "task");
  assert.ok(slugForTask("a".repeat(80)).length <= 32);
});

test("dispatch creates the session, delivers the task, and verifies submission", () => {
  happyPath("uploader-fix");
  const r = dispatchSession({ name: "uploader-fix", task: TASK, cwd: scratch });

  assert.equal(r.ok, true);
  assert.deepEqual(r.delivery, { state: "submitted" });
  assert.match(r.message, /delivered/);
  assert.equal(r.tmuxName, "uploader-fix");

  const lines = log();
  assert.ok(lines.some((l) => l.startsWith("has-session")), "checks for a name collision first");
  assert.ok(lines.some((l) => l.startsWith("new-session")), "creates the tmux session");
  assert.ok(lines.some((l) => l.startsWith("load-buffer")), "loads the task into a buffer");
  assert.ok(lines.some((l) => l === "send-keys -t =uploader-fix:0.0 Enter"), "submits with a separate Enter");
  // Order matters: Enter must come after the paste, not before.
  assert.ok(
    lines.findIndex((l) => l.startsWith("paste-buffer")) < lines.findIndex((l) => l.includes("Enter")),
    "pastes before submitting",
  );
});

test("paste-buffer uses -p AND -r so multi-line tasks are not shredded into one turn per line", () => {
  // Regression guard. Without -r, tmux rewrites every LF to CR and pi's
  // composer reads CR as submit: a 43-line brief arrived as 43 separate user
  // turns (measured 2026-08-13, session 019ffa8f-6dd9-7e61-ae8b-ce3babd99baa).
  // Dispatch is the worst place for this because nobody is watching the pane.
  happyPath("flags-check");
  dispatchSession({ name: "flags-check", task: TASK, cwd: scratch });
  const paste = log().find((l) => l.startsWith("paste-buffer"));
  assert.ok(paste, "pasted at all");
  assert.match(paste, /(^| )-p( |$)/, "bracketed-paste flag present");
  assert.match(paste, /(^| )-r( |$)/, "no-LF-to-CR-translation flag present");
});

test("a task with no turn behind it is reported as unconfirmed, not as success", () => {
  reset();
  setFrames(HAPPY);
  clearCards(); // pasted, Enter sent, but no card ever carries the prompt
  const r = dispatchSession({ name: "stuck-one", task: TASK, cwd: scratch });
  assert.equal(r.ok, true, "the session exists and must not be reported as a failure to create");
  assert.equal(r.delivery?.state, "unconfirmed");
  assert.match(r.message, /press Enter/, "tells the user how to recover by hand");
});

test("a card for a DIFFERENT session does not count as confirmation", () => {
  reset();
  setFrames(HAPPY);
  clearCards();
  writeCard("somebody-else", `Done: ${TASK}`);
  const r = dispatchSession({ name: "mine", task: TASK, cwd: scratch });
  assert.equal(r.delivery?.state, "unconfirmed");
});

test("a card that predates this prompt does not count as confirmation", () => {
  reset();
  setFrames(HAPPY);
  clearCards();
  // Session exists and is idle from earlier work: right name, wrong activity.
  writeCard("recycled", "Done: something else entirely");
  const r = dispatchSession({ name: "recycled", task: TASK, cwd: scratch });
  assert.equal(r.delivery?.state, "unconfirmed");
});

test("a task that never reaches the composer is reported as not-pasted", () => {
  reset();
  clearCards();
  setFrames([READY]); // ready, but the text never shows up
  const r = dispatchSession({ name: "lost-one", task: TASK, cwd: scratch });
  assert.equal(r.ok, true);
  assert.equal(r.delivery?.state, "not-pasted");
  assert.match(r.message, /never reached/);
  assert.ok(!log().some((l) => l.includes("Enter")), "does not blind-fire Enter when the paste is unaccounted for");
});

test("dispatch refuses a name that already exists (single writer per session)", () => {
  reset({ sessionExists: true });
  setFrames([READY]);
  const r = dispatchSession({ name: "already-there", task: TASK, cwd: scratch });
  assert.equal(r.ok, false);
  assert.match(r.message, /already exists/);
  assert.ok(!log().some((l) => l.startsWith("new-session")), "creates nothing");
  assert.ok(!log().some((l) => l.includes("send-keys")), "never sends keys into a session it did not create");
});

test("dispatch rejects an empty task and a missing cwd before touching tmux", () => {
  reset();
  setFrames([READY]);
  assert.equal(dispatchSession({ name: "x", task: "   ", cwd: scratch }).ok, false);
  assert.equal(dispatchSession({ name: "x", task: TASK, cwd: join(scratch, "nope") }).ok, false);
  assert.equal(log().length, 0, "no tmux commands run for invalid input");
});

test("tmux session names are sanitised: ':' and '.' would parse as pane coordinates", () => {
  happyPath("feat-api-v2"); // the card is written under the SANITISED name
  const r = dispatchSession({ name: "feat:api.v2", task: TASK, cwd: scratch });
  assert.equal(r.tmuxName, "feat-api-v2");
  assert.ok(log().some((l) => l.includes("=feat-api-v2:0.0")));
});

test("dispatch records no lineage; arcs still do", () => {
  const lineageFile = join(HOME, ".pi", "king", "lineage.json");
  const before = existsSync(lineageFile) ? readFileSync(lineageFile, "utf8") : "";

  happyPath("no-parent");
  dispatchSession({ name: "no-parent", task: TASK, cwd: scratch });
  const after = existsSync(lineageFile) ? readFileSync(lineageFile, "utf8") : "";
  assert.equal(after, before, "a dispatched session is not anyone's child");

  happyPath("with-parent");
  const arc = spawnArc({ name: "with-parent", brief: TASK, cwd: scratch, parentId: "parent-123" });
  assert.equal(arc.ok, true);
  const arcs = JSON.parse(readFileSync(lineageFile, "utf8")).arcs;
  const rec = arcs.find((a) => a.name === "with-parent");
  assert.ok(rec, "arc was recorded");
  assert.equal(rec.parentId, "parent-123");
  assert.ok(rec.id, "arc has a seeded session id");
  assert.equal(arcs.some((a) => a.name === "no-parent"), false, "dispatch did not sneak into lineage");
});

test("dispatch passes client size through to tmux so the pane spawns at the real terminal size", () => {
  happyPath("sized");
  dispatchSession({ name: "sized", task: TASK, cwd: scratch, liveSize: { w: 203, h: 51 } });
  const ns = log().find((l) => l.startsWith("new-session"));
  assert.match(ns, /-x 203/);
  assert.match(ns, /-y 51/);
});

test("a composer that never becomes ready leaves the session but sends nothing", () => {
  reset();
  setFrames(["loading..."]);
  const r = dispatchSession({ name: "slow-one", task: TASK, cwd: scratch, readyTimeoutSec: 0 });
  assert.equal(r.ok, true, "the session was created and must not be orphaned silently");
  assert.match(r.message, /NOT sent/);
  assert.ok(!log().some((l) => l.includes("send-keys")), "no keys fired at a composer that is not up");
});

// --- sessionDirFor: symlink resolution -------------------------------------
// pi derives its session directory from its OWN resolved cwd. On macOS /tmp is
// a symlink to /private/tmp, so seeding under "--tmp-x--" writes where pi never
// looks: the session comes up with no seed, exits, and the tmux window vanishes
// a few seconds after we already reported success. Found by the native-dispatch
// arc while testing in a scratch dir under /tmp; production arcs all use
// ~/codebase paths, which is why it stayed hidden.
test("sessionDirFor resolves symlinks so the seed lands where pi looks", () => {
  const real = realpathSync("/tmp");
  assert.notEqual(real, "/tmp", "precondition: /tmp must be a symlink for this test to mean anything");
  assert.equal(sessionDirFor("/tmp"), sessionDirFor(real));
  assert.match(sessionDirFor("/tmp"), /--private-tmp--$/);
});

test("sessionDirFor falls back to the literal path when the dir does not exist", () => {
  const ghost = join(tmpdir(), "pi-king-absent-" + Date.now());
  assert.match(sessionDirFor(ghost), /pi-king-absent-\d+--$/);
});
