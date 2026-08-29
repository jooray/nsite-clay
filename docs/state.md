# Where state lives

There are two places to put things, and picking wrongly is the main way an
nsite-clay page goes bad. This is the rule.

## The two substrates

**The document.** Markup, serialised on save, stored as one Blossom blob, named
by one replaceable manifest event. One writer. Versioned. Present in the file at
rest, so `curl`, a crawler and an agent all see it without running anything.
Whole-file granularity: changing one word rewrites the page.

**Relays.** Signed events. Many writers. Per-item granularity. Addressable and
replaceable, so an item has an identity that outlives any page showing it.
Queryable by filter. Fetched at view time, so absent from the file and dependent
on a relay answering.

## The rule

Ask what the thing *is*, not where it is convenient to put it.

| The thing is | It lives in | Because |
|---|---|---|
| Layout, copy, structure | the document | it *is* the page |
| Settings for this page | the document | they belong to the file, not to a browser |
| Application state: a board's columns, a checklist, a theme | the document | the page is meaningless without it, and it has no life elsewhere |
| A blog post, a note, a photo | a relay event | it has an identity of its own and belongs in every Nostr client, not only here |
| Anything written by someone who is not the owner | a relay event | the document has exactly one signer |
| A draft, a filter, a scroll position | neither | it is not state, it is what the tab is doing right now |

The short version: **the document holds what the page is; relays hold what you
published.** A kanban board is the page. A blog post is not, and putting one in
the markup alone means Habla, njump and every other client never see it.

## Posts can be both, and usually should

This is where the two substrates stop competing.

A long-form post baked into the page is readable without JavaScript and survives
every relay going down, but it exists nowhere on Nostr. The same post as a
kind-30023 event reaches every long-form client, can be zapped and replied to,
and is editable from any of them, but a reader with scripting off sees an empty
block.

Publish it as an event, then bake a rendered copy into the page and keep the
event address next to it:

```html
<article class="post" nc:from="naddr1…">
  <h2>Hosting without a host</h2>
  <p>The manifest is a replaceable event, so publishing a new one is the deploy.</p>
</article>
```

The event is the original and the markup is a cached rendering. The page is
self-contained and crawler-visible; the post is still a first-class Nostr object.
When the event changes, the page can refresh the baked copy from `nc:from`,
because it knows where the copy came from.

Nothing forces this. A page can show a live feed and bake nothing, or bake
everything and publish nothing. Both are reasonable, and the runtime does not
pick for you.

## Three ways the document holds state

**Attributes and markup.** The default and the one to reach for first. Form
controls are written into the markup on save: `value`, `checked`, `selected`. A
checked box stays checked for the next visitor. Mark a control `nc:no-persist`
when it is a search box or a filter, where baking the last value into the file
would be wrong.

**Structure as data.** Query the DOM and let it answer. A board's cards are
`.card` elements inside `.column` elements; counting them is counting elements,
filtering by status is reading an attribute. There is no model to keep in sync
with the view, because the view is the model.

```js
const active = [...document.querySelectorAll(".task[data-status=active]")];
```

**A JSON block** for state with no visual form: a theme name, an open tab, a
layout preference.

```html
<script id="app-state" type="application/json">{"theme":"lunarpunk"}</script>
```

Read and write it with `nc.state`, which escapes correctly and marks the page
unsaved. Do not write user-supplied text into a script block by hand; a `</script>`
in the data ends the block and the rest of your page with it.

## What does not belong in the document

Anything a reader's browser produced for that reader alone: a draft, a scroll
position, a collapsed section, a filter. Put it in a JavaScript variable or
`localStorage` and let it die with the tab. Serialisation captures attributes,
so anything in `dataset` is in the published file forever, for everybody.

And nothing private. A published page is public, and the settings, the JSON
block and every attribute go out with it.
