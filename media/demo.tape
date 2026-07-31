# pi-king demo — regenerate with: vhs media/demo.tape
#
# Runs entirely inside the sanitized environment built by tools/demo-env.sh:
# placeholder skills and prompts, neutral project names, synthetic call logs,
# and a provider registered under a neutral display name. A recording shows
# every panel on screen for its whole length, so without this it documents the
# author's machine — installed tooling, model mix, provider arrangement —
# rather than pi-king.
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
Type "clear; tmux kill-server 2>/dev/null; source ~/king-demo/env.sh; clear"
Enter
Sleep 3s
Show

# --- session 1: api-server ---
Type "cd $P/api-server && pi --no-skills --model demo/auto/best-fast"
Enter
Sleep 9s
Type "Reply with exactly THE-CROWN-JEWEL-42 and nothing else."
Enter
Sleep 11s
Type "/bg"
Enter
Sleep 8s

# --- session 2: web-client ---
Type "cd $P/web-client && pi --no-skills --model demo/auto/best-fast"
Enter
Sleep 9s
Type "Reply with exactly SILVER-COMPASS-7 and nothing else."
Enter
Sleep 11s
Type "/bg"
Enter
Sleep 8s

# --- session 3: data-pipeline ---
Type "cd $P/data-pipeline && pi --no-skills --model demo/auto/best-fast"
Enter
Sleep 9s
Type "Reply with exactly NORTH-LANTERN-9 and nothing else."
Enter
Sleep 11s
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

# --- reattach: the session answers from its own history ---
Enter
Sleep 10s
Type "What was the phrase?"
Enter
Sleep 13s

# --- detach: back to the dashboard, all three still listed ---
Ctrl+B
Type "d"
Sleep 10s
Escape
Sleep 2s
