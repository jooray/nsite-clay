# Changelog

## 0.3.0

The first version meant for other people.

Page
- A save no longer strips the buttons, the counter and the context from the page. Before, the
  first tick removed them for everyone who opened the page afterwards.
- Rebuilding the page keeps its comments, and highlights the words of open comments again.
- New layout: the most important decisions first, a one-glance project status, "More context"
  under each card, sections for testing, what was done and what is next (only when they have
  something), and a "Tell the agent" box with the agent's answers under it.
- Picture choices in a grid, options with a preview, pros, cons and a link. Questions with a
  written answer (`kind: text`) and with several answers (`kind: multi`).
- The watch line is computed in the reader's browser and time zone, and says when checking ended.
- Text you typed but that was not saved yet comes back after a reload.
- Slovak labels in `locales/sk.json`.

Agent side
- One script, `scripts/board.mjs`: validate, build, publish, pull, push, watch.
- `pull` checks for a change without downloading anything and prints only the delta.
- The watcher is Node: an offline machine is no longer reported as a deleted page, ISO
  deadlines work, a bad argument is an error instead of a tight loop, a missing artifact
  script is reported at once, it waits until the owner stops ticking, and it never sleeps past
  the deadline. `watch.sh` still works and calls it.
- Instructions from the box are moved into a log and the box is emptied, so none is handled twice.
- Settings in `~/.config/decision-board/config.json`; a project file may set only language,
  expiry and watch. `notify.mjs` sends the message with the edit link attached, so the link
  never passes through the agent.
- With `ownerNpub`, the owner is also a member of the page and can sign in if the link is lost.
- Harness-neutral: Claude Code is one documented harness among others.

Fixed data losses
- Two ids that mapped to the same field name shared one answer. Now an error.
- An item with an unknown status disappeared from the page. Now an error.
- A numeric option id lost its choice on the next build. Ids are compared as strings.
- A non-breaking space in a note came back as the text `&nbsp;`.
- `read-back.mjs --merge board.json page.html` (flag first) erased the instructions. The
  argument order no longer matters.

Compatibility
- 0.2 boards build unchanged; the first pull rewrites them as schema 3. Field names on the page
  are the same, so 0.2 pages read back.
- `build.mjs` and `read-back.mjs` are gone: use `board.mjs build` and `board.mjs pull`.

## 0.2.0

Private version.
