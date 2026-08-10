#!/usr/bin/env node
// Verifies every symbol one project file imports from another (via a
// `./x.ts` relative import) is actually exported there.
//
// This exists because 0.1.1 shipped with `class StatsCache` instead of
// `export class StatsCache`: a search-and-replace matched the substring inside
// `export class ...` and moved the keyword onto an adjacent declaration. The
// extension still loaded, the session tracker still worked, and the failure
// only appeared when someone opened the dashboard — which is the one path a
// non-interactive test never exercises. Wired to prepublishOnly so a broken
// build cannot reach the registry again.
//
// Extended 2026-08-10 (index.ts -> jobs.ts, index.ts -> fleet.ts, fleet.ts ->
// jobs.ts) after the fleet.ts extraction moved ~20 exports across a file
// boundary in one pass — exactly the shape of change that caused the
// original bug, just with a much bigger import list this time.
import { readFileSync } from "node:fs";

const PAIRS = [
  { from: "index.ts", to: "data.ts" },
  { from: "index.ts", to: "jobs.ts" },
  { from: "index.ts", to: "fleet.ts" },
  { from: "fleet.ts", to: "jobs.ts" },
];

let failed = false;
let totalChecked = 0;
for (const { from, to } of PAIRS) {
  const fromSrc = readFileSync(new URL(`../src/${from}`, import.meta.url), "utf8");
  const toSrc = readFileSync(new URL(`../src/${to}`, import.meta.url), "utf8");

  const target = to.replace(/\.ts$/, "");
  const m = fromSrc.match(new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*"\\./${target}\\.ts"`, "s"));
  if (!m) {
    // Every pair above is known to import today; a missing match means the
    // regex broke, not that the import went away on its own — fail loudly
    // rather than silently stop checking a pair.
    console.error(`check-exports: expected src/${from} to import from ./${target}.ts, found no such import`);
    failed = true;
    continue;
  }

  const imported = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  totalChecked += imported.length;

  const exported = new Set(
    [...toSrc.matchAll(/^export\s+(?:declare\s+)?(?:const|let|function|class|type|interface|async function)\s+(\w+)/gm)]
      .map((x) => x[1]),
  );

  const missing = imported.filter((n) => !exported.has(n));
  if (missing.length) {
    console.error(`check-exports: src/${from} imports from ./${target}.ts but it does not export: ${missing.join(", ")}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`check-exports: ${totalChecked} imports across ${PAIRS.length} file pairs all resolve`);
