# Perf investigation tools (2026-08-11..13)

Instruments built while chasing the tmux-vs-native smoothness gap. See
`../PERF-TMUX-SPEC.md` for findings, including which hypotheses are already
DISPROVEN (do not re-run those).

- `analyze-smoothness.sh <recording.mov>` — quantify perceived smoothness from
  a screen recording. macOS `screencapture -v` records VARIABLE frame rate, so
  inter-frame gaps ARE repaint events. This is the instrument that actually
  measures what a human perceives; byte-level latency tests do not.
- `ghost2.py` — classify bright blocks in extracted frames as static UI vs
  transient artifacts. Correctly traced the real cursor advancing while typing.
  Extract frames first: `ffmpeg -i rec.mov -vsync 0 frames/f%04d.png`
- `cursor-desync-sim.mjs` + `run-desync-test.sh` — step-gated harness that
  mirrors pi-tui's `positionHardwareCursor()` relative-move strategy inside a
  real tmux pane and compares against tmux's own `#{cursor_x}`. Result was
  0/25 divergence (hypothesis disproven, kept for regression use).

Recording from the CLI (no user paste needed):
    screencapture -v -V 20 /tmp/out.mov

- `eventloop-starve.mjs` + `starve-test.py` — PROVES that synchronous CPU work
  starves keystroke echo (native, raw-mode pty): a 60ms work burst every 100ms
  pushes echo p90 from 0.50ms to 54.63ms. NOTE `starve-test.py` contains the
  `raw()` helper every future latency test must use — without raw mode you
  measure the KERNEL's pty echo, not the app's render, which invalidated all
  of this investigation's first-round numbers. The tmux branch of this script
  still misreads (returns pre-buffered output) and is NOT trustworthy.

## Fix 6 tooling (2026-08-13)
- `kitty-equiv-test.mjs` — proves the kitty-scan patch returns IDENTICAL image
  id sets to upstream across 13 cases. Its adversarial in-place-mutation case
  caught a real bug in the first draft (storing the caller's array instead of a
  snapshot), which would have silently corrupted image tracking.
- `kitty-bench.mjs` — micro-benchmark. **Read the caveat:** it uses 3,120-char
  lines and 60k lines/render, which OVER-ESTIMATES the real win by ~an order of
  magnitude. It predicted ~110ms/render saved; the real V8 profile showed the
  scan is ~8% of active CPU, and applying the patch moved streaming CPU 57.8%
  -> ~57%. Trust `--cpu-prof` over synthetic micro-benchmarks.
- `styling-cpu.py` — heavy vs coalesced SGR through a real tmux server: heavy
  costs 2.17x the tmux CPU for identical visible text.
- `contention-test.py` — 2x2 {native,tmux} x {idle,loaded}. tmux relays a
  steady 30ms styled stream cleanly (p99 31ms, 0% >100ms); native barely
  degrades under 10 CPU hogs. NOTE: its tmux+loaded cell fails to START tmux
  (spawn_rc=1) rather than measuring a stall — do not read that cell as data.
