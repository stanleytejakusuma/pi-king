#!/usr/bin/env node
// Copy a real pi transcript to a scratch path with a FRESH sessionId.
//
// WHY THIS EXISTS: a byte-identical copy makes two pi processes claim one
// sessionId; whichever exits last DELETES the shared status card and the real
// session drops off the pi-king dashboard. That happened live on 2026-08-13.
// The id appears ~57x inside a big transcript, not just in the header.
//
// Usage: node mk-scratch-session.mjs <src.jsonl> <dest.jsonl>
// Prints the new sessionId on stdout.

import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** UUIDv7, same shape pi generates (src/arc.ts newSessionId). */
function newSessionId() {
  const b = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error("usage: mk-scratch-session.mjs <src.jsonl> <dest.jsonl>");
  process.exit(2);
}

const text = readFileSync(src, "utf8");
const header = JSON.parse(text.slice(0, text.indexOf("\n")));
const oldId = header.id;
if (!oldId) throw new Error("no sessionId in header line");

const id = newSessionId();
const out = text.split(oldId).join(id);

// Verify the rewrite actually happened — trust the outcome, not the exit code.
const before = text.split(oldId).length - 1;
const after = out.split(oldId).length - 1;
if (after !== 0) throw new Error(`rewrite incomplete: ${after} occurrences left`);
writeFileSync(dest, out);
console.error(`rewrote ${before} occurrences of ${oldId} -> ${id}`);
console.log(id);
