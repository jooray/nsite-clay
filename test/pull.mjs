#!/usr/bin/env node
// The round trip an outside agent makes: pull a published site into a
// directory, edit it, deploy it back, and lose nothing that was made or saved
// in the browser meanwhile. Through the real CLI against the devnet, with a
// raw key and with a NIP-46 bunker whose link works once. Nothing reaches a
// public relay: every relay and server named is on this machine.
//   node test/pull.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool } from "nostr-tools";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import WebSocket from "ws";
import { localPorts } from "./local-ports.mjs";
import { startBunker } from "./mock-bunker.mjs";
useWebSocketImplementation(WebSocket);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "bin/nsite-clay.mjs");
const DEVNET = join(ROOT, "tools/devnet.mjs");

let fail = 0;
const t = (name, pass, detail = "") => {
  if (!pass) fail++;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${!pass && detail ? "  (" + String(detail).slice(0, 1500) + ")" : ""}`);
};

const [relayPort, blossomPort, gatewayPort] = await localPorts(3);
const RELAY = `ws://127.0.0.1:${relayPort}`;
const BLOSSOM = `http://127.0.0.1:${blossomPort}`;
const GATEWAY = `http://127.0.0.1:${gatewayPort}`;
const devnet = spawn(process.execPath, [DEVNET, "--quiet"], {
  stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: relayPort, DEVNET_BLOSSOM_PORT: blossomPort, DEVNET_GATEWAY_PORT: gatewayPort },
});
for (let i = 0; i < 50; i++) {
  try { await fetch(BLOSSOM + "/"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const sec = generateSecretKey();
const pub = getPublicKey(sec);
const npub = nip19.npubEncode(pub);
const work = mkdtempSync(join(tmpdir(), "nsite-pull-"));
const config = join(work, "config");
const baseEnv = { ...process.env, NOSTR_SECRET_KEY: "", NOSTR_BUNKER_URI: "", XDG_CONFIG_HOME: config };
const pinned = [`--relays=${RELAY}`, `--servers=${BLOSSOM}`];

// Async, because the bunker answers from this same process.
const cli = (args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...baseEnv, ...env } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => child.kill(), 90_000);
  child.on("close", (status) => { clearTimeout(timer); resolve({ status, out }); });
});
const withKey = { NOSTR_SECRET_KEY: nip19.nsecEncode(sec) };
const hash = (b) => bytesToHex(sha256(typeof b === "string" ? Buffer.from(b) : b));
const tick = () => new Promise((r) => setTimeout(r, 1100));   // a newer manifest needs a newer second

const pool = new SimplePool();
const manifest = async () => (await pool.querySync([RELAY], { kinds: [15128], authors: [pub] }))
  .sort((a, b) => b.created_at - a.created_at)[0];
const table = async () => Object.fromEntries((await manifest()).tags.filter((x) => x[0] === "path").map((x) => [x[1], x[2]]));
const served = async (path) => {
  const res = await fetch(`${GATEWAY}${path}?npub=${npub}`);
  return res.ok ? res.text() : null;
};

// What a save in the browser does to the site: one new blob, and a manifest
// that is the old table with that one path changed.
async function browserSave(path, html) {
  const bytes = Buffer.from(html);
  const auth = finalizeEvent({ kind: 24242, created_at: Math.floor(Date.now() / 1000), content: "Upload",
    tags: [["t", "upload"], ["x", hash(bytes)], ["expiration", String(Math.floor(Date.now() / 1000) + 600)]] }, sec);
  const res = await fetch(`${BLOSSOM}/upload`, { method: "PUT", body: bytes,
    headers: { Authorization: "Nostr " + Buffer.from(JSON.stringify(auth)).toString("base64"), "Content-Type": "text/html" } });
  if (!res.ok) throw new Error("upload failed");
  const prev = await manifest();
  const paths = Object.fromEntries(prev.tags.filter((x) => x[0] === "path").map((x) => [x[1], x[2]]));
  paths[path] = hash(bytes);
  const ev = finalizeEvent({ kind: 15128, created_at: prev.created_at + 1, content: "",
    tags: [...Object.entries(paths).map(([p, h]) => ["path", p, h]), ["server", BLOSSOM]] }, sec);
  await Promise.any(pool.publish([RELAY], ev));
  await tick();
}

const page = (path, title, body = "") => `<!doctype html>
<html lang="en" nc:owner="${npub}" nc:path="${path}" nc:edit-gate="hash"
      nc:relays="${RELAY}" nc:servers="${BLOSSOM}">
<head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/nsite-clay-base.css"></head>
<body><main><h1 editable="single-line">${title}</h1><div editable><p>${body || "Open on Saturdays."}</p></div></main>
<script src="/nsite-clay.js"></script><script src="/nsite-clay-chrome.js"></script></body></html>
`;

const dir = (name) => join(work, name);
const write = (name, files) => {
  mkdirSync(dir(name), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir(name), f), body);
  return dir(name);
};
const edit = (name, file, from, to) => {
  const p = join(dir(name), file);
  writeFileSync(p, readFileSync(p, "utf8").replace(from, to));
};

