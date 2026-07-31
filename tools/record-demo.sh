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
