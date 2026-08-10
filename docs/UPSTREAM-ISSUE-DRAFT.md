# Upstream issue draft — earendil-works/pi

Template: **Contribution Proposal** (`contribution.yml`) — the required
pre-PR path for new contributors.

Submission rules honored here (from CONTRIBUTING.md):

- One screen max — draft below is ~15 lines of body text.
- **Own voice required — LLM-generated issue text is disallowed.** Treat the
  draft as raw material: rewrite/trim in your words before submitting. Every
  number in it is from our real measurements, so you can own every sentence.
- Detailed AI-produced analysis (the full measurement table) goes in a
  follow-up comment *clearly labeled* as agent-assisted, only if asked.
- Submit manually via the GitHub template UI, never via automation (their
  blocking policy is explicit about agent-slung issues).
- Say you want to implement it → included in "How".
- Monday–Thursday submission (Fri–Sun issues deprioritized).

---

## Field: What do you want to change?

Cap how many lines `fullRender` in `packages/tui/src/tui-main-screen.ts`
replays. Today it rewrites the entire rendered document — every line of the
session — on first render, on any resize, and whenever the differential path
bails out (content shrink, change above the viewport). On one of my real
40MB sessions that is 67,555 lines ≈ 10.9MB written to the terminal per full
render. I'd like an opt-in cap (env var or TUI option) so full renders
replay only the last N lines; unset keeps current behavior byte-identical.

## Field: Why?

stdout writes to a tty block, and slower terminal paths (tmux panes) drain
large bursts ~6.5× slower than a fast pty (measured: a 5.2MB burst = 27ms on
a fast pty vs ~175ms through tmux). Each full render of a big session
freezes the event loop for 350–550ms — spinner stalls, keystrokes queue. A
one-row resize reproduces it deterministically (verified with
`PI_DEBUG_REDRAW=1` + tmux `pipe-pane` byte counts). Fast native terminals
hide this; anyone running long sessions inside tmux gets a visibly laggy
UI. Only the replayed-scrollback depth changes with a cap — bookkeeping is
document-space and cursor moves are already viewport-clamped, so the final
screen state is identical.

## Field: How? (optional)

In `fullRender`, when the cap is set and `newLines.length > cap`, start the
write loop at `newLines.length - cap` (both clear and non-clear variants).
I'm happy to implement this myself with tests.

---

## After submitting

- Expect auto-close; maintainers review daily and reopen if it meets the
  bar. `lgtmi` = issues open; `lgtm` = PR rights.
- If `lgtm`: PR work happens from the pi repo root (their AGENTS.md governs
  agents), `npm run check` + `./test.sh` must pass, never touch
  CHANGELOG.md.
- Version field: pi 0.84.1.
