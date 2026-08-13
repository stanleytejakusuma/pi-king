#!/usr/bin/env node
// Regression coverage for tools/patch-pi-tui.mjs. This tool itself caused a
// real incident (2026-08-10): a sandboxed test run silently fell through to
// the REAL global pi-tui install via `which pi` PATH-shadowing and patched
// it. Root fix was PI_KING_PI_TUI_TARGET (bypasses `which` entirely); this
// file is the automated coverage the incident's postmortem said was
// missing — every scenario here runs via execFileSync against a real
// fixture file, using the override, so this NEVER touches the real
// install, and every case that previously required manual sandbox
// construction now runs on every `npm run check`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOL = join(import.meta.dirname, "patch-pi-tui.mjs");

// Byte-exact original snippet, copied from patch-pi-tui.mjs's own ORIGINAL
// constant — kept as a literal here (not imported) so this test proves the
// CLI's on-disk behavior end-to-end, not just internal function calls.
const originalBlock = `            for (let i = 0; i < newLines.length; i++) {
                if (i > 0)
                    buffer += "\\r\\n";
                const line = newLines[i];`;

// Second patch site (Fix 5, utils.js). The tool applies both sites as one
// unit, so every fixture must provide both files or apply() correctly
// refuses on the missing one.
const originalWidthCache = `const WIDTH_CACHE_SIZE = 512;`;

// Third patch site (Fix 6, 2026-08-13) lives in the SAME file as render-cap,
// so the tui-main-screen.js fixture must carry it too or apply() correctly
// refuses and the file never changes.
const originalKittyCollect = `    collectKittyImageIds(lines) {
        const ids = new Set();
        for (const line of lines) {
            for (const id of extractKittyImageIds(line)) {
                ids.add(id);
            }
        }
        return ids;
    }`;

function fixture(dir, body = originalBlock, widthBody = originalWidthCache, kitty = true) {
  const path = join(dir, "tui-main-screen.js");
  const kittyBody = kitty ? `${originalKittyCollect}\n` : "";
  writeFileSync(path, `// fixture\n${kittyBody}${body}\n// end fixture\n`);
  writeFileSync(join(dir, "utils.js"), `// fixture\n${widthBody}\n// end fixture\n`);
  return path;
}

