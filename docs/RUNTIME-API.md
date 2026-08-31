# Runtime reference

One script tag. `window.nsiteclay` (short alias `window.nc`) exists as soon as the script runs,
carrying a `ready` promise. Everything else is safe once that resolves.

```html
<script src="/nsite-clay.js"></script>
<script>
  (async () => {
    await nc.ready;
    // …
  })();
</script>
```

## Configuration: attributes on `<html>`

```html
<html lang="en" autosave
      nc:owner="npub1…"
      nc:relays="wss://nos.lol,wss://relay.primal.net,wss://nostr.mom"
      nc:servers="https://cdn.hzrd149.com,https://blossom.primal.net">
```

| Attribute | Required | Meaning |
|---|---|---|
| `nc:owner` | yes | npub or 64-hex of the key allowed to save this document |
| `nc:relays` | no | comma list. Default `wss://nos.lol,wss://relay.damus.io,wss://relay.primal.net` |
| `nc:servers` | no | comma list of Blossom servers. Default `https://cdn.hzrd149.com,https://blossom.primal.net` |
| `nc:site` | no | nsite `d` tag. Absent means the root site (kind 15128); set means a named site (kind 35128), 1 to 13 characters of `[a-z0-9-]` |
| `nc:path` | no | this document's path inside the manifest. Default `/index.html` |
| `autosave` | no | save once edits settle (2.5 s debounce, 15 s throttle). `⌘S` / `Ctrl+S` works either way |
| `nc:autoreload` | no | `"false"` stops the document watching its manifest for newer versions |
| `nc:runtime-owner` | no | whose runtime this page will offer to upgrade to. Default is the project's own key; `"off"` never looks |
| `nc:watch-dom` | no | count any DOM change as an edit, not only typing. Off by default: a page that redraws itself would be permanently unsaved |

Unknown `nc:*` attributes are ignored, so a document written for a later version still renders.

The runtime writes these back onto `<html>` for the document's own CSS and logic, and strips
every one of them from anything it saves:

`nc:ready`, `nc:status` (`idle` / `saving` / `saved` / `error`), `nc:pubkey`,
`nc:owner-here` (`true` / `false`), `nc:editmode`, `nc:editable`, `nc:outdated`.

```css
html[nc\:status="saving"] .dot { animation: pulse 1s infinite; }
html[nc\:owner-here="true"] .owner-only { display: block; }
```

## Members

```js
await nc.ready                     // resolves to nc
nc.cfg                             // the parsed configuration
nc.pubkey / nc.npub / nc.isOwner
nc.status                          // idle | saving | saved | error
nc.dirty                           // set true to suppress auto-reload while work is unsaved

await nc.login("auto")             // "nip07" | "nip46" | "bunker" | "nsec"
await nc.login("nsec", { key, password })     // nsec1…, 64 hex, or ncryptsec1… + password
await nc.login("bunker", { uri })             // bunker://…
const { uri, ready } = nc.connectRemote()     // nostrconnect:// for Amber; await ready
await nc.logout()

nc.getHTML()                       // the exact string a save would store
await nc.save()                    // → { hash, bytes, manifest, version, aggregate }
                                   //   or { skipped: true } when nothing changed
await nc.save({ extraPaths, dropPaths })      // publish other files in the same manifest.
                                   //   A drop the document still references is refused
await nc.publishFiles(files, { servers, relays, onProgress })   // a whole site, from the browser
// onProgress stages: "upload" { path, done, total }, "server" { server, state, detail },
// "manifest" { uploaded, reused }. Server states: checking, present, absent, signing,
// sending, ok, failed. Every network call has a timeout (nc has none to override;
// blossom.js TIMEOUTS: head 20s, get 60s, put 120s, signer 180s)
await nc.currentManifest()         // the live nsite manifest event
await nc.versions()                // kind-5128 snapshots, newest first
await nc.readVersion(snap)         // that version's HTML, fetched and hash-verified
await nc.restore(snap)             // republish that version's path table as current

nc.editable.enable() / .disable()  // re-run enable() after inserting new [editable] nodes
nc.editable.block("H2")            // what the block menu calls
nc.reloadToLatest()                // reload through a URL no cache can satisfy

// blocks: a page built out of markup rather than out of rows
nc.blocks.open() / .add(name, { container, before })
nc.blocks.partsOf(block)           // what is inside one, depth-first, furniture excluded
nc.blocks.parts(block)             // and the dialog that lists it, with remove and reorder

// moving a published site to a newer runtime
nc.version                         // the version of the engine this page is running
await nc.upgrade.check()           // → a plan, or null when there is nothing newer
await nc.upgrade.prompt()          // check, then offer it; what Settings calls
nc.unstamp(path) / nc.stamp(path, hash)   // the content stamp in an asset URL

// structure: the DOM is the database, these are the operations on it
nc.dom.clone(el) / .remove(el) / .move(el, +1|-1, selector)   // move reorders in one parent
nc.dom.moveTo(el, container, "beforeend")                    // and this crosses parents
nc.dom.insert(target, html, "beforeend") / .addFrom("template-id", container)
nc.dom.toggle(el, "hidden") / .set(el, "data-status", "done")
nc.dom.cloneClosest(btn, ".card")        // from a control inside the block
nc.dom.removeClosest(btn, ".card") / .removeClosestAsk(btn, ".card", "this card")
nc.dom.moveClosest(btn, -1, ".card") / .toggleClosest(btn, ".card", "hidden")
nc.dom.moveToClosest(btn, ".card", ".col", +1|-1)   // walk a card along the columns
nc.dom.all(".card") / .by(".card", "data-status")   // reading it back

// state with no visual form, kept in a JSON script block in the page
nc.state.get() / .set({…}) / .update({…})           // optional id, default "app-state"

// a generated form for the page, from a <script type="application/json" nc:cms> block
nc.cms.open() / .close() / .toggle() / .isOpen / .rules()

// a published post, rendered into the page and stamped with its address
nc.compose.bake(event, container) / .refreshBaked() / .addressOf(event)

nc.addDocumentTransform(fn)        // fn(clone, doc) runs on the save clone
nc.addEventListener("nsiteclay:status", handler)
// also: ready, login, logout, connect-uri, outdated
```

