#!/usr/bin/env node
// pi-king patch-acp — the auto-heal half of ACP's compaction-gate fix.
//
// billion-context-pi's session_before_compact hook ships as an unconditional
// `() => ({ cancel: true })` — the literal cause of the 2026-08-10 incident
// (a session grew past 1M tokens because ACP's own context-nudge is
// advisory-only, and this hook vetoed the only real fallback with zero
// conditions). The fix (three escape hatches: never cancel a manual/
// overflow/willRetry compaction, never cancel below a 330k-token model, only
// cancel a large model's AUTO compaction below 75% usage) has now been
// silently wiped TWICE in one evening (2026-08-11) by mechanisms never fully
// root-caused — ACP's own log had zero entries either time, and
// ACP_AUTO_UPDATE=0 was already set as an env killswitch before the second
// wipe happened anyway. Stanley explicitly chose keeping npm-managed updates
// over forking the package immune (a fork can't receive `pi update
// --extensions`, see ~/.pi/agent/PATCHES.md) — so this tool exists to close
// the wipe-to-reapplied gap to the daemon's ~60s poll instead of however
// long until someone notices a session stuck mid-compaction with the old
// behavior.
//
// Same idempotent apply/check/revert contract as patch-pi-tui.mjs: content-
// based status only (never trusts an install-time record — an npm reinstall
// can silently replace the file without this tool's own record knowing),
// exact-count safety check before touching anything (if the stock source
// appears more than once, or not at all, this refuses rather than guessing
// which occurrence is the real hook — same failure shape patch-pi-tui.mjs
// found and fixed 2026-08-10), byte-exact `.orig`-backup revert.
//
// Usage:
//   pi-king patch-acp           apply (idempotent)
//   pi-king patch-acp --check   exit 0 patched / 1 unpatched / 2 unknown-version
//   pi-king patch-acp --revert  restore from the .orig backup

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const RECORD_FILE = join(homedir(), ".pi", "king", "acp-patch.json");

// Same marker string src/fleet.ts's isAcpCompactionGatePatched() checks for
// (duplicated, not imported, for the same reason as patch-pi-tui.mjs: this
// must detect the patch is gone even if something about billion-context-pi
// itself is broken). Keep these two in sync by hand if either changes.
const MARKER = "SAFETY_CEILING_PCT";

const ORIGINAL = `function wireCompactionDisable(pi) {
  pi.on("session_before_compact", () => ({ cancel: true }));
}`;

const PATCHED = `function wireCompactionDisable(pi) {
  // pi-king-acp-patch:v1 -- SAFETY_CEILING_PCT
  const SAFETY_CEILING_PCT = 75;
  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason === "manual" || event.reason === "overflow" || event.willRetry) return { cancel: false };
    const usage = ctx.getContextUsage ? ctx.getContextUsage() : undefined;
    if (!usage || !usage.contextWindow || usage.contextWindow < 330_000) return { cancel: false };
    if (typeof usage.percent === "number" && usage.percent < SAFETY_CEILING_PCT) return { cancel: false };
    return { cancel: true };
  });
}`;

// Path is fixed, not resolved via `which pi` like pi-tui: ACP is installed
// into pi's own agent npm dir, not hoisted alongside the pi binary. Override
// for sandbox testing, same pattern as PI_KING_PI_TUI_TARGET.
function acpTarget() {
  const forced = process.env.PI_KING_ACP_TARGET?.trim();
  if (forced) return forced;
  return join(homedir(), ".pi", "agent", "npm", "node_modules", "billion-context-pi", "dist", "index.js");
}

/** Content-based status. Never trusts RECORD_FILE. */
function statusOf(target) {
  let src;
  try {
    src = readFileSync(target, "utf8");
  } catch {
    return "missing";
  }
  if (src.includes(MARKER)) return "patched";
  const hits = src.split(ORIGINAL).length - 1;
  if (hits === 1) return "unpatched";
  return "unknown"; // 0 (billion-context-pi changed the block) or 2+ (ambiguous) -- needs human re-review
}

function writeRecord(target, extra) {
  try {
    writeFileSync(RECORD_FILE, JSON.stringify({ target, patchedAt: new Date().toISOString(), ...extra }, null, 1));
  } catch {
    // best-effort audit trail only; statusOf() never depends on this file
  }
}

function apply() {
  const target = acpTarget();
  const st = statusOf(target);
  if (st === "patched") {
    console.log(`Already patched: ${target}`);
    return 0;
  }
  if (st !== "unpatched") {
    console.error(
      `Refusing to patch ${target}: source does not match what this tool expects (status: ${st}).\n` +
      `billion-context-pi likely changed since this patch was written. Re-verify wireCompactionDisable() by ` +
      `hand against ~/.pi/agent/PATCHES.md before updating ORIGINAL/PATCHED in this file.`,
    );
    return 2;
  }
  const src = readFileSync(target, "utf8");
  const backup = `${target}.orig`;
  if (!existsSync(backup)) writeFileSync(backup, src);
  writeFileSync(target, src.replace(ORIGINAL, PATCHED));
  console.log(`Patched: ${target}\nBackup:  ${backup}`);
  writeRecord(target, { marker: MARKER });
  console.log("Already-running sessions keep the old unconditional-cancel code until they restart — this only reaches a session on its next start.");
  return 0;
}

function revert() {
  const target = acpTarget();
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
  const target = acpTarget();
  const st = statusOf(target);
  console.log(`${target}: ${st}`);
  if (st === "unknown" || st === "missing") return 2;
  if (st === "patched") return 0;
  return 1;
}

const mode = process.argv[2];
// Bare `pi-king patch-acp` means apply -- documented call. An UNRECOGNISED
// arg must never fall through to apply (same lesson patch-pi-tui.mjs
// learned 2026-08-13: typing the wrong flag silently patched a live install).
if (mode !== undefined && !["--check", "--revert", "--apply"].includes(mode)) {
  console.error(`unknown argument: ${mode}\nusage: patch-acp.mjs [--apply|--check|--revert]  (no argument = --apply)`);
  process.exit(2);
}
try {
  const code = mode === "--check" ? check() : mode === "--revert" ? revert() : apply();
  process.exit(code);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
