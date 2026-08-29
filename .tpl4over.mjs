import { chromium } from "playwright";
const base = "http://127.0.0.1:4877";
const NSEC = "nsec1hmd3a3psw3n277csh8gd0r375dq5qpe9suyxqq023afjwajk6lnsa4m73x";
const b = await chromium.launch({ channel: "chrome" });
for (const name of process.argv.slice(2)) {
  for (const w of [320, 375, 768]) {
    const p = await b.newPage({ viewport: { width: w, height: 800 } });
    await p.goto(`${base}/own-${name}/#edit`, { waitUntil: "networkidle" });
    await p.evaluate(async (k) => { await nc.ready; await nc.login("nsec", { key: k }); }, NSEC);
    await p.waitForTimeout(1500);
    const r = await p.evaluate(() => {
      const cw = document.documentElement.clientWidth, hits = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.right > cw + 1) hits.push(el.tagName + "." + el.className.toString().slice(0, 30) + " r=" + Math.round(r.right));
      }
      return { over: document.documentElement.scrollWidth - cw, hits: hits.slice(0, 6) };
    });
    console.log(name, w, JSON.stringify(r));
    await p.close();
  }
}
await b.close();
