// A gateway that goes on serving an old manifest, and a sealed page that was
// changed under it. nsite.lol was measured keeping a manifest for hours, so
// the page's own address hands back the shell being replaced. The tab learns
// of the newer version from the relays and offers to reload; a reload that
// only asked the gateway again opened the old page under the same notice,
// every time. This checks that Reload, a plain reload and a reader's automatic
// reload all end on the newer version, fetched from Blossom by its hash, and
// that the page then behaves as the current one: no notice, and its saves go
// through.
//
// Real Chrome, on a devnet this test starts with its gateway's manifest cache
// switched on (DEVNET_GATEWAY_CACHE_MS), and the artifact tool as the agent.
//
//   node test/stale-gateway.mjs
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { localPorts } from "./local-ports.mjs";

const S = mkdtempSync(join(tmpdir(), "nc-stalegw-"));
const [RP, BP, GP] = await localPorts(3);
const devnet = spawn("node", ["tools/devnet.mjs", "--quiet"], { stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: RP, DEVNET_BLOSSOM_PORT: BP, DEVNET_GATEWAY_PORT: GP,
    DEVNET_GATEWAY_CACHE_MS: String(60 * 60 * 1000) } });
process.on("exit", () => { try { devnet.kill(); } catch {} try { rmSync(S, { recursive: true, force: true }); } catch {} });
await new Promise((r) => setTimeout(r, 700));
const env = { ...process.env, NSITE_ARTIFACTS_HOME: S + "/home", NSITE_ARTIFACTS_RELAYS: "ws://127.0.0.1:" + RP,
  NSITE_ARTIFACTS_SERVERS: "http://127.0.0.1:" + BP, NSITE_ARTIFACTS_GATEWAY: "http://{host}.localhost:" + GP,
  NSITE_ARTIFACTS_RUNTIME: process.cwd(), NSITE_ARTIFACTS_SETTLE_MS: "300" };