function run(args, target) {
  try {
    const stdout = execFileSync("node", [TOOL, ...args], {
      encoding: "utf8",
      env: { ...process.env, PI_KING_PI_TUI_TARGET: target, HOME: process.env.HOME },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

let dir;
const fresh = () => { dir = mkdtempSync(join(tmpdir(), "pi-king-patchtool-")); return dir; };
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

test("--check on a fresh fixture: unpatched, exit 1", () => {
  const target = fixture(fresh());
  const r = run(["--check"], target);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /unpatched/);
  cleanup();
});

test("apply: succeeds, writes a byte-preserving .orig backup, and inserts the marker exactly once", () => {
  const target = fixture(fresh());
  const before = readFileSync(target, "utf8");
  const r = run([], target);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(`${target}.orig`, "utf8"), before, ".orig must be byte-identical to pre-patch content");
  const after = readFileSync(target, "utf8");
  assert.equal((after.match(/pi-king-tui-patch:v1/g) ?? []).length, 1);
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

test("unknown-version refusal: a hand-mutated patch site refuses to apply, exit 2, file left untouched", () => {
  const target = fixture(fresh(), originalBlock.replace("i < newLines.length", "i < newLines.length /* changed */"));
  const before = readFileSync(target, "utf8");
  const r = run([], target);
  assert.equal(r.code, 2);
  assert.equal(readFileSync(target, "utf8"), before, "a refused apply must not touch the file at all");
  cleanup();
});

// The exact bug class the 2026-08-10 review flagged: String.replace() only
// touches the FIRST match, so if the target text appears more than once,
// blind replacement could silently patch the wrong occurrence while still
// reporting success. status() must treat "more than one occurrence" as
// unknown/needs-review, never as a green light.
test("multiple occurrences of the target block: refuses rather than guessing which one to patch", () => {
  const target = fixture(fresh(), `${originalBlock}\n// --- an unrelated second copy of the same loop shape ---\n${originalBlock}`);
  const before = readFileSync(target, "utf8");
  const rCheck = run(["--check"], target);
  assert.equal(rCheck.code, 2, "--check must report unknown (2), not unpatched (1), when the match isn't unique");
  const rApply = run([], target);
  assert.equal(rApply.code, 2, "apply must refuse rather than patch an ambiguous first match");
  assert.equal(readFileSync(target, "utf8"), before, "a refused apply must not touch the file at all");
  cleanup();
});

test("zero occurrences (pi-tui changed the block entirely): unknown, exit 2, refuses to apply", () => {
  const target = fixture(fresh(), "// this file no longer has the loop shape at all");
  const rCheck = run(["--check"], target);
  assert.equal(rCheck.code, 2);
  const rApply = run([], target);
  assert.equal(rApply.code, 2);
  cleanup();
});

test("missing target file: --check reports missing, exit 1 (not a crash)", () => {
  fresh();
  const target = join(dir, "does-not-exist.js");
  const r = run(["--check"], target);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /missing/);
  cleanup();
});

test("width-cache site: apply raises WIDTH_CACHE_SIZE and marks it, revert restores byte-exact", () => {
  const target = fixture(fresh());
  const utils = join(dir, "utils.js");
  const before = readFileSync(utils, "utf8");
  assert.equal(run([], target).code, 0);
  const after = readFileSync(utils, "utf8");
  assert.match(after, /const WIDTH_CACHE_SIZE = 65536;/);
  assert.equal((after.match(/pi-king-tui-patch:widthcache-v1/g) ?? []).length, 1);
  assert.equal(readFileSync(`${utils}.orig`, "utf8"), before, ".orig must be byte-identical to pre-patch content");
  assert.equal(run(["--revert"], target).code, 0);
  assert.equal(readFileSync(utils, "utf8"), before, "revert must restore byte-exact original");
  cleanup();
});

test("partial patch state (one site clobbered by an upgrade) reports unpatched, never healthy", () => {
  const target = fixture(fresh());
  assert.equal(run([], target).code, 0);
  // Simulate an upgrade that replaced utils.js but happened to leave
  // tui-main-screen.js patched: the pair must not average out to "patched".
  writeFileSync(join(dir, "utils.js"), `// fixture\n${originalWidthCache}\n// end fixture\n`);
  const r = run(["--check"], target);
  assert.equal(r.code, 1, "a half-patched install must not report healthy");
  assert.match(r.stdout, /patched/);
  assert.match(r.stdout, /unpatched/);
  cleanup();
});

test("an unrecognised site refuses the WHOLE run, leaving the other site untouched", () => {
  // utils.js mutated (unknown), tui-main-screen.js pristine (patchable).
  // A half-applied pair is worse than none: the daemon warning would clear
  // while a real regression stayed live.
  const target = fixture(fresh(), originalBlock, "const WIDTH_CACHE_SIZE = 999;");
  const before = readFileSync(target, "utf8");
  const r = run([], target);
  assert.equal(r.code, 2);
  assert.equal(readFileSync(target, "utf8"), before, "the patchable site must be left untouched when a sibling site is unknown");
  cleanup();
});

test("no PI_KING_PI_TUI_TARGET and no real `pi` reachable: fails closed, never falls through to a real system path", () => {
  fresh();
  // PATH must still resolve `node` itself (needed to spawn the child at
  // all -- an execFileSync ENOENT on the spawn itself is a different
  // failure shape, status:null, and would prove nothing about the tool's
  // own PATH-fallback behavior) and `which` (the tool's own dependency),
  // but must NOT resolve `pi`. dirname(process.execPath) gives node without
  // dragging in any real pi install.
  const safePath = [join(process.execPath, ".."), "/usr/bin", "/bin"].join(":");
  let code, stdout, stderr;
  try {
    stdout = execFileSync("node", [TOOL, "--check"], {
      encoding: "utf8",
      env: { PATH: safePath, HOME: process.env.HOME },
    });
    code = 0;
  } catch (err) {
    code = err.status;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }
  assert.equal(code, 2);
  assert.match(`${stdout}${stderr}`, /pi.*not found on PATH/i);
  cleanup();
});

// The ghost-cursor guard: pi's showHardwareCursor:true is what paints stray
// white blocks under tmux (docs/PERF-TMUX-SPEC.md). --check warns about it but
// must NOT move the exit code, which the daemon watchdog reads as patch state.
test("--check warns when showHardwareCursor is on, and only then", () => {
  const target = fixture(fresh());
  const home = mkdtempSync(join(tmpdir(), "pi-king-home-"));
  mkdirSync(join(home, ".pi/agent"), { recursive: true });
  const settings = join(home, ".pi/agent/settings.json");
  const runHome = (args) => {
    try {
      return { code: 0, stdout: execFileSync("node", [TOOL, ...args], {
        encoding: "utf8",
        env: { ...process.env, PI_KING_PI_TUI_TARGET: target, HOME: home },
      }) };
    } catch (err) { return { code: err.status, stdout: err.stdout ?? "" }; }
  };

  writeFileSync(settings, JSON.stringify({ showHardwareCursor: true }));
  const on = runHome(["--check"]);
  assert.match(on.stdout, /hardware-cursor\]: ON/);
  assert.equal(on.code, 1, "unpatched fixture still reports 1 — the warning must not change it");

  writeFileSync(settings, JSON.stringify({ showHardwareCursor: false }));
  assert.doesNotMatch(runHome(["--check"]).stdout, /hardware-cursor/);

  rmSync(settings);
  assert.doesNotMatch(runHome(["--check"]).stdout, /hardware-cursor/, "no settings file: silent");

  rmSync(home, { recursive: true, force: true });
  cleanup();
});
