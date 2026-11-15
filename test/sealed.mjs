// Sealed pages, end to end, on a devnet this test starts for itself: the agent
// tool publishes an encrypted list, a browser opens it from its link, edits it
// and saves, the tool reads back what changed, and at the end deletes it.
//
// Run: node test/sealed.mjs        ENGINE=firefox|webkit for Playwright's builds
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPorts } from "./local-ports.mjs";

const S = mkdtempSync(join(tmpdir(), "nc-sealed-"));
const [RP, BP, GP] = await localPorts(3);
const devnet = spawn("node", ["tools/devnet.mjs", "--quiet"], { stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: RP, DEVNET_BLOSSOM_PORT: BP, DEVNET_GATEWAY_PORT: GP } });
process.on("exit", () => { try { devnet.kill(); } catch {} try { rmSync(S, { recursive: true, force: true }); } catch {} });
await new Promise((r) => setTimeout(r, 700));
const env = { ...process.env, NSITE_ARTIFACTS_HOME: S + "/home", NSITE_ARTIFACTS_RELAYS: "ws://127.0.0.1:" + RP,
  NSITE_ARTIFACTS_SERVERS: "http://127.0.0.1:" + BP, NSITE_ARTIFACTS_GATEWAY: "http://{host}.localhost:" + GP, NSITE_ARTIFACTS_RUNTIME: process.cwd() };
