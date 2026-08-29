import { chromium } from "playwright";
const base = "http://127.0.0.1:4877";
const NSEC = "nsec1hmd3a3psw3n277csh8gd0r375dq5qpe9suyxqq023afjwajk6lnsa4m73x";
const vis = (s) => { const e = document.querySelector(s); if (!e) return "missing";
  const c = getComputedStyle(e); return c.display !== "none" && c.visibility !== "hidden" ? "shown" : "hidden"; };
const b = await chromium.launch({ channel: "chrome" });
for (const name of process.argv.slice(2)) {
  const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
  const logs = [];
  p.on("console", (m) => { if (m.type() === "error") logs.push(m.text()); });
  p.on("pageerror", (e) => logs.push("pageerror: " + e.message));
  await p.addInitScript(`window.__vis = ${vis.toString()}`);

  await p.goto(`${base}/own-${name}/`, { waitUntil: "networkidle" });
  await p.waitForFunction("window.nc && nc.cfg", null, { timeout: 8000 }).catch(() => {});
  const reader = await p.evaluate(() => ({ bar: __vis(".nc-bar"), hint: __vis(".nc-edit-hint") }));

  await p.goto(`${base}/own-${name}/#edit`, { waitUntil: "networkidle" });
  await p.waitForFunction("window.nc && nc.cfg", null, { timeout: 8000 }).catch(() => {});
  const gated = await p.evaluate(() => ({ bar: __vis(".nc-bar"), hint: __vis(".nc-edit-hint") }));
  const owner = await p.evaluate(async (k) => {
    await nc.ready; await nc.login("nsec", { key: k });
    await new Promise((r) => setTimeout(r, 500));
    return { isOwner: nc.isOwner, save: __vis("[data-nc-save]"),
      armed: [...document.querySelectorAll("[editable]")].filter((e) => e.isContentEditable).length,
      editables: document.querySelectorAll("[editable]").length };
  }, NSEC);
  // owner signed in, gate closed -> the hint should now be the one thing showing
  await p.goto(`${base}/own-${name}/`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  const ownerNoHash = await p.evaluate(() => ({ owner: nc.isOwner, bar: __vis(".nc-bar"), hint: __vis(".nc-edit-hint") }));
  const feed = await p.evaluate(() => new Promise((res) => {
    let n = 0; const els = [...document.querySelectorAll("[nc\\:feed]")];
    const t = setInterval(() => { n++;
      const r = els.map((e) => e.querySelectorAll(".nc-item").length);
      if (n > 20 || r.every((x) => x > 0)) { clearInterval(t); res(r); } }, 500);
  }));
  console.log(name, JSON.stringify({ reader, gated, owner, ownerNoHash, feed, logs }));
  await p.close();
}
await b.close();
