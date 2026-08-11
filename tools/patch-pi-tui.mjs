#!/usr/bin/env node
// pi-king patch-tui — Fixes 2 and 5 of docs/PERF-TMUX-SPEC.md.
//
// TWO independent vendored patches to pi-tui's installed dist, applied and
// reverted together. Both target real, measured event-loop stalls on large
// sessions; they hit DIFFERENT bottlenecks and neither substitutes for the
// other:
//
// [render-cap] (Fix 2, 2026-08-10) — the WRITE cost.
//   pi-tui's fullRender() (packages/tui/src/tui-main-screen.ts upstream,
//   installed as .../pi-tui/dist/tui-main-screen.js) rewrites the ENTIRE
//   rendered transcript through the terminal on every boot, resize, and
//   differential-render bailout. Measured on a real 40MB session: 67,555
//   lines / 10.9MB per full render, and because Node's tty writes are
//   blocking, that freezes pi's event loop for ~350-550ms under tmux (which
//   drains bursts ~6.5x slower than a fast pty) — every occurrence, every
//   time. This patches the write loop to only draw the last N lines when
//   PI_TUI_MAX_FULL_RENDER_LINES is set; unset, output is byte-identical to
//   upstream. Full trace of why this is safe (cursorRow/hardwareCursorRow
//   bookkeeping stays correct because it's a raw newLines.length-1
//   assignment, not derived from how many lines were actually written; the
//   cursor marker is always within the last `height` lines per
//   extractCursorPosition, always inside the cap for any cap >= height) is
//   in docs/PERF-TMUX-SPEC.md Fix 2 and this file's marker comment.
//
// [width-cache] (Fix 5, 2026-08-11) — the BUILD cost, a strictly bigger win.
//   utils.js's visibleWidth() memoizes grapheme-aware string widths in a
//   Map bounded by WIDTH_CACHE_SIZE = 512 with FIFO eviction. It fast-paths
//   pure-ASCII strings, but every REAL rendered line carries ANSI colour
//   escapes (measured on the live pane: 100% of 38 visible lines), so none
//   take that fast path and the working set is the whole document. A 512
//   entry FIFO against a 12,269-line document is 24x over capacity, and
//   under a sequential full-document scan that collapses the hit rate to
//   ~0%: every entry is evicted just before it is needed again. Every line
//   then re-runs Intl.Segmenter, which clones an ICU RuleBasedBreakIterator
//   per call. This is a CLIFF, not a slope — under capacity is ~100% hits,
//   one entry over is ~0% — which is why one session lags while a smaller
//   one is perfectly smooth.
//
//   Measured on the real dist with 12,269 real ANSI-styled transcript lines:
//     512   (shipped): 666.0 ms per full-document pass
//     65536 (patched):   2.3 ms per full-document pass   (290x)
//   Correctness: 12,269 lines x {visibleWidth, truncateToWidth}, 0 mismatches
//   (pure memoisation of a pure function — a bigger cache cannot change a
//   result, only how often one is recomputed). Cost: ~0.6MB heap.
//   Live `sample`(1) profile that found it: 69% of main thread in the render
//   timer, 33% in ICU, 26% GC, and 0% in pty writes — i.e. the render-cap
//   patch above does not address this at all.
//
//   KNOWN CEILING: 65536 is flat, not adaptive, and the same cliff returns
//   near ~65k distinct rendered lines (~8x today's headroom). LRU would NOT
//   help — a sequential full-document scan is LRU's pathological case too;
//   only capacity > working set matters. The real fix is upstream: layout
//   should not be recomputed for every line of an unchanged document on
//   every tick. This patch buys headroom, it does not fix the architecture.
//
// These are vendored patches to code pi-king does not own. They WILL be
// wiped out by any `pi` reinstall/upgrade — see --check and the daemon/
// dashboard warning wiring, which detect that by scanning file CONTENT,
// never by trusting the record this tool writes.
//
// Usage:
//   pi-king patch-tui           apply (idempotent)
//   pi-king patch-tui --check   exit 0 patched / 1 unpatched / 2 unknown-version
//   pi-king patch-tui --revert  restore from the .orig backups

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const RECORD_FILE = join(homedir(), ".pi", "king", "tui-patch.json");

