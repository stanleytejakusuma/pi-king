# `pix` — the isolated pi lab

A second pi install at `~/.pi-lab`, reachable as **`pix`**, used to prove a
vendored `pi-tui` patch on one session before it is allowed near the fleet.

## Why this exists

`pi-king patch-tui` edits `pi-tui` **in place** under
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/`.
Every fleet session resolves that one copy, so applying a patch is a
fleet-wide act.

Two facts make that acceptable for the first three patches and *not*
acceptable for the fourth:

- Node caches modules at require time, so patching never touches a **running**
  session. The blast radius is sessions started afterwards — including any the
  hub daemon restores.
- `render-cap`, `width-cache` and `kitty-scan` fail **slow**. `box-child-memo`
  fails **wrong**: its hazard is a stale cached frame, i.e. incorrect text on
  screen. A crash announces itself; a subtly stale line does not, and you would
  be reading agent output through it.

So `box-child-memo` gets proved on one session first.

## What it is

An APFS clone (`cp -Rc`, copy-on-write — near-zero disk and ~2s) of the system
install, with `box-child-memo` applied to the clone only.

```
~/.pi-lab/pi-coding-agent/            clone of the 0.84.1 install
  node_modules/@earendil-works/pi-tui/dist/components/
    box.js                            PATCHED (marker: pi-king-tui-patch:boxmemo-v1)
    box.js.orig                       pristine upstream, byte-identical to system
~/.local/bin/pix                      shim: exec node <lab>/dist/cli.js "$@"
```

**Only `components/box.js` differs.** `~/.pi/agent` is shared, so `pix` uses the
same settings, extensions, skills and session directory as `pi` — same fleet,
same config, same everything else.

## Verifying isolation

```sh
# different files, different sizes, marker present in exactly one
for r in /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent \
         ~/.pi-lab/pi-coding-agent; do
  f=$r/node_modules/@earendil-works/pi-tui/dist/components/box.js
  echo "$(grep -c 'pi-king-tui-patch:boxmemo-v1' $f)  $(wc -c <$f)  $f"
done
```

Expected: system `0  3233`, lab `1  4950`.

The system install must stay byte-identical across any lab work. Record it
before and check it after:

```sh
D=/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist
shasum -a256 $D/components/box.js $D/tui-main-screen.js $D/utils.js > /tmp/real-pitui-before.sha
# ... later ...
shasum -a256 -c /tmp/real-pitui-before.sha
```

## Using it

```sh
pix --version                 # 0.84.1, same as pi
pix                           # a normal pi session, patched renderer
pix --session <path>          # open a specific transcript
```

**Never point `pi` and `pix` at the same live transcript at once.** Two writers
on one session file is a known hazard: a byte-identical copy duplicates the
embedded `sessionId` (~90 occurrences in a large transcript, not just the
header), two processes then claim one dashboard status card, and whichever
exits last deletes it — dropping the real session into "tmux (no Pi session)".
For side-by-side tests make a scratch copy per arm:

```sh
node docs/perf-tools/mk-scratch-session.mjs <real.jsonl> /tmp/scratch-a.jsonl
```

which rewrites the id as it copies.

## Measuring

`docs/perf-tools/tui-mode-ab.py` takes `PI_PERF_CLI` to select the install:

```sh
cd docs/perf-tools
python3 tui-mode-ab.py --mode regular --transport native --load typing \
  --session /tmp/scratch-a.jsonl --out /tmp/stock.json
PI_PERF_CLI=~/.pi-lab/pi-coding-agent/dist/cli.js \
python3 tui-mode-ab.py --mode regular --transport native --load typing \
  --session /tmp/scratch-b.jsonl --out /tmp/patched.json
```

### Is the patch actually firing?

CPU numbers alone cannot distinguish "the patch helps a little" from "the patch
never fires and costs a comparison". `boxmemo-probe.mjs` answers that directly
by wrapping `Box.prototype.render` from outside the file — ESM modules are
singletons, so every internal `new Box()` gets the wrapper, and the measured
`box.js` stays byte-identical to the shipped patch.

```sh
PK_STAT_OUT=/tmp/stats.json \
NODE_OPTIONS="--import $PWD/boxmemo-probe.mjs" \
PI_PERF_CLI=~/.pi-lab/pi-coding-agent/dist/cli.js \
python3 tui-mode-ab.py --mode regular --transport native --load typing \
  --session /tmp/scratch.jsonl --out /tmp/probe
```

A hit is the fast path returning the **same array object** as last time — the
only thing the patch can do. `hitRate: 0` means it is pure overhead on that
workload. `widthChanges` matters too: the cache is width-keyed, so a workload
that changes width every frame (resize) can never hit by construction, and is
the wrong place to look for a win.

Caveat inherited from the fullscreen measurement: typing is a **proxy** for
streaming, not streaming itself — no provider will accept a 54MB session. It is
pi's documented worst path (`requestImmediateRender` deliberately bypasses the
16ms throttle), so it bounds behaviour, but it is not the real thing.

## Reverting

```sh
# revert the lab's patch, keep the lab
PI_KING_PI_TUI_TARGET=~/.pi-lab/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist \
  node tools/patch-pi-tui.mjs revert

# remove the lab entirely
rm -rf ~/.pi-lab ~/.local/bin/pix
```

Neither touches the system install.

## Promoting the patch

Once proven, `pi-king patch-tui` applies it system-wide. Running sessions keep
the old code until they restart, so a fleet-wide rollout is gradual by nature —
and `pi-king patch-tui --revert` plus a restart undoes it.

## Staleness

The lab is a clone of 0.84.1. A `pi` upgrade updates the system install and
**not** the lab, so `pix --version` diverging from `pi --version` means the lab
is stale — delete and re-clone rather than patching an old runtime.
