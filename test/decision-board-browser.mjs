#!/usr/bin/env node
// decision-board in a real browser with the real runtime (dist/nsite-clay.js).
// The regression this guards (C1 in the 0.2 audit): whatever the owner saves must still hold every
// control and all long-form context when it is opened again. The runtime drops nc:chrome elements
// from a save, so the page may mark only script-drawn UI that way.
//   node test/decision-board-browser.mjs [--shots=<dir>]
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFields } from "../skills/decision-board/scripts/lib/readback.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SKILL = join(ROOT, "skills/decision-board");
const shotsArg = process.argv.find((a) => a.startsWith("--shots="));
let fail = 0;
const check = (ok, what) => { if (!ok) { fail++; console.log(`FAIL  ${what}`); } };

let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("decision-board browser: playwright is not installed, skipped"); process.exit(0); }
const runtime = join(ROOT, "dist/nsite-clay.js");
if (!existsSync(runtime)) { console.log("decision-board browser: dist/nsite-clay.js missing (npm run build), skipped"); process.exit(0); }

const tmp = mkdtempSync(join(tmpdir(), "db-browser-"));
cpSync(join(SKILL, "assets/examples"), tmp, { recursive: true });
for (const [src, out] of [["audit.json", "audit.html"], ["cover-image.json", "cover.html"]]) {
  const r = spawnSync(process.execPath, [join(SKILL, "scripts/board.mjs"), "build", join(tmp, src), join(tmp, out)], { encoding: "utf8" });
  check(r.status === 0, `build ${src}: ${r.stderr}`);
}
// What create would add: the runtime script.
for (const f of ["audit.html", "cover.html"]) {
  const p = join(tmp, f);
  const h = readFileSync(p, "utf8");
  check(!/<[^>]+\snc:chrome[\s>=]/.test(h.replace(/<script>[\s\S]*?<\/script>/g, "")), `${f}: no nc:chrome in the static markup`);
  writeFileSync(p, h.replace("</head>", '<script src="/nsite-clay.js"></script>\n</head>'));
}

