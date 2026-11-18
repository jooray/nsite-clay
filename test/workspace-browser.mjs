// Workspace pages in a browser, on a devnet this test starts for itself: two
// pages of one workspace, each opened from its own link, edited and saved in
// the browser, and one deleted from its own panel, without the other page or
// the workspace noticing anything.
//
//   node test/workspace-browser.mjs
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nip19 } from "nostr-tools";
import WebSocket from "ws";
import { localPorts } from "./local-ports.mjs";

const S = mkdtempSync(join(tmpdir(), "nc-wsb-"));
const [RP, BP, GP] = await localPorts(3);
const devnet = spawn("node", ["tools/devnet.mjs", "--quiet"], { stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: RP, DEVNET_BLOSSOM_PORT: BP, DEVNET_GATEWAY_PORT: GP } });
process.on("exit", () => { try { devnet.kill(); } catch {} try { rmSync(S, { recursive: true, force: true }); } catch {} });
await new Promise((r) => setTimeout(r, 700));
const env = { ...process.env, NSITE_ARTIFACTS_HOME: S + "/home", NSITE_ARTIFACTS_RELAYS: "ws://127.0.0.1:" + RP,
  NSITE_ARTIFACTS_SERVERS: "http://127.0.0.1:" + BP, NSITE_ARTIFACTS_GATEWAY: "http://{host}.localhost:" + GP,
  NSITE_ARTIFACTS_RUNTIME: process.cwd(), NSITE_ARTIFACTS_SETTLE_MS: "300" };
