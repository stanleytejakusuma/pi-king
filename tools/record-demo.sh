#!/usr/bin/env bash
# Record the demo into media/demo.mp4.
#
#   tools/record-demo.sh
#
# Pi scans $HOME/.agents/skills unconditionally — the path is hardcoded, not
# settable, and unaffected by PI_CODING_AGENT_DIR. Any skill there that fails
# validation prints a [Skill conflicts] block into every session, which lands
# in the recording and names skills that have nothing to do with pi-king.
# Sessions can be started with --no-skills, but sessions resumed by /bg cannot:
# they are launched by pi-king itself and do not inherit the flag.
#
# So the directory is moved aside for the length of the recording and restored
# on exit, including on failure or interrupt. Nothing is renamed or edited:
# namespaced skill names may be meaningful to whatever installed them.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS="$HOME/.agents/skills"
ASIDE="$HOME/.agents/skills.pi-king-recording-aside"

restore() {
  if [ -d "$ASIDE" ]; then
    if [ -d "$SKILLS" ]; then
      echo "WARNING: both $SKILLS and $ASIDE exist; leaving $ASIDE in place." >&2
    else
      mv "$ASIDE" "$SKILLS" && echo "restored $SKILLS"
    fi
  fi
}
trap restore EXIT INT TERM

if [ -d "$ASIDE" ]; then
  echo "ERROR: $ASIDE already exists — a previous run did not clean up." >&2
  echo "Inspect and move it back manually before recording." >&2
  trap - EXIT INT TERM
  exit 1
fi

bash "$REPO/tools/demo-env.sh" >/dev/null
[ -d "$SKILLS" ] && mv "$SKILLS" "$ASIDE" && echo "moved $SKILLS aside for the recording"

tmux kill-server 2>/dev/null
rm -f "$HOME/.pi/king/session-status/"*.json

cd "$REPO" && vhs media/demo.tape

# GitHub renders an inline player only for its own user-attachments URLs, which
# require a manual upload through the web UI. A committed GIF renders from a
# relative path instead, so the README works in a fresh clone, on npm, and in
# any mirror, with nothing to re-upload. Two-pass palette: default GIF
# quantization mangles terminal text at this size.
ffmpeg -y -loglevel error -i media/demo.mp4 \
  -vf "fps=10,scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/pi-king-pal.png
ffmpeg -y -loglevel error -i media/demo.mp4 -i /tmp/pi-king-pal.png \
  -lavfi "fps=10,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" media/demo.gif
rm -f /tmp/pi-king-pal.png
echo "wrote media/demo.mp4 and media/demo.gif"

# Stills for the README.
#
# These timestamps are tied to the tape's pacing and DO NOT survive edits to it.
# A previous version shipped a still captioned "the dashboard" that was actually
# a terminal scroll, because the tape changed and the offsets did not. After any
# change to demo.tape, open each PNG and confirm it shows what its caption says.
ffmpeg -y -loglevel error -ss 44 -i media/demo.mp4 -frames:v 1 media/dashboard.png
ffmpeg -y -loglevel error -ss 57 -i media/demo.mp4 -frames:v 1 media/reattach.png
ffmpeg -y -loglevel error -ss 17 -i media/demo.mp4 -vf "crop=iw:520:0:0" -frames:v 1 media/backgrounding.png
echo "wrote media/dashboard.png, media/reattach.png, media/backgrounding.png"
