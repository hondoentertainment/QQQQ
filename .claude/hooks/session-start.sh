#!/bin/bash
set -euo pipefail

# SessionStart hook for the QQQQ Component Tracker.
#
# The app, server, and data scripts have ZERO runtime dependencies — they run
# on the Node.js standard library. The only dependencies are dev tooling
# (ESLint), so this hook runs `npm install` to make `npm run lint` and
# `npm test` work in the session.
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

cd "${CLAUDE_PROJECT_DIR:-.}"

# `npm ci` if the lockfile is in sync, otherwise `npm install`. Both leave a
# populated node_modules that the container caches for subsequent sessions.
echo "session-start: installing dependencies with npm..."
if [ -f package-lock.json ]; then
  npm ci || npm install
else
  npm install
fi

echo "session-start: Node $(node --version) ready — dependencies installed."