const A = (...args) => { try { return JSON.parse(execFileSync("node", ["skills/nsite-artifacts/scripts/artifact.mjs", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); } catch (e) { return { error: String(e.stderr || e.message).trim() }; } };
const out = []; const t = (name, pass, detail = "") => { out.push([name, !!pass, detail]); console.log((pass ? "ok   " : "FAIL ") + name + (pass ? "" : "  " + String(detail).slice(0, 400))); };
const blobStatus = async (hash) => (await fetch(`http://127.0.0.1:${BP}/${hash}`)).status;
const manifest = (pk) => new Promise((r) => {
  const ws = new WebSocket("ws://127.0.0.1:" + RP); const got = [];
  ws.on("open", () => ws.send(JSON.stringify(["REQ", "m", { kinds: [15128], authors: [pk] }])));
  ws.on("message", (m) => { const d = JSON.parse(String(m)); if (d[0] === "EVENT") got.push(d[2]); else { ws.close(); r(got.sort((a, b) => b.created_at - a.created_at)[0]); } });
});
const paths = (m) => Object.fromEntries((m?.tags || []).filter((x) => x[0] === "path").map((x) => [x[1], x[2]]));

const init = A("workspace", "init");
t("a workspace is made", /^npub1/.test(init.npub || ""), JSON.stringify(init));
const pk = nip19.decode(init.npub).data;
A("list-page", "--title=Alpha", "--item=Milk", "--item=Bread", "--out=" + S + "/a.html");
A("list-page", "--title=Beta", "--item=Nails", "--item=Glue", "--out=" + S + "/b.html");
const a = A("create", S + "/a.html", "--workspace", "--edit=link", "--expires=30d");
const b = A("create", S + "/b.html", "--workspace", "--edit=link", "--expires=30d");
t("two pages in it", a.workspace === "default" && b.workspace === "default" && a.url !== b.url, JSON.stringify([a, b]));
const pathA = `/${a.id}/index.html`, pathB = `/${b.id}/index.html`;

const browser = await chromium.launch({ channel: "chrome" });
const errors = [];
const open = async (link) => {
  const p = await (await browser.newContext()).newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(link);
  await p.waitForFunction(() => (document.documentElement.getAttribute("nc:ready") === "true" && !document.documentElement.hasAttribute("nc:sealed")) || document.documentElement.hasAttribute("nc:locked"), null, { timeout: 15000 });
  return p;
};

const pa = await open(a.editLink);
t("a page's edit link opens it, editable", await pa.evaluate(() => nc.isOwner && nc.sealed.canEdit && document.querySelectorAll(".item").length === 2));
t("the page knows where it lives", await pa.evaluate((p) => nc.cfg.path === p, pathA));
const m0 = await manifest(pk);
const aBefore = paths(m0)[pathA], bBefore = paths(m0)[pathB];
await pa.locator(".item", { hasText: "Milk" }).locator("input").check();
await pa.waitForFunction(() => document.querySelector(".state").textContent === "Saved.", null, { timeout: 30000 }).catch(() => {});
const m1 = await manifest(pk);
t("a save in the browser changes that page's path", paths(m1)[pathA] && paths(m1)[pathA] !== aBefore, JSON.stringify(paths(m1)));
t("and leaves the other page as it was", paths(m1)[pathB] === bBefore);
t("puts no expiry on the shared manifest", !m1.tags.some((x) => x[0] === "expiration"), JSON.stringify(m1.tags));
t("and retires what it replaced under its own path", m1.tags.some((x) => x[0] === "retired" && x[3] === pathA), JSON.stringify(m1.tags.filter((x) => x[0] === "retired")));
const rd = A("read", a.id);
t("the agent reads the tick", rd.changed && JSON.stringify(rd.changes) === JSON.stringify([{ change: "checked", line: "Milk" }]), JSON.stringify(rd));
const links = await pa.evaluate(() => nc.sealed.links());
t("the page's own panel hands out both halves of its edit link", links.edit === a.editLink && links.read === a.readLink, JSON.stringify(links).replace(/=[A-Za-z0-9_-]{43}/g, "=…"));

// Another page's read key does not open this one.
const wrong = await open(`${b.url}#k=${a.readLink.split("#k=")[1]}`);
t("one page's read key does not open the other", await wrong.evaluate(() => document.documentElement.getAttribute("nc:locked")) === "wrong-key");
// An edit key alone, without the page's read key, does not open it either.
const half = await open(a.editLink.split("&k=")[0]);
t("the signing key alone does not open a workspace page", await half.evaluate(() => document.documentElement.getAttribute("nc:locked")) === "wrong-key");

const pb = await open(b.editLink);
t("the other page opens from its own link", await pb.evaluate(() => nc.sealed.canEdit && document.querySelectorAll(".item").length === 2));
await pb.locator(".item", { hasText: "Glue" }).locator("input").check();
await pb.waitForFunction(() => document.querySelector(".state").textContent === "Saved.", null, { timeout: 30000 }).catch(() => {});
const m2 = await manifest(pk);
t("its save keeps the first page's latest version", paths(m2)[pathA] === paths(m1)[pathA] && paths(m2)[pathB] !== bBefore);

// Delete one page from its own panel.
const served = paths(m2)[pathA];
await pa.goto(a.url + "?fresh=1" + a.editLink.slice(a.url.length));
await pa.waitForFunction(() => document.documentElement.getAttribute("nc:ready") === "true", null, { timeout: 15000 });
await pa.click("#nc-sealed-menu"); await pa.waitForSelector(".nc-ui [data-delete]");
await pa.click(".nc-ui [data-delete]");
await pa.waitForFunction(() => document.querySelectorAll("dialog.nc-ui").length === 2);
await pa.evaluate(() => [...document.querySelectorAll("dialog.nc-ui")].at(-1).querySelector(".nc-primary").click());
await pa.waitForFunction(() => document.documentElement.hasAttribute("nc:deleted"), null, { timeout: 30000 }).catch(() => {});
const m3 = await manifest(pk);
t("deleting from the page takes out only its path", !paths(m3)[pathA] && paths(m3)[pathB] === paths(m2)[pathB] && paths(m3)["/nsite-clay.js"], JSON.stringify(paths(m3)));
t("its file is gone, the other page's is not", await blobStatus(served) === 404 && await blobStatus(paths(m3)[pathB]) === 200);
t("the gateway still serves the other page", (await fetch(b.url)).status === 200 && (await fetch(a.url)).status === 404);
const st = A("status", a.id);
t("the agent learns that page was deleted from the page", !!st.deleted && st.deletedBy === "page" && !st.published, JSON.stringify(st));
const wv = A("workspace", "verify");
t("and the workspace is healthy", wv.ok === true, JSON.stringify(wv));

t("no page errors", errors.filter((x) => !/Content Security Policy|ERR_|Failed to load resource|violates/.test(x)).length === 0, errors.join(" | "));
await browser.close();
const bad = out.filter((x) => !x[1]);
console.log(`\n${out.length - bad.length}/${out.length} passed`);
devnet.kill();
process.exit(bad.length ? 1 : 0);
