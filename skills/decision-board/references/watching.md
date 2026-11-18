# Watching a board

The owner should not have to say "I answered". The agent notices.

## What a check costs

`pull` and `watch` first run `artifact status <id>`. That asks a relay for the page's newest
manifest and compares the page hash in it with the hash stored at the last read. Nothing is
downloaded and no model runs. Your own `push` stores the new hash, so it never wakes you.
Only when the hash differs does `pull` download the page and print the small delta.

## The deadline

Ask the owner how long to keep checking (see `watch.ask`, `watch.default`, `watch.choices` in
the settings). Then:

- `--watch=24h` (or `4h`, `7d`, an ISO time) on `publish` or `push` writes `watch.until` into
  board.json and the page. The page prints it in the reader's time zone and says when it ended.
- `--watch=until-decided` sets seven days; stop earlier when `undecided` and `untested` are 0.
- `--watch=off` removes it. The page then says nobody is watching.

`board.mjs watch board.json` takes the deadline from board.json. `--until=` overrides it.

## board.mjs watch

    node <skill>/scripts/board.mjs watch board.json [--every=600] [--until=ISO|24h] [--settle=45]

It runs `status` every `--every` seconds (default from the settings, 600) and exits with one
JSON line:

| exit | event | meaning |
|---|---|---|
| 0 | `changed` | the owner saved something; run `pull` |
| 2 | | bad arguments or an unknown id; nothing was checked |
| 3 | `gone`, `expired` | the page was deleted, or its expiry passed |
| 4 | `error` | five failed checks in a row, or the artifact script is missing |
| 5 | `deadline` | the watch window is over |

- **Settle.** The page saves itself a few seconds after each tick, so five answers are five
  saves. A change counts only when the last save is `--settle` seconds old (default 45).
  You wake once, after the owner stops.
- **Offline is not gone.** When no relay answers, the check counts as failed. Only a deletion
  the relays report is exit 3.
- The sleep never runs past the deadline.

## After a change

1. `pull`. Act on the delta.
2. `push --notify="..."`.
3. Run `watch board.json` again. It keeps the same deadline.

Stop when: exit 3 or 5, nothing is left undecided or untested, the owner says stop (in the
chat or in "Tell the agent"). At exit 5, `push --watch=off --notify="Automatic checking ended. Tell me in the chat when you want me to look again."`.

## With a scheduler instead

`pull board.json --settle=45` prints `{"changed":false}` and costs one relay query when
nothing happened. With `--settle` it also prints `"settling": true` while the owner is still
ticking; try again at the next run. Remove the job at the deadline.

## Without either

Publish without `--watch`. Run `pull` when the owner next writes to you.
