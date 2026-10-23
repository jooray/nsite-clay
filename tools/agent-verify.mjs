#!/usr/bin/env node
// What tools/agent-session.mjs is for: after an agent has edited and
// republished the site, check that the change is live, that every page is still
// in the manifest, and that the site still edits and saves itself in a browser.
//
//   node tools/agent-verify.mjs <work dir> [--expect=/path.html:some text]...
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SimplePool } from "nostr-tools";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { chromium } from "playwright";
useWebSocketImplementation(WebSocket);

const work = resolve(process.argv[2] || "agent-session");
const s = JSON.parse(readFileSync(join(work, "session.json"), "utf8"));
const expects = process.argv.filter((a) => a.startsWith("--expect=")).map((a) => {
  const v = a.slice(9); const i = v.indexOf(":"); return [v.slice(0, i), v.slice(i + 1)];
});
const out = [];
const t = (name, pass, detail = "") => out.push([name, !!pass, detail]);

const pool = new SimplePool();
const evs = await pool.querySync([s.relay], { kinds: [15128], authors: [s.pubkey] });
const manifest = evs.sort((a, b) => b.created_at - a.created_at)[0];
const paths = Object.fromEntries(manifest.tags.filter((x) => x[0] === "path").map((x) => [x[1], x[2]]));
const versions = await pool.querySync([s.relay], { kinds: [5128], authors: [s.pubkey] });
pool.close([s.relay]);
t("the manifest still has both pages", paths["/index.html"] && paths["/about.html"], Object.keys(paths).join(" "));
t("no asset is stamped twice", !Object.keys(paths).some((p) => /-[0-9a-f]{8}-[0-9a-f]{8}\./.test(p)), Object.keys(paths).join(" "));
t("more than one version was published", versions.length >= 2, `${versions.length} versions`);

const get = async (p) => { const r = await fetch(`${s.gateway}${p}?npub=${s.npub}`); return { status: r.status, text: await r.text(), type: r.headers.get("content-type") }; };
for (const [p, want] of expects) {
  const r = await get(p);
  t(`${p} has "${want}"`, r.status === 200 && r.text.includes(want), `${r.status} ${r.text.slice(0, 200)}`);
}
for (const p of Object.keys(paths).filter((x) => x.endsWith(".html"))) {
  const r = await get(p);
  const scripts = [...r.text.matchAll(/<script[^>]+src="(\/[^"]+)"/g)].map((m) => m[1]);
  const engine = scripts.filter((x) => /^\/nsite-clay(-[0-9a-f]{8})*\.js$/.test(x));
  const chrome = scripts.filter((x) => /^\/nsite-clay-chrome(-[0-9a-f]{8})*\.js$/.test(x));
  t(`${p} still loads the runtime and the chrome`, engine.length === 1 && chrome.length === 1, scripts.join(" "));
  for (const x of [...engine, ...chrome]) {
    const a = await get(x);
    t(`  ${x} is served as JavaScript`, a.status === 200 && /javascript/.test(a.type || ""), `${a.status} ${a.type}`);
  }
  const path = r.text.match(/nc:path="([^"]*)"/)?.[1] || "/index.html";
  t(`${p} says nc:path="${p}"`, path === p, path);
  t(`${p} keeps its owner and devnet relays`, r.text.includes(`nc:owner="${s.npub}"`) && r.text.includes(`nc:relays="${s.relay}"`));
}

// The browser half: #edit, sign in, edit, save, and the site is still whole.
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.routeWebSocket((url) => !url.href.startsWith(s.relay), (ws) => ws.close());
  for (const p of Object.keys(paths).filter((x) => x.endsWith(".html")).map((x) => x.replace(/\/index\.html$/, "/"))) {
    await page.goto(`${s.site.replace(/\/$/, "")}${p}#edit`);
    await page.evaluate(async () => { await nc.ready; });
    const bar = await page.evaluate(() => getComputedStyle(document.querySelector(".nc-bar")).display !== "none");
    t(`${p}#edit shows the toolbar`, bar);
    await page.evaluate(async (k) => { await nc.login("nsec", { key: k }); }, s.nsec);
    const st = await page.evaluate(() => ({ owner: nc.isOwner, editable: document.documentElement.getAttribute("nc:editable"), version: nc.version }));
    t(`${p}: signing in as the owner arms the editor`, st.owner && st.editable === "true", JSON.stringify(st));
  }
  // A save from the browser, after the agent's deploy, must keep every page.
  await page.goto(`${s.site}#edit`);
  await page.evaluate(async (k) => { await nc.ready; await nc.login("nsec", { key: k }); }, s.nsec);
  await page.waitForFunction(() => nc._manifest);
  const saved = await page.evaluate(async () => {
    const p = document.querySelector(".tagline") || document.querySelector("[editable]");
    p.textContent = p.textContent + " Saved from the browser after the agent.";
    nc.dirty = true;
    const r = await nc.save();
    return { hash: r.hash, paths: Object.keys(nc.manifestPaths(r.manifest)) };
  });
  t("a save in the browser still works", saved.hash, JSON.stringify(saved));
  t("and keeps every page in the site", saved.paths.includes("/about.html") && saved.paths.includes("/index.html"), saved.paths.join(" "));
  t("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}

for (const [name, pass, detail] of out) console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail && !pass ? "   (" + detail + ")" : ""}`);
console.log(`\n${out.filter((r) => r[1]).length}/${out.length} passed`);
process.exit(out.every((r) => r[1]) ? 0 : 1);
