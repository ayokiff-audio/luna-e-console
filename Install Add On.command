#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; fi
if [ ! -x "$NODE_BIN" ]; then printf '%s\n' 'Node.js was not found. Install Node.js, then run this installer again.'; exit 1; fi
"$NODE_BIN" tools/builder.mjs install
printf '%s\n' 'Open LUNA → Add Ons → Windows → E Console.'