// The one-file build the skill ships, which is also what `nsite-clay artifact` runs.
const A = (...args) => { try { return JSON.parse(execFileSync("node", ["skills/nsite-artifacts/scripts/artifact.mjs", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); } catch (e) { return { error: String(e.stderr || e.message).trim() }; } };
const A2 = (extra, ...args) => { try { return JSON.parse(execFileSync("node", ["skills/nsite-artifacts/scripts/artifact.mjs", ...args], { env: { ...env, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); } catch (e) { return { error: String(e.stderr || e.message).trim() }; } };
const sha = (text) => createHash("sha256").update(text).digest("hex");
const BLOSSOM = "http://127.0.0.1:" + BP;
const blobStatus = async (hash) => (await fetch(BLOSSOM + "/" + hash)).status;
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 200)); } };
const out = []; const t = (name, pass, detail = "") => { out.push([name, !!pass, detail]); console.log((pass ? "ok   " : "FAIL ") + name + (pass ? "" : "  " + String(detail).slice(0, 300))); };

A("list-page", "--title=Shopping", "--note=For Saturday", "--item=Milk", "--item=[x] Bread", "--item=Eggs", "--out=" + S + "/list.html");
const made = A("create", S + "/list.html", "--edit=link", "--title=Shopping", "--expires=30d");
t("create returns links", made.editLink && made.readLink && made.link === made.editLink, JSON.stringify(made));

const served = await (await fetch(made.url)).text();
t("the gateway serves a shell with none of the content", served.includes("application/nc-sealed") && !/Milk|Bread|Shopping|Saturday/.test(served), served.slice(0, 400));
t("the shell carries a policy and a generic title", /Content-Security-Policy/.test(served) && /<title[^>]*>Private page</.test(served));

const engine = process.env.ENGINE || "chrome";
const { firefox, webkit } = await import("playwright");
const browser = engine === "chrome" ? await chromium.launch({ channel: "chrome" }) : await ({ firefox, webkit })[engine].launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
const ctx = await browser.newContext();
const p = await ctx.newPage();
const errors = []; p.on("pageerror", (e) => errors.push(e.message)); p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const ready = (pg) => pg.waitForFunction(() => document.documentElement.getAttribute("nc:ready") === "true" && !document.documentElement.hasAttribute("nc:sealed") || document.documentElement.hasAttribute("nc:locked"), null, { timeout: 15000 });

await p.goto(made.editLink); await ready(p);
t("the edit link opens the page", await p.locator(".item").count() === 3, await p.content().then((c) => c.slice(0, 300)));
t("its scripts ran (DOMContentLoaded and inline)", await p.evaluate(() => typeof listAdd === "function" && document.readyState === "complete"));
t("the holder of the edit link is the owner", await p.evaluate(() => nc.isOwner && nc.sealed.active && nc.sealed.canEdit));
t("the shell's policy is on the opened page", await p.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')));
const blocked = await p.evaluate(async () => { try { await fetch("http://127.0.0.1:5999/x?leak=1", { mode: "no-cors" }); return "sent"; } catch (e) { return "blocked"; } });
const violation = p.waitForEvent("console", { timeout: 3000 }).catch(() => null);
t("fetch to an origin that is not the page's own is blocked", blocked === "blocked", blocked);
const img = await p.evaluate(() => new Promise((r) => { document.addEventListener("securitypolicyviolation", (e) => r(e.violatedDirective), { once: true }); const i = new Image(); i.src = "http://127.0.0.1:5999/pixel.gif?leak=1"; setTimeout(() => r("none"), 1500); }));
t("so is an image beacon", /img-src/.test(img), img);
const scr = await p.evaluate(() => new Promise((r) => { document.addEventListener("securitypolicyviolation", (e) => r(e.violatedDirective), { once: true }); const s = document.createElement("script"); s.src = "https://cdn.example.com/x.js"; document.head.append(s); setTimeout(() => r("none"), 1500); }));
t("and a script from a CDN", /script-src/.test(scr), scr);

await p.locator(".item", { hasText: "Milk" }).locator("input").check();
await p.fill("form.add input", "Coffee"); await p.press("form.add input", "Enter");
await p.waitForFunction(() => document.querySelector(".state").textContent === "Saved.", null, { timeout: 30000 }).catch(() => {});
t("the page saved itself", await p.evaluate(() => document.querySelector(".state").textContent) === "Saved.", await p.evaluate(() => document.querySelector(".state").textContent + " | " + nc.status));

const after = await (await fetch(made.url)).text();
t("what it saved is a shell again", after.includes("application/nc-sealed") && !/Coffee|Milk/.test(after) && after !== served);
t("the version it replaced is deleted from Blossom", await until(async () => (await blobStatus(sha(served))) === 404), await blobStatus(sha(served)));
const st = A("status", made.id);
t("the agent sees that something changed", st.changed === true, JSON.stringify(st));
const rd = A("read", made.id);
t("and reads exactly what", rd.changed && JSON.stringify(rd.changes) === JSON.stringify([{ change: "checked", line: "Milk" }, { change: "added", line: "[ ] Coffee" }]), JSON.stringify(rd));
t("the text has every row and its state", /\[x\] Milk\n\[x\] Bread\n\[ \] Eggs\n\[ \] Coffee/.test(rd.text), rd.text);
t("a second read reports no change", A("read", made.id).changed === false);

// Something on the page tries to get it published in the clear.
await p.evaluate(() => { document.documentElement.removeAttribute("nc:sealed"); document.documentElement.setAttribute("nc:owner", "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsclcak"); window.__ncSealed2 = 1; document.title = "Leaky title"; });
await p.locator(".item", { hasText: "Eggs" }).locator("input").check();
await p.waitForFunction(() => document.querySelector(".state").textContent === "Saved." && !nc.dirty, null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(500);
const third = await (await fetch(made.url)).text();
t("a page that drops its own sealed mark still saves sealed", third.includes("application/nc-sealed") && !/Eggs|Leaky/.test(third) && third !== after, third.slice(0, 200));
const relayEvents = await p.evaluate((RP) => new Promise((r) => { const ws = new WebSocket("ws://127.0.0.1:" + RP); const got = []; ws.onopen = () => ws.send(JSON.stringify(["REQ", "x", { kinds: [15128, 5128] }])); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d[0] === "EVENT") got.push(d[2]); else { ws.close(); r(got); } }; }), RP);
const mine = relayEvents.filter((e) => e.pubkey === nip19.decode(made.url.match(/npub1[a-z0-9]+/)[0]).data);
t("a sealed page files no version snapshots", mine.length >= 1 && !mine.some((e) => e.kind === 5128), JSON.stringify(mine.map((e) => e.kind)));
t("no event carries the title, every one is marked sealed and expiring", mine.length >= 1 && mine.every((e) => !e.tags.some((x) => x[0] === "title") && e.tags.some((x) => x[0] === "sealed") && e.tags.some((x) => x[0] === "expiration")), JSON.stringify(mine.map((e) => e.tags.filter((x) => x[0] !== "path"))));

// A reader.
const ctx2 = await browser.newContext(); const r = await ctx2.newPage();
await r.goto(made.readLink); await ready(r);
t("the read link shows the list as saved", await r.locator(".item").count() === 4 && await r.locator(".item", { hasText: "Eggs" }).locator("input").isChecked());
t("and cannot save", await r.evaluate(() => !nc.isOwner && !nc.sealed.canEdit && getComputedStyle(document.querySelector("form.add")).display === "none"));
await r.click("#nc-sealed-menu"); await r.waitForSelector(".nc-ui [data-link=readLink]");
t("a reader's panel has the read link and nothing that changes the page", await r.evaluate((link) =>
  document.querySelector(".nc-ui [data-link=readLink]").value === link && !document.querySelector(".nc-ui [data-link=editLink], .nc-ui [data-delete], .nc-ui [data-add]"), made.readLink));
await r.click(".nc-ui .nc-primary");
t("the same tab reopens it without the key in the address", await (async () => { await r.goto(made.url); await ready(r); return (await r.locator(".item").count()) === 4; })());
const r2 = await (await browser.newContext()).newPage(); { const r = r2;
await r.goto(made.url); await ready(r);
t("without the key the page stays locked", await r.evaluate(() => document.documentElement.getAttribute("nc:locked")) === "no-key" && !/Milk/.test(await r.content()));
await r.goto(made.url + "#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); await ready(r);
await r.waitForFunction(() => document.documentElement.getAttribute("nc:locked") === "wrong-key", null, { timeout: 8000 }).catch(() => {});
t("a wrong key opens nothing", await r.evaluate(() => document.documentElement.getAttribute("nc:locked")) === "wrong-key");
}

{
  const pg = await (await browser.newContext()).newPage();
  await pg.goto(made.url); await ready(pg);
  await pg.fill("#nc-locked-link", "see " + made.readLink + " ");
  await pg.click("#nc-locked button");
  await pg.waitForFunction(() => document.querySelectorAll(".item").length === 4, null, { timeout: 15000 }).catch(() => {});
  t("the whole link pasted into a locked page opens it", await pg.locator(".item").count() === 4);
  A("list-page", "--title=Nákup", "--lang=sk", "--item=Mlieko", "--out=" + S + "/sk.html");
  const sk = A("create", S + "/sk.html", "--edit=link");
  await pg.goto(sk.url); await ready(pg);
  t("a Slovak page is locked in Slovak", /Táto stránka je zašifrovaná/.test(await pg.evaluate(() => document.body.innerText)), await pg.evaluate(() => document.body.innerText));
}

// The agent changes the page.
const got = A("read", made.id, "--as=html", "--out=" + S + "/cur.html");
writeFileSync(S + "/cur.html", readFileSync(S + "/cur.html", "utf8").replace("Coffee", "Coffee beans"));
const up = A("update", made.id, S + "/cur.html");
t("the agent can publish a change", !!up.savedAt, JSON.stringify(up));
await p.waitForFunction(() => document.documentElement.getAttribute("nc:outdated") === "true", null, { timeout: 8000 }).catch(() => {});
t("the open tab notices (it is on its canonical host)", await p.evaluate(() => document.documentElement.getAttribute("nc:outdated")) === "true", await p.evaluate(() => String(nc.onCanonicalHost())));
await p.evaluate(() => { window.__sameDocument = true; });
await p.waitForTimeout(6500);
t("an editor is told, with a button, and the page is not reloaded under them",
  await p.evaluate(() => window.__sameDocument === true && /Someone changed this page/.test(document.body.innerText) && !!document.querySelector("[nc\\:chrome] button")),
  await p.evaluate(() => document.body.innerText.slice(-200)));
await p.locator(".item", { hasText: "Bread" }).locator("input").uncheck();
await p.waitForFunction(() => document.querySelector(".state").dataset.kind === "error", null, { timeout: 30000 }).catch(() => {});
t("and a save from that older copy is refused, so the newer one is not overwritten",
  /newer version/.test(await p.evaluate(() => document.querySelector(".state").textContent)), await p.evaluate(() => document.querySelector(".state").textContent));
t("the agent's change is still what is published", /Coffee beans/.test(A("read", made.id, "--peek").text || ""));
await p.goto(made.url + "?x=1" + made.editLink.slice(made.url.length)); await ready(p);
t("and shows it after a reload", /Coffee beans/.test(await p.content()));
await p.locator(".item", { hasText: "Coffee beans" }).locator("input").check();
await p.waitForFunction(() => document.querySelector(".state").textContent === "Saved.", null, { timeout: 30000 }).catch(() => {});
const pic = await p.evaluate(async () => {
  const c = document.createElement("canvas"); c.width = 2400; c.height = 1600;
  const g = c.getContext("2d"); for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${i * 7},70%,50%)`; g.fillRect((i * 97) % 2400, (i * 53) % 1600, 300, 200); }
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const out = await nc.media.upload(new File([blob], "photo.png", { type: "image/png" }));
  const img = new Image(); img.src = out.url; img.alt = "A photo"; document.querySelector("main").append(img);
  await img.decode();
  nc.dirty = true; nc.dispatchEvent(new CustomEvent("nsiteclay:autosave-now"));
  let video = ""; try { await nc.media.upload(new File([new Uint8Array(10)], "a.mp4", { type: "video/mp4" })); } catch (e) { video = e.message; }
  return { url: out.url.slice(0, 30), size: out.size, original: blob.size, width: img.naturalWidth, video };
});
t("a picture added to a sealed page goes inside the page, made smaller", /^data:image\/(webp|jpeg);base64,/.test(pic.url) && pic.size <= 350000 && pic.width <= 1600, JSON.stringify(pic));
t("a video is refused there, in words", /not video/.test(pic.video), pic.video);
await p.waitForFunction(() => document.querySelector(".state").textContent === "Saved." && !nc.dirty, null, { timeout: 30000 }).catch(() => {});
const withPic = await (await fetch(made.url)).text();
t("and is published only as part of the ciphertext", withPic.includes("application/nc-sealed") && !/data:image/.test(withPic) && withPic.length > 20000, withPic.length);
{ const back = A("read", made.id, "--as=html"); t("the agent gets it back with the page", /<img[^>]+src="data:image\//.test(back.html || ""), (back.error || "") + " " + (back.html || "").match(/<img[^>]{0,80}/)); }
const stale0 = A("read", made.id); await p.locator(".item", { hasText: "Coffee beans" }).locator("input").uncheck();
await p.waitForFunction(() => document.querySelector(".state").textContent === "Saved." && !nc.dirty, null, { timeout: 30000 }).catch(() => {});
const stale = A("update", made.id, S + "/cur.html");
t("an agent update over an unread change is refused", /changed after you last read/.test(stale.error || ""), JSON.stringify(stale));

// Members: no link, only a key.
const msk = generateSecretKey(); const mnpub = nip19.npubEncode(getPublicKey(msk));
const priv = A("create", S + "/list.html", "--visibility=private", "--edit=members", "--member=" + mnpub, "--title=Family");
t("a private artifact has no key in any link", priv.link === priv.url && priv.readLink === null && priv.editLink === null, JSON.stringify(priv));
const m = await (await browser.newContext()).newPage();
await m.goto(priv.url); await ready(m);
t("it asks for a sign-in", await m.evaluate(() => document.documentElement.getAttribute("nc:locked")) === "members");
t("in the page's own language, with a button", await m.evaluate(() => /Sign in with your Nostr key/.test(document.body.innerText) && !!document.querySelector("#nc-locked button")));
await m.click("#nc-locked button");
await m.waitForSelector("dialog.nc-ui details summary");
t("the button opens a sign-in with the signer app first and a key field", await m.evaluate(() => /signer app/i.test(document.querySelector(".nc-ui").innerText) && !!document.querySelector(".nc-ui details input[type=password]")));
await m.waitForSelector(".nc-ui svg, .nc-ui canvas, .nc-ui img", { timeout: 5000 }).catch(() => {});
t("the signer code is drawn in the page", await m.evaluate(() => !!document.querySelector(".nc-ui svg, .nc-ui canvas, .nc-ui img") && /^nostrconnect:/.test(document.querySelector(".nc-ui a")?.href || "")));
await m.click(".nc-ui details summary");
await m.fill(".nc-ui input[type=password]", nip19.nsecEncode(msk));
await m.click(".nc-ui .nc-primary");
await m.waitForFunction(() => document.querySelectorAll(".item").length === 3 && window.nc?.isOwner, null, { timeout: 15000 }).catch(() => {});
t("a member's key opens it and can edit", await m.evaluate(() => document.querySelectorAll(".item").length === 3 && nc.isOwner));
await m.click("#nc-sealed-menu"); await m.waitForSelector(".nc-ui [data-members]");
t("a member's panel shows no link, because the page was shared by key", await m.evaluate(() =>
  !document.querySelector(".nc-ui [data-link]") && /with your Nostr key/.test(document.querySelector(".nc-ui").innerText)));
await m.click(".nc-ui .nc-primary");
const stranger = await (await browser.newContext()).newPage();
await stranger.goto(priv.url); await ready(stranger);
await stranger.click("#nc-locked button");
await stranger.click(".nc-ui details summary");
await stranger.fill(".nc-ui input[type=password]", nip19.nsecEncode(generateSecretKey()));
await stranger.click(".nc-ui .nc-primary");
await stranger.waitForTimeout(1500);
t("another key does not", await stranger.evaluate(() => document.documentElement.getAttribute("nc:locked")) === "not-a-member");

// Public, with an edit link.
const pub = A("create", S + "/list.html", "--visibility=public", "--public", "--edit=link", "--title=Open list");
const pubServed = await (await fetch(pub.url)).text();
t("a public artifact is plain HTML", /Milk/.test(pubServed) && !/nc-sealed/.test(pubServed));
const e = await (await browser.newContext()).newPage();
await e.goto(pub.editLink); await ready(e);
t("and its edit link signs in", await e.evaluate(() => nc.isOwner));

// The panel on a page somebody can edit.
{
  const panelPage = A("create", S + "/list.html", "--edit=link", "--title=Panel", "--expires=7d");
  const q = await (await browser.newContext()).newPage();
  q.on("pageerror", (e) => errors.push(e.message));
  await q.goto(panelPage.editLink); await ready(q);
  await q.click("#nc-sealed-menu"); await q.waitForSelector(".nc-ui [data-link=readLink]");
  const panel = await q.evaluate(() => ({ read: document.querySelector(".nc-ui [data-link=readLink]").value,
    edit: document.querySelector(".nc-ui [data-link=editLink]")?.value, del: !!document.querySelector(".nc-ui [data-delete]"),
    text: document.querySelector(".nc-ui").innerText }));
  t("the panel gives an editor both links", panel.read === panelPage.readLink && panel.edit === panelPage.editLink && panel.del, JSON.stringify(panel));
  t("and says when the page goes away", /Deleted automatically on/.test(panel.text), panel.text);
  t("the panel's button is never saved with the page", !/nc-sealed-menu/.test(A("read", panelPage.id, "--as=html", "--peek").html || "x nc-sealed-menu"));

  await q.fill(".nc-ui [data-add-member]", "not a key"); await q.click(".nc-ui [data-add]");
  t("something that is not an npub is refused, in words", /not an npub/.test(await q.locator(".nc-ui .nc-status").textContent()));
  const friend = getPublicKey(generateSecretKey());
  const before = await (await fetch(panelPage.url)).text();
  await q.fill(".nc-ui [data-add-member]", nip19.npubEncode(friend)); await q.click(".nc-ui [data-add]");
  await q.waitForFunction(() => /Added/.test(document.querySelector(".nc-ui .nc-status").textContent), null, { timeout: 30000 }).catch(() => {});
  const shared = await (await fetch(panelPage.url)).text();
  t("adding a person saves the page, sealed, with their key in it", shared.includes(friend) && shared.includes("application/nc-sealed") && shared !== before,
    await q.locator(".nc-ui .nc-status").textContent());
  t("and lists them", await q.evaluate(() => document.querySelectorAll(".nc-ui [data-members] li").length) === 1);
  await q.click(".nc-ui .nc-primary");

  const got2 = A("read", panelPage.id, "--as=html", "--out=" + S + "/panel.html");
  t("the agent reads it as unchanged text", got2.changed === true && !A("read", panelPage.id).changed);
  writeFileSync(S + "/panel.html", readFileSync(S + "/panel.html", "utf8").replace("Eggs", "Eggs, a dozen"));
  const up2 = A("update", panelPage.id, S + "/panel.html");
  const afterAgent = await (await fetch(panelPage.url)).text();
  t("an agent's update keeps the person added in the browser", !!up2.savedAt && afterAgent.includes(friend), JSON.stringify(up2));
  t("and deletes the version it replaced", await until(async () => (await blobStatus(sha(shared))) === 404));

  await q.goto(panelPage.url + "?fresh=1" + panelPage.editLink.slice(panelPage.url.length)); await ready(q);
  await q.click("#nc-sealed-menu"); await q.waitForSelector(".nc-ui [data-delete]");
  await q.click(".nc-ui [data-delete]");
  await q.waitForFunction(() => document.querySelectorAll("dialog.nc-ui").length === 2);
  t("deleting asks first", /cannot be undone/.test(await q.evaluate(() => [...document.querySelectorAll("dialog.nc-ui")].at(-1).innerText)));
  await q.evaluate(() => [...document.querySelectorAll("dialog.nc-ui")].at(-1).querySelector(".nc-primary").click());
  await q.waitForFunction(() => document.documentElement.hasAttribute("nc:deleted"), null, { timeout: 30000 }).catch(() => {});
  t("then the page says it was deleted and shows nothing of it", await q.evaluate(() =>
    document.documentElement.hasAttribute("nc:deleted") && /was deleted/.test(document.body.innerText) && !/Milk/.test(document.body.innerText)));
  t("the gateway stops serving it", (await fetch(panelPage.url)).status === 404);
  t("its bytes are gone from Blossom", await blobStatus(sha(afterAgent)) === 404);
  const st2 = A("status", panelPage.id);
  t("and the agent learns it was deleted from the page", !!st2.deleted && st2.published === false, JSON.stringify(st2));
  t("the other artifacts' runtime is untouched", (await fetch(made.url + "nsite-clay.js")).status === 200);
}

// Moving a sealed page onto a newer runtime.
{
  const now = Math.floor(Date.now() / 1000);
  const rsk = generateSecretKey(), rnpub = nip19.npubEncode(getPublicKey(rsk));
  const put = async (text, type) => {
    const hash = sha(text);
    const auth = finalizeEvent({ kind: 24242, created_at: now, content: "", tags: [["t", "upload"], ["x", hash], ["expiration", String(now + 600)]] }, rsk);
    await fetch(BLOSSOM + "/upload", { method: "PUT", body: text,
      headers: { Authorization: "Nostr " + Buffer.from(JSON.stringify(auth)).toString("base64"), "Content-Type": type } });
    return hash;
  };
  const engineNow = readFileSync("dist/nsite-clay.js", "utf8");
  const newer = await put(engineNow + "\n;window.__ncNewer = 1;\n", "text/javascript");
  const notes = await put(JSON.stringify({ version: "9.9.9", released: "2026-11-13", notes: ["A newer runtime."] }), "application/json");
  const site = finalizeEvent({ kind: 15128, created_at: now, content: "",
    tags: [["path", "/nsite-clay.js", newer], ["path", "/runtime.json", notes], ["server", BLOSSOM]] }, rsk);
  await new Promise((done) => { const ws = new WebSocket("ws://127.0.0.1:" + RP); ws.on("open", () => ws.send(JSON.stringify(["EVENT", site]))); ws.on("message", () => { ws.close(); done(); }); });

  writeFileSync(S + "/app.html", `<!doctype html><html lang="en" nc:runtime-owner="${rnpub}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>Counter</title></head>` +
    `<body><h1 editable="single-line">Counter</h1><p id="n">3</p></body></html>`);
  const app = A("create", S + "/app.html", "--edit=link", "--expires=7d");
  const u = await (await browser.newContext()).newPage();
  u.on("pageerror", (e) => errors.push(e.message));
  await u.goto(app.editLink); await ready(u);
  const servedBefore = await (await fetch(app.url)).text();
  const plan = await u.evaluate(async () => { const p = await nc.upgrade.check(); return p && { files: p.files.map((f) => f.canonical), version: p.version }; });
  t("an opened sealed page finds a newer runtime", plan?.files.includes("/nsite-clay.js") && plan.version === "9.9.9", JSON.stringify(plan));
  const took = await u.evaluate(async () => { try { const r = await nc.upgrade.apply(await nc.upgrade.check()); return { files: r.files }; } catch (e) { return { error: e.message }; } });
  t("and takes it", took.files >= 1, JSON.stringify(took));
  const servedAfter = await (await fetch(app.url)).text();
  t("what it published is still sealed", servedAfter.includes("application/nc-sealed") && !/Counter/.test(servedAfter) && servedAfter !== servedBefore);
  t("the gateway serves the newer engine for it", (await (await fetch(app.url + "nsite-clay.js")).text()).includes("__ncNewer = 1"));
  const u2 = await (await browser.newContext()).newPage();
  await u2.goto(app.editLink); await ready(u2);
  t("the page opens on the newer runtime, editable, with its content", await u2.evaluate(() =>
    window.__ncNewer === 1 && nc.sealed.canEdit && nc.isOwner && document.getElementById("n")?.textContent === "3"));
  t("and nothing offers the same update again", await u2.evaluate(async () => !(await nc.upgrade.check())));
  t("the agent still reads it", /Counter/.test(A("read", app.id).text || ""));

  // The agent's way: a runtime directory with a newer engine in it.
  const rt = S + "/rt"; mkdirSync(rt, { recursive: true });
  writeFileSync(rt + "/nsite-clay.js", engineNow + "\n;window.__ncNewer = 2;\n");
  const list2 = A("create", S + "/list.html", "--edit=link", "--title=Old list");
  const shellBefore = await (await fetch(list2.url)).text();
  const ug = A2({ NSITE_ARTIFACTS_RUNTIME: rt }, "upgrade", list2.id);
  t("artifact upgrade moves a page onto the tool's runtime", ug.upgraded?.[0]?.id === list2.id && ug.upgraded[0].files.includes("/nsite-clay.js"), JSON.stringify(ug));
  t("without touching the page itself", (await (await fetch(list2.url)).text()) === shellBefore);
  t("and a second run finds nothing to do", A2({ NSITE_ARTIFACTS_RUNTIME: rt }, "upgrade", list2.id).current?.includes(list2.id));
  const v = await (await browser.newContext()).newPage();
  await v.goto(list2.editLink); await ready(v);
  t("the page opens on it and still saves sealed", await v.evaluate(() => window.__ncNewer === 2 && nc.sealed.canEdit) &&
    await (async () => { await v.locator(".item", { hasText: "Milk" }).locator("input").check();
      await v.waitForFunction(() => document.querySelector(".state").textContent === "Saved.", null, { timeout: 30000 }).catch(() => {});
      const s2 = await (await fetch(list2.url)).text(); return s2.includes("application/nc-sealed") && s2 !== shellBefore; })());
}

// Navigation: what no policy stops.
const leak = await (await browser.newContext()).newPage();
await leak.goto(made.readLink); await ready(leak);
const nav = await leak.evaluate((GP) => { try { location.href = "http://127.0.0.1:" + GP + "/?leaked=" + encodeURIComponent(document.querySelector(".text").textContent); return "navigating"; } catch (e2) { return "blocked"; } }, GP);
await leak.waitForTimeout(1200);
t("KNOWN GAP: a script on the page can still navigate away with data", /leaked=Milk/.test(leak.url()), leak.url());

// Deleting.
const gone = A("delete", made.id);
t("delete removes the page's blob; the older versions were removed as it was saved", gone.deleted && gone.blobs.deleted === 1 && !gone.blobs.refused.length, JSON.stringify(gone));
const res = await fetch(made.url);
t("and the gateway stops serving it", res.status === 404, res.status);
t("the key is dropped from the ledger", !JSON.parse(readFileSync(S + "/home/ledger.json", "utf8")).artifacts[made.id].secret);
const runtime = await fetch(pub.url + "nsite-clay.js");
t("the shared runtime is untouched", runtime.status === 200);

t("no page errors", errors.filter((x) => !/Content Security Policy|ERR_|Failed to load resource|violates/.test(x)).length === 0, errors.join(" | "));
await browser.close();
const bad = out.filter((x) => !x[1]);
console.log(`\n${out.length - bad.length}/${out.length} passed`);
devnet.kill();
process.exit(bad.length ? 1 : 0);
