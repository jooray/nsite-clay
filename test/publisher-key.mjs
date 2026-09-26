// The Copy button on a key nobody can ever recover: it has to tell the truth
// about whether it copied, and it has to come back.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { mockAiAccount } from "./ai-account-fixture.mjs";
const srv = createServer((q, r) => {
  const p = new URL(q.url, "http://l").pathname;
  const f = p === "/nsite-clay.js" ? "dist/nsite-clay.js" : p === "/nsite-clay-base.css" ? "templates/_shared/nsite-clay-base.css" : join("site", p);
  try { r.writeHead(200, { "Content-Type": { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" }[extname(f)] || "application/octet-stream" }); r.end(readFileSync(f)); }
  catch { r.writeHead(404); r.end(); }
}).listen(4809, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const b = await chromium.launch({ channel: "chrome" });
const out = [];
const t = (n, pass, d = "") => out.push([n, pass, d]);
const ctx = await b.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
await mockAiAccount(page);
await page.goto("http://127.0.0.1:4809/deploy.html");
await page.evaluate(async () => { await nc.ready; });
await page.click("#way-new");
await page.waitForSelector("#newkey:not([hidden])");
const nsec = (await page.textContent("#newkey-nsec")).trim();
t("a new key is shown", /^nsec1/.test(nsec), nsec.slice(0, 12));

await page.click("#newkey-copy");
await page.waitForTimeout(150);
const clip = await page.evaluate(() => navigator.clipboard.readText());
t("pressing Copy puts the key on the clipboard", clip === nsec, clip.slice(0, 12));
t("and says so", (await page.textContent("#newkey-copy")).trim() === "Copied");
await page.waitForTimeout(3200);
t("then goes back to Copy so it can be pressed again", (await page.textContent("#newkey-copy")).trim() === "Copy");
await page.click("#newkey-copy");
await page.waitForTimeout(150);
t("and pressing it again does copy again", (await page.textContent("#newkey-copy")).trim() === "Copied");

// A browser with no clipboard API at all, which plain HTTP is.
const bare = await b.newContext();
const p2 = await bare.newPage();
await mockAiAccount(p2);
await p2.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", { get: () => undefined, configurable: true });
  document.execCommand = () => false;
});
await p2.goto("http://127.0.0.1:4809/deploy.html");
await p2.evaluate(async () => { await nc.ready; });
await p2.click("#way-new");
await p2.waitForSelector("#newkey:not([hidden])");
await p2.click("#newkey-copy");
await p2.waitForTimeout(150);
const said = (await p2.textContent("#newkey-copy")).trim();
t("when it cannot copy at all it says so rather than claiming success", /could not copy/i.test(said), said);
await p2.waitForTimeout(3200);
t("and still comes back", (await p2.textContent("#newkey-copy")).trim() === "Copy");

// A key made here a moment ago has published nothing, so the first publish
// writes its relay list without looking one up, which is what keeps a slow
// lookup relay from leaving a new site unfindable. Signing in with the key's
// own text must not lose that.
await p2.check("#newkey-ok");
await p2.click("#newkey-go");
await p2.waitForFunction(() => !!nc.signer, null, { timeout: 10000 });
t("a key made in the publisher signs in knowing it is new", await p2.evaluate(() => nc.signer.fresh === true));
t("and it is the key that was shown", await p2.evaluate(() =>
  nc.nip19.nsecEncode(nc.signer.sec) === document.querySelector("#newkey-nsec").textContent.trim()));

for (const [n, pass, d] of out) console.log(`  ${pass ? "ok  " : "FAIL"} ${n}${d ? "   (" + d + ")" : ""}`);
console.log(`\n${out.filter((r) => r[1]).length}/${out.length} passed`);
if (out.every((r) => r[1])) console.log("Publisher key: the new nsec copies, says whether it did, and the button comes back.");
await b.close(); srv.close();
process.exit(out.every((r) => r[1]) ? 0 : 1);
