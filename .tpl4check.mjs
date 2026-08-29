import { chromium } from "playwright";
const NSEC = "nsec1hmd3a3psw3n277csh8gd0r375dq5qpe9suyxqq023afjwajk6lnsa4m73x";
const base = "http://127.0.0.1:4877";
const browser = await chromium.launch({ channel: "chrome" });
const out = {};
const vis = `(s) => { const e = document.querySelector(s); if (!e) return "missing";
  const c = getComputedStyle(e); return c.display !== "none" && c.visibility !== "hidden" ? "shown" : "hidden"; }`;

for (const name of process.argv.slice(2)) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(`${base}/own-${name}/`, { waitUntil: "networkidle" });
  await page.waitForFunction("window.nc && nc.cfg", null, { timeout: 8000 }).catch(() => {});
  const plain = await page.evaluate((v) => ({
    editing: document.documentElement.getAttribute("nc:editing"),
    bar: eval(v)(".nc-bar"), hint: eval(v)(".nc-edit-hint"),
  }), vis);

  await page.goto(`${base}/own-${name}/#edit`, { waitUntil: "networkidle" });
  await page.waitForFunction("window.nc && nc.cfg", null, { timeout: 8000 }).catch(() => {});
  const gated = await page.evaluate((v) => ({
    editing: document.documentElement.getAttribute("nc:editing"),
    bar: eval(v)(".nc-bar"), hint: eval(v)(".nc-edit-hint"),
    saveBtn: eval(v)("[data-nc-save]"),
  }), vis);

  const login = await page.evaluate(async ({ key, v }) => {
    await nc.ready;
    await nc.login("nsec", { key });
    await new Promise((r) => setTimeout(r, 500));
    const armed = [...document.querySelectorAll("[editable]")].filter((e) => e.isContentEditable);
    return {
      isOwner: nc.isOwner, ownerHere: document.documentElement.getAttribute("nc:owner-here"),
      editables: document.querySelectorAll("[editable]").length, armed: armed.length,
      who: document.querySelector("[data-nc-who]")?.textContent,
      saveBtn: eval(v)("[data-nc-save]"),
      barBg: getComputedStyle(document.querySelector(".nc-bar")).backgroundColor,
      barRadius: getComputedStyle(document.querySelector(".nc-bar")).borderRadius,
      barFont: getComputedStyle(document.querySelector(".nc-bar")).fontFamily.slice(0, 40),
      primaryBg: getComputedStyle(document.querySelector(".nc-primary")).backgroundColor,
    };
  }, { key: NSEC, v: vis });

  // type into the first editable, confirm the DOM took it
  const typed = await page.evaluate(async () => {
    const el = [...document.querySelectorAll("[editable]")].find((e) => e.isContentEditable);
    if (!el) return "none armed";
    el.focus();
    document.execCommand("insertText", false, "ZZ");
    return el.textContent.includes("ZZ") ? "accepted" : "rejected";
  });

  const feed = await page.evaluate(() => new Promise((res) => {
    const els = [...document.querySelectorAll("[nc\\:feed]")];
    let n = 0;
    const t = setInterval(() => {
      n++;
      const r = els.map((el) => ({ items: el.querySelectorAll(".nc-item").length,
        status: el.querySelector(".nc-feed-status")?.textContent || null }));
      if (n > 20 || r.every((x) => x.items > 0)) { clearInterval(t); res(r); }
    }, 500);
  }));

  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(300);
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));

  // scripting off
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1200, height: 900 } });
  const p2 = await ctx.newPage();
  await p2.goto(`${base}/${name}/`, { waitUntil: "domcontentloaded" });
  const noJs = await p2.evaluate(() => 1).catch(() => null);
  const text = (await p2.locator("body").innerText()).replace(/\s+/g, " ").trim();
  await ctx.close();

  out[name] = { plain, gated, login, typed, feed, mobile, noJsChars: text.length, noJsHead: text.slice(0, 90), logs };
  await page.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 1));
