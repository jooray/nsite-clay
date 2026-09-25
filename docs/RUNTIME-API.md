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

An image can declare `nc:crop="1:1"`, `"16:9"`, `"4:3"` or `"free"` to select
the initial crop mode in its image picker. This affects new file uploads only.
`await nc.media.crop(file, { aspect: 1 })` returns quickcrop's `{ blob, width,
height, dataURL }`, or `null` on cancellation. Crops are capped at 2560 pixels
on either axis. The original file stays untouched.

The runtime writes these back onto `<html>` for the document's own CSS and logic, and strips
every one of them from anything it saves:

`nc:ready`, `nc:status` (`idle` / `saving` / `saved` / `error`), `nc:pubkey`,
`nc:owner-here` (`true` / `false`), `nc:editmode`, `nc:editable`, `nc:outdated`.

```css
html[nc\:status="saving"] .dot { animation: pulse 1s infinite; }
html[nc\:owner-here="true"] .owner-only { display: block; }
```

## Members

### Content fields and data

The existing `nc:cms` rules accept `@innerHTML` for rich text. The content form
shows an editable rich-text field and sanitises its output. Other fields can
declare `nc:cms-type="select|number|date|time|url|email|color|textarea"` on the
target element. A select uses `nc:cms-options='["draft","published"]'` or a
list of `{ "value": "draft", "label": "Draft" }` objects. Native constraints
use `nc:cms-min`, `nc:cms-max`, `nc:cms-step`, `nc:cms-required`,
`nc:cms-pattern` and `nc:cms-maxlength`; invalid input leaves the page unchanged.

`nc.cms.getData(name = "cms")` reads scalar fields, nested groups and lists.
`nc.cms.setData(partialValues, name = "cms")` validates all targets before
changing them, requires the owner, and records one undo step. Lists must match
their current length; their existing Add and Remove controls change structure.
Template seeds are excluded from data. No JSON sidecar is published automatically.

### Source-preserving saves

`nc.source.ready` settles after fetching and pairing the source HTML. A save
before it settles uses the full serializer. `nc.source.text()` returns the
source string, and `nc.source.locate(element)` returns `{ from, to, line,
column }` or null for an unpaired element. Offsets are UTF-16 code units, not
UTF-8 bytes. Pairings describe the loaded or last accepted source, not an
unsaved replacement node.

The renderer verifies every output against the cleaned save document. On a
mismatch it uses the full serializer and emits `nsiteclay:save-reprinted` with a
reason. `nc.source.reprints` counts those fallbacks. Blossom still stores the
whole document after a change; this preserves author formatting, not storage quota.

### Undo

`nc.undo.undo()` and `nc.undo.redo()` navigate the current editing session.
`nc.undo.commit(label, fn)` groups a synchronous DOM change into one step;
`nc.undo.flush()` ends a typing batch. `canUndo` and `canRedo` report availability.
Recording runs only while the owner is editing. Runtime chrome, fetched content
and no-save regions are excluded. Plain form fields keep native typing undo;
property-only changes made by scripts can call `nc.undo.recordValue(element,
{ prop: "value", oldValue, newValue })`. History clears on sign-out or leaving edit mode.

### Common operations

`nc.ai.settings()` opens the AI settings hub, with provider/model configuration
under Advanced and backup/recovery in its own section. `nc.ai.addCredit()` opens
the focused Lightning/Cashu flow; `nc.ai.withdraw()` opens withdrawal. `nc.ai.client`
is the OpenAI-compatible client; its default base is
`https://routstr.cypherpunk.today/v1` and its default model is
`deepseek-v4-1-flash`. Settings and endpoint-bound credentials are kept locally
and backed up by `nc.ai.keepOnRelays()` to the owner's encrypted vault. The vault
keeps the legacy `ai[endpoint]` key map plus `aiProfiles[endpoint]` with `mode`,
`base` and `model`, and `aiSelected` for fresh-device restoration. `nc.ai.adopt()`
restores the complete profile; `{ force: true }` requests an explicit restore.
Backup failure returns false and the dialogs show recovery instructions.
`models()`, `balance()`, `cashu(token)`, `invoice(sats)`, `invoiceStatus(invoice)`
and `refund()` use that explicit endpoint. No node discovery or automatic retry
of paid requests occurs. `complete(messages, { signal, onProgress, maxTokens })`
streams text but only resolves for a complete response with `finish_reason: stop`.
Raw stream fragments must never be applied to the live document.

