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
  <button class="nc-owner-only" data-nc-settings>Settings</button>
  <button class="nc-owner-only" data-nc-history>History</button>
  <button class="nc-primary nc-owner-only" data-nc-save>Save</button>
</div>
<p class="nc-edit-hint nc-ui-chrome">add #edit to the URL to edit this page</p>

<script src="/nsite-clay.js"></script>
<script src="/nsite-clay-chrome.js"></script>
```

`nsite-clay-chrome.js` wires those buttons. A template writes no sign-in code,
no save handler and no version dialog of its own.

## Editable regions

- `editable="single-line"` for a heading, a title, a caption, a list row.
- `editable` on a container for prose, where Enter makes a paragraph.

Mark everything an owner would plausibly want to change. A template nobody can
edit without opening a text editor has missed the point.

## Nostr content

Feeds are markup, so a template can ship one already configured:

```html
<div nc:feed="articles" nc:authors="npub1…" nc:limit="4" nc:style="grid"></div>
```

Style them by overriding `.nc-item`, `.nc-title`, `.nc-by` and friends. The
shared stylesheet defines them against the variables, so a template that sets
its variables gets a feed that matches without touching feed markup.

## Variables

Set these on `:root` and the shared chrome follows the template:

`--nc-ink`, `--nc-ink-dim`, `--nc-bg`, `--nc-panel`, `--nc-edge`, `--nc-accent`,
`--nc-accent-ink`, `--nc-ok`, `--nc-bad`, `--nc-radius`, `--nc-chrome-font`,
`--nc-mono`.

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
