# pi-king demo — regenerate with: vhs media/demo.tape
# Arc: stranded session -> /bg -> dashboard -> reattach, history intact.
Output media/demo.mp4

Set Shell zsh
Set FontSize 17
Set Width 1500
Set Height 900
Set Theme "Catppuccin Mocha"
Set Padding 16
Set TypingSpeed 55ms

# ---- beat 1: an ordinary Pi session, about to be stranded ----
Type "pi"
Enter
Sleep 6s
Type "Reply with exactly: THE-CROWN-JEWEL-42"
Enter
Sleep 9s

# ---- beat 2: /bg — background it into tmux ----
Type "/bg"
Enter
Sleep 6s

# ---- beat 3: the dashboard — the session survived its terminal ----
Type "pi-king"
Enter
Sleep 6s

# ---- beat 4: reattach — same process, history intact ----
Enter
Sleep 5s
Type "What was the exact phrase I asked you to reply with?"
Enter
Sleep 9s

# ---- beat 5: detach back to the dashboard, then close ----
Ctrl+B
Type "d"
Sleep 4s
Escape
Sleep 2s
