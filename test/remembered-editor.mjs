// The remembered editor: once the owner has signed in on a site in a browser,
// later visits there open the edit gate as #edit would, and nobody else's
// browser changes at all.
//
// Real pages in the installed Chrome, with the shared toolbar script from
// templates/_shared, every WebSocket refused so nothing reaches a relay.
//
// Run: node test/remembered-editor.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const NSEC = "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y";
const NPUB = "npub16kwfcualkq4kz6vgs8tze0j4jkpgs53h48ghmpnj80s7cvfjspwsh4uk9u";
const STRANGER = "1".repeat(64);          // a valid key that is not the owner's

const page = (path, title) => `<!doctype html><html lang="en" nc:owner="${NPUB}" nc:path="${path}" ` +
  `nc:edit-gate="hash" nc:runtime-owner="off" nc:autoreload="false"><head><title>${title}</title>` +
  `<link rel="stylesheet" href="/nsite-clay-base.css"></head><body><main><h1 editable="single-line">${title}</h1>` +
  `<p editable>Open on Saturdays.</p></main>` +
  `<div class="nc-bar nc-ui-chrome"><span class="nc-dot"></span><span class="nc-who" data-nc-who>read-only</span>` +
  `<button data-nc-signin>Sign in</button><button class="nc-owner-only" data-nc-settings>Settings</button>` +
  `<button class="nc-primary nc-owner-only" data-nc-save>Save</button></div>` +
  `<p class="nc-edit-hint">add #edit to the URL to edit this page</p>` +
  `<script src="/nsite-clay.js"></script><script src="/nsite-clay-chrome.js"></script></body></html>`;

const files = {
  "/nsite-clay.js": ["dist/nsite-clay.js", "text/javascript"],
  "/nsite-clay-chrome.js": ["templates/_shared/nsite-clay-chrome.js", "text/javascript"],
  "/nsite-clay-base.css": ["templates/_shared/nsite-clay-base.css", "text/css"],
};
const server = createServer((q, r) => {
  const p = new URL(q.url, "http://l").pathname;
  if (p === "/" || p === "/index.html") { r.writeHead(200, { "Content-Type": "text/html" }); return r.end(page("/index.html", "Bakery")); }
  if (p === "/about.html") { r.writeHead(200, { "Content-Type": "text/html" }); return r.end(page("/about.html", "About")); }
  const f = files[p];
  if (!f) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "Content-Type": f[1] }); r.end(readFileSync(f[0]));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const out = [];
const t = (name, pass, detail = "") => out.push([name, !!pass, detail]);
const browser = await chromium.launch({ channel: "chrome" });

const open = async (context, path = "/") => {
  const p = await context.newPage();
  p.on("pageerror", (e) => out.push(["pageerror", false, e.message]));
  await p.routeWebSocket("**", (ws) => ws.close());
  await p.goto(base + path);
  await p.evaluate(async () => { await nc.ready; await new Promise((r) => setTimeout(r, 50)); });
  return p;
};
const look = (p) => p.evaluate(() => ({
  requested: nc.editRequested,
  editing: document.documentElement.getAttribute("nc:editing"),
  toolbar: getComputedStyle(document.querySelector(".nc-bar")).display !== "none",
  signedIn: !!nc.pubkey,
  stored: Object.keys(localStorage).filter((k) => k.startsWith("nsite-clay.editor")),
}));
const goto = async (p, path) => {
  await p.goto(base + path);
  await p.evaluate(async () => { await nc.ready; await new Promise((r) => setTimeout(r, 50)); });
};

// Signing in as the owner also keeps the sign-in for this tab, so the next page
// opens signed in. This file is about the note that opens the controls, which
// is what a new tab, or one whose hour ran out, still has: so the kept sign-in
// is let go here. test/kept-signin.mjs is about the sign-in itself.
const signIn = (p) => p.evaluate(async (k) => {
  await nc.login("nsec", { key: k });
  for (const name of Object.keys(sessionStorage)) if (name.startsWith("nsite-clay.session")) sessionStorage.removeItem(name);
}, NSEC);