/** Every patch site, applied and reverted as one unit. `original` is the
 * exact upstream source verified byte-for-byte against pi 0.84.1's installed
 * dist; if an upgrade changes it at all, the string stops matching and the
 * tool refuses rather than guessing — a human re-verifies the site first.
 * Each carries its own marker so a partially-applied state (one patch
 * surviving an upgrade that clobbered the other) is detected, not averaged.
 *
 * The marker must live INSIDE the replacement text: status() is content-
 * based, so a patch whose marker is only in a record file is invisible. */
const PATCHES = [
  {
    name: "render-cap",
    file: "tui-main-screen.js",
    marker: "pi-king-tui-patch:v1",
    original: `            for (let i = 0; i < newLines.length; i++) {
                if (i > 0)
                    buffer += "\\r\\n";`,
    patched: `            const __piKingRenderCap = Number(process.env.PI_TUI_MAX_FULL_RENDER_LINES || 0); // pi-king-tui-patch:v1
            const __piKingRenderStart = __piKingRenderCap > 0 && newLines.length > __piKingRenderCap ? newLines.length - __piKingRenderCap : 0;
            for (let i = __piKingRenderStart; i < newLines.length; i++) {
                if (i > __piKingRenderStart)
                    buffer += "\\r\\n";`,
  },
  {
    name: "width-cache",
    file: "utils.js",
    marker: "pi-king-tui-patch:widthcache-v1",
    original: `const WIDTH_CACHE_SIZE = 512;`,
    // Unconditional, unlike render-cap's env gate: this is pure memoisation
    // of a pure function, so there is no behaviour to opt into and nothing
    // to differ from upstream except how often a width is recomputed. An env
    // knob here would only add a way to leave the bug switched on.
    patched: `const WIDTH_CACHE_SIZE = 65536; // pi-king-tui-patch:widthcache-v1 — 512 thrashed to ~0% hits on a 12k-line doc (666ms -> 2.3ms/pass); cliff returns near ~65k lines`,
  },
];

/** Test/CI escape hatch: an explicit path to pi-tui's dist directory,
 * bypassing `which` entirely.
 * 2026-08-10 incident: a sandboxed test run intended to target a scratch
 * copy under /tmp instead silently fell through to the REAL installed
 * pi-tui and patched it (caught immediately, reverted byte-exact from the
 * .orig backup this tool itself makes — see docs/PERF-TMUX-SPEC.md's
 * changelog). Root mechanism confirmed: `which` silently skips a PATH
 * entry whose target isn't executable and falls through to the next
 * match — PATH-shadowing is fundamentally the wrong tool for isolating a
 * program whose entire job is "find things via which". This override
 * makes that class of mistake structurally impossible: any future sandbox
 * test sets PI_KING_PI_TUI_TARGET instead of fighting PATH, so there is no
 * `which` call in the loop to silently miss.
 *
 * Accepts either the dist DIRECTORY or (for backwards compatibility with
 * the single-target era) a path to a file inside it. */
