# Working on nsite-clay

What the project is: **[README.md](README.md)**. What an agent building someone a
site with it needs: **[site/llms.txt](site/llms.txt)**. This file is about
working on the repository itself, and it is mostly about releasing, because that
is the part with a step you cannot see from the code.

## Where things are

- `src/` is the runtime. `build.mjs` bundles it into `dist/`, which is committed.
- `templates/_shared/CONTRACT.md` is binding on every template. The stylesheet
  and the chrome script next to it are shared: change the engine there, never in
  ten template files.
- `site/` is the project's own nsite, published at
  `npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2`. It is also
  where every deployed site reads its upgrades from, which is why a release is
  not a release until `site/` is deployed.
- `docs/RUNTIME-API.md` is the reference. `docs/state.md` says what belongs in
  the document and what belongs on relays.
- Machine-specific facts, keys and the deploy incantation live in
  `CLAUDE.md.local`, which is gitignored and true only for one checkout.

## Releasing

A published page hardcodes the URLs of the files it runs on, so it stays on the
engine it was published with until its owner takes a newer one. What makes a
newer one exist is a deploy of `site/`, and nothing else. Pushing to GitHub
changes nothing for anybody's live site.

1. **Bump `version` in `package.json`.** `build.mjs` stamps it into the bundle as
   `nc.version`, so this changes the bundle bytes, its hash, and every
   content-stamped path. That is intended: a new build has to be a new URL for a
   cache to notice it.
2. **Add an entry to `docs/releases.json`** for exactly that version, with
   `released` and `notes`.
3. `npm run build && npm test`
4. `npm run site:build`, which regenerates `site/`, restages the twelve
   templates, the three translations, and `site/runtime.json` from the two files
   above.
5. Commit and push.
6. **Deploy `site/`.** The command is in `CLAUDE.md.local`; it needs the bunker
   signer awake. Until this runs, no existing page can find the release.

Then check it landed: the manifest should name `/nsite-clay.js`,
`/nsite-clay-base.css`, `/nsite-clay-chrome.js` and `/runtime.json`, and the
gateway should serve the notes at
`https://npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2.nsite.lol/runtime.json`.

### Writing the notes

They are not a changelog. `docs/releases.json` is what the upgrade dialog shows
the owner of somebody's bakery page, in a browser, when they open their own site
to edit it. Write each line as what changed for them and why it matters, in
whole sentences, with no jargon they have no use for. Say what was wrong, not
which function fixed it.

`tools/stage-runtime.mjs` warns and still builds when a version has no entry, so
a release can ship with an empty offer if nobody checks. Check.

### What an upgrade does not carry

The engine, the chrome script and the stylesheet, and nothing else. A template's
own CSS, its `<template nc:block>` library and its toolbar markup live in the
author's document and no upgrade rewrites them. So a change that needs new
markup in the toolbar reaches new pages only. Anything that must reach pages
already published belongs in runtime-drawn chrome instead, which is why the
upgrade offer itself sits in the Settings dialog rather than on the toolbar.

## Standing rules

- **Never copy `nsite-clay.js` or the stylesheet into a page.** They are linked
  from the site root so one upgrade fixes every page.
- **Every document needs its own `nc:path`.** A page that misreports it compares
  itself against somebody else's bytes, never matches, and reloads forever.
  `stage-deploy.mjs` checks all of them on every build; keep that check working.
- **No em or en dashes** anywhere in the site's prose or the templates, in any
  language. The other writing rules are in `site/llms.txt` §13.
- **A change to `site/deploy.html` needs all four languages.** English lives in
  the markup and in the `say()` fallbacks; `es`, `sk` and `cs` are in the
  `STRINGS` table in the same file. `tools/stage-deploy.mjs` generates the three
  translated copies, so never edit `site/{es,sk,cs}/deploy.html` by hand.
- `npm test`, the walkthrough and the screenshot tools drive the installed
  Chrome through Playwright. `npx playwright install` does not help if Chrome is
  missing.
- `npm run publish:local` puts a relay and a Blossom server on this machine and
  serves `site/` pointed at them, so the publisher can be exercised end to end
  without anything reaching a public relay. Use it rather than testing against
  the real thing.
