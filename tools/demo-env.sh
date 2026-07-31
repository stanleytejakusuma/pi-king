#!/usr/bin/env bash
# Build a sanitized environment for recording the demo.
#
# The recording is the most exposed artifact this project produces: it shows
# skills, prompts, extensions, installed CLIs, model mix and project names, all
# of which describe the author's machine rather than pi-king. This creates a
# throwaway agent directory with placeholder content so the demo shows the
# tool, not its author's setup.
#
# Usage: tools/demo-env.sh   (prints the env to export)
set -euo pipefail

# Kept under $HOME rather than /tmp: credentials are reached by symlink below,
# and a world-readable parent directory is the wrong place for that.
ROOT="${PI_KING_DEMO_ROOT:-$HOME/king-demo}"
AGENT="$ROOT/agent"
rm -rf "$ROOT"
mkdir -p "$AGENT"/{skills,prompts,extensions,lib} "$ROOT"/projects/{api-server,web-client,data-pipeline}
# A fresh status directory per take. Reaping leftover processes from earlier
# takes proved unreliable — a survivor's heartbeat recreates its status file in
# whatever directory the path points at, so a later recording showed six
# sessions instead of three. A unique directory removes the dependency on
# killing anything: an old process keeps writing to a directory this take never
# reads.
STATUS="$ROOT/status-$(date +%s)"
mkdir -p "$ROOT/tmux" "$STATUS"

# An empty skills tree at the demo HOME. Pi scans <home>/.agents/skills and
# prints a validation warning for every malformed skill it finds; with HOME
# pointed here that scan lands on this empty directory instead of the author's.
mkdir -p "$ROOT/.agents/skills"

# tmux reads <home>/.tmux.conf. Without one, the demo server runs with defaults
# and Pi warns that extended keys are off — a warning about the recording rig,
# not about pi-king, that has no business being in the recording.
cat > "$ROOT/.tmux.conf" <<'CONF'
set -s extended-keys on
set -s extended-keys-format csi-u
set -g default-terminal "tmux-256color"
set -sg escape-time 10
set -g status off
CONF
chmod 700 "$ROOT/tmux"

# --- placeholder skills -----------------------------------------------------
for s in run-tests write-docs review-diff; do
  mkdir -p "$AGENT/skills/$s"
  cat > "$AGENT/skills/$s/SKILL.md" <<EOF
---
name: $s
description: Placeholder skill used for the pi-king demo recording.
---
Placeholder.
EOF
done

# --- placeholder prompts ----------------------------------------------------
for p in changelog summarize handoff; do
  printf -- '---\ndescription: Placeholder prompt for the demo recording.\n---\nPlaceholder.\n' \
    > "$AGENT/prompts/$p.md"
done

# --- the extension under test, plus its helper ------------------------------
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sed 's#from "./data.ts"#from "../lib/pi-king-data.ts"#' "$REPO/src/index.ts" > "$AGENT/extensions/pi-king.ts"
cp "$REPO/src/data.ts" "$AGENT/lib/pi-king-data.ts"

printf '{\n  "quietStartup": true\n}\n' > "$AGENT/settings.json"

# A provider whose displayed name says nothing about which vendor is behind it.
# The recording puts the model label on screen for its whole length, and a real
# model id discloses both the provider and, by inference, how it is being paid
# for. Point PI_KING_DEMO_BASEURL at any OpenAI-compatible endpoint.
DEMO_BASEURL="${PI_KING_DEMO_BASEURL:-http://127.0.0.1:20128/v1}"
DEMO_MODEL="${PI_KING_DEMO_MODEL:-auto/chat}"
cat > "$AGENT/extensions/demo-provider.ts" <<EOF
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Demo-only. Registers one provider under a neutral display name so the
 *  recording does not put a vendor or routing arrangement on screen. */
export default function demoProvider(pi: ExtensionAPI) {
  pi.registerProvider("demo", {
    baseUrl: "$DEMO_BASEURL",
    apiKey: "local",
    api: "openai-completions",
    models: [{
      id: "$DEMO_MODEL",
      name: "assistant",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    }],
  });
}
EOF

# Reach the real credentials by symlink rather than copying them. The demo
# needs to make live model calls, but duplicating auth.json into a second
# location would create a second thing to leak and a second thing to rotate.
# Nothing here reads the file; Pi opens it through the link.
for f in auth.json models-store.json trust.json; do
  [ -e "$HOME/.pi/agent/$f" ] && ln -sf "$HOME/.pi/agent/$f" "$AGENT/$f"
done

# --- synthetic call logs ----------------------------------------------------
# Generic model names, so the band demonstrates the feature without disclosing
# which providers this machine actually routes to. Clearly illustrative.
LOGS="$ROOT/call-logs"
DAY="$(date -u +%Y-%m-%d)"
mkdir -p "$LOGS/$DAY"
python3 - "$LOGS/$DAY" <<'PY'
import json, random, sys
from pathlib import Path
out = Path(sys.argv[1]); random.seed(7)
models = ["fast-model"]*54 + ["smart-model"]*31 + ["long-context-model"]*15
for i, m in enumerate(random.sample(models * 3, 240)):
    hour = min(23, int(abs(random.gauss(13, 3))))
    (out / f"call-{i:04d}.json").write_text(json.dumps({"summary": {
        "model": m, "provider": "demo",
        "status": 200 if random.random() > 0.012 else 500,
        "timestamp": f"2000-01-01T{hour:02d}:00:00.000Z",
    }}))
PY

# Written to a file as well as stdout: the demo tape sources it, and VHS's
# parser cannot carry a command substitution inside a Type line.
cat > "$ROOT/env.sh" <<EOF
export PI_CODING_AGENT_DIR="$AGENT"
export PI_KING_CALL_LOGS="$LOGS"
export PI_KING_CLIS="git,jq,rg,tmux"
export P="$ROOT/projects"
# Isolate the recording from the real environment. TMUX_TMPDIR selects a
# different socket directory, so the demo gets its own tmux server and cannot
# see, list, or destroy the sessions you actually have running; PI_KING_STATUS_DIR
# does the same for the dashboard's view. An earlier version instead ran
# tmux kill-server for a clean slate and destroyed every live session on the
# machine, which is the precise failure this project exists to prevent.
export TMUX_TMPDIR="$ROOT/tmux"
export PI_KING_STATUS_DIR="$STATUS"
# Pi scans \$HOME/.agents/skills unconditionally and prints a validation warning
# for every skill there that fails its name rules, which lands in the recording.
# Pointing HOME at the demo root makes that scan find nothing. The previous
# approach moved the real directory aside and restored it on exit, which left
# the author's skills displaced whenever a run was killed hard enough to skip
# the trap. Nothing outside this directory is touched now.
export HOME="$ROOT"
EOF
cat "$ROOT/env.sh"
