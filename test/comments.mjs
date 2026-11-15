// Comments on an agent's page, end to end on a devnet this test starts for
// itself: a person selects words in a browser and comments, the agent finds the
// comment and where it is, answers it and resolves it, the person sees the
// answer, and an edit made with the ordinary editing tools shows up as a diff.
//
// Run: node test/comments.mjs
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPorts } from "./local-ports.mjs";

const S = mkdtempSync(join(tmpdir(), "nc-comments-"));
const [RP, BP, GP] = await localPorts(3);
const devnet = spawn("node", ["tools/devnet.mjs", "--quiet"], { stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: RP, DEVNET_BLOSSOM_PORT: BP, DEVNET_GATEWAY_PORT: GP } });
process.on("exit", () => { try { devnet.kill(); } catch {} try { rmSync(S, { recursive: true, force: true }); } catch {} });
await new Promise((r) => setTimeout(r, 700));
const env = { ...process.env, NSITE_ARTIFACTS_HOME: S + "/home", NSITE_ARTIFACTS_RELAYS: "ws://127.0.0.1:" + RP,
  NSITE_ARTIFACTS_SERVERS: "http://127.0.0.1:" + BP, NSITE_ARTIFACTS_GATEWAY: "http://{host}.localhost:" + GP, NSITE_ARTIFACTS_RUNTIME: process.cwd() };
// The one-file build the skill ships.
const A = (...args) => { try { return JSON.parse(execFileSync("node", ["skills/nsite-artifacts/scripts/artifact.mjs", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch (e) { return { error: String(e.stderr || e.message).trim() }; } };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 250)); } };
const out = []; const t = (name, pass, detail = "") => { out.push([name, !!pass, detail]); console.log((pass ? "ok   " : "FAIL ") + name + (pass ? "" : "   " + String(detail).slice(0, 400))); };

A("list-page", "--title=Shopping", "--note=For Saturday", "--item=Milk", "--item=Bread", "--item=Eggs", "--out=" + S + "/list.html");
const made = A("create", S + "/list.html", "--edit=link", "--title=Shopping", "--expires=30d");
t("create works", !!made.editLink, JSON.stringify(made));
t("the page asks for comments", /<html[^>]*\bnc:comments\b/.test(A("read", made.id, "--as=html", "--peek").html || ""));
const readOnly = A("create", S + "/list.html", "--edit=none", "--title=Fixed");
t("a page nobody can edit does not", !/\bnc:comments\b/.test(A("read", readOnly.id, "--as=html", "--peek").html || ""));
A("delete", readOnly.id);

// A page with nothing in it to edit, made with an edit link: the agent is told when it is made.
writeFileSync(S + "/plain.html", '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Plain</title></head><body><h1>A report</h1><p>Words nobody marked editable.</p></body></html>');
const plain = A("create", S + "/plain.html", "--edit=link", "--title=Plain", "--expires=1d");
t("a page with nothing to edit says so when it is made", /no editable text/.test((plain.warnings || []).join(" ")) && /leave comments/.test((plain.warnings || []).join(" ")), JSON.stringify(plain.warnings));
t("and with comments off it says the edit link does nothing", /lets nobody change anything/.test((A("create", S + "/plain.html", "--edit=link", "--no-comments", "--expires=1d").warnings || []).join(" ")));
t("a page with editable text says nothing", !(made.warnings || []).some((w) => /no editable/.test(w)));
A("delete", plain.id);

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext();
const p = await ctx.newPage();
const errors = []; p.on("pageerror", (e) => errors.push(e.message));
const ready = (pg) => pg.waitForFunction(() => document.documentElement.getAttribute("nc:ready") === "true" && !document.documentElement.hasAttribute("nc:locked"), null, { timeout: 20000 });
const saved = (pg) => pg.waitForFunction(() => nc.status === "saved" && !nc.dirty, null, { timeout: 30000 }).catch(() => {});

await p.goto(made.editLink); await ready(p);
await p.waitForSelector("#nc-comments-btn");
t("whoever can edit sees the Comments button", await p.locator("#nc-comments-btn").isVisible());

// Words, selected the way a person does, and a comment on them.
const select = (text) => p.evaluate((word) => {
  const el = [...document.querySelectorAll(".item .text")].find((e) => e.textContent === word);
  const r = document.createRange(); r.selectNodeContents(el.firstChild);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}, text);
