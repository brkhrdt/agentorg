#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE=${1:-/tmp/org-demo-workspace}
mkdir -p "$WORKSPACE"
DATA_DIR=$(mktemp -d "${TMPDIR:-/tmp}/org-demo-data.XXXXXX")
SOCKET=$DATA_DIR/server.sock
SERVER_PID=
DEMO_PID=

cleanup() {
  trap - 0 HUP INT TERM
  if [ -n "$DEMO_PID" ]; then
    kill "$DEMO_PID" 2>/dev/null || true
    wait "$DEMO_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR"
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM

(cd "$ROOT" && bun start --data-dir "$DATA_DIR") >"$WORKSPACE/org-server.log" 2>&1 &
SERVER_PID=$!

# Wait for the server socket, or report a startup failure rather than hanging.
i=0
while [ ! -S "$SOCKET" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Organization server failed to start; see $WORKSPACE/org-server.log" >&2
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 300 ]; then
    echo "Timed out waiting for server; see $WORKSPACE/org-server.log" >&2
    exit 1
  fi
  sleep 0.1
done

(cd "$ROOT" && bun run demo "$SOCKET" "$WORKSPACE") >"$WORKSPACE/org-demo.log" 2>&1 &
DEMO_PID=$!

echo "Demo is running; opening the TUI. Logs: $WORKSPACE/org-demo.log and org-server.log"
(cd "$ROOT/tui" && bun run start --socket "$SOCKET")
