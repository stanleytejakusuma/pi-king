#!/bin/bash
# Ghost-cursor A/B: does pi's `showHardwareCursor` setting cause the stray white
# blocks seen under tmux? Measures at the byte level, so it needs no screen
# recording — the artifact is only possible if pi tells the terminal to SHOW the
# hardware cursor (\x1b[?25h); with it off, tmux has no cursor to park.
#
#   bash cursor-ab.sh            # runs both arms
#
# Touches ~/.pi/agent/settings.json for ~20s per arm and restores it on exit
# (including on Ctrl-C). Runs pi on a PRIVATE tmux socket — the live fleet is
# never attached, resized, or signalled.
set -u
SOCK=/tmp/pk-cursor-ab.sock
SET="$HOME/.pi/agent/settings.json"
OUT=${OUT:-/tmp/pi-audit}
mkdir -p "$OUT" "$OUT/scratch"
BACKUP=$(mktemp)
cp "$SET" "$BACKUP"
cleanup() { cp "$BACKUP" "$SET"; rm -f "$BACKUP"; tmux -S $SOCK kill-server 2>/dev/null; }
trap cleanup EXIT INT TERM

arm() {
  local want=$1 raw="$OUT/pane-hw-$1.raw"
  python3 -c "
import json,sys
p='$SET'; s=json.load(open(p)); s['showHardwareCursor'] = ('$want'=='on')
json.dump(s, open(p,'w'), indent=2)"
  rm -f "$raw"
  tmux -S $SOCK kill-server 2>/dev/null; sleep 0.5
  tmux -S $SOCK -f ~/.tmux.conf new-session -d -x 160 -y 45 -s ab -c "$OUT/scratch" "pi --no-session"
  # No client is attached on purpose. pi writes to its pty regardless of who is
  # watching, and an attached `script` client sends ^D on stdin EOF, which pi
  # takes as quit — that is what made earlier runs die at ~3s.
  # Wait for readiness rather than a fixed sleep: extension loading takes
  # 10-30s here, and a fixed sleep silently measures an empty screen.
  local ready=""
  for _ in $(seq 1 40); do
    sleep 1
    tmux -S $SOCK has-session -t ab 2>/dev/null || break
    if tmux -S $SOCK capture-pane -t ab -p 2>/dev/null | grep -q 'CTX '; then ready=1; break; fi
  done
  [ -n "$ready" ] || { echo "$want: pi never reached its prompt"; return 1; }
  tmux -S $SOCK pipe-pane -t ab -o "cat >> $raw"
  for _ in $(seq 1 15); do tmux -S $SOCK send-keys -t ab -l "hello world "; sleep 0.12; done
  sleep 1
  tmux -S $SOCK kill-server 2>/dev/null; sleep 0.4
  python3 - "$want" "$raw" <<'PY'
import sys
want, path = sys.argv[1], sys.argv[2]
d = open(path, 'rb').read()
show, hide = d.count(b'\x1b[?25h'), d.count(b'\x1b[?25l')
print('showHardwareCursor=%-3s  pi wrote %6dB  ?25h(show)=%-3d  ?25l(hide)=%-3d  -> ghost %s'
      % (want, len(d), show, hide, 'POSSIBLE' if show else 'impossible'))
PY
}

arm on
arm off
