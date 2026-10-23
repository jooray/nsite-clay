// "Copy instructions for your own agent": the Settings button puts this site's
// own facts into the text, the text is the general version with those facts
// filled in, and the button speaks the page's language.
//
// Real pages in the installed Chrome, every WebSocket refused, so the page
// works from the manifest it is handed and nothing reaches a relay.
//
// Run: node test/agent-brief.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { finalizeEvent, nip19 } from "nostr-tools";
import { agentInstructions } from "../src/agent-brief.js";

const NSEC = "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y";
const NPUB = "npub16kwfcualkq4kz6vgs8tze0j4jkpgs53h48ghmpnj80s7cvfjspwsh4uk9u";
const RELAYS = "wss://relay.example.org,wss://nos.lol";
const SERVERS = "https://blossom.example.org";

const page = (lang, site = "") => `<!doctype html><html lang="${lang}" nc:owner="${NPUB}" nc:path="/index.html" ` +
  `${site ? `nc:site="${site}" ` : ""}nc:edit-gate="hash" nc:runtime-owner="off" nc:autoreload="false" ` +
  `nc:relays="${RELAYS}" nc:servers="${SERVERS}"><head><title>Bakery</title>` +
  `<link rel="stylesheet" href="/nsite-clay-base.css"></head><body><main><h1 editable="single-line">Bakery</h1></main>` +
  `<div class="nc-bar nc-ui-chrome"><span class="nc-who" data-nc-who>read-only</span>` +
  `<button data-nc-signin>Sign in</button><button class="nc-owner-only" data-nc-settings>Settings</button></div>` +
  `<script src="/nsite-clay.js"></script><script src="/nsite-clay-chrome.js"></script></body></html>`;

const files = {
  "/nsite-clay.js": ["dist/nsite-clay.js", "text/javascript"],
  "/nsite-clay-chrome.js": ["templates/_shared/nsite-clay-chrome.js", "text/javascript"],
  "/nsite-clay-base.css": ["templates/_shared/nsite-clay-base.css", "text/css"],
};
let lang = "en", site = "";
const server = createServer((q, r) => {
  const p = new URL(q.url, "http://l").pathname;
  if (p === "/") { r.writeHead(200, { "Content-Type": "text/html" }); return r.end(page(lang, site)); }
  const f = files[p];
  if (!f) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "Content-Type": f[1] }); r.end(readFileSync(f[0]));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const out = [];
const t = (name, pass, detail = "") => out.push([name, !!pass, detail]);
const sec = nip19.decode(NSEC).data;
// The live manifest the page would have read on load.
const manifest = finalizeEvent({ kind: 15128, created_at: 1760000000, content: "", tags: [
  ["path", "/index.html", "a".repeat(64)], ["path", "/menu/index.html", "b".repeat(64)],
  ["path", "/about.html", "c".repeat(64)], ["path", "/nsite-clay-1a2b3c4d.js", "d".repeat(64)],
] }, sec);

const browser = await chromium.launch({ channel: "chrome" });
try {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const p = await context.newPage();
  p.on("pageerror", (e) => out.push(["pageerror", false, e.message]));
  await p.routeWebSocket("**", (ws) => ws.close());
  await p.goto(base + "/#edit");
  await p.evaluate(async ({ k, ev }) => { await nc.ready; await nc.login("nsec", { key: k }); nc._manifest = ev; }, { k: NSEC, ev: manifest });
  await p.locator("[data-nc-settings]").click();
  const button = p.locator("[data-nc-agent]");
  t("Settings offers the instructions for the owner's own agent", await button.textContent() === "Copy instructions for your own agent");
  await button.click();
  await p.waitForFunction(() => document.querySelector(".nc-toast"));
  const text = await p.evaluate(() => navigator.clipboard.readText());
  t("the click puts the instructions on the clipboard", text.startsWith("# Edit this nsite-clay site"), text.slice(0, 80));
  t("naming the owner and the site's address", text.includes(`Owner key: ${NPUB}`) && text.includes(`https://${NPUB}.nsite.lol/#edit`));
  t("the relays and servers the page saves to", text.includes("wss://relay.example.org, wss://nos.lol") && text.includes(SERVERS));
  t("every page in the live manifest, and only pages", /Pages in the published site[^\n]*: \/about\.html, \/index\.html, \/menu\/index\.html\n/.test(text), text.match(/Pages[^\n]*/)?.[0]);
  t("a pull command for exactly this site", text.includes(`pull ${NPUB} site --relays=${RELAYS} --servers=${SERVERS}\n`));
  t("the engine version", text.includes(`running nsite-clay ${await p.evaluate(() => nc.version)}`));
  t("never a secret key", !/nsec1|"secret"|ncryptsec/.test(text.replace(/an nsec\)/, "")) && !text.includes(NSEC));
  t("no em or en dashes", !/[–—]/.test(text));
  const toast = await p.locator(".nc-toast").textContent();
  t("and says what to do with it", /bunker link/.test(toast) && /never for your key/.test(toast), toast);
  t("the same text the page hands a script", text === await p.evaluate(() => nc.agentInstructions()));

  // The general version is the same template with nothing filled in.
  const general = agentInstructions(null);
  t("the general version has the same sections", ["## 1.", "## 2.", "## 3.", "## 4.", "## 5.", "## 6.", "## 7.", "## Without Node"].every((h) => general.includes(h) && text.includes(h)));

  // A named site, in Slovak.
  lang = "sk"; site = "pekaren";
  const sk = await context.newPage();
  await sk.routeWebSocket("**", (ws) => ws.close());
  await sk.goto(base + "/#edit");
  await sk.evaluate(async (k) => { await nc.ready; await nc.login("nsec", { key: k }); }, NSEC);
  await sk.locator("[data-nc-settings]").click();
  t("the button speaks the page's language", await sk.locator("[data-nc-agent]").textContent() === "Skopírovať pokyny pre vlastného agenta");
  const named = await sk.evaluate(() => nc.agentInstructions());
  const b36 = BigInt("0x" + nip19.decode(NPUB).data).toString(36).padStart(50, "0");
  t("a named site gets its own address, kind and --site", named.includes(`https://${b36}pekaren.nsite.lol/`) && named.includes("kind 35128") && named.includes("--site=pekaren"));

  // A browser that refuses the clipboard shows the text to copy by hand.
  const refusing = await browser.newContext();
  await refusing.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { get: () => ({ writeText: () => Promise.reject(new Error("denied")) }) });
    document.execCommand = () => false;
  });
  const q = await refusing.newPage();
  await q.routeWebSocket("**", (ws) => ws.close());
  lang = "en"; site = "";
  await q.goto(base + "/#edit");
  await q.evaluate(async (k) => { await nc.ready; await nc.login("nsec", { key: k }); }, NSEC);
  await q.locator("[data-nc-settings]").click();
  await q.locator("[data-nc-agent]").click();
  const shown = await q.locator("[data-nc-agent-text]").inputValue();
  t("without a clipboard, the text is shown to copy by hand", shown.includes(NPUB) && shown.startsWith("# Edit this"));
  await refusing.close();
} finally {
  for (const [name, pass, detail] of out) console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail && !pass ? "   (" + detail + ")" : ""}`);
  console.log(`\n${out.filter((r) => r[1]).length}/${out.length} passed`);
  await browser.close(); server.close();
}
process.exit(out.length && out.every((r) => r[1]) ? 0 : 1);
