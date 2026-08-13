# Resume prompt (session rotation, 2026-08-13)

The "Pi-King" session that did this work grew to 19,425 entries / 148MB —
larger by disk size than the Alexandria monolith that prompted today's whole
investigation. Paste the block below into a **fresh** session to continue.
This follows the same pattern Alexandria's own `docs/RESUME-PROMPT.md`
established (state lives in the repo; the session is disposable) — deliberately
eating our own cooking on the tool we built today.

---

```
We're continuing work on pi-king (~/codebase/pi-king), the tmux/dashboard
supervisor for a fleet of ~18 persistent "pi" agent sessions. The previous
session grew to 19,425 entries and was rotated for exactly the reason this
project exists: retained-session-size lag. Read docs/PERF-TMUX-SPEC.md before
touching anything performance-related — it is authoritative, and re-deriving
any of the findings below wastes real time (several were only reached after
multiple false leads that ARE documented so they are not repeated).

WHERE WE ARE

Tree clean, HEAD 0622364, 56/56 tests, `pi-king patch-tui --check` shows all
three patches applied (render-cap, width-cache, kitty-scan). Fleet: 18 tmux
sessions, 0 dead panes, daemon running (com.stanz.pi-king-hub, pid check via
launchctl). One arc is open: "alexandria-agents-md" (parent
019fa9b9-1f51-7ef0-87d8-3bd4b8f5bd40 — the session being rotated by this very
prompt), spawned to write ~/codebase/alexandria/AGENTS.md. It finished its
task (commits 2aa6511, 5453196, 55d646b landed in alexandria) and was steered
interactively at least once, but was never formally closed with closeArc().
Decide whether to close it or leave it; nothing is lost either way.

SETTLED FINDINGS — do not re-investigate, do not trust older/vaguer claims
over these

1. TMUX IS A REAL AMPLIFIER, PROVEN BY CONTROLLED A/B, NOT ASSUMED. Same
   21,371-line transcript, same prompt, same typing during a stream, only tmux
   differs: p50 repaint gap IDENTICAL (25ms both conditions) but the TAIL
   diverges hard — p99 425ms vs 100ms, stutters >100ms 14.1% vs 0.9% (15x),
   freezes >500ms 3 vs 0. Humans perceive the tail, not the median, which is
   why earlier median/byte-echo measurements wrongly exonerated tmux.
   Measurement tool that actually works: macOS `screencapture -v -V N out.mov`
   records VARIABLE frame rate — a frame is emitted only when the screen
   changes, so inter-frame gaps ARE real repaint events. Tools in
   docs/perf-tools/.

2. STREAMING CPU IS PI'S OWN RENDER PIPELINE, NOT TMUX TRANSPORT. Measured on
   a RAW PTY WITH NO TMUX: 62% CPU median, 112% peak while streaming a
   21k-entry session. Differential `node --cpu-prof` (load-only run minus
   load+stream run — a single whole-lifetime profile is useless, 72% of it is
   idle) showed streaming adds 20.0s of active CPU: box.js cache-compare
   16.6%, GC 13.2%, truncateToWidth 11.3%, parseKittyImageHeader 8.1%,
   isImageLine 7.8%, doRender 6.6%, render 6.1% — ~78% render+GC. Mechanism in
   source: Box.render() (pi-tui/dist/components/box.js) renders ALL children
   FIRST, then matchCache() compares every child line — the cache is checked
   AFTER the expensive work. This is a STILL-OPEN upstream bug:
   earendil-works/pi#6665 ("TUI pins a full core while streaming"), also
   #7730, #8029. We run 0.84.1 = latest, so the CLOSED perf issues' fixes are
   already in (#7385/#5014/#6478/#7332/#7541/#7769) — #6665 is what remains,
   and it needs a core fix (render coalescing/history virtualization) that is
   explicitly out of reach for an extension. docs/UPSTREAM-ISSUE-DRAFT.md has
   a draft ready to file; nobody has filed it yet — a real, cheap,
   brand-relevant contribution if you want to pick it up.

3. THE BIGGEST WIN WAS OUR OWN CODE, NOT UPSTREAM: fleet idle CPU
   1.29 cores -> ~0.003 cores (>99%). ~/.pi/agent/extensions/pi-alerts.ts was
   calling ctx.ui.setStatus every 1000ms UNCONDITIONALLY; setStatus
   invalidates the footer and a render walks the retained component tree
   (same Box.render bug), so all 18 sessions repainted their entire tree once
   a second while sitting fully idle. Fixed by publishing only when the
   formatted text changes. GENERALIZABLE RULE, worth remembering for any
   future extension: any setStatus/setWidget/setFooter on a timer costs a
   FULL TREE REPAINT per tick in this TUI — publish only on change.

4. /fork AND /clone DO NOT REDUCE SESSION SIZE. Verified in installed source:
   SessionManager.createBranchedSession(leafId) writes the FULL ancestor
   branch into the new file — a clone of a 21k-entry session is a 21k-entry
   session. Confirmed empirically too (a real fork's first message ids are
   byte-identical to its parent's). This is WHY the arc feature (below) exists
   at all — it was the only path that actually produces a small session.

5. Native spinner is correct and costs nothing. We tried slowing it (400ms vs
   pi's default 80ms) as a CPU-saving measure, measured a real win at the
   time (62.0% -> 41.5% streaming CPU), then REVERTED it on Stanley's explicit
   call — a motionless/slow indicator defeats the point of a working
   indicator. After finding #3 (the much bigger win), re-measured: fleet idle
   CPU with the native 80ms spinner and NO indicator extension installed is
   STILL ~0.00 cores. The spinner's marginal cost had already collapsed once
   #3 was fixed. Do not reintroduce a custom spinner extension without
   re-measuring first — the tradeoff that justified it no longer exists.

6. The "sync" tmux terminal-feature (xterm-ghostty:sync) was REMOVED. It was
   added speculatively during the tmux-config audit and never once measured
   as a win; it coincided with a real regression (scrolled-up mouse selection
   snapping to the composer instead of letting text be highlighted). Do not
   re-add without an A/B proving both a real redraw benefit AND intact
   copy-mode selection while scrolled up.

FEATURE SHIPPED THIS SESSION: arc

src/arc.ts + tool registrations in src/index.ts (arc_spawn, arc_digest) +
command /arc + skill ~/.pi/agent/skills/arc/SKILL.md + doctrine in
~/.pi/agent/AGENTS.md's "Session hygiene (arcs)" section.

An arc is a fresh, EMPTY child session (header-only seed file with
parentSession pointing at the spawning session) that appears indented under
its parent in /resume (buildSessionTree groups purely by parentSessionPath,
indifferent to whether the child was forked or born empty) while staying
fast. Lineage is ALSO recorded by session ID in ~/.pi/king/lineage.json,
because pi's own parentSession is a filesystem PATH and paths rot — this is
literally why Alexandria's own lineage was invisible before today, its
parent pointer resolves to a deleted file.

Verified live end to end: spawn (child answered at CTX 3.9%/7 entries while
parent sat at 21,470) -> real interactive steering (proven on the
alexandria-agents-md arc) -> arc_digest (0.3MB transcript -> 13KB conversation
text, zero tool-call noise, 96% reduction) -> subagent distillation into the
child repo's docs/LEARNINGS.md, never read back into the parent.

/arc is a SELECTOR, not a printout: it shows live per-arc status read from the
session card (attention/working/idle), and on selection jumps you there —
switch-client inside tmux (reuses the dashboard's own verified
goToSession/dispatchHubAction path, including its pid re-verification against
tmux so a forged listing row cannot redirect the jump); outside tmux, opens a
NEW GHOSTTY TAB via AppleScript (Cmd+T + type the attach command + Enter) —
Ghostty has no +new-tab action and no +new-window support on macOS and no
IPC/URL-scheme, so this keystroke-injection approach is the only way to land
in a tab rather than a whole separate app instance. It is fragile by nature;
if it silently does nothing, that is the known failure mode, not new
information — fall back to `tmux attach-session -t <name>`.

OPEN / NOT YET DONE

- Nobody has filed the upstream issue draft yet (docs/UPSTREAM-ISSUE-DRAFT.md)
  on earendil-works/pi#6665 or #7730 with the differential CPU profile
  evidence. Real, low-cost, brand-relevant.
- Alexandria's own rotation (spawning its replacement, same idea as this
  prompt) was explicitly deferred by Stanley pending a rested decision. Do not
  do it unprompted.
- arc_digest's transcript extraction chunks at 200KB and truncates beyond
  that (keeping the most recent portion) — fine for a properly-scoped arc,
  but an arc that grows past that size is itself becoming a monolith and
  should be treated as a signal to close it out sooner, not a tooling gap to
  fix.
- Parallel arcs (two children editing one repo at once) are explicitly NOT
  supported — the design is serial by Stanley's own stated logic ("once the
  parent spawns a new session, we work on that session instead"). If this
  ever needs to change, each concurrent arc needs its own git worktree.

STANDING CONSTRAINTS (unchanged, still apply)
- Real-fleet safety discipline: verify-before-kill on restarts, sandbox any
  destructive test against a scratch dir via PI_KING_PI_TUI_TARGET (never the
  real pi-tui install directly — that caused a real incident on 2026-08-10),
  checksum .orig backups before/after any patch-tui run.
- Copying a session transcript byte-identically duplicates its embedded
  sessionId (~57 occurrences including the header) — two processes then claim
  one status card, and whichever exits LAST deletes it, dropping the real
  session into "tmux (no Pi session)" and looking unpinned even though its
  pin in layout.json survives. Always rewrite the sessionId when copying a
  transcript for any reason (arc.ts's newSessionId() does this correctly).
```