Helpers re-exported for convenience: `nc.nip19`, `nc.verifyEvent`, `nc.sanitize`,
`nc.sanitizeAs`, `nc.hashText`, `nc.fetchVerified`, `nc.LocalSigner`.

## Upgrading a published page

A deployed document hardcodes the URLs of the three shared files it runs on, and a gateway serves
those with a cache lifetime, so the published copy is pinned to the engine it was published with.
That is the right default — a site that changed under its owner would not be theirs — but it needs
a door.

The door is Nostr. The project publishes its own nsite; that manifest is a signed event naming
content-addressed blobs; `fetchVerified` re-hashes whatever a Blossom server returns before
believing a byte of it. So a server cannot lie, and the only thing being trusted is the key named in
`nc:runtime-owner`. The new bytes are stored on **the owner's own** Blossom servers and named in
**the owner's own** manifest, so afterwards nothing of anybody else's is in the path.

It is never automatic. An owner who opens the page for editing is shown a notice, and Settings has
the same offer behind a button; a reader triggers neither. The offer lives in a dialog the runtime
draws rather than on the toolbar, because the toolbar is markup in the document: a page published
before a button existed would never grow one.

An upgrade replaces the engine, the toolbar script and the stylesheet. It does not rewrite the
document — the template's own CSS, its `<template nc:block>` library and its toolbar buttons are the
author's page. Version history keeps the old path table either way, so a restore undoes it.

## Editing markup

```html
<h1 editable="single-line">A title</h1>       <!-- Enter suppressed, no block menu -->
<div editable>                                 <!-- Enter starts a new paragraph -->
  <p>Type here. Select text to raise the toolbar.</p>
</div>
```

Tokens combine: `single-line`, `no-toolbar`, `toolbar-on-select`, `no-markdown`.
Editable containers arm for the owner on login and disarm on logout; `<html nc:editable="true">` while armed.

Toolbar: block menu (Paragraph, Heading 1 to 3, Quote, Code block), bold, italic, strikethrough,
bulleted list, numbered list, link, clear formatting.

Keys: `⌘B` `⌘I` `⌘U` `⌘K`, `⌘⇧7` / `⌘⇧8` / `⌘⇧9` for numbered list, bulleted list and quote,
`⌥0` to `⌥3` for the block types.

Input rules at the start of a block: `# `, `## `, `### `, `- `, `1. `, `> `, ` ``` `.

A save keeps the `editable` attribute as an inert marker and drops the rest: no
`contenteditable`, no toolbar, no editor debris in the markup.

## Save markers

| Marker | Effect |
|---|---|
| `clay="no-save"` or `no-save` | never written to the file |
| `clay="no-snapshot"` or `no-snapshot` | never leaves the live page |
| `nc:chrome` | runtime UI; always stripped |
| `nc:keep-editable` | keep `contenteditable` on this element in the saved file |
| `nc:no-persist` | a form control whose value is not written into the file |
| `nc:baked` | where `bake()` puts a post when no container is named |
| `nc:from` | on a baked post: the `naddr` or `nevent` it was rendered from |

Form state is written into markup before serialising, so inputs, checkboxes and selects survive
a save: a checked box is still checked for the next visitor, which is what makes the document a
database. Password and file inputs never are, and `nc:no-persist` opts a search box or a filter
out.

Where a given thing belongs, in the document or on relays, is
**[docs/state.md](state.md)**.

State that should not persist belongs in a JavaScript property or a `WeakMap`, not an
attribute. Serialising captures attributes, so anything in `dataset` is in the file forever.
