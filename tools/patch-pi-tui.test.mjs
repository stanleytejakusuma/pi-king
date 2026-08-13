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

// Fourth patch site (box-child-memo, components/box.js). Unlike the three
// above, this one's fixture is a RUNNABLE copy of upstream's Box — the
// behavioural tests at the bottom of this file import it and render with it,
// because "the marker got inserted" proves nothing about a cache whose bug
// shape is wrong text on screen. The render() method below is byte-exact
// upstream 0.84.1 and must stay that way or the patch stops matching.
const originalBoxRender = `    render(width) {
        if (this.children.length === 0) {
            return [];
        }
        const contentWidth = Math.max(1, width - this.paddingX * 2);
        const leftPad = " ".repeat(this.paddingX);
        // Render all children
        const childLines = [];
        for (const child of this.children) {
            const lines = child.render(contentWidth);
            for (const line of lines) {
                childLines.push(leftPad + line);
            }
        }
        if (childLines.length === 0) {
            return [];
        }
        // Check if bgFn output changed by sampling
        const bgSample = this.bgFn ? this.bgFn("test") : undefined;
        // Check cache validity
        if (this.matchCache(width, childLines, bgSample)) {
            return this.cache.lines;
        }
        // Apply background and padding
        const result = [];
        // Top padding
        for (let i = 0; i < this.paddingY; i++) {
            result.push(this.applyBg("", width));
        }
        // Content
        for (const line of childLines) {
            result.push(this.applyBg(line, width));
        }
        // Bottom padding
        for (let i = 0; i < this.paddingY; i++) {
            result.push(this.applyBg("", width));
        }
        // Update cache
        this.cache = { childLines, width, bgSample, lines: result };
        return result;
    }`;

// The rest of upstream's Box, verbatim, so the fixture is importable and
// really exercises matchCache/applyBg rather than a mock of them.
const boxSource = (render) => `import { applyBackgroundToLine, visibleWidth } from "../utils.js";
export class Box {
    children = [];
    paddingX;
    paddingY;
    bgFn;
    cache;
    constructor(paddingX = 1, paddingY = 1, bgFn) {
        this.paddingX = paddingX;
        this.paddingY = paddingY;
        this.bgFn = bgFn;
    }
    addChild(component) {
        this.children.push(component);
        this.invalidateCache();
    }
    removeChild(component) {
        const index = this.children.indexOf(component);
        if (index !== -1) {
            this.children.splice(index, 1);
            this.invalidateCache();
        }
    }
    clear() {
        this.children = [];
        this.invalidateCache();
    }
    setBgFn(bgFn) {
        this.bgFn = bgFn;
    }
    invalidateCache() {
        this.cache = undefined;
    }
    matchCache(width, childLines, bgSample) {
        const cache = this.cache;
        return (!!cache &&
            cache.width === width &&
            cache.bgSample === bgSample &&
            cache.childLines.length === childLines.length &&
            cache.childLines.every((line, i) => line === childLines[i]));
    }
    invalidate() {
        this.invalidateCache();
        for (const child of this.children) {
            child.invalidate?.();
        }
    }
${render}
    applyBg(line, width) {
        const visLen = visibleWidth(line);
        const padNeeded = Math.max(0, width - visLen);
        const padded = line + " ".repeat(padNeeded);
        if (this.bgFn) {
            return applyBackgroundToLine(padded, width, this.bgFn);
        }
        return padded;
    }
}
`;

// Dependency-free stand-ins so the fixture imports cleanly in a tmpdir with
// no node_modules. Real utils.js pulls in get-east-asian-width; Box only
// needs these two, and the patch changes neither.
const utilsSource = (widthBody) => `${widthBody}
export function visibleWidth(s) {
  return s.replace(/\\x1b\\[[0-9;]*m/g, "").length;
}
export function applyBackgroundToLine(line, width, bgFn) {
  return bgFn(line);
}
`;

