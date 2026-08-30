#!/usr/bin/env node
// The publisher, driven end to end, with a screenshot at every step.
//
// This is where the pictures in site/guide.html come from, and it is also the
// only test that covers the whole path: a key that did not exist a second ago,
// through the wizard, onto a relay and a Blossom server, back out of a gateway,
// edited in the browser and saved again.
//
// It runs against tools/devnet.mjs, so nothing here reaches a public relay.
// The screenshots still show real addresses because the wizard computes the
// nsite.lol URL from the npub rather than from where it happens to be running.
//
//   node tools/publish-walkthrough.mjs [--headed] [--keep]
//
// The example site is a Nostr meetup during Lunarpunk Košice. The picture and
// the feed are that event's own, which is the point: a template becomes a real
// page by pulling in real things.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

const HEADED = process.argv.includes("--headed");
const OUT = join("media", "guide-publish");
const PICTURE = process.env.WALKTHROUGH_PICTURE ||
  join(process.env.TMPDIR || "/tmp", "lunarpunk.jpg");

const RELAY = "ws://127.0.0.1:4869";
const BLOSSOM = "http://127.0.0.1:4870";
const GATEWAY = "http://127.0.0.1:4871";
// A published page asks for /nsite-clay-xxxxxxxx.js with no query string, so the
// gateway has to work out whose site it is from the hostname. Chrome resolves
// anything under .localhost to 127.0.0.1, and an npub is exactly 63 characters,
// which is the most a DNS label may hold. So the browser visits the site the way
// a real gateway serves it, by name.
const siteHost = (npub) => `http://${npub}.localhost:4871`;

// Whose posts the meetup page shows, and whose event it sits inside.
const LUNARPUNK = "npub1q9mfvl56uje98qklyk32q3cekp4ex8mljfx0zd2qkxcqv8n0gu0qk73vv7";
const READ_RELAYS = "wss://nostr.cypherpunk.today,wss://relay.primal.net,wss://nos.lol";

mkdirSync(OUT, { recursive: true });
if (!existsSync(PICTURE)) {
  console.error(`No picture at ${PICTURE}.\n` +
    `Download the event's image first, or point WALKTHROUGH_PICTURE at one:\n` +
    `  curl -sLo /tmp/lunarpunk.jpg https://image.nostr.build/b9bf63cdfad604ce65598797a5564c9f1e9d7b45ccfef07df3016442addfd9eb.jpg`);
  process.exit(1);
}

// ---------------------------------------------------------------- the stage

const devnet = spawn("node", ["tools/devnet.mjs", "--quiet"], { stdio: "ignore" });
const stop = () => { try { devnet.kill(); } catch {} };
process.on("exit", stop);

// site/, with the relay and Blossom lists pointed at the devnet. The wizard
// uploads the bytes it is served, so patching here is what keeps the published
// page talking to localhost rather than to somebody else's relay.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".md": "text/markdown" };

const local = (html) => html
  .replace(/nc:relays="[^"]*"/g, `nc:relays="${RELAY}"`)
  .replace(/nc:servers="[^"]*"/g, `nc:servers="${BLOSSOM}"`);

const site = createServer((req, res) => {
  let path = decodeURIComponent(req.url.split("?")[0]);
  if (path.endsWith("/")) path += "index.html";
  const file = join("site", path);
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404); return res.end("not found"); }
  const ext = extname(file).toLowerCase();
  if (ext === ".html") body = Buffer.from(local(body.toString("utf8")), "utf8");
  res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(body);
}).listen(0);
const SITE = `http://127.0.0.1:${site.address().port}`;

await new Promise((r) => setTimeout(r, 1000));

// ------------------------------------------------------------------ driving

const browser = await chromium.launch({ channel: "chrome", headless: !HEADED });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name, opts = {}) => {
  await page.screenshot({ path: join(OUT, `${name}.png`), ...opts });
  console.log(`  shot  ${name}`);
};
const step = (n) => console.log(n);
// The dialogs scroll, and a long list of posts can end up over the button, so
// the primary action is triggered through the form rather than by a click.
const submit = () => page.evaluate(() => {
  const form = document.querySelector(".nc-ui .nc-ui-card");
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
});

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

step("\nThe publisher");
await page.goto(`${SITE}/deploy.html`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.nc && document.documentElement.getAttribute("nc:ready") === "true");
await sleep(400);
await shot("p1-start");

