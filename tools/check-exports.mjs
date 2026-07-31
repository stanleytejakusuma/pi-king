#!/usr/bin/env node
// Verifies every symbol src/index.ts imports from src/data.ts is actually
// exported there.
//
// This exists because 0.1.1 shipped with `class StatsCache` instead of
// `export class StatsCache`: a search-and-replace matched the substring inside
// `export class ...` and moved the keyword onto an adjacent declaration. The
// extension still loaded, the session tracker still worked, and the failure
// only appeared when someone opened the dashboard — which is the one path a
// non-interactive test never exercises. Wired to prepublishOnly so a broken
// build cannot reach the registry again.
import { readFileSync } from "node:fs";

const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const dat = readFileSync(new URL("../src/data.ts", import.meta.url), "utf8");

const m = idx.match(/import\s*\{([^}]+)\}\s*from\s*"\.\/data\.ts"/s);
if (!m) { console.error("check-exports: no import from ./data.ts found"); process.exit(1); }

const imported = m[1]
  .split(",")
  .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
  .filter(Boolean);

const exported = new Set(
  [...dat.matchAll(/^export\s+(?:declare\s+)?(?:const|let|function|class|type|interface|async function)\s+(\w+)/gm)]
    .map((x) => x[1]),
);

const missing = imported.filter((n) => !exported.has(n));
if (missing.length) {
  console.error(`check-exports: src/data.ts does not export: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`check-exports: ${imported.length} imports all resolve`);
