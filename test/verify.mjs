#!/usr/bin/env node
// Behaviour this project must not break, checked in a real browser: several of
// these are about what the HTML parser and the browser's editing commands do,
// which no amount of unit testing in jsdom would tell you.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeEvent, nip19 } from "nostr-tools";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "fixtures");
// The bundle is served straight out of dist/, so the tests always run against
// what was just built rather than a stale copy someone forgot to refresh.
const server = createServer((req, res) => {
  const name = req.url === "/" ? "conformance.html" : req.url.split("?")[0].replace(/^\//, "");
  const p = name === "nsite-clay.js" ? join(HERE, "..", "dist", "nsite-clay.js") : join(DIR, name);
  let body;
  try { body = readFileSync(p); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": extname(p) === ".js" ? "text/javascript" : "text/html" });
  res.end(body);
}).listen(0);
const port = server.address().port;

const OWNER = nip19.decode("nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y").data;
const NSEC = "nsec1wsxl92ek0uznl6u3wpk7hl86cqnxdp8f8m9cvl93tr2tt0n4c5jqfjt3a8";
const HEX = "740df2ab367f053feb91706debfcfac0266684e93ecb867cb158d4b5be75c524";
const PUB = "feca5039602901bceb4e3110ddd89d4cc899658157254b1340866ec6d6e39eac";

// Manifests for the update-watch checks, signed by the fixture's owner.
const manifest = (pathHash, at) => finalizeEvent({
  kind: 35128, created_at: at, content: "",
  tags: [["d", "conf"], ["path", "/index.html", pathHash], ["server", "https://127.0.0.1:1"]],
}, OWNER);
const events = {
  same: manifest("a".repeat(64), 3000),    // matches the bytes we were served
  own: manifest("b".repeat(64), 3100),     // matches what we last published
  newer: manifest("c".repeat(64), 3200),   // somebody else published
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });

const results = await page.evaluate(async ({ evs, NSEC, HEX, PUB }) => {
  await nc.ready;
  // bake() only reads tags and content, so an unsigned template is enough here.
  const finalizeEventInPage = (t) => ({ ...t, pubkey: PUB, id: "0".repeat(64), sig: "0".repeat(128) });
  const out = [];
  const t = (name, pass, detail = "") => out.push({ name, pass, detail });
  const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

  // --- configuration lives in the document --------------------------------
  t("config is read from <html>", nc.cfg.site === "conf" && nc.cfg.path === "/index.html");
  t("an npub owner is normalised to hex", /^[0-9a-f]{64}$/.test(nc.cfg.owner));

  // --- signing in with a typed key ----------------------------------------
  t("nsec logs in", (await nc.login("nsec", { key: NSEC })) === PUB);
  await nc.logout();
  t("raw hex logs in", (await nc.login("nsec", { key: HEX })) === PUB);
  await nc.logout();
  t("surrounding whitespace is tolerated",
    (await nc.login("nsec", { key: "  " + NSEC + "\n" })) === PUB);
  await nc.logout();

  const ncryptsec = nc.LocalSigner.encrypt(NSEC, "hunter2", 8);
  t("a NIP-49 ncryptsec round-trips", ncryptsec.startsWith("ncryptsec1"));
  t("ncryptsec plus password logs in",
    (await nc.login("nsec", { key: ncryptsec, password: "hunter2" })) === PUB);
  await nc.logout();

  t("an npub is refused with a useful message",
    /public key/i.test(await err(() => nc.login("nsec", { key: nc.nip19.npubEncode(PUB) }))),
    await err(() => nc.login("nsec", { key: nc.nip19.npubEncode(PUB) })));
  t("an ncryptsec without its password is refused",
    /password/i.test(await err(() => nc.login("nsec", { key: ncryptsec }))));
  t("a wrong password is refused",
    /password/i.test(await err(() => nc.login("nsec", { key: ncryptsec, password: "nope" }))));
  t("garbage is refused", /Not a key/i.test(await err(() => nc.login("nsec", { key: "hello" }))));
  t("signed out again", nc.pubkey === null);

  // --- a key must never reach the file ------------------------------------
  document.getElementById("secret").value = NSEC;
  await nc.login("nsec", { key: NSEC });
  const withKey = nc.getHTML();
  t("a password field's value never reaches a snapshot", !withKey.includes(NSEC));
  t("nor does the hex form", !withKey.includes(HEX));
  t("nor is a file input's value serialised", !/id="upload"[^>]*value=/.test(withKey));
  await nc.logout();

  // --- the snapshot -------------------------------------------------------
  document.getElementById("f").value = "changed";
  const plain = nc.getHTML();
  t("runtime attributes are stripped",
    !/nc:(ready|status|pubkey|editmode|owner-here|editable|outdated)=/.test(plain));
  t("nc:chrome is stripped", !plain.includes("runtime UI"));
  t('clay="no-save" is stripped', !plain.includes("never saved"));
  t("live form state is written into markup", plain.includes('value="changed"'));
  t("the snapshot is a complete document", plain.startsWith("<!DOCTYPE html><html"));

  // --- editing ------------------------------------------------------------
  const prose = document.getElementById("prose");
  const line = document.getElementById("line");
  nc.editable.enable();
  t("an editable container is armed in edit mode", prose.isContentEditable);
  t("edit mode is legible to CSS", document.documentElement.getAttribute("nc:editable") === "true");

  const sel = getSelection(); const r = document.createRange();
  r.selectNodeContents(prose.querySelector("p"));
  sel.removeAllRanges(); sel.addRange(r);
  nc.editable.block("H2");
  t("the block menu turns a paragraph into a heading", !!prose.querySelector("h2"));
  nc.editable.block("P");
  t("and back again", !prose.querySelector("h2") && !!prose.querySelector("p"));

  r.selectNodeContents(line); sel.removeAllRanges(); sel.addRange(r);
  nc.editable.block("H2");
  t("a single-line region refuses block changes", line.tagName === "H1");

  prose.querySelector("p").innerHTML = '<font color="red"><span style="color:red">x</span></font>';
  nc.editable.normalise(prose);
  t("editor debris is normalised away", !/font|style=/i.test(prose.innerHTML), prose.innerHTML);

  t("pasted markup is sanitised",
    !/onerror|<script|javascript:/i.test(nc.sanitize('<img src=x onerror=alert(1)><script>x()<\/script>')));
  t("a table cell survives sanitising in its own context",
    nc.sanitizeAs("tr", "<td>a</td><td>b</td>").replace(/\s/g, "") === "<td>a</td><td>b</td>");

  const edited = nc.getHTML();
  t("the editable marker survives a save", /id="prose" editable/.test(edited));
  t("contenteditable does not", !/contenteditable=/.test(edited));
  t("nc:keep-editable does not", !edited.includes("nc:keep-editable"));
  t("the toolbar never reaches the file", !edited.includes('role="toolbar"'));

  // A page that inserts content while editing must be able to arm it.
  {
    const fresh = document.createElement("div");
    fresh.setAttribute("editable", "");
    fresh.innerHTML = "<p>added while editing</p>";
    document.body.appendChild(fresh);
    t("a region added while editing is not armed on its own", !fresh.isContentEditable);
    nc.editable.enable();
    t("calling enable() again arms it", fresh.isContentEditable);
    const line = document.createElement("h4");
    line.setAttribute("editable", "single-line");
    document.body.appendChild(line);
    nc.editable.refresh();
    t("refresh() does the same", line.isContentEditable);
    t("the arming marker never reaches the file", !nc.getHTML().includes("nc:armed"));
    fresh.remove(); line.remove();
  }

  nc.editable.disable();
  t("disarmed when the owner signs out", !prose.isContentEditable);

  // --- staying current ----------------------------------------------------
  t("a local copy is not an outdated version", nc.onCanonicalHost() === false);
  nc.dirty = true;                      // so nothing actually navigates
  nc._servedHash = "a".repeat(64);
  nc._ownHash = "b".repeat(64);
  nc._manifest = null;

  nc._onManifest(evs.same);
  t("a manifest matching the served bytes is not an update",
    !document.documentElement.hasAttribute("nc:outdated"));
  nc._onManifest(evs.own);
  t("our own save does not read as an update",
    !document.documentElement.hasAttribute("nc:outdated"));
  nc._onManifest(evs.newer);
  t("a newer manifest from elsewhere is an update",
    document.documentElement.getAttribute("nc:outdated") === "true");
  const banner = document.querySelector("[nc\\:chrome][role=status]");
  t("the reader is told rather than left stale", !!banner && /newer version/i.test(banner.textContent));
  t("a page with unsaved work is never reloaded under its reader",
    /unsaved changes/i.test(banner?.textContent || ""));
  t("the notice never reaches a save", !nc.getHTML().includes("newer version"));
  nc.dirty = false;

  nc._trackDirty();
  document.getElementById("f").dispatchEvent(new Event("input", { bubbles: true }));
  t("typing marks the page dirty", nc.dirty === true);
  nc._dirty = false;
  document.getElementById("secret").dispatchEvent(new Event("input", { bubbles: true }));
  t("typing a key does not count as unsaved work", nc.dirty === false);

  // --- media --------------------------------------------------------------
  t("a YouTube watch URL is recognised",
    JSON.stringify(nc.media.constructor && nc.parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
      === JSON.stringify({ provider: "youtube", id: "dQw4w9WgXcQ" }));
  t("a youtu.be short link is recognised",
    nc.parseVideoUrl("https://youtu.be/dQw4w9WgXcQ")?.id === "dQw4w9WgXcQ");
  t("a Vimeo URL is recognised", nc.parseVideoUrl("https://vimeo.com/123456789")?.provider === "vimeo");
  t("an unrelated URL is not a video", nc.parseVideoUrl("https://example.com/a.mp4") === null);

  nc.media.image({ url: "https://example.com/a.png", alt: "a" });
  nc.media.videoEmbed({ provider: "youtube", id: "dQw4w9WgXcQ", title: "demo" });
  t("an embed is a link before anyone clicks it",
    !!document.querySelector("[nc\\:video] a[href*='youtube.com/watch']") &&
    document.querySelectorAll("iframe").length === 0);
  document.querySelector("[nc\\:video] .nc-embed-link").click();
  await new Promise((r) => setTimeout(r, 80));
  t("clicking it loads the player", document.querySelectorAll("iframe").length === 1);

  const withMedia = nc.getHTML();
  t("an inserted image is saved", withMedia.includes("example.com/a.png"));
  t("the facade is saved", withMedia.includes("nc:video="));
  t("the loaded player is not", !/<iframe/.test(withMedia));

  // --- the feed widget ------------------------------------------------------
  const w = nc.feed.readFeedConfig
    ? nc.feed.readFeedConfig(document.getElementById("widget"))
    : null;
  t("a feed widget's configuration is read from its attributes",
    !!w && w.type === "notes" && w.limit === 2 && w.authors.length === 1 &&
    /^[0-9a-f]{64}$/.test(w.authors[0]));
  t("a feed's own markup is saved", withMedia.includes('nc:feed="notes"'));
  t("what a feed fetched is not", !withMedia.includes("fetched at view time"));

  // A dropdown built with no explicit value must keep its first option.
  // Assigning "" to a <select> clears the selection, which silently submitted
  // an empty string and made the feed dialog query kind `undefined`.
  {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sel = nc.field(host, { label: "t", options: [{ value: "notes", label: "Notes" }, { value: "articles", label: "Articles" }] });
    t("a dropdown defaults to its first option", sel.value === "notes", sel.value);
    const preset = nc.field(host, { label: "t", options: ["list", "grid"], value: "grid" });
    t("a dropdown honours an explicit value", preset.value === "grid");
    host.remove();
  }

  // A document must never publish a manifest that omits a file it references.
  // This is the failure that looks like the runtime is broken: the page loads,
  // its script 404s, and nothing works.
  {
    const html = '<html><head></head><body><img src="/logo.png"><script src="/app-9f2a.js"><\/script></body></html>';
    const refs = nc._referencedPaths(html);
    t("§4.2 same-origin references are found", refs.includes("/logo.png") && refs.includes("/app-9f2a.js"), refs.join(","));
    const off = nc._referencedPaths('<html><body><img src="https://example.com/x.png"><a href="#top">t</a></body></html>');
    t("§4.2 external and fragment links are not paths", off.length === 0, off.join(","));
  }

  // --- settings live in the document ---------------------------------------
  t("autosave is off unless the page asks for it", nc.settings.autosave === false);
  nc.settings.autosave = true;
  t("turning it on marks the page", document.documentElement.hasAttribute("nc:autosave"));
  t("and survives a save", nc.getHTML().includes("nc:autosave"));
  nc.settings.autosave = false;
  t("turning it off clears both spellings",
    !document.documentElement.hasAttribute("nc:autosave") && !document.documentElement.hasAttribute("autosave"));

  t("the editing controls are open by default", nc.editRequested === true);
  nc.settings.editGate = "hash";
  t("gating on hash closes them without #edit", nc.editRequested === false);
  t("and CSS can see it", document.documentElement.getAttribute("nc:editing") === "false");
  location.hash = "#edit";
  nc.applyEditGate();
  t("#edit opens them", nc.editRequested === true &&
    document.documentElement.getAttribute("nc:editing") === "true");
  t("the gate is saved with the page", nc.getHTML().includes('nc:edit-gate="hash"'));
  t("runtime state is not", !/nc:editing=/.test(nc.getHTML()));
  location.hash = "";
  nc.settings.editGate = "always";
  nc._dirty = false;

  // --- the document as a database ------------------------------------------
  nc.editable.enable();          // structural edits only arm regions while editing is on
  const board = document.getElementById("board");
  const cards = () => nc.dom.all(".card", board);

  t("a card can be duplicated", (nc.dom.clone(cards()[0]), cards().length === 3));
  t("the copy carries no id from the original",
    !nc.dom.all(".card[id]", board).length);
  t("nor a reference to one, which would point at the original's input",
    nc.dom.all("[for]", board).length === 1);   // the original keeps its own
  t("a duplicate is armed for editing straight away",
    cards()[1].querySelector("[editable]").isContentEditable);

  nc.dom.remove(cards()[1]);
  t("a card can be removed", cards().length === 2);

  const first = cards()[0].querySelector("[editable]").textContent;
  nc.dom.move(cards()[0], 1, ".card");
  t("a card can be moved past its sibling",
    cards()[1].querySelector("[editable]").textContent === first);

  nc.dom.addFrom("card-tpl", board);
  t("a <template> can be added to a container", cards().length === 3);

  const gear = board.querySelector(".nc-gear button");
  t("a gear addresses the block it sits in",
    nc.dom.cloneClosest(gear, ".card")?.classList.contains("card") === true);
  nc.dom.removeClosest(board.querySelector(".card"), ".card");

  // A board's whole point is a card crossing from one column to the next, which
  // move() cannot do because it only reorders inside one parent.
  const colA = document.getElementById("col-a"), colB = document.getElementById("col-b");
  const travelling = colA.querySelector(".card");
  nc.dom.moveTo(travelling, colB);
  t("a card can cross into another container",
    colB.contains(travelling) && !colA.contains(travelling));
  t("and it is the same node, so what was typed into it came along",
    travelling.querySelector("[editable]").textContent === "travels");
  nc.dom.moveToClosest(travelling.querySelector(".nc-gear button"), ".card", ".col", -1);
  t("a gear can walk it back one container",
    colA.contains(travelling));
  t("walking past the last container leaves it where it is",
    (nc.dom.moveToClosest(travelling.querySelector(".nc-gear button"), ".card", ".col", -1),
     colA.contains(travelling)));
  t("a container cannot be moved into its own descendant",
    nc.dom.moveTo(colA, travelling) === null);

  // --- the CMS: a form for the page, generated from the page ----------------
  const rules = nc.cms.rules();
  t("the rules block is read from the document", rules && rules.title === ".site-title");

  // The panel is owner-only, and the fixture's owner is the demo key.
  await nc.login("nsec", { key: "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y" });
  t("signed in as the fixture's owner", nc.isOwner === true);
  const panel = nc.cms.open();
  t("the panel opens", !!panel && nc.cms.isOpen);
  t("and is runtime chrome, so it never reaches the file", panel.hasAttribute("nc:chrome"));

  const fieldFor = (label) => [...panel.querySelectorAll(".nc-cms-label")]
    .find((l) => l.textContent === label)?.closest(".nc-cms-field, .nc-cms-check");

  const title = fieldFor("title").querySelector("input, textarea");
  t("a scalar field shows what the element says", title.value === "Old title");
  title.value = "New title";
  title.dispatchEvent(new window.Event("input", { bubbles: true }));
  t("typing writes straight through to the DOM",
    document.querySelector(".site-title").textContent === "New title");
  t("and marks the page unsaved", nc.dirty === true);

  const open = fieldFor("open").querySelector("input");
  open.value = "yes";
  open.dispatchEvent(new window.Event("input", { bubbles: true }));
  t("an @attribute field writes the attribute",
    document.querySelector(".status").getAttribute("data-open") === "yes");

  const cmsCards = () => [...panel.querySelectorAll(".nc-cms-card")].filter((c) => c.querySelector("input, textarea"));
  t("an object array draws one card per match, template excluded", cmsCards().length === 2);
  t("a template item is not offered as content",
    !panel.textContent.includes("Say something."));

  panel.querySelector(".nc-cms-list .nc-cms-add").click();
  t("Add copies the template rather than the last item",
    nc.dom.all("#cmsroot .post:not([nc\\:cms-template])").length === 3);
  t("and the copy is content, leaving exactly one template behind",
    nc.dom.all("#cmsroot .post[nc\\:cms-template]").length === 1);

  const html = nc.getHTML();
  t("the panel is absent from the saved file", !html.includes("nc-cms-body"));
  t("but the rules stay, because they are part of the page", html.includes("nc:cms"));
  t("and the typed title is in the file", html.includes("New title"));

  nc.cms.close();
  t("the panel closes", !nc.cms.isOpen && !document.querySelector(".nc-cms"));
  await nc.logout();             // later checks want nobody signed in

  const grouped = nc.dom.by(".card", "data-status", board);
  t("elements group by attribute, which is the query a board wants",
    grouped.size >= 1 && [...grouped.values()].every((v) => Array.isArray(v)));

  // state with no visual form
  nc.state.set({ theme: "lunarpunk", tab: "development" });
  t("JSON state round-trips through the document", nc.state.get().theme === "lunarpunk");
  nc.state.update({ tab: "design" });
  t("update merges rather than replacing",
    nc.state.get().tab === "design" && nc.state.get().theme === "lunarpunk");
  t("state is saved with the page", nc.getHTML().includes("lunarpunk"));
  nc.state.set({ evil: "</script><img src=x>" });
  t("a closing script tag in the data cannot end the block",
    !/<\/script><img/.test(nc.state.block().textContent) &&
    nc.state.get().evil === "</script><img src=x>");
  nc.state.set({});

  // A gear is part of the app and belongs in the published file. CSS keeps it
  // away from readers; clay="no-save" would strip it and the pattern would work
  // exactly once.
  t("a gear survives a save", nc.getHTML().includes("nc-gear"));
  t("but a composer marked no-save does not", !nc.getHTML().includes('id="composer"'));

  nc.editable.disable();

  // persistence, and the opt-out
  document.getElementById("filter").value = "changed-filter";
  const withForms = nc.getHTML();
  t("a control persists its value by default", withForms.includes('value="changed"'));
  t("nc:no-persist keeps a filter out of the file", !withForms.includes("changed-filter"));

  // --- a post can live in both places --------------------------------------
  {
    const article = finalizeEventInPage({
      kind: 30023, created_at: 4000,
      tags: [["d", "hosting"], ["title", "Hosting without a host"],
             ["summary", "The manifest is the deploy."], ["published_at", "4000"]],
      content: "# Why\n\nThe manifest is a **replaceable** event.\n\n- one\n- two",
    });
    const el = nc.compose.bake(article, document.body);
    t("a published post can be baked into the page", !!el && el.classList.contains("nc-baked"));
    t("the baked copy remembers the event it came from",
      /^naddr1/.test(el.getAttribute("nc:from") || ""));
    {
      const md = nc.compose.render({ kind: 30023, pubkey: PUB, id: "c".repeat(64), created_at: 1,
        tags: [["d", "img"], ["title", "T"]],
        content: "Look:\n\n![](https://example.com/a.png)\n\nAnd ![a cat](https://example.com/b.png) inline." });
      const html = md.innerHTML;
      t("a Markdown image with no alt text becomes an image",
        /<img[^>]+src="https:\/\/example\.com\/a\.png"/.test(html), html.slice(0, 90));
      t("and one with alt text keeps it",
        /<img[^>]+src="https:\/\/example\.com\/b\.png"[^>]*alt="a cat"|alt="a cat"[^>]*src="https:\/\/example\.com\/b\.png"/.test(html));
      t("the image is not left as literal text", !html.includes("!["));
    }

    t("Markdown becomes real markup", /<h2>Why<\/h2>/.test(el.innerHTML) && /<strong>/.test(el.innerHTML));
    t("a list survives", /<li>one<\/li>/.test(el.innerHTML));
    t("the baked copy is editable", el.querySelector("[editable]") !== null);
    t("it is in the saved file, so a reader needs no relay", nc.getHTML().includes("Hosting without a host"));

    const again = nc.compose.bake(article, document.body);
    t("re-baking replaces rather than stacking",
      document.querySelectorAll('[nc\\:from="' + again.getAttribute("nc:from") + '"]').length === 1);
    el.remove(); again.remove();
  }

  // A nostrconnect URI carries the client key and the one-time secret, so the
  // sign-in code has to be drawn here rather than fetched from a QR service.
  {
    const uri = "nostrconnect://" + "a".repeat(64) + "?relay=wss://nos.lol&secret=deadbeef";
    const svg = nc.qrSvg(uri, { size: 200 });
    t("§8.2 the sign-in code is an inline SVG", svg.startsWith("<svg") && svg.includes("<path"));
    // The only URL in it is the SVG namespace declaration, which fetches nothing.
    const urls = (svg.match(/https?:\/\/[^"'\s]+/g) || []).filter((u) => u !== "http://www.w3.org/2000/svg");
    t("§8.2 it fetches nothing from anywhere", urls.length === 0, urls.join(","));
    const el = nc.qrElement(uri);
    t("§8.2 and comes back as a real element", el.tagName.toLowerCase() === "svg");
  }

  // --- where a post opens --------------------------------------------------
  {
    // The routes differ between an article and a note, and between clients.
    // Each of these was checked against the live site; a wrong one is a 404
    // that nothing here would otherwise notice.
    const article = { kind: 30023, pubkey: PUB, id: "a".repeat(64), created_at: 1,
                      tags: [["d", "hello"], ["title", "Hello"]], content: "# Hi\n\nBody **here**." };
    const note = { kind: 1, pubkey: PUB, id: "b".repeat(64), created_at: 1, tags: [], content: "just a note" };
    const naddr = nc.addressOf(article), nevent = nc.addressOf(note);
    t("an addressable event is named by its address", naddr.startsWith("naddr1"));
    t("a note is named by its event id", nevent.startsWith("nevent1"));

    t("njump takes both at the root",
      nc.postUrl(article, "njump") === `https://njump.me/${naddr}` &&
      nc.postUrl(note, "njump") === `https://njump.me/${nevent}`);
    t("yakihonne puts an article under /article and a note under /note",
      nc.postUrl(article, "yakihonne") === `https://yakihonne.com/article/${naddr}` &&
      nc.postUrl(note, "yakihonne") === `https://yakihonne.com/note/${nevent}`);
    t("primal puts an article under /a and a note under /e",
      nc.postUrl(article, "primal") === `https://primal.net/a/${naddr}` &&
      nc.postUrl(note, "primal") === `https://primal.net/e/${nevent}`);
    t("an unknown name falls back rather than building a broken URL",
      nc.postUrl(note, "nosuchclient") === `https://njump.me/${nevent}`);
    t("the reader still has a real link behind it, for a middle click",
      nc.postUrl(note, "reader") === `https://njump.me/${nevent}`);

    const custom = nc.postUrl(article, "https://x.example/{kind}/{npub}/{d}/{id}");
    t("a custom URL fills in every variable",
      custom === `https://x.example/30023/${nc.nip19.npubEncode(PUB)}/hello/${naddr}`,
      custom);

    // Reading it in the page.
    nc.feed.openPost(article, "reader");
    const read = document.querySelector(".nc-read");
    t("the reader opens over the page", !!read);
    t("it renders the Markdown", !!read.querySelector(".nc-read-body strong"));
    t("it shows the title", read.querySelector(".nc-read-title")?.textContent === "Hello");
    t("it offers a way out to a real client", /njump\.me/.test(read.querySelector(".nc-read-out a")?.href || ""));
    t("the page is marked as reading", document.documentElement.getAttribute("nc:reading") === "true");

    const whileReading = nc.getHTML();
    t("an open post never reaches a save", !whileReading.includes("nc-read-card"));
    t("nor does the reading attribute", !/nc:reading/.test(whileReading));

    nc.feed.openPost(note, "reader");
    t("opening another replaces the first", document.querySelectorAll(".nc-read").length === 1);

    // A card is what the reader opens from, and a feed of notes has no title
    // link, so the date has to be one of the openers.
    for (const [kind, type, expect] of [[30023, "articles", 2], [1, "notes", 1]]) {
      const ev = { kind, pubkey: PUB, id: String(kind).padStart(64, "d"), created_at: 1,
                   tags: kind === 30023 ? [["d", "x"], ["title", "T"]] : [], content: "hello" };
      const el = nc.feed.card(ev, { type, style: "list", openWith: "reader" });
      t(`a ${type} card offers ${expect} way(s) into the reader`,
        el.querySelectorAll("a[nc\\:open]").length === expect,
        String(el.querySelectorAll("a[nc\\:open]").length));
      t(`and its date link is one of them`, el.querySelector("a.nc-when")?.hasAttribute("nc:open") === true);
      t(`while the author's name is not`, el.querySelector("a.nc-name")?.hasAttribute("nc:open") !== true);
    }

    nc.feed.closePost();
    t("closing takes it away", !document.querySelector(".nc-read"));
    t("and unmarks the page", !document.documentElement.hasAttribute("nc:reading"));
    nc.feed.closePost();
    t("closing twice is harmless", !document.querySelector(".nc-read"));
    // A page can gain its first feed from the block palette long after load.
    t("the reader is armed even before any feed exists", nc.feed._armedReader === true);
  }

  // --- blocks -------------------------------------------------------------
  {
    const area = document.getElementById("blockarea");
    const before = nc.blocks.blocksIn(area).length;
    t("a block area is found", nc.blocks.containers().length === 1);
    t("blocks are its element children", before === 2);
    const lib = nc.blocks.library();
    t("the library comes from the page's <template> elements", lib.size === 3);
    t("a library entry carries its palette label", lib.get("heading").label === "Heading");
    t("and its picker, where it has one", lib.get("picture").onAdd === "image");
    t("a <template> is not itself a block", !nc.blocks.blocksIn(area).some((b) => b.tagName === "TEMPLATE"));

    await nc.blocks.add("heading", { container: area });
    t("adding appends a block", nc.blocks.blocksIn(area).length === before + 1);
    const added = nc.blocks.blocksIn(area).at(-1);
    t("the copy is stamped with its type", added.getAttribute("nc:block-type") === "heading");
    t("adding an unknown block is refused rather than throwing",
      (await nc.blocks.add("nosuchblock", { container: area })) === null);

    // The rails and insert points must not be mistaken for content, and must
    // never be written to disk.
    nc.blocks.arm();
    t("arming draws a rail on every block",
      document.querySelectorAll(".nc-blk-rail").length === before + 1);
    t("and an insert point between and after each",
      document.querySelectorAll(".nc-blk-add").length === before + 2);
    t("a rail is not counted as a block", nc.blocks.blocksIn(area).length === before + 1);

    // Moving has to skip the insert points sitting between the blocks.
    nc.blocks.moveBlock(added, -1);
    t("moving up swaps with the block above, not with an insert point",
      nc.blocks.blocksIn(area).at(-2) === added);
    nc.blocks.moveBlock(added, 1);
    t("and back down again", nc.blocks.blocksIn(area).at(-1) === added);
    t("moving past the end does nothing",
      nc.blocks.moveBlock(added, 1) === added && nc.blocks.blocksIn(area).at(-1) === added);

    const withBlocks = nc.getHTML();
    t("no rail reaches the saved file", !withBlocks.includes("nc-blk-rail"));
    t("no insert point reaches the saved file", !withBlocks.includes("nc-blk-add"));
    t("the library does reach the saved file, so the next editor has it",
      withBlocks.includes('nc:block="heading"'));
    t("and so does the added block",
      (withBlocks.match(/nc:block-type="heading"/g) || []).length === 2);

    nc.blocks.disarm();
    t("disarming takes every rail away", document.querySelectorAll(".nc-blk-rail").length === 0);
    nc.dom.remove(added);
  }

  // --- saving guards ------------------------------------------------------
  t("a save without a signer is refused", /signed in/i.test(await err(() => nc.save())));
  await nc.login("nsec", { key: NSEC });   // a writer, but not this site's owner
  t("a save by anyone but the owner is refused", /owner/i.test(await err(() => nc.save())));
  await nc.logout();

  return out;
}, { evs: events, NSEC, HEX, PUB });

server.close();
await browser.close();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "  ok  " : "FAIL  "}${r.name}${r.detail ? "   (" + r.detail + ")" : ""}`);
}
for (const e of errors) console.log(`FAIL  uncaught page error: ${e}`);
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