// --- a key that did not exist a moment ago ---------------------------------
await page.click("#way-new");
await sleep(350);
const nsec = (await page.textContent("#newkey-nsec")).trim();
check("a key is generated and shown once", /^nsec1[a-z0-9]{58}$/.test(nsec));
await shot("p2-new-key");

// The backup file is part of the flow, so it is part of the test.
await page.click("#newkey-file");
await page.fill("#encpass", "a-long-enough-password");
const download = page.waitForEvent("download").catch(() => null);
await page.click("#encgo");
const file = await download;
check("an encrypted backup file is offered", !!file);
if (file) {
  const saved = join(OUT, "..", "..", ".walkthrough-backup.txt");
  await file.saveAs(saved);
  check("and it holds a NIP-49 ncryptsec", readFileSync(saved, "utf8").includes("ncryptsec1"));
}
await shot("p3-backup");

await page.check("#newkey-ok");
await page.click("#newkey-go");
await page.waitForSelector('section.step[data-step="2"][data-on]');
await sleep(900);

// --- template ---------------------------------------------------------------
step("\nPicking a template");
await page.waitForSelector(".tpl");
const templates = await page.locator(".tpl").count();
check(`the catalogue loads (${templates} templates)`, templates >= 12);
check("the block composer is offered first",
  (await page.locator(".tpl .name").first().textContent()).trim() === "cms");
await shot("p4-templates");

// Clicking the card is the choice; there is no second button to confirm it.
await page.locator(".tpl").first().click();
await page.waitForSelector('section.step[data-step="3"][data-on]');
await sleep(700);
check("clicking a template goes straight on", true);

// A step already passed is a way back to it.
check("the template step is offered as a way back",
  await page.locator('#steps li[data-step="2"][data-go]').count() === 1);
await page.locator('#steps li[data-step="2"]').click();
await page.waitForSelector('section.step[data-step="2"][data-on]');
check("clicking it returns to the template list", true);
await page.locator(".tpl").first().click();
await page.waitForSelector('section.step[data-step="3"][data-on]');
await sleep(700);

// --- where ------------------------------------------------------------------
step("\nChoosing the address");
const preview = await page.textContent("#path-preview");
check("the address is shown before publishing", /nsite\.lol\/$/.test(preview.trim()));
check("a fresh key has nothing to overwrite", await page.locator("#occupied").isHidden());
await shot("p5-address");

// --- publish ----------------------------------------------------------------
step("\nPublishing");
await page.click("#where-go");
await page.waitForSelector("#done-card:not([hidden])", { timeout: 60000 });
await sleep(400);
const url = (await page.textContent("#done-url")).trim();
const npub = url.match(/https:\/\/(npub1[a-z0-9]+)\./)[1];
check("it reports a real nsite address", url.startsWith(`https://${npub}.nsite.lol/`));
check("the address belongs to the generated key",
  npub === nip19.npubEncode(getPublicKey(nip19.decode(nsec).data)));
await shot("p6-published");

// --- what was actually published --------------------------------------------
step("\nWhat landed");
const served = await fetch(`${GATEWAY}/?npub=${npub}`).then((r) => r.text());
check("the gateway serves the page", served.includes("<!DOCTYPE html>"));
check("the owner is the new key", served.includes(`nc:owner="${npub}"`));
check("no trace of the template author's key",
  !served.includes("npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2"));
check("the feed was repointed at the new owner too",
  (served.match(new RegExp(npub, "g")) || []).length >= 2);
check("the runtime is fingerprinted", /\/nsite-clay-[0-9a-f]{8}\.js/.test(served));
check("the document knows its own path", served.includes('nc:path="/index.html"'));
if (process.env.WALKTHROUGH_EXTRA) {
  const extra = await fetch(`${GATEWAY}/${process.env.WALKTHROUGH_EXTRA}?npub=${npub}`).then((r) => r.status);
  check(`a template's own files travel with it (${process.env.WALKTHROUGH_EXTRA})`, extra === 200);
}

// ---------------------------------------------------------------- editing it

step("\nEditing the published page");
await page.goto(`${siteHost(npub)}/#edit`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.nc && document.documentElement.getAttribute("nc:ready") === "true");
await page.evaluate((key) => nc.login("nsec", { key }), nsec);
await sleep(700);
check("the key that published it is the owner", await page.evaluate(() => nc.isOwner));
await shot("p7-editing");

