#!/usr/bin/env node
// Working on a site with more than one page: the Pages button and its list,
// moving to another page with unsaved work, the link dialog with the site's
// pages and the places on them, links that lead nowhere marked while editing,
// and a new page in this page's design, empty or written by AI.
//
// A three-page site is deployed with the real CLI to the devnet (a relay, a
// Blossom server and a gateway on this machine) and edited in the installed
// Chrome at its own address, the way an owner would. The AI is a mock: no
// request leaves this machine and nothing is paid for.
//
// Run: node test/multi-page.mjs     (NC_SHOTS=<dir> also saves screenshots)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { nip19, getPublicKey } from "nostr-tools";
import { localPorts } from "./local-ports.mjs";
import { mockAiAccount } from "./ai-account-fixture.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NSEC = "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y";
const NPUB = nip19.npubEncode(getPublicKey(nip19.decode(NSEC).data));
const SHOTS = process.env.NC_SHOTS || "";

const out = [];
const t = (name, pass, detail = "") => out.push([name, !!pass, detail]);

const [relayPort, blossomPort, gatewayPort] = await localPorts(3);
const RELAY = `ws://127.0.0.1:${relayPort}`;
const BLOSSOM = `http://127.0.0.1:${blossomPort}`;
const SITE = `http://${NPUB}.localhost:${gatewayPort}`;
const devnet = spawn(process.execPath, [join(ROOT, "tools/devnet.mjs"), "--quiet"], { stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: relayPort, DEVNET_BLOSSOM_PORT: blossomPort, DEVNET_GATEWAY_PORT: gatewayPort } });
for (let i = 0; i < 60; i++) {
  try { await fetch(BLOSSOM + "/"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const STYLE = `body{font-family:system-ui,sans-serif;margin:0;background:#fbf7f0;color:#2a2118}
header{display:flex;justify-content:space-between;align-items:center;padding:1rem 2rem;background:#2a2118;color:#fbf7f0}
header nav a{color:inherit;margin-left:1rem}header nav a[aria-current]{text-decoration:underline}
.logo{width:28px;height:28px;vertical-align:middle;margin-right:.5rem}
.card{background:#fff;border-radius:12px;padding:1.2rem 1.5rem;margin:1.5rem 2rem;box-shadow:0 1px 3px rgba(0,0,0,.08)}
footer{padding:1rem 2rem 6rem;color:#7a6a58}`;
const TOOLBAR = `<div class="nc-bar nc-ui-chrome"><span class="nc-dot"></span><span class="nc-who" data-nc-who>read-only</span>` +
  `<button data-nc-signin>Sign in</button><button class="nc-owner-only" data-nc-settings>Settings</button>` +
  `<button class="nc-owner-only" data-nc-history>History</button><button class="nc-primary nc-owner-only" data-nc-save>Save</button></div>` +
  `<p class="nc-edit-hint">add #edit to the URL to edit this page</p>` +
  `<script src="/nsite-clay.js"></script><script src="/nsite-clay-chrome.js"></script>`;
const doc = ({ path, title, nav, main }) => `<!DOCTYPE html>
<html lang="en" nc:owner="${NPUB}" nc:path="${path}" nc:edit-gate="hash" nc:runtime-owner="off" nc:relays="${RELAY}" nc:servers="${BLOSSOM}">
<head><meta charset="utf-8"><title>${title}</title><meta name="description" content="About ${title}">
<link rel="stylesheet" href="/nsite-clay-base.css"><style>${STYLE}</style></head>
<body>
<header><span><img class="logo" src="${path === "/index.html" ? "images/logo.svg" : "/images/logo.svg"}" alt=""><b class="brand" editable="single-line">Crumb and Co</b></span>
<nav>${nav}</nav></header>
<main nc:blocks>
${main}
</main>
<footer><p editable>Crumb and Co, Baker Street 1. Open Tuesday to Saturday.</p></footer>
<template nc:block="picture" nc:label="Picture" nc:on-add="image"><section class="card"><figure><img nc:slot src="/images/logo.svg" alt=""></figure></section></template>
<template nc:block="section" nc:label="Section"><section class="card"><h2 editable="single-line">A heading</h2><div editable><p>Write here.</p></div></section></template>
<script type="application/json" nc:cms>{"Brand": "header .brand", "Bread heading": "#our-bread"}</script>
${TOOLBAR}
</body></html>`;

const work = mkdtempSync(join(tmpdir(), "nsite-multipage-"));
const put = (path, body) => { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), body); };
put("index.html", doc({ path: "/index.html", title: "Crumb and Co",
  nav: `<a href="/" aria-current="page">Home</a> <a href="/about/">About</a>`,
  main: `<section class="card" id="bread"><h2 editable="single-line" id="our-bread">Our bread</h2><div editable>` +
    `<p>Sourdough every morning. Read <a href="/about/#story">our story</a>, or see the <a href="/cakes/">cakes</a>.</p>` +
    `<p>When to come: <a href="#hours">opening hours</a>. The <a href="/about">team</a> bakes it.</p></div></section>` +
    `<section class="card"><h2 editable="single-line">Opening hours</h2><div editable><p>Tuesday to Saturday, from seven until one.</p></div></section>` }));
put("about/index.html", doc({ path: "/about/index.html", title: "About us",
  nav: `<a href="/">Home</a> <a href="/about/" aria-current="page">About</a>`,
  main: `<section class="card"><h2 editable="single-line" id="story">Our story</h2><div editable><p>We started in a garage.</p></div></section>` +
    `<section class="card"><h2 editable="single-line" id="team">The team</h2><div editable><p>Three bakers.</p></div></section>` }));
put("contact.html", `<!DOCTYPE html><html><head><title>Contact</title></head><body><p>Call us.</p></body></html>`);
put("images/logo.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#d9a441"/></svg>`);
for (const [to, from] of [["nsite-clay.js", "dist/nsite-clay.js"], ["nsite-clay-chrome.js", "templates/_shared/nsite-clay-chrome.js"],
  ["nsite-clay-base.css", "templates/_shared/nsite-clay-base.css"]]) put(to, readFileSync(join(ROOT, from)));

const deploy = spawnSync(process.execPath, [join(ROOT, "bin/nsite-clay.mjs"), "deploy", work, `--relays=${RELAY}`, `--servers=${BLOSSOM}`, "--no-relay-list"],
  { encoding: "utf8", env: { ...process.env, NOSTR_SECRET_KEY: NSEC, NOSTR_BUNKER_URI: "" }, timeout: 60000 });
t("a three-page site is deployed to the devnet", deploy.status === 0, (deploy.stdout + deploy.stderr).slice(-400));

const browser = await chromium.launch({ channel: "chrome" });
const shot = async (p, name, locator = null) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await (locator || p).screenshot({ path: join(SHOTS, name + ".png") });
};
const dialog = (p) => p.locator("dialog.nc-ui").last();
const openSite = async (context, path) => {
  const p = await context.newPage();
  p.on("pageerror", (e) => t("no page error", false, e.message));
  await p.setViewportSize({ width: 1100, height: 820 });
  await p.goto(SITE + path);
  await p.evaluate(async () => { await nc.ready; });
  return p;
};
const signIn = async (p) => {
  await p.evaluate((key) => nc.login("nsec", { key }), NSEC);
  await p.waitForSelector("[data-nc-pages]", { timeout: 10000 });
};
const select = (p, selector, word) => p.evaluate(({ selector, word }) => {
  for (const el of document.querySelectorAll(selector)) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const i = n.textContent.indexOf(word);
      if (i < 0) continue;
      el.closest("[editable]").focus();
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    }
  }
  throw new Error("no " + word + " in " + selector);
}, { selector, word });
// The link dialog, opened the way ⌘K opens it, with the promise kept to await.
const linking = async (p) => {
  await p.evaluate(() => { window.__link = nc.editable.link(); });
  await dialog(p).locator("[data-nc-link]").waitFor({ timeout: 5000 });
};
const linked = (p) => p.evaluate(async () => { await window.__link; });
const manifestPaths = (p) => p.evaluate(async () => nc.manifestPaths(await nc.currentManifest()));

try {
  const context = await browser.newContext();
  // ---- the Pages button and list (a) ---------------------------------------
  const home = await openSite(context, "/#edit");
  t("a reader sees no Pages button", await home.locator("[data-nc-pages]").count() === 0);
  await signIn(home);
  const order = await home.evaluate(() => [...document.querySelector(".nc-bar").children].map((el) =>
    el.hasAttribute("data-nc-pages") ? "pages" : el.hasAttribute("data-nc-ai") ? "ai" : el.hasAttribute("data-nc-save") ? "save" : ""
  ).filter(Boolean).join(","));
  t("the owner gets a Pages button on the toolbar, before Edit with AI and Save", order === "pages,ai,save", order);
  await shot(home, "01-toolbar", home.locator(".nc-bar"));
  const words = await home.evaluate(() => {
    const was = document.documentElement.lang, said = {};
    for (const lang of ["es", "sk", "cs"]) { document.documentElement.lang = lang; said[lang] = [nc.pages.say("pages"), nc.pages.say("newTitle")]; }
    document.documentElement.lang = was;
    return said;
  });
  t("the new words follow the page's language", words.es[0] === "Páginas" && words.sk[1] === "Nová stránka v tomto dizajne" &&
    words.cs[1] === "Nová stránka v tomto designu", JSON.stringify(words));
  t("and none of them has an em or en dash", !/[\u2013\u2014]/.test(readFileSync(join(ROOT, "src/pages.js"), "utf8")));

  await home.click("[data-nc-pages]");
  await dialog(home).locator(".nc-pages li", { hasText: "About us" }).waitFor({ timeout: 15000 });
  await dialog(home).locator(".nc-pages li", { hasText: "not editable here" }).waitFor({ timeout: 15000 });
  const rows = await home.evaluate(() => [...document.querySelectorAll("dialog.nc-ui .nc-pages li")].map((li) => li.textContent));
  t("the list holds every HTML page of the manifest and nothing else", rows.length === 3 &&
    rows.some((r) => r.includes("/about/")) && rows.some((r) => r.includes("/contact.html")) && !rows.some((r) => /\.js|\.css|\.svg/.test(r)), JSON.stringify(rows));
  t("this page comes first and is marked", /this page/.test(rows[0]) && /Crumb and Co/.test(rows[0]), rows[0]);
  t("other pages show their titles, read from their own bytes", rows.some((r) => r.includes("About us")));
  t("a page that is not this site's editable kind says so", rows.some((r) => /Contact.*not editable here/.test(r)), JSON.stringify(rows));
  const cached = await home.evaluate(() => Object.values(JSON.parse(localStorage.getItem("nsite-clay.page-info") || "{}")).map((v) => v.t));
  t("titles are kept in this browser by hash", cached.includes("About us") && cached.includes("Contact"), JSON.stringify(cached));
  const dead = await dialog(home).locator(".nc-pages + .nc-hint").textContent();
  t("the list names the links on this page that lead nowhere", /\/cakes\//.test(dead) && /#hours/.test(dead), dead);
  await shot(home, "02-pages-dialog", dialog(home).locator(".nc-ui-card"));

  // Unsaved work: "Open without saving" goes, and nothing is published.
  await home.evaluate(() => {
    const p = document.querySelector("footer p"); p.append(" Fresh."); p.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  t("typing makes the page unsaved", await home.evaluate(() => nc.dirty));
  await dialog(home).locator(".nc-pages li", { hasText: "About us" }).locator("button").click();
  await dialog(home).locator("[data-nc-discard]").waitFor({ timeout: 5000 });
  t("leaving with unsaved work asks first", /Open About us\?/.test(await dialog(home).locator("h3").textContent()));
  await shot(home, "03-unsaved-guard", dialog(home).locator(".nc-ui-card"));
  await dialog(home).locator(".nc-cancel").click();
  t("Cancel stays on the page with the work in it", home.url().endsWith("/#edit") && await home.evaluate(() => nc.dirty));
  const before = await manifestPaths(home);
  await home.evaluate(() => { window.__open = nc.pages.openPage({ path: "/about/index.html", href: "/about/", title: "About us" }); });
  await dialog(home).locator("[data-nc-discard]").click();
  await home.waitForURL(SITE + "/about/#edit", { timeout: 10000 });
  await home.evaluate(async () => { await nc.ready; });
  const there = await home.evaluate(() => ({ path: nc.cfg.path, editing: document.documentElement.getAttribute("nc:editing") }));
  t("Open without saving goes to the other page, with the editing controls open", there.path === "/about/index.html" && there.editing === "true", JSON.stringify(there));
  t("and nothing was published on the way", JSON.stringify(await manifestPaths(home)) === JSON.stringify(before));

  // "Save and open": the save goes out first.
  await signIn(home);
  await home.evaluate(() => {
    const p = document.querySelector("footer p"); p.append(" Closed Mondays."); p.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await home.evaluate(() => { window.__open = nc.pages.openPage({ path: "/index.html", href: "/", title: "Home" }); });
  await dialog(home).locator(".nc-primary").click();
  await home.waitForURL(SITE + "/#edit", { timeout: 20000 });
  const saved = await manifestPaths(home);
  t("Save and open publishes this page, then goes", saved["/about/index.html"] !== before["/about/index.html"] && saved["/index.html"] === before["/index.html"]);

  // ---- the link dialog and live marks (b) ----------------------------------
  await home.evaluate(async () => { await nc.ready; });
  await signIn(home);
  await home.waitForFunction(() => document.querySelector('a[href="/cakes/"]')?.getAttribute("nc:dead") === "page", null, { timeout: 15000 });
  const marks = await home.evaluate(() => Object.fromEntries([...document.querySelectorAll("main a")].map((a) => [a.getAttribute("href"), a.getAttribute("nc:dead")])));
  t("a link to a page the site does not have is marked while editing", marks["/cakes/"] === "page", JSON.stringify(marks));
  t("so is a link to a place this page does not have", marks["#hours"] === "anchor", JSON.stringify(marks));
  t("and a directory named without its slash", marks["/about"] === "slash", JSON.stringify(marks));
  t("a link to a place another page has is not", marks["/about/#story"] === null, JSON.stringify(marks));
  t("the marks are never saved", !(await home.evaluate(() => nc.getHTML())).includes("nc:dead"));
  await shot(home, "04-dead-links", home.locator("main section").first());

  // A page of the site, picked from the list.
  await select(home, "main p", "Sourdough");
  await linking(home);
  await dialog(home).getByText("Our story").waitFor({ timeout: 15000 });
  const groups = await dialog(home).locator(".nc-pick-group").allTextContents();
  t("the dialog lists the site's pages, this page's headings and the other pages' headings",
    groups.join("|") === "Pages on this site|On this page|On About us", groups.join("|"));
  await shot(home, "05-link-picker", dialog(home).locator(".nc-ui-card"));
  await dialog(home).locator(".nc-link-pick button", { hasText: "About us" }).first().click();
  t("choosing a page fills in its address with the slash", await dialog(home).locator("[data-nc-link]").inputValue() === "/about/");
  await dialog(home).locator(".nc-primary").click();
  await linked(home);
  t("and links the selected words to it", await home.evaluate(() =>
    [...document.querySelectorAll("main a")].some((a) => a.textContent === "Sourdough" && a.getAttribute("href") === "/about/")));
  t("which marks the page unsaved", await home.evaluate(() => nc.dirty));

  // A heading on another page.
  await select(home, "main p", "morning");
  await linking(home);
  await dialog(home).locator(".nc-link-pick button", { hasText: "The team" }).waitFor({ timeout: 15000 });
  await dialog(home).locator(".nc-link-pick button", { hasText: "The team" }).click();
  await dialog(home).locator(".nc-primary").click();
  await linked(home);
  t("a heading on another page links as page#id", await home.evaluate(() => document.querySelector('a[href="/about/#team"]')?.textContent === "morning"));

  // A heading on this page that has no id gets one from its words.
  await select(home, "main p", "When");
  await linking(home);
  await dialog(home).locator(".nc-link-pick button", { hasText: "Opening hours" }).click();
  await dialog(home).locator(".nc-primary").click();
  await linked(home);
  const anchor = await home.evaluate(() => ({ id: [...document.querySelectorAll("h2")].find((h) => h.textContent === "Opening hours")?.id,
    link: [...document.querySelectorAll("main a")].find((a) => a.textContent === "When")?.getAttribute("href") }));
  t("a heading here without an id gets one, and the link uses it", anchor.id === "opening-hours" && anchor.link === "#opening-hours", JSON.stringify(anchor));

  // Web addresses, email, phone, typed.
  const typed = async (word, value) => {
    await select(home, "main p", word);
    await linking(home);
    await dialog(home).locator("[data-nc-link]").fill(value);
    const note = await dialog(home).locator(".nc-link-note").textContent();
    await dialog(home).locator(".nc-primary").click();
    await linked(home);
    return { note, href: await home.evaluate((w) => [...document.querySelectorAll("main a")].find((a) => a.textContent === w)?.getAttribute("href"), word) };
  };
  let r = await typed("every", "example.com/menu");
  t("a web address without https:// gets it", r.href === "https://example.com/menu" && /Opens https:\/\/example\.com\/menu/.test(r.note), JSON.stringify(r));
  r = await typed("Tuesday", "orders@example.com");
  t("an email address becomes a mailto: link", r.href === "mailto:orders@example.com", JSON.stringify(r));
  r = await typed("seven", "+421 900 123 456");
  t("a phone number becomes a tel: link", r.href === "tel:+421900123456", JSON.stringify(r));

  await select(home, "main p", "one");
  await linking(home);
  await dialog(home).locator("[data-nc-link]").fill("javascript:alert(1)");
  await dialog(home).locator(".nc-primary").click();
  const refusal = await dialog(home).locator(".nc-status").textContent();
  t("any other kind of address is refused, and says why", /Only web addresses/.test(refusal), refusal);
  await dialog(home).locator(".nc-cancel").click();
  await linked(home);
  t("and nothing is linked", await home.evaluate(() => ![...document.querySelectorAll("main a")].some((a) => a.textContent === "one")));

  // An existing link opens with its address in the box.
  await select(home, "main p", "cake");
  await linking(home);
  t("editing an existing link starts from where it goes", await dialog(home).locator("[data-nc-link]").inputValue() === "/cakes/");
  t("and offers to remove it", await dialog(home).locator("[data-nc-unlink]").count() === 1);
  await dialog(home).locator("[data-nc-link]").fill("/about");
  await dialog(home).locator(".nc-link-note", { hasText: "slash" }).waitFor({ timeout: 3000 });
  await shot(home, "06-link-slash", dialog(home).locator(".nc-ui-card"));
  await dialog(home).locator(".nc-primary").click();
  await linked(home);
  t("a directory typed without its slash is linked with it", await home.evaluate(() =>
    [...document.querySelectorAll("main a")].find((a) => a.textContent === "cakes")?.getAttribute("href")) === "/about/");
  await home.waitForFunction(() => ![...document.querySelectorAll("main a")].find((a) => a.textContent === "cakes")?.hasAttribute("nc:dead"), null, { timeout: 3000 });
  t("and the mark goes when the link is fixed", true);

  await select(home, "main p", "team");
  await linking(home);
  await dialog(home).locator("[data-nc-unlink]").click();
  await linked(home);
  t("Remove link unwraps the words", await home.evaluate(() =>
    ![...document.querySelectorAll("main a")].some((a) => a.textContent === "team") && document.querySelector("main").textContent.includes("team")));

  const slash = await home.evaluate(() => nc._missingRefs('<a href="/about">a</a><a href="/about/">b</a><a href="/contact">c</a>',
    { "/index.html": "a", "/about/index.html": "b", "/contact.html": "c" }).links);
  t("the check after a save agrees: no slash, or no .html, is a page no gateway is sure to serve",
    JSON.stringify(slash) === JSON.stringify(["/about", "/contact"]), JSON.stringify(slash));
  const savedLinks = await home.evaluate(async () => (await nc.save()).missing.links);
  t("with the links fixed, the save reports none", JSON.stringify(savedLinks) === "[]", JSON.stringify(savedLinks));

  // ---- a new page in this design (c) ---------------------------------------
  const versionsBefore = (await home.evaluate(async () => (await nc.versions()).length));
  await home.click("[data-nc-pages]");
  await dialog(home).locator('[data-nc-pages-action="new"]').click();
  await dialog(home).locator("[data-nc-new-title]").waitFor();
  await dialog(home).locator("[data-nc-new-title]").fill("Catering");
  t("the address follows the title", await dialog(home).locator("[data-nc-new-address]").inputValue() === "/catering/");
  await dialog(home).locator("[data-nc-new-address]").fill("/about/");
  const taken = await dialog(home).locator(".nc-field .nc-hint").textContent();
  t("an address that is taken is refused", /already a page at \/about\//.test(taken) &&
    await dialog(home).locator(".nc-primary").isDisabled(), taken);
  await dialog(home).locator("[data-nc-new-address]").fill("/Catering");
  t("a typed address is made into a directory", /\/catering\//.test(await dialog(home).locator(".nc-field .nc-hint").textContent()));
  t("the menu is offered", await dialog(home).getByText("Add it to this page's menu").count() === 1);
  await shot(home, "07-new-page", dialog(home).locator(".nc-ui-card"));
  await dialog(home).locator(".nc-primary").click();
  await home.waitForURL(SITE + "/catering/#edit", { timeout: 60000 });
  await home.evaluate(async () => { await nc.ready; });
  const fresh = await home.evaluate(() => ({
    path: nc.cfg.path, title: document.title, owner: document.documentElement.getAttribute("nc:owner"),
    relays: document.documentElement.getAttribute("nc:relays"),
    brand: document.querySelector("header .brand")?.textContent,
    nav: [...document.querySelectorAll("header nav a")].map((a) => [a.getAttribute("href"), a.textContent, a.getAttribute("aria-current")]),
    blocks: [...document.querySelector("main[nc\\:blocks]").children].map((el) => el.outerHTML),
    library: document.querySelectorAll("template[nc\\:block]").length,
    rules: JSON.parse(document.querySelector("script[nc\\:cms]")?.textContent || "{}"),
    logo: document.querySelector("header img").getAttribute("src"),
    description: !!document.querySelector('meta[name="description"]'),
    footer: document.querySelector("footer").textContent,
    style: [...document.querySelectorAll("style:not([nc\\:chrome])")].some((s) => s.textContent.includes(".card{")),
  }));
  t("the new page opens at its own address with its own nc:path", fresh.path === "/catering/index.html", fresh.path);
  t("with the title it was given", fresh.title === "Catering");
  t("the same owner, relays, header, footer and stylesheet", fresh.owner === NPUB && fresh.relays === RELAY &&
    fresh.brand === "Crumb and Co" && /Baker Street/.test(fresh.footer) && fresh.style, JSON.stringify(fresh).slice(0, 300));
  t("and the same block library", fresh.library === 2);
  t("an empty block area holding one titled block from the library",
    fresh.blocks.length === 1 && /nc:block-type="section"/.test(fresh.blocks[0]) && /<h2[^>]*>Catering<\/h2>/.test(fresh.blocks[0]), fresh.blocks.join(""));
  t("its menu names it as the current page", JSON.stringify(fresh.nav) === JSON.stringify([["/", "Home", null], ["/about/", "About", null], ["/catering/", "Catering", "page"]]),
    JSON.stringify(fresh.nav));
  t("content rules for parts it does not have are gone", JSON.stringify(fresh.rules) === JSON.stringify({ Brand: "header .brand" }), JSON.stringify(fresh.rules));
  t("a picture named relative to the old page still loads from the new one", /^\/images\/logo(-[0-9a-f]{8})?\.svg$/.test(fresh.logo) &&
    await home.evaluate(() => document.querySelector("header img").naturalWidth > 0), fresh.logo);
  t("what described the old page is not copied", !fresh.description);
  const after = await manifestPaths(home);
  const served = await (await fetch(SITE + "/?v=" + Date.now())).text();
  t("the old page's menu links to it, published in the same manifest",
    after["/catering/index.html"] && served.includes('href="/catering/"') && !/href="\/catering\/"[^>]*aria-current/.test(served));
  t("and everything else in the table is still there", Object.keys(before).every((p) => after[p]));
  t("as one new version", (await home.evaluate(async () => (await nc.versions()).length)) === versionsBefore + 1);
  await signIn(home);
  await shot(home, "08-new-page-opened");

  // ---- a new page with AI (c) ----------------------------------------------
  const aiContext = await browser.newContext();
  const page = await aiContext.newPage();
  page.on("pageerror", (e) => t("no page error (AI)", false, e.message));
  await page.setViewportSize({ width: 1100, height: 860 });
  await mockAiAccount(page, { balance: 1000000 });
  const QWEN = { id: "qwen-image-2-1-turbo", architecture: { output_modalities: ["image"] }, sats_pricing: { image_output: 24.33 } };
  await page.route("https://routstr.cypherpunk.today/v1/models", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ data: [{ id: "deepseek-v4-1-flash-1017", sats_pricing: { prompt: .000439, completion: .001756 } }, QWEN] }) }));
  const square = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 180;
    const x = c.getContext("2d"); x.fillStyle = "#c96"; x.fillRect(0, 0, 320, 180); return c.toDataURL("image/png").split(",")[1];
  });
  const drawn = [];
  await page.route("https://routstr.cypherpunk.today/v1/image/generate", (route) => {
    drawn.push(route.request().postDataJSON());
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ images: [square] }) });
  });
  const asked = [];
  // A model that does not quite do as it is told: a whole document, with a
  // header of its own and a stylesheet, around the sections it was asked for.
  const REPLY = '```html\n<!DOCTYPE html><html><head><style>body{background:red}</style></head><body><header><nav><a href="/">Home</a></nav></header><main>' +
    '<section class="card"><h1>Workshops</h1><p>Learn to bake sourdough on Saturday mornings.</p><img alt="Hands kneading dough" nc:crop="16:9" nc:prompt="Hands kneading dough on a floured table, morning light"></section>' +
    '<section class="card"><h2>What to bring</h2><ul><li>An apron</li><li>A jar for your starter</li></ul><script>alert(1)</script><p onclick="x()">Questions? Read <a href="/about/">about us</a>.</p></section>' +
    '</main><footer>Made by AI</footer></body></html>\n```';
  await page.route("https://routstr.cypherpunk.today/v1/chat/completions", (route) => {
    const body = route.request().postDataJSON(); asked.push(body);
    const text = body.messages[1].content.includes("Change to make:")
      ? body.messages[1].content.split("The content as it is now:\n")[1].split("\n\nChange to make:")[0].replace("Saturday mornings", "Saturday and Sunday mornings")
      : REPLY;
    route.fulfill({ contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
  });
  await page.goto(SITE + "/#edit");
  await page.evaluate(async () => { await nc.ready; nc.ai.client.configure({ ...nc.ai.client.config, key: "sk-local-multipage" }); });
  await signIn(page);
  await page.click("[data-nc-pages]");
  await dialog(page).locator('[data-nc-pages-action="new-ai"]').click();
  await dialog(page).locator("[data-nc-new-title]").fill("Workshops");
  await dialog(page).locator("textarea").fill("Sourdough workshops on Saturday mornings, what to bring, and a link to the about page.");
  await page.waitForFunction(() => /Rough cost/.test(document.querySelector("dialog.nc-ui:last-of-type .nc-ai-readiness")?.textContent || "") &&
    !document.querySelector("dialog.nc-ui:last-of-type .nc-primary").disabled, null, { timeout: 15000 });
  const cost = await dialog(page).locator(".nc-ai-readiness").textContent();
  t("the AI dialog shows the credit, the expected cost and what a picture costs", /Available credit/.test(cost) && /Rough cost/.test(cost) && /24\.33/.test(cost), cost);
  await shot(page, "09-new-page-ai", dialog(page).locator(".nc-ui-card"));
  await dialog(page).locator(".nc-primary").click();
  await dialog(page).locator("iframe").waitFor({ timeout: 30000 });
  const sent = asked[0];
  t("the model is asked for the inside of <main> only", /inside the page's <main>/.test(sent.messages[0].content));
  t("and is shown this page's stylesheet and block shapes as the design to use",
    sent.messages[1].content.includes(".card{background:#fff") && sent.messages[1].content.includes("A heading"));
  t("and the site's other pages to link to", /About us \(\/about\/\)/.test(sent.messages[1].content) && /Catering \(\/catering\/\)|\/catering\//.test(sent.messages[1].content));
  t("and told how to ask for pictures", /nc:prompt/.test(sent.messages[0].content));
  const preview = await dialog(page).locator("iframe").evaluate((f) => f.srcdoc);
  t("the preview is the new content in this site's shell", preview.includes("Learn to bake sourdough") && preview.includes("Crumb and Co") &&
    preview.includes("Baker Street") && !preview.includes("Made by AI") && !preview.includes("background:red"));
  t("with the picture AI made, before anything is uploaded", drawn.length === 1 && preview.includes("data:image/webp") && drawn[0].aspect_ratio === "16:9");
  await shot(page, "10-new-page-ai-preview", dialog(page).locator(".nc-ui-card"));

  await dialog(page).locator("textarea").fill("Say Saturday and Sunday mornings.");
  await dialog(page).getByText("Refine this version").click();
  await page.waitForFunction(() => document.querySelector("dialog.nc-ui:last-of-type iframe")?.srcdoc.includes("Saturday and Sunday"), null, { timeout: 20000 });
  t("a preview can be refined", asked.length === 2 && /The content as it is now/.test(asked[1].messages[1].content));
  t("refining keeps the picture rather than making it again", drawn.length === 1);

  await dialog(page).locator(".nc-primary").click();
  await page.waitForURL(SITE + "/workshops/#edit", { timeout: 60000 });
  await page.evaluate(async () => { await nc.ready; });
  const built = await page.evaluate(() => ({
    path: nc.cfg.path, title: document.title, headers: document.querySelectorAll("header").length,
    footer: document.querySelector("footer").textContent,
    main: document.querySelector("main").innerHTML,
    img: document.querySelector("main img")?.getAttribute("src"),
    nav: [...document.querySelectorAll("header nav a")].map((a) => a.getAttribute("href")),
    editable: [...document.querySelectorAll("main [editable]")].map((el) => el.tagName).join(","),
  }));
  t("the AI page is published at its address with its nc:path", built.path === "/workshops/index.html" && built.title === "Workshops", JSON.stringify(built).slice(0, 200));
  t("with this site's own header and footer, not the model's", built.headers === 1 && /Baker Street/.test(built.footer) && !/Made by AI/.test(built.footer));
  t("with the refined words", built.main.includes("Saturday and Sunday mornings"));
  t("and nothing the model may not write", !/<script|onclick|<style/.test(built.main), built.main.slice(0, 300));
  t("its words are editable", /H1/.test(built.editable) && /LI/.test(built.editable), built.editable);
  t("its picture is on the owner's Blossom server", built.img?.startsWith(BLOSSOM + "/"), built.img);
  t("and it is in the menu of the page it was made from, and in its own",
    built.nav.includes("/workshops/") && (await (await fetch(SITE + "/?v=" + Date.now())).text()).includes('href="/workshops/"'), JSON.stringify(built.nav));
  t("the draft is cleared once the page is published", await page.evaluate(() =>
    !Object.keys(localStorage).some((k) => k.startsWith("nsite-clay.ai-draft:") && k.includes('"newpage"'))));
} catch (e) {
  // What was on screen, which is usually the reason.
  for (const context of browser.contexts()) for (const p of context.pages()) {
    const said = await p.evaluate(() => [...document.querySelectorAll("dialog.nc-ui, .nc-notice, .nc-toast")]
      .map((d) => d.textContent.replace(/\s+/g, " ").slice(0, 400)).join(" || ")).catch(() => "");
    if (said) console.log(`  on ${p.url()}: ${said}`);
  }
  t("the run completed", false, e.stack || e.message);
} finally {
  for (const [name, pass, detail] of out) console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail && !pass ? "   (" + detail + ")" : ""}`);
  console.log(`\n${out.filter((r) => r[1]).length}/${out.length} passed`);
  await browser.close();
  devnet.kill();
  rmSync(work, { recursive: true, force: true });
}
process.exit(out.length && out.every((r) => r[1]) ? 0 : 1);
