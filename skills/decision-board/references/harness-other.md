# Watching from other agents

Any agent that can run Node can use this skill. What differs is how it gets woken up.

## Background command (tier 1)

If your harness can start a long-running command and resume you when it ends, start

    node <skill>/scripts/board.mjs watch board.json

and act on its exit code (table in `watching.md`). It prints one JSON line on exit and nothing
before, so it is safe to capture.

## Scheduler that starts the agent (tier 2)

A job that starts your agent every 10 minutes with a prompt such as:

    Run: node <skill>/scripts/board.mjs pull <path>/board.json --settle=45
    If it prints "changed": false, or "settling": true, stop.
    Otherwise act on the delta as the decision-board skill says, then push.

Remove the job when the deadline in board.json passes.

A plain cron job without an agent cannot act on the answers. Do not use one to run `pull`: it
would mark the change as seen and the agent would never hear of it.

## Nothing of the kind (tier 3)

Publish without `--watch`. The page tells the owner that nobody is watching and to write in
the chat when they are done. Then run `pull`.

## Asking how long to watch

Ask in the chat if your harness has no question tool. Offer the choices from
`node <skill>/scripts/config.mjs` (`watch.choices`) with the default marked.
