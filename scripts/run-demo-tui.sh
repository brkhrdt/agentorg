#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 SERVER_REPO TUI_REPO [WORKSPACE]" >&2
  exit 2
fi

SERVER_REPO=$(CDPATH= cd -- "$1" && pwd)
TUI_REPO=$(CDPATH= cd -- "$2" && pwd)
WORKSPACE=${3:-/tmp/org-demo-workspace}
DATA_DIR=${TMPDIR:-/tmp}/org-demo-data
mkdir -p "$WORKSPACE" "$DATA_DIR"
SOCKET=$DATA_DIR/server.sock
INITIALIZE_ORG=0
if [ ! -f "$DATA_DIR/organization.sqlite" ]; then
  INITIALIZE_ORG=1
fi
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
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM

(cd "$SERVER_REPO" && bun start --data-dir "$DATA_DIR" --recover) >"$WORKSPACE/org-server.log" 2>&1 &
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

if [ "$INITIALIZE_ORG" -eq 1 ]; then
  (cd "$SERVER_REPO" && bun run demo "$SOCKET" "$WORKSPACE") >"$WORKSPACE/org-demo.log" 2>&1 &
  DEMO_PID=$!
fi

echo "Demo is running; opening the TUI. Logs: $WORKSPACE/org-demo.log and org-server.log"
(cd "$TUI_REPO" && bun run start --socket "$SOCKET")
