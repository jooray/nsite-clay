// Signing in with a signer app (Amber and the like), end to end, against an
// Amber made of a few lines of nostr-tools: it reads the nostrconnect:// link the
// page shows, answers on the relay the way the real one does (its own transport
// key, never the user's), and signs and decrypts with the user's key.
//
// This is the part of sign-in that is hardest to get right and the part a person
// meets first, so what the dialog looks like is checked here too: the signer app
// is the first thing on it, one tap away, and the QR code behind a button on a
// phone, and the code is a readable white tile in a dark dialog.
//
// Run: node test/signer-app.mjs
import { chromium, devices } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { v2 as nip44 } from "nostr-tools/nip44";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { localPorts } from "./local-ports.mjs";

useWebSocketImplementation(WebSocket);
const S = mkdtempSync(join(tmpdir(), "nc-signer-"));
const [RP, BP, GP] = await localPorts(3);
const devnet = spawn("node", ["tools/devnet.mjs", "--quiet"], { stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: RP, DEVNET_BLOSSOM_PORT: BP, DEVNET_GATEWAY_PORT: GP } });
process.on("exit", () => { try { devnet.kill(); } catch {} try { rmSync(S, { recursive: true, force: true }); } catch {} });
await new Promise((r) => setTimeout(r, 700));
const RELAY = "ws://127.0.0.1:" + RP;
const env = { ...process.env, NSITE_ARTIFACTS_HOME: S + "/home", NSITE_ARTIFACTS_RELAYS: RELAY,
  NSITE_ARTIFACTS_SERVERS: "http://127.0.0.1:" + BP, NSITE_ARTIFACTS_GATEWAY: "http://{host}.localhost:" + GP, NSITE_ARTIFACTS_RUNTIME: process.cwd() };
