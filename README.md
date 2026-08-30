<p align="center">
  <img src="icons/nsite-clay-transparent.png" alt="" width="140" height="140">
</p>

<h1 align="center">nsite-clay</h1>

<p align="center">
  A self-editable nsite.<br>
  One HTML file that edits and republishes itself, hosted on Nostr.
</p>

<p align="center">
  <a href="https://npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2.nsite.lol/"><b>Homepage</b></a>
  ·
  <a href="https://npub16kwfcualkq4kz6vgs8tze0j4jkpgs53h48ghmpnj80s7cvfjspwsh4uk9u.nsite.lol/">Live demo</a>
  ·
  <a href="docs/RUNTIME-API.md">Runtime reference</a>
</p>

<p align="center"><sub>The homepage is itself an nsite-clay document, and it edits itself.</sub></p>

<p align="center">
  <img src="media/editing.png" alt="The heading of a published page being edited in the browser, with the block menu open" width="880">
</p>

---

Open the page, sign in with your key, and type into it. The document serialises its own DOM,
pushes those bytes to a [Blossom](https://github.com/hzrd149/blossom) server as one
content-addressed blob, and republishes the [NIP-5A](https://github.com/nostr-protocol/nips/blob/master/5A.md)
nsite manifest that points at it. Anyone else loading the page gets a plain static document with
your changes already in it.

Nothing in that loop is a server you have to run. Relays hold the manifest, Blossom servers hold
the bytes, and the browser does the rest. Ownership is a keypair rather than an account, so
"who may edit this page" is not a row in somebody else's database.

The idea is [HyperClay](https://hyperclay.com)'s and the editing model follows
[ClayJS](https://clayjs.com); this is that model with Nostr underneath instead of a hosting
platform.

## Description for Nostr geeks

An nsite is web hosting. Not long-form notes, whole HTML files. That is all an
nsite is.

nsite-clay adds one thing to it: the page edits and updates itself, so the CMS
sits inside the static HTML rather than behind it.

You change the DOM. Click around the page and edit things, or open your
browser's DOM inspector and change it there; the page does not care which. The
new version is uploaded to your Blossom servers, and one replaceable event is
republished saying which Blossom hash `/` or `/about-us` now points to. Any
nsite gateway renders it.

## Try it

A live document is published under a throwaway key, and the key is public on purpose:

**<https://npub16kwfcualkq4kz6vgs8tze0j4jkpgs53h48ghmpnj80s7cvfjspwsh4uk9u.nsite.lol/>**

```
nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y
```

Open it, press **Sign in**, paste that nsec, and edit the page. Your save rewrites the real
document for everyone. It is a sandbox with no owner, so treat whatever is there as other
people's leftovers.

## Quick start, without a terminal

Open **[the publisher](https://npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2.nsite.lol/deploy.html)**,
pick a template, sign in with your key or make one on the spot, and it is online.
It runs entirely in the browser: it fetches the template and the runtime from the
site it is published on, uploads them to your Blossom servers, and signs the
manifest with your key. There is no server in the loop and nothing to install.

The [guide](https://npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2.nsite.lol/guide.html)
walks the whole path with screenshots, from having no key at all to a published
page with a picture and a Nostr feed in it.

## Quick start, with one

```bash
npx nsite-clay init mysite      # scaffolds index.html + nsite-clay.js, generates a key
npx nsite-clay deploy mysite --sec=nsec1…
```

`deploy` prints the URL. Open it, sign in as the owner, and from then on the page saves itself;
you only come back to the CLI for changes you make outside the browser.

To use a key you already have, hand `init` the npub so the document knows its owner:

```bash
npx nsite-clay init mysite --npub=npub1…
npx nsite-clay deploy mysite --bunker="bunker://…"
```

## What a document looks like

```html
<!DOCTYPE html>
<html lang="en" autosave nc:owner="npub1…">
<head><meta charset="utf-8"><title>Notes</title></head>
<body>
  <h1 editable="single-line">My notes</h1>
  <div editable>
    <p>Type anything here.</p>
  </div>
  <script src="/nsite-clay.js"></script>
</body>
</html>
```

That is the whole integration. `nc:owner` says whose signature may save it, `editable` marks
what a person can type into, and the script does the rest. Save it, then open the file in a text
editor: your words are in the HTML.

## Editing

Mark a container `editable` and it becomes rich text for the owner and ordinary markup for
everybody else.

**Enter starts a new paragraph.** Selecting text raises a floating toolbar whose first control
is a block menu: Paragraph, Heading 1 to 3, Quote, Code block. Alongside it are bold, italic,
strikethrough, bulleted and numbered lists, link, and clear formatting.

Keyboard: `⌘B` `⌘I` `⌘U` `⌘K`, `⌘⇧8` for a bulleted list, `⌥1` to `⌥3` for headings. Typing `# `,
`- ` or `> ` at the start of a line works too.

Use `editable="single-line"` for a title or a list row, where Enter should do nothing and the
block menu makes no sense.

What reaches the file is markup a person could have written by hand. The `editable` attribute
stays behind as an inert marker; the `contenteditable` it implies, the toolbar, and the debris
browsers emit from editing commands are all stripped. Pasted markup goes through a sanitiser, so
copying out of a word processor does not smuggle a stylesheet into your document.

## Pictures, video and Nostr posts

Three more buttons on the same toolbar.

**Pictures.** Drag a file in, pick one you have uploaded before from a grid, or paste a URL.
Uploads go to the same Blossom servers the document is stored on, so an image is
content-addressed and its URL never has to change.

**Video.** A YouTube or Vimeo link becomes a click-to-play thumbnail rather than an iframe, so
nothing third-party loads until a reader presses play and the thumbnail still works as a link
with JavaScript off. A video file is uploaded and played from Blossom.

**Nostr feeds.** A widget showing short notes, long-form articles or picture posts from any
npubs you name. The dialog lists their actual posts so you can click the ones to pin rather than
hunting for event ids. Pinning an article uses its slug, not its event id, because kind 30023 is
replaceable and an id-pin breaks the moment the author fixes a typo. Every event is
signature-checked and sanitised in the browser, and the posts are fetched at view time rather
than stored in the file.

```html
<div nc:feed="articles" nc:authors="npub1…" nc:limit="5" nc:style="grid"
     nc:pinned="my-first-post"></div>
```

## Writing Nostr posts

The composer lists what you have published and opens an editor for more: short notes (kind 1)
and long-form articles (kind 30023). Publishing an article again under a slug you have used
before is the edit, so every long-form client shows the new text at the same address and the
original date stays put.

Posts and pages are separate. Writing a note does not change your page, and saving your page
does not touch your posts.

## Blocks

A page marked `nc:blocks` is assembled rather than typed over. In edit mode the
runtime draws a rail on every block (move it, duplicate it, delete it, and for a
picture or a feed a gear that reopens the picker) and an insert point between
them that opens a palette.

The palette is built from the document's own library, which is a set of inert
`<template>` elements:

```html
<main nc:blocks>
  <section nc:block-type="heading"><h2 editable="single-line">A heading</h2></section>
</main>

<template nc:block="picture" nc:label="Picture" nc:icon="▥"
          nc:group="Media" nc:on-add="image">
  <section class="b-picture">
    <figure>
      <img nc:slot src="…" alt="">
      <figcaption editable="single-line">Caption</figcaption>
    </figure>
  </section>
</template>
```

A `<template>` renders nothing and is saved with the page, so the library
travels with the document. Whoever opens the file next can keep adding blocks
with nothing to fetch and nothing to install. `nc:on-add` names a picker to run
once the block lands (`image`, `video`, `feed`, `post`) and `nc:slot` marks what
that picker acts on.

Nothing the rail draws is written to disk. A reader gets the blocks as ordinary
markup with no trace that a composer was ever involved. The full rules are in
[`templates/_shared/CONTRACT.md`](templates/_shared/CONTRACT.md).

## Editing without a visible editor

Templates ship with `nc:edit-gate="hash"`, so a reader gets the page and nothing
to click. Add `#edit` to the URL and the toolbar appears:

```
https://<your npub>.nsite.lol/#edit
```

Worth remembering, because a page with no visible way in looks broken to someone
who has forgotten. `nc.settings.open()` turns the gate off if you would rather
have the toolbar always there.

Autosave is off by default. Every save stores the whole page again and files a
version, so saving on a timer publishes a dozen versions of one paragraph.
Turn it on in the same settings panel. Both settings are attributes on `<html>`,
so they are saved with the page and travel with the file rather than living in
one browser.

## Signing in

Ranked by how much you have to trust the page in front of you:

- **NIP-07 browser extension.** The key never enters the page.
- **Amber or another NIP-46 remote signer.** The key never enters the browser at all. The page
  shows a `nostrconnect://` QR and deep link, and every signature is approved on your phone.
  This is the right default for a document served from a gateway you do not control.
- **Typing a key.** `nsec1…`, 64 hex characters, or a NIP-49 `ncryptsec1…` with its password.
  The key stays in the tab's memory for the session and is written nowhere. It sits in a
  password field deliberately: the snapshot algorithm never writes those values into markup, so
  a save cannot bake your key into the document it publishes.

## Built by agents

Most pages made with this will be built by an agent rather than by hand, so the
project ships instructions for one:

**<https://npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2.nsite.lol/llms.txt>**

Point your coding agent at that file and ask it for the page you want. It covers
what to ask you for, how to pick and rework a template, how to get the page
online with a remote signer rather than a raw key, and the handful of things
that go wrong. It deliberately does not restate the documentation; it links it.

Hand it to Claude Code, Codex, Cursor, or anything else that reads a URL. The
same file works as `AGENTS.md` in a project built on top of nsite-clay.

## Templates

Twelve starting points, all sharing one stylesheet and one runtime so an engine
change does not mean editing twelve files:

`cms` `event` `blog` `project` `personal` `links` `gallery` `terminal` `phrack`
`brutal` `eco` `irc`

`cms` is the one to start from. It is a page built out of blocks rather than a
finished design to type over: press the `+` between two blocks and add a
heading, a picture, a video, a row of cards or a Nostr feed. See
[Blocks](#blocks) below.

Ten of the twelve take blocks, each in its own shapes, so one added to `phrack`
comes out in monospace and one added to `terminal` comes out as another command.
`gallery` and `irc` do not: the gallery's wall is redrawn from a live feed on
every load and has nothing persisted to make a block of, and the chat log is
append-only by design and already has its own way of growing.

`node tools/template-blocks.mjs` checks every one of them in a browser.

The last of those is worth opening: its content is the transcript of the
conversation that produced it, held with an agent that was handed nothing but
[llms.txt](https://npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2.nsite.lol/llms.txt).

```bash
npx nsite-clay init mysite --template=blog --npub=npub1…
```

Browse them at [/templates.html](https://npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2.nsite.lol/templates.html),
or read the source in [`templates/`](templates/). The rules a template follows
are in [`templates/_shared/CONTRACT.md`](templates/_shared/CONTRACT.md).

## Deploying

### What a deploy does

A deploy is three steps, and they are the same three the browser performs when you press save:

1. **Every file becomes a Blossom blob**, addressed by its own sha256. Uploads are authorised
   with a signed kind-24242 token ([BUD-11](https://github.com/hzrd149/blossom/blob/master/buds/11.md)).
2. **A manifest event maps paths to hashes**, signed by the site owner and published to your
   relays. Kind 15128 for a root site, kind 35128 for a named one. The event is replaceable, so
   publishing a new one is the deploy.
3. **A kind-5128 snapshot pins that set of hashes** as a permanent version.

A gateway resolves your manifest, fetches the blobs, and serves them over HTTP.

### The commands

```bash
nsite-clay init [dir] [--npub=npub1…]
nsite-clay deploy <dir> [--sec=… | --bunker=…] [--site=name] [--title=…] [--description=…]
nsite-clay keygen
```

Signing takes either a raw key (`--sec`, or `NOSTR_SECRET_KEY`) or a remote signer
(`--bunker="bunker://…"`, or `NOSTR_BUNKER_URI`). A bunker keeps the key off the machine running
the deploy, so a CI runner never holds it.

### Where your site ends up

A key has one **root site** and any number of **named sites**:

| | URL |
|---|---|
| root site (default) | `https://<npub>.nsite.lol/` |
| named site (`--site=blog`) | `https://<50-char-base36-pubkey>blog.nsite.lol/` |
| a specific version | `https://v<50-char-base36-snapshot-id>.nsite.lol/` |

Any NIP-5A gateway serves the same site: [nsite.lol](https://nsite.lol),
[nsite.run](https://nsite.run), or one you run yourself. For a domain of your own, see
[Custom domains](#custom-domains).

Named sites need a `d` tag of 1 to 13 characters from `[a-z0-9-]`, because a DNS label is 63
characters and the base36 pubkey uses 50 of them.

### Where it gets served

An nsite gateway resolves your manifest and serves the files. They all read the
same events, so a site is not tied to any of them:

| Gateway | |
|---|---|
| [nsite.lol](https://nsite.lol) | public gateway |
| [nsite.run](https://nsite.run) | reference implementation, and the clearest explanation of what an nsite is |
| [nosto.re](https://nosto.re) | public gateway |
| [nwb.tf](https://nwb.tf) | public gateway |
| [nsite.cloud](https://nsite.cloud) | reference implementation |
| [shakespeare.to](https://shakespeare.to) | reference implementation |

If one is down, swap the hostname and your site is still there, and
`npm run devnet` runs one on your laptop.

### Custom domains

A gateway reads the npub out of the hostname. When the name it was asked for is
not an nsite label it resolves the CNAME and reads the npub from where that
points, so the record goes to your npub subdomain rather than to the gateway:

```
blog.example.com.  CNAME  npub1….nsite.lol.
```

A CNAME at `nsite.lol` itself cannot work: it carries no npub.

That is the routing. HTTPS is separate and, on the public gateways today, not
solved. nsite.lol holds one certificate covering `*.nsite.lol`, and answers any
other name with a TLS `unrecognized name` alert and no certificate, so a browser
asking for `https://blog.example.com` never reaches the page. Run the gateway
yourself if you want a name of your own over HTTPS: the reference deployment
puts Caddy in front, which issues certificates on demand.

### Relays and Blossom servers

The defaults work for a first deploy.

**Publish to the gateway's own relay.** A gateway keeps a live subscription to its relays and
re-syncs everything else on a timer. With `wss://relay.nsite.lol` in the list a change appears in
about a second; without it, up to ten minutes. It is in the default set for that reason.

**Blossom servers are not interchangeable.** Several public ones refuse `text/html` outright,
sensibly enough, since they would be hosting arbitrary pages on their own domain. Several accept
only padded base64 in the auth header where BUD-11 asks for base64url. The CLI and the runtime
both try each encoding, and a deploy succeeds if any one server takes the blob, since blobs are
content-addressed and more copies is strictly better. `cdn.hzrd149.com` and `blossom.primal.net`
are known to work.

**A blob is only as durable as the servers holding it.** The manifest names hashes, not bytes.
List several servers; every save pushes to all of them.

### Assets and caching

Assets are published at paths carrying their content hash (`/nsite-clay-1054f97d.js`), so a new
build is a new URL that no cache can serve stale. Documents keep stable paths, since those are
what people link to. The unfingerprinted path stays in the manifest as an alias to the same blob,
so a reader still holding a cached copy of the previous document does not break. Pass
`--no-fingerprint` to turn this off.

On top of that, a published document watches its own manifest. The manifest is a replaceable
event, so a new version arrives as a push rather than a poll: when the hash for the document's
path stops matching the bytes the tab was served, the page says so and reloads itself through a
cache-proof URL. A page with unsaved work is never reloaded out from under you. Nobody should
need to know what a hard refresh is.

### Deploying twice

Blobs are addressed by their own hash, so a file whose bytes have not changed is
already on the server under the same name. `deploy` asks each server before it
uploads, and stops before publishing when the path table still hashes to what the
live manifest says:

```
$ npx nsite-clay deploy mysite
  /index.html                    1aa4b3323850…    18818 B  2/2  already there
  /nsite-clay-328e2b9d.js        328e2b9d37e2…   303407 B  2/2  already there

  unchanged: the published manifest already points at these 7 paths
  nothing published. --force republishes anyway.
```

So a scheduled job that redeploys an unchanged site costs a few HEAD requests and
writes nothing to any relay. A server that has dropped a blob gets it back, which
makes a repeat deploy a repair rather than a no-op, and `--force` publishes
regardless if a manifest needs rewriting for its own sake.

## Version history

Every save files a permanent kind-5128 snapshot naming an immutable set of hashes, and blobs
deduplicate, so history costs almost nothing. `nc.versions()` lists them, `nc.readVersion()`
fetches one and refuses bytes that do not hash to what the snapshot claims, and `nc.restore()`
republishes an old path table as the current one. Restoring is itself a new version, so nothing
is destroyed. Each version also has its own permanent URL, which does mean your history is
public.

## Configuration

Full attribute and API reference: **[docs/RUNTIME-API.md](docs/RUNTIME-API.md)**.

## What this does not do

- **One key writes the document.** The manifest carries one signature. There is no shared
  editing and no per-visitor content.
- **No conflict detection.** A replaceable event has no compare-and-swap. Two devices editing
  the same document will silently lose one side's work. Re-read before you publish, and do not
  treat it as a collaboration tool.
- **The gateway is trusted for the first byte.** Sub-resources are hash-checked against the
  manifest and every event is signature-checked, but the entry document cannot verify itself:
  the code doing the verifying would be the code under suspicion. This is the nsite trust model,
  not something specific to this project. What differs from a hosting platform is that the
  manifest, the blobs and the history all live outside the gateway, so you can check the same
  document through another one and compare aggregate hashes. Running a local gateway removes the
  trust entirely.
- **No server code.** If your project needs a backend, this is the wrong tool. Though your
  project probably does not need one beyond Nostr. You would be surprised how far you get
  without it.

## Developing locally

```bash
npm run devnet
```

A relay, a Blossom server and a NIP-5A gateway on localhost, all in memory, so experiments do
not land on other people's disks or a public gateway. Deploy into it and open the site at its
canonical hostname, since browsers resolve anything under `.localhost` to the loopback address:

```bash
npx nsite-clay deploy mysite --sec=nsec1… \
  --relays=ws://127.0.0.1:4869 --servers=http://127.0.0.1:4870

open http://npub1….localhost:4871/
```

Stop the process and everything it held is gone. It trusts its caller and should never be
reachable from anywhere else.

To click through the web publisher against that stack rather than against public infrastructure:

```bash
npm run publish:local     # devnet, plus site/ served with its relay and Blossom lists rewritten
```

It prints the publisher's address. Publish as often as you like; nothing reaches a public relay.

The whole path is also a test. It drives the real publisher from a key that did not exist a
second ago, through the wizard, onto the devnet, back out of the gateway, edits the published
page and saves it, and screenshots every step into `media/guide-publish/`:

```bash
curl -sLo /tmp/lunarpunk.jpg https://image.nostr.build/b9bf63cdfad604ce65598797a5564c9f1e9d7b45ccfef07df3016442addfd9eb.jpg
npm run walkthrough
```

The pictures in the [guide](https://npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2.nsite.lol/guide.html)
come from that run, so they show working software rather than a mock-up.

## Building from source

```bash
npm install
npm run build     # dist/nsite-clay.js and dist/nsite-clay.esm.js
npm test          # 142 behaviour checks in a real browser
```

The tests run in Chrome on purpose. Several of them are about what the HTML parser and the
browser's own editing commands do to markup, which is not something a DOM shim will tell you.

## Credits

The malleable-HTML idea, the `editable` model and the save lifecycle come from
[HyperClay](https://hyperclay.com) and [ClayJS](https://clayjs.com) by
[panphora](https://github.com/panphora); the format is specified at
[malleablehtmlfile.com](https://malleablehtmlfile.com). Hosting rests on
[NIP-5A](https://github.com/nostr-protocol/nips/blob/master/5A.md) nsites and
[Blossom](https://github.com/hzrd149/blossom) by [hzrd149](https://github.com/hzrd149), and on
[nostr-tools](https://github.com/nbd-wtf/nostr-tools). Contributed markup is sanitised with
[DOMPurify](https://github.com/cure53/DOMPurify).

## Licence

MIT-0. Use it, change it, ship it, no attribution needed.