`await nc.ai.client.check()` returns readiness, available Routstr sats after
reservations, and current model pricing when available. States are `noKey`,
`ready`, `insufficient`, `invalidKey`, `modelMissing`, `unavailable`, and
`configured` for BYOK. BYOK has no standard balance API. Unknown balance is not
reported as zero. Cost ranges are estimates, not provider quotes or spending caps.

`await nc.ai.edit(element)` opens the prompt and preview flow, including proposed
version refinement, comparison, and locally recovered drafts. Omitting the element
selects the whole static page. Live feeds go to the model as numbered
`nc:keep` places and come back exactly as they were; a rewrite that leaves one
out is refused. Pages with forms or custom scripts offer element editing
instead. For a custom UI,
`await nc.ai.propose(element, prompt, { signal })` returns a proposal and
`nc.ai.accept(proposal)` applies it as one undo step. Both require the owner.
Acceptance refuses a target changed since generation began. Only the selected
element goes to the model. Scripts, live feeds and whole-document elements are
excluded from element proposals. `nc.ai.proposePage(prompt, options)` returns
`{ page, before }`; `nc.ai.applyPage(page, { before })` checks ownership and the
original snapshot before replacing the page as one undo step.

`nc.ai.drafts.read(kind)`, `.write(kind, draft)`, `.clear(kind)` and
`.import(kind, jsonText)` manage local drafts. Kinds are `edit` and `builder`.
Storage is scoped to the signed-in pubkey, document path and workflow, keeps up
to five proposed versions, and reports write failure without discarding memory.
Draft files are sanitised again before preview or acceptance. They contain page
content and instructions, not provider credentials, and never enter the published
document or the relay vault.

`await nc.ai.buildPage(description, { template, lang, signal, onProgress })`
generates a static document. Omit `template` to start from scratch.
`nc.ai.preparePage(html, { owner, path, lang })` sanitises a completed document,
assigns the publisher's ownership/path, and supplies runtime references, toolbar,
editable regions, CMS rules and a fallback block library. It removes generated
scripts and forms, and CSS that reaches off the page. It refuses a document that
carries no stylesheet, because that one publishes as unstyled text.
`nc.ai.previewHTML(html)` adds a restrictive CSP for display in an iframe with an
empty `sandbox` attribute. Preparing or previewing never publishes anything.

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
| `nc:transient` | put on the page at view time, by a feed or your own script; never written to the file, not an undo step, not an edit to autosave |
| `nc:chrome` | runtime UI; always stripped |
| `nc:keep-editable` | keep `contenteditable` on this element in the saved file |
| `nc:no-persist` | a form control whose value is not written into the file |
| `nc:baked` | where `bake()` puts a post when no container is named |
| `nc:from` | on a baked post: the `naddr` or `nevent` it was rendered from |

Form state is written into markup before serialising, so inputs, checkboxes and selects survive
a save: a checked box is still checked for the next visitor, which is what makes the document a
database. Password and file inputs never are, and `nc:no-persist` opts a search box or a filter
out.

A page with a form, whose visitors type something and get an answer back, is worked
through in **[docs/forms.md](forms.md)**.

Where a given thing belongs, in the document or on relays, is
**[docs/state.md](state.md)**.

State that should not persist belongs in a JavaScript property or a `WeakMap`, not an
attribute. Serialising captures attributes, so anything in `dataset` is in the file forever.