function fixture(dir, body = originalBlock, widthBody = originalWidthCache, kitty = true, boxRender = originalBoxRender) {
  const path = join(dir, "tui-main-screen.js");
  const kittyBody = kitty ? `${originalKittyCollect}\n` : "";
  writeFileSync(path, `// fixture\n${kittyBody}${body}\n// end fixture\n`);
  writeFileSync(join(dir, "utils.js"), utilsSource(widthBody));
  // package.json so components/box.js loads as ESM when imported.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(dir, "components"), { recursive: true });
  writeFileSync(join(dir, "components", "box.js"), boxSource(boxRender));
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

// ---------------------------------------------------------------------------
// [box-child-memo] — the fourth patch site.
//
// This patch is different in kind from the other three: they change how much
// work is written or cached, and a mistake shows up as slowness. This one
// decides whether to REUSE a previously rendered frame, so a mistake shows up
// as *wrong text on the user's screen*. Marker-presence tests cannot see that
// class of bug at all, so the tests below import the patched fixture and
// actually render with it.
//
// The soundness argument the patch rests on: pi-tui's Text, Markdown and Image
// all memoise internally and return the SAME array object while their content
// and width are unchanged (verified against 0.84.1's dist — they are also the
// only three components that cache at all). So "every child handed back an
// identical array reference" is a proof that the flattened, left-padded
// document is unchanged, and the cached frame can be returned without
// touching a single line.
//
// That proof has exactly one hole: a component that keeps its array object
// and mutates the contents IN PLACE. No shipped component does this (grepped
// across the whole dist), but this file is re-applied blindly after every pi
// upgrade, so the patch carries a revalidation counter that forces a full
// content compare every 61st render. The adversarial test below is the one
// that fails without it.

const stubChildren = `
// Mimics Text/Markdown/Image: memoises, returns the SAME array while unchanged.
export class FakeText {
  constructor(text) { this.text = text; }
  setText(t) { this.text = t; this.cachedLines = undefined; }
  invalidate() { this.cachedLines = undefined; }
  render(width) {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) return this.cachedLines;
    const lines = [];
    for (let i = 0; i < this.text.length; i += width) lines.push(this.text.slice(i, i + width));
    this.cachedText = this.text; this.cachedWidth = width;
    this.cachedLines = lines.length ? lines : [""];
    return this.cachedLines;
  }
}
// Mimics Spacer/Loader/DynamicBorder: a brand-new array every render, so the
// reference fast path must never fire for a box containing one.
export class FreshEveryTime {
  constructor(text) { this.text = text; }
  invalidate() {}
  render() { return [this.text]; }
}
// ADVERSARIAL: same array object, mutated in place.
export class InPlaceMutator {
  constructor(t) { this.lines = [t]; }
  invalidate() {}
  render() { return this.lines; }
}
`;

/** Build a fixture dir, optionally patch it, and return an import URL for its Box. */
function boxDir(patched, mutateRender) {
  const d = mkdtempSync(join(tmpdir(), "pi-king-boxbehav-"));
  const target = fixture(d);
  if (mutateRender) {
    const p = join(d, "components", "box.js");
    writeFileSync(p, readFileSync(p, "utf8"));
  }
  if (patched) {
    const r = run([], target);
    assert.equal(r.code, 0, `fixture must patch cleanly: ${r.stdout}${r.stderr ?? ""}`);
  }
  writeFileSync(join(d, "children.mjs"), stubChildren);
  return d;
}

test("box-child-memo: registered, reported by --check, and revert is byte-exact", () => {
  const target = fixture(fresh());
  const box = join(dir, "components", "box.js");
  const before = readFileSync(box, "utf8");

  const pre = run(["--check"], target);
  assert.match(pre.stdout, /components\/box\.js \[box-child-memo\]: unpatched/);
  assert.equal(pre.code, 1);

  assert.equal(run([], target).code, 0);
  const after = readFileSync(box, "utf8");
  assert.equal((after.match(/pi-king-tui-patch:boxmemo-v1/g) ?? []).length, 1, "marker exactly once");
  assert.equal(readFileSync(`${box}.orig`, "utf8"), before, ".orig must be byte-identical to pre-patch content");

  const post = run(["--check"], target);
  assert.match(post.stdout, /components\/box\.js \[box-child-memo\]: patched/);
  assert.equal(post.code, 0);

  assert.equal(run(["--revert"], target).code, 0);
  assert.equal(readFileSync(box, "utf8"), before, "revert must restore byte-exact original");
  cleanup();
});

test("box-child-memo: an upstream edit anywhere inside render() refuses rather than half-patching", () => {
  // The whole method is the match target precisely so this happens.
  const target = fixture(fresh(), originalBlock, originalWidthCache, true,
    originalBoxRender.replace("// Top padding", "// Top padding (upstream reworded this)"));
  const box = join(dir, "components", "box.js");
  const before = readFileSync(box, "utf8");
  assert.equal(run(["--check"], target).code, 2, "must report unknown, not unpatched");
  assert.equal(run([], target).code, 2, "must refuse to apply");
  assert.equal(readFileSync(box, "utf8"), before, "a refused apply must not touch the file");
  cleanup();
});

test("box-child-memo: patched Box is byte-identical to upstream across 60k randomised frames", async () => {
  const origDir = boxDir(false);
  const newDir = boxDir(true);
  const { Box: OrigBox } = await import(join(origDir, "components", "box.js"));
  const { Box: NewBox } = await import(join(newDir, "components", "box.js"));
  const { FakeText, FreshEveryTime } = await import(join(newDir, "children.mjs"));

  // Deterministic PRNG so any failure reproduces exactly.
  let seed = 12345;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const bgFns = [undefined, (t) => `<${t}>`];
  let frames = 0;

  for (let trial = 0; trial < 400; trial++) {
    const padX = rnd(3), padY = rnd(2), bg = bgFns[rnd(2)];
    const o = new OrigBox(padX, padY, bg), n = new NewBox(padX, padY, bg);
    const oc = [], nc = [];
    for (let i = 0; i < 1 + rnd(4); i++) {
      const fresh_ = rnd(2) === 0;
      const txt = `child${i}-${rnd(1000)}`;
      const a = fresh_ ? new FreshEveryTime(txt) : new FakeText(txt);
      const b = fresh_ ? new FreshEveryTime(txt) : new FakeText(txt);
      oc.push(a); nc.push(b); o.addChild(a); n.addChild(b);
    }
    // >60 frames per trial so the revalidation window is crossed repeatedly.
    for (let f = 0; f < 150; f++) {
      const width = 20 + rnd(3) * 10;
      frames++;
      assert.deepEqual(n.render(width), o.render(width),
        `divergence at trial ${trial} frame ${f} (padX=${padX} padY=${padY})`);
      const roll = rnd(100);
      if (roll < 10) {
        const i = rnd(oc.length);
        if (oc[i] instanceof FakeText) { oc[i].setText(`upd${f}`); nc[i].setText(`upd${f}`); }
      } else if (roll < 13) {
        const t = `new${f}`;
        const a = new FakeText(t), b = new FakeText(t);
        oc.push(a); nc.push(b); o.addChild(a); n.addChild(b);
      } else if (roll < 16 && oc.length > 1) {
        const i = rnd(oc.length);
        o.removeChild(oc[i]); n.removeChild(nc[i]); oc.splice(i, 1); nc.splice(i, 1);
      } else if (roll < 17) { o.invalidate(); n.invalidate(); }
    }
  }
  assert.equal(frames, 60000);
  rmSync(origDir, { recursive: true, force: true });
  rmSync(newDir, { recursive: true, force: true });
});

// THE ADVERSARIAL STALENESS CASE.
//
// A Box whose only child keeps the same array object and mutates it in place,
// with nothing else in the box ever changing — so no sibling churn can break
// the reference match by accident. This is the exact scenario the reference
// fast path gets wrong, and it is why the patch carries a revalidation
// counter rather than trusting reference identity forever.
//
// Proven to be load-bearing: with `hits < 60` removed from the patch, the box
// below never picks up the mutation at all (verified: stale for 500 frames,
// i.e. forever), and this test fails.
test("box-child-memo ADVERSARIAL: in-place child mutation cannot pin stale text forever", async () => {
  const d = boxDir(true);
  const { Box } = await import(join(d, "components", "box.js"));
  const { InPlaceMutator } = await import(join(d, "children.mjs"));

  const child = new InPlaceMutator("ORIGINAL");
  const box = new Box(0, 0);
  box.addChild(child);
  assert.match(box.render(40).join(""), /ORIGINAL/, "sanity: first frame renders the original text");

  child.lines[0] = "MUTATED"; // same array object, contents changed underneath

  let firstCorrect = -1;
  for (let f = 0; f < 500; f++) {
    if (box.render(40).join("").includes("MUTATED")) { firstCorrect = f; break; }
  }
  assert.notEqual(firstCorrect, -1,
    "STALE FOREVER: the reference fast path never revalidated, so the user would see wrong text indefinitely");
  assert.ok(firstCorrect <= 60,
    `staleness must be bounded by the revalidation window, took ${firstCorrect} frames`);
  rmSync(d, { recursive: true, force: true });
});

test("box-child-memo: a non-caching child defeats the fast path (no false freeze)", async () => {
  const d = boxDir(true);
  const { Box } = await import(join(d, "components", "box.js"));
  const { FreshEveryTime } = await import(join(d, "children.mjs"));
  const child = new FreshEveryTime("A");
  const box = new Box(0, 0);
  box.addChild(child);
  assert.match(box.render(40).join(""), /A/);
  // A component that returns a fresh array must be re-read every frame.
  child.text = "B";
  assert.match(box.render(40).join(""), /B/, "a fresh-array child must never be served from the reference cache");
  rmSync(d, { recursive: true, force: true });
});

test("box-child-memo: structural changes are picked up immediately, not after the window", async () => {
  const d = boxDir(true);
  const { Box } = await import(join(d, "components", "box.js"));
  const { FakeText } = await import(join(d, "children.mjs"));
  const box = new Box(0, 0);
  const a = new FakeText("AAA");
  box.addChild(a);
  // Warm the fast path well past a few hits.
  for (let i = 0; i < 30; i++) box.render(40);
  box.addChild(new FakeText("BBB"));
  assert.match(box.render(40).join(""), /BBB/, "addChild must invalidate immediately");
  box.removeChild(a);
  assert.doesNotMatch(box.render(40).join(""), /AAA/, "removeChild must invalidate immediately");
  // A width change must re-render even though child refs are unchanged.
  const wide = box.render(80);
  assert.notDeepEqual(box.render(40), wide, "a width change must not be served from cache");
  rmSync(d, { recursive: true, force: true });
});
