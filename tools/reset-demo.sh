#!/usr/bin/env bash
# Put the public demo back to what the repository says it should be.
#
# The demo's key is published on purpose, so anyone can rewrite that page. That
# is the point of it, and it means the page is whatever the last visitor left
# behind. This runs weekly and restores the version in git.
#
# A week where nobody edited the demo costs nothing. The blobs are content
# addressed and already on the servers, so deploy uploads none of them and
# publishes no event at all. See the note further down.
#
# Install:
#
#   git clone https://github.com/jooray/nsite-clay.git ~/projects/nsite-clay
#   crontab -e
#   # nsite-clay: put the public demo back to the version in git, weekly.
#   30 4 * * 1 ~/projects/nsite-clay/tools/reset-demo.sh >> ~/log/nsite-clay-reset-demo.log 2>&1
#
# It writes to stdout and stderr and lets cron place the log, which is how the
# other jobs on this host work.
set -euo pipefail

# cron gets a bare PATH, and node, npm and flock live under linuxbrew here. The
# other jobs solve this by sourcing ~/.path, so do the same and carry on if the
# file is absent, which it will be on any other machine.
# shellcheck disable=SC1090
[ -f "$HOME/.path" ] && source "$HOME/.path"

REPO="${NSITE_CLAY_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/nsite-clay"

# The demo key is public and printed on the project's own homepage. It is here
# rather than in a secret file because treating it as a secret would be a lie,
# and because a cron job that depends on a secret is one that quietly stops.
DEMO_NSEC="${NSITE_DEMO_NSEC:-nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y}"

mkdir -p "$STATE"
say() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Two runs at once would race each other to publish. Skip rather than queue:
# next week comes round soon enough.
exec 9>"$STATE/reset-demo.lock"
if ! flock -n 9; then say "another run holds the lock, skipping"; exit 0; fi

say "reset starting in $REPO"
cd "$REPO"

# Whatever is in the working tree loses. This host publishes what main says.
git fetch --quiet origin main
BEFORE="$(git rev-parse HEAD)"
git reset --quiet --hard origin/main
AFTER="$(git rev-parse HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then say "already at ${AFTER:0:12}"
else say "moved ${BEFORE:0:12} to ${AFTER:0:12}"; fi

# Only reinstall when the lockfile actually moved. npm ci every week is minutes
# of nothing, and it turns a network hiccup into a failed reset.
HASHFILE="$STATE/package-lock.sha"
NOW="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -f "$HASHFILE" ] || [ "$NOW" != "$(cat "$HASHFILE")" ] || [ ! -d node_modules ]; then
  say "installing dependencies"
  npm ci --silent
  printf '%s' "$NOW" >"$HASHFILE"
fi

say "building"
npm run --silent demo:build

# Publishing an empty page over a working one would be worse than doing nothing.
if [ ! -s demo-dist/index.html ]; then
  say "FAILED: demo-dist/index.html is missing or empty, publishing nothing"
  exit 1
fi

# The key goes through the environment. On argv it would be visible to every
# other process on the box through ps, which is a habit worth keeping even for a
# key that does not matter.
# deploy asks each Blossom server whether it already serves a blob before
# uploading it, and stops before publishing when the path table still hashes to
# what the live manifest says. So the usual run, where nobody edited the demo and
# every blob is still served, writes nothing to the relays. It publishes only
# when the page actually changed, or when a server dropped a blob and it had to
# be put back.
say "publishing $(find demo-dist -type f | wc -l | tr -d ' ') files"
NOSTR_SECRET_KEY="$DEMO_NSEC" node bin/nsite-clay.mjs deploy demo-dist
say "done"
