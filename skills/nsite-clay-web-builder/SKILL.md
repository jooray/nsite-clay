---
name: nsite-clay-web-builder
description: Build and publish a website for the user on Nostr as an nsite that they can edit themselves in the browser, with no hosting account. Use when the user wants a website, landing page, personal page, event page, link page, portfolio, small business page or a small web app published on Nostr or nsite, or wants an existing page or site converted so they can keep editing it themselves. Do not use for short-lived private lists or one-off pages shared by link, that is the nsite-artifacts skill.
license: MIT-0
compatibility: Needs Node.js 18 or newer and outbound network access (HTTPS and WebSocket). Publishing needs a Nostr remote signer (bunker) the user approves with.
metadata:
  version: "0.1.0"
  homepage: https://nsite-clay.cypherpunk.today/
---

# nsite-clay web builder

nsite-clay turns one HTML file into a page its owner edits in the browser and
republishes on Nostr, hosted without a server or an account. You build the first
version and hand it over. After that they do not need you for ordinary changes.

## Before anything else

Read `references/llms.txt` completely. It is the real brief, over a thousand
lines, and it covers the templates, the editing markup, deploying, the traps and
how to write for the owner. Do not work from this page alone and do not skim.
The sections you will use most are 4 (templates), 4b (an existing page), 5
(getting it online), 8 (making a page editable) and 14 (handing it over).

## The sequence

1. **Ask what you need to know**, and only that: who the site is for, what it
   says, what they want visitors to do, and the name, links and pictures they
   have. Section 3 says what to ask. Do not ask for technical choices they cannot
   make.
2. **Pick a template**, or follow section 4b if they already have a page. Start
   from a template instead of a blank file. Section 4 lists them.
3. **Make it editable**. Every part the owner will want to change must be
   editable in the browser, with its own `nc:path` on each document. Section 8
   has the exact markup and section 12 the things that break.
4. **Publish** with `npx nsite-clay deploy`, signing with a remote signer. Ask
   the user for a `bunker://` address and pass it in the `NOSTR_BUNKER_URI`
   environment variable, never as an argument. Sections 5 and 6 have the details.
5. **Check the live page** at `https://<their npub>.nsite.lol/` before you say
   it is done.
6. **Hand it over** as section 14 describes: the address, how to open the editor,
   how to sign in, and what to do when something goes wrong.

## Keys

Never ask the user to paste a private key (an `nsec`) into the chat. Never print,
log, write down or store one, and never put one in a file in the project. Use a
remote signer so the key stays in the user's own signer app. If the user only
has a key and no signer, section 6 says what to recommend.

## Changing a site that is already published

Read `references/llms-edit.txt`. It is the shorter brief for editing a page that
exists. It also ships inside every published page, where the owner can copy it
for their own coding agent.

## When to use the other skill

If the user wants a list, a plan or a one-off page they send to a few people by
link, and it should disappear after some days, use the `nsite-artifacts` skill
instead. That skill encrypts the page and expires it. This one is for a lasting
public site the owner keeps editing.

## Writing

The text on the site is the owner's voice, not yours. Section 13 has the rules,
including no em or en dashes. Write in the language the owner uses.
