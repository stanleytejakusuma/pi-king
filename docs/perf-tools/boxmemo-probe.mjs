// Measures the box-child-memo fast-path HIT RATE inside a real pi session.
//
// Loads via `node --import`, and patches Box.prototype.render from OUTSIDE
// box.js. ESM modules are singletons, so every internal `new Box()` in pi gets
// the wrapped method -- no edits to box.js, so nothing can be mangled and the
// measured file is byte-identical to the shipped patch.
//
//   PK_STAT_OUT=/tmp/stats.json \
//   PI_LAB_ROOT=~/.pi-lab/pi-coding-agent \
//   NODE_OPTIONS="--import ./boxmemo-probe.mjs" \
//   python3 tui-mode-ab.py --mode regular --transport native --load typing ...
//
// A "hit" is the fast path returning the SAME array object it returned last
// time. That is the only thing the patch can do, so it is the only thing worth
// counting: hitRate 0 means the patch costs a comparison and buys nothing.
import { writeFileSync } from "node:fs";

const ROOT = process.env.PI_LAB_ROOT
  || `${process.env.HOME}/.pi-lab/pi-coding-agent`;
const OUT = process.env.PK_STAT_OUT || "/tmp/boxmemo-stats.json";

const { Box } = await import(
  `${ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`
);

const s = {
  renders: 0,
  sameRefReturned: 0,
  widthChanges: 0,
  linesRebuilt: 0,
  distinctWidths: new Set(),
};

const orig = Box.prototype.render;
Box.prototype.render = function (width) {
  const prevLines = this.cache && this.cache.lines;
  s.renders++;
  if (this.cache && this.cache.width !== undefined && this.cache.width !== width) {
    s.widthChanges++;
  }
  s.distinctWidths.add(width);
  const out = orig.call(this, width);
  if (prevLines && out === prevLines) s.sameRefReturned++;
  else s.linesRebuilt += out.length;
  return out;
};

const dump = () => {
  const o = { ...s, distinctWidths: [...s.distinctWidths].sort((a, b) => a - b) };
  o.hitRate = s.renders ? +(s.sameRefReturned / s.renders).toFixed(4) : null;
  try {
    writeFileSync(OUT, JSON.stringify(o, null, 2));
  } catch {}
};

setInterval(dump, 2000).unref();
for (const sig of ["exit", "SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    dump();
    if (sig !== "exit") process.exit(0);
  });
}
