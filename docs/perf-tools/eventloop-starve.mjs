// Tests whether CPU-bound synchronous render work delays keystroke echo,
// independent of tmux. Node is single-threaded: if a render pass blocks the
// event loop, stdin data events (and therefore echo) wait behind it.
//
// Mode "idle": echo only. Mode "busy": echo + a synchronous work burst on a
// timer, simulating pi re-rendering a large document while streaming.
import fs from "node:fs";

const mode = process.argv[2] || "idle";
const workMs = Number(process.argv[3] || 60); // ms of sync work per render
const logPath = `/tmp/pi-audit/starve-${mode}.log`;
fs.writeFileSync(logPath, "");

process.stdin.on("data", () => {
  // echo immediately, timestamped -- this is the "keystroke appears" moment
  process.stdout.write("\x1b[2K\r> x");
  fs.appendFileSync(logPath, `${process.hrtime.bigint()}\n`);
});

if (mode === "busy") {
  // Simulate the render loop: a periodic BLOCKING burst, like a synchronous
  // full re-render of a large document tree.
  setInterval(() => {
    const end = Date.now() + workMs;
    let acc = 0;
    while (Date.now() < end) {
      acc += Math.sqrt(Math.random()) * Math.sin(acc); // real CPU, not a sleep
    }
    globalThis.__sink = acc; // burn CPU only, emit nothing
  }, 100); // render ~10x/sec, matching an active streaming session
}
