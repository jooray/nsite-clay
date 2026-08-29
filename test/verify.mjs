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
