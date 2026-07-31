# pi-king demo — regenerate with: vhs media/demo.tape
#
# Three sessions across three projects, backgrounded, then supervised and
# reattached from one place. Grouping by project is the point; a single session
# cannot show it.
#
# Sessions run with --no-context-files --no-skills so the demo shows pi-king
# rather than this machine's personal doctrine files. It also keeps turns
# short: /bg defers until the current turn finishes, and a long turn pushes the
# handoff past the tape's next keystroke, which then lands inside Pi instead of
# the shell.
Output media/demo.mp4

Set Shell zsh
Set FontSize 20
Set Width 2000
Set Height 1200
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 40ms
Set PlaybackSpeed 0.75

Hide
Type "clear && tmux kill-server 2>/dev/null; clear"
Enter
Sleep 2s
Show

# --- session 1: pi-king ---
Type "cd ~/codebase/pi-king && pi --no-context-files --no-skills"
Enter
Sleep 9s
Type "Reply with exactly THE-CROWN-JEWEL-42 and nothing else. Do not use any tools."
Enter
Sleep 12s
Type "/bg"
Enter
Sleep 8s

# --- session 2: card-counter ---
Type "cd ~/codebase/card-counter && pi --no-context-files --no-skills"
Enter
Sleep 9s
Type "Reply with exactly SILVER-COMPASS-7 and nothing else. Do not use any tools."
Enter
Sleep 12s
Type "/bg"
Enter
Sleep 8s

# --- session 3: atlas ---
Type "cd ~/codebase/atlas && pi --no-context-files --no-skills"
Enter
Sleep 9s
Type "Reply with exactly NORTH-LANTERN-9 and nothing else. Do not use any tools."
Enter
Sleep 12s
Type "/bg"
Enter
Sleep 8s

# Let the three resumed processes boot and advertise themselves.
Hide
Sleep 20s
Show

# --- the dashboard: three projects, three live sessions ---
Type "pi-king"
Enter
Sleep 12s
Down
Sleep 3s
Down
Sleep 3s

# --- reattach: the session answers with ITS OWN phrase ---
Enter
Sleep 10s
Type "What was the phrase?"
Enter
Sleep 13s

# --- detach: back to the dashboard, all three still listed ---
Ctrl+B
Type "d"
Sleep 8s
Escape
Sleep 2s
