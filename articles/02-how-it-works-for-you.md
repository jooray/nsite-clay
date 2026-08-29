Title: Getting a page online, and then living with it
Summary: The terminal part is two commands. After that it is a page you sign into and type on, with pictures, video, your Nostr posts and a version list behind it.
Suggested slug: getting-a-page-online

---

The [walkthrough](https://npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2.nsite.lol/docs.html)
on the project site has a screenshot of every step. This is the same ground, faster.

## Two commands, and one of them prints a key

```
npx nsite-clay init mysite
npx nsite-clay deploy mysite --sec=nsec1…
```

The first makes a folder with your page in it and prints a key. That key is the only thing
that will ever be able to change the page, and it is stored nowhere, so copy it somewhere
safe before you close the terminal window. The second puts the page online and prints its
address.

If you already have a Nostr key, hand the npub to `init` instead and the page belongs to you
from the first deploy. Signing can then come from a bunker rather than from a file on disk,
which keeps the key off the machine running the deploy. A CI runner never has to hold it.

That is the last command you need. Everything after this happens in a browser.

## Signing in, in order of how much you have to trust the page

A visitor gets your page and nothing to click. You get a Sign in button.

A browser extension is one click and nothing typed, and the key never enters the page. A
signer app on your phone is better still. The page shows a `nostrconnect://` code, you scan
it with Amber or another NIP-46 signer, and every signature after that is approved on the
phone, so the key never enters the browser at all. For a document served by a gateway you do
not control, that is the one to use.

Typing a key works too: an `nsec1…`, sixty-four hex characters, or a NIP-49 `ncryptsec1…`
with its password. It stays in the tab's memory for the session and is written nowhere. It
sits in a password field on purpose, because the snapshot algorithm never copies those values
into markup, so a save cannot bake your key into the page it is about to publish.

Anyone else who signs in gets the same read-only page a visitor sees.

## The editing

Click into text and type. Enter starts a paragraph. Select something and a small toolbar
appears above it, whose first control is a block menu: paragraph, three heading sizes, quote,
code block. Beside it are bold, italic, strikethrough, bulleted and numbered lists, a link
button and one that strips formatting back out. The keyboard shortcuts are the ones you
already use, and typing `# `, `- ` or `> ` at the start of a line does the same thing.

What reaches the file is markup you could have written by hand. No wrapper divs, no inline
styles left over from a browser's idea of what bold means. Pasting out of a word processor is
safe because the formatting is cleaned on the way in.

Use `editable="single-line"` for a title or a list row, where Enter should do nothing and a
block menu makes no sense.

## Pictures and video

Put the cursor where you want it and press the picture button. Drag a file in, click one you
have used before from the grid, or paste a web address. Uploads go to the same Blossom
servers the page itself is stored on, so a picture is content addressed and its URL never has
to change. Everything you have ever uploaded is in that grid, which is how you stop hunting
for the same image twice.

Fill in the alt text. It is what a screen reader says out loud and what shows when the image
does not load.

The video button takes a YouTube or Vimeo link and turns it into a thumbnail with a play
button rather than an iframe. Nothing third-party loads until a reader presses play, and the
thumbnail still works as a link for somebody browsing with JavaScript off. A video file gets
uploaded and played from Blossom like any other blob.

## Your posts, on your page

The lightning button drops a feed of Nostr posts into the page: short notes, long-form
articles or picture posts, from whichever npubs you name. The dialog lists their actual
posts, so you pin the ones you want by clicking them instead of hunting for event ids. You
can name more than one npub, so a page can show a whole group.

Pinning an article uses its slug rather than its event id. Long-form posts are replaceable,
so the id changes every time the author fixes a typo, and an id pin would break at the exact
moment the author improved something.

The posts are fetched when somebody opens the page rather than stored in it. Publish
something next week and it turns up here without you touching the page again. Every event is
signature-checked and sanitised in the browser before it is shown, because a relay is a
transport and not an authority.

```html
<div nc:feed="articles" nc:authors="npub1…" nc:limit="5" nc:style="grid"></div>
```

## Writing posts from the same page

If the page can show your posts it can write them. The composer lists what you have published
and opens an editor for more, both short notes and long-form articles.

For an article, the address is the part to get right, because publishing again under an
address you have used before is the edit. Fix a typo, publish, and every long-form client
shows the corrected text at the same link with the original date still on it. Short notes
work the same way with one difference: they cannot be edited afterwards, and the panel tells
you so before you publish one.

Posts and pages are separate. Writing a note does not change your page, and saving your page
does not touch your posts.

## Saving, and going back

Press Save, or `⌘S`. It takes about a second and the dot in the corner turns green. If
nothing has changed since the last save it says so and does nothing, so pressing it twice is
harmless. When a save fails it says why. The usual cause is a signer app that has gone to
sleep, so wake it, approve, and press Save again.

Anybody still reading the previous version is told a newer one exists, and their page updates
itself.

Every save is kept. History lists them all, you can read any one of them in a new tab, and
restoring an old one files another version rather than throwing the current one away. Change
your mind, then change it back.

Two devices editing the same page will quietly lose one side's work. There is no conflict
detection, because a replaceable event has no compare-and-swap. Finish on one machine before
you start on another.

## Where it lives

`https://<your npub>.nsite.lol/`. The address is yours because the key is yours. Other
gateways serve the same site, so swapping `nsite.lol` for `nsite.run` gets you the same page
from somewhere else, and a CNAME record points a domain of your own at whichever one you
like. Deploying with `--site=blog` gets you a second page under the same key.
