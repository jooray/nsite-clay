# Workspaces: many pages under one key

By default the artifact tool (`skills/nsite-artifacts`, `bin/artifact.mjs`)
makes every page its own nsite under a fresh key. A workspace is the opt-in
other way: one key, one site, and each page a path in it,
`https://<npub>.nsite.lol/<id>/`. Nothing changes for anybody who does not ask
for one.

## Why

- An agent keeps one key instead of one per page, and the owner has one npub
  to recognise.
- A Blossom server that takes uploads only from keys it allows needs to allow
  that one key once, instead of every fresh key of every page.
- An agent on another machine or in another harness can take the workspace
  over with one file (`workspace export`, then `workspace adopt`).

## Commands

    artifact workspace init [--name=N] [--owner=npub]     make one; prints its npub and the key that uploads
    artifact create page.html --workspace[=N] …           a page in it, at /<id>/, with its own link
    artifact workspace list [--name=N]                    its pages, and how many pages other machines made
    artifact workspace verify [--name=N]                  the shared manifest and every page (exit 1 if not ok)
    artifact workspace doctor [--name=N] [--fix]          put lost pages back, take deleted ones out, copy files
    artifact workspace export --out=<file> [--name=N]     the key and its pages, for another machine
    artifact workspace adopt <file>|- [--name=N]          from an export, or from a file holding the nsec
    artifact workspace index --pages=all|<id>,… | --remove-index   an optional page at the root

`"workspace": "default"` in `config.json`, or `NSITE_ARTIFACTS_WORKSPACE`,
makes `--workspace` the default for `create`; `--no-workspace` overrides it for
one page. Every other command (`read`, `update`, `comments`, `reply`,
`delete`, `verify`, `doctor`, `sweep`, `upgrade`, `rekey`, `links`) takes a page
id as before and knows from the ledger where the page lives.

decision-board passes `workspace` from its own user settings file on to
`create`.

## What is private and what is not

Each page is sealed with a read key of its own, random, not derived from the
workspace key. The read link is `…/<id>/#k=<K>`, the edit link
`…/<id>/#e=<workspace key>&k=<K>`. A link to one page opens that page only.

What is shared, and visible to anybody who looks at the relays:

- one npub, so every page is recognisably by the same author;
- one manifest, which lists every page's path (`/<8 hex>/index.html`, opaque)
  and is replaced on every save of any page: an observer sees how many pages
  there are and when each was saved;
- the workspace's relays and servers.

The manifest carries no titles, no expiry and nothing from inside a page. The
site's root shows nothing unless `workspace index` puts a page there; that
page is sealed with its own key and lists only the pages chosen, with their
links, so its link opens every page on it.

**Editing.** Whoever can edit a page signs for the whole site, because a nsite
has one signer. An edit link (or an edit membership) to one workspace page lets
its holder change or take down any page of the workspace, though not read the
others. `rekey` gives a page a new read key; it cannot take the workspace key
back from somebody who had it. So:

- use a workspace for the owner's own ongoing pages (project boards, notes,
  trackers) that only the owner edits;
- keep the default, one site per page, for anything sensitive, anything a
  third person edits, and one-off pages that should leave no trace linking
  them to the others.

`create` says so in its warnings when a workspace page gets an edit link.

## Writers that do not know about each other

A nsite manifest is one replaceable event that lists every path, and relays
keep only the newest. Two writers that each publish their own whole list drop
each other's pages. The tool never writes a whole list:

1. One run at a time per workspace on one machine: a lock file next to the
   ledger, held across the network work.
2. The newest manifest from every relay; the change (set or drop these paths)
   merged into it, every other tag kept byte for byte; `created_at` above the
   live one.
3. Read again just before sending; if it moved, merge again.
4. Read back from every relay. A newer manifest without this change means
   another writer won the race: merge again on top of theirs.
5. Read once more a moment later (`NSITE_ARTIFACTS_SETTLE_MS`, 2 s), for a
   writer whose read came just before this one was sent; if the change is
   gone, merge again.

Up to six rounds, then it fails and says so. `test/workspace-faults.mjs` runs
two homes with the same key creating six pages at once, with every read held
back long enough that they interleave, and a stale write landing in the
settle window; every page ends up in every relay's manifest.

What is left, and caught afterwards: a writer that stalls between its last
read and its send for longer than the settle window can still drop a page. A
page this ledger made that is missing from the manifest while its file is
still on a server is reported by `status`, `verify` and `workspace verify` as
lost (never as deleted), and `workspace doctor --fix` or `doctor <id> --fix`
puts it back. A path this ledger deleted that comes back (a browser tab that
saved from an older table) is taken out again on the next write.

The browser runtime does the same per path on its saves: it keeps every other
path, puts no expiry on the manifest, and its padlock's delete removes only its
own path. A runtime from before this (no `nc-split-keys-1` in the bundle) cannot
open a workspace page at all, and the tool refuses to put a page in a workspace
on such a runtime.

## Deleting, expiry and old versions

`delete <id>` drops that page's path and its files, and never the workspace or
its key. A page expires by itself: `sweep` removes it the same way. Retired
versions are named in the shared manifest with their path
(`["retired", <sha256>, <time>, <path>]`), and a page only deletes its own,
and never a blob that a path of any relay's manifest still names.

## Blossom servers that allow only some keys

`servers` in `config.json` (or `NSITE_ARTIFACTS_SERVERS`, or `--servers`) is
the list, in order: put your own first, for example

    { "servers": ["https://blossom.cypherpunk.today", "https://nostr.download", "https://blossom.yakihonne.com"],
      "workspace": "default" }

Uploads are signed by the workspace key, or by `uploader` when the settings
name one. `workspace init` and `workspace list` print that key's npub
(`uploader`): allow it on your server once. A server that refuses an upload
with 401 or 403 is passed over, the page goes to the others as long as
`minServers` of them (default 2) hold it, and the answer says which server
refused. With too few left nothing is published, and the error names the npub
to allow. A workspace keeps the relays and servers it was made with;
`workspace init --update-servers` takes the current settings for pages made
from then on.

## Moving a workspace

`workspace export --out=<file>` writes the workspace key and the keys of its
pages to a file readable only by its owner, refuses to overwrite one, and
prints no secret. `workspace adopt <file>` on the other machine takes it in.
`workspace adopt <file holding the nsec>` (or `-` for stdin) takes only the
key: the other machine can then add its own pages, and sees the pages made
elsewhere only as a count. `adopt <edit link>` of a workspace page brings the
workspace with it.
