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
await nc.currentManifest()         // the live nsite manifest event
await nc.versions()                // kind-5128 snapshots, newest first
await nc.readVersion(snap)         // that version's HTML, fetched and hash-verified
await nc.restore(snap)             // republish that version's path table as current

nc.editable.enable() / .disable()  // re-run enable() after inserting new [editable] nodes
nc.editable.block("H2")            // what the block menu calls
nc.reloadToLatest()                // reload through a URL no cache can satisfy

nc.addDocumentTransform(fn)        // fn(clone, doc) runs on the save clone
nc.addEventListener("nsiteclay:status", handler)
// also: ready, login, logout, connect-uri, outdated
```

Helpers re-exported for convenience: `nc.nip19`, `nc.verifyEvent`, `nc.sanitize`,
`nc.sanitizeAs`, `nc.hashText`, `nc.fetchVerified`, `nc.LocalSigner`.

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

Form state is written into markup before serialising, so inputs, checkboxes and selects survive
a save. Password and file inputs never are.

State that should not persist belongs in a JavaScript property or a `WeakMap`, not an
attribute. Serialising captures attributes, so anything in `dataset` is in the file forever.
