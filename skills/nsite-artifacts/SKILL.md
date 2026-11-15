---
name: nsite-artifacts
description: Publish a small web page for the user and get a link to send them, such as a shopping list, todo list, packing list, trip plan, report, draft, proposal or one-off tool. The page can be private to people who have the link, editable by them in the browser, and deleted automatically after a number of days. People can comment on it by selecting words or picking a part of the page, and you read those comments, answer them and change the page. Also use it to read back what the user ticked, added or changed on a page you published earlier, to see exactly what changed, to change that page, or to take it down. Use when the user asks for a list or page they can open on their phone, share with family, review, or edit themselves.
license: MIT-0
compatibility: Needs Node.js 18 or newer, outbound network access (HTTPS and WebSocket), and a state directory that survives between sessions.
metadata:
  version: "0.3.2"
  homepage: https://nsite-clay.cypherpunk.today/
---

# nsite-artifacts

You make a page as an HTML file. The script next to this file encrypts it,
publishes it and gives you a link. You never encrypt anything yourself and you
never see or handle a key: the key is inside the link the script returns.

Run the script with Node. It sits at `scripts/artifact.mjs` in this skill's
folder. Below it is written as `artifact`:

    node <this skill's folder>/scripts/artifact.mjs <command> [options]

Every command prints one JSON object. On failure it prints a sentence on stderr
that says what to do, and exits non-zero. Read that sentence and act on it.

## The rules

1. **Send the user the `link` field, exactly as returned.** Everything after
   the `#` is the key. A link with that part cut off opens nothing.
2. **Never publish with `--visibility=public` unless the user asked for
   something public** ("post it", "anyone can see it", "for my website").
   Private things, lists, plans, anything with names, addresses, health, money
   or schedules are `link` (the default) or `private`.
3. **Do not write a link into long-term memory, a log, a summary or a commit.**
   A link is a key. To get it again, run `artifact links <id>`. Remember the
   `id` and the title instead. `create`, `update`, `share`, `rekey` and
   `links` print links as part of their answer: do not repeat them in a report
   or summary of what you did, say that you sent the link to the user.
4. **Read before you change.** If the user may have edited the page, run
   `artifact read <id>` first, then build your change on what you read. The
   script refuses an update that would overwrite an edit you have not seen.
5. **Choose an expiry and say it.** Default is 30 days. A shopping list:
   `--expires=14d`. A trip plan: a week after the trip. Something they asked to
   keep: `--expires=never`. Tell the user when the page goes away.
6. **Tell the user plainly what the link is**, once: anyone who has the link
   can open the page, and with an edit link, change it.

## A list the user can tick and edit

This is the common case. Do not write HTML for it: the script has the page.

    artifact list-page --title="Shopping" --note="For Saturday" \
        --item="Milk" --item="Bread" --item="[x] Coffee" --out=/tmp/shopping.html
    artifact create /tmp/shopping.html --edit=link --expires=14d

`--item` may repeat. `[x] ` in front marks an item as already done.
`--items=<file>` or `--items=-` reads one item per line. `--lang=sk` sets the
page language; write the title, note and items in the user's language.

`create` answers:

    { "id": "6c523953", "title": "Shopping",
      "link": "https://npub1….nsite.lol/#e=…",      <- send this one
      "readLink": "https://npub1….nsite.lol/#k=…",  <- view only, for somebody else
      "editLink": "https://npub1….nsite.lol/#e=…",
      "expires": "2026-11-27T09:16:04.000Z" }

Whoever opens `link` can tick items, edit their text, add and remove items. The
page saves itself a few seconds after each change. `readLink` shows the same
list and cannot change it.

## Seeing what the user did

    artifact status            which of my pages changed since I last read them
    artifact read <id>         the page now, as text, and what changed

`read` answers:

    { "id": "6c523953", "changed": true, "savedAt": "…",
      "changes": [ { "change": "checked", "line": "Milk" },
                   { "change": "added",   "line": "[ ] Olive oil" } ],
      "text": "# Shopping\nFor Saturday\n[x] Milk\n[ ] Bread\n[x] Coffee\n[ ] Olive oil" }

`[x]` is ticked, `[ ]` is not. `changes` lists what is different from the last
time you read it. Reading marks the page as seen; add `--peek` to look without
doing that.

