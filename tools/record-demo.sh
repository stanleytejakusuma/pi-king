#!/usr/bin/env bash
# Record the demo into media/demo.mp4.
#
#   tools/record-demo.sh
#
# Nothing here modifies anything outside the throwaway demo root. demo-env.sh
# points HOME, TMUX_TMPDIR and PI_KING_STATUS_DIR into it, so the recording gets
# its own home directory, its own tmux server and its own dashboard view.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pi resolves the home directory for its $HOME/.agents/skills scan from the
# password database, not from $HOME, so pointing HOME at the demo root does not
# redirect it (verified: the conflicts block still named the real path). Any
# skill there failing validation prints into every session in the recording,
# including the author's own skill names. Sessions started by the tape can pass
# --no-skills; sessions resumed by /bg cannot, because pi-king launches them.
#
# So the directory is moved aside for the recording. An earlier version left it
# displaced when a run was killed before its trap ran, so the restore is now
# also performed on startup: if the aside directory is present, put it back
# before doing anything else.
SKILLS="$HOME/.agents/skills"
ASIDE="$HOME/.agents/skills.pi-king-recording-aside"

restore_skills() {
  [ -d "$ASIDE" ] || return 0
  if [ -d "$SKILLS" ]; then
    # Both present: a real skills dir was recreated while ours was aside. Do not
    # overwrite it; leave the aside copy for a human to reconcile.
    echo "WARNING: both $SKILLS and $ASIDE exist; leaving $ASIDE alone." >&2
    return 0
  fi
  mv "$ASIDE" "$SKILLS" && echo "restored $SKILLS"
}

# Self-heal from any previous run that did not get to clean up.
restore_skills
trap restore_skills EXIT INT TERM HUP



# Kill the DEMO server only. Safe because demo-env.sh gives it its own socket
# directory: this cannot reach the real server. Without it, sessions from
# previous takes accumulate and the recording shows six sessions instead of
# three.
if [ -d "$HOME/king-demo/tmux" ]; then
  TMUX_TMPDIR="$HOME/king-demo/tmux" tmux kill-server 2>/dev/null || true
fi
# Killing the demo server orphans rather than stops the Pi processes inside it,
# and their heartbeat re-creates status files in the recreated status directory,
# so a later take shows every earlier take's sessions too. Match on working
# directory: only demo processes live under the demo root.
for p in $(pgrep -x pi 2>/dev/null); do
  d=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)
  case "$d" in "$HOME/king-demo"*) kill "$p" 2>/dev/null ;; esac
done
sleep 1

bash "$REPO/tools/demo-env.sh" >/dev/null
[ -d "$SKILLS" ] && mv "$SKILLS" "$ASIDE"

# Nothing here touches the real tmux server or the real status directory:
# demo-env.sh points TMUX_TMPDIR and PI_KING_STATUS_DIR at the throwaway root,
# so the recording runs against its own tmux server entirely. An earlier version
# ran tmux kill-server for a clean slate and destroyed every live session on
# this machine.

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
ffmpeg -y -loglevel error -ss 58 -i media/demo.mp4 -frames:v 1 media/reattach.png
ffmpeg -y -loglevel error -ss 17 -i media/demo.mp4 -vf "crop=iw:520:0:0" -frames:v 1 media/backgrounding.png
echo "wrote media/dashboard.png, media/reattach.png, media/backgrounding.png"