const rt = readFileSync(runtime);
const srv = createServer((q, s) => {
  const p = decodeURIComponent(q.url.split("?")[0]);
  if (p === "/nsite-clay.js") { s.setHeader("content-type", "text/javascript"); return s.end(rt); }
  try { s.setHeader("content-type", "text/html; charset=utf-8"); s.end(readFileSync(join(tmp, p.slice(1)))); } catch { s.statusCode = 404; s.end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${srv.address().port}`;

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); }
catch (e) { console.log(`decision-board browser: Chrome could not start (${e.message.split("\n")[0]}), skipped`); srv.close(); rmSync(tmp, { recursive: true, force: true }); process.exit(0); }

async function open(file) {
  const pg = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  pg.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await pg.goto(`${base}/${file}`);
  await pg.waitForFunction(() => document.querySelector("[data-slot=glance]")?.textContent, null, { timeout: 10000 });
  await pg.waitForTimeout(500);
  return { pg, errors };
}

{
  const { pg, errors } = await open("audit.html");
  check(await pg.evaluate(() => typeof window.nc) === "object", "the runtime loaded");
  check(await pg.locator("button.take").count() >= 2, "Take recommended is drawn");
  check(/3 to decide/.test(await pg.locator("[data-slot=glance]").textContent()), "the glance line counts open cards");
  check(/1 to test/.test(await pg.locator("[data-slot=glance]").textContent()), "the glance line counts tests");
  check(/not watching/.test(await pg.locator("[data-slot=watch]").textContent()), "no watch: the page says so");
  await pg.locator("#i-token-expiry button.take").click();
  check(await pg.locator("#i-token-expiry input[value='30d']").isChecked(), "Take recommended checks the recommended option");
  check(await pg.locator("#i-token-expiry button.clear").count() === 1, "Clear appears once something is checked");
  check(await pg.locator("#i-token-expiry button.take").count() === 0, "Take recommended goes away when it is taken");
  await pg.locator("#i-export-format details.note summary").click();
  await pg.locator("textarea[name=n-export-format]").fill("also CSV later & <b>");
  await pg.locator("input[name=t-sync-two-phones][value=fail]").check();
  await pg.locator("#agent-instructions").fill("verify the migration on a copy first");
  if (shotsArg) await pg.screenshot({ path: join(shotsArg.slice(8), "audit.png"), fullPage: true });
  check(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal scroll at phone width");
  const saved = await pg.evaluate(() => nc.getHTML());
  writeFileSync(join(tmp, "saved.html"), saved);
  check(!/nc:chrome/.test(saved.replace(/<script>[\s\S]*?<\/script>/g, "")), "the save holds no chrome");
  check((saved.match(/<details class="ctx"/g) || []).length === 2, "the save keeps the long-form context of both choice cards");
  check(/data-rec="30d"/.test(saved), "the save keeps the recommendation data");
  const f = readFields(saved);
  check(f.checked["c-token-expiry"]?.[0] === "30d", `the save holds the choice (${JSON.stringify(f.checked["c-token-expiry"])})`);
  check(f.text["n-export-format"] === "also CSV later & <b>", `the note reads back with its non-breaking space as a space (${JSON.stringify(f.text["n-export-format"])})`);
  check(f.checked["t-sync-two-phones"]?.[0] === "fail", "the test result reads back");
  check(errors.length === 0, `no page errors: ${errors.join(" | ")}`);
  await pg.close();
}
{
  const { pg, errors } = await open("saved.html");
  check(await pg.locator("button.take").count() >= 1, "reopened save: Take recommended is drawn again");
  check(await pg.locator("button.clear").count() === 1, "reopened save: Clear is drawn for the decided card");
  check(await pg.locator("details.ctx").count() === 2, "reopened save: context is there");
  check(/2 to decide/.test(await pg.locator("[data-slot=glance]").textContent()), "reopened save: counter is right");
  check(await pg.locator("#agent-instructions").inputValue() === "verify the migration on a copy first", "reopened save: the command box text is there");
  check(errors.length === 0, `reopened save: no page errors: ${errors.join(" | ")}`);
  await pg.close();
}
{
  const { pg, errors } = await open("cover.html");
  check(await pg.locator(".opts.grid img").count() === 3, "cover board: three pictures in a grid");
  await pg.locator(".opts.grid label.opt").nth(1).click();
  check(await pg.locator("input[name=c-cover]:checked").count() === 1, "cover board: a tap on a picture selects it");
  await pg.locator("textarea[name=n-anything-else]").fill("shorter intro");
  check(/1 to decide/.test(await pg.locator("[data-slot=glance]").textContent()), "cover board: a written answer counts as decided");
  check(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "cover board: no horizontal scroll");
  if (shotsArg) await pg.screenshot({ path: join(shotsArg.slice(8), "cover.png"), fullPage: true });
  check(errors.length === 0, `cover board: no page errors: ${errors.join(" | ")}`);
  await pg.close();
}
{
  // Opened from disk without the runtime, the buttons still work and nothing throws.
  writeFileSync(join(tmp, "bare.html"), readFileSync(join(tmp, "audit.html"), "utf8").replace('<script src="/nsite-clay.js"></script>', ""));
  const { pg, errors } = await open("bare.html");
  await pg.locator("#i-token-expiry button.take").click();
  check(await pg.locator("#i-token-expiry input[value='30d']").isChecked(), "without the runtime: Take recommended works");
  check(errors.length === 0, `without the runtime: no page errors: ${errors.join(" | ")}`);
  await pg.close();
}
{
  // A watch in the future, then one in the past.
  const d = JSON.parse(readFileSync(join(tmp, "audit.json"), "utf8"));
  d.watch = { until: new Date(Date.now() + 3600e3).toISOString(), everyMin: 10 };
  writeFileSync(join(tmp, "w.json"), JSON.stringify(d));
  spawnSync(process.execPath, [join(SKILL, "scripts/board.mjs"), "build", join(tmp, "w.json"), join(tmp, "w.html")]);
  d.watch.until = "2020-01-01T00:00:00Z";
  writeFileSync(join(tmp, "w2.json"), JSON.stringify(d));
  spawnSync(process.execPath, [join(SKILL, "scripts/board.mjs"), "build", join(tmp, "w2.json"), join(tmp, "w2.html")]);
  let { pg } = await open("w.html");
  check(/checks this page every 10 min until/.test(await pg.locator("[data-slot=watch]").textContent()), "watch line shows the deadline");
  await pg.close();
  ({ pg } = await open("w2.html"));
  check(/checking ended/i.test(await pg.locator("[data-slot=watch]").textContent()), "watch line says when checking ended");
  await pg.close();
}

await browser.close();
srv.close();
rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `${fail} decision-board browser check(s) failed` : "decision-board browser: saved pages keep their controls and context.");
process.exit(fail ? 1 : 0);
