// The kept sign-in: the owner signs in once, and the other pages of the site
// open signed in for an hour after they were last used, by every way there is
// to sign in. Nobody else is ever signed in by it.
//
// Real pages in the installed Chrome, with the shared toolbar script. Every
// WebSocket goes to a relay played here in the test, and the remote signer
// behind the bunker:// URI is played here too, so nothing reaches a real relay
// and the test can see every request the signer is asked.
//
// Run: node test/kept-signin.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { v2 as nip44 } from "nostr-tools/nip44";
import { bytesToHex } from "@noble/hashes/utils";

const NSEC = "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y";
const NPUB = "npub16kwfcualkq4kz6vgs8tze0j4jkpgs53h48ghmpnj80s7cvfjspwsh4uk9u";
const OWNER_SEC = nip19.decode(NSEC).data;
const OWNER = nip19.decode(NPUB).data;
const STRANGER_SEC = generateSecretKey();
const STRANGER = getPublicKey(STRANGER_SEC);
const HOUR = 60 * 60 * 1000;

const page = (path, title) => `<!doctype html><html lang="en" nc:owner="${NPUB}" nc:path="${path}" ` +
  `nc:edit-gate="hash" nc:runtime-owner="off" nc:autoreload="false"><head><title>${title}</title>` +
  `<link rel="stylesheet" href="/nsite-clay-base.css"></head><body><main><h1 editable="single-line">${title}</h1>` +
  `<p editable>Open on Saturdays.</p></main>` +
  `<div class="nc-bar nc-ui-chrome"><span class="nc-dot"></span><span class="nc-who" data-nc-who>read-only</span>` +
  `<button data-nc-signin>Sign in</button><button class="nc-owner-only" data-nc-settings>Settings</button>` +
  `<button class="nc-primary nc-owner-only" data-nc-save>Save</button></div>` +
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

// ---- a relay, and a NIP-46 signer listening on it -------------------------
const REMOTE_SEC = generateSecretKey();
const REMOTE = getPublicKey(REMOTE_SEC);
const BUNKER_SECRET = "one-time-" + bytesToHex(generateSecretKey()).slice(0, 8);
const BUNKER_URI = `bunker://${REMOTE}?relay=${encodeURIComponent("wss://bunker.test")}&secret=${BUNKER_SECRET}`;
const bunker = {
  approved: new Set(),      // client pubkeys the signer has paired with
  log: [],                  // [client, method] for every request it was sent
  silent: false,            // asleep: hears requests, answers none
  answerAs: OWNER,          // who it says it is
  spentSecret: false,
};
const sockets = new Set();
const matches = (f, ev) => (!f.kinds || f.kinds.includes(ev.kind)) &&
  (!f.authors || f.authors.includes(ev.pubkey)) &&
  (!f["#p"] || ev.tags.some((t) => t[0] === "p" && f["#p"].includes(t[1])));
const deliver = (ev) => {
  for (const s of sockets) for (const [id, filters] of s.subs) {
    if (filters.some((f) => matches(f, ev))) s.ws.send(JSON.stringify(["EVENT", id, ev]));
  }
};
const answer = (req) => {
  const client = req.pubkey;
  const key = nip44.utils.getConversationKey(REMOTE_SEC, client);
  let msg;
  try { msg = JSON.parse(nip44.decrypt(req.content, key)); } catch { return; }
  bunker.log.push([client, msg.method]);
  if (bunker.silent) return;
  let result = null, error = null;
  if (msg.method === "connect") {
    if (msg.params[1] === BUNKER_SECRET && !bunker.spentSecret) { bunker.spentSecret = true; bunker.approved.add(client); result = "ack"; }
    else if (bunker.approved.has(client)) error = "already connected";
    else error = "invalid secret";
  } else if (!bunker.approved.has(client)) error = "no permission";
  else if (msg.method === "get_public_key") result = bunker.answerAs;
  else if (msg.method === "sign_event") result = JSON.stringify(finalizeEvent(JSON.parse(msg.params[0]), OWNER_SEC));
  else if (msg.method === "ping") result = "pong";
  else error = "not supported";
  const reply = finalizeEvent({
    kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", client]],
    content: nip44.encrypt(JSON.stringify({ id: msg.id, result, error }), key),
  }, REMOTE_SEC);
  setTimeout(() => deliver(reply), 20);
};
const relay = (ws) => {
  const s = { ws, subs: new Map() };
  sockets.add(s);
  ws.onClose(() => sockets.delete(s));
  ws.onMessage((raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m[0] === "REQ") { s.subs.set(m[1], m.slice(2)); ws.send(JSON.stringify(["EOSE", m[1]])); }
    else if (m[0] === "CLOSE") s.subs.delete(m[1]);
    else if (m[0] === "EVENT") {
      const ev = m[1];
      ws.send(JSON.stringify(["OK", ev.id, true, ""]));
      if (ev.kind === 24133 && ev.tags.some((t) => t[0] === "p" && t[1] === REMOTE)) answer(ev);
    }
  });
};

