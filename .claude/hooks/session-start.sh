#!/bin/bash
set -euo pipefail

# SessionStart hook for the QQQQ Component Tracker.
#
# This project intentionally has ZERO npm dependencies — the frontend, the
# zero-dep static server, and the data scripts all run on the Node.js standard
# library (see package.json: no dependencies, no lockfile). There is therefore
# nothing to `npm install`.
#
# This hook simply verifies that a supported Node.js toolchain is present so
# that `npm test` and `npm run refresh` work immediately in the session.
#
# Idempotent, non-interactive, and safe to run on every session start.

# Only needed for Claude Code on the web; skip on local machines.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "session-start: ERROR — node not found on PATH; install Node.js 20+." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "session-start: ERROR — Node 20+ required (package.json engines), found $(node --version)." >&2
  exit 1
fi

echo "session-start: Node $(node --version) ready — zero dependencies, nothing to install."
