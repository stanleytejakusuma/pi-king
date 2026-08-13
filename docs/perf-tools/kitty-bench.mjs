const KITTY = "\x1b_G";
function parseKittyImageHeader(line) {
  const s = line.indexOf(KITTY);
  if (s === -1) return undefined;
  return { ids: [], rows: 1 };
}
// realistic rendered lines: heavy truecolor styling, ~200 visible chars
const PINK = "\x1b[38;2;255;152;165m", R = "\x1b[39m";
const words = "the quick brown fox jumps over the lazy dog".split(" ");
const lines = [];
for (let i = 0; i < 60000; i++) {
  let l = "";
  for (let j = 0; j < 12; j++) for (const w of words) l += `${PINK}${w}${R} `;
  lines.push(l);
}
console.log(`lines=${lines.length}, avg len=${Math.round(lines[0].length)}`);

// CURRENT: scan every line every render
let t0 = process.hrtime.bigint();
for (let r = 0; r < 5; r++) { const s = new Set(); for (const l of lines) parseKittyImageHeader(l); }
let t1 = process.hrtime.bigint();
const cur = Number(t1-t0)/1e6/5;

// PATCHED: reference-equality cache -- unchanged lines skip the scan entirely
let prevLines = null, prevIds = null;
function collectCached(ls) {
  const out = new Array(ls.length);
  for (let i = 0; i < ls.length; i++) {
    if (prevLines && prevLines[i] === ls[i]) { out[i] = prevIds[i]; continue; }
    out[i] = parseKittyImageHeader(ls[i]);
  }
  prevLines = ls.slice(); prevIds = out;
}
collectCached(lines); // prime
t0 = process.hrtime.bigint();
for (let r = 0; r < 5; r++) collectCached(lines);
t1 = process.hrtime.bigint();
const pat = Number(t1-t0)/1e6/5;

console.log(`current (scan all):      ${cur.toFixed(1)} ms/render`);
console.log(`patched (ref-eq cache):  ${pat.toFixed(2)} ms/render`);
console.log(`speedup: ${(cur/pat).toFixed(0)}x   saved: ${(cur-pat).toFixed(1)} ms per render`);
