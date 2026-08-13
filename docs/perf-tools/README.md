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
