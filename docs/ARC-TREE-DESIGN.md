# Arc tree on the dashboard — design

Status: **designed, not built** (2026-08-14). Settled with Stanley in a
grill-me interview; every decision below has a rationale and most were
reached by rejecting a worse alternative that is recorded here so it is not
re-proposed.

## Goal

Arcs currently scatter into their `cwd` group and look identical to ordinary
sessions. Make lineage visible: an arc renders **nested under the session
that spawned it**, recursively (an arc can spawn an arc), with a toggle to
collapse.

## Decisions

### 1. Nested under the parent row, not a separate section

Rejected: a dedicated `arcs` section near the top. It broke the cwd
contract — an arc spawned in a different directory than its parent would sit
under a section header that lies about where it lives. Nesting under the
parent keeps every row inside its real project group.

Consequence Stanley spotted immediately: **no new jump keybind is needed.**
Arcs are ordinary rows, so `↑↓` reaches them, `Enter` attaches, and
`x`/`X`/`e`/pin all work for free. This also sidesteps `/arc`'s fragile
Ghostty-AppleScript jump path in favour of the dashboard's verified
`goToSession` (which re-verifies the pid against tmux before switching).

### 2. Arc visibility is inherited from the parent, decided at spawn

**The load-bearing decision.** If a session is not on the dashboard, neither
it nor its arcs should be — per Stanley: *"If a session isn't in the
dashboard then I have clear intention that it shouldn't be managed. It's
probably a one-off only."*

`visible` is already **provenance, not liveness**: `tmuxLaunchEnv`
(`src/fleet.ts:571`) stamps `PI_DASHBOARD_SPAWNED=1` at launch and the card
carries it for its lifetime; `src/fleet.ts:363` filters on it. Arc spawning
currently hardcodes that flag, which is why arcs spawned from a native
Ghostty tab appear on the dashboard while their parent does not.

Fix: propagate the parent's flag instead of asserting it. One line.

Escape hatch, already implemented, no new code: `/bg` inside an arc surfaces
it — an explicit act of intent, which is exactly the test above.

**This eliminates the orphan case for new spawns.** Every visible arc now
has a visible parent by construction, so the tree is always well-formed. An
earlier design needed a dimmed non-selectable "ghost parent" row for arcs
whose parent was off-dashboard; that is no longer necessary and should not
be reintroduced.

**Enforced twice, because the spawn-time gate alone is not enough.** Any
session that was already running when the inheritance change shipped keeps
its OLD in-memory extension code, which stamps `PI_DASHBOARD_SPAWNED=1`
unconditionally — so pre-upgrade sessions keep producing visible arcs with
invisible parents until they restart. Observed live with the Pi-King dev
session (2026-08-14). Stanley's ruling: *"fix this so that Pi-King won't
show an arc that doesn't have an active parent in pi-king."* The
render-side gate is `pruneOrphanArcs()` (`src/fleet.ts`): a row survives
only if its ancestry terminates in a session with no parent in the ledger;
an arc whose parent chain never reaches a dashboard row is hidden entirely.
Lineage cycles keep today's flat-render behaviour.

Edge case, restated for the render-side gate: the gate looks at the rows
actually present, not at provenance. An exited parent whose card is still on
the dashboard keeps its arcs visible, nested under the exited row. Dismissing
that parent's card (X) removes it from the rows, and its arcs vanish with it
— the same reading as Stanley's ruling: a parent no longer in pi-king means
its arcs should not be managed there either. To keep an arc after dismissing
the parent, `/bg` inside the arc surfaces it as its own root row first.

### 3. Tree glyphs are drawn inside the name column

`src/index.ts:1813` fixes the name column at
`min(34, max(18, width * 0.22))`, and the comment says why: *"so activity
text lines up down the page instead of ragging against variable-width
names."*

Therefore the tree prefix (`├─ `, `│  `, `└─ `) is **part of the name
column's budget**, not inserted before the row marker. Indenting the whole
row would rag every column to its right — precisely what that geometry
exists to prevent.

Cost: each depth level consumes 3 characters of an 18–34 char name budget.

**Built without a depth cap** (design said cap at 4). A cap silently flattens
depth 5 into depth 4, which is more confusing than a name truncated with `…`
— and truncation already works. Add one if real nesting ever reaches that
depth; nothing here assumes it is absent.

Glyphs are light box-drawing in `dim` so the tree recedes and session names
stay the brightest thing in the column (per the `pi-tui-design` skill: one
accent dominates, `muted`/`dim` for everything secondary).

### 4. A row shows its own project only when it differs from the header

Arcs may be spawned with a different cwd than their parent (`arc_spawn`
takes `cwd`). When an arc's cwd differs from the section header, render
`name · project` on the row.

Direct precedent, `src/index.ts:1826`: *"A pinned row keeps its own project
visible on the row itself, since the section header no longer says where it
lives."*

