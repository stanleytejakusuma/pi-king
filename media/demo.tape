# pi-king demo — regenerate with: vhs media/demo.tape
# Arc: ordinary session -> /bg -> dashboard -> reattach with history intact.
Output media/demo.mp4

Set Shell zsh
Set FontSize 16
Set Width 1560
Set Height 920
Set Theme "Catppuccin Mocha"
Set Padding 18
Set TypingSpeed 45ms
Set PlaybackSpeed 0.7

Hide
Type "clear && tmux kill-server 2>/dev/null; clear"
Enter
Sleep 2s
Show

# --- beat 1: an ordinary session, doing real work ---
Type "pi"
Enter
Sleep 10s
Type "Remember this phrase exactly: THE-CROWN-JEWEL-42"
Enter
Sleep 13s

# --- beat 2: /bg — hand it to tmux, free the terminal ---
Type "/bg"
Enter
Sleep 8s

# The resumed process needs to finish booting and advertise itself before the
# dashboard can correlate it; opening too early lists it as a bare tmux
# session. Waiting here is the difference between the demo showing the feature
# and showing its absence.
Hide
Sleep 16s
Show

# --- beat 3: the dashboard — still alive, and listed ---
Type "pi-king"
Enter
Sleep 10s

# --- beat 4: enter reattaches the SAME process ---
Enter
Sleep 8s
Type "What was the phrase?"
Enter
Sleep 13s

# --- beat 5: detach, back to the dashboard ---
Ctrl+B
Type "d"
Sleep 6s
Escape
Sleep 3s