Read a page when the user refers to it ("what is left on the list?", "I added
some things"), before you change it, and when a scheduled check says it
changed. Do not poll in a loop. If the user wants to be told when a page
changes, schedule `artifact status` (see Scheduling below).

`status` also lists pages under `deleted` that somebody deleted from the page
itself. Do not make them again unless the user asks.

### What exactly changed

The user may change the page with the ordinary editing tools, not only by
ticking boxes, so `read` keeps a copy of the page as you last saw it and can
show the difference:

    artifact diff <id>         what changed since you last read it, as a diff
    artifact read <id> --diff  the same, together with the text

`diff` answers with `changes` (the words and ticks, as in `read`), `markup` (a
unified diff of the page, `-` was there and `+` is there now, with a few lines
around each change) and `comments` that are new or were answered. If you changed
the page yourself with `update`, that copy is the one later changes are measured
against. A diff with nothing in it means nothing changed.

`diff`, `read` and `comments` all count as reading: afterwards the page is
"seen", and the next one of them reports only what is newer. Add `--peek` to any
of them to look without that. For a quick look at the whole page use plain
`read`, which prints it as text; `--as=html` is for editing, it writes a file and
only tells you where.

## Comments: let the user say what should be different

Every page you make that people can edit has a **Comments** button in its
corner. The user selects some words on the page and presses Comment, or picks a
part of the page, types what they want, and it is saved with the page. You read
it and act on it. This is much easier for them than describing, in a chat,
which sentence on which page they mean.

**Encourage it.** When you give the user a page that is a draft, a plan, a
proposal, a report or anything they may want changed, say once, in one sentence:
"Select any words you want changed and press Comment, and I will see it."
Send the `editLink` (or the `link` of a page made with `--edit=link`) to
whoever should comment: commenting needs the right to edit, because a comment is
saved with the page. Someone with only the read link can look but not comment.

Find the comments, do not read the page for them:

    artifact comments <id>         open comments, new ones first
    artifact comments <id> --all   resolved ones too

    { "open": 2, "resolved": 1, "comments": [
      { "id": "c7k2f9", "news": "new", "state": "open", "by": "Jana", "npub": "npub1…",
        "at": "2026-11-15T10:30:00.000Z",
        "quote": "Milk",                       <- the words they selected
        "text": "Oat milk, please.",          <- what they said
        "where": { "heading": "Shopping",     <- the section it is in
                   "block": "Milk" },         <- the paragraph or row around it
        "anchored": true, "replies": [] } ] }

`by` and `npub` say who wrote it: the profile name of a person who opened the page
as a member or signed in with their own Nostr key. A comment made through a plain
link has neither, because nobody said who they are; the commenter is nobody you
need to ask for a name. `news` is `new` for a comment you have not seen, `reply` when somebody answered
one of yours, `state` when it was resolved or reopened. A comment on a part of
the page, not on words, has the text of that part as `quote`. `anchored: false`
means the words were removed from the page; the comment still stands.

Act on a comment the way you would act on a request in chat, then close it:

    artifact reply <id> <comment> --text="Changed to oat milk." --resolve --by=Claude

That adds your answer under the comment, marks it resolved and takes the
highlight off the words, so the person sees what you did. Without `--resolve` the
comment stays open, which is right when you asked them something. `artifact
resolve <id> <comment>` and `reopen` change only the state. To change the page
itself, do it with `read --as=html`, `update` as usual, and answer the comment
afterwards; `reply` reads the page fresh and changes nothing else in it.
`--by` is the name shown under your answer; leave it out and it says Agent.

You may rewrite or delete the commented words. A resolved comment needs no
highlight: `reply --resolve` takes off whatever is left of it, so it does not
matter whether you kept the `<mark>` around your new words, and a resolved
comment showing `anchored: false` is normal. Keep the mark only for a comment
you leave open.

A comment can be short or ambiguous ("do sushi", "shorter"). Make the smallest
change that satisfies it, and say in your reply how you read it, so they can
correct you. When the choice really matters, reply **without** `--resolve` and
ask. Do not change anything the comments do not ask for.

If somebody saved the page since you last read it, `reply` tells you to look
again first.

Check for comments when the user says they have commented or looked at the page
("I left some comments", "have a look at it"), and with `status` when a
scheduled check says the page changed. Do not poll. Do not resolve a comment you
have not acted on. When you reply to several, group them into one `update` and
then reply to each.

Comments are saved in the page's markup as `<aside nc:comments hidden>` with
one `<article nc:comment="id">` each. Keep that block, and the
`<mark nc:c="…">` of every comment that is still open, when you rewrite a page
yourself, or those comments are lost.
Switch comments off for a page with `--no-comments` on `create`.

## Changing a page you published

Change only what the user asked for or what has to follow from it. If after
reading the page nothing needs to change, say so and do not `update`. If the
user edited the page themselves and something in their edit looks wrong or odd (a
time that does not fit, a figure that does not add up), leave it as they wrote it,
point it out, and ask: it may be on purpose.

    artifact read <id> --as=html --out=/tmp/page.html       answers { "file": "/tmp/page.html", … }
    (edit /tmp/page.html: add rows, change text, keep everything else as it is)
    artifact update <id> /tmp/page.html

The link stays the same. A row in a list is one `<li class="item">` element;
copy an existing one to add another. A ticked row has `checked` on its
`<input>`. If `update` says the page was changed after you last read it, run
`read` again and redo your change on the new file.

## Any other page, including an app

You are not limited to lists. Write whatever the task needs as one HTML file:
a report, a trip plan with a map drawn in SVG, a calculator, a budget table
that adds itself up, a habit tracker, a seating chart people can drag, a small
game. Scripts are welcome. An app that keeps its state in the page is the
point: the user changes it in the browser, the page saves itself, and you read
the result back.

    artifact create /tmp/report.html --expires=30d                 read only, by link
    artifact create /tmp/tracker.html --edit=link --expires=90d    an app they use and you read

What the file must be:

- **One file, nothing loaded from elsewhere.** No CDN scripts, no web fonts, no
  remote images, no analytics, no calls to an API. Put CSS in `<style>`,
  JavaScript in `<script>`, and write the script yourself instead of pulling
  in a library. The script refuses a page that loads from another site, and
  the browser would block it anyway.
- **Pictures go inside the file** as `data:` URLs, and small: an icon as inline
  SVG, a photo at most about 1200 pixels wide as JPEG or WebP. The whole page
  is uploaded on every save and must stay under 3 MB. A picture the user adds
  in the browser is made small and put inside the page automatically.
- A complete document with `<html lang="…">`, a `<title>`, and a viewport meta.
  It will mostly be opened on a phone: single column, 16px or larger text,
  large tap targets, and both light and dark colours.
- Do not add `nc:owner`, `nc:relays` or `nc:servers`, and do not link
  `/nsite-clay.js`. The script adds them.

**Give people something to change.** An edit link opens the page for the person, but
they can only change text marked `editable`, form fields, and whatever your own
script draws for that. A report with none of those cannot be edited at all; it can
be commented on (the Comments button below), which is right for a draft to review.
If they should change the words themselves, mark them: `editable="single-line"` on
a heading or a row, `editable` on a container of paragraphs. `create` and
`update` put a `warnings` list in their answer when a page has nothing to edit,
and for other things you should know. Read it every time and act on it, or tell
the user what you could not fix. Do not promise the user that they can "comment
directly" or "edit directly" on a page until you have checked that they can.

**State lives in the page's markup.** There is no server and no database. What
is in the document when it saves is what the next person sees and what you read
back. So:

- Text the user may change: `editable="single-line"` on a heading, label or
  row, or `editable` on a container for paragraphs.
- Checkboxes, text inputs, selects and textareas keep their values
  automatically. Give an input `nc:no-persist` when its value is not state (a
  search or filter box).
- State with no visible form: `nc.state.set(obj)`, `nc.state.get()`,
  `nc.state.update({ key: value })`. Do not keep state only in a JavaScript variable or in
  `localStorage`: it would not be saved and you could not read it.
- Add `nc:autosave` to `<html>` so the page saves itself a few seconds after a
  change. Without it, give the page a button with `onclick="nc.save()"`.
- After your script adds, removes or changes elements, tell the page:
  `nc.editable.refresh(); nc.dirty = true; nc.dispatchEvent(new CustomEvent("nsiteclay:autosave-now"))`.
- Anything your script draws only for the person looking (a "Saved" line, an
  open menu, a computed total you can recompute) should be created by the
  script with the attribute `nc:chrome`, so it is not saved and changing it
  does not count as an edit.
- Show what you want to read back as visible text, checkboxes or form fields.
  `artifact read` gives you the text of the page with every checkbox as
  `[x]` or `[ ]` and every field as `name: value`. `--as=html` gives you all
  of it, including `nc.state`.
- Hide editing controls from people who can only read:
  `html:not([nc\:owner-here="true"]) .my-control { display: none; }`.
- Keep the page the size of a page. No logs that grow without end.

Two people editing at the same moment: the second save is refused and that
person is told to reload. Nothing is overwritten. If the user says a change
"did not stick", that is why; tell them to reload and do it again.

`assets/list.html` is a complete working example of all of this.

## Who can open it

| The user wants | Options | What you send |
|---|---|---|
| A page for themselves or people they will forward it to | `--visibility=link` (default) | `link` |
| The same, and they can change it | `--visibility=link --edit=link` | `link` |
| Only specific people, by their Nostr key, no key in any link | `--visibility=private --edit=members --member=npub1…` (repeat `--member`) | `link` (it has no `#`); they sign in to open it |
| Some can edit, others only read | `--edit=link`, send `editLink` to editors and `readLink` to readers | both |
| Published for everyone | `--visibility=public --public` | `link` |

Use `private` only when the user gave you npubs or you know theirs. To give one
more person access later: `artifact share <id> --member=npub1…`.

An encrypted page has a small padlock button in its bottom corner. Whoever
opened it can copy its read link there; whoever can edit it also gets the edit
link, can add a person by npub, and can delete the page. Tell the user about it
when they ask how to share the page or get rid of it themselves.

**Removing someone** who already has a link or is a member cannot be done on
the same page: they hold its key. Run `artifact rekey <id> --remove=npub1…`. It
publishes the page under a new key and link, deletes the old one, and returns
the new `link` to send to everyone who should still have it.

## Taking pages down

    artifact delete <id>       now
    artifact sweep             everything past its expiry
    artifact list              what exists and when each one expires

Run `artifact delete` when the user says they are done with a page.

A page keeps only its current version: each save, yours or the user's, deletes
the one it replaces, so a list ticked a hundred times takes the space of one.

Deleting removes the page from the servers it was put on. It cannot reach a
copy somebody already saved. For an encrypted page that does not matter much:
without the link it is unreadable. For a public page, say so.

## Scheduling

Expiry only happens if `sweep` runs. Set this up once, the first time you
create a page with an expiry, and tell the user you did:

- A daily job that runs `node <this skill's folder>/scripts/artifact.mjs sweep`.
  It needs no model: use a script-only job if your scheduler has one.
- Weekly, if you keep pages for longer than a month: `artifact upgrade`, which
  moves every live page onto the runtime this script publishes with. It
  changes nothing in the pages or their links. Also script-only.
- Only if the user asked to be told about changes: a job that runs
  `artifact status` and reports to the user when its `changed` list is not
  empty. Remove it when the page is deleted.

## A page that runs an older version of the tool

Pages made before a new version of this skill do not get its newer abilities until
they are moved onto the new runtime. After you update the skill, run
`artifact upgrade` once. It only changes which files the page loads; the page,
its content and its links stay as they are. A page made by an older tool has no
Comments button until you do. If the person tells you that a page offers an
update or does not do what you said, run `artifact upgrade <id>` first.

## Settings

The user may have pointed the script at their own servers in
`~/.config/nsite-clay/artifacts/config.json`. Do not change that file and do
not pass `--relays`, `--servers` or `--gateway` unless the user tells you to.
The same folder holds `ledger.json`, which has the key of every page you made.
Never print it, copy it or send it anywhere.

## When something fails

- "no Blossom server accepted the page" or "no relay accepted": the servers are
  refusing or unreachable. Try once more. If it fails again, tell the user and
  say that their settings file decides which servers are used.
- "this page loads from …": the file pulls something from another site. Put it
  inside the file.
- "was changed after you last read it": run `read`, then redo the change.
- "no relay has … any more": it expired or was deleted. Offer to make it again.
- The user says the link does not open: check it was sent whole, including
  everything after `#`. Get it again with `artifact links <id>`.
