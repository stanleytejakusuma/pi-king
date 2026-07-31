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
DEMO_MODEL="${PI_KING_DEMO_MODEL:-auto/best-fast}"
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
EOF
cat "$ROOT/env.sh"
