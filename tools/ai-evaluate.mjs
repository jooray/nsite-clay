#!/usr/bin/env node
// An opt-in, paid quality run. Uses the same prompts, client and page preparation
// as the app. Ordinary npm test never invokes it or spends provider credit.
import { parseArgs } from "node:util";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
const { values } = parseArgs({ options: {
  list: { type: "boolean" }, live: { type: "boolean" }, case: { type: "string" },
  model: { type: "string" }, base: { type: "string" }, mode: { type: "string", default: "routstr" }, out: { type: "string" },
} });
const cases = JSON.parse(readFileSync(new URL("../test/ai-evaluation/cases.json", import.meta.url)));
if (values.list || !values.live) {
  console.log(cases.map((c) => `${c.id}: ${c.lang}, ${c.kind}, ${1 + (c.refinements?.length || 0)} request(s)`).join("\n"));
  console.log("\nTo run one paid case, set NSITE_AI_KEY and pass --live --case=<id> --model=<model-id>.");
  process.exit(0);
}
const task = cases.find((c) => c.id === values.case);
if (!task || !values.model || !process.env.NSITE_AI_KEY) throw new Error("Choose a case and model, and set NSITE_AI_KEY. Use --list to see cases.");
const out = resolve(values.out || join(tmpdir(), `nsite-ai-${task.id}-${Date.now()}`)); mkdirSync(out, { recursive: true });
let resultHTML = "";
const server = createServer((q, r) => {
  const path = new URL(q.url, "http://localhost").pathname;
  if (path === "/result.html") { r.setHeader("Content-Type", "text/html"); return r.end(resultHTML); }
  if (path === "/bench.svg" || path === "/tools.svg") {
    r.setHeader("Content-Type", "image/svg+xml");
    return r.end(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${path === "/bench.svg" ? "#996f3c" : "#3c6585"}"/><text x="40" y="240" fill="white" font-size="40">${path.slice(1, -4)}</text></svg>`);
  }
  if (path === "/") { r.setHeader("Content-Type", "text/html"); return r.end('<!doctype html><html nc:upgrade="off"><body><script src="/nsite-clay.js"></script></body></html>'); }
  const file = { "/nsite-clay.js": "dist/nsite-clay.js", "/nsite-clay-source.js": "dist/nsite-clay-source.js", "/nsite-clay-base.css": "templates/_shared/nsite-clay-base.css", "/nsite-clay-chrome.js": "templates/_shared/nsite-clay-chrome.js" }[path];
  if (!file) { r.writeHead(404); return r.end(); }
  r.setHeader("Content-Type", file.endsWith("css") ? "text/css" : "text/javascript"); r.end(readFileSync(file));
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const browser = await chromium.launch({ channel: "chrome" });
const records = [];
const report = { case: task.id, model: values.model, endpoint: values.base || "https://routstr.cypherpunk.today/v1", runAt: new Date().toISOString(), records };
const saveReport = () => writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
try {
  const page = await browser.newPage(); await page.routeWebSocket("**", (ws) => ws.close());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async (config) => { await nc.ready; nc.ai.client.configure(config); }, {
    mode: values.mode, base: values.base || "https://routstr.cypherpunk.today/v1", model: values.model, key: process.env.NSITE_AI_KEY,
  });
  const starting = task.fixture ? readFileSync(new URL(`../test/ai-evaluation/${task.fixture}`, import.meta.url), "utf8") : "";
  for (const [index, prompt] of [task.prompt, ...(task.refinements || [])].entries()) {
    const before = index ? resultHTML : starting;
    const result = await page.evaluate(async ({ before, prompt, lang }) => {
      const client = nc.ai.client;
      const balance = async () => {
        if (client.config.mode !== "routstr") return null;
        try { const value = await client.balance(); return { balance: Number(value.balance), reserved: Number(value.reserved || 0) }; } catch { return null; }
      };
      const initial = await balance(), start = performance.now();
      const html = before ? await nc.ai.refinePage(before, prompt, { lang }) : await nc.ai.buildPage(prompt, { lang });
      const elapsedMs = Math.round(performance.now() - start), final = await balance();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const had = new DOMParser().parseFromString(before, "text/html");
      return { html, elapsedMs, balanceBefore: initial, balanceAfter: final,
        text: doc.body.textContent, editable: doc.querySelectorAll("[editable]").length,
        pictures: [...doc.querySelectorAll("img")].map((i) => ({ id: i.id, src: i.getAttribute("src"), alt: i.alt })),
        lostPictures: [...had.querySelectorAll("img[src]")].filter((old) => doc.getElementById(old.id)?.getAttribute("src") !== old.getAttribute("src")).map((i) => i.id),
        brokenAnchors: [...doc.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute("href")).filter((h) => h.length > 1 && !doc.getElementById(h.slice(1))) };
    }, { before, prompt, lang: task.lang });
    resultHTML = result.html;
    writeFileSync(join(out, `version-${index + 1}.html`), result.html);
    const record = { version: index + 1, prompt, elapsedMs: result.elapsedMs,
      observedDebitSats: result.balanceBefore && result.balanceAfter ? (Number(result.balanceBefore.balance) - Number(result.balanceAfter.balance)) / 1000 : null,
      balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter, editableFields: result.editable,
      pictures: result.pictures, lostPictures: result.lostPictures, brokenAnchors: result.brokenAnchors,
      missingTerms: task.mustContain.filter((t) => !result.text.toLowerCase().includes(t.toLowerCase())),
      humanScores: { design: null, facts: null, mobile: null, editability: null, nextAction: null }, review: task.review };
    records.push(record);
    saveReport();
    const preview = await browser.newPage(); await preview.routeWebSocket("**", (ws) => ws.close());
    for (const width of [1440, 390]) {
      await preview.setViewportSize({ width, height: 900 });
      await preview.goto(`http://127.0.0.1:${server.address().port}/result.html`);
      record[`overflow${width}`] = await preview.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      await preview.screenshot({ path: join(out, `version-${index + 1}-${width}.png`), fullPage: true });
    }
    await preview.close();
    console.log(`Version ${index + 1}: ${result.elapsedMs}ms; observed debit ${record.observedDebitSats ?? "unavailable"} sats; missing terms ${record.missingTerms.length}.`);
  }
  saveReport();
  console.log(`Review HTML, screenshots and results.json in ${out}`);
} catch (e) {
  report.failure = e.message.replaceAll(process.env.NSITE_AI_KEY, "[key]"); saveReport();
  console.error(`${report.failure}\nPartial results: ${out}`); process.exitCode = 1;
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