// Signed in as somebody (not through the page's own edit link): the author is their profile name.
await p.evaluate(() => {
  nc.comments.identity = () => "d".repeat(64);
  const real = nc.pool.querySync.bind(nc.pool);
  nc.pool.querySync = async (relays, filter, ...rest) => filter.kinds?.[0] === 0 ? [{ created_at: 1, content: JSON.stringify({ name: "Jana Test" }) }] : real(relays, filter, ...rest);
});
await select("Milk");
await p.waitForSelector("#nc-comments-bubble");
t("selecting words offers to comment on them", await p.locator("#nc-comments-bubble").isVisible());
await p.click("#nc-comments-bubble");
await p.waitForSelector(".ncc-form textarea");
t("the form has no name field", await p.locator(".ncc-form input").count() === 0);
t("and a roomy box for the comment", (await p.locator(".ncc-form textarea").boundingBox()).height >= 120);
await p.fill(".ncc-form textarea", "Oat milk, please, not cow's.");
await p.click(".ncc-form button[type=submit]");
t("the words are marked on the page", await p.locator("mark[nc\\:c]").count() === 1 && (await p.locator("mark[nc\\:c]").textContent()) === "Milk");
t("the button counts it", (await p.locator("#nc-comments-btn b").textContent()) === "1");
await until(async () => A("comments", made.id, "--peek").open === 1);

const c1 = A("comments", made.id);
t("the agent finds it: who, what and the words it is about", c1.open === 1 && c1.comments[0].by === "Jana Test" && /^npub1/.test(c1.comments[0].npub || "") && c1.comments[0].text === "Oat milk, please, not cow's." && c1.comments[0].quote === "Milk", JSON.stringify(c1));
t("and where it is on the page", c1.comments[0].anchored && /Milk/.test(c1.comments[0].where?.block || "") && c1.comments[0].where.heading === "Shopping", JSON.stringify(c1.comments[0].where));
t("it is new the first time", c1.comments[0].news === "new");
const id1 = c1.comments[0].id;
t("the second look says nothing is new", A("comments", made.id).comments[0].news === undefined);
const rd = A("read", made.id);
t("the page's own text does not carry the comments", !/Oat milk/.test(rd.text) && rd.comments?.open === 1, JSON.stringify(rd).slice(0, 300));

// A comment on a part of the page, which the person picks.
await p.evaluate(() => nc.comments.add({ element: document.querySelector("h1"), text: "A friendlier title.", by: "Jana" }));
await until(async () => A("comments", made.id, "--peek").open === 2);
const c2 = A("comments", made.id);
const second = c2.comments.find((c) => c.text === "A friendlier title.");
t("a picked part of the page is found too", c2.open === 2 && second?.anchored && second.quote === "Shopping", JSON.stringify(c2.comments.map((c) => c.quote)));

// The picker, through the panel.
await p.click("#nc-comments-btn");
await p.waitForSelector(".ncc-panel .ncc-item");
t("the panel lists both", await p.locator(".ncc-panel .ncc-item").count() === 2);
await p.click(".ncc-panel .ncc-tools .ncc-b:nth-child(2)");
await p.waitForSelector(".ncc-pick", { state: "attached" });
await p.locator(".item", { hasText: "Eggs" }).locator(".text").click({ position: { x: 4, y: 4 } });
await p.waitForSelector(".ncc-form textarea");
await p.fill(".ncc-form textarea", "Free range.");
await p.click(".ncc-form button[type=submit]");
await until(async () => A("comments", made.id, "--peek").open === 3);
const c3 = A("comments", made.id);
t("picking a row comments on that row", c3.comments.some((c) => c.text === "Free range." && /Eggs/.test(c.where?.block || "")), JSON.stringify(c3.comments.map((c) => [c.text, c.where?.block])));

