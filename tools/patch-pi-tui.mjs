#!/usr/bin/env node
// pi-king patch-tui — Fix 2 of docs/PERF-TMUX-SPEC.md.
//
// pi-tui's fullRender() (packages/tui/src/tui-main-screen.ts upstream,
// installed as .../pi-tui/dist/tui-main-screen.js) rewrites the ENTIRE
// rendered transcript through the terminal on every boot, resize, and
// differential-render bailout. Measured on a real 40MB session: 67,555
// lines / 10.9MB per full render, and because Node's tty writes are
// blocking, that freezes pi's event loop for ~350-550ms under tmux (which
// drains bursts ~6.5x slower than a fast pty) — every occurrence, every
// time. This patches the write loop to only draw the last N lines when
// PI_TUI_MAX_FULL_RENDER_LINES is set; unset, output is byte-identical to
// upstream. Full trace of why this is safe (cursorRow/hardwareCursorRow
// bookkeeping stays correct because it's a raw newLines.length-1
// assignment, not derived from how many lines were actually written; the
// cursor marker is always within the last `height` lines per
// extractCursorPosition, always inside the cap for any cap >= height) is
// in docs/PERF-TMUX-SPEC.md Fix 2 and this file's PATCH_MARKER comment.
//
// This is a vendored patch to code pi-king does not own. It WILL be wiped
// out by any `pi` reinstall/upgrade — see --check and the daemon/dashboard
// warning wiring, which detect that by scanning file CONTENT, never by
// trusting the record this tool writes.
//
// Usage:
//   pi-king patch-tui           apply (idempotent)
//   pi-king patch-tui --check   exit 0 patched / 1 unpatched / 2 unknown-version
//   pi-king patch-tui --revert  restore from the .orig backup

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PATCH_MARKER = "pi-king-tui-patch:v1";
const RECORD_FILE = join(homedir(), ".pi", "king", "tui-patch.json");

// The exact original source this patch targets. Verified byte-for-byte
// (python repr dump) against pi 0.84.1's installed dist, 2026-08-10. If a pi
// upgrade changes this block at all, this string stops matching and the
// tool refuses rather than guessing — a human needs to re-verify the patch
// site against the new source before it's safe to reapply.
const ORIGINAL = `            for (let i = 0; i < newLines.length; i++) {
                if (i > 0)
                    buffer += "\\r\\n";`;

const PATCHED = `            const __piKingRenderCap = Number(process.env.PI_TUI_MAX_FULL_RENDER_LINES || 0); // ${PATCH_MARKER}
            const __piKingRenderStart = __piKingRenderCap > 0 && newLines.length > __piKingRenderCap ? newLines.length - __piKingRenderCap : 0;
            for (let i = __piKingRenderStart; i < newLines.length; i++) {
                if (i > __piKingRenderStart)
                    buffer += "\\r\\n";`;

/** Test/CI escape hatch: an explicit path, bypassing `which` entirely.
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
 * `which` call in the loop to silently miss. */
function findPiTuiFile() {
  const forced = process.env.PI_KING_PI_TUI_TARGET?.trim();
  if (forced) return forced;
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
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-tui", "dist", "tui-main-screen.js");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`Could not find pi-tui's dist under any node_modules above ${piBin} (realpath ${realpathSync(piBin)}).`);
}

function versions(target) {
  let piVersion;
  try {
    piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    piVersion = undefined;
  }
  let piTuiVersion;
  try {
    const pkg = join(dirname(dirname(target)), "package.json");
    piTuiVersion = JSON.parse(readFileSync(pkg, "utf8")).version;
  } catch {
    piTuiVersion = undefined;
  }
  return { piVersion, piTuiVersion };
}

/** Content-based status. Never trusts RECORD_FILE alone — a pi upgrade can
 * silently replace the patched file without touching that record, so every
 * caller (this CLI, the daemon, the dashboard) must re-derive status from
 * what is actually on disk right now. */
function status(target) {
  let src;
  try {
    src = readFileSync(target, "utf8");
  } catch {
    return "missing";
  }
  if (src.includes(PATCH_MARKER)) return "patched";
  // Exact-count, not just presence: `apply()` uses String.replace(ORIGINAL,
  // ...), which only touches the FIRST match. A future pi-tui version that
  // happens to contain a second, unrelated loop with this exact text would
  // let replace() silently patch the wrong site while still reporting
  // success -- the worst failure shape this tool has (found in review,
  // 2026-08-10). Verified today's real dist has exactly one occurrence;
  // treat anything other than exactly one as "needs a human", never guess.
  const hits = src.split(ORIGINAL).length - 1;
  if (hits === 1) return "unpatched";
  return "unknown"; // 0 (pi changed the block) or 2+ (ambiguous) -- needs human re-review
}

function writeRecord(target, extra) {
  try {
    writeFileSync(RECORD_FILE, JSON.stringify({ target, patchedAt: new Date().toISOString(), ...versions(target), ...extra }, null, 1));
  } catch {
    // best-effort audit trail only; status() never depends on this file
  }
}

function apply() {
  const target = findPiTuiFile();
  const st = status(target);
  if (st === "patched") {
    console.log(`Already patched: ${target}`);
    return 0;
  }
  if (st !== "unpatched") {
    console.error(
      `Refusing to patch ${target}: its source at the patch site does not match what this tool expects (status: ${st}).\n` +
      `pi-tui likely changed since this patch was written (${JSON.stringify(versions(target))}). ` +
      `Re-verify the patch site by hand against docs/PERF-TMUX-SPEC.md Fix 2 before updating ORIGINAL/PATCHED in this file.`,
    );
    return 2;
  }
  const src = readFileSync(target, "utf8");
  writeFileSync(`${target}.orig`, src);
  writeFileSync(target, src.replace(ORIGINAL, PATCHED));
  writeRecord(target, { signature: PATCH_MARKER });
  console.log(`Patched: ${target}\nBackup:  ${target}.orig\nSet PI_TUI_MAX_FULL_RENDER_LINES=<n> on a tmux-spawned session to cap full renders (pi-king does this automatically via tmuxLaunchEnv()).`);
  return 0;
}

function revert() {
  const target = findPiTuiFile();
  const backup = `${target}.orig`;
  if (!existsSync(backup)) {
    console.error(`No backup at ${backup} — nothing to revert (or it was never patched by this tool).`);
    return 2;
  }
  writeFileSync(target, readFileSync(backup, "utf8"));
  console.log(`Reverted: ${target} restored from ${backup}`);
  return 0;
}

function check() {
  const target = findPiTuiFile();
  const st = status(target);
  console.log(`${target}: ${st}`);
  if (st === "patched") return 0;
  if (st === "unpatched" || st === "missing") return 1;
  return 2; // unknown — source changed underneath the patch
}

const mode = process.argv[2];
try {
  const code = mode === "--check" ? check() : mode === "--revert" ? revert() : apply();
  process.exit(code);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