function findPiTuiDist() {
  const forced = process.env.PI_KING_PI_TUI_TARGET?.trim();
  if (forced) return forced.endsWith(".js") ? dirname(forced) : forced;
  let piBin;
  try {
    piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("`pi` not found on PATH — is it installed?");
  }
  if (!piBin) throw new Error("`pi` not found on PATH — is it installed?");
  let dir = dirname(realpathSync(piBin));
  const root = dirname(dir).split("/")[0] || "/";
  while (dir !== root && dir !== "/" && dir !== ".") {
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-tui", "dist");
    if (existsSync(join(candidate, "tui-main-screen.js"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`Could not find pi-tui's dist under any node_modules above ${piBin} (realpath ${realpathSync(piBin)}).`);
}

function versions(dist) {
  let piVersion;
  try {
    piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    piVersion = undefined;
  }
  let piTuiVersion;
  try {
    piTuiVersion = JSON.parse(readFileSync(join(dirname(dist), "package.json"), "utf8")).version;
  } catch {
    piTuiVersion = undefined;
  }
  return { piVersion, piTuiVersion };
}

/** Content-based status for ONE patch site. Never trusts RECORD_FILE — a pi
 * upgrade can silently replace a patched file without touching that record,
 * so every caller (this CLI, the daemon, the dashboard) must re-derive
 * status from what is actually on disk right now. */
function statusOf(dist, patch) {
  const target = join(dist, patch.file);
  let src;
  try {
    src = readFileSync(target, "utf8");
  } catch {
    return "missing";
  }
  if (src.includes(patch.marker)) return "patched";
  // Exact-count, not just presence: `apply()` uses String.replace(original,
  // ...), which only touches the FIRST match. A future pi-tui version that
  // happens to contain a second, unrelated block with this exact text would
  // let replace() silently patch the wrong site while still reporting
  // success -- the worst failure shape this tool has (found in review,
  // 2026-08-10). Verified today's real dist has exactly one occurrence of
  // each; treat anything other than exactly one as "needs a human".
  const hits = src.split(patch.original).length - 1;
  if (hits === 1) return "unpatched";
  return "unknown"; // 0 (pi changed the block) or 2+ (ambiguous) -- needs human re-review
}

function writeRecord(dist, extra) {
  try {
    writeFileSync(RECORD_FILE, JSON.stringify({ dist, patchedAt: new Date().toISOString(), ...versions(dist), ...extra }, null, 1));
  } catch {
    // best-effort audit trail only; statusOf() never depends on this file
  }
}

function apply() {
  const dist = findPiTuiDist();
  const states = PATCHES.map((p) => ({ patch: p, st: statusOf(dist, p) }));
  // Refuse the whole run if ANY site is unrecognised, before writing
  // anything: a half-applied pair is worse than an unapplied one, because
  // the daemon's warning would clear while a real regression stayed live.
  const bad = states.filter((s) => s.st !== "patched" && s.st !== "unpatched");
  if (bad.length > 0) {
    console.error(
      `Refusing to patch ${dist}: source at ${bad.map((b) => `${b.patch.file} [${b.patch.name}]`).join(", ")} does not match what this tool expects ` +
      `(status: ${bad.map((b) => b.st).join(", ")}).\n` +
      `pi-tui likely changed since these patches were written (${JSON.stringify(versions(dist))}). ` +
      `Re-verify the patch sites by hand against docs/PERF-TMUX-SPEC.md before updating PATCHES in this file.`,
    );
    return 2;
  }
  const applied = [];
  for (const { patch, st } of states) {
    const target = join(dist, patch.file);
    if (st === "patched") {
      console.log(`Already patched: ${target} [${patch.name}]`);
      continue;
    }
    const src = readFileSync(target, "utf8");
    writeFileSync(`${target}.orig`, src);
    writeFileSync(target, src.replace(patch.original, patch.patched));
    applied.push(patch.name);
    console.log(`Patched: ${target} [${patch.name}]\nBackup:  ${target}.orig`);
  }
  writeRecord(dist, { signatures: PATCHES.map((p) => p.marker) });
  if (applied.includes("render-cap")) {
    console.log("Set PI_TUI_MAX_FULL_RENDER_LINES=<n> on a tmux-spawned session to cap full renders (pi-king does this automatically via tmuxLaunchEnv()).");
  }
  if (applied.length > 0) {
    console.log("Already-running sessions keep the old code until they restart — this only reaches a session on its next start.");
  }
  return 0;
}

function revert() {
  const dist = findPiTuiDist();
  let reverted = 0;
  for (const patch of PATCHES) {
    const target = join(dist, patch.file);
    const backup = `${target}.orig`;
    if (!existsSync(backup)) {
      console.error(`No backup at ${backup} — nothing to revert for [${patch.name}] (or it was never patched by this tool).`);
      continue;
    }
    writeFileSync(target, readFileSync(backup, "utf8"));
    console.log(`Reverted: ${target} restored from ${backup} [${patch.name}]`);
    reverted++;
  }
  return reverted > 0 ? 0 : 2;
}

function check() {
  const dist = findPiTuiDist();
  const states = PATCHES.map((p) => ({ patch: p, st: statusOf(dist, p) }));
  for (const { patch, st } of states) {
    console.log(`${join(dist, patch.file)} [${patch.name}]: ${st}`);
  }
  // Worst-status-wins: "patched" only when every site is patched, so a
  // partial state can never report healthy.
  if (states.some((s) => s.st === "unknown")) return 2;
  if (states.every((s) => s.st === "patched")) return 0;
  return 1;
}

const mode = process.argv[2];
try {
  const code = mode === "--check" ? check() : mode === "--revert" ? revert() : apply();
  process.exit(code);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