// ---- harness ----------------------------------------------------------------
const out = [];
const t = (name, pass, detail = "") => out.push([name, !!pass, detail]);
const browser = await chromium.launch({ channel: "chrome" });
const context = async (init) => {
  const c = await browser.newContext();
  await c.routeWebSocket(() => true, relay);
  if (init) await c.addInitScript(init);
  return c;
};
const settle = (p) => p.evaluate(async () => { await nc.ready; await nc.resuming; await new Promise((r) => setTimeout(r, 50)); });
const open = async (c, path = "/") => {
  const p = await c.newPage();
  p.on("pageerror", (e) => out.push(["pageerror", false, e.message]));
  await p.goto(base + path);
  await settle(p);
  return p;
};
const goto = async (p, path) => { await p.goto(base + path); await settle(p); };
const look = (p) => p.evaluate(() => {
  const kept = (s) => { try { return Object.keys(s).filter((k) => k.startsWith("nsite-clay.session:")).map((k) => JSON.parse(s.getItem(k))); } catch { return []; } };
  return {
    signedIn: nc.pubkey, owner: nc.isOwner,
    button: document.querySelector("[data-nc-signin]").textContent,
    editmode: document.documentElement.getAttribute("nc:editmode"),
    tab: kept(sessionStorage), browser: kept(localStorage),
  };
});
const setUntil = (p, store, until) => p.evaluate(([store, until]) => {
  const s = window[store];
  for (const k of Object.keys(s)) if (k.startsWith("nsite-clay.session:")) {
    s.setItem(k, JSON.stringify({ ...JSON.parse(s.getItem(k)), until: until === "past" ? Date.now() - 1 : Date.now() + until }));
  }
}, [store, until]);
const near = (until, ms) => Math.abs(until - Date.now() - ms) < 60000;

