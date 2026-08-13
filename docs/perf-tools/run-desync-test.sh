#!/bin/bash
# Controller: drives the sim step-by-step inside a real tmux pane and compares
# pi-tui's ASSUMED cursor column against tmux's OWN tracked cursor column.
# A divergence proves relative positioning desyncs under tmux.
set -uo pipefail
SOCK=pi-king-desync
rm -f /tmp/pi-audit/step.txt /tmp/pi-audit/expected.txt /tmp/pi-audit/desync-results.txt
echo 0 > /tmp/pi-audit/step.txt

tmux -L $SOCK kill-server 2>/dev/null
# Small pane forces scrolling quickly -- the condition under test.
tmux -f ~/.tmux.conf -L $SOCK new-session -d -s desync -x 100 -y 12 \
  "node /tmp/pi-audit/cursor-desync-sim.mjs"
sleep 0.6

MISMATCH=0
for step in $(seq 1 25); do
  echo "$step" > /tmp/pi-audit/step.txt
  # wait for sim to process this step
  for _ in $(seq 1 50); do
    got=$(awk '{print $1}' /tmp/pi-audit/expected.txt 2>/dev/null)
    [ "$got" = "$step" ] && break
    sleep 0.02
  done
  sleep 0.12  # let tmux apply the escapes

  expected_col=$(awk '{print $2}' /tmp/pi-audit/expected.txt 2>/dev/null)
  actual_col=$(tmux -L $SOCK display-message -p -t desync '#{cursor_x}' 2>/dev/null)
  actual_row=$(tmux -L $SOCK display-message -p -t desync '#{cursor_y}' 2>/dev/null)

  if [ "$expected_col" != "$actual_col" ]; then
    MISMATCH=$((MISMATCH+1))
    echo "step $step: MISMATCH expected_col=$expected_col actual_col=$actual_col (row=$actual_row)" \
      | tee -a /tmp/pi-audit/desync-results.txt
  else
    echo "step $step: ok col=$actual_col row=$actual_row" >> /tmp/pi-audit/desync-results.txt
  fi
done

echo
echo "=== RESULT: $MISMATCH / 25 steps diverged (tmux) ==="
tmux -L $SOCK kill-server 2>/dev/null