let bunker;
try {
  // --- a site, published the ordinary way --------------------------------------
  const original = write("original", {
    "index.html": page("/index.html", "Bakery"),
    "about.html": page("/about.html", "About us"),
    "nsite-clay.js": readFileSync(join(ROOT, "dist/nsite-clay.js")),
    "nsite-clay-chrome.js": readFileSync(join(ROOT, "templates/_shared/nsite-clay-chrome.js")),
    "nsite-clay-base.css": readFileSync(join(ROOT, "templates/_shared/nsite-clay-base.css")),
  });
  let r = await cli(["deploy", original, "--no-relay-list", ...pinned], withKey);
  t("a two-page site is deployed", r.status === 0, r.out);
  await tick();

  // A page made in the browser, which the directory has never seen.
  await browserSave("/notes.html", page("/notes.html", "Notes", "Written in the browser."));

  r = await cli(["deploy", original, "--no-relay-list", ...pinned], withKey);
  t("a deploy that would take down a page made in the browser refuses", r.status !== 0 && /\/notes\.html/.test(r.out) && /pull/.test(r.out), r.out);
  t("and publishes nothing", !!(await table())["/notes.html"]);

  // --- pull ---------------------------------------------------------------------
  r = await cli(["pull", npub, dir("pulled"), ...pinned]);
  t("pull downloads the site", r.status === 0, r.out);
  const live = await table();
  const missing = Object.entries(live).filter(([p, h]) => {
    const f = join(dir("pulled"), ...p.split("/").slice(1));
    return !existsSync(f) || hash(readFileSync(f)) !== h;
  });
  t("every path in the manifest is a file with the right bytes", missing.length === 0, JSON.stringify(missing));
  t("including the page made in the browser", existsSync(join(dir("pulled"), "notes.html")));
  const record = JSON.parse(readFileSync(join(dir("pulled"), ".nsite-clay.json"), "utf8"));
  t("and a record of where it came from", record.pubkey === pub && record.relays[0] === RELAY && record.servers[0] === BLOSSOM, JSON.stringify(record));

  r = await cli(["pull", npub, dir("pulled"), ...pinned]);
  t("pull will not write into a directory that has files in it", r.status !== 0 && /not empty/.test(r.out), r.out);

  r = await cli(["pull", `http://${npub}.localhost:${gatewayPort}/`, dir("by-address"), ...pinned]);
  t("a site's address works as well as its npub", r.status === 0 && existsSync(join(dir("by-address"), "about.html")), r.out);

  // --- edit and deploy back, with no flags: the record says where ----------------
  edit("pulled", "about.html", "Open on Saturdays.", "Open on Saturdays and Sundays.");
  r = await cli(["deploy", dir("pulled")], withKey);
  t("a pulled directory deploys back with no flags", r.status === 0, r.out);
  let now = await table();
  t("the edit is live", (await served("/about.html"))?.includes("Saturdays and Sundays"));
  t("the page made in the browser is still there", (await served("/notes.html"))?.includes("Written in the browser"));
  t("nothing else moved", Object.keys(now).sort().join() === Object.keys(live).sort().join(), `${Object.keys(live).sort()} -> ${Object.keys(now).sort()}`);
  t("no asset was stamped twice", !Object.keys(now).some((p) => /-[0-9a-f]{8}-[0-9a-f]{8}\./.test(p)), Object.keys(now).join(" "));
  t("the record follows the deploy", JSON.parse(readFileSync(join(dir("pulled"), ".nsite-clay.json"), "utf8")).paths["/about.html"] === now["/about.html"]);
  await tick();

  r = await cli(["deploy", dir("pulled")], withKey);
  t("deploying it again changes nothing", r.status === 0 && /unchanged/.test(r.out), r.out);

  // --- the browser saves while the directory is away ---------------------------
  await browserSave("/index.html", page("/index.html", "Bakery", "Saved in the browser after the pull."));
  await browserSave("/later.html", page("/later.html", "Later", "Added in the browser after the pull."));
  edit("pulled", "about.html", "and Sundays.", "and Sundays, from eight.");
  r = await cli(["deploy", dir("pulled")], withKey);
  t("a page changed only in the browser is kept, not reverted", r.status === 0 && (await served("/index.html"))?.includes("Saved in the browser"), r.out);
  t("and written into the directory, so the next deploy keeps it too", readFileSync(join(dir("pulled"), "index.html"), "utf8").includes("Saved in the browser"));
  t("a page added in the browser after the pull is kept", (await served("/later.html"))?.includes("Added in the browser"));
  t("and the edit made here is live", (await served("/about.html"))?.includes("from eight"));
  await tick();

  await browserSave("/about.html", page("/about.html", "About us", "Rewritten in the browser."));
  edit("pulled", "about.html", "from eight.", "from nine.");
  r = await cli(["deploy", dir("pulled")], withKey);
  t("a page changed in both places is a conflict, and nothing is published", r.status !== 0 && /\/about\.html/.test(r.out) && /pull/i.test(r.out) &&
    (await served("/about.html"))?.includes("Rewritten in the browser"), r.out);
  r = await cli(["deploy", dir("pulled"), "--overwrite"], withKey);
  t("--overwrite publishes this copy anyway", r.status === 0 && (await served("/about.html"))?.includes("from nine"), r.out);
  await tick();

  // --- what an agent gets wrong -------------------------------------------------
  writeFileSync(join(dir("pulled"), "menu.html"), readFileSync(join(dir("pulled"), "about.html"), "utf8"));
  r = await cli(["deploy", dir("pulled")], withKey);
  t("a new page that kept its source's nc:path is refused", r.status !== 0 && /menu\.html.*nc:path="\/about\.html"/s.test(r.out), r.out);
  edit("pulled", "menu.html", 'nc:path="/about.html"', 'nc:path="/menu.html"');
  r = await cli(["deploy", dir("pulled")], withKey);
  t("and published once it has its own", r.status === 0 && (await served("/menu.html")) !== null, r.out);
  await tick();

  unlinkSync(join(dir("pulled"), "notes.html"));
  r = await cli(["deploy", dir("pulled")], withKey);
  t("a page deleted from a pulled directory comes out of the site", r.status === 0 && !(await table())["/notes.html"] && !!(await table())["/later.html"], r.out);
  await tick();

  const engine = readdirSync(dir("pulled")).filter((f) => /^nsite-clay(-[0-9a-f]{8})+\.js$/.test(f));
  for (const f of engine) unlinkSync(join(dir("pulled"), f));
  unlinkSync(join(dir("pulled"), "nsite-clay.js"));
  r = await cli(["deploy", dir("pulled")], withKey);
  t("a deploy that would leave pages without their engine refuses", r.status !== 0 && /runtime file/.test(r.out), r.out);
  rmSync(dir("pulled"), { recursive: true });

  const stranger = generateSecretKey();
  r = await cli(["pull", npub, dir("again"), ...pinned]);
  r = await cli(["deploy", dir("again")], { NOSTR_SECRET_KEY: nip19.nsecEncode(stranger) });
  t("a pulled site cannot be deployed by another key", r.status !== 0 && /pulled from/.test(r.out), r.out);

  // --- a bunker whose link works once -------------------------------------------
  bunker = await startBunker({ relay: RELAY, secretKey: sec });
  const link = bunker.uri();
  r = await cli(["whoami", dir("again")], { NOSTR_BUNKER_URI: link });
  t("whoami connects with the link and names the key", r.status === 0 && r.out.includes(npub), r.out);
  const saved = JSON.parse(readFileSync(join(config, "nsite-clay", "bunkers.json"), "utf8"))[bunker.signerPub];
  t("and saves the connection, with the bunker's relays", saved?.userPubkey === pub && saved.relays?.[0] === RELAY, JSON.stringify(saved));

  edit("again", "about.html", "from nine.", "from ten.");
  r = await cli(["deploy", dir("again")]);
  t("a later deploy needs no link: the saved connection is found by the site's owner", r.status === 0 && (await served("/about.html"))?.includes("from ten"), r.out);
  t("with no request refused on the way", bunker.stats.refused === 0, JSON.stringify(bunker.stats));
  await tick();

  r = await cli(["whoami", dir("again")], { NOSTR_BUNKER_URI: link });
  t("the spent link still works on the machine that saved the connection", r.status === 0 && r.out.includes(npub), r.out);
  r = await cli(["whoami"], { NOSTR_BUNKER_URI: link, XDG_CONFIG_HOME: join(work, "elsewhere") });
  t("but not from anywhere else, and it says the link is single use", r.status !== 0 && /single use/.test(r.out), r.out);

  // --- a directory that did not come from pull ------------------------------------
  await tick();
  const lone = write("lone", { "index.html": page("/index.html", "Bakery", "Only the home page here."),
    "nsite-clay.js": readFileSync(join(ROOT, "dist/nsite-clay.js")),
    "nsite-clay-chrome.js": readFileSync(join(ROOT, "templates/_shared/nsite-clay-chrome.js")),
    "nsite-clay-base.css": readFileSync(join(ROOT, "templates/_shared/nsite-clay-base.css")) });
  const before = Object.keys(await table()).filter((p) => p.endsWith(".html")).sort();
  r = await cli(["deploy", lone, "--no-relay-list", "--keep-missing", ...pinned], withKey);
  const kept = Object.keys(await table()).filter((p) => p.endsWith(".html")).sort();
  t("--keep-missing publishes the directory and keeps the pages it lacks", r.status === 0 && kept.join() === before.join() &&
    (await served("/index.html"))?.includes("Only the home page"), r.out);
  await tick();
  r = await cli(["deploy", lone, "--no-relay-list", "--prune", ...pinned], withKey);
  t("--prune takes them down", r.status === 0 && Object.keys(await table()).filter((p) => p.endsWith(".html")).join() === "/index.html", r.out);
} finally {
  bunker?.close();
  pool.close([RELAY]);
  devnet.kill();
  rmSync(work, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
