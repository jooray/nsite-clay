// A bounded desktop/mobile review of the additions. No public payments,
// inference, relay events or Blossom uploads are made by this script.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";

const out = ".impeccable/review"; mkdirSync(out, { recursive: true });
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = path === "/demo" ? "demo/index.html" : path === "/nsite-clay.js" ? "dist/nsite-clay.js" :
    ["/nsite-clay-base.css", "/nsite-clay-chrome.js"].includes(path) ? join("templates/_shared", path) : join("site", path);
  try { res.setHeader("Content-Type", { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream"); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const browser = await chromium.launch({ channel: "chrome" });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    await page.routeWebSocket("**", (ws) => ws.close());
    await page.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin + "/sk/deploy.html");
    await page.evaluate(async () => { await nc.ready; nc.manifestOf = async () => null; });
    await page.click("#way-key");
    await page.fill("#key", "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y");
    await page.click("#key-go"); await page.waitForSelector("#tpls .tpl");
    await page.click("#ai-builder summary");
    await page.fill("#ai-description", "Stránka pre komunitnú cyklodielňu. Stretávame sa v sobotu, opravujeme bicykle a požičiavame si náradie.");
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${out}/publisher-${name}.png`, fullPage: true });
    await page.click("#ai-settings");
    await page.screenshot({ path: `${out}/settings-${name}.png`, fullPage: true });
    await page.keyboard.press("Escape");

    await page.goto(origin + "/demo#edit");
    await page.evaluate(async () => {
      await nc.ready; await nc.login("nsec", { key: "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y" });
    });
    await page.screenshot({ path: `${out}/editor-${name}.png`, fullPage: true });
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.innerHTML = `<span id="review-price" nc:cms-type="number" nc:cms-min="0">25</span><span id="review-status" nc:cms-type="select" nc:cms-options='["Open","Closed"]'>Open</span><div id="review-body"><p>Bring your bike. <b>Tools are provided.</b></p></div>`;
      document.body.append(host);
      const rules = document.createElement("script"); rules.setAttribute("nc:cms", "review"); rules.type = "application/json";
      rules.textContent = JSON.stringify({ Price: "#review-price", Status: "#review-status", Description: "#review-body@innerHTML" });
      document.body.append(rules); nc.cms.open("review");
    });
    await page.screenshot({ path: `${out}/cms-${name}.png`, fullPage: true });
    await page.evaluate(async () => {
      nc.cms.close();
      const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 400;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#345c62"; ctx.fillRect(0, 0, 600, 400); ctx.fillStyle = "#e2be73"; ctx.fillRect(80, 60, 320, 240);
      const blob = await new Promise((r) => canvas.toBlob(r)); void nc.media.crop(blob, { aspect: 1 });
    });
    await page.waitForSelector(".qc-stage");
    await page.screenshot({ path: `${out}/crop-${name}.png`, fullPage: true });
    await page.close();
  }
  console.log(`Desktop and mobile evidence saved in ${out}.`);
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
