import { chromium } from "playwright";
const base = "http://127.0.0.1:4877";
const OUT = "/private/tmp/claude-502/-Users-juraj-tmp-nostrclay/9188ecf3-578b-4bad-9a1f-1652a7c23ea3/scratchpad/tpl4/shots";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ channel: "chrome" });
for (const name of process.argv.slice(2)) {
  const p = await b.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 1 });
  await p.goto(`${base}/${name}/#edit`, { waitUntil: "networkidle" });
  await p.waitForTimeout(3500);
  await p.screenshot({ path: `${OUT}/${name}-top.png`, fullPage: false });
  await p.screenshot({ path: `${OUT}/${name}-full.png`, fullPage: true });
  if (name === "eco") {
    console.log("eco weight:", await p.locator("#weight").innerText());
  }
  await p.close();
}
await b.close();
console.log("done");