// The palette, which is the thing this template is for.
await page.evaluate(() => void nc.blocks.open());
await sleep(500);
await shot("p8-palette");
await submit();
await sleep(250);

// Words first.
await page.evaluate(() => {
  const set = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text; };
  set(".site-title", "Nostr meetup Košice");
  set(".tagline", "Saturday 5 September 2026, 22:00, Paralelná Polis Košice");
  set('[nc\\:block-type="lead"] p',
    "An open evening for anyone who builds on Nostr, or wants to. It runs at the end of the " +
    "Lunarpunk Košice day, in the same building, and you do not need a ticket for it.");
  set('[nc\\:block-type="heading"] h2', "What happens");
  const body = document.querySelector('[nc\\:block-type="text"] [editable]');
  if (body) body.innerHTML =
    "<p>Short talks from whoever wants to give one, then the floor is open. Past evenings have " +
    "gone from key management to whether relays should charge, usually in one sentence.</p>" +
    "<p>Bring a laptop if you are building something. Bring nothing if you are not.</p>";
  const cards = [...document.querySelectorAll('[nc\\:block-type="cards"] .card')];
  const rows = [["22:00", "Doors, in the Paralelná Polis café."],
                ["22:30", "Lightning talks. Five minutes each, no slides required."],
                ["Later", "Open floor for as long as anyone is still talking."]];
  cards.forEach((card, i) => {
    if (!rows[i]) return;
    card.querySelector("h3").textContent = rows[i][0];
    card.querySelector("p").textContent = rows[i][1];
  });
  set('[nc\\:block-type="quote"] blockquote',
    "The best conversations at a conference happen after the conference.");
  set('[nc\\:block-type="quote"] cite', "Every conference, ever");
  const btn = document.querySelector('[nc\\:block-type="button"] a');
  if (btn) { btn.textContent = "Lunarpunk Košice, all day"; btn.href = "https://lunarpunk.cypherpunk.today"; }
  const foot = document.querySelectorAll("footer p");
  if (foot[0]) foot[0].textContent = "Paralelná Polis Košice, Hlavná 68. Saturday 5 September 2026, from 22:00.";
  if (foot[1]) foot[1].textContent = "This page is an nsite. It belongs to a key, not to a company.";
  nc.dirty = true;
});
await sleep(300);

// A picture, uploaded rather than linked.
step("\nAdding a picture");
await page.evaluate(() => {
  const img = document.querySelector('[nc\\:block-type="picture"] img');
  void nc.media.promptImage({ target: img });
});
await sleep(600);
await page.setInputFiles(".nc-ui input[type=file]", PICTURE);
await page.waitForFunction(
  () => /uploaded/i.test(document.querySelector(".nc-ui .nc-status")?.textContent || ""),
  { timeout: 30000 });
await page.evaluate(() => {
  const inputs = [...document.querySelectorAll(".nc-ui input[type=text]")];
  inputs[1].value = "The hall at Paralelná Polis during Lunarpunk Košice";
  inputs[2].value = "Lunarpunk Košice, where the meetup happens.";
  for (const i of inputs) i.dispatchEvent(new Event("input", { bubbles: true }));
});
await sleep(400);
await shot("p9-picture");
await submit();
await sleep(700);
check("the picture went to Blossom and into the page", await page.evaluate(
  () => (document.querySelector('[nc\\:block-type="picture"] img')?.src || "").includes("127.0.0.1:4870")));

// The feed, pointed at the event's own account.
step("\nAdding the feed");
// A feed widget may name its own relays, which is how a page published to one
// relay shows posts that live on others. Set before the picker opens, so the
// picker browses the same relays the finished feed will read.
await page.evaluate((relays) => {
  document.querySelector('[nc\\:block-type="feed"] [nc\\:feed]')
    .setAttribute("nc:feed-relays", relays);
}, READ_RELAYS);
await page.evaluate(() => {
  const el = document.querySelector('[nc\\:block-type="feed"] [nc\\:feed]');
  void nc.feed.promptInsert({ target: el });
});
await sleep(600);
await page.evaluate((authors) => {
  const inputs = [...document.querySelectorAll(".nc-ui input, .nc-ui select")];
  const byLabel = (text) => inputs.find((i) => i.previousElementSibling?.textContent?.includes(text));
  const a = byLabel("Authors");
  a.value = authors;
  a.dispatchEvent(new Event("input", { bubbles: true }));
}, LUNARPUNK);
await sleep(4000);
await shot("p10-feed");
await submit();
await sleep(1200);

