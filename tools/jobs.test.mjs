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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
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
writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\n`, { mode: 0o755 });
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
} = await import("../src/jobs.ts");

// ---- helpers -------------------------------------------------------------

const writeMarker = (id, body) => {
  writeFileSync(join(jobsDir, `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
};
const noSession = { getEntries: () => [] };
const sessionRow = (cwd, tmuxName) => ({ kind: "session", entry: { cwd, tmuxName } });
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

test("targetRow: cwd hint > focused > none", () => {
  const job = { id: "x", file: "", stale: false, marker: { status: "done", resultPath: "/proj/alpha/out.txt" } };
  const rows = [
    sessionRow("/proj/beta", "t-beta"),
    sessionRow("/proj/alpha", "t-alpha"),
    { kind: "orphan" },
  ];
  const focused = sessionRow("/proj/gamma", "t-gamma");
  // cwd-hint match wins even over a valid focused row
  assert.equal(targetRow(job, rows, focused)?.entry?.tmuxName, "t-alpha");
  // hint matches nothing → focused (when it is a tmux-backed session)
  const miss = { ...job, marker: { status: "done", resultPath: "/elsewhere/out.txt" } };
  assert.equal(targetRow(miss, rows, focused)?.entry?.tmuxName, "t-gamma");
  // no hint → focused
  const noHint = { ...job, marker: { status: "done" } };
  assert.equal(targetRow(noHint, rows, focused)?.entry?.tmuxName, "t-gamma");
  // no hint, focused not a session → none
  assert.equal(targetRow(noHint, rows, undefined), undefined);
  // hint match without tmuxName is skipped, focused used
  const noTmux = [{ kind: "session", entry: { cwd: "/proj/alpha" } }];
  assert.equal(targetRow(job, noTmux, focused)?.entry?.tmuxName, "t-gamma");
  // exact-cwd hit (not just prefix)
  const exact = { ...job, marker: { status: "done", resultPath: "/proj/alpha" } };
  assert.equal(targetRow(exact, rows, focused)?.entry?.tmuxName, "t-alpha");
});

test("scanJobs reads markers, skips malformed, caches via stat", () => {
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

  panel.poll(Date.now(), rows, rows[0]);
  await settle();
  const afterFirst = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);

  panel.poll(Date.now(), rows, rows[0]); // second poll: seen → no re-injection
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
  panel.poll(Date.now(), rows, rows[0]);
  await settle();
  panel.poll(Date.now(), rows, rows[0]);
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
  assert.match(await panel.resume("g-pend", [], undefined), /still pending/);

  // acked → refuse (ack = sha256 of raw marker, first 16 hex — pi-jobs contract)
  writeMarker("g-ack", { status: "done", summary: "done once" });
  panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), [], undefined);
  await panel.resume("g-ack", [], undefined); // writes the ack, no target to inject
  const ackFiles = readdirSync(ACKS_DIR);
  assert.equal(ackFiles.length, 1);
  assert.ok(readFileSync(join(ACKS_DIR, ackFiles[0]), "utf8").includes("ackedAt"));
  assert.match(await panel.resume("g-ack", [], undefined), /already resumed/);

  // active goal_mode entry → refuse
  writeMarker("g-goal", { status: "done", summary: "under goal" });
  const goalSession = {
    getEntries: () => [{ type: "custom", customType: "goal_mode", data: { status: "active" } }],
  };
  panel = new JobsPanel(goalSession, "/proj/alpha", undefined);
  panel.poll(Date.now(), [], undefined);
  assert.match(await panel.resume("g-goal", [], undefined), /\/goal is active/);

  // non-terminal workflow run in cwd → refuse (flat layout)
  const wfDir = mkdtempSync(join(tmpdir(), "pi-king-wf-"));
  mkdirSync(join(wfDir, ".pi", "workflows", "runs"), { recursive: true });
  writeFileSync(join(wfDir, ".pi", "workflows", "runs", "run-1.json"), JSON.stringify({ status: "running" }));
  writeMarker("g-wf", { status: "done", summary: "under workflow" });
  panel = new JobsPanel(noSession, wfDir, undefined);
  panel.poll(Date.now(), [], undefined);
  assert.match(await panel.resume("g-wf", [], undefined), /workflow run is active/);
  // legacy layout refusal
  const legacyDir = mkdtempSync(join(tmpdir(), "pi-king-wf-legacy-"));
  mkdirSync(join(legacyDir, ".pi", "workflows", "run-1"), { recursive: true });
  writeFileSync(join(legacyDir, ".pi", "workflows", "run-1", "run.json"), JSON.stringify({ run: { status: "paused" } }));
  writeMarker("g-wf2", { status: "done" });
  panel = new JobsPanel(noSession, legacyDir, undefined);
  panel.poll(Date.now(), [], undefined);
  assert.match(await panel.resume("g-wf2", [], undefined), /workflow run is active/);
});

test("resume happy path: ack + framed injection into the target session", async () => {
  resetJobsDir();
  resetLog();
  rmSync(ACKS_DIR, { recursive: true, force: true });
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined);
  writeMarker("ok-1", { status: "failed", summary: "exit=2", resultPath: "/proj/alpha/out.log" });
  const rows = [sessionRow("/proj/alpha", "t-alpha")];
  panel.poll(Date.now(), rows, rows[0]);
  const msg = await panel.resume("ok-1", rows, rows[0]);
  assert.match(msg, /Resumed job ok-1/);
  const log = readFileSync(logFile, "utf8").trim();
  assert.match(log, /send-keys -t t-alpha/);
  assert.match(log, /UNTRUSTED report, verify before acting/);
  assert.match(log, /Summarize what the job reports/);
  // ack written → a second resume is refused
  assert.match(await panel.resume("ok-1", rows, rows[0]), /already resumed/);
});

test("poll seeds seen with pre-existing markers (no re-inject on reopen)", async () => {
  resetJobsDir();
  resetLog();
  writeMarker("old-1", { status: "done", summary: "from before" });
  const panel = new JobsPanel(noSession, "/proj/alpha", undefined); // seeds old-1
  const rows = [sessionRow("/proj/alpha", "t-alpha")];
  panel.poll(Date.now(), rows, rows[0]);
  await settle();
  assert.equal(readLog().trim(), "", "pre-existing markers must not inject");
  // a marker written after open still injects exactly once
  writeMarker("new-1", { status: "done", summary: "while open", resultPath: "/proj/alpha/x" });
  panel.poll(Date.now(), rows, rows[0]);
  await settle();
  panel.poll(Date.now(), rows, rows[0]);
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
