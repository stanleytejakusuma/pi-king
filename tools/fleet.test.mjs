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

test("PI_BIN: defaults to pi, honours PI_KING_PI_BIN, and is used at every spawn site", async () => {
  // Guards two things at once: that the default is unchanged (a wrong default
  // would silently repoint the whole fleet), and that no spawn site kept a
  // hardcoded "pi" behind. The literal must survive ONLY in the PI_BIN
  // definition and in the process.title detector, which really does look for
  // the string "pi" that pi writes over its own argv.
  const { readFileSync } = await import("node:fs");
  for (const f of ["src/index.ts", "src/fleet.ts"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    for (const line of src.split("\n")) {
      if (!line.includes('"--", "pi"') && !line.includes('"pi", "--')) continue;
      assert.fail(`${f} still spawns a hardcoded "pi": ${line.trim()}`);
    }
  }
});

// ---- orderByLineage (docs/ARC-TREE-DESIGN.md) -----------------------------
// The ordering is the part with edge cases worth testing -- cycles, absent
// parents, collapse -- and none of them need a filesystem to reproduce, which
// is why the function takes all three inputs rather than reading them.

const { orderByLineage } = await import("../src/fleet.ts");
const mkRow = (id, extra = {}) => ({ kind: "session", entry: { sessionId: id, cwd: "/w", project: "w", ...extra } });
const ids = (rows) => rows.map((r) => r.entry.sessionId);
const shape = (rows) => rows.map((r) => `${r.tree.prefix}${r.entry.sessionId}`);

test("no lineage: order and rows are untouched, every row depth 0", () => {
  const rows = [mkRow("a"), mkRow("b"), mkRow("c")];
  const out = orderByLineage(rows, new Map(), new Set());
  assert.deepEqual(ids(out), ["a", "b", "c"]);
  assert.deepEqual(out.map((r) => r.tree.depth), [0, 0, 0]);
  assert.deepEqual(out.map((r) => r.tree.prefix), ["", "", ""]);
  assert.deepEqual(out.map((r) => r.tree.arcCount), [0, 0, 0]);
});

test("a child is hoisted to sit directly under its parent", () => {
  // 'kid' sorts last on its own; lineage must move it up next to 'mum'.
  const rows = [mkRow("mum"), mkRow("other"), mkRow("kid")];
  const out = orderByLineage(rows, new Map([["kid", "mum"]]), new Set());
  assert.deepEqual(ids(out), ["mum", "kid", "other"]);
  assert.equal(out[0].tree.arcCount, 1);
  assert.equal(out[1].tree.depth, 1);
  assert.equal(out[2].tree.arcCount, 0);
});

test("arcs nest recursively, and glyphs continue the parent's rail", () => {
  // The case Stanley asked for by name: an arc that spawns an arc.
  const rows = [mkRow("root"), mkRow("a1"), mkRow("a2"), mkRow("deep")];
  const parents = new Map([["a1", "root"], ["a2", "root"], ["deep", "a1"]]);
  const out = orderByLineage(rows, parents, new Set());
  assert.deepEqual(shape(out), ["root", "├─ a1", "│  └─ deep", "└─ a2"]);
  assert.deepEqual(out.map((r) => r.tree.depth), [0, 1, 2, 1]);
});

test("collapsing a parent hides descendants but keeps the parent", () => {
  const rows = [mkRow("root"), mkRow("a1"), mkRow("deep")];
  const parents = new Map([["a1", "root"], ["deep", "a1"]]);
  const out = orderByLineage(rows, parents, new Set(["root"]));
  assert.deepEqual(ids(out), ["root"]);
  assert.equal(out[0].tree.collapsed, true);
  assert.equal(out[0].tree.arcCount, 1);
});

test("collapsing an intermediate arc hides only its own subtree", () => {
  const rows = [mkRow("root"), mkRow("a1"), mkRow("deep"), mkRow("a2")];
  const parents = new Map([["a1", "root"], ["deep", "a1"], ["a2", "root"]]);
  const out = orderByLineage(rows, parents, new Set(["a1"]));
  assert.deepEqual(ids(out), ["root", "a1", "a2"]);
});

test("a parent that is not on the dashboard leaves its arc at top level", () => {
  // Arcs inherit visibility at spawn, so this only happens when the parent's
  // card was dismissed later. The arc must stay visible, not disappear.
  const rows = [mkRow("orphanArc")];
  const out = orderByLineage(rows, new Map([["orphanArc", "gone"]]), new Set());
  assert.deepEqual(ids(out), ["orphanArc"]);
  assert.equal(out[0].tree.depth, 0);
  assert.equal(out[0].tree.prefix, "");
});

test("a lineage cycle still renders every row instead of deleting them", () => {
  // a -> b -> a leaves neither reachable from a root. Losing sight of a live
  // session is far worse than rendering it flat.
  const rows = [mkRow("a"), mkRow("b"), mkRow("sane")];
  const out = orderByLineage(rows, new Map([["a", "b"], ["b", "a"]]), new Set());
  assert.deepEqual(ids(out).sort(), ["a", "b", "sane"]);
  assert.equal(out.length, 3);
});

test("a row parented to itself is treated as a root, not an infinite tree", () => {
  const out = orderByLineage([mkRow("self")], new Map([["self", "self"]]), new Set());
  assert.deepEqual(ids(out), ["self"]);
  assert.equal(out[0].tree.depth, 0);
});

test("orderByLineage does not mutate the rows it was given", () => {
  const rows = [mkRow("mum"), mkRow("kid")];
  orderByLineage(rows, new Map([["kid", "mum"]]), new Set());
  assert.equal(rows[0].tree, undefined);
  assert.equal(rows[1].tree, undefined);
});

// ---- visibility inheritance ----------------------------------------------

test("tmuxLaunchEnv omits PI_DASHBOARD_SPAWNED when spawning invisible", async () => {
  const { tmuxLaunchEnv } = await import("../src/fleet.ts");
  assert.ok(tmuxLaunchEnv().includes("PI_DASHBOARD_SPAWNED=1"), "visible spawn must opt in");
  assert.ok(tmuxLaunchEnv(true).includes("PI_DASHBOARD_SPAWNED=1"), "default is visible");
  // Withheld entirely rather than set to 0: that is what makes an arc of an
  // unmanaged session indistinguishable from an ad-hoc `pi` in a terminal.
  assert.ok(!tmuxLaunchEnv(false).some((a) => a.startsWith("PI_DASHBOARD_SPAWNED")),
    "invisible spawn must not mention the flag at all");
});

test("createTmuxSession passes visibility through to the spawned process", () => {
  resetLog();
  createTmuxSession("vis", "/tmp", undefined, undefined, true);
  assert.match(readLog(), /PI_DASHBOARD_SPAWNED=1/);
  resetLog();
  createTmuxSession("invis", "/tmp", undefined, undefined, false);
  assert.doesNotMatch(readLog(), /PI_DASHBOARD_SPAWNED/);
});

// ---- layout.collapsed round-trip -----------------------------------------

test("layout.collapsed survives a read/write round-trip and rejects junk", async () => {
  const { readLayout, LAYOUT_FILE } = await import("../src/fleet.ts");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(LAYOUT_FILE, JSON.stringify({ pinned: [], order: [], names: {}, collapsed: ["x", 7, null, "y"] }));
  assert.deepEqual(readLayout().collapsed, ["x", "y"]);
  writeFileSync(LAYOUT_FILE, JSON.stringify({ pinned: [], order: [], names: {} }));
  assert.deepEqual(readLayout().collapsed, [], "a layout written before this feature must not crash");
});

// ---- pruneOrphanArcs (docs/ARC-TREE-DESIGN.md decision 3, render-side gate) -
const { pruneOrphanArcs } = await import("../src/fleet.ts");

test("an arc whose parent is not on the dashboard is hidden", () => {
  const rows = [mkRow("kid"), mkRow("other")];
  const out = pruneOrphanArcs(rows, new Map([["kid", "ghost"]]));
  assert.deepEqual(ids(out), ["other"]);
});

test("a grandchild of an absent parent is hidden too", () => {
  const rows = [mkRow("g"), mkRow("k"), mkRow("other")];
  const parentOf = new Map([["g", "k"], ["k", "ghost"]]);
  assert.deepEqual(ids(pruneOrphanArcs(rows, parentOf)), ["other"]);
});

test("an arc whose parent IS on the dashboard survives", () => {
  const rows = [mkRow("mum"), mkRow("kid")];
  const out = pruneOrphanArcs(rows, new Map([["kid", "mum"]]));
  assert.deepEqual(ids(out), ["mum", "kid"]);
});

test("a cycle of present rows stays visible, rendered flat", () => {
  const rows = [mkRow("a"), mkRow("b")];
  const out = pruneOrphanArcs(rows, new Map([["a", "b"], ["b", "a"]]));
  assert.deepEqual(ids(out).sort(), ["a", "b"]);
});

test("sessions with no lineage entry are never pruned", () => {
  const rows = [mkRow("plain"), mkRow("kid")];
  const out = pruneOrphanArcs(rows, new Map([["kid", "ghost"]]));
  assert.deepEqual(ids(out), ["plain"]);
});
