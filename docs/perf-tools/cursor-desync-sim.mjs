// Reproduces pi-tui's EXACT cursor-positioning strategy to test whether
// relative cursor movement desyncs from the terminal's real cursor state
// under tmux when content scrolls.
//
// Mirrors tui-main-screen.js:504-535 positionHardwareCursor():
//   rowDelta = targetRow - this.hardwareCursorRow
//   write ESC[{rowDelta}B  (down)  or  ESC[{-rowDelta}A  (up)
//   write ESC[{targetCol+1}G
//   this.hardwareCursorRow = targetRow
//
// Step-gated by a file so an external controller can sample tmux's own
// cursor tracking at a deterministic point after each frame.
import fs from "node:fs";

const STEP_FILE = "/tmp/pi-audit/step.txt";
const EXPECT_FILE = "/tmp/pi-audit/expected.txt";
const ESC = "\x1b";

let hardwareCursorRow = 0; // pi-tui's tracked state
let lastStep = 0;

function frame(step) {
  // 1. Emit "streaming" output -- this is what a live agent turn does, and
  //    it is what pushes the screen into scrolling once the pane fills.
  const lines = 3;
  for (let i = 0; i < lines; i++) {
    process.stdout.write(`stream output step=${step} line=${i} ${"x".repeat(40)}\r\n`);
  }
  // After writing N lines with \r\n, the terminal cursor advanced N rows
  // (or the screen scrolled). pi-tui updates its own model the same way:
  hardwareCursorRow += lines;

  // 2. Now position the "composer" cursor exactly the way pi-tui does:
  //    a relative move computed from its OWN tracked row.
  const targetRow = Math.max(0, hardwareCursorRow - 1);
  const targetCol = (step * 3) % 40;
  const rowDelta = targetRow - hardwareCursorRow;
  let buf = "";
  if (rowDelta > 0) buf += `${ESC}[${rowDelta}B`;
  else if (rowDelta < 0) buf += `${ESC}[${-rowDelta}A`;
  buf += `${ESC}[${targetCol + 1}G`;
  process.stdout.write(buf);
  hardwareCursorRow = targetRow;

  // Record where pi-tui's logic BELIEVES the cursor now is (0-indexed col
  // is targetCol; row is model-relative, so the controller compares COLUMN
  // exactly and row-DELTA behavior across steps).
  fs.writeFileSync(EXPECT_FILE, `${step} ${targetCol}\n`);
}

setInterval(() => {
  let step = 0;
  try {
    step = parseInt(fs.readFileSync(STEP_FILE, "utf8").trim(), 10) || 0;
  } catch {}
  if (step > lastStep) {
    lastStep = step;
    frame(step);
  }
}, 20);