try {
  // --- a reader ----------------------------------------------------------
  const readers = await context();
  const reader = await open(readers);
  let s = await look(reader);
  t("a plain visitor is not signed in", !s.signedIn && s.button === "Sign in", JSON.stringify(s));
  t("and nothing is kept in their browser", !s.tab.length && !s.browser.length, JSON.stringify(s));
  await readers.close();

  // --- a typed key -------------------------------------------------------
  const typed = await context();
  const owner = await open(typed, "/#edit");
  await owner.evaluate((k) => nc.login("nsec", { key: k }), NSEC);
  s = await look(owner);
  t("an owner who types their key is kept in this tab only", s.tab.length === 1 && !s.browser.length && s.tab[0].kind === "local", JSON.stringify(s));
  t("for an hour", near(s.tab[0]?.until, HOUR), JSON.stringify(s.tab[0]?.until));

  await goto(owner, "/about.html");
  s = await look(owner);
  t("another page of the site opens signed in", s.signedIn === OWNER && s.owner && s.button === "Sign out", JSON.stringify(s));
  t("with editing on, without #edit", s.editmode === "true" &&
    await owner.evaluate(() => document.querySelector("h1").isContentEditable), JSON.stringify(s));
  await goto(owner, "/");
  s = await look(owner);
  t("and so does a reload", s.signedIn === OWNER, JSON.stringify(s));

  const other = await open(typed, "/");
  s = await look(other);
  t("a second tab does not get the typed key", !s.signedIn && s.button === "Sign in" && !s.tab.length, JSON.stringify(s));
  await other.close();

  await setUntil(owner, "sessionStorage", 60000);
  await goto(owner, "/about.html");
  s = await look(owner);
  t("opening a page signed in keeps it for another hour", s.signedIn === OWNER && near(s.tab[0]?.until, HOUR), JSON.stringify(s.tab));

  await setUntil(owner, "sessionStorage", 60000);
  await owner.evaluate(() => { nc._sessionTouched = 0; document.querySelector("p").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true })); });
  s = await look(owner);
  t("and so does working on it", near(s.tab[0]?.until, HOUR), JSON.stringify(s.tab));

  await setUntil(owner, "sessionStorage", "past");
  await goto(owner, "/");
  s = await look(owner);
  t("an hour without use and the next page asks again", !s.signedIn && s.button === "Sign in", JSON.stringify(s));
  t("with the expired sign-in gone", !s.tab.length, JSON.stringify(s.tab));
  t("and the controls still open, as the remembered editor's", await owner.evaluate(() => nc.editRequested));

  await owner.evaluate((k) => nc.login("nsec", { key: k }), NSEC);
  await owner.locator("[data-nc-signin]").click();          // Sign out
  s = await look(owner);
  t("signing out lets the kept sign-in go", !s.signedIn && !s.tab.length && !s.browser.length, JSON.stringify(s));
  await goto(owner, "/#edit");
  s = await look(owner);
  t("so the next page is not signed in", !s.signedIn, JSON.stringify(s));

  await owner.evaluate((k) => nc.login("nsec", { key: k }), NSEC);
  await owner.evaluate(() => nc.rememberEditor(false));
  s = await look(owner);
  t("forgetting this browser as the editor's lets it go too", s.signedIn && !s.tab.length, JSON.stringify(s));
  await owner.evaluate(() => { nc._sessionTouched = 0; document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
  s = await look(owner);
  t("and working on afterwards does not bring it back", !s.tab.length, JSON.stringify(s.tab));
  await goto(owner, "/about.html#edit");
  t("so the next page is not signed in either", !(await look(owner)).signedIn);

  // Not the owner: never kept, and a record naming anyone else is not used.
  await owner.evaluate((k) => nc.login("nsec", { key: k }), bytesToHex(STRANGER_SEC));
  s = await look(owner);
  t("somebody else signing in is not kept", s.signedIn === STRANGER && !s.tab.length && !s.browser.length, JSON.stringify(s));
  await goto(owner, "/");
  t("and the next page is a reader's", !(await look(owner)).signedIn);

  const forge = (p, rec) => p.evaluate((rec) => {
    sessionStorage.setItem(nc._sessionKey(), JSON.stringify({ ...rec, until: Date.now() + 600000 }));
  }, rec);
  await forge(owner, { kind: "local", pubkey: STRANGER, key: bytesToHex(STRANGER_SEC) });
  await goto(owner, "/");
  s = await look(owner);
  t("a kept key that is not the owner's is not used", !s.signedIn && !s.tab.length, JSON.stringify(s));
  await forge(owner, { kind: "local", pubkey: OWNER, key: bytesToHex(STRANGER_SEC) });
  await goto(owner, "/");
  s = await look(owner);
  t("nor one that only claims to be", !s.signedIn && !s.tab.length, JSON.stringify(s));
  await owner.evaluate((key) => localStorage.setItem(nc._sessionKey(),
    JSON.stringify({ kind: "local", pubkey: nc.cfg.owner, key, until: Date.now() + 600000 })), bytesToHex(OWNER_SEC));
  await goto(owner, "/");
  s = await look(owner);
  t("and the owner's own key is not taken from anywhere but the tab", !s.signedIn && !s.browser.length, JSON.stringify(s));
  await typed.close();

  // --- a remote signer (bunker://) --------------------------------------
  const remote = await context();
  const amber = await open(remote, "/#edit");
  await amber.evaluate((uri) => nc.login("bunker", { uri }), BUNKER_URI);
  s = await look(amber);
  const rec = s.browser[0] || {};
  t("an owner with a remote signer is kept in this browser", s.signedIn === OWNER && s.browser.length === 1 && !s.tab.length && rec.kind === "nip46", JSON.stringify(s));
  t("as the paired client key, the signer and its relays", rec.remote === REMOTE && /^[0-9a-f]{64}$/.test(rec.client) &&
    rec.relays?.some((r) => r.startsWith("wss://bunker.test")) && near(rec.until, HOUR), JSON.stringify(rec));
  t("never the one-time secret, nor the owner's key", !JSON.stringify(s.browser).includes(BUNKER_SECRET) &&
    !JSON.stringify(s.browser).includes(bytesToHex(OWNER_SEC)));
  const client = getPublicKey(Uint8Array.from(Buffer.from(rec.client, "hex")));
  const connects = () => bunker.log.filter(([, m]) => m === "connect").length;
  const before = connects();

  await goto(amber, "/about.html");
  s = await look(amber);
  t("another page opens signed in through the same signer", s.signedIn === OWNER && s.button === "Sign out", JSON.stringify(s));
  t("asking it who it is, with no new pairing to approve", connects() === before &&
    bunker.log.at(-1)?.[0] === client && bunker.log.at(-1)?.[1] === "get_public_key", JSON.stringify(bunker.log.slice(-3)));
  const signed = await amber.evaluate(() => nc.signer.sign({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "hi" }));
  t("and it still signs, as the owner", signed?.pubkey === OWNER, JSON.stringify(signed));
  const tab2 = await open(remote, "/");
  t("a second tab of the browser is signed in as well", (await look(tab2)).signedIn === OWNER);
  await tab2.close();

  // Asleep: the page gives up quietly, and keeps the sign-in for when it wakes.
  bunker.silent = true;
  const t0 = Date.now();
  await goto(amber, "/");
  s = await look(amber);
  t("a signer that does not answer leaves the Sign in button", !s.signedIn && s.button === "Sign in", JSON.stringify(s));
  t("after a deadline, not forever", Date.now() - t0 < 20000, `${Date.now() - t0} ms`);
  t("and the sign-in is kept for when it does", s.browser.length === 1, JSON.stringify(s.browser));
  bunker.silent = false;
  await goto(amber, "/about.html");
  t("which it then is", (await look(amber)).signedIn === OWNER);

  // A signer that answers as somebody else.
  bunker.answerAs = STRANGER;
  await goto(amber, "/");
  s = await look(amber);
  t("a signer that is now somebody else is not signed in as", !s.signedIn && !s.browser.length, JSON.stringify(s));
  bunker.answerAs = OWNER;

  // Revoked in the signer app: it says no, and the page lets it go.
  bunker.spentSecret = false;
  await amber.evaluate((uri) => nc.login("bunker", { uri }), BUNKER_URI);
  bunker.approved.clear();
  await goto(amber, "/about.html");
  s = await look(amber);
  t("a signer that refuses lets the kept sign-in go", !s.signedIn && !s.browser.length && s.button === "Sign in", JSON.stringify(s));

  bunker.spentSecret = false;
  await goto(amber, "/#edit");
  await amber.evaluate((uri) => nc.login("bunker", { uri }), BUNKER_URI);
  await amber.evaluate(() => nc.logout());
  s = await look(amber);
  t("signing out of a remote signer lets it go", !s.signedIn && !s.browser.length, JSON.stringify(s));
  await remote.close();

  // --- an extension (NIP-07) ---------------------------------------------
  const extension = await context(() => {
    window.nostr = {
      async getPublicKey() {
        localStorage.setItem("test.asked", String(Number(localStorage.getItem("test.asked") || 0) + 1));
        return localStorage.getItem("test.pubkey");
      },
      async signEvent() { throw new Error("not in this test"); },
    };
  });
  const ext = await open(extension, "/#edit");
  await ext.evaluate((pk) => localStorage.setItem("test.pubkey", pk), OWNER);
  await ext.evaluate(() => nc.login("nip07"));
  s = await look(ext);
  t("an owner with an extension is kept as who they are, and nothing else",
    s.browser.length === 1 && Object.keys(s.browser[0]).sort().join() === "kind,pubkey,until" && s.browser[0].kind === "nip07", JSON.stringify(s.browser));
  const asked = await ext.evaluate(() => Number(localStorage.getItem("test.asked")));
  await goto(ext, "/about.html");
  s = await look(ext);
  t("another page asks the extension again and is signed in", s.signedIn === OWNER &&
    await ext.evaluate(() => Number(localStorage.getItem("test.asked"))) === asked + 1, JSON.stringify(s));
  await ext.evaluate((pk) => localStorage.setItem("test.pubkey", pk), STRANGER);
  await goto(ext, "/");
  s = await look(ext);
  t("an extension now on another account is not signed in as", !s.signedIn && !s.browser.length, JSON.stringify(s));
  await extension.close();

  // --- storage that refuses ----------------------------------------------
  const locked = await context(() => {
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(window, name, { get() { throw new DOMException("denied", "SecurityError"); } });
    }
  });
  const shut = await open(locked, "/#edit");
  const result = await shut.evaluate(async (k) => {
    await nc.login("nsec", { key: k });
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const signed = nc.pubkey;
    await nc.logout();
    return { signed, out: !nc.pubkey };
  }, NSEC);
  t("a browser that refuses storage still signs in and out", result.signed === OWNER && result.out, JSON.stringify(result));
  await goto(shut, "/");
  t("and simply opens the next page signed out", await shut.evaluate(() => !nc.pubkey && document.documentElement.getAttribute("nc:ready") === "true"));
  await locked.close();
} finally {
  for (const [name, pass, detail] of out) console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail && !pass ? "   (" + detail + ")" : ""}`);
  console.log(`\n${out.filter((r) => r[1]).length}/${out.length} passed`);
  await browser.close(); server.close();
}
process.exit(out.length && out.every((r) => r[1]) ? 0 : 1);
