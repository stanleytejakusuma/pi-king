#!/bin/bash
S=/tmp/pk-sync.sock
run() {
  tag=$1; feat=$2
  tmux -S $S kill-server 2>/dev/null; sleep 0.2
  tmux -S $S -f /dev/null new-session -d -x 100 -y 30 -s t "sh -c 'while :; do date +%s%N; sleep 0.05; done'"
  tmux -S $S set -g default-terminal tmux-256color
  [ -n "$feat" ] && tmux -S $S set -as terminal-features "$feat"
  ( script -q /tmp/pi-audit/out-$tag.raw env TERM=xterm-ghostty tmux -S $S attach -t t ) >/tmp/pi-audit/script-$tag.log 2>&1 &
  sleep 3
  tmux -S $S kill-server 2>/dev/null
  sleep 0.5
  python3 -c "
d=open('/tmp/pi-audit/out-$tag.raw','rb').read()
print('[$tag] feat=${feat:-none}', d.count(b'\x1b[?2026h'),'BSU', d.count(b'\x1b[?2026l'),'ESU', len(d),'bytes')"
}
run nosync ""
run sync "xterm-ghostty:sync"
