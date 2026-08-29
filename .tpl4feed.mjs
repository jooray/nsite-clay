import { chromium } from "playwright";
const base = "http://127.0.0.1:4877";
const OUT = "/private/tmp/claude-502/-Users-juraj-tmp-nostrclay/9188ecf3-578b-4bad-9a1f-1652a7c23ea3/scratchpad/tpl4/shots";
const b = await chromium.launch({ channel: "chrome" });
for (const name of process.argv.slice(2)) {
  const p = await b.newPage({ viewport: { width: 1200, height: 700 } });
  await p.goto(`${base}/${name}/`, { waitUntil: "networkidle" });
  await p.waitForTimeout(4000);
  const el = p.locator("[nc\\:feed]").first();
  await el.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/${name}-feed.png` });
  await p.close();
}
await b.close();
console.log("ok");
