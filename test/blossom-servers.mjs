// Settings lets the owner replace the Blossom servers a page is stored on, and
// the change lands in the document (nc:servers) and in the running config, so
// the next save uses the new list. Nothing reaches a relay or a real server.
//
// Run: node test/blossom-servers.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const NSEC = "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y";
const NPUB = "npub16kwfcualkq4kz6vgs8tze0j4jkpgs53h48ghmpnj80s7cvfjspwsh4uk9u";
const html = `<!doctype html><html lang="en" nc:owner="${NPUB}" nc:servers="https://old.example,https://gone.example" ` +
  `nc:runtime-owner="off" nc:autoreload="false"><head><title>T</title></head><body><main><p editable>x</p></main>` +
  `<script src="/nsite-clay.js"></script></body></html>`;
const server = createServer((q, r) => {
  const p = new URL(q.url, "http://l").pathname;
  if (p === "/") { r.writeHead(200, { "Content-Type": "text/html" }); return r.end(html); }
  if (p === "/nsite-clay.js") { r.writeHead(200, { "Content-Type": "text/javascript" }); return r.end(readFileSync("dist/nsite-clay.js")); }
  r.writeHead(404); r.end();
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

const out = [];
const t = (name, pass, detail = "") => out.push([name, !!pass, detail]);
const browser = await chromium.launch({ channel: "chrome" });
try {
  const p = await (await browser.newContext()).newPage();
  p.on("pageerror", (e) => out.push(["pageerror", false, e.message]));
  await p.routeWebSocket("**", (ws) => ws.close());
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.evaluate(async (k) => { await nc.ready; await nc.login("nsec", { key: k }); }, NSEC);

  const open = async () => {
    await p.evaluate(() => { window.__s = nc.settings.open(); });
    await p.waitForSelector("dialog.nc-ui textarea");
  };
  await open();
  const shown = await p.inputValue("dialog.nc-ui textarea");
  t("the field lists the page's current servers", shown === "https://old.example\nhttps://gone.example", JSON.stringify(shown));

  await p.fill("dialog.nc-ui textarea", "https://old.example\nftp://files.example");
  await p.click("dialog.nc-ui .nc-primary");
  const err = await p.textContent("dialog.nc-ui .nc-status");
  t("an entry that is not an address is refused, and the dialog stays", /not a web address/.test(err) && await p.locator("dialog.nc-ui").count() === 1, err);

  await p.fill("dialog.nc-ui textarea", "http://plain.example");
  await p.click("dialog.nc-ui .nc-primary");
  t("plain http is refused for a remote server", /not a web address/.test(await p.textContent("dialog.nc-ui .nc-status")));

  await p.fill("dialog.nc-ui textarea", " \n ");
  await p.click("dialog.nc-ui .nc-primary");
  t("an empty list is refused", /at least one/.test(await p.textContent("dialog.nc-ui .nc-status")));

  await p.fill("dialog.nc-ui textarea", "https://old.example/\nblossom.new.example\nhttps://old.example");
  await p.click("dialog.nc-ui .nc-primary");
  await p.waitForSelector("dialog.nc-ui", { state: "detached" });
  const s = await p.evaluate(() => ({
    attr: document.documentElement.getAttribute("nc:servers"), cfg: nc.cfg.servers, dirty: nc.dirty,
    saved: /nc:servers="https:\/\/old\.example,https:\/\/blossom\.new\.example"/.test(nc.getHTML()),
  }));
  t("the document and the running config take the cleaned list",
    s.attr === "https://old.example,https://blossom.new.example" && s.cfg.join() === s.attr && s.dirty && s.saved, JSON.stringify(s));
} finally {
  await browser.close(); server.close();
}
let bad = 0;
for (const [n, ok, d] of out) { console.log(`${ok ? "ok  " : "FAIL"} ${n}${ok || !d ? "" : "  " + d}`); if (!ok) bad++; }
process.exit(bad ? 1 : 0);
