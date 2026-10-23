// An old copy the browser kept. nsite.lol serves every page for an hour from
// cache, so after a save the plain address, or Back, can hand back the page as
// it was. The page has to notice that it is not what the manifest says and
// fetch the new one; the browser that saved has to stop keeping the old one;
// and a save from an old copy must not publish it over the new text.
//
// Real pages in the installed Chrome, on an address that looks like the site's
// own gateway host (resolved to a local server sending nsite.lol's cache
// header), with the relay answered inside the browser so nothing leaves it.
//
// Run: node test/stale-copy.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { finalizeEvent, nip19 } from "nostr-tools";

const NSEC = "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y";
const NPUB = "npub16kwfcualkq4kz6vgs8tze0j4jkpgs53h48ghmpnj80s7cvfjspwsh4uk9u";
const SK = nip19.decode(NSEC).data;

const page = (path, title, words) => `<!doctype html><html lang="en" nc:owner="${NPUB}" nc:path="${path}" ` +
  `nc:edit-gate="hash" nc:runtime-owner="off" nc:relays="wss://relay.test" nc:servers="https://blossom.test">` +
  `<head><title>${title}</title></head><body><main><h1 editable="single-line">${words}</h1></main>` +
  `<script src="/nsite-clay.js"></script></body></html>`;
const sha = (text) => createHash("sha256").update(text).digest("hex");

// What the gateway serves now, and what the relay says it should be.
const now = { "/index.html": page("/index.html", "Bakery", "Open on Saturdays"), "/about.html": page("/about.html", "About", "About us") };
let table = {};
const publish = () => { table = Object.fromEntries(Object.entries(now).map(([p, html]) => [p, sha(html)])); };
publish();
const manifest = () => finalizeEvent({
  kind: 15128, created_at: Math.floor(Date.now() / 1000), content: "",
  tags: Object.entries(table).map(([p, h]) => ["path", p, h]),
}, SK);

const hits = [];
const server = createServer((q, r) => {
  const p = new URL(q.url, "http://l").pathname;
  const doc = p === "/" ? "/index.html" : p;
  if (now[doc]) {
    hits.push(p);
    const html = now[doc];
    r.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600", ETag: `"${sha(html)}"` });
    return r.end(html);
  }
  if (p === "/nsite-clay.js") { r.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=3600" }); return r.end(readFileSync("dist/nsite-clay.js")); }
  r.writeHead(404); r.end();
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://${NPUB}.nsite.lol:${server.address().port}`;

const out = [];
const t = (name, pass, detail = "") => out.push([name, !!pass, detail]);
const browser = await chromium.launch({ channel: "chrome", args: ["--host-resolver-rules=MAP *.nsite.lol 127.0.0.1"] });
const context = await browser.newContext();
await context.routeWebSocket("**", (ws) => {
  ws.onMessage((raw) => {
    const msg = JSON.parse(String(raw));
    if (msg[0] === "REQ") { ws.send(JSON.stringify(["EVENT", msg[1], manifest()])); ws.send(JSON.stringify(["EOSE", msg[1]])); }
    if (msg[0] === "EVENT") ws.send(JSON.stringify(["OK", msg[1].id, true, ""]));
  });
});
const p = await context.newPage();
p.on("pageerror", (e) => out.push(["pageerror", false, e.message]));
const heading = () => p.evaluate(() => document.querySelector("h1")?.textContent);
const settle = () => p.evaluate(async () => { await nc.ready; await new Promise((r) => setTimeout(r, 400)); });

try {
  await p.goto(base + "/");
  await settle();
  t("the current page is left alone", await heading() === "Open on Saturdays" &&
    !(await p.evaluate(() => document.documentElement.hasAttribute("nc:outdated"))));

  // Somebody saves the page elsewhere. This browser still holds the old one.
  now["/index.html"] = page("/index.html", "Bakery", "Open every day");
  publish();
  await p.goto(base + "/about.html");
  await settle();
  hits.length = 0;
  await p.goto(base + "/");
  const first = await heading();
  t("the browser really does show its old copy first (what this is about)", first === "Open on Saturdays", first);
  await p.waitForFunction(() => document.querySelector("h1")?.textContent === "Open every day", null, { timeout: 15000 }).catch(() => {});
  t("an old copy found as the page opens is replaced by the published one", await heading() === "Open every day", await heading());
  t("at its plain address, without ?v=", new URL(p.url()).search === "", p.url());
  await settle();
  t("and the new copy is not mistaken for an old one", !(await p.evaluate(() => document.documentElement.hasAttribute("nc:outdated"))));

  // Back, after another save elsewhere.
  now["/index.html"] = page("/index.html", "Bakery", "Closed for the holidays");
  publish();
  await p.goto(base + "/about.html");
  await settle();
  await p.goBack();
  await p.waitForFunction(() => document.querySelector("h1")?.textContent === "Closed for the holidays", null, { timeout: 15000 }).catch(() => {});
  t("Back to an old copy ends on the published page too", await heading() === "Closed for the holidays", await heading());

  // The browser that saved. Its copy of /about.html is the old one; after the
  // save it should hold the new one under both addresses, without anybody
  // reloading anything.
  await p.goto(base + "/about.html");
  await settle();
  now["/about.html"] = page("/about.html", "About", "About the bakers");
  publish();
  await p.evaluate((h) => nc._refreshCached({ "/about.html": h }), table["/about.html"]);
  await p.waitForFunction(() => !nc._refreshing?.size, null, { timeout: 15000 }).catch(() => {});
  const fromCache = await p.evaluate(async () => (await (await fetch("/about.html", { cache: "only-if-cached", mode: "same-origin" })).text()).includes("About the bakers"));
  t("a save leaves the browser's cache holding the new bytes", fromCache);
  await p.goto(base + "/");
  await settle();
  hits.length = 0;
  await p.goto(base + "/about.html");
  t("so going back to that page shows the save straight away", await heading() === "About the bakers", await heading());
  t("from the cache, without asking the gateway", !hits.includes("/about.html"), hits.join(","));

  // A save from an old copy. The tab is shown "About the bakers"; the page is
  // then saved again elsewhere, and this tab tries to save what it has.
  await settle();
  now["/about.html"] = page("/about.html", "About", "About the new bakers");
  publish();
  const refused = await p.evaluate(async (nsec) => {
    nc.dirty = true;                                 // so nothing reloads under the test
    nc.signer = new nc.LocalSigner(nsec);
    nc._manifest = null; nc._bootManifest = null;
    try { await nc.save(); return null; } catch (e) { return String(e.message || e); }
  }, NSEC);
  t("a save from an old copy is refused rather than publishing the old text", /newer version of this page/i.test(refused || ""), refused || "saved");
} catch (e) {
  t("ran to the end", false, e.stack);
} finally {
  await browser.close();
  server.close();
}

let failed = 0;
for (const [name, pass, detail] of out) {
  if (!pass) failed++;
  console.log(`${pass ? "  ok" : "FAIL"}  ${name}${!pass && detail ? `\n        ${detail}` : ""}`);
}
console.log(`${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);