### 5. Expanded by default; `a` collapses; state persists in `layout.json`

The feature exists to stop arcs being invisible, so collapsed-by-default
would reintroduce the problem it solves. Collapse means "I know about these,
stop showing me" — a deliberate act worth persisting.

**Persistence is not polish.** `bin/pi-king` is a `while true` loop that
re-runs the extension after every detach, so the dashboard is a fresh
process each time you return; in-memory collapse state would reset several
times an hour.

`layout.json` already carries `pinned` and `order` and already tolerates
stale ids (`src/index.ts:208`: *"a stale id just fails the lookup"*), so
`collapsed: string[]` needs no new machinery.

Key choice: `a` is free and mnemonic. `→` is **not** available — it is
already bound to attach (`src/index.ts:1460`). Space was the other
candidate, rejected because it is the key people press to scroll.

Affordance: `▾`/`▸` renders on a parent **only when it actually has arcs**,
so nothing changes for ordinary rows.

## Target rendering

```
  ~/codebase/pi-king                                     ● 2 uncommitted

    Alexandria                ● idle      indexed 46 notes         8m ago
  ❯ Pi-King              ▾    ● working   designing the arc tree    now
    ├─ stream-profile         ● working   profiling render walk     1h ago
    │  └─ box-ab · pk-stream  ● idle      waiting on you           12m ago
    └─ fingerprint-fix        ● idle      89 tests · ready          2h ago
    Charon                    ● idle      watching mempool         31m ago
```

## Known dependency — resolved, and it was overstated

The design claimed tree ordering required reworking the comparator at
`src/fleet.ts:415-425`, coupling it to the "state-first grouping" gap.
**It does not.** `orderByLineage()` is a **post-pass** over the fully sorted
list: it only relocates descendants, so pinned-first / cwd / manual-order /
urgency / recency all still hold within a sibling group, and the load-bearing
comparator is untouched. The two features are independent after all.

Nested rows do not emit a section header (`src/index.ts`), so an arc stays
inside its parent's section even when its own cwd differs — which is what
makes decision 4 necessary.

Lineage source: `~/.pi/king/lineage.json`, shaped
`{arcs:[{id,name,cwd,parentId,createdAt,closedAt}]}`. `parentId` is a
session id, deliberately not a path (paths rot). `arcsOf(sessionId)` and
`allArcs()` are exported from `src/arc.ts`.

Overlaps the unmerged `feat/arc-close` branch (87 tests), which already
touches arc listing and adds window teardown. Merge that first.

## Out of scope

- No new jump keybind (decision 1 removed the need).
- No ghost parent rows (decision 2 removed the need); invisible parents hide
  their arcs at render time too (pruneOrphanArcs).
- No cross-machine or multi-parent lineage. One parent per arc.

## Visual decisions, made against screenshots

Reviewed in a sandboxed dashboard (`/tmp/arcui/harness.sh`: private tmux
socket, throwaway `HOME`, fixture cards) rather than by reading code. Four
things were only visible once rendered:

1. **The rail leads the row.** It first sat to the right of the session glyph
   (`⌿ ├─ name`), which made the tree read as decoration floating inside a
   column instead of the thing giving the rows their shape. The whole left
   column is now assembled as one string — rail, glyph, flag, name, suffix —
   and passed to `truncateToWidth`, which is ANSI-aware, so each piece carries
   its own colour and the column still lands exactly on `nameW`.

2. **The twisty occupies the glyph slot** rather than sitting beside it.
   Carrying both produced three glyphs ahead of a parent's name
   (`▾ ⌿ ⚑ Alexandria`) and the eye had to sort out which meant what. A row
   that owns arcs is by definition a live session, so the glyph it gives up
   was the predictable one.

3. **`statusW` 22 → 13.** The longest state is `● background` at 12 cells, so
   every row padded ten dead columns before its activity text. This was not
   part of the feature; it was just visible once the rows were dense enough to
   look at.

4. **The project suffix is all-or-nothing.** Truncated, it degrades to a
   dangling `·…` that spends two cells of the name column saying nothing. It
   now appears only if it fits whole.

Fixture rows must be backed by real processes whose command is exactly `pi`
(`process.title` rewriting, as pi itself does) **and** whose start time is
within 60s of the card's `startedAt` — `src/fleet.ts` treats a mismatch as a
recycled pid and marks the card exited, so every row renders grey and the
state colours never appear.

### Found while reviewing, unrelated to arcs

`src/index.ts` had been read as latin-1 and re-encoded, so every literal
non-ASCII character in it was double-encoded — the restart indicator and the
separators in each row's right-hand meta are literals, so the dashboard was
drawing `ctx 35% Â· â» restart` on every row. Escaped characters were fine,
which is exactly why it went unnoticed: the file's own `\uXXXX` convention hid
it. Repaired in 9a187cb.
