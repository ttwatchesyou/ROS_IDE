#!/usr/bin/env bash
# Run inside the staged release, before changing current or the running service.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if node agent-native-check.js; then exit 0; fi
echo 'Native PTY is unavailable; rebuilding node-pty for this machine and Node version.' >&2
for tool in python3 make g++; do
  if ! command -v "$tool" >/dev/null; then
    echo 'Native build tools missing. On Ubuntu install: sudo apt-get install -y build-essential python3' >&2
    exit 1
  fi
done
# Force lifecycle scripts even when npm config has ignore-scripts=true.
# node-pty 1.1.0 checks only for a prebuild directory; force a real rebuild.
npm_config_build_from_source=true timeout 900s npm rebuild node-pty --ignore-scripts=false --foreground-scripts --no-audit --no-fund
node agent-native-check.js
