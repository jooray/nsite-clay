# Workspaces: many pages under one key

Optional. Without one, every page is its own site under a fresh key, which is
the default and stays the right choice for most pages. With one, the pages
are paths of one site, `https://<npub>.nsite.lol/<id>/`, under one key that
the script keeps in its ledger.

## When to use one

Use a workspace only when the user asked for it, or their settings name one
(`"workspace"` in `config.json`, or `NSITE_ARTIFACTS_WORKSPACE`): for their
own ongoing pages, such as project boards, notes and trackers, that they edit
themselves. Keep the default for anything sensitive, anything another person
edits, and one-off pages.

Why: every page of a workspace has its own link, and a link to one page opens
only that page. But all the pages share one public npub and one list of pages
on the relays, so anybody can see how many pages there are and when each was
saved. And whoever can edit one page holds the workspace's key, so they could
change or take down its other pages (not read them). `create` warns about that
when a workspace page gets an edit link; give such a link only to the person
the workspace belongs to.

## Commands

    artifact workspace init [--name=N] [--owner=npub]
    artifact create page.html --workspace[=N] [the usual options]
    artifact workspace list [--name=N]
    artifact workspace verify [--name=N]
    artifact workspace doctor [--name=N] --fix
    artifact workspace export --out=<file> [--name=N]
    artifact workspace adopt <file> [--name=N]
    artifact workspace index --pages=all|<id>,… [--links=read|edit] [--title=…]
    artifact workspace index --remove-index

- `init` makes the workspace once and prints its `npub` and `uploader`. Never
  run it again to "refresh" anything: a second one would be a different key.
  `--owner=npub` makes the user a member of every page made in it, so they can
  also open each page by signing in.
- `create --workspace` (the workspace named `default`, or `--workspace=N`)
  answers like any create, with `"workspace"`. `--no-workspace` makes a page
  its own site when the settings name a workspace.
- Every other command takes the page id as usual. `read`, `update`,
  `comments`, `reply`, `delete`, `verify`, `doctor`, `sweep`, `upgrade`,
  `rekey` and `links` know where the page lives.
- `delete <id>` takes out that page only. Nothing deletes a workspace.
- `workspace list` shows its pages, and `otherPages`: pages made with the same
  key somewhere else (another machine, another agent). Leave those alone.
- `workspace verify` exits 1 when something is wrong, such as a page of yours
  that is no longer listed (`lost`) because another writer dropped it, or a
  deleted page that came back (`resurrected`). `workspace doctor --fix`
  repairs both, and copies files to servers that lost them. `verify` without
  an id checks every workspace too, so a scheduled `verify` covers it.
- The site's root shows nothing. `workspace index` puts a sealed page there
  with its own link, listing the pages chosen and their links: whoever has the
  index link can open every page on it, so make one only when the user asks.

## Another machine or agent

The workspace key is in the ledger, as every page's key is. To hand the
workspace to another machine or harness, `workspace export --out=<file>`
writes a file that holds the key and its pages' keys, readable only by the
user. Never print it, read it aloud, paste it into a chat or commit it. Tell
the user where it is, and that `workspace adopt <file>` on the other side takes
it in and that the file should be deleted afterwards. A file that holds only
the nsec works too (`workspace adopt <file>`, or `-` for stdin); then the
other side can add its own pages but opens only those whose links it is given
(`adopt <edit link>`). Do not put an nsec on a command line.

Two agents writing the same workspace at once is handled: each change is
merged into what is on the relays, checked again right before and after it is
sent, and merged again if another writer's change came in between. If a write
fails with "times in a row", run `workspace verify` and try again.

## Servers that allow only some keys

If the user runs a Blossom server that takes uploads only from keys it allows,
tell them to allow the `uploader` npub that `workspace init` and `workspace
list` print, once. A server that refuses (401 or 403) is passed over for the
others, and the answer says so in `warnings`. Do not change `servers` in the
settings yourself.
