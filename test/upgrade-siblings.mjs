#!/usr/bin/env node
// Taking a runtime upgrade on a site with more than one page.
//
// Every page of a site is named in one manifest, and on a site published by the
// CLI or the wizard every page points at the same content-stamped engine. An
// upgrade started from one page used to move that page to the new stamped name
// and drop the old one from the shared table, which unpublished the engine every
// other page was still loading. So the upgrade now takes every page of the site
// with it, in the same manifest, and only retires a name nothing loads any more.
//
// Everything runs against tools/devnet.mjs on ports nobody else holds: a relay,
// a Blossom server and a gateway that serves a site by hostname, exactly as a
// real one does. Nothing reaches a public relay.
//   node test/upgrade-siblings.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool } from "nostr-tools";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import WebSocket from "ws";
import { localPorts } from "./local-ports.mjs";
useWebSocketImplementation(WebSocket);

const root = (p) => fileURLToPath(new URL("../" + p, import.meta.url));
const DEVNET = root("tools/devnet.mjs");

let fail = 0;
const t = (name, pass, detail = "") => {
  if (!pass) fail++;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${!pass && detail ? "  (" + detail + ")" : ""}`);
};

// ---- the rewrite on its own: attribute values, and nothing else
{
  const { retarget } = await import("../src/upgrade.js");
  const m = new Map([["/nsite-clay-11111111.js", "/nsite-clay-22222222.js"]]);
  const cases = [
    [`<script SRC="/nsite-clay-11111111.js?v=1#x"></script>`, `<script SRC="/nsite-clay-22222222.js?v=1#x"></script>`, "any case, query kept"],
    [`<script src=/nsite-clay-11111111.js></script>`, `<script src=/nsite-clay-22222222.js></script>`, "unquoted"],
    [`<a title="x > y" href='/nsite-clay-11111111.js'>`, `<a title="x > y" href='/nsite-clay-22222222.js'>`, "a > inside another attribute"],
    [`<html\n  nc:source="/nsite-clay-11111111.js">`, `<html\n  nc:source="/nsite-clay-22222222.js">`, "nc:source on <html>"],
    [`<textarea><script src="/nsite-clay-11111111.js"></script></textarea>`, null, "a tag written inside a textarea"],
    [`<script src="/nsite-clay-11111111.js">s = '<script src="/nsite-clay-11111111.js">'</script>`,
      `<script src="/nsite-clay-22222222.js">s = '<script src="/nsite-clay-11111111.js">'</script>`, "a script body"],
    [`<!-- <script src="/nsite-clay-11111111.js"> -->`, null, "a comment"],
    [`<img data-src="/nsite-clay-11111111.js">`, null, "an attribute that only ends in src"],
    [`<script src="/nsite-clay-11111111.json"></script>`, null, "a longer path that starts the same"],
    [`<script src=/nsite-clay-11111111.js/></script>`, null, "an unquoted value that is a different path"],
  ];
  for (const [html, want, what] of cases) {
    const got = retarget(html, m);
    t(`retarget: ${what}`, got === (want ?? html), got);
  }
}

const [relayPort, blossomPort, gatewayPort] = await localPorts(3);
const RELAY = `ws://127.0.0.1:${relayPort}`;
const BLOSSOM = `http://127.0.0.1:${blossomPort}`;
const devnet = spawn(process.execPath, [DEVNET, "--quiet"], {
  stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: relayPort, DEVNET_BLOSSOM_PORT: blossomPort, DEVNET_GATEWAY_PORT: gatewayPort },
});
for (let i = 0; i < 50; i++) {
  try { await fetch(BLOSSOM + "/"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const hex = (bytes) => bytesToHex(sha256(bytes));
const enc = new TextEncoder();
const pool = new SimplePool();

// Two keys: the one publishing the runtime, as the project does from its own
// site, and the one whose site is being upgraded.
const runtimeSec = generateSecretKey();
const runtimeNpub = nip19.npubEncode(getPublicKey(runtimeSec));
const ownerSec = generateSecretKey();
const ownerPub = getPublicKey(ownerSec);
const ownerNpub = nip19.npubEncode(ownerPub);
const ownerNsec = nip19.nsecEncode(ownerSec);
const b36 = BigInt("0x" + ownerPub).toString(36).padStart(50, "0");
const siteUrl = (site, path) => `http://${site ? b36 + site : ownerNpub}.localhost:${gatewayPort}${path}`;

async function put(bytes, type) {
  const auth = finalizeEvent({ kind: 24242, created_at: Math.floor(Date.now() / 1000), content: "test",
    tags: [["t", "upload"], ["x", hex(bytes)], ["expiration", String(Math.floor(Date.now() / 1000) + 600)]] }, ownerSec);
  const res = await fetch(BLOSSOM + "/upload", { method: "PUT", body: bytes,
    headers: { Authorization: "Nostr " + Buffer.from(JSON.stringify(auth)).toString("base64"), "Content-Type": type } });
  if (!res.ok) throw new Error(`upload: ${res.status}`);
  return hex(bytes);
}

async function publishManifest(sec, site, paths, at) {
  const ev = finalizeEvent({
    kind: site ? 35128 : 15128, created_at: at, content: "",
    tags: [...(site ? [["d", site]] : []), ...Object.entries(paths).map(([p, h]) => ["path", p, h]), ["server", BLOSSOM]],
  }, sec);
  await Promise.any(pool.publish([RELAY], ev));
  return ev;
}

async function manifest(site) {
  const ev = await pool.get([RELAY], site
    ? { kinds: [35128], authors: [ownerPub], "#d": [site] }
    : { kinds: [15128], authors: [ownerPub] });
  return Object.fromEntries(ev.tags.filter((x) => x[0] === "path").map((x) => [x[1], x[2]]));
}

// ---- the runtime: what the project publishes, and two builds older than it

const SHARED = [
  ["/nsite-clay.js", "dist/nsite-clay.js", "text/javascript"],
  ["/nsite-clay-base.css", "templates/_shared/nsite-clay-base.css", "text/css"],
  ["/nsite-clay-chrome.js", "templates/_shared/nsite-clay-chrome.js", "text/javascript"],
  ["/nsite-clay-source.js", "dist/nsite-clay-source.js", "text/javascript"],
];
const stamp = (path, hash) => path.replace(/(\.[a-z]+)$/, `-${hash.slice(0, 8)}$1`);
// An older build is the same code with a different byte at the end: what is
// under test is the engine doing the upgrading, and only the hashes have to
// differ for the page to be offered one.
async function build(suffix) {
  const out = {};
  for (const [canonical, file, type] of SHARED) {
    const bytes = Buffer.concat([readFileSync(root(file)), Buffer.from(suffix ? `\n/* ${suffix} */\n` : "")]);
    const hash = await put(bytes, type);
    out[canonical] = { hash, stamped: stamp(canonical, hash) };
  }
  return out;
}
const fresh = await build("");
const old = await build("an older build");
const older = await build("an even older build");

const now = Math.floor(Date.now() / 1000) - 30;
const notes = enc.encode(JSON.stringify({ version: "9.9.9", released: "2026-10-23", notes: ["A test release."] }));
await publishManifest(runtimeSec, "", {
  ...Object.fromEntries(SHARED.map(([c]) => [c, fresh[c].hash])),
  "/runtime.json": await put(notes, "application/json"),
}, now);

// ---- the owner's site --------------------------------------------------------

// A page as a publisher leaves it. `refs` says which build it names, and how:
// stamped, as the CLI and the wizard write them, or by the plain name. Some of
// it is there to be left alone: the same path written as prose, in a code
// sample and in a comment is not a reference, and must come back byte for byte.
function page({ path, site = "", title, engine, plain = false, owner = ownerNpub, extra = "" }) {
  const ref = (c) => (plain ? c : engine[c].stamped);
  return `<!DOCTYPE html>
<html lang="en"
      nc:owner="${owner}"${site ? ` nc:site="${site}"` : ""}
      nc:relays="${RELAY}" nc:servers="${BLOSSOM}"
      nc:runtime-owner="${runtimeNpub}"
      nc:path="${path}" nc:source='${ref("/nsite-clay-source.js")}'>
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet"   href="${ref("/nsite-clay-base.css")}">
<style>body { font-family: Georgia , serif }  /* spacing kept as typed */</style>
</head>
<body>
  <main editable>
    <h1>${title}</h1>
    <p>To run it yourself, write src="${ref("/nsite-clay.js")}" in your own page.</p>
    <pre>&lt;script src="${ref("/nsite-clay.js")}"&gt;&lt;/script&gt;</pre>
    <!-- built against ${ref("/nsite-clay.js")} -->
    ${extra}
  </main>
<script src="${ref("/nsite-clay.js")}"></script>
<script src=${ref("/nsite-clay-chrome.js")} defer></script>
</body>
</html>
`;
}

// What a publisher puts in the table for one build: the stamped names, and the
// plain names beside them the CLI keeps for a reader holding an older copy.
const table = (engine) => Object.fromEntries(SHARED.flatMap(([c]) => [[engine[c].stamped, engine[c].hash], [c, engine[c].hash]]));

const pages = {
  "/index.html": page({ path: "/index.html", title: "Home", engine: old }),
  "/about.html": page({ path: "/about.html", title: "About", engine: old, extra: "<p>Ünïcödé stays… as written, «quoted» and all.</p>" }),
  "/notes/index.html": page({ path: "/notes/index.html", title: "Notes", engine: older }),
  "/plain.html": page({ path: "/plain.html", title: "Plain", engine: old, plain: true }),
  "/static.html": "<!doctype html><title>static</title><p>No engine here. <script src=\"/nsite-clay.js\"> is text.</p>\n",
};
const rootPaths = { ...table(old), ...table(older) };
for (const [p, html] of Object.entries(pages)) rootPaths[p] = await put(enc.encode(html), "text/html");
rootPaths["/logo.svg"] = await put(enc.encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml");
await publishManifest(ownerSec, "", rootPaths, now);

// A second site where one page cannot be read: its blob is on no server. The
// upgrade must not retire anything that page may still be loading.
const failPages = {
  "/index.html": page({ path: "/index.html", site: "fail", title: "Home", engine: old }),
  "/about.html": page({ path: "/about.html", site: "fail", title: "About", engine: old }),
  // Somebody else's page, published under this key: not ours to rewrite.
  "/foreign.html": page({ path: "/foreign.html", site: "fail", title: "Foreign", engine: old,
    owner: nip19.npubEncode(getPublicKey(generateSecretKey())) }),
};
const failPaths = { ...table(old) };
for (const [p, html] of Object.entries(failPages)) failPaths[p] = await put(enc.encode(html), "text/html");
failPaths["/gone.html"] = hex(enc.encode("<!doctype html><title>never uploaded</title>"));
await publishManifest(ownerSec, "fail", failPaths, now);

// ---- the browser -------------------------------------------------------------

const browser = await chromium.launch({ channel: "chrome" });
// One context, as one person's browser: the pages of a site share an origin, and
// so the storage that remembers an upgrade was taken.
const context = await browser.newContext();
const errors = [];

// Open a page of the site and say what engine it is running on, as a reader
// would get it: the address it loads, what the gateway answers there, and
// whether that is the build just published.
async function open(site, path) {
  const p = await context.newPage();
  p.on("pageerror", (e) => errors.push(`${site}${path}: ${e.message}`));
  await p.goto(siteUrl(site, path), { waitUntil: "load" });
  const src = await p.evaluate(() => document.querySelector("script[src*='nsite-clay']:not([src*='chrome'])")?.getAttribute("src"));
  const running = await p.waitForFunction(() => window.nc && window.nc.ready, null, { timeout: 8000 })
    .then(() => true).catch(() => false);
  const served = src ? await fetch(siteUrl(site, src)) : null;
  const hash = served?.ok ? hex(new Uint8Array(await served.arrayBuffer())) : null;
  return { p, src, running, status: served?.status, current: hash === fresh["/nsite-clay.js"].hash };
}

async function upgradeFrom(site) {
  const { p } = await open(site, "/index.html");
  return { p, out: await p.evaluate(async (nsec) => {
    await nc.ready;
    await nc.login("nsec", { key: nsec });
    const plan = await nc.upgrade.check();
    if (!plan) return { error: "no plan" };
    // What the dialog says before anything happens.
    const shown = nc.upgrade.promptFor(plan);
    await new Promise((r) => setTimeout(r, 100));
    const said = document.querySelector("dialog.nc-ui")?.textContent || "";
    document.querySelector("dialog.nc-ui .nc-cancel")?.click();
    await shown;
    const steps = [];
    try {
      const done = await nc.upgrade.apply(plan, (s) => steps.push(s.path));
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("nsite-clay.upgraded:"));
      return { said, pages: plan.pages, steps, done: { files: done.files, pages: done.pages, kept: done.kept }, keys };
    } catch (e) { return { said, error: e.message }; }
  }, ownerNsec) };
}

try {
  // ---- the reproduction: two pages on one engine, upgrade from the first
  {
    const before = await open("", "/about.html");
    t("before the upgrade the second page runs", before.running && before.status === 200, JSON.stringify(before));
    await before.p.close();

    const { p, out } = await upgradeFrom("");
    t("the upgrade goes through", !out.error, out.error);
    t("the dialog says it updates every page of the site", /all 5 pages of this site/.test(out.said), out.said.slice(0, 400));
    t("and progress names the other pages as it goes", out.steps?.some((s) => /about\.html/.test(s)), JSON.stringify(out.steps));
    t("the result counts the pages it moved", out.done?.pages === 4, JSON.stringify(out.done));
    await p.close();

    const after = await open("", "/about.html");
    t("after upgrading the first page, the second still loads an engine", after.status === 200,
      `${after.src} -> ${after.status}`);
    t("and it is the new one", after.current && after.running, JSON.stringify({ src: after.src, current: after.current, running: after.running }));
    await after.p.close();
  }

  // ---- every page, whatever it was on
  {
    const paths = await manifest("");
    for (const path of ["/index.html", "/notes/index.html", "/plain.html"]) {
      const o = await open("", path);
      t(`${path} runs the new engine`, o.current && o.running, JSON.stringify({ src: o.src, status: o.status }));
      await o.p.close();
    }
    t("a page naming the plain file is served the new build under it",
      paths["/nsite-clay.js"] === fresh["/nsite-clay.js"].hash && paths["/nsite-clay-chrome.js"] === fresh["/nsite-clay-chrome.js"].hash);
    t("its bytes did not need to change", paths["/plain.html"] === rootPaths["/plain.html"]);
    t("a page without the engine is left exactly as it was", paths["/static.html"] === rootPaths["/static.html"]);
    t("a file that is not a page is left alone", paths["/logo.svg"] === rootPaths["/logo.svg"]);
    t("the old stamped names nothing loads any more are retired",
      !paths[old["/nsite-clay.js"].stamped] && !paths[older["/nsite-clay.js"].stamped] && !paths[old["/nsite-clay-base.css"].stamped],
      Object.keys(paths).join(" "));
    t("the new stamped names are in the table",
      SHARED.every(([c]) => paths[fresh[c].stamped] === fresh[c].hash));

    // Owner content: the only bytes that changed are the references.
    const res = await fetch(siteUrl("", "/about.html"));
    const got = await res.text();
    const want = pages["/about.html"]
      .replace(`href="${old["/nsite-clay-base.css"].stamped}"`, `href="${fresh["/nsite-clay-base.css"].stamped}"`)
      .replace(`nc:source='${old["/nsite-clay-source.js"].stamped}'`, `nc:source='${fresh["/nsite-clay-source.js"].stamped}'`)
      .replace(`<script src="${old["/nsite-clay.js"].stamped}">`, `<script src="${fresh["/nsite-clay.js"].stamped}">`)
      .replace(`src=${old["/nsite-clay-chrome.js"].stamped} defer`, `src=${fresh["/nsite-clay-chrome.js"].stamped} defer`);
    t("a sibling's bytes are its own except for the references that moved", got === want,
      got.split("\n").find((line, i) => line !== want.split("\n")[i]));
    t("prose, code samples and comments naming the old file are not references",
      got.includes(`write src="${old["/nsite-clay.js"].stamped}"`) && got.includes(`<!-- built against ${old["/nsite-clay.js"].stamped} -->`));

    // A sibling the owner opens next is current, and is not offered it again.
    const b = await open("", "/about.html");
    const again = b.running ? await b.p.evaluate(async ({ nsec, hash }) => {
      await nc.ready;
      // Asked before signing in, which runs check(), and check() forgets the
      // record once the page is current. It is what a copy of this page from
      // before the upgrade, handed out by a gateway's cache, would be told:
      // already done here, reload.
      const remembered = nc.upgrade._alreadyApplied([{ canonical: "/nsite-clay.js", hash }]);
      await nc.login("nsec", { key: nsec });
      return { plan: await nc.upgrade.check(), remembered };
    }, { nsec: ownerNsec, hash: fresh["/nsite-clay.js"].hash }) : { plan: "not running" };
    t("the upgraded sibling has nothing more to take", again.plan === null, JSON.stringify(again.plan?.files?.map((f) => f.path) ?? again.plan));
    t("and a stale copy of it would be told it is already done, not offered it again", again.remembered === true);

    // A sibling saved from another tab while the upgrade was reading it: the
    // rewrite was made from the bytes before that save, and publishing it would
    // throw the save away. Nothing goes out instead.
    if (b.running) {
      const raced = await b.p.evaluate(async () => {
        const before = (await nc._currentPaths())["/about.html"];
        try {
          await nc.save({ extraPaths: { "/index.html": "0".repeat(64) }, expect: { "/index.html": "f".repeat(64) }, report: false });
          return { message: null, before };
        } catch (e) { return { message: e.message, before, after: (await nc._currentPaths())["/about.html"] }; }
      });
      t("a page changed since it was read stops the publish", /changed while this was running/.test(raced.message || ""), raced.message);
      t("and nothing is published", raced.after === raced.before);
    }
    await b.p.close();
  }

  // ---- a page that cannot be read keeps what it loads
  {
    const { p, out } = await upgradeFrom("fail");
    t("an upgrade with an unreadable page still goes through", !out.error, out.error);
    t("and says which pages it could not reach", (out.done?.kept || []).includes("/gone.html"), JSON.stringify(out.done));
    await p.close();
    const paths = await manifest("fail");
    t("the unreadable page stays in the table", paths["/gone.html"] === failPaths["/gone.html"]);
    t("so the old engine it may load is kept", SHARED.every(([c]) => paths[old[c].stamped] === old[c].hash),
      Object.keys(paths).join(" "));
    const b = await open("fail", "/about.html");
    t("the readable sibling moved to the new engine anyway", b.current && b.running, JSON.stringify({ src: b.src, status: b.status }));
    await b.p.close();
    t("somebody else's page under this key is not rewritten", paths["/foreign.html"] === failPaths["/foreign.html"]);
    const f = await open("fail", "/foreign.html");
    t("and still loads what it loaded", f.status === 200 && f.running);
    await f.p.close();
  }

  t("no page threw", !errors.length, errors.join(" | "));
} finally {
  await browser.close();
  pool.close([RELAY]);
  devnet.kill();
}

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
