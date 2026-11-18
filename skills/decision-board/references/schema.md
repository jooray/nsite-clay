# board.json, schema 3

Every key except `title` is optional. A board written for 0.2 builds unchanged; the first `pull`
rewrites it as schema 3.

```json
{
  "schema": 3,
  "title": "Notes app: decisions before 1.0",
  "subtitle": "Open questions from the code review.",
  "lang": "en",
  "project": { "state": "waiting_on_you", "summary": "Two decisions block the release." },
  "watch": { "until": "2026-11-18T14:00:00Z", "everyMin": 10 },
  "artifact": { "id": "6c523953", "expires": "2026-12-17T09:00:00.000Z" },
  "items": [ ... ],
  "testing": [ ... ],
  "commands": { "draft": "", "log": [ ... ] },
  "done": [ ... ],
  "next": [ ... ],
  "evidence": [ { "title": "Method", "items": ["What was read, run and tried."] } ],
  "labels": { }
}
```

- `project.state`: `on_track`, `waiting_on_you`, `blocked` or `done`. Shown as a chip with the
  summary sentence under the title. The page adds the counts ("2 to decide, 1 to test") itself.
- `watch` is written by `--watch=` on publish and push. Do not edit it by hand unless you also
  restart the watcher with the same deadline. The page prints it in the reader's time zone.
- `artifact` is written by `publish`. It holds the page id, never a link.

## items

```json
{
  "id": "cover",
  "kind": "choice",
  "title": "Which cover image?",
  "why": "One sentence on what is at stake.",
  "details": { "context": "", "decision": "", "why": "", "recommendation": "", "more": "" },
  "priority": "P0",
  "area": "design",
  "later": false,
  "layout": "grid",
  "links": ["docs/x.md", { "href": "https://example.com/draft", "label": "Draft post" }],
  "status": "open",
  "options": [
    { "id": "warm", "label": "Warm landscape", "recommended": true,
      "image": "covers/a.webp", "alt": "A sunset over hills",
      "preview": "One line of text or code.",
      "pros": ["Reads well when small"], "cons": ["Says nothing about bread"],
      "link": { "href": "https://example.com/a-full.webp", "label": "Full size" } }
  ],
  "choice": null,
  "note": ""
}
```

- `id`: lower case letters, digits and hyphens, at most 40. Unique. It becomes the form field
  names `c-<id>` (the options) and `n-<id>` (the note), so do not rename it once published.
  Older ids with other characters still work; two ids that end up with the same field name are
  an error.
- `kind`: `choice` (one answer, the default), `multi` (checkboxes, `choice` is a list) or `text`
  (no options, the answer is the note, shown as an open text box).
- `status`: `open`, `in_progress`, `shipped`, `postponed`, `rejected`, `dropped`. Anything else
  is an error. Only `open` items are cards; the rest are short rows under "Already decided".
- `priority`: `P0` to `P3`. Open cards are sorted by it, then by their order in the file.
- `details` may also be one string.
- `options[].id` is compared as a string. At most one `recommended` in a `choice`; it is
  listed first. Up to three `pros` and three `cons` are shown.
- `image`: a path relative to board.json (or absolute). webp, png, jpeg, gif, svg or avif, at
  most 150 KB each. It is put inside the page, because a page may not load anything from
  elsewhere. A web address is refused: put that in `link`. The whole page must stay under
  1 MB, because it is uploaded again on every tick the owner makes.
- `choice` and `note` are what the owner answered. `pull` fills them; you may set them too.

## testing

```json
{ "id": "sync-two-phones", "title": "Sync between two phones",
  "steps": ["Install the beta on two phones.", "Edit the same note on both."],
  "expect": "Both edits survive.", "link": null, "result": null, "note": "" }
```

`result` is `null`, `pass` or `fail` (the owner taps Works or Does not work). Field names
`t-<id>` and `tn-<id>`. Remove an entry, or move it to `done`, once you have acted on it.

## commands

`draft` is the text in the "Tell the agent" box. `pull` moves it into `log` as
`{ "id": "k3", "at": "ISO", "text": "...", "state": "new" }` and empties `draft`. You set
`state` to `doing`, `done` or `declined` and add `reply` (one line). The page shows the last
five entries under the box. Field name `agent-instructions`.

## done and next

`done`: `{ "title", "detail", "at": "ISO", "link" }`, newest last in the file; the page shows
the newest five and folds the rest. `next`: `{ "title", "detail" }` or a plain string, in order.

## labels

Every text the page itself writes can be changed per board, for example
`"labels": { "take": "Use this" }`. The keys and English defaults are `LABELS` in
`scripts/lib/render.mjs`. With `lang` (or the `language` setting) `sk`, the Slovak strings in
`locales/sk.json` apply. Another language: copy that file to `locales/<code>.json` and translate,
or put the strings in `labels`.

## 0.2 boards

- `actions` (things the owner must do) are shown as a list at the top of "Needs your testing".
- `agentInstructions` becomes `commands.draft`.
- `watch.tz` is ignored: the page shows times in the reader's own zone.
- Label names `open`, `actions`, `agent`, `agentHint` and `none` map to their new names. The old
  `done` label (the "decided" badge) is dropped.