// The agent answers and resolves the first.
const resp = A("reply", made.id, id1, "--text=Changed to oat milk.", "--resolve", "--by=Claude");
t("the agent replies and resolves", resp.state === "resolved" && resp.replies === 1, JSON.stringify(resp));
const html1 = A("read", made.id, "--as=html", "--peek").html;
t("the highlight is taken off the words", !/<mark\b[^>]*nc:c="/.test(html1) && /Milk/.test(html1));
t("the thread is kept, with the reply", /nc:reply[^>]*>Changed to oat milk\./.test(html1));
const all = A("comments", made.id, "--all", "--peek");
t("--all shows the resolved one with the reply", all.resolved === 1 && all.comments.find((c) => c.id === id1)?.replies[0].by === "Claude");
t("by default only open ones", A("comments", made.id, "--peek").comments.every((c) => c.state === "open"));

// The person sees it.
await p.reload(); await ready(p);
await p.waitForSelector("#nc-comments-btn");
await p.click("#nc-comments-btn");
const panelText = await p.locator(".ncc-panel").innerText();
t("the person sees the answer and that it is resolved", /Changed to oat milk\./.test(panelText) && /Resolved/.test(panelText), panelText);
// Reopening puts the highlight back on the words.
await p.locator('.ncc-item[data-state="resolved"] .ncc-acts .ncc-b:nth-child(2)').click();
t("reopening highlights the words again", await p.locator('mark[nc\\:c]').filter({ hasText: "Milk" }).count() === 1);
await until(async () => A("comments", made.id, "--peek").open === 3);

// A change made with the ordinary editing tools: ticking a box, retyping a word.
await p.evaluate(() => nc.comments.resolve(document.querySelectorAll("article[nc\\:comment]")[1].getAttribute("nc:comment"), true));
await p.locator(".item", { hasText: "Bread" }).locator("input").check();
await p.evaluate(() => { const e = [...document.querySelectorAll(".item .text")].find((x) => x.textContent === "Eggs"); e.textContent = "Eggs, a dozen"; nc.dirty = true; });
await p.evaluate(() => nc.save());
const df = A("diff", made.id);
t("diff says what a person did", df.changed && df.changes.some((c) => c.change === "checked" && c.line === "Bread") && df.changes.some((c) => c.line === "Eggs, a dozen" || /Eggs, a dozen/.test(c.line)), JSON.stringify(df.changes));
t("and shows the markup that changed", df.markup?.added > 0 && /\+.*checked/.test(df.markup.diff) && /Eggs, a dozen/.test(df.markup.diff), JSON.stringify(df.markup).slice(0, 500));
t("a state change is news", df.comments?.some((c) => c.news === "state"), JSON.stringify(df.comments?.map((c) => [c.id, c.news])));
t("a diff with nothing new is empty", A("diff", made.id).changed === false);
t("the page as last seen is kept to compare with", existsSync(S + "/home/seen/" + made.id + ".html"));
const withDiff = (() => { A("update", made.id, S + "/list.html", "--force"); return A("read", made.id, "--diff", "--peek"); })();
t("read --diff works against a copy the agent made itself", withDiff.changed === false || !!withDiff.diff);

// A phone: no mouse, so the selection settling is what offers the comment, the
// button sits at the bottom clear of the phone's own menu, and the form is at the top.
{
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const m = await mctx.newPage();
  await m.goto(made.editLink); await ready(m);
  await m.waitForSelector("#nc-comments-btn");
  await m.evaluate(() => {
    const el = [...document.querySelectorAll(".item .text")].find((e) => e.textContent.startsWith("Eggs"));
    const r = document.createRange(); r.selectNodeContents(el.firstChild);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await m.waitForSelector("#nc-comments-bubble", { timeout: 4000 }).catch(() => {});
  const bubble = await m.evaluate(() => { const b = document.getElementById("nc-comments-bubble"); if (!b) return null; const r = b.getBoundingClientRect(), sel = getSelection().getRangeAt(0).getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), below: Math.round(r.top - sel.bottom), inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }; });
  t("on a phone, selecting words offers the comment without a mouse", !!bubble);
  t("and the button sits under the selection, clear of the phone's drag handles, on screen", bubble?.inView && bubble.below >= 40, JSON.stringify(bubble));
  await m.tap("#nc-comments-bubble");
  await m.waitForSelector(".ncc-form textarea");
  const form = await m.evaluate(() => { const f = document.querySelector(".ncc-form"), r = f.getBoundingClientRect(); return { top: r.top, w: r.width, vw: innerWidth, font: getComputedStyle(f.querySelector("textarea")).fontSize }; });
  t("the form is at the top of the screen and wide", form.top < 40 && form.w > form.vw - 40, JSON.stringify(form));
  t("with 16px text, so the phone does not zoom in", form.font === "16px", form.font);
  await m.fill(".ncc-form textarea", "From the phone.");
  t("on a phone the box is bigger still", (await m.locator(".ncc-form textarea").boundingBox()).height >= 150);
  await m.tap(".ncc-form button[type=submit]");
  const fromPhone = await until(async () => A("comments", made.id, "--peek").comments.find((c) => c.text === "From the phone."));
  t("a comment made on a phone reaches the agent", !!fromPhone && /Eggs/.test(fromPhone.quote), JSON.stringify(fromPhone));
  t("and through the edit link it has no author, since nobody said who they are", fromPhone && fromPhone.by === "" && !fromPhone.npub, JSON.stringify(fromPhone));
  await mctx.close();
}

// A reader.
const r = await (await browser.newContext()).newPage();
await r.goto(made.readLink); await ready(r);
t("a reader has no button, and sees no highlights", await r.locator("#nc-comments-btn").count() === 0 && (await r.locator("mark[nc\\:c]").count() === 0 || await r.evaluate(() => getComputedStyle(document.querySelector("mark[nc\\:c]")).backgroundColor === "rgba(0, 0, 0, 0)")));

t("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
const bad = out.filter((x) => !x[1]);
console.log(`\n${out.length - bad.length}/${out.length} passed`);
devnet.kill();
process.exit(bad.length ? 1 : 0);
