# What every template must do

A template is one `index.html`. It links the shared stylesheet and the shared
runtime, both from the site root, and it does not carry a copy of either:

```html
<link rel="stylesheet" href="/nsite-clay-base.css">
...
<script src="/nsite-clay.js"></script>
```

That is the whole reason the shared files exist. Changing the engine or the
chrome should mean editing `templates/_shared/`, never ten template files.

## The root element

```html
<html lang="en"
      nc:owner="npub1…"
      nc:edit-gate="hash"
      nc:relays="wss://nos.lol,wss://relay.primal.net,wss://nostr.mom,wss://relay.nsite.lol"
      nc:servers="https://cdn.hzrd149.com,https://blossom.primal.net">
```

`nc:edit-gate="hash"` is required in every template. A reader gets the page and
nothing to click; the owner adds `#edit` to the URL and the controls appear.

Do not add `autosave`. It is off on purpose: every save stores the whole page
again and files a version.

`nc:watch-dom` is optional and off by default. It makes any DOM change count as
an edit rather than only typing, which a page whose own script edits it wants and
a page with a carousel or a clock in it very much does not.

`nc:runtime-owner` is optional and is best left out. Absent, a published page
offers its owner the project's own newer runtime when one exists; set it to your
own key if you fork the engine, or to `"off"` to never look. It is only ever an
offer — nothing upgrades itself.

## The toolbar

Copy this verbatim, near the end of `<body>`. The classes come from the shared
stylesheet, `nc-ui-chrome` is what the edit gate hides, and `nc:chrome` is what
keeps it out of the saved file only when the runtime injected it (this one is
authored markup and stays).

```html
<div class="nc-bar nc-ui-chrome">
  <span class="nc-dot"></span>
  <span class="nc-who" data-nc-who>read-only</span>
  <button data-nc-signin>Sign in</button>
  <button class="nc-owner-only" data-nc-write>Write</button>
  <button class="nc-owner-only" data-nc-cms>Edit content</button>
  <button class="nc-owner-only" data-nc-settings>Settings</button>
  <button class="nc-owner-only" data-nc-history>History</button>
  <button class="nc-primary nc-owner-only" data-nc-save>Save</button>
</div>
<p class="nc-edit-hint">add #edit to the URL to edit this page</p>

<script src="/nsite-clay.js"></script>
<script src="/nsite-clay-chrome.js"></script>
```

`nsite-clay-chrome.js` wires those buttons. A template writes no sign-in code,
no save handler and no version dialog of its own.

`data-nc-cms` opens the form generated from the page's `nc:cms` rules. Leave the
button in whether or not the page has any: the shared stylesheet hides it until
there is a rules block to draw, so a page that grows one later gets the button
without the markup changing.

## Editable regions

- `editable="single-line"` for a heading, a title, a caption, a list row.
- `editable` on a container for prose, where Enter makes a paragraph.

Use `single-line` for anything whose element is inline — a button's `<a>`, a
`<cite>`, a `<span>`. Those cannot legally hold a paragraph, and the runtime
relies on the token to keep one out: it pastes text rather than markup there, and
hides the controls that would make a block.

Mark everything an owner would plausibly want to change. A template nobody can
edit without opening a text editor has missed the point.

## Contextual controls

A page that is a board or a list needs more than typing. Put the controls on the
thing they act on and mark them `nc-gear`, so they appear only for a signed-in
owner who is editing:

```html
<article class="card" data-status="active">
  <h3 editable="single-line">Fix Blossom sync</h3>
  <menu class="nc-gear nc-gear-row">
    <button type="button" onclick="nc.dom.cloneClosest(this, '.card')">Duplicate</button>
    <button type="button" onclick="nc.dom.moveClosest(this, -1, '.card')">Up</button>
    <button type="button" onclick="nc.dom.removeClosestAsk(this, '.card', 'this card')">Delete</button>
  </menu>
</article>
```

**Do not put `clay="no-save"` on a gear.** That strips it from the save, so the
pattern works exactly once and the published page has no controls. A gear is part
of the app and belongs in the file; the rules above are what keep it away from
readers. `clay="no-save"` is for markup that must never be written at all, such as
a composer holding a half-typed line, and a control drawn by a script that itself
persists is the way to have both.

`nc-gear` sets visibility only; `nc-gear-row` adds the usual row layout, so a
control shaped differently can lay itself out without out-specifying anything.

`nc.dom` arms new markup for editing and marks the page unsaved, so a control is
one attribute rather than a closure. It calls `nc.editable.refresh()` for you;
you only need it yourself for markup you inserted some other way. State with no visual form goes in a JSON
block through `nc.state`. What belongs in the document and what belongs on relays
is [docs/state.md](../../docs/state.md).

## Blocks

A template whose page is *assembled* rather than typed over declares a block
area and a library of shapes. Mark the container:

```html
<main nc:blocks>
  <section nc:block-type="heading"><h2 editable="single-line">A heading</h2></section>
</main>
```

Every direct element child of that container is a block. In edit mode the
runtime draws a rail on each one (move, duplicate, configure, delete) and an
insert point between them, and the palette is built from the library:

