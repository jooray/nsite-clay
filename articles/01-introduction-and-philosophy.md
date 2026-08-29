Title: The document is the database
Summary: One HTML file that holds its own content, edits itself in the browser and republishes itself to Nostr, and what changes when the answer to "who may edit this page" is a keypair.
Suggested slug: the-document-is-the-database

---

Most ways to put a page on the web end with somebody else holding the page. A hosting
account, or a repository that a platform turns into HTML for you. You write, they store, and
the arrangement lasts as long as they want it to. Usually that is long enough. When it is
not, an export button is the only thing standing between your writing and a dead link.

nsite-clay is one answer to that. It is a single HTML file that you edit in the browser and
that republishes itself when you press save. The words you type land in the markup. Open the
saved file in a text editor afterwards and they are sitting there, in tags a person could
have typed.

## The file is the app

The idea is [HyperClay](https://hyperclay.com)'s and the editing model follows
[ClayJS](https://clayjs.com). This is that model with Nostr underneath instead of a hosting
platform. Mark a container `editable` and it becomes rich text for whoever holds the key and
ordinary markup for everybody else. There is no content store to keep in step with a
template, because there is no template. The DOM is where the content lives, and saving means
writing the DOM down.

```html
<!DOCTYPE html>
<html lang="en" nc:owner="npub1…">
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

That is the whole integration. One attribute says whose signature may save the file, one
marks what people can type into, one script tag does the rest.

What comes out the other end is not machine shaped. The runtime removes the
`contenteditable` it added, its own floating toolbar, and the debris browsers emit from their
editing commands. Contributed markup goes through DOMPurify, so pasting out of a word
processor does not smuggle a stylesheet into your page. The `editable` attribute stays behind
as an inert marker, which is how the page knows what to switch on next time somebody signs
in.

## Where the bytes go

A save is three steps, and they are the same three the command line runs when it deploys.

The page clones its own DOM, cleans the clone up and serialises the whole document. Those
bytes go to a [Blossom](https://github.com/hzrd149/blossom) server as a blob addressed by its
own sha256, authorised with a signed kind-24242 token. A
[NIP-5A](https://github.com/nostr-protocol/nips/blob/master/5A.md) manifest event then maps
the document's path to that hash and goes out to your relays with the owner's signature on
it. Kind 15128 for a root site, 35128 for a named one. The event is replaceable, so
publishing a new one is the deploy.

A gateway resolves the manifest, fetches the blobs and serves them over HTTP. Nothing in that
loop is a process of yours. Relays keep the pointer and Blossom servers keep the bytes.

Some of this is less tidy in practice than it is on a diagram. Several public Blossom servers
refuse `text/html` outright, which is a sensible thing to refuse when the alternative is
hosting arbitrary pages on your own domain. Several accept only padded base64 in an auth
header where the spec asks for base64url. The CLI and the runtime try each encoding, and a
save counts as successful if any one server takes the blob, because blobs are content
addressed and more copies is strictly better. So name several servers. Every save pushes to
all of them, and a blob lasts exactly as long as somebody is still holding it.

## Ownership is a keypair

The manifest carries one signature, so who may edit this page is a signature check rather
than a row in somebody's user table. There is no account for an automated system to suspend
on a Tuesday.

The address comes out of the key: `https://<npub>.nsite.lol/`. Nobody assigned it and nobody
can reassign it. Any NIP-5A gateway serves the same site, so nsite.lol, nsite.run and the one
running on your own laptop all show the same page. A gateway disappearing is a hostname
change. Point a CNAME at one and the page answers on a domain of your own instead.

One key gets one root site and as many named sites as you want, so a blog and a project page
can share an identity without sharing a document.

## History that costs almost nothing

Every save files a permanent kind-5128 snapshot naming an immutable set of hashes. Blobs
deduplicate, so a page you have edited two hundred times is not two hundred copies of a page.
`nc.versions()` lists them, `nc.readVersion()` fetches one and refuses bytes that do not hash
to what the snapshot claims, and `nc.restore()` republishes an old path table as the current
one. Restoring is itself a new version, so you are allowed to change your mind twice.

Each version also has a permanent URL of its own, which does mean your history is public.
That is a real trade, and it is easier to think about before your first draft than after it.

## Caching, which is normally somebody else's problem

Assets are published at paths carrying their content hash, so a new build is a new URL that
no cache can serve stale. Documents keep stable paths, because those are what people link to.
The unfingerprinted path stays in the manifest as an alias to the same blob, so a reader
still holding yesterday's copy does not break.

On top of that, a published document watches its own manifest. A manifest is a replaceable
event, so a newer version arrives as a push rather than a poll. When the hash for the
document's path stops matching the bytes the tab was served, the page says so and reloads
itself through a URL no cache can satisfy. A page with unsaved work is never reloaded out
from under you. Nobody should have to know what a hard refresh is.

## What it will not do

One key writes the document, so there is no shared editing and no per-visitor content.

There is no conflict detection either. A replaceable event has no compare-and-swap, which
means two devices editing the same page will quietly lose one side's work. Re-read before you
publish, and do not treat this as a collaboration tool.

The gateway is trusted for the first byte. Sub-resources are hash-checked against the
manifest and every event is signature-checked, but the entry document cannot verify itself,
because the code doing the verifying would be the code under suspicion. That is the nsite
trust model rather than anything specific to this project. What differs from a hosting
platform is that the manifest, the blobs and the history all sit outside the gateway, so you
can read the same document through a second one and compare. Running a gateway on your own
machine removes the question.

And there is no server code. If what you are building needs a backend, this is the wrong
tool.

## What survives

If whoever runs the thing lost interest tomorrow, what would you still have? For most
publishing tools the answer is a database export and a weekend. Here it is the HTML file you
already have, a key you already hold, and any gateway that speaks NIP-5A.

The code is MIT-0. Use it, change it, ship it, no attribution needed.
