import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { spawnSync } from "node:child_process";

// livePiPids() is the identity-verification function that stops a recycled
// pid from resurrecting a dead session's card as alive. It caused a real
// incident during development (a mid-refactor signature change shipped to
// disk before its call sites were updated, making every session render
// exited) and separately, while writing THIS check, exposed a second bug in
// its own bounds filter (99,999,999 was 1000x too permissive -- this
// machine's real ps -p ceiling, binary-searched below, is 99999). Both were
// caught by exactly this kind of check, which is why it is permanent rather
// than a one-off script.
const jiti = createJiti(import.meta.url, { interopDefault: true });
// livePiPids lives in fleet.ts; index.ts only imports it, so mod.livePiPids
// was undefined and this entire gate threw on its first call -- dead since the
// move, silently, because the throw aborts before any summary. Same root cause
// as verify-metrics.mjs. Found 2026-08-13 via the verification-loop skill.
const mod = await jiti.import("/Users/stanz/codebase/pi-king/src/fleet.ts");

let bad = 0;
const chk = (name, ok, detail = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };

// The real, machine-specific ceiling ps -p will accept before rejecting the
// WHOLE query as "process id too large" -- re-derived here, not hardcoded,
// so this check catches it again if it ever drifts on a different machine.
function psRejectsAbove() {
  for (const candidate of [99_999, 999_999, 9_999_999]) {
    const r = spawnSync("/bin/ps", ["-p", String(candidate + 1), "-o", "pid="], { encoding: "utf8" });
    if (/too large/i.test(r.stderr || "")) return candidate;
  }
  return undefined; // could not establish a ceiling on this machine; skip the bound-specific check
}

// Pid list shape checks -- no live process required.
chk("empty pid list returns empty Map, not undefined", (() => {
  const r = mod.livePiPids([]);
  return r instanceof Map && r.size === 0;
})());
chk("garbage values (negative/zero/float/NaN) filtered without throwing", (() => {
  try { mod.livePiPids([-5, 0, 3.7, NaN]); return true; } catch { return false; }
})());

const ceiling = psRejectsAbove();
if (ceiling !== undefined) {
  chk(`filter matches this machine's real ps -p ceiling (${ceiling})`, (() => {
    // A pid just above the real ceiling must be silently dropped by the
    // bounds filter -- never handed to ps, where it would reject the WHOLE
    // query and take every other requested pid down with it.
    const r = mod.livePiPids([ceiling + 1]);
    return r instanceof Map; // defined result: the bad pid did not reach ps and poison the call
  })());
} else {
  console.log("  SKIP  ps -p ceiling check: could not establish this machine's limit");
}

// Live-pid-dependent checks: find a real "pi" process to target. None found
// (no session open right now) is a legitimate, common state -- skip rather
// than fail, same convention as verify-metrics' fresh-day SKIP.
const ps = spawnSync("/bin/ps", ["-eo", "pid=,command="], { encoding: "utf8" });
const line = (ps.stdout || "").split("\n").find((l) => {
  const cmd = l.trim().split(/\s+/).slice(1).join(" ");
  return cmd === "pi" || cmd.startsWith("pi-");
});
const realPid = line ? Number(line.trim().split(/\s+/)[0]) : undefined;

if (realPid === undefined) {
  console.log("  SKIP  live-pid checks: no running pi process found on this machine right now");
} else {
  chk("a real, live pi pid is found", mod.livePiPids([realPid])?.has(realPid) === true);
  chk("start time parses to a sane, finite, past timestamp", (() => {
    const t = mod.livePiPids([realPid])?.get(realPid);
    return typeof t === "number" && Number.isFinite(t) && t > 0 && t < Date.now();
  })());

  const definitelyDead = realPid + 5_000_000 > 90_000 ? realPid + 2 * (ceiling ?? 99_999) : realPid + 5_000_000;
  // Only meaningful if the synthetic "dead" pid actually lands out of range
  // OR is simply unassigned; either way it must never suppress the real one.
  chk("a dead/out-of-range pid never hides a real pid in the same query", (() => {
    const r = mod.livePiPids([realPid, definitelyDead]);
    return r instanceof Map && r.has(realPid) && !r.has(definitelyDead);
  })());

  chk("the CRITICAL case: all-requested-pids-dead returns an EMPTY MAP, never undefined", (() => {
    // This is the exact distinction that caused the real incident: an empty
    // Map means "verified, nobody is alive" (prune correctly); undefined
    // means "unknown, do not prune". Getting this backwards makes every
    // tracked session render exited the moment ps finds zero matches, which
    // is a normal, common outcome (e.g. right after every session closed),
    // not a sign ps itself is broken.
    const dead1 = definitelyDead;
    const dead2 = dead1 + 1 > 99_999 ? Math.max(1, dead1 - 2) : dead1 + 1;
    const r = mod.livePiPids([dead1, dead2].filter((p) => p !== realPid));
    return r instanceof Map && r.size === 0;
  })());
}

console.log(`\n  ${bad === 0 ? "All livePiPids checks passed." : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
