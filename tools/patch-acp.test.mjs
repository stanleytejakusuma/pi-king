#!/usr/bin/env node
// Regression coverage for tools/patch-acp.mjs, same fixture-and-execFileSync
// pattern as patch-pi-tui.test.mjs (see that file's header for why: a
// sandboxed run must never fall through to a real install). PI_KING_ACP_TARGET
// takes a literal file path (unlike PI_KING_PI_TUI_TARGET, which takes a dist
// dir) because this tool's target is a fixed path, not `which`-resolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOL = join(import.meta.dirname, "patch-acp.mjs");

// Byte-exact stock source, copied from patch-acp.mjs's own ORIGINAL constant
// (not imported) so this proves the CLI's on-disk behavior end-to-end.
const original = `function wireCompactionDisable(pi) {
  pi.on("session_before_compact", () => ({ cancel: true }));
}`;

function fixture(dir, body = original) {
  const path = join(dir, "index.js");
  writeFileSync(path, `"use strict";\nfunction otherStuff() { return 1; }\n${body}\nmodule.exports = { wireCompactionDisable };\n`);
  return path;
}

function run(args, target) {
  try {
    const stdout = execFileSync("node", [TOOL, ...args], {
      encoding: "utf8",
      env: { ...process.env, PI_KING_ACP_TARGET: target },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

let dir;
const fresh = () => { dir = mkdtempSync(join(tmpdir(), "pi-king-acptool-")); return dir; };
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

test("unknown argument refuses instead of falling through to apply", () => {
  const target = fixture(fresh());
  const before = readFileSync(target, "utf8");
  for (const bad of ["check", "revert", "--dry-run", "-c"]) {
    const r = run([bad], target);
    assert.equal(r.code, 2, `"${bad}" should exit 2`);
    assert.match(r.stderr ?? "", /unknown argument/);
    assert.equal(readFileSync(target, "utf8"), before, `"${bad}" must leave the file byte-identical`);
  }
  cleanup();
});

test("--check on a fresh fixture: unpatched, exit 1", () => {
  const target = fixture(fresh());
  const r = run(["--check"], target);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /unpatched/);
  cleanup();
});

test("apply: succeeds, writes a byte-preserving .orig backup, node --check passes, marker exactly once", () => {
  const target = fixture(fresh());
  const before = readFileSync(target, "utf8");
  const r = run([], target);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(`${target}.orig`, "utf8"), before, ".orig must be byte-identical to pre-patch content");
  const after = readFileSync(target, "utf8");
  assert.equal((after.match(/SAFETY_CEILING_PCT/g) ?? []).length, 3, "marker comment, const declaration, and the usage.percent comparison");
  assert.doesNotThrow(() => execFileSync("node", ["--check", target]), "patched output must be valid JS");
  cleanup();
});

test("apply is idempotent: applying twice does not double-patch or error", () => {
  const target = fixture(fresh());
  run([], target);
  const r2 = run([], target);
  assert.equal(r2.code, 0);
  assert.match(r2.stdout, /Already patched/);
  cleanup();
});

test("--check after apply: patched, exit 0", () => {
  const target = fixture(fresh());
  run([], target);
  const r = run(["--check"], target);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /patched/);
  cleanup();
});

test("--revert restores byte-exact original content", () => {
  const target = fixture(fresh());
  const before = readFileSync(target, "utf8");
  run([], target);
  assert.notEqual(readFileSync(target, "utf8"), before, "sanity: patch actually changed the file");
  const r = run(["--revert"], target);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(target, "utf8"), before, "revert must restore byte-exact original");
  cleanup();
});

test("--revert with no prior apply (no .orig): refuses, exit 2", () => {
  const target = fixture(fresh());
  const r = run(["--revert"], target);
  assert.equal(r.code, 2);
  cleanup();
});

test("unknown-version refusal: a hand-mutated source refuses to apply, exit 2, file left untouched", () => {
  const target = fixture(fresh(), original.replace("cancel: true", "cancel: true /* changed */"));
  const before = readFileSync(target, "utf8");
  const r = run([], target);
  assert.equal(r.code, 2);
  assert.equal(readFileSync(target, "utf8"), before, "a refused apply must not touch the file at all");
  cleanup();
});

// Same bug class patch-pi-tui.mjs's review flagged 2026-08-10: a blind
// String.replace() only touches the first match, so if the target text
// appears more than once, status() must treat that as unknown, never as a
// green light to patch the wrong occurrence.
test("multiple occurrences of the stock block: refuses rather than guessing which one to patch", () => {
  const target = fixture(fresh(), `${original}\n// --- unrelated second copy ---\n${original}`);
  const before = readFileSync(target, "utf8");
  assert.equal(run(["--check"], target).code, 2, "--check must report unknown (2), not unpatched (1)");
  const r = run([], target);
  assert.equal(r.code, 2);
  assert.equal(readFileSync(target, "utf8"), before, "a refused apply must not touch the file at all");
  cleanup();
});

test("zero occurrences (billion-context-pi changed the hook entirely): unknown, exit 2, refuses to apply", () => {
  const target = fixture(fresh(), "// this file no longer has the hook shape at all");
  assert.equal(run(["--check"], target).code, 2);
  assert.equal(run([], target).code, 2);
  cleanup();
});

test("missing target file: --check reports missing, exit 2 (not a crash)", () => {
  fresh();
  const target = join(dir, "does-not-exist.js");
  const r = run(["--check"], target);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /missing/);
  cleanup();
});

test("already-patched fixture is recognised as patched even with no prior .orig in this process (fresh daemon restart scenario)", () => {
  // Simulates the daemon's own use: it never applied the patch itself in a
  // prior tick, it's just checking content on a file some earlier run (or a
  // human) already patched.
  const target = fixture(fresh());
  run([], target); // apply once to get real patched content
  const patchedContent = readFileSync(target, "utf8");
  const target2 = fixture(fresh(), patchedContent.match(/function wireCompactionDisable[\s\S]*?\n}/)[0]);
  const r = run(["--check"], target2);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /patched/);
  cleanup();
});
