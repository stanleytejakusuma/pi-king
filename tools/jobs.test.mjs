#!/usr/bin/env node
// Logic-level tests for the jobs panel (src/jobs.ts). Zero dependencies:
// node:test + node's native TypeScript type stripping.
//
// Hermetic setup: the panel's dirs and tmux binary are env-overridable
// (PI_JOBS_DIR, PI_KING_TMUX), notifications are silenced (PI_JOBS_OSA=0),
// and the stale-pending window is disabled so scanJobs never races the
// clock. Env must be set BEFORE the dynamic import below — the module
// resolves all of it at load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_JOBS_OSA = "0";
process.env.PI_JOBS_STALE_PENDING_HOURS = "0";
const jobsDir = mkdtempSync(join(tmpdir(), "pi-king-jobs-"));
process.env.PI_JOBS_DIR = jobsDir;
// Fake tmux: records every invocation to a log file so the single-fire
// injection contract is observable. Lives OUTSIDE the jobs dir — the tests
// wipe the jobs dir between cases.
const toolsDir = mkdtempSync(join(tmpdir(), "pi-king-tools-"));
const logFile = join(toolsDir, "tmux.log");
const fakeTmux = join(toolsDir, "fake-tmux.sh");
// Fake tmux: records every invocation to a log file so the single-fire
// injection contract is observable. Exits non-zero while the fail marker
// exists, so failed-injection paths are testable too. Lives OUTSIDE the
// jobs dir — the tests wipe the jobs dir between cases.
const failMarker = join(toolsDir, "fail.marker");
process.env.PI_KING_TMUX_FAIL = failMarker;
writeFileSync(
  fakeTmux,
  `#!/bin/sh\n[ -f "$PI_KING_TMUX_FAIL" ] && exit 1\nprintf '%s\\n' "$*" >> "${logFile}"\n`,
  { mode: 0o755 },
);
process.env.PI_KING_TMUX = fakeTmux;

const {
  validateMarker,
  sanitizeField,
  sortJobs,
  isStalePending,
  targetRow,
  scanJobs,
  JobsPanel,
  ACKS_DIR,
  INJECTED_DIR,
  claimInjected,
  claimed,
  isSettledRow,
  workerDead,
  selectRestoreCards,
} = await import("../src/jobs.ts");

// ---- helpers -------------------------------------------------------------