const A = (...args) => JSON.parse(execFileSync("node", ["skills/nsite-artifacts/scripts/artifact.mjs", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const out = []; const t = (name, pass, detail = "") => { out.push([name, !!pass, detail]); console.log((pass ? "ok   " : "FAIL ") + name + (pass ? "" : "   " + String(detail).slice(0, 400))); };

// ---- a signer app ------------------------------------------------------------
// `userSk` is the person's key. The transport key it answers with is a fresh one
// for each connection, as newer Amber does: event.pubkey is not the user.
function amber({ link, userSk, delayMs = 0 }) {
  const uri = new URL(link);
  const clientPk = uri.hostname;
  const secret = uri.searchParams.get("secret");
  const relays = uri.searchParams.getAll("relay");
  const tsk = generateSecretKey(), tpk = getPublicKey(tsk);
  const userPk = getPublicKey(userSk);
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
  // "Approved": the connect response, whose result is the one-time secret.
  const approve = async () => { await new Promise((r) => setTimeout(r, delayMs)); await reply(clientPk, "connect-" + tpk.slice(0, 6), secret); };
  return { approve, log, userPk, transportPk: tpk, close: () => { try { sub.close(); } catch {} try { pool.close(relays); } catch {} } };
}

// ---- a private page for one person -------------------------------------------
const userSk = generateSecretKey();
const npub = nip19.npubEncode(getPublicKey(userSk));
A("list-page", "--title=Family", "--item=Milk", "--item=Bread", "--item=Eggs", "--out=" + S + "/list.html");
const made = A("create", S + "/list.html", "--visibility=private", "--edit=members", "--member=" + npub, "--title=Family");

const browser = await chromium.launch({ channel: "chrome" });
const errors = [];
const ready = (pg) => pg.waitForFunction(() => (document.documentElement.getAttribute("nc:ready") === "true" && !document.documentElement.hasAttribute("nc:sealed")) || document.documentElement.hasAttribute("nc:locked"), null, { timeout: 20000 });

async function openDialog(ctxOptions) {
  const ctx = await browser.newContext(ctxOptions);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(made.url); await ready(p);
  // The handshake goes over the devnet relay here, not the public ones.
  await p.evaluate((relay) => { nc.cfg.signerRelays = [relay]; }, RELAY);
  await p.click("#nc-locked button");
  await p.waitForSelector("dialog.nc-ui a[href^='nostrconnect:']", { timeout: 8000 });
  return { ctx, p };
}

// 1. A desktop browser: the app first, the code shown, a way to paste a key below.
{
  const { ctx, p } = await openDialog({ colorScheme: "dark", viewport: { width: 1000, height: 900 } });
  const layout = await p.evaluate(() => {
    const body = document.querySelector("dialog.nc-ui .nc-body");
    const kids = [...body.children].map((e) => e.tagName + ":" + (e.textContent || "").trim().slice(0, 24));
    const qr = body.querySelector("svg");
    const tile = qr;
    const r = tile?.getBoundingClientRect();
    return { kids, qrShown: !!r && r.width > 100, tileBg: tile && getComputedStyle(tile).backgroundColor,
      first: body.firstElementChild.tagName, firstText: body.firstElementChild.textContent,
      href: body.firstElementChild.getAttribute("href") || "", key: !!document.querySelector("dialog.nc-ui details input[type=password]") };
  });
  t("the signer app is the first thing in the dialog", layout.first === "A" && /signer app/i.test(layout.firstText), JSON.stringify(layout.kids));
  t("and it is one tap: a nostrconnect link, ready when the dialog opens", /^nostrconnect:\/\/[0-9a-f]{64}\?/.test(layout.href));
  t("on a desktop the QR code is shown, as a white tile", layout.qrShown && layout.tileBg === "rgb(255, 255, 255)", JSON.stringify(layout));
  t("pasting a key is further down, out of the way", layout.key);
  const code = await p.evaluate(() => document.querySelector("dialog.nc-ui svg path").getBoundingClientRect().width);
  t("the code's modules are drawn", code > 100);

  // 2. Approve in the app. The page opens.
  const link = await p.evaluate(() => document.querySelector("dialog.nc-ui a").href);
  const app = amber({ link, userSk });
  await app.approve();
  await p.waitForFunction(() => document.querySelectorAll(".item").length === 3, null, { timeout: 20000 }).catch(() => {});
  t("approving in the signer app opens the page", await p.evaluate(() => document.querySelectorAll(".item").length === 3), app.log.join(","));
  t("and the page knows the person, not the app's transport key", await p.evaluate((u) => nc.sealed.state?.member === u, app.userPk) && app.userPk !== app.transportPk);
  t("the app was asked for the person's key, and to decrypt", app.log.includes("get_public_key") && app.log.includes("nip44_decrypt"), app.log.join(","));
  app.close(); await ctx.close();
}

// 3. A phone: the app on top, the code behind a button.
{
  const { ctx, p } = await openDialog({ ...devices["Pixel 7"], colorScheme: "dark" });
  const before = await p.evaluate(() => { const svg = document.querySelector("dialog.nc-ui svg"); return { hidden: !svg || svg.getBoundingClientRect().width === 0, first: document.querySelector("dialog.nc-ui .nc-body").firstElementChild.textContent };
  });
  t("on a phone the code is behind a button", before.hidden, JSON.stringify(before));
  const toggle = p.locator("dialog.nc-ui .nc-body button", { hasText: /QR/ });
  await toggle.tap();
  const shown = await p.evaluate(() => { const r = document.querySelector("dialog.nc-ui svg").getBoundingClientRect(); return r.width > 150; });
  t("Show QR code shows it, readable", shown);
  const tileColors = await p.evaluate(() => { const tile = document.querySelector("dialog.nc-ui svg"); const s = getComputedStyle(tile); return { bg: s.backgroundColor, w: tile.getBoundingClientRect().width }; });
  t("on a white tile that fits the screen", tileColors.bg === "rgb(255, 255, 255)" && tileColors.w <= 412, JSON.stringify(tileColors));
  // The same sign-in, the answer arriving a moment after the person comes back from the app.
  const link = await p.evaluate(() => document.querySelector("dialog.nc-ui a").href);
  const app = amber({ link, userSk, delayMs: 1500 });
  await p.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await app.approve();
  await p.waitForFunction(() => document.querySelectorAll(".item").length === 3, null, { timeout: 20000 }).catch(() => {});
  t("a phone signs in through the app too", await p.evaluate(() => document.querySelectorAll(".item").length === 3 && nc.isOwner), app.log.join(","));
  app.close(); await ctx.close();
}

// 4. Somebody who is not a member signs in with the app: the page says so, it does not wait forever.
{
  const { ctx, p } = await openDialog({});
  const link = await p.evaluate(() => document.querySelector("dialog.nc-ui a").href);
  const stranger = amber({ link, userSk: generateSecretKey() });
  await stranger.approve();
  await p.waitForFunction(() => document.documentElement.getAttribute("nc:locked") === "not-a-member", null, { timeout: 20000 }).catch(() => {});
  t("a person who is not a member is told so", await p.evaluate(() => document.documentElement.getAttribute("nc:locked")) === "not-a-member");
  stranger.close(); await ctx.close();
}

// 5. The browser drops the page's sockets while the person is in the signer app (a phone sends
// a tab to the background without saying so), and the approval comes after that.
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"] });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => { const O = window.WebSocket; window.__sockets = []; window.WebSocket = class extends O { constructor(...a) { super(...a); window.__sockets.push(this); } }; });
  await p.goto(made.url); await ready(p);
  await p.evaluate((relay) => { nc.cfg.signerRelays = [relay]; }, RELAY);
  await p.click("#nc-locked button");
  await p.waitForSelector("dialog.nc-ui a[href^='nostrconnect:']", { timeout: 8000 });
  const link = await p.evaluate(() => document.querySelector("dialog.nc-ui a").href);
  await p.waitForTimeout(1500);
  const open = await p.evaluate(() => window.__sockets.filter((s) => s.readyState === 1).length);
  await p.evaluate(() => window.__sockets.forEach((s) => { try { s.close(); } catch {} }));
  await p.waitForTimeout(500);
  const app = amber({ link, userSk, delayMs: 6000 });
  await app.approve();
  await p.waitForFunction(() => document.querySelectorAll(".item").length === 3, null, { timeout: 30000 }).catch(() => {});
  const ok = await p.evaluate(() => document.querySelectorAll(".item").length === 3);
  t("sockets dropped while in the app: the page still signs in after the approval", ok, "open sockets before the drop: " + open + "; " + app.log.join(","));
  if (!ok) {
    const back = await p.evaluate(() => { const b = [...document.querySelectorAll("dialog.nc-ui button")].find((x) => /nothing happened|Try again/i.test(x.textContent)); return { shown: !!b && getComputedStyle(b).display !== "none", status: document.querySelector("dialog.nc-ui .nc-status")?.textContent }; });
    console.log("   dialog state:", JSON.stringify(back));
  }
  app.close(); await ctx.close();
}

t("no page errors", errors.filter((x) => !/Content Security Policy|ERR_|Failed to load resource|violates/.test(x)).length === 0, errors.join(" | "));
await browser.close();
const bad = out.filter((x) => !x[1]);
console.log(`\n${out.length - bad.length}/${out.length} passed`);
devnet.kill();
process.exit(bad.length ? 1 : 0);
