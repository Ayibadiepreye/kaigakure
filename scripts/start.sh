#!/usr/bin/env bash
# Start Kaigakure. Kills any stale listener on the port first so a restart
# never silently serves the old code.
set -u
cd "$(dirname "$0")/.." || exit 1

PORT="${PORT:-3000}"

# Windows: free the port if something is already bound to it.
if command -v netstat >/dev/null 2>&1; then
  PIDS=$(netstat -ano 2>/dev/null | grep ":$PORT" | grep LISTENING | awk '{print $5}' | sort -u)
  for p in $PIDS; do
    echo "freeing port $PORT (pid $p)"
    MSYS2_ARG_CONV_EXCL="*" taskkill /F /PID "$p" >/dev/null 2>&1
  done
  sleep 1
fi

echo "Kaigakure -> http://localhost:$PORT"
exec node server/index.js