const writeMarker = (id, body) => {
  writeFileSync(join(jobsDir, `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
};
const noSession = { getEntries: () => [] };
const sessionRow = (cwd, tmuxName, updatedAt = 0, sessionId, extra = {}) => ({
  kind: "session",
  entry: { cwd, tmuxName, updatedAt, sessionId, ...extra },
});
const resetLog = () => { rmSync(logFile, { force: true }); };
const readLog = () => { try { return readFileSync(logFile, "utf8"); } catch { return ""; } };
const settle = () => new Promise((r) => setTimeout(r, 100));
// Tests share one jobs dir, but panels must not see markers written by other
// tests (each fresh panel has an empty seen set). Wipe between tests.
const resetJobsDir = () => {
  rmSync(jobsDir, { recursive: true, force: true });
  mkdirSync(jobsDir);
};

test("sanitizeField strips control chars and caps length", () => {
  // control chars become spaces (the literal "[31m" after ESC is inert text)
  assert.equal(sanitizeField("a\nb\x1b[31mc", 500), "a b [31mc");
  assert.equal(sanitizeField("abcdef", 3), "abc");
  assert.equal(sanitizeField(42, 10), undefined);
  assert.equal(sanitizeField("   ", 10), undefined);
});

test("validateMarker rejects unknown status, non-JSON, oversized, non-object", () => {
  const ok = validateMarker(JSON.stringify({ status: "done", summary: "ok" }));
  assert.equal(ok?.status, "done");
  assert.equal(ok?.summary, "ok");
  assert.equal(validateMarker(JSON.stringify({ status: "flying" })), null);
  assert.equal(validateMarker("not json"), null);
  assert.equal(validateMarker("42"), null);
  assert.equal(validateMarker('{"status":"done","summary":"' + "x".repeat(17 * 1024) + '"}'), null);
  // control chars in fields are replaced, not rejected
  const m = validateMarker(JSON.stringify({ status: "done", summary: "a\u0000b" }));
  assert.equal(m?.summary, "a b");
  // caps: 500 summary, 1024 resultPath, 500 nextStep
  const capped = validateMarker(JSON.stringify({
    status: "done",
    summary: "s".repeat(600),
    resultPath: "p".repeat(1100),
    nextStep: "n".repeat(600),
  }));
  assert.equal(capped?.summary?.length, 500);
  assert.equal(capped?.resultPath?.length, 1024);
  assert.equal(capped?.nextStep?.length, 500);
});

test("sortJobs is newest-first by createdAt, dateless after dated, ties by id", () => {
  const job = (id, createdAt) => ({ id, file: "", stale: false, marker: { status: "done", createdAt } });
  const sorted = sortJobs([
    job("old-1", "2026-01-01T00:00:00Z"),
    job("mid-1", "2026-06-01T00:00:00Z"),
    job("new-1", "2026-08-01T00:00:00Z"),
    job("dateless-b"),
    job("dateless-a"),
  ]);
  assert.deepEqual(sorted.map((j) => j.id), ["new-1", "mid-1", "old-1", "dateless-b", "dateless-a"]);
});

test("isStalePending: pending older than window, never terminal", () => {
  const now = Date.parse("2026-08-07T00:00:00Z");
  const windowMs = 24 * 3600 * 1000;
  assert.equal(isStalePending({ status: "pending", createdAt: "2026-08-05T00:00:00Z" }, now, windowMs), true);
  assert.equal(isStalePending({ status: "pending", createdAt: "2026-08-06T12:00:00Z" }, now, windowMs), false);
  assert.equal(isStalePending({ status: "pending" }, now, windowMs), false); // no createdAt
  assert.equal(isStalePending({ status: "done", createdAt: "2026-01-01T00:00:00Z" }, now, windowMs), false);
  assert.equal(isStalePending({ status: "pending", createdAt: "2026-08-05T00:00:00Z" }, now, 0), false); // disabled
});

test("targetRow: only the exact spawner session is authorized for automatic injection", () => {
  const mk = (marker) => ({ id: "x", file: "", stale: false, marker });
  const rows = [
    sessionRow("/proj/atlas", "t-atlas", 10, "sess-atlas"),
    sessionRow("/proj/hustle", "t-hustle", 999, "sess-hustle"),
  ];
  // The exact id beats unrelated cwd/recency (the atlas case).
  assert.equal(targetRow(mk({ status: "done", cwd: "/tmp/atlas-minoml", spawnerSessionId: "sess-atlas" }), rows)?.entry?.tmuxName, "t-atlas");
  // An absent or pane-less owner must NEVER fall through into another session.
  assert.equal(targetRow(mk({ status: "done", cwd: "/proj/hustle", spawnerSessionId: "sess-gone" }), rows), undefined);
  const noTmux = [{ kind: "session", entry: { cwd: "/x", sessionId: "sess-atlas" } }, sessionRow("/y", "t-y", 3, "sess-y")];
  assert.equal(targetRow(mk({ status: "done", spawnerSessionId: "sess-atlas" }), noTmux), undefined);
  // Legacy/cron markers without an owner are panel + banner only.
  assert.equal(targetRow(mk({ status: "done", cwd: "/proj/hustle" }), rows), undefined);
});

test("claimInjected: first writer wins across watchers", async () => {
  const rows = [sessionRow("/proj/alpha", "t-alpha", 1, "sess-alpha")];
  // watcher A (e.g. hub daemon) and watcher B (dashboard / session-side
  // pi-jobs) BOTH construct before the marker lands, so neither has it in
  // its seen set — the .injected claim, not the seen set, is the dedup.
  const panelA = new JobsPanel(noSession, "/proj/alpha", undefined);
  const panelB = new JobsPanel(noSession, "/proj/alpha", undefined);
  writeMarker("claim-1", { status: "done", summary: "claim test", spawnerSessionId: "sess-alpha" });
  panelA.poll(Date.now(), () => rows);
  await settle();
  const logAfterA = readLog().trim().split("\n").filter(Boolean);
  assert.equal(logAfterA.length, 1, "first watcher injects exactly once");
  assert.equal(readdirSync(ACKS_DIR).length, 1, "winner writes the ack");
  assert.equal(readdirSync(INJECTED_DIR).length, 1, "claim file exists");
  panelB.poll(Date.now(), () => rows);
  await settle();
  const logAfterB = readLog().trim().split("\n").filter(Boolean);
  assert.equal(logAfterB.length, 1, "second watcher stays silent — exactly one injection total");
  // manual resume still works regardless of the claim
  assert.match(await panelA.resume("claim-1", rows), /already resumed/);
});

test("selectRestoreCards: dead + recycled restored, alive/invisible/unstamped skipped", () => {
  const live = new Map([[1, 100], [2, 999999]]);
  const cards = [
    { id: "a", cwd: "/x", visible: true, lastActivity: Date.now(), pid: 1, startedAt: 100 }, // alive → skip
    { id: "b", cwd: "/x", visible: true, lastActivity: Date.now(), pid: 2, startedAt: 100 }, // recycled → restore
    { id: "c", cwd: "/x", visible: true, lastActivity: Date.now(), pid: 3, startedAt: 100 }, // dead → restore
    { id: "d", cwd: "/x", visible: false, lastActivity: Date.now(), pid: 4, startedAt: 100 }, // invisible → skip
    { id: "e", cwd: "/x", visible: true, pid: 5, startedAt: 100 }, // never stamped → skip
  ];
  assert.deepEqual(selectRestoreCards(cards, live).map((c) => c.id), ["b", "c"]);
  // empty liveness map (ps unavailable): every stamped card looks restoreable
  assert.deepEqual(selectRestoreCards(cards, new Map()).map((c) => c.id), ["a", "b", "c"]);
});

test("scanJobs reads markers, skips malformed, caches via stat", () => {
  resetJobsDir(); // claim/restore tests above leave markers behind
  writeMarker("a-1", { status: "done", summary: "alpha" });
  writeMarker("b-2", { status: "pending" });
  writeMarker("bad-3", "{{{");
  const jobs = scanJobs();
  assert.deepEqual(jobs.map((j) => j.id).sort(), ["a-1", "b-2"]);
  assert.equal(jobs.find((j) => j.id === "a-1")?.marker.summary, "alpha");
  // same-mtime cache hit path (second scan) must return the same markers
  assert.deepEqual(scanJobs().map((j) => j.id).sort(), ["a-1", "b-2"]);
});

test("poll: exactly one injection per marker (single-fire seen set)", async () => {
  resetJobsDir();
  resetLog();
  // Panel first: construction seeds `seen` with pre-existing markers, so a
  // marker written after open is what injects (per-hub-run semantics).
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  writeMarker("fire-1", { status: "done", summary: "boom", resultPath: "/proj/alpha/out.txt", spawnerSessionId: "sess-alpha" });
  const rows = [sessionRow("/proj/alpha", "t-alpha", 0, "sess-alpha")];

  panel.poll(Date.now(), () => rows);
  await settle();
  const afterFirst = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);

  panel.poll(Date.now(), () => rows); // second poll: seen → no re-injection
  await settle();

  const all = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(afterFirst.length, 1, "exactly one injection on first poll");
  assert.equal(all.length, 1, "second poll must not re-inject");
  assert.match(afterFirst[0], /send-keys -t t-alpha/);
  assert.match(afterFirst[0], /UNTRUSTED data, verify before acting/);
  assert.doesNotMatch(afterFirst[0], /boom/, "marker fields never enter the injection line");
});

test("poll: pending markers are never injected", async () => {
  resetJobsDir();
  resetLog();
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  writeMarker("pend-1", { status: "pending" });
  const rows = [sessionRow("/proj/alpha", "t-alpha")];
  panel.poll(Date.now(), () => rows);
  await settle();
  panel.poll(Date.now(), () => rows);
  await settle();
  assert.equal(readLog().trim(), "");
});

test("resume guards: pending, acked, active goal, active workflow", async () => {
  resetJobsDir();
  resetLog();
  // pending → refuse
  writeMarker("g-pend", { status: "pending" });
  let panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), () => []);
  assert.match(await panel.resume("g-pend", []), /still pending/);

  // no tmux target → refuse WITHOUT acking (a burned ack would block the
  // retry once a target exists)
  writeMarker("g-ack", { status: "done", summary: "done once" });
  panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), () => []);
  assert.match(await panel.resume("g-ack", []), /not resumed/);
  assert.equal(existsSync(ACKS_DIR) ? readdirSync(ACKS_DIR).length : 0, 0, "no-target resume must not write an ack");
  // with a target: inject then ack → second resume refused
  const ackRows = [sessionRow("/proj/alpha", "t-alpha", 0, "sess-alpha")];
  resetLog();
  writeMarker("g-owned", { status: "done", summary: "done once", spawnerSessionId: "sess-alpha" });
  panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), () => ackRows);
  assert.match(await panel.resume("g-owned", ackRows), /Resumed job g-owned/);
  const ackFiles = readdirSync(ACKS_DIR);
  assert.equal(ackFiles.length, 1);
  assert.ok(readFileSync(join(ACKS_DIR, ackFiles[0]), "utf8").includes("ackedAt"));
  assert.match(await panel.resume("g-owned", ackRows), /already resumed/);

  // active goal_mode entry → refuse
  writeMarker("g-goal", { status: "done", summary: "under goal" });
  const goalSession = {
    getEntries: () => [{ type: "custom", customType: "goal_mode", data: { status: "active" } }],
  };
  panel = new JobsPanel(goalSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), () => []);
  assert.match(await panel.resume("g-goal", []), /\/goal is active/);

  // non-terminal workflow run in cwd → refuse (flat layout)
  const wfDir = mkdtempSync(join(tmpdir(), "pi-king-wf-"));
  mkdirSync(join(wfDir, ".pi", "workflows", "runs"), { recursive: true });
  writeFileSync(join(wfDir, ".pi", "workflows", "runs", "run-1.json"), JSON.stringify({ status: "running" }));
  writeMarker("g-wf", { status: "done", summary: "under workflow" });
  panel = new JobsPanel(noSession, wfDir, undefined);
  panel.poll(Date.now(), () => []);
  assert.match(await panel.resume("g-wf", []), /workflow run is active/);
  // legacy layout refusal
  const legacyDir = mkdtempSync(join(tmpdir(), "pi-king-wf-legacy-"));
  mkdirSync(join(legacyDir, ".pi", "workflows", "run-1"), { recursive: true });
  writeFileSync(join(legacyDir, ".pi", "workflows", "run-1", "run.json"), JSON.stringify({ run: { status: "paused" } }));
  writeMarker("g-wf2", { status: "done" });
  panel = new JobsPanel(noSession, legacyDir, undefined);
  panel.poll(Date.now(), () => []);
  assert.match(await panel.resume("g-wf2", []), /workflow run is active/);
});

test("resume happy path: ack + framed injection into the target session", async () => {
  resetJobsDir();
  resetLog();
  rmSync(ACKS_DIR, { recursive: true, force: true });
  writeMarker("ok-1", { status: "failed", summary: "exit=2", resultPath: "/proj/alpha/out.log", spawnerSessionId: "sess-alpha" });
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined); // seeds ok-1 → no auto-inject
  const rows = [sessionRow("/proj/alpha", "t-alpha", 0, "sess-alpha")];
  panel.poll(Date.now(), () => rows);
  const msg = await panel.resume("ok-1", rows);
  assert.match(msg, /Resumed job ok-1/);
  const log = readFileSync(logFile, "utf8").trim();
  assert.match(log, /send-keys -t t-alpha/);
  assert.match(log, /UNTRUSTED report, verify before acting/);
  assert.match(log, /Summarize what the job reports/);
  // ack written → a second resume is refused
  assert.match(await panel.resume("ok-1", rows), /already resumed/);
});

test("poll seeds seen with pre-existing markers (no re-inject on reopen)", async () => {
  resetJobsDir();
  resetLog();
  writeMarker("old-1", { status: "done", summary: "from before" });
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined); // seeds old-1
  const rows = [sessionRow("/proj/alpha", "t-alpha", 0, "sess-alpha")];
  panel.poll(Date.now(), () => rows);
  await settle();
  assert.equal(readLog().trim(), "", "pre-existing markers must not inject");
  // a marker written after open still injects exactly once
  writeMarker("new-1", { status: "done", summary: "while open", resultPath: "/proj/alpha/x", spawnerSessionId: "sess-alpha" });
  panel.poll(Date.now(), () => rows);
  await settle();
  panel.poll(Date.now(), () => rows);
  await settle();
  const lines = readLog().trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Job new-1/);
});

test("clearFinished removes only finished markers (and their acks)", () => {
  resetJobsDir();
  writeMarker("clr-done", { status: "done" });
  writeMarker("clr-fail", { status: "failed" });
  writeMarker("clr-pend", { status: "pending" });
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), () => []);
  const removed = panel.clearFinished();
  assert.equal(removed, 2);
  assert.deepEqual(panel.list.map((j) => j.id), ["clr-pend"]);
});

test("resume injects before acking: failed injection keeps the job resumable", async () => {
  resetJobsDir();
  resetLog();
  rmSync(ACKS_DIR, { recursive: true, force: true });
  mkdirSync(ACKS_DIR, { recursive: true });
  const rows = [sessionRow("/proj/alpha", "t-alpha", 0, "sess-alpha")];
  writeMarker("f-1", { status: "done", summary: "flaky", spawnerSessionId: "sess-alpha" });
  writeFileSync(failMarker, "fail");
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), () => rows);
  const failed = await panel.resume("f-1", rows);
  assert.match(failed, /not resumed/);
  assert.match(failed, /nothing was acked/);
  assert.equal(readdirSync(ACKS_DIR).length, 0, "failed injection must not burn the ack");
  // retry after the failure clears: succeeds and acks
  rmSync(failMarker, { force: true });
  const msg = await panel.resume("f-1", rows);
  assert.match(msg, /Resumed job f-1/);
  assert.equal(readdirSync(ACKS_DIR).length, 1);
});

test("auto-injection acks an exact-owner delivery exactly once", async () => {
  resetJobsDir();
  resetLog();
  rmSync(ACKS_DIR, { recursive: true, force: true });
  mkdirSync(ACKS_DIR, { recursive: true });
  const rows = [sessionRow("/proj/alpha", "t-alpha", 0, "sess-alpha")];
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined); // seeds nothing yet
  writeMarker("auto-1", { status: "done", summary: "auto", spawnerSessionId: "sess-alpha" });
  panel.poll(Date.now(), () => rows);
  await settle();
  const lines = readLog().trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "auto-injection fires exactly once");
  assert.equal(readdirSync(ACKS_DIR).length, 1, "successful auto-injection writes the ack");
  assert.match(await panel.resume("auto-1", rows), /already resumed/);
});

test("automatic injection never substitutes a foreign session and burns no claim", async () => {
  resetJobsDir();
  resetLog();
  rmSync(ACKS_DIR, { recursive: true, force: true });
  rmSync(INJECTED_DIR, { recursive: true, force: true });
  mkdirSync(ACKS_DIR, { recursive: true });
  const foreign = [sessionRow("/proj/foreign", "t-foreign", 999, "sess-foreign")];
  const panel = new JobsPanel(noSession, "/proj/foreign", undefined);
  writeMarker("owner-absent", { status: "failed", cwd: "/proj/foreign", spawnerSessionId: "sess-owner" });
  panel.poll(Date.now(), () => foreign);
  await settle();
  assert.equal(readLog(), "", "foreign pane must receive zero send-keys");
  assert.equal(readdirSync(ACKS_DIR).length, 0, "undelivered job must not be acked");
  assert.equal(existsSync(INJECTED_DIR) ? readdirSync(INJECTED_DIR).length : 0, 0, "undelivered job must not burn a claim");
});

test("legacy unstamped marker is panel-only, never automatic conversation injection", async () => {
  resetJobsDir();
  resetLog();
  rmSync(ACKS_DIR, { recursive: true, force: true });
  rmSync(INJECTED_DIR, { recursive: true, force: true });
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  writeMarker("legacy-1", { status: "done", cwd: "/proj/alpha", summary: "legacy" });
  panel.poll(Date.now(), () => [sessionRow("/proj/alpha", "t-alpha", 1, "sess-alpha")]);
  await settle();
  assert.equal(readLog(), "");
  assert.equal(existsSync(INJECTED_DIR) ? readdirSync(INJECTED_DIR).length : 0, 0);
});

test("isStalePending: pending older than the window is stale, done never", () => {
  const now = Date.now();
  const h = 24 * 60 * 60 * 1000;
  assert.ok(isStalePending({ status: "pending", createdAt: new Date(now - 25 * h).toISOString() }, now, h));
  assert.equal(isStalePending({ status: "pending", createdAt: new Date(now - 1 * h).toISOString() }, now, h), false);
  assert.equal(isStalePending({ status: "done", createdAt: new Date(now - 25 * h).toISOString() }, now, h), false);
  assert.equal(isStalePending({ status: "pending" }, now, h), false, "dateless pending is not stale");
  assert.equal(isStalePending({ status: "pending", createdAt: new Date(now - 25 * h).toISOString() }, now, 0), false);
});

// ---- mid-turn guard, orphan detection, delivery contract -----------------

test("isSettledRow mirrors index.ts isSettled (working / subagents / no entry)", () => {
  const row = (state, subagents) => ({ kind: "session", entry: { tmuxName: "t", state, subagents } });
  assert.equal(isSettledRow(row("idle", [])), true);
  assert.equal(isSettledRow(row("attention", [])), true, "attention = prompt is waiting, safe to type");
  assert.equal(isSettledRow(row("working", [])), false);
  assert.equal(isSettledRow(row("idle", [{ status: "running" }])), false, "subagent running blocks");
  assert.equal(isSettledRow(row("idle", [{ status: "queued" }])), false, "subagent queued blocks");
  assert.equal(isSettledRow(row("idle", [{ status: "completed" }])), true);
  assert.equal(isSettledRow(row("idle", undefined)), true, "no subagent field = nothing running");
  assert.equal(isSettledRow({ kind: "session" }), false, "no entry is never settled");
  assert.equal(isSettledRow(undefined), false);
});

test("auto-inject waits for a mid-turn owner and burns no claim, then delivers once settled", async () => {
  resetJobsDir();
  resetLog();
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  writeMarker("busy-1", { status: "done", summary: "report", spawnerSessionId: "sess-alpha" });
  const busy = [sessionRow("/proj/alpha", "t-alpha", 1, "sess-alpha", { state: "working", subagents: [] })];
  panel.poll(Date.now(), () => busy);
  await settle();
  assert.equal(readLog().trim(), "", "must not type into a pane mid-turn");
  assert.equal(existsSync(INJECTED_DIR) ? readdirSync(INJECTED_DIR).length : 0, 0, "no claim burned while waiting");
  // owner finishes its turn: the SAME marker now delivers, exactly once
  const idle = [sessionRow("/proj/alpha", "t-alpha", 1, "sess-alpha", { state: "idle", subagents: [] })];
  panel.poll(Date.now(), () => idle);
  await settle();
  const lines = readLog().trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "delivered once the owner settled");
  assert.match(lines[0], /Job busy-1/);
  assert.equal(readdirSync(ACKS_DIR).length, 1, "successful delivery acks");
});

test("a subagent still running blocks delivery too", async () => {
  resetJobsDir();
  resetLog();
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  writeMarker("sub-1", { status: "done", summary: "report", spawnerSessionId: "sess-alpha" });
  const rows = [sessionRow("/proj/alpha", "t-alpha", 1, "sess-alpha", { state: "idle", subagents: [{ status: "running" }] })];
  panel.poll(Date.now(), () => rows);
  await settle();
  assert.equal(readLog().trim(), "", "subagent running = still mid-work");
});

test("workerDead: pending marker whose worker pid is gone is orphaned", () => {
  assert.equal(workerDead({ status: "pending", pid: process.pid }), false, "our own pid is alive");
  // pid 1 (launchd) exists but is not ours -> EPERM -> counts as alive
  assert.equal(workerDead({ status: "pending", pid: 1 }), false);
  assert.equal(workerDead({ status: "pending", pid: 999999 }), true, "no such process");
  assert.equal(workerDead({ status: "pending" }), false, "no pid recorded: cannot judge");
  assert.equal(workerDead({ status: "done", pid: 999999 }), false, "terminal markers are never orphans");
});

test("orphaned pending marker: scanJobs flags it, resume explains, nothing is injected", async () => {
  resetJobsDir();
  resetLog();
  writeMarker("zombie-1", { status: "pending", summary: "running", pid: 999999, spawnerSessionId: "sess-alpha" });
  const found = scanJobs().find((j) => j.id === "zombie-1");
  assert.equal(found.orphaned, true);
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  const rows = [sessionRow("/proj/alpha", "t-alpha", 1, "sess-alpha", { state: "idle", subagents: [] })];
  panel.poll(Date.now(), () => rows);
  await settle();
  assert.equal(readLog().trim(), "", "a pending marker never injects");
  const msg = await panel.resume("zombie-1", rows);
  assert.match(msg, /died/);
  assert.match(msg, /999999/);
});

test("resume refuses a marker another watcher already claimed (no duplicate delivery)", async () => {
  resetJobsDir();
  resetLog();
  writeMarker("dup-1", { status: "done", summary: "already delivered", spawnerSessionId: "sess-alpha" });
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), () => []); // populate panel.jobs without delivering
  await settle();
  // simulate the session-side pi-jobs watcher having claimed + delivered it
  assert.equal(claimInjected("dup-1"), true);
  assert.equal(claimed("dup-1"), true);
  const rows = [sessionRow("/proj/alpha", "t-alpha", 1, "sess-alpha", { state: "idle", subagents: [] })];
  assert.match(await panel.resume("dup-1", rows), /already delivered/);
  assert.equal(readLog().trim(), "", "refused resume sends nothing");
});

test("a completion that landed while no watcher ran is delivered on the next start", async () => {
  resetJobsDir();
  resetLog();
  // marker already terminal BEFORE any panel exists (daemon was down)
  writeMarker("missed-1", { status: "done", summary: "finished while down", spawnerSessionId: "sess-alpha" });
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined); // seeds notified, NOT delivery
  const rows = [sessionRow("/proj/alpha", "t-alpha", 1, "sess-alpha", { state: "idle", subagents: [] })];
  panel.poll(Date.now(), () => rows);
  await settle();
  const lines = readLog().trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "owner is alive, so the missed completion still gets delivered");
  assert.match(lines[0], /Job missed-1/);
  // and never twice
  panel.poll(Date.now(), () => rows);
  await settle();
  assert.equal(readLog().trim().split("\n").filter(Boolean).length, 1);
});

test("poll never calls the rows provider when there is nothing to deliver (idle tick forks nothing)", async () => {
  resetJobsDir();
  resetLog();
  writeMarker("quiet-1", { status: "pending", summary: "still running", pid: process.pid });
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  let calls = 0;
  const provider = () => { calls++; return []; };
  panel.poll(Date.now(), provider);
  await settle();
  panel.poll(Date.now(), provider);
  await settle();
  assert.equal(calls, 0, "a live pending marker must not trigger a fleet scan");
});