try {
  // --- a reader who never signed in -----------------------------------------
  const readers = await browser.newContext();
  const reader = await open(readers);
  let s = await look(reader);
  t("a plain visitor gets the page with the controls shut", s.requested === false && s.editing === "false" && !s.toolbar, JSON.stringify(s));
  t("and nothing is written to their browser", s.stored.length === 0, JSON.stringify(s.stored));

  // Somebody signing in who is not the owner is not remembered.
  await goto(reader, "/#edit");
  await reader.evaluate((k) => nc.login("nsec", { key: k }), STRANGER);
  s = await look(reader);
  t("a signed-in stranger is not remembered", s.signedIn && s.stored.length === 0, JSON.stringify(s));
  await goto(reader, "/");
  s = await look(reader);
  t("so their next visit is a reader's", s.requested === false && !s.toolbar, JSON.stringify(s));
  await readers.close();

  // --- the owner ------------------------------------------------------------
  const owners = await browser.newContext();
  const owner = await open(owners, "/#edit");
  s = await look(owner);
  t("#edit opens the controls as it always did", s.requested && s.toolbar && s.stored.length === 0, JSON.stringify(s));
  await signIn(owner);
  s = await look(owner);
  t("signing in as the owner remembers this browser", s.signedIn && s.stored.length === 1, JSON.stringify(s));
  const record = await owner.evaluate((k) => JSON.parse(localStorage.getItem(k)), s.stored[0]);
  t("keeping who, not any key", record && Object.keys(record).sort().join() === "at,pubkey" && !JSON.stringify(record).includes("nsec"), JSON.stringify(record));

  await goto(owner, "/");
  s = await look(owner);
  t("a later visit without #edit opens the controls", s.requested && s.editing === "true" && s.toolbar, JSON.stringify(s));
  t("with Sign in offered and nothing signed in by itself", !s.signedIn &&
    await owner.locator("[data-nc-signin]").textContent() === "Sign in");
  await goto(owner, "/about.html");
  s = await look(owner);
  t("on the other pages of the same site too", s.requested && s.toolbar, JSON.stringify(s));

  // A different tab in the same browser starts fresh, so "not now" is per tab.
  const second = await open(owners, "/");
  s = await look(second);
  t("a second tab opens the controls as well", s.requested && s.toolbar, JSON.stringify(s));

  // Cancelling the sign-in it was offered puts the controls away for this tab.
  await goto(owner, "/");
  await owner.locator("[data-nc-signin]").click();
  await owner.locator("dialog.nc-ui .nc-cancel").click();
  s = await look(owner);
  t("dismissing the sign-in puts the controls away", !s.requested && !s.toolbar && s.stored.length === 1, JSON.stringify(s));
  const page1 = await owner.evaluate(() => document.querySelector("h1").textContent);
  t("and the page is still all there", page1 === "Bakery");
  await goto(owner, "/");
  s = await look(owner);
  t("a reload in that tab does not offer them again", !s.requested && !s.toolbar, JSON.stringify(s));
  await goto(owner, "/#edit");
  s = await look(owner);
  t("#edit still brings them back", s.requested && s.toolbar, JSON.stringify(s));
  s = await look(second);
  t("the other tab is not affected", s.requested && s.toolbar, JSON.stringify(s));

  // Signing in again clears the "not now"; signing out forgets the browser.
  await signIn(owner);
  await goto(owner, "/");
  s = await look(owner);
  t("signing in again lifts the tab's \"not now\"", s.requested && s.toolbar, JSON.stringify(s));
  await signIn(owner);
  await owner.locator("[data-nc-signin]").click();          // reads "Sign out" now
  s = await look(owner);
  t("signing out forgets this browser", !s.signedIn && s.stored.length === 0, JSON.stringify(s));
  t("and closes controls that only the memory had opened", !s.requested && !s.toolbar, JSON.stringify(s));
  await goto(owner, "/");
  s = await look(owner);
  t("after signing out, a visit is a reader's again", !s.requested && !s.toolbar, JSON.stringify(s));

  // The Settings line forgets without signing out.
  await goto(owner, "/#edit");
  await signIn(owner);
  await owner.locator("[data-nc-settings]").click();
  const line = owner.getByText("Open the editing controls in this browser without #edit");
  t("Settings offers the remembered browser as a line of its own", await line.count() === 1);
  await line.click();
  await owner.locator("dialog.nc-ui .nc-primary").click();
  s = await look(owner);
  t("and unticking it forgets this browser while staying signed in", s.signedIn && s.stored.length === 0, JSON.stringify(s));
  await owners.close();

  // --- a page in another language words the line in it ----------------------
  const slovak = await browser.newContext();
  const sk = await slovak.newPage();
  await sk.routeWebSocket("**", (ws) => ws.close());
  await sk.route(base + "/", (route) => route.fulfill({ contentType: "text/html", body: page("/index.html", "Pekáreň").replace('lang="en"', 'lang="sk"') }));
  await sk.goto(base + "/#edit");
  await sk.evaluate(async (k) => { await nc.ready; await nc.login("nsec", { key: k }); }, NSEC);
  await sk.evaluate(() => { nc.settings.open(); });
  t("the Settings line follows the page's language", await sk.getByText("Zobrazovať ovládanie úprav v tomto prehliadači aj bez #edit").count() === 1);
  await slovak.close();

  // --- storage that refuses ---------------------------------------------------
  const locked = await browser.newContext();
  await locked.addInitScript(() => {
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(window, name, { get() { throw new DOMException("denied", "SecurityError"); } });
    }
  });
  const shut = await open(locked, "/#edit");
  await shut.evaluate((k) => nc.login("nsec", { key: k }), NSEC);
  const survived = await shut.evaluate(async () => {
    const remembered = nc.editorRemembered;
    await nc.logout();
    return { remembered, ready: document.documentElement.getAttribute("nc:ready"), out: !nc.pubkey };
  });
  t("a browser that refuses storage still signs in and out", survived.ready === "true" && survived.out, JSON.stringify(survived));
  await locked.close();
} finally {
  for (const [name, pass, detail] of out) console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail && !pass ? "   (" + detail + ")" : ""}`);
  console.log(`\n${out.filter((r) => r[1]).length}/${out.length} passed`);
  await browser.close(); server.close();
}
process.exit(out.length && out.every((r) => r[1]) ? 0 : 1);