```html
<template nc:block="picture" nc:label="Picture" nc:icon="▥"
          nc:group="Media" nc:on-add="image" nc:hint="Upload one or paste a URL.">
  <section class="b-picture">
    <figure>
      <img nc:slot src="…" alt="">
      <figcaption editable="single-line">Caption</figcaption>
    </figure>
  </section>
</template>
```

A `<template>` renders nothing and is saved with the page, so the library
travels with the document: whoever inherits the file can keep adding blocks
without fetching anything. `nc:block` is the name, stamped onto each copy as
`nc:block-type`. `nc:on-add` names a picker to run once the block lands, and
`nc:slot` marks the element that picker acts on:

| `nc:on-add` | what opens | what `nc:slot` should be |
|---|---|---|
| `image` | the picture picker | the `<img>` to fill |
| `video` | the video picker | the element to replace |
| `feed`  | the Nostr feed picker | anything; it looks for `[nc:feed]` first |
| `post`  | your published posts | the block itself, which receives the copy |

Backing out of that picker removes the block again, so a cancelled "add a
picture" does not leave an empty frame behind.

The rail is drawn by the runtime and marked `nc:chrome`, so it never reaches a
save. That is the opposite of the gear rule above, and deliberately: a gear is
particular to the thing it sits on and belongs in the file, whereas a rail
identical above every block would be the same buttons copied into the document a
dozen times, growing with the page and going stale the moment the runtime
changes. Use a gear for a control that is about *this* card; the rail already
covers move, duplicate and delete.

The two mix freely. `templates/cms/index.html` ships both: rails on the blocks,
and authored gears inside the gallery and the card grid for "add another one of
these".

Style blocks through their own classes. The rails and the palette follow the
variables like everything else, so a template that sets them gets controls that
match without touching them.

## Nostr content

Feeds are markup, so a template can ship one already configured:

```html
<div nc:feed="articles" nc:authors="npub1…" nc:limit="4" nc:style="grid"></div>
```

Style them by overriding `.nc-item`, `.nc-title`, `.nc-by` and friends. The
shared stylesheet defines them against the variables, so a template that sets
its variables gets a feed that matches without touching feed markup.

`nc:open-with` decides what a click on a post does. Left out, it reads the post
in the page: the feed already fetched the event to draw the card, so the reader
opens with no relay round trip, and closing it is an overlay coming off rather
than a navigation, so the page underneath has not moved.

| value | what a click does |
|---|---|
| absent, or `reader` | opens it in the page |
| `yakihonne` | `yakihonne.com/article/<naddr>`, `yakihonne.com/note/<nevent>` |
| `primal` | `primal.net/a/<naddr>`, `primal.net/e/<nevent>` |
| `njump` | `njump.me/<naddr>` or `njump.me/<nevent>` |
| a URL | your own, with `{id}`, `{npub}`, `{kind}` and `{d}` filled in |

An article and a note are not at the same path in any of them, which is why this
is a name rather than a URL you assemble yourself. The reader still puts a real
link in the href, so a middle click and a reader with scripting off both work.

Style the reader by overriding `.nc-read-card`, `.nc-read-title` and
`.nc-read-body`. It follows the variables like everything else.

## Variables

Set these on `:root` and the shared chrome follows the template:

`--nc-ink`, `--nc-ink-dim`, `--nc-bg`, `--nc-panel`, `--nc-edge`, `--nc-accent`,
`--nc-accent-ink`, `--nc-ok`, `--nc-bad`, `--nc-radius`, `--nc-radius-sm`,
`--nc-shadow`, `--nc-chrome-font`, `--nc-mono`.

They reach every surface the runtime draws: the toolbar, the sign-in and
settings dialogs, the version list, the media and feed pickers, the floating
text toolbar, the toasts and the feeds. A page with square corners and no
shadows sets `--nc-radius: 0`, `--nc-radius-sm: 0` and `--nc-shadow: none`, and
the chrome squares off with it.

## Writing

Every word a reader sees goes through the same rules as the rest of the
project: no em or en dashes, no "there are several ways to", no announcing what
the next sentence will do. Write like a person who has used the thing.

## What a template must not do

- No CDN links, no web fonts from a third party, no analytics. A page that
  phones home is not a page you own.
- No copy of `nsite-clay.js` or the base stylesheet.
- No `autosave`.
- Nothing that only works while JavaScript runs, other than the Nostr feeds. A
  template read with scripting off should still be a readable page.

## Gears

`.nc-gear` hides with `!important`, and the rule that reveals it for a
signed-in owner restores it the same way. A page's own stylesheet loads after
the shared one, so without that a gear carrying a page class with its own
`display` would show its controls to every reader: the failure was silent and
it failed open, which is the wrong direction.

The consequence is that `class="nc-gear my-toolbar"` will not pick up
`.my-toolbar { display: flex }`. Use `nc-gear-row`, which is a wrapping flex
row, or write the layout against the armed selector yourself:

```css
html[nc\:owner-here="true"][nc\:editing="true"] .my-toolbar { display: grid; }
```

Do not put `clay="no-save"` on a gear. It belongs in the file.
