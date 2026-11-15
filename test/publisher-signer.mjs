// The publishing wizard's first step: the signer app is the first way in and it
// takes one tap. On a phone that tap opens the app (here the navigation to the
// nostrconnect:// link is intercepted, not followed), the QR code waits behind a
// button, and a computer shows the code at once. Approving in a fake Amber (a few
// lines of nostr-tools, answering over a local relay as the real one does) lands
// on step 2 as the person, and a retry is a new code.
//
// Run: node test/publisher-signer.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, extname } from "node:path";
import { chromium, devices } from "playwright";
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { v2 as nip44 } from "nostr-tools/nip44";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { localPorts } from "./local-ports.mjs";
import { mockAiAccount } from "./ai-account-fixture.mjs";

useWebSocketImplementation(WebSocket);
const [RP, BP, GP] = await localPorts(3);
const devnet = spawn("node", ["tools/devnet.mjs", "--quiet"], { stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: RP, DEVNET_BLOSSOM_PORT: BP, DEVNET_GATEWAY_PORT: GP } });
process.on("exit", () => { try { devnet.kill(); } catch {} });
await new Promise((r) => setTimeout(r, 700));
const RELAY = "ws://127.0.0.1:" + RP;

const srv = createServer((q, r) => {
  const p = new URL(q.url, "http://l").pathname;
  const f = p === "/nsite-clay.js" ? "dist/nsite-clay.js" : p === "/nsite-clay-base.css" ? "templates/_shared/nsite-clay-base.css" : join("site", p);
  try { r.writeHead(200, { "Content-Type": { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" }[extname(f)] || "application/octet-stream" }); r.end(readFileSync(f)); }
  catch { r.writeHead(404); r.end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const URL_ = `http://127.0.0.1:${srv.address().port}/deploy.html`;

const out = []; const t = (name, pass, detail = "") => { out.push([name, !!pass, detail]); console.log((pass ? "ok   " : "FAIL ") + name + (pass ? "" : "   " + String(detail).slice(0, 400))); };

// A signer app: answers connect, get_public_key, nip44 and sign_event with its own
// transport key, never the user's.
function amber({ link, userSk }) {
  const uri = new URL(link);
  const clientPk = uri.hostname, secret = uri.searchParams.get("secret"), relays = uri.searchParams.getAll("relay");
  const tsk = generateSecretKey(), tpk = getPublicKey(tsk), userPk = getPublicKey(userSk);
  const pool = new SimplePool();
  const log = [];
  const reply = (toPk, id, result, error) => {
    const ck = nip44.utils.getConversationKey(tsk, toPk);
    const ev = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", toPk]],
      content: nip44.encrypt(JSON.stringify({ id, result, ...(error ? { error } : {}) }), ck) }, tsk);
    return Promise.allSettled(pool.publish(relays, ev));
  };
  const sub = pool.subscribeMany(relays, { kinds: [24133], "#p": [tpk] }, {
    onevent: async (ev) => {
      let msg;
      try { msg = JSON.parse(nip44.decrypt(ev.content, nip44.utils.getConversationKey(tsk, ev.pubkey))); } catch { return; }
      log.push(msg.method);
      const [a, b] = msg.params || [];
      if (msg.method === "connect") await reply(ev.pubkey, msg.id, "ack");
      else if (msg.method === "get_public_key") await reply(ev.pubkey, msg.id, userPk);
      else if (msg.method === "switch_relays") await reply(ev.pubkey, msg.id, "null");
      else if (msg.method === "nip44_decrypt") await reply(ev.pubkey, msg.id, nip44.decrypt(b, nip44.utils.getConversationKey(userSk, a)));
      else if (msg.method === "nip44_encrypt") await reply(ev.pubkey, msg.id, nip44.encrypt(b, nip44.utils.getConversationKey(userSk, a)));
      else if (msg.method === "sign_event") await reply(ev.pubkey, msg.id, JSON.stringify(finalizeEvent(JSON.parse(a), userSk)));
      else await reply(ev.pubkey, msg.id, "", "not supported");
    },
  });
  const approve = () => reply(clientPk, "connect-" + tpk.slice(0, 6), secret);
  return { approve, log, userPk, close: () => { try { sub.close(); } catch {} try { pool.close(relays); } catch {} } };
}

const browser = await chromium.launch({ channel: "chrome" });
const errors = [];
async function open(ctxOptions, { intercept = false } = {}) {
  const ctx = await browser.newContext(ctxOptions);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await mockAiAccount(p);
  // A phone follows a nostrconnect:// link into the app. There is no app here, so
  // note the link and stop the navigation.
  if (intercept) await p.addInitScript(() => {
    window.__opened = [];
    document.addEventListener("click", (e) => {
      const a = e.target.closest?.("a[href^='nostrconnect:']");
      if (a) { e.preventDefault(); window.__opened.push(a.href); }
    }, true);
  });
  await p.goto(URL_);
  await p.evaluate(async () => { await nc.ready; });
  // The handshake goes over the devnet relay here, not the public ones.
  await p.evaluate((relay) => { nc.cfg.signerRelays = [relay]; }, RELAY);
  return { ctx, p };
}
const step2 = (p) => p.waitForFunction(() => document.querySelector("section.step[data-step='2']")?.hasAttribute("data-on"), null, { timeout: 20000 }).then(() => true, () => false);
const signedAs = (p, pk) => p.evaluate((u) => nc.signer && nc.pubkey === u, pk).catch(() => false);

const userSk = generateSecretKey();
const userPk = getPublicKey(userSk);

// 1. A computer: the signer app first, the code shown right away.
{
  const { ctx, p } = await open({ colorScheme: "dark", viewport: { width: 1200, height: 900 } });
  const ways = await p.evaluate(() => [...document.querySelectorAll("#signin-choose .way")].filter((b) => !b.hidden).map((b) => b.id));
  t("the signer app is the first way in", ways[0] === "way-remote", ways.join(","));
  t("pasting a key and making one are still there, below it", ways.includes("way-key") && ways.includes("way-new") && ways.indexOf("way-key") > 0, ways.join(","));
  await p.click("#way-remote");
  await p.waitForSelector("#panel-app:not([hidden]) a#app-open[href^='nostrconnect:']");
  const view = await p.evaluate(() => {
    const box = document.querySelector("#qrbox"), tile = box.firstElementChild, r = tile.getBoundingClientRect();
    const open = document.querySelector("#app-open");
    return { hidden: box.hidden, w: r.width, bg: getComputedStyle(tile).backgroundColor, openColor: getComputedStyle(open).color, openBg: getComputedStyle(open).backgroundColor,
      text: document.querySelector("#panel-app h2").textContent };
  });
  t("on a computer the code is shown at once, on a white tile", !view.hidden && view.w > 150 && view.bg === "rgb(255, 255, 255)", JSON.stringify(view));
  t("the waiting state says what it waits for", /waiting for your signer app/i.test(view.text), view.text);
  t("and the link is not in a default link colour", view.openColor !== "rgb(0, 0, 238)" && view.openColor !== view.openBg, JSON.stringify(view));
  const link = await p.evaluate(() => document.querySelector("#app-open").href);
  const app = amber({ link, userSk });
  await app.approve();
  t("approving in the app moves on to step 2", await step2(p), app.log.join(","));
  t("signed in as the person, not the app's transport key", await signedAs(p, userPk), app.log.join(","));
  t("and the page says so", /Signed in as/.test(await p.textContent("#who")) && (await p.textContent("#who")).includes(nip19.npubEncode(userPk).slice(0, 12)));
  app.close(); await ctx.close();
}

// 2. A phone: one tap opens the app, the code waits behind a button, a retry is a new code.
{
  const { ctx, p } = await open({ ...devices["Pixel 7"], colorScheme: "dark" }, { intercept: true });
  t("a phone counts as a touch device here", await p.evaluate(() => matchMedia("(pointer: coarse)").matches));
  const before = await p.evaluate(() => ({ attempts: document.querySelector("#app-open").getAttribute("href") }));
  t("no connection attempt exists until the person taps", before.attempts === null);
  await p.tap("#way-remote");
  await p.waitForSelector("#panel-app:not([hidden])");
  const opened = await p.evaluate(() => window.__opened.slice());
  t("one tap opens the app with a nostrconnect link", opened.length === 1 && /^nostrconnect:\/\/[0-9a-f]{64}\?/.test(opened[0]), JSON.stringify(opened));
  t("the QR code is hidden on a phone", await p.evaluate(() => document.querySelector("#qrbox").getBoundingClientRect().width === 0));
  await p.tap("#app-qr-toggle");
  const shown = await p.evaluate(() => { const tile = document.querySelector("#qrbox").firstElementChild, r = tile.getBoundingClientRect(); return { w: r.width, bg: getComputedStyle(tile).backgroundColor, fits: r.right <= innerWidth }; });
  t("Show QR code shows it, on a white tile that fits the screen", shown.w > 150 && shown.bg === "rgb(255, 255, 255)" && shown.fits, JSON.stringify(shown));
  t("no Try again yet, while it is still fresh", await p.evaluate(() => document.querySelector("#app-retry-row").hidden));

  // Back from the app with nothing received.
  await p.waitForTimeout(3200);
  await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  t("coming back with nothing received offers Try again", await p.evaluate(() => !document.querySelector("#app-retry-row").hidden));
  await p.tap("#app-retry");
  const opened2 = await p.evaluate(() => window.__opened.slice());
  t("Try again is a new code, and opens the app again", opened2.length === 2 && opened2[1] !== opened2[0], JSON.stringify(opened2.map((x) => x.slice(15, 30))));
  t("and the retry row goes away while it waits", await p.evaluate(() => document.querySelector("#app-retry-row").hidden));

  // The first code is spent: an app that answers it does not sign anybody in.
  const stale = amber({ link: opened[0], userSk });
  await stale.approve();
  await p.waitForTimeout(1500);
  t("the old code no longer signs anybody in", !(await p.evaluate(() => document.querySelector("section.step[data-step='2']").hasAttribute("data-on"))));
  const app = amber({ link: opened2[1], userSk });
  await app.approve();
  t("approving the new code moves on to step 2", await step2(p), app.log.join(","));
  t("signed in as the person", await signedAs(p, userPk));
  stale.close(); app.close();

  // Leaving cancels the attempt: choose another way, then the list is back.
  await ctx.close();
}

// 3. Leaving the waiting screen goes back to the list; the extension way stays when there is one.
{
  const { ctx, p } = await open({ viewport: { width: 1200, height: 900 } });
  await p.click("#way-remote");
  await p.waitForSelector("#panel-app:not([hidden])");
  await p.click("#panel-app .back-to-choose");
  t("Choose another way goes back to the list", await p.evaluate(() => !document.querySelector("#signin-choose").hidden && document.querySelector("#panel-app").hidden));
  await ctx.close();
  const ext = await browser.newContext();
  const q = await ext.newPage();
  await q.addInitScript(() => { window.nostr = { getPublicKey: async () => "0".repeat(64), signEvent: async (e) => e }; });
  await q.goto(URL_);
  const ids = await q.evaluate(() => [...document.querySelectorAll("#signin-choose .way")].filter((b) => !b.hidden).map((b) => b.id));
  t("with a browser extension its way stays on the list, after the signer app", ids[0] === "way-remote" && ids.includes("way-nip07"), ids.join(","));
  await ext.close();
}

// 4. ?key=have lands on the signer-first list.
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(URL_ + "?key=have");
  const have = await p.evaluate(() => ({ first: [...document.querySelectorAll("#signin-choose .way")].filter((b) => b.offsetParent).map((b) => b.id)[0], mode: document.querySelector("#signin-choose").dataset.mode }));
  t("?key=have opens on the signer app first", have.first === "way-remote" && have.mode === "have", JSON.stringify(have));
  await ctx.close();
}

t("no page errors", errors.filter((x) => !/Content Security Policy|ERR_|Failed to load resource|violates/.test(x)).length === 0, errors.join(" | "));
await browser.close(); srv.close();
const bad = out.filter((x) => !x[1]);
console.log(`\n${out.length - bad.length}/${out.length} passed`);
devnet.kill();
process.exit(bad.length ? 1 : 0);