await page.evaluate(() => {
  const heading = document.querySelector('[nc\\:block-type="feed"] .b-label');
  if (heading) heading.textContent = "From Lunarpunk Košice";
  return nc.feed.load(document.querySelector('[nc\\:block-type="feed"] [nc\\:feed]'));
});
await sleep(3000);
check("the feed shows real posts", await page.evaluate(
  () => document.querySelectorAll('[nc\\:feed] .nc-item').length > 0));

// --- save -------------------------------------------------------------------
step("\nSaving");
const saved = await page.evaluate(() => nc.save().then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, error: e.message })));
check("the page saves itself back to its own key", saved.ok === true);
await sleep(500);
await shot("p11-saved");

// --- and as a reader sees it ------------------------------------------------
step("\nAs a reader gets it");
await page.goto(`${siteHost(npub)}/`, { waitUntil: "networkidle" });
await sleep(3500);
const readerHtml = await page.content();
check("a reader gets no editing controls", !readerHtml.includes("nc-blk-rail"));
check("the words are the edited ones", readerHtml.includes("Nostr meetup Košice"));
check("the picture is in the published file", readerHtml.includes("127.0.0.1:4870"));
await shot("p12-reader", { fullPage: true });
await page.setViewportSize({ width: 1180, height: 820 });
await sleep(300);
await shot("p13-reader-top");

// --- publishing a second page to the same key -------------------------------
step("\nA second page under the same key");
await page.goto(`${SITE}/deploy.html`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.nc && document.documentElement.getAttribute("nc:ready") === "true");
await page.click("#way-key");
await page.fill("#key", nsec);
await page.click("#key-go");
await page.waitForSelector('section.step[data-step="2"][data-on]');
await page.waitForSelector(".tpl");
await page.locator(".tpl").first().click();
await page.waitForSelector('section.step[data-step="3"][data-on]');
await page.fill("#path", "/notes");
await sleep(1800);
check("the wizard notices the key already has a site",
  await page.locator("#occupied").isVisible());
check("and says the existing pages are left alone",
  !(await page.locator("#occupied").getAttribute("class")).includes("warn"));
await shot("p14-second-page");

await page.fill("#path", "/");
await sleep(1800);
check("but warns before replacing the page that is there",
  (await page.locator("#occupied").getAttribute("class")).includes("warn"));
check("and refuses to publish until that is confirmed", await page.evaluate(() => {
  document.querySelector("#where-go").click();
  return !document.querySelector("#where-error").hidden;
}));
await shot("p15-overwrite-warning");

await page.fill("#path", "/notes");
await sleep(1500);
await page.click("#where-go");
await page.waitForSelector("#done-card:not([hidden])", { timeout: 60000 });
const second = (await page.textContent("#done-url")).trim();
check("the second page publishes alongside the first", second.endsWith("/notes/"));

// The runtime, the stylesheet and the chrome are the same blobs as the first
// publish, so a second site under the same key should send only its document.
const reuse = await page.textContent("#log");
check("the shared blobs were not uploaded twice", /already there/.test(reuse));

check("after publishing there is nothing to go back to",
  await page.locator("#steps li[data-go]").count() === 0);

const stillThere = await fetch(`${GATEWAY}/?npub=${npub}`).then((r) => r.text());
check("and the first page is still there", stillThere.includes("Nostr meetup Košice"));
const notes = await fetch(`${GATEWAY}/notes/?npub=${npub}`).then((r) => r.status);
check("with the new one served from its own path", notes === 200);

// ------------------------------------------------------------------ finished

writeFileSync(join(OUT, "walkthrough.json"), JSON.stringify({
  npub, url, second, when: new Date().toISOString(),
}, null, 2) + "\n");

for (const e of errors) { console.log(`  FAIL  uncaught page error: ${e}`); failures++; }
console.log(`\n${failures ? failures + " failed" : "everything passed"}`);
console.log(`screenshots in ${OUT}/`);
console.log(`the walkthrough site was ${npub}`);

await browser.close();
site.close();
stop();
process.exit(failures ? 1 : 0);
