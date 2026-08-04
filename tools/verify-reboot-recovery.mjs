import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Fully sandboxed: never touches the real fleet at ~/.pi/king/session-status.
// A frozen boot time is not available (there is exactly one real boot per
// machine), so every fixture below is computed relative to the REAL
// sysctl kern.boottime at run time, same as the production code does.
const STATUS_DIR = "/tmp/pi-king-verify-reboot/session-status";
rmSync("/tmp/pi-king-verify-reboot", { recursive: true, force: true });
mkdirSync(STATUS_DIR, { recursive: true });
process.env.PI_KING_STATUS_DIR = STATUS_DIR;

let bad = 0;
const chk = (name, ok, detail = "") => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };

if (spawnSync("which", ["tmux"]).status !== 0) {
  console.log("  SKIP  reboot recovery: tmux not on PATH");
  process.exit(0);
}
const bootProbe = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
const bootMatch = bootProbe.status === 0 ? /sec\s*=\s*(\d+)/.exec(bootProbe.stdout || "") : null;
if (!bootMatch) {
  console.log("  SKIP  reboot recovery: kern.boottime unavailable (non-macOS)");
  process.exit(0);
}
const boot = Number(bootMatch[1]);

const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = await jiti.import("/Users/stanz/codebase/pi-king/src/index.ts");

function seed(id, secBeforeBoot) {
  const card = {
    formatVersion: 1, id, name: id, cwd: "/tmp", project: "verify",
    model: undefined, pid: 999999, startedAt: 0,
    lastActivity: (boot - secBeforeBoot) * 1000,
    status: "exited", activity: "Session ended.", title: "",
    sessionFile: undefined, subagents: [], visible: true,
  };
  writeFileSync(join(STATUS_DIR, `${id}.json`), JSON.stringify(card));
}

// Real observed reboot signature (see restoreRebootOrphans): a plain Restart
// leaves every session exited ~33s before the new boot. In-window.
seed("dddd-verify-fresh", 33);
// Edge of the 600s window: still eligible.
seed("dddd-verify-edge-in", 599);
// Just past the edge: must be excluded.
seed("dddd-verify-edge-out", 601);
// Exited days before this boot, unrelated to it: must be excluded regardless
// of how far in the past — this is the case a naive "updatedAt < bootTime"
// check gets wrong.
seed("dddd-verify-old", 3 * 24 * 3600);
// Exited AFTER boot (negative distance): the user quit it themselves once the
// machine was already back up. Must be excluded.
seed("dddd-verify-post-boot", -120);

const r1 = mod.restoreRebootOrphans();
chk("first run restores exactly the two in-window cards", r1.restored === 2 && r1.failed === 0, JSON.stringify(r1));

const names = (spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).stdout || "");
chk("in-window card got a real tmux session", names.includes("dddd-verify-fresh"));
chk("edge-in card (599s) got a real tmux session", names.includes("dddd-verify-edge-in"));
chk("edge-out card (601s) did NOT get a session", !names.includes("dddd-verify-edge-out"));
chk("stale old-exit card did NOT get a session", !names.includes("dddd-verify-old"));
chk("post-boot exit card did NOT get a session", !names.includes("dddd-verify-post-boot"));

const r2 = mod.restoreRebootOrphans();
chk("second run in the same boot generation is a no-op (marker dedup)", r2.restored === 0 && r2.failed === 0, JSON.stringify(r2));

for (const s of ["dddd-verify-fresh", "dddd-verify-edge-in"]) spawnSync("tmux", ["kill-session", "-t", s]);
rmSync("/tmp/pi-king-verify-reboot", { recursive: true, force: true });

console.log(`\n  ${bad === 0 ? "All reboot-recovery checks passed." : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