const A = (...args) => { try { return JSON.parse(execFileSync("node", ["skills/nsite-artifacts/scripts/artifact.mjs", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); } catch (e) { return { error: String(e.stderr || e.message).trim() }; } };
const sha = (text) => createHash("sha256").update(text).digest("hex");
const out = []; const t = (name, pass, detail = "") => { out.push([name, !!pass]); console.log((pass ? "ok   " : "FAIL ") + name + (pass ? "" : "  " + String(detail).slice(0, 400))); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The agent changes one item's text.
const change = (id, from, to) => {
  A("read", id, "--as=html", "--out=" + S + "/cur.html");
  writeFileSync(S + "/cur.html", readFileSync(S + "/cur.html", "utf8").replace(from, to));
  return A("update", id, S + "/cur.html");
};

A("list-page", "--title=Shopping", "--item=Milk", "--item=Bread", "--item=Eggs", "--out=" + S + "/list.html");
const made = A("create", S + "/list.html", "--edit=link", "--expires=30d");
t("a sealed page is published", made.editLink && made.gateway === "current", JSON.stringify(made));

const browser = await chromium.launch({ channel: "chrome" });
const errors = [];
const opened = (pg) => pg.waitForFunction(() => document.documentElement.getAttribute("nc:ready") === "true" &&
  !document.documentElement.hasAttribute("nc:sealed"), null, { timeout: 20000 });
const items = (pg) => pg.evaluate(() => [...document.querySelectorAll(".item")].map((x) => x.textContent.replace(/×/g, "").trim()).join(", "));
const banner = (pg) => pg.evaluate(() => [...document.querySelectorAll("[nc\\:chrome][role=status]")].find((b) => b.querySelector("button"))?.textContent || "");
const outdated = (pg) => pg.evaluate(() => document.documentElement.hasAttribute("nc:outdated"));
const newPage = async () => {
  const pg = await (await browser.newContext()).newPage();
  pg.on("pageerror", (e) => errors.push(e.message));
  pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return pg;
};

try {
  const p = await newPage();
  let navigations = 0;
  p.on("framenavigated", (f) => { if (f === p.mainFrame()) navigations++; });
  await p.goto(made.editLink); await opened(p);
  t("the edit link opens it", await items(p) === "Milk, Bread, Eggs", await items(p));
  await wait(15500);             // past the moment a page counts as just opened

  // The agent changes the page. The gateway goes on serving the old shell.
  const up = change(made.id, "Bread", "Butter");
  t("the agent's change lands, and the gateway is behind", up.verified && up.gateway === "older", JSON.stringify(up));
  const latest = () => p.evaluate(() => nc.manifestPaths(nc._manifest)[nc.cfg.path]);
  await p.waitForFunction(() => document.documentElement.hasAttribute("nc:outdated"), null, { timeout: 15000 }).catch(() => {});
  const newHash = await latest();
  t("the gateway really serves the old shell (what this is about)", newHash && sha(await (await fetch(made.url)).text()) !== newHash, newHash);

  await p.waitForFunction(() => document.documentElement.hasAttribute("nc:outdated"), null, { timeout: 15000 }).catch(() => {});
  t("the open tab notices", await outdated(p) && /Someone changed this page/.test(await banner(p)), `${await outdated(p)} [${await banner(p)}] ${await p.evaluate(() => document.querySelectorAll("[role=status]").length)}`);
  await p.locator("[nc\\:chrome][role=status] button").click();
  await p.waitForFunction(() => /Butter/.test(document.body?.innerText), null, { timeout: 20000 }).catch(() => {});
  await opened(p);
  t("Reload shows the newer version though the gateway still has the old one", await items(p) === "Milk, Butter, Eggs", await items(p));
  await wait(1500);
  t("and no notice is left", !(await outdated(p)) && !(await banner(p)), await banner(p));
  t("the tab knows it shows the latest", await p.evaluate(() => nc._servedHash) === newHash && await latest() === newHash);
  await wait(20000);
  t("nor comes back later", !(await outdated(p)) && !(await banner(p)) && await items(p) === "Milk, Butter, Eggs", await banner(p));
  t("one reload, not a loop", navigations === 2, navigations);

  // The page opened from Blossom is the current one, so its own save goes through.
  await p.locator(".item", { hasText: "Milk" }).locator("input").check();
  await p.waitForFunction(() => document.querySelector(".state")?.textContent === "Saved.", null, { timeout: 30000 }).catch(() => {});
  t("a save from it goes through", await p.evaluate(() => document.querySelector(".state")?.textContent) === "Saved.",
    await p.evaluate(() => document.querySelector(".state")?.textContent));
  const rd = A("read", made.id);
  t("and the agent reads the tick", rd.changed && JSON.stringify(rd.changes) === JSON.stringify([{ change: "checked", line: "Milk" }]), JSON.stringify(rd));

  // A plain reload: the address still serves the first shell.
  await p.reload(); await opened(p);
  await p.waitForFunction(() => /Butter/.test(document.body?.innerText) && document.querySelector(".item input")?.checked, null, { timeout: 20000 }).catch(() => {});
  await opened(p);
  t("a plain reload ends on the newest version too", await items(p) === "Milk, Butter, Eggs" &&
    await p.evaluate(() => document.querySelector(".item input").checked), await items(p));
  await wait(1500);
  t("without a notice", !(await outdated(p)) && !(await banner(p)), await banner(p));

  // A reader is not asked: the page follows by itself, and once.
  const r = await newPage();
  let readerNav = 0;
  r.on("framenavigated", (f) => { if (f === r.mainFrame()) readerNav++; });
  await r.goto(made.readLink); await opened(r);
  await r.waitForFunction(() => /Butter/.test(document.body?.innerText), null, { timeout: 20000 }).catch(() => {});
  t("a reader opening the page gets the newest version", /Butter/.test(await items(r)), await items(r));
  await wait(15500);
  const up2 = change(made.id, "Eggs", "Eggs and flour");
  t("a second change lands with the gateway still behind", up2.verified && up2.gateway === "older", JSON.stringify(up2));
  await r.waitForFunction(() => /flour/.test(document.body?.innerText), null, { timeout: 30000 }).catch(() => {});
  await opened(r);
  t("the reader's page follows by itself", /Eggs and flour/.test(await items(r)), await items(r) + " | " + await banner(r));
  await wait(12000);
  t("and stops there, with no notice and no further reloads", !(await banner(r)) && readerNav === 3 && /flour/.test(await items(r)), `${readerNav} ${await banner(r)}`);

  // When nothing can be had, it says so and stays put.
  const failed = await p.evaluate(async () => {
    const steps = [];
    const r = await nc.showLatest("0".repeat(64), { waitMs: 2500, onStatus: (s) => steps.push(s.step) });
    return { r, steps, text: document.body?.innerText.length > 0 };
  });
  t("a version no server has ends in false, after saying it waited", failed.r === false && failed.steps.includes("waiting") &&
    failed.steps.at(-1) === "failed" && failed.text, JSON.stringify(failed));
} catch (e) {
  t("ran to the end", false, e.stack);
}

// The shell's policy refuses whatever is not the page's own; the 404 is the favicon.
t("no page errors", errors.filter((x) => !/Content Security Policy|ERR_|Failed to load resource|violates/.test(x)).length === 0, errors.join(" | "));
await browser.close();
const bad = out.filter((x) => !x[1]);
console.log(`\n${out.length - bad.length}/${out.length} passed`);
devnet.kill();
process.exit(bad.length ? 1 : 0);
