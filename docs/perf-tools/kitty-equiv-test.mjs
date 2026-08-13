// Equivalence test: patched (ref-eq memoised) collectKittyImageIds MUST return
// the same id set as the original, across image/no-image/changing/reordered
// sequences of renders.
const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const __PK_KITTY_NO_IDS = Object.freeze([]);
function parseKittyImageHeader(line) {
    const s = line.indexOf(KITTY_SEQUENCE_PREFIX);
    if (s === -1) return undefined;
    const paramsStart = s + KITTY_SEQUENCE_PREFIX.length;
    const paramsEnd = line.indexOf(";", paramsStart);
    if (paramsEnd === -1) return undefined;
    const ids = []; let rows = 1;
    for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
        const [k, v] = param.split("=", 2);
        if (v === undefined) continue;
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) continue;
        if (k === "i") ids.push(n); else if (k === "r") rows = n;
    }
    return { ids, rows };
}
const extractKittyImageIds = (l) => parseKittyImageHeader(l)?.ids ?? [];

function original(lines) {
    const ids = new Set();
    for (const line of lines) for (const id of extractKittyImageIds(line)) ids.add(id);
    return ids;
}
class Patched {
    collectKittyImageIds(lines) {
        const ids = new Set();
        const p = this.__pkKittyLines, pi = this.__pkKittyIds;
        const ni = new Array(lines.length);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let lineIds;
            if (p !== undefined && p[i] === line) lineIds = pi[i];
            else { const f = extractKittyImageIds(line); lineIds = f.length === 0 ? __PK_KITTY_NO_IDS : f; }
            ni[i] = lineIds;
            for (const id of lineIds) ids.add(id);
        }
        this.__pkKittyLines = lines.slice(); this.__pkKittyIds = ni;
        return ids;
    }
}
const img = (id, rows=1) => `\x1b_Gi=${id},r=${rows};payloaddata\x1b\\`;
const txt = (s) => `\x1b[38;2;1;2;3m${s}\x1b[39m`;

const scenarios = [
  ["no images",        [txt("a"), txt("b"), txt("c")]],
  ["one image",        [txt("a"), img(42), txt("c")]],
  ["multi images",     [img(1), txt("x"), img(2), img(3)]],
  ["image mid-change", [txt("a"), img(42), txt("c")]],
  ["image removed",    [txt("a"), txt("b"), txt("c")]],
  ["reordered",        [img(3), img(1), txt("z")]],
  ["grown",            [img(3), img(1), txt("z"), img(9), txt("q")]],
  ["shrunk",           [img(3)]],
  ["same as before",   [img(3)]],
  ["multirow",         [img(7, 5), "", "", txt("tail")]],
  ["empty",            []],
  ["malformed",        ["\x1b_Gi=notanumber;x", "\x1b_G", txt("ok")]],
];

const P = new Patched();
let fails = 0;
for (const [name, lines] of scenarios) {
  const a = [...original(lines)].sort((x,y)=>x-y);
  const b = [...P.collectKittyImageIds(lines)].sort((x,y)=>x-y);
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(18)} original=[${a}] patched=[${b}]`);
}
// adversarial: reuse the SAME array object with mutated content (should still be correct
// because we compare per-index string identity)
const shared = [txt("a"), img(55)];
P.collectKittyImageIds(shared);
shared[1] = img(66);
const a2 = [...original(shared)].sort((x,y)=>x-y);
const b2 = [...P.collectKittyImageIds(shared)].sort((x,y)=>x-y);
const ok2 = JSON.stringify(a2)===JSON.stringify(b2);
if (!ok2) fails++;
console.log(`${ok2?"PASS":"FAIL"}  in-place mutation  original=[${a2}] patched=[${b2}]`);

console.log(fails === 0 ? "\nALL EQUIVALENT ✓" : `\n${fails} MISMATCH(ES) ✗`);
process.exit(fails === 0 ? 0 : 1);
