#!/usr/bin/env node
// Screenshot every staged template from site/t/<name>/, served the way a
// gateway serves it: the site root is the server root, so the shared files
// resolve from /.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, statSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown" };

const server = createServer((q, s) => {
  let p = join("site", decodeURIComponent(q.url.split("?")[0]));
  try { if (statSync(p).isDirectory()) p = join(p, "index.html"); } catch {}
  try {
    const b = readFileSync(p);
    s.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream" });
    s.end(b);
  } catch { s.writeHead(404); s.end("not found"); }
}).listen(0);
const port = server.address().port;

mkdirSync("media/templates", { recursive: true });
const only = process.argv[2];
const names = readdirSync(join("site", "t")).filter((n) => !only || n === only);

const browser = await chromium.launch({ channel: "chrome" });
for (const name of names) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 120)); });
  try {
    await page.goto(`http://127.0.0.1:${port}/t/${name}/`, { waitUntil: "networkidle", timeout: 25000 });
    await new Promise((r) => setTimeout(r, 3500));          // let feeds settle
    // A reader sees no chrome until #edit, so this is the honest shot.
    const gated = await page.evaluate(`(() => {
      const bar = document.querySelector('.nc-bar');
      return { hasBar: !!bar, barVisible: !!bar && getComputedStyle(bar).display !== 'none',
               editing: document.documentElement.getAttribute('nc:editing') };
    })()`);
    await page.screenshot({ path: `media/templates/${name}.png` });
    console.log(`${name.padEnd(10)} shot ok   gate:${gated.editing} barHidden:${gated.hasBar && !gated.barVisible}` +
      (errs.length ? `   ERRORS: ${errs.slice(0, 2).join(" | ")}` : ""));
  } catch (e) {
    console.log(`${name.padEnd(10)} FAILED    ${e.message.split("\n")[0]}`);
  }
  await page.close();
}
await browser.close();
server.close();
process.exit(0);
