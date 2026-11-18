#!/bin/sh
# Kept for sessions started with decision-board 0.2: watch.sh <id> [interval_seconds] [until].
# The watcher itself is "board.mjs watch"; see its header for the exit codes.
exec node "$(dirname "$0")/board.mjs" watch "$1" --every="${2:-600}" ${3:+--until="$3"}
