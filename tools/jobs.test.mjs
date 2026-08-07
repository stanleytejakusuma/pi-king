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
  selectRestoreCards,
} = await import("../src/jobs.ts");

// ---- helpers -------------------------------------------------------------

const writeMarker = (id, body) => {
  writeFileSync(join(jobsDir, `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
};
const noSession = { getEntries: () => [] };
const sessionRow = (cwd, tmuxName, updatedAt = 0) => ({ kind: "session", entry: { cwd, tmuxName, updatedAt } });
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

test("targetRow: cwd hint > resultPath dirname > most-recently-active > none", () => {
  const mk = (marker) => ({ id: "x", file: "", stale: false, marker });
  const rows = [
    sessionRow("/proj/beta", "t-beta"),
    sessionRow("/proj/alpha", "t-alpha"),
    sessionRow("/proj/alpha/sub", "t-alpha-sub"),
    { kind: "orphan" },
  ];
  // cwd field beats resultPath dirname and recency
  const cwdJob = mk({ status: "done", cwd: "/proj/alpha", resultPath: "/proj/beta/out.txt" });
  assert.equal(targetRow(cwdJob, rows)?.entry?.tmuxName, "t-alpha");
  // resultPath dirname matched when no cwd field (older markers)
  const rpJob = mk({ status: "done", resultPath: "/proj/alpha/out.txt" });
  assert.equal(targetRow(rpJob, rows)?.entry?.tmuxName, "t-alpha");
  // session nested inside the hint matches too
  const subRows = [sessionRow("/proj/beta", "t-beta"), sessionRow("/proj/alpha/sub", "t-alpha-sub")];
  assert.equal(targetRow(cwdJob, subRows)?.entry?.tmuxName, "t-alpha-sub");
  // no hints → most-recently-active tmux-backed session
  const recencyRows = [sessionRow("/proj/beta", "t-beta", 100), sessionRow("/proj/gamma", "t-gamma", 999)];
  const noHint = mk({ status: "done" });
  assert.equal(targetRow(noHint, recencyRows)?.entry?.tmuxName, "t-gamma");
  // hint match without tmuxName is skipped; recency still applies
  const noTmux = [{ kind: "session", entry: { cwd: "/proj/alpha" } }, sessionRow("/proj/delta", "t-delta", 5)];
  assert.equal(targetRow(rpJob, noTmux)?.entry?.tmuxName, "t-delta");
  // nothing tmux-backed at all → none
  assert.equal(targetRow(noHint, [{ kind: "session", entry: { cwd: "/proj/alpha" } }]), undefined);
  assert.equal(targetRow(noHint, []), undefined);
  // exact-cwd hit (not just prefix)
  const exact = mk({ status: "done", resultPath: "/proj/alpha" });
  assert.equal(targetRow(exact, rows)?.entry?.tmuxName, "t-alpha");
});

test("claimInjected: first writer wins across watchers", async () => {
  const rows = [sessionRow("/proj/alpha", "t-alpha", 1)];
  // watcher A (e.g. hub daemon) and watcher B (dashboard / session-side
  // pi-jobs) BOTH construct before the marker lands, so neither has it in
  // its seen set — the .injected claim, not the seen set, is the dedup.
  const panelA = new JobsPanel(noSession, "/proj/alpha", undefined);
  const panelB = new JobsPanel(noSession, "/proj/alpha", undefined);
  writeMarker("claim-1", { status: "done", summary: "claim test" });
  panelA.poll(Date.now(), rows);
  await settle();
  const logAfterA = readLog().trim().split("\n").filter(Boolean);
  assert.equal(logAfterA.length, 1, "first watcher injects exactly once");
  assert.equal(readdirSync(ACKS_DIR).length, 1, "winner writes the ack");
  assert.equal(readdirSync(INJECTED_DIR).length, 1, "claim file exists");
  panelB.poll(Date.now(), rows);
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
  writeMarker("fire-1", { status: "done", summary: "boom", resultPath: "/proj/alpha/out.txt" });
  const rows = [sessionRow("/proj/alpha", "t-alpha")];

  panel.poll(Date.now(), rows);
  await settle();
  const afterFirst = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);

  panel.poll(Date.now(), rows); // second poll: seen → no re-injection
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
  panel.poll(Date.now(), rows);
  await settle();
  panel.poll(Date.now(), rows);
  await settle();
  assert.equal(readLog().trim(), "");
});

test("resume guards: pending, acked, active goal, active workflow", async () => {
  resetJobsDir();
  resetLog();
  // pending → refuse
  writeMarker("g-pend", { status: "pending" });
  let panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), [], undefined);
  assert.match(await panel.resume("g-pend", []), /still pending/);

  // no tmux target → refuse WITHOUT acking (a burned ack would block the
  // retry once a target exists)
  writeMarker("g-ack", { status: "done", summary: "done once" });
  panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), [], undefined);
  assert.match(await panel.resume("g-ack", []), /not resumed/);
  assert.equal(existsSync(ACKS_DIR) ? readdirSync(ACKS_DIR).length : 0, 0, "no-target resume must not write an ack");
  // with a target: inject then ack → second resume refused
  const ackRows = [sessionRow("/proj/alpha", "t-alpha")];
  resetLog();
  assert.match(await panel.resume("g-ack", ackRows), /Resumed job g-ack/);
  const ackFiles = readdirSync(ACKS_DIR);
  assert.equal(ackFiles.length, 1);
  assert.ok(readFileSync(join(ACKS_DIR, ackFiles[0]), "utf8").includes("ackedAt"));
  assert.match(await panel.resume("g-ack", ackRows), /already resumed/);

  // active goal_mode entry → refuse
  writeMarker("g-goal", { status: "done", summary: "under goal" });
  const goalSession = {
    getEntries: () => [{ type: "custom", customType: "goal_mode", data: { status: "active" } }],
  };
  panel = new JobsPanel(goalSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), [], undefined);
  assert.match(await panel.resume("g-goal", []), /\/goal is active/);

  // non-terminal workflow run in cwd → refuse (flat layout)
  const wfDir = mkdtempSync(join(tmpdir(), "pi-king-wf-"));
  mkdirSync(join(wfDir, ".pi", "workflows", "runs"), { recursive: true });
  writeFileSync(join(wfDir, ".pi", "workflows", "runs", "run-1.json"), JSON.stringify({ status: "running" }));
  writeMarker("g-wf", { status: "done", summary: "under workflow" });
  panel = new JobsPanel(noSession, wfDir, undefined);
  panel.poll(Date.now(), [], undefined);
  assert.match(await panel.resume("g-wf", []), /workflow run is active/);
  // legacy layout refusal
  const legacyDir = mkdtempSync(join(tmpdir(), "pi-king-wf-legacy-"));
  mkdirSync(join(legacyDir, ".pi", "workflows", "run-1"), { recursive: true });
  writeFileSync(join(legacyDir, ".pi", "workflows", "run-1", "run.json"), JSON.stringify({ run: { status: "paused" } }));
  writeMarker("g-wf2", { status: "done" });
  panel = new JobsPanel(noSession, legacyDir, undefined);
  panel.poll(Date.now(), [], undefined);
  assert.match(await panel.resume("g-wf2", []), /workflow run is active/);
});

test("resume happy path: ack + framed injection into the target session", async () => {
  resetJobsDir();
  resetLog();
  rmSync(ACKS_DIR, { recursive: true, force: true });
  writeMarker("ok-1", { status: "failed", summary: "exit=2", resultPath: "/proj/alpha/out.log" });
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined); // seeds ok-1 → no auto-inject
  const rows = [sessionRow("/proj/alpha", "t-alpha")];
  panel.poll(Date.now(), rows);
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
  const rows = [sessionRow("/proj/alpha", "t-alpha")];
  panel.poll(Date.now(), rows);
  await settle();
  assert.equal(readLog().trim(), "", "pre-existing markers must not inject");
  // a marker written after open still injects exactly once
  writeMarker("new-1", { status: "done", summary: "while open", resultPath: "/proj/alpha/x" });
  panel.poll(Date.now(), rows);
  await settle();
  panel.poll(Date.now(), rows);
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
  panel.poll(Date.now(), [], undefined);
  const removed = panel.clearFinished();
  assert.equal(removed, 2);
  assert.deepEqual(panel.list.map((j) => j.id), ["clr-pend"]);
});

test("resume injects before acking: failed injection keeps the job resumable", async () => {
  resetJobsDir();
  resetLog();
  rmSync(ACKS_DIR, { recursive: true, force: true });
  mkdirSync(ACKS_DIR, { recursive: true });
  const rows = [sessionRow("/proj/alpha", "t-alpha")];
  writeMarker("f-1", { status: "done", summary: "flaky" });
  writeFileSync(failMarker, "fail");
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), rows);
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

test("auto-injection acks the marker: exactly one injection per marker", async () => {
  resetJobsDir();
  resetLog();
  rmSync(ACKS_DIR, { recursive: true, force: true });
  mkdirSync(ACKS_DIR, { recursive: true });
  const rows = [sessionRow("/proj/alpha", "t-alpha")];
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined); // seeds nothing yet
  writeMarker("auto-1", { status: "done", summary: "auto" });
  panel.poll(Date.now(), rows);
  await settle();
  const lines = readLog().trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "auto-injection fires exactly once");
  assert.equal(readdirSync(ACKS_DIR).length, 1, "successful auto-injection writes the ack");
  assert.match(await panel.resume("auto-1", rows), /already resumed/);
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
