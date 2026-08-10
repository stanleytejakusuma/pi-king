#!/usr/bin/env node
// Logic-level tests for src/fleet.ts's client-size machinery (Fix 1 of the
// 2026-08-10 tmux perf audit, docs/PERF-TMUX-SPEC.md): resolveSpawnSize's
// fallback chain, the persisted client-size.json round-trip, and
// createTmuxSession actually emitting -x/-y. Hermetic: PI_KING_STATUS_DIR
// points at a scratch dir (CLIENT_SIZE_FILE derives from it), PI_KING_TMUX
// at a fake binary that logs argv, same convention as jobs.test.mjs. Env
// must be set BEFORE the dynamic import — fleet.ts resolves both at load.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const statusDir = mkdtempSync(join(tmpdir(), "pi-king-status-"));
process.env.PI_KING_STATUS_DIR = statusDir;
const clientSizeDir = mkdtempSync(join(tmpdir(), "pi-king-clientsize-"));
process.env.PI_KING_CLIENT_SIZE_FILE = join(clientSizeDir, "client-size.json");

const toolsDir = mkdtempSync(join(tmpdir(), "pi-king-fleet-tools-"));
const logFile = join(toolsDir, "tmux.log");
const fakeTmux = join(toolsDir, "fake-tmux.sh");
writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\n`, { mode: 0o755 });
process.env.PI_KING_TMUX = fakeTmux;

const {
  CLIENT_SIZE_FILE,
  DEFAULT_SPAWN_SIZE,
  createTmuxSession,
  readClientSize,
  resolveSpawnSize,
  writeClientSize,
} = await import("../src/fleet.ts");

const resetLog = () => { rmSync(logFile, { force: true }); };
const readLog = () => { try { return readFileSync(logFile, "utf8"); } catch { return ""; } };
const clearPersisted = () => { rmSync(CLIENT_SIZE_FILE, { force: true }); };

// ---- readClientSize / writeClientSize ------------------------------------

test("no persisted file yet: readClientSize is undefined", () => {
  clearPersisted();
  assert.equal(readClientSize(), undefined);
});

test("writeClientSize then readClientSize round-trips exactly", () => {
  clearPersisted();
  writeClientSize({ w: 224, h: 63 });
  assert.deepEqual(readClientSize(), { w: 224, h: 63 });
});

test("writeClientSize rejects non-finite / non-positive sizes silently (no write, no throw)", () => {
  clearPersisted();
  writeClientSize({ w: 0, h: 63 });
  assert.equal(readClientSize(), undefined);
  writeClientSize({ w: NaN, h: 63 });
  assert.equal(readClientSize(), undefined);
  writeClientSize({ w: -5, h: 10 });
  assert.equal(readClientSize(), undefined);
});

test("writeClientSize is a no-op write when the size hasn't changed (dedup)", () => {
  clearPersisted();
  writeClientSize({ w: 100, h: 40 });
  const first = readFileSync(CLIENT_SIZE_FILE, "utf8");
  // A second write of the SAME size must not touch the file's contents
  // (specifically its `at` timestamp) — proves the read-compare-before-write
  // guard actually short-circuits rather than always rewriting.
  writeClientSize({ w: 100, h: 40 });
  const second = readFileSync(CLIENT_SIZE_FILE, "utf8");
  assert.equal(first, second);
});

test("writeClientSize DOES write when the size changed", () => {
  clearPersisted();
  writeClientSize({ w: 100, h: 40 });
  writeClientSize({ w: 200, h: 50 });
  assert.deepEqual(readClientSize(), { w: 200, h: 50 });
});

test("readClientSize survives a corrupt/malformed file (returns undefined, does not throw)", () => {
  mkdirSync(join(CLIENT_SIZE_FILE, ".."), { recursive: true });
  writeFileSync(CLIENT_SIZE_FILE, "{not json");
  assert.equal(readClientSize(), undefined);
  clearPersisted();
});

// ---- resolveSpawnSize: the three-tier fallback chain ---------------------

test("resolveSpawnSize: tier 1 — a valid live size wins over everything else", () => {
  clearPersisted();
  writeClientSize({ w: 999, h: 999 });
  assert.deepEqual(resolveSpawnSize({ w: 10, h: 20 }), { w: 10, h: 20 });
});

test("resolveSpawnSize: tier 2 — no live size, falls back to the persisted file", () => {
  clearPersisted();
  writeClientSize({ w: 180, h: 45 });
  assert.deepEqual(resolveSpawnSize(undefined), { w: 180, h: 45 });
});

test("resolveSpawnSize: tier 3 — neither live nor persisted, falls back to DEFAULT_SPAWN_SIZE", () => {
  clearPersisted();
  assert.deepEqual(resolveSpawnSize(undefined), DEFAULT_SPAWN_SIZE);
});

test("resolveSpawnSize: an invalid live size (zero/negative/NaN) is treated as absent, not trusted", () => {
  clearPersisted();
  writeClientSize({ w: 150, h: 55 });
  assert.deepEqual(resolveSpawnSize({ w: 0, h: 0 }), { w: 150, h: 55 });
  assert.deepEqual(resolveSpawnSize({ w: NaN, h: 40 }), { w: 150, h: 55 });
});

// ---- createTmuxSession actually emits -x/-y ------------------------------

test("createTmuxSession passes -x/-y from a live size hint", () => {
  clearPersisted();
  resetLog();
  createTmuxSession("test-session-a", "/tmp", undefined, { w: 137, h: 41 });
  const call = readLog();
  assert.match(call, /-x 137/);
  assert.match(call, /-y 41/);
});

test("createTmuxSession falls back to the persisted size when no live hint is given", () => {
  clearPersisted();
  writeClientSize({ w: 210, h: 58 });
  resetLog();
  createTmuxSession("test-session-b", "/tmp");
  const call = readLog();
  assert.match(call, /-x 210/);
  assert.match(call, /-y 58/);
});

test("createTmuxSession falls back to DEFAULT_SPAWN_SIZE (224x63) with nothing else known — never tmux's bare 80x24 default", () => {
  clearPersisted();
  resetLog();
  createTmuxSession("test-session-c", "/tmp");
  const call = readLog();
  assert.match(call, new RegExp(`-x ${DEFAULT_SPAWN_SIZE.w}`));
  assert.match(call, new RegExp(`-y ${DEFAULT_SPAWN_SIZE.h}`));
});

after(() => {
  rmSync(statusDir, { recursive: true, force: true });
  rmSync(toolsDir, { recursive: true, force: true });
  rmSync(clientSizeDir, { recursive: true, force: true });
});
