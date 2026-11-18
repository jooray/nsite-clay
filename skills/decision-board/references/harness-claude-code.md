# Watching from Claude Code

Claude Code can run a command in the background and re-invokes the agent when it exits. That
is tier 1 in `watching.md`.

1. After `publish` or `push` with `--watch=`, start the watcher with the Bash tool and
   `run_in_background: true`:

       node <skill>/scripts/board.mjs watch board.json

   Do not poll it, do not sleep. You are woken when it exits.
2. On exit 0, run `board.mjs pull board.json` yourself. The delta is a few lines, so a
   subagent is not needed. If you delegate anyway, give the subagent the board path, never a
   link.
3. Act, `push --notify="..."`, and start the watcher again (step 1). It keeps the deadline.
4. To stop early (the owner says stop, everything is answered), stop the background task with
   the task stop tool and do not start it again. On exit 5, push with `--watch=off`.

If the session ends, the watcher dies with it, and the page keeps showing its deadline. At the
next session, `pull` first, then either restart the watcher or push with `--watch=off`.

## With /loop instead

`/loop 10m` with a prompt that runs `board.mjs pull board.json --settle=45` and continues only
when it prints `"changed": true` without `"settling"`. End the loop at the deadline.

## Asking how long to watch

Use the question tool with the choices from `config.mjs` (`watch.choices`), the default marked
as recommended, for example "24 hours (Recommended)", "Until everything is answered",
"4 hours", "7 days".
