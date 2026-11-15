#!/usr/bin/env node
// nsite-artifacts: publish a page an agent made, read back what people did to
// it, and take it down when it is no longer needed.
//
// An artifact is one nsite under its own freshly made key. The model writes
// plain HTML and never touches a key or a cipher: this tool makes the key,
// encrypts the page when it is not public, publishes it, remembers the key in
// a ledger, and hands back the link to send.
//
//   create <file.html>   publish a page             -> links
//   list-page            write a checklist page from a title and items
//   read <id>            the page as it is now      -> text, html or json
//   status <id>          has anybody saved it since I last read it?
//   update <id> <file>   publish new content under the same link
//   share <id>           give one more key access
//   rekey <id>           move to a new key and link (the way to remove someone)
//   list                 everything in the ledger
//   delete <id>          take it down now
//   sweep                take down everything past its expiry
//
// Everything prints one JSON object on stdout. Errors go to stderr with a
// non-zero exit, and never include a key.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeEvent, getPublicKey, nip19, SimplePool, verifyEvent } from "nostr-tools";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { parse, serialize } from "parse5";
import WebSocket from "ws";
import {
  assertShell, b64u, buildShell, keysFrom, newSecret, openText, parseShell, sealText, shellPolicy, unb64u, wrapFor,
} from "../src/seal.js";

if (typeof globalThis.WebSocket === "undefined") useWebSocketImplementation(WebSocket);

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------- configuration

// Set by main(), so the same file is the `nsite-clay artifact` subcommand and
// the one-file script the agent skill ships.
let cmd = "help", positional = [], flags = {};
function parseArgs(argv) {
  cmd = argv.find((a) => !a.startsWith("--")) || "help";
  positional = argv.filter((a) => !a.startsWith("--")).slice(1);
  flags = {};
  for (const a of argv.filter((x) => x.startsWith("--"))) {
    const i = a.indexOf("=");
    const [k, v] = i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
    flags[k] = k in flags ? [].concat(flags[k], v) : v;       // --member may repeat
  }
}
const many = (v) => (v == null || v === true ? [] : [].concat(v).flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean));
const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };

const HOME = process.env.NSITE_ARTIFACTS_HOME ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "nsite-clay", "artifacts");
const LEDGER = join(HOME, "ledger.json");

// Settings come from flags, then the environment, then a config file next to
// the ledger, then the public defaults. The config file is how a person points
// every artifact their agent makes at their own relay, Blossom server and
// gateway once, without the agent having to know.
function settings() {
  let file = {};
  try { file = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8")); } catch { /* none */ }
  const pick = (flag, env, key, fallback) =>
    many(flags[flag]).length ? many(flags[flag]) : process.env[env] ? many(process.env[env]) : file[key] || fallback;
  return {
    relays: pick("relays", "NSITE_ARTIFACTS_RELAYS", "relays",
      // strfry relays that list NIP-40, so an expiry is honoured there. The
      // first is the one nsite.lol reads live.
      ["wss://relay.nsite.lol", "wss://relay.primal.net", "wss://relay.damus.io", "wss://relay.nostr.net"]),
    // The servers that, tried on 2026-11-13, took an HTML page from a key with
    // no history, served it back, accepted a browser's upload and really
    // deleted it when asked. Several others refuse one of those.
    servers: pick("servers", "NSITE_ARTIFACTS_SERVERS", "servers",
      ["https://nostr.download", "https://blossom.yakihonne.com", "https://blossom.data.haus"]),
    // {host} is the artifact's npub (or its base36 name). One gateway serves
    // every artifact; which one a link points at is only a matter of the link.
    gateway: one(flags.gateway) || process.env.NSITE_ARTIFACTS_GATEWAY || file.gateway || "https://{host}.nsite.lol",
    // Where the runtime comes from: a directory holding nsite-clay.js, or the
    // nsite of the key that publishes it.
    // Run from the nsite-clay package, the runtime is the one that came with it.
    runtime: one(flags.runtime) || process.env.NSITE_ARTIFACTS_RUNTIME || file.runtime ||
      (existsSync(join(HERE, "..", "dist", "nsite-clay.js")) ? join(HERE, "..") : null),
    runtimeOwner: file.runtimeOwner || "npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2",
    // A key that pays for, or is allowed on, the Blossom servers. Blob uploads
    // are authorised by whoever signs the upload, which need not be the key
    // that signs the manifest, so one allow-listed key can carry the bytes of
    // every artifact. Unset, each artifact's own key uploads its own.
    uploader: process.env.NSITE_ARTIFACTS_UPLOADER || file.uploader || null,
    defaults: { visibility: "link", edit: "none", expires: "30d", ...(file.defaults || {}) },
    // Set to false by a person who never wants their agent to publish in the
    // clear. No flag overrides it: it is changed in the file or not at all.
    allowPublic: file.allowPublic !== false,
  };
}

// ------------------------------------------------------------------- ledger

// The ledger is the agent's memory of what it made and the only copy of each
// artifact's key outside the links it handed out. Mode 600, written whole and
// renamed into place so a crash cannot leave half of one.
function readLedger() {
  try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return { v: 1, artifacts: {} }; }
}
function writeLedger(ledger) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const tmp = LEDGER + ".tmp";
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  renameSync(tmp, LEDGER);
  chmodSync(LEDGER, 0o600);
}
function entryOf(ledger, id) {
  if (!id) fail("which artifact? Give its id (see: list)");
  const hit = ledger.artifacts[id] ||
    Object.values(ledger.artifacts).find((a) => a.npub === id || a.url === id.split("#")[0] || a.id.startsWith(id));
  if (!hit) fail(`no artifact "${id}" in ${LEDGER}`);
  return hit;
}

// ------------------------------------------------------------------- helpers

const now = () => Math.floor(Date.now() / 1000);
const hashOf = (bytes) => bytesToHex(sha256(bytes));
const enc = new TextEncoder();
const norm = (u) => String(u).trim().replace(/\/+$/, "");
const TIMEOUT = { head: 15000, get: 30000, put: 60000, relay: 8000 };
const until = (ms) => ({ signal: AbortSignal.timeout(ms) });

function toHex(key) {
  const k = String(key).trim();
  if (/^[0-9a-f]{64}$/i.test(k)) return k.toLowerCase();
  try { const d = nip19.decode(k); if (d.type === "npub") return d.data; if (d.type === "nprofile") return d.data.pubkey; } catch { /* below */ }
  fail(`not a public key: ${k}`);
}

function parseExpiry(text) {
  if (!text || text === "never" || text === "none") return null;
  const m = /^(\d+)\s*(m|h|d|w)$/.exec(String(text));
  if (m) return now() + Number(m[1]) * { m: 60, h: 3600, d: 86400, w: 604800 }[m[2]];
  const t = Date.parse(text);
  if (Number.isNaN(t)) fail(`--expires takes 30d, 12h, 2w, a date like 2026-12-24, or "never": ${text}`);
  return Math.floor(t / 1000);
}

function siteUrl(cfg, pubkey) {
  return cfg.gateway.replace("{host}", nip19.npubEncode(pubkey)).replace("{hex}", pubkey).replace(/\/+$/, "") + "/";
}

// A fresh pool per command; every command is short.
async function withPool(fn) {
  const pool = new SimplePool();
  try { return await fn(pool); } finally { try { pool.destroy?.(); } catch { /* closing */ } }
}

async function publish(pool, relays, event) {
  const sent = await Promise.allSettled(pool.publish(relays, event, { maxWait: TIMEOUT.relay }));
  return relays.filter((_, i) => sent[i].status === "fulfilled");
}

// Every relay is asked by itself, and the answer is taken a moment after the
// first one that has anything, so a relay that is down costs a second and not
// the whole timeout.
async function ask(pool, relays, filter, { grace = 1200 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    let left = relays.length, timer = null;
    const done = () => { clearTimeout(timer); resolve([...found.values()]); };
    for (const r of relays) {
      pool.querySync([r], filter, { maxWait: TIMEOUT.relay }).catch(() => []).then((events) => {
        for (const ev of events) if (verifyEvent(ev)) found.set(ev.id, ev);
        if (--left === 0) return done();
        if (events.length && !timer) timer = setTimeout(done, grace);
      });
    }
  });
}

async function newest(pool, relays, filter) {
  return (await ask(pool, relays, filter)).sort((a, b) => b.created_at - a.created_at)[0] || null;
}

// ------------------------------------------------------------------ blossom

async function held(server, hash) {
  try {
    let res = await fetch(`${norm(server)}/${hash}`, { method: "HEAD", ...until(TIMEOUT.head) });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(`${norm(server)}/${hash}`, { headers: { Range: "bytes=0-0" }, ...until(TIMEOUT.head) });
    }
    return res.ok || res.status === 206;
  } catch { return false; }
}

function blossomAuth(sk, verb, hash, expiration) {
  const ev = finalizeEvent({
    kind: 24242, created_at: now(), content: verb === "delete" ? "Delete artifact file" : "Upload artifact file",
    tags: [["t", verb], ["x", hash], ["expiration", String(now() + 600)]],
  }, sk);
  const raw = Buffer.from(JSON.stringify(ev));
  // BUD-11 says base64url without padding; part of the fleet wants standard.
  return [raw.toString("base64url"), raw.toString("base64")].map((b) => "Nostr " + b);
}

async function putBlob(server, bytes, type, sk, expires) {
  const hash = hashOf(bytes);
  let last = "";
  for (const auth of blossomAuth(sk, "upload", hash)) {
    try {
      const res = await fetch(`${norm(server)}/upload`, {
        method: "PUT", body: bytes, ...until(TIMEOUT.put),
        headers: {
          Authorization: auth, "Content-Type": type,
          // Not in any merged BUD (hzrd149/blossom issue 115). A server that
          // knows it may drop the blob then; one that does not ignores it.
          ...(expires ? { "X-Expiration": String(expires) } : {}),
        },
      });
      if (res.ok) return true;
      last = `${res.status} ${res.headers.get("x-reason") || (await res.text().catch(() => ""))}`.trim().slice(0, 200);
      if (![400, 401].includes(res.status)) break;
    } catch (e) { last = e?.name === "TimeoutError" ? "no answer" : e?.message || String(e); break; }
  }
  throw new Error(`${server}: ${last}`);
}

// Every server gets the blob; one is enough to be published.
async function store(servers, bytes, type, sk, expires) {
  const hash = hashOf(bytes);
  const results = await Promise.all(servers.map(async (s) => {
    if (await held(s, hash)) return { server: s, ok: true };
    try { await putBlob(s, bytes, type, sk, expires); return { server: s, ok: true }; }
    catch (e) { return { server: s, ok: false, why: e.message }; }
  }));
  if (!results.some((r) => r.ok)) fail("no Blossom server accepted the page:\n  " + results.map((r) => r.why).join("\n  "));
  return { hash, on: results.filter((r) => r.ok).map((r) => r.server), refused: results.filter((r) => !r.ok).map((r) => r.why) };
}

async function fetchBlob(servers, hash) {
  for (const s of servers) {
    try {
      const res = await fetch(`${norm(s)}/${hash}`, until(TIMEOUT.get));
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (hashOf(bytes) === hash) return bytes;
    } catch { /* the next server */ }
  }
  fail(`no server has ${hash.slice(0, 12)}… any more`);
}

async function dropBlob(servers, hash, sk) {
  const out = [];
  for (const s of servers) {
    let state = "refused";
    for (const auth of blossomAuth(sk, "delete", hash)) {
      try {
        const res = await fetch(`${norm(s)}/${hash}`, { method: "DELETE", headers: { Authorization: auth }, ...until(TIMEOUT.put) });
        if (res.ok) { state = "deleted"; break; }
        if (res.status === 404) { state = "gone"; break; }
        if (![400, 401].includes(res.status)) break;
      } catch { break; }
    }
    out.push({ server: s, state });
  }
  return out;
}

// ------------------------------------------------------------------ runtime

const RUNTIME_FILES = { "/nsite-clay.js": "text/javascript", "/nsite-clay-source.js": "text/javascript",
  "/nsite-clay-base.css": "text/css", "/nsite-clay-chrome.js": "text/javascript" };

// The page links its runtime from its own root, so the artifact's manifest has
// to name those files. Their blobs are the same for every artifact, so after
// the first one this uploads nothing: the servers already hold them.
async function runtimeFiles(cfg, pool, html, sealed) {
  const wanted = Object.keys(RUNTIME_FILES).filter((p) => html.includes(p) || p === "/nsite-clay.js");
  if (cfg.runtime) {
    return wanted.map((p) => {
      const file = [join(cfg.runtime, p), join(cfg.runtime, "dist", p), join(cfg.runtime, "templates", "_shared", p)].find(existsSync);
      if (!file) fail(`the runtime directory ${cfg.runtime} has no ${p.slice(1)}`);
      return { path: p, bytes: new Uint8Array(readFileSync(file)), type: RUNTIME_FILES[p] };
    });
  }
  // Straight from the project's own nsite, the same place a published page
  // reads its upgrades from. The manifest is signed and every blob is checked
  // against the hash it names, so neither the relay nor the server is trusted.
  const owner = toHex(cfg.runtimeOwner);
  const lookup = [...new Set([...cfg.relays, "wss://relay.nsite.lol", "wss://relay.primal.net"])];
  const manifest = await newest(pool, lookup, { kinds: [15128], authors: [owner] });
  if (!manifest) fail("could not find the nsite-clay runtime on the relays. Pass --runtime=<dir> with nsite-clay.js in it.");
  const table = Object.fromEntries(manifest.tags.filter((t) => t[0] === "path").map((t) => [t[1], t[2]]));
  const from = [...new Set([...manifest.tags.filter((t) => t[0] === "server").map((t) => t[1]), ...cfg.servers])];
  const files = wanted.map((p) => {
    if (!table[p]) fail(`the published runtime has no ${p}`);
    return { path: p, hash: table[p], type: RUNTIME_FILES[p], fetch: () => fetchBlob(from, table[p]) };
  });
  // A runtime from before sealed pages existed would serve the shell and never
  // open it. Checked once per runtime build and remembered.
  if (sealed) {
    const engine = files.find((f) => f.path === "/nsite-clay.js");
    const okFile = join(HOME, "runtime-ok.json");
    let ok = [];
    try { ok = JSON.parse(readFileSync(okFile, "utf8")); } catch { /* none yet */ }
    if (!ok.includes(engine.hash)) {
      const text = new TextDecoder().decode(await engine.fetch());
      if (!text.includes("application/nc-sealed")) {
        fail("the published nsite-clay runtime cannot open encrypted pages yet. Use a newer one: " +
          "--runtime=<directory with nsite-clay.js>, or \"runtime\" in the settings file.");
      }
      mkdirSync(HOME, { recursive: true, mode: 0o700 });
      writeFileSync(okFile, JSON.stringify([...ok, engine.hash].slice(-20)));
    }
  }
  return files;
}

// ----------------------------------------------------------------- the page

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// What the tool decides and the model does not: whose page this is and where
// it lives. Whatever the file said about those is replaced.
function stampPage(html, { npub, relays, servers, edit, comments }) {
  if (!/<html\b/i.test(html)) fail("that file is not an HTML document: it has no <html> element");
  // Comments are for pages somebody can change: a comment is saved with the page.
  const withComments = comments !== false && edit !== "none";
  let out = html.replace(/<html\b([^>]*)>/i, (_, attrs) => {
    const kept = attrs.replace(/\s+nc:(owner|site|path|relays|servers|sealed|expires)(="[^"]*")?/g, "");
    const has = /\bnc:comments\b/.test(kept);
    return `<html${kept}${withComments && !has ? " nc:comments" : ""} nc:owner="${npub}" nc:path="/index.html" nc:relays="${relays.join(",")}" nc:servers="${servers.join(",")}">`;
  });
  if (!/<script\b[^>]*\bsrc\s*=\s*["']?\/nsite-clay(-[0-9a-f]{8})?\.js/i.test(out)) {
    const tag = `<script src="/nsite-clay.js"></script>`;
    out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, tag + "\n</head>") : out.replace(/<html\b[^>]*>/i, (m) => m + tag);
  }
  return out;
}

// A page can be opened with an edit link and still have nothing in it to change:
// the runtime only lets people type into what is marked editable, and into fields
// and boxes a page draws itself. An agent that forgets this sends an edit link and
// the person finds a page they cannot touch. Said when the page is made.
function editHint(html, { edit, comments }) {
  if (edit === "none") return null;
  const editable = /<[a-z][^>]*[\s"']editable(?=[\s=>\/])/i.test(html) || /\scontenteditable\b/i.test(html);
  const fields = /<(input|textarea|select)\b/i.test(html) || /\bnc\.state\b/.test(html);
  if (editable || fields) return null;
  return comments === false
    ? "this page has no editable text, boxes or fields, and comments are off, so its edit link lets nobody change anything. Mark the text people may change with editable (editable=\"single-line\" on a heading or a row, editable on a container of paragraphs), or leave --no-comments off so they can comment."
    : "this page has no editable text, boxes or fields, so its edit link only lets people leave comments. That is right for a draft to review. If they should change the words themselves, mark them with editable (editable=\"single-line\" on a heading or a row, editable on a container of paragraphs).";
}

// Anything a sealed page would load from somewhere else. The shell's policy
// blocks all of it, so say so now, while the model can still fix the page.
function foreignLoads(html) {
  const found = new Set();
  for (const m of html.matchAll(/<(?:script|link|img|iframe|video|audio|source)\b[^>]*?\b(?:src|href)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi)) {
    try { found.add(new URL(m[1], "https://x").origin); } catch { /* not a URL */ }
  }
  for (const m of html.matchAll(/@import\s+(?:url\()?["']?((?:https?:)?\/\/[^"')\s]+)/gi)) {
    try { found.add(new URL(m[1], "https://x").origin); } catch { /* not a URL */ }
  }
  return [...found];
}

async function sealPage(html, a, keys) {
  const where = { owner: a.pubkey, site: "", path: "/index.html" };
  const sealed = await sealText(html, keys.K, where);
  const engine = /<script\b[^>]*\bsrc\s*=\s*["']?(\/nsite-clay(?:-[0-9a-f]{8})?\.js)/i.exec(html)[1];
  const shell = buildShell({
    owner: a.npub, relays: a.relays, servers: a.servers,
    lang: /<html\b[^>]*\blang="([^"]*)"/i.exec(html)?.[1] || "en",
    title: a.shellTitle || "Private page", policy: a.policy,
    head: `<script src="${engine}" nc:shell></script>`,
    sealed, expires: a.expires || null,
    wraps: (a.members || []).map((m) => wrapFor(keys.sk, m.pubkey, m.role, keys.K)),
  });
  assertShell(shell);
  return shell;
}

// The page as it is published now: the manifest, the bytes, and for a sealed
// page the text inside.
async function fetchPage(pool, a, keys) {
  const manifest = await newest(pool, a.relays, { kinds: [15128], authors: [a.pubkey] });
  if (!manifest) fail(`no relay has ${a.id} any more. It may have expired or been deleted.`);
  const table = Object.fromEntries(manifest.tags.filter((t) => t[0] === "path").map((t) => [t[1], t[2]]));
  const hash = table["/index.html"];
  if (!hash) fail(`${a.id} has no page any more (it was deleted)`);
  const text = new TextDecoder().decode(await fetchBlob(a.servers, hash));
  const shell = parseShell(text);
  // The ledger says whether this artifact is sealed, not the bytes that came
  // back. A plain page where a sealed one should be is a fault, not content.
  if (a.sealed && !shell) fail(`${a.id} is a sealed artifact, but what is published is not sealed. Not reading it.`);
  const html = shell ? await openText(shell.sealed, keys.K, { owner: a.pubkey, site: "", path: "/index.html" }) : text;
  return { manifest, table, hash, html, shell };
}

// The runtime files a page links, on the artifact's own servers. Their blobs
// are the same for every artifact, so after the first one this uploads nothing.
async function putRuntime(pool, a, html, cfg, uploader) {
  const paths = {};
  for (const f of await runtimeFiles(cfg, pool, html, a.sealed)) {
    const hash = f.hash || hashOf(f.bytes);
    const missing = (await Promise.all(a.servers.map(async (s) => ((await held(s, hash)) ? null : s)))).filter(Boolean);
    if (missing.length) {
      const bytes = f.bytes || await f.fetch();
      const sent = await Promise.allSettled(missing.map((s) => putBlob(s, bytes, f.type, uploader)));
      if (missing.length === a.servers.length && !sent.some((r) => r.status === "fulfilled")) {
        fail(`no Blossom server accepted ${f.path}: ${sent[0].reason?.message}`);
      }
    }
    paths[f.path] = hash;
  }
  return paths;
}

async function putPage(pool, a, keys, html, cfg, { live = null, table = null } = {}) {
  const sk = keys.sk;
  const body = enc.encode(a.sealed ? await sealPage(html, a, keys) : html);
  const uploader = cfg.uploader ? nip19.decode(cfg.uploader).data : sk;
  const page = await store(a.servers, body, "text/html", uploader, a.expires);

  const paths = { ...(table || await putRuntime(pool, a, html, cfg, uploader)) };
  const before = paths["/index.html"];
  paths["/index.html"] = page.hash;
  const out = await publishTable(pool, a, sk, paths, live);
  // An artifact keeps no history: the version this one replaces is deleted,
  // so a list ticked a hundred times is one blob and not a hundred.
  if (before && before !== page.hash) {
    const signers = [...new Set([uploader, sk])];
    for (const by of signers) {
      const rows = await dropBlob(a.servers, before, by);
      if (rows.every((r) => r.state !== "refused")) break;
    }
  }
  return { hash: page.hash, ...out, servers: page.on, refused: page.refused };
}

// One manifest naming `paths`, newer than `live`. No version snapshot: an
// artifact keeps only its current version.
async function publishTable(pool, a, sk, paths, live) {
  const lines = Object.entries(paths).map(([p, h]) => `${h} ${p}\n`).sort().join("");
  const expiration = a.expires ? [["expiration", String(a.expires)]] : [];
  const tags = [
    ...Object.entries(paths).map(([p, h]) => ["path", p, h]),
    ["x", hashOf(enc.encode(lines)), "aggregate"],
    ...a.servers.map((s) => ["server", s]),
    // A sealed page publishes nothing about itself: no title, no description.
    ...(a.sealed ? [["sealed", "1"]] : a.title ? [["title", a.title]] : []),
    ...expiration,
  ];
  const created_at = Math.max(now(), (live?.created_at ?? 0) + 1);
  const manifest = finalizeEvent({ kind: 15128, created_at, tags, content: "" }, sk);
  const took = await publish(pool, a.relays, manifest);
  if (!took.length) fail("no relay accepted the page's manifest");
  if (!live) {
    // Gateways other than nsite.lol find a site through its key's relay list,
    // and a key made a moment ago has none.
    const list = finalizeEvent({ kind: 10002, created_at, content: "",
      tags: [...a.relays.filter((r) => !/relay\.nsite\.lol/.test(r)).map((r) => ["r", r]), ...expiration] }, sk);
    await publish(pool, [...new Set([...a.relays, ...(a.relays.every((r) => /\/\/(127\.0\.0\.1|localhost)/.test(r)) ? [] : ["wss://purplepag.es", "wss://user.kindpag.es"])])], list);
  }
  return { manifest, relays: took };
}

// ------------------------------------------------------- the page, as text

// What a person would read off the page, with every checkbox as [x] or [ ].
// An agent asking "what did they tick" wants this, not two hundred lines of
// markup, and comparing two of these is how it sees what changed.
function digest(html) {
  const lines = [];
  let line = "";
  const flush = () => { const t = line.replace(/\s+/g, " ").trim(); if (t) lines.push(t); line = ""; };
  const BLOCK = new Set(["p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article",
    "header", "footer", "main", "form", "table", "br", "hr", "blockquote", "pre", "dt", "dd", "label", "details", "summary"]);
  const SKIP = new Set(["script", "style", "template", "head", "noscript", "svg", "button", "menu", "dialog"]);
  const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
  const has = (node, name) => node.attrs?.some((a) => a.name === name);
  const walk = (node) => {
    if (node.nodeName === "#text") { line += node.value; return; }
    const tag = node.tagName;
    if (!tag) { for (const c of node.childNodes || []) walk(c); return; }
    if (SKIP.has(tag) && tag !== "head") return;
    if (tag === "head") return;
    // The comments are read with `comments`, not as a part of the page's words.
    if (tag === "aside" && has(node, "nc:comments")) return;
    if (BLOCK.has(tag)) flush();
    if (/^h[1-6]$/.test(tag)) line += "#".repeat(Number(tag[1])) + " ";
    if (tag === "li" && !(node.childNodes || []).some((c) => c.tagName === "input")) line += "- ";
    if (tag === "input") {
      const type = (attr(node, "type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") line += has(node, "checked") ? "[x] " : "[ ] ";
      else if (!has(node, "nc:no-persist") && type !== "password" && type !== "hidden" && attr(node, "value")) {
        line += `${attr(node, "name") || attr(node, "aria-label") || "field"}: ${attr(node, "value")} `;
      }
      return;
    }
    if (tag === "select") {
      const chosen = [];
      const find = (n) => { if (n.tagName === "option" && has(n, "selected")) chosen.push((n.childNodes || []).map((c) => c.value || "").join("")); for (const c of n.childNodes || []) find(c); };
      find(node);
      line += `${attr(node, "name") || "choice"}: ${chosen.join(", ")} `;
      return;
    }
    for (const c of node.childNodes || []) walk(c);
    if (tag === "a" && attr(node, "href") && /^https?:/.test(attr(node, "href"))) line += ` (${attr(node, "href")})`;
    if (BLOCK.has(tag)) flush();
  };
  walk(parse(html));
  flush();
  return lines.join("\n");
}

// Line by line, in order, which is all a list needs.
function changes(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  const bare = (l) => l.replace(/^\[[ x]\] /, "");
  const was = new Map(a.map((l) => [bare(l), l]));
  const is = new Map(b.map((l) => [bare(l), l]));
  const out = [];
  for (const l of b) {
    const old = was.get(bare(l));
    if (old === undefined) out.push({ change: "added", line: l });
    else if (old !== l) out.push({ change: l.startsWith("[x]") ? "checked" : "unchecked", line: bare(l) });
  }
  for (const l of a) if (!is.has(bare(l))) out.push({ change: "removed", line: l });
  return out;
}

// What the page is made of, line by line, in the order it appears: the words,
// ticks and fields of `digest`, and nothing that only the browser's editor adds.
// A person may have changed the page with the ordinary editing tools, so
// "what did they do" is answered from a copy of the page as it was last read,
// kept here, and not from anything the page says about itself.
function diffOps(a, b) {
  // Myers' O(ND) shortest edit script, so a long page with a short edit is quick.
  const n = a.length, m = b.length, max = n + m, off = max;
  let v = new Int32Array(2 * max + 2), trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, off, d);
    }
  }
  return [];
}
function backtrack(trace, a, b, off, dEnd) {
  const ops = [];
  let x = a.length, y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d], k = x - y;
    const prevK = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? k + 1 : k - 1;
    const prevX = v[off + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push([" ", a[x - 1]]); x--; y--; }
    if (x === prevX) ops.push(["+", b[y - 1]]); else ops.push(["-", a[x - 1]]);
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { ops.push([" ", a[x - 1]]); x--; y--; }
  return ops.reverse();
}

// One tag to a line, so a diff of a page saved on a single line still says where.
const lined = (html) => serialize(parse(html)).replace(/>\s*</g, ">\n<").replace(/\r/g, "").split("\n").filter((l) => l.trim());

/** A unified diff of two pages: `-` was there, `+` is there now. */
function unifiedDiff(beforeHtml, afterHtml, { context = 2, limit = 24000 } = {}) {
  const ops = diffOps(lined(beforeHtml), lined(afterHtml));
  const out = [];
  let added = 0, removed = 0;
  const keep = new Array(ops.length).fill(false);
  ops.forEach(([t], i) => {
    if (t === " ") return;
    t === "+" ? added++ : removed++;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  });
  let gap = false, size = 0, truncated = false;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) { gap = true; continue; }
    if (gap && out.length) out.push("@@");
    gap = false;
    const line = ops[i][0] + ops[i][1].slice(0, 400);
    size += line.length + 1;
    if (size > limit) { truncated = true; break; }
    out.push(line);
  }
  return { added, removed, diff: out.join("\n"), ...(truncated ? { truncated: true } : {}) };
}

// ----------------------------------------------------------- comments on a page

const BLOCKS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "figcaption", "blockquote", "dd", "dt", "label", "pre", "summary", "div", "section", "article", "main"]);
const textOfNode = (n) => n.nodeName === "#text" ? n.value : (n.childNodes || []).map(textOfNode).join("");
const squash = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Every comment on a page, as the page's own runtime wrote it (see
 * src/comments.js): who, when, what was selected, what they said, the replies,
 * and where in the page the words sit, so an agent can act on a comment without
 * reading the whole page to find it.
 */
function commentsOf(html) {
  const found = [], anchors = new Map(), order = [];
  const attr = (n, k) => n.attrs?.find((a) => a.name === k)?.value;
  const walk = (n) => {
    if (n.tagName) {
      order.push(n);
      if (n.tagName === "article" && attr(n, "nc:comment") != null && n.parentNode?.tagName === "aside" && attr(n.parentNode, "nc:comments") != null) found.push(n);
      for (const id of (attr(n, "nc:c") || "").split(/\s+/).filter(Boolean)) {
        if (!anchors.has(id)) anchors.set(id, []);
        anchors.get(id).push(n);
      }
    }
    for (const c of n.childNodes || []) walk(c);
  };
  walk(parse(html));
  const headingBefore = (node) => {
    const at = order.indexOf(node);
    for (let i = at; i >= 0; i--) if (/^h[1-6]$/.test(order[i].tagName) && !order[i].parentNode?.attrs?.some((a) => a.name === "nc:comments")) return squash(textOfNode(order[i])).slice(0, 120);
    return "";
  };
  return found.map((art) => {
    const id = attr(art, "nc:comment");
    const kids = (art.childNodes || []).filter((c) => c.tagName);
    const first = anchors.get(id)?.[0];
    let block = first;
    while (block && !BLOCKS.has(block.tagName)) block = block.parentNode;
    return {
      id,
      state: attr(art, "nc:state") === "resolved" ? "resolved" : "open",
      by: attr(art, "nc:by") || "",
      ...(attr(art, "nc:pk") ? { npub: attr(art, "nc:pk") } : {}),
      at: attr(art, "nc:at") || "",
      quote: squash(kids.filter((c) => c.tagName === "blockquote").map(textOfNode).join(" ")),
      text: kids.filter((c) => c.tagName === "p" && attr(c, "nc:text") != null).map(textOfNode).join("\n").trim(),
      replies: kids.filter((c) => c.tagName === "p" && attr(c, "nc:reply") != null)
        .map((r) => ({ by: attr(r, "nc:by") || "", at: attr(r, "nc:at") || "", text: textOfNode(r).trim() })),
      anchored: !!first,
      ...(first ? { where: { heading: headingBefore(first), block: squash(textOfNode(block || first)).slice(0, 240) } } : {}),
    };
  });
}

const seenFile = (a) => join(HOME, "seen", a.id + ".txt");
const seenHtmlFile = (a) => join(HOME, "seen", a.id + ".html");
function remember(a, text, html) {
  mkdirSync(join(HOME, "seen"), { recursive: true, mode: 0o700 });
  writeFileSync(seenFile(a), text, { mode: 0o600 });
  if (html != null) writeFileSync(seenHtmlFile(a), html, { mode: 0o600 });
}
function seenHtml(a) { try { return readFileSync(seenHtmlFile(a), "utf8"); } catch { return null; } }

// ----------------------------------------------------------------- commands

function linksOf(a, keys) {
  const read = a.sealed ? `${a.url}#k=${b64u(keys.K)}` : a.url;
  const edit = `${a.url}#e=${b64u(keys.sk)}`;
  // The one link to send, by what the artifact was made for. A private
  // artifact is opened by signing in, so its link carries no key at all.
  const share = a.visibility === "private" ? a.url : a.edit === "link" ? edit : read;
  return { url: a.url, link: share, readLink: a.visibility === "private" ? null : read, editLink: a.edit === "link" ? edit : null };
}

async function create(file, opts = {}) {
  const cfg = settings();
  if (!file) fail("usage: create <file.html> [--visibility=public|link|private] [--edit=none|link|members] [--member=npub…] [--expires=30d] [--title=…]");
  const visibility = opts.visibility || one(flags.visibility) || cfg.defaults.visibility;
  const edit = opts.edit || one(flags.edit) || cfg.defaults.edit;
  if (!["public", "link", "private"].includes(visibility)) fail("--visibility is public, link or private");
  if (!["none", "link", "members"].includes(edit)) fail("--edit is none, link or members");
  if (visibility === "private" && edit === "link") fail("a private artifact has no link that opens it, so it cannot have an edit link. Use --edit=members, or --visibility=link.");
  const members = (opts.members || [
    ...many(flags.member).map((m) => ({ pubkey: toHex(m), role: edit === "none" ? "read" : "edit" })),
    ...many(flags["member-read"]).map((m) => ({ pubkey: toHex(m), role: "read" })),
  ]);
  if (visibility === "private" && !members.length) fail("a private artifact opens only for its members. Add --member=<npub> for each person, or use --visibility=link.");
  if (edit === "members" && !members.some((m) => m.role === "edit")) fail("--edit=members needs at least one --member=<npub>");

  const sk = opts.sk || newSecret();
  const keys = await keysFrom({ edit: sk });
  const expires = opts.expires !== undefined ? opts.expires : parseExpiry(one(flags.expires) ?? cfg.defaults.expires);
  const a = {
    id: bytesToHex(sha256(enc.encode(keys.pubkey))).slice(0, 8),
    pubkey: keys.pubkey, npub: nip19.npubEncode(keys.pubkey), secret: b64u(sk),
    title: opts.title || one(flags.title) || "", visibility, edit, sealed: visibility !== "public",
    members, created: now(), expires, relays: cfg.relays.map(norm), servers: cfg.servers.map(norm),
    shellTitle: one(flags["shell-title"]) || undefined,
    comments: !flags["no-comments"] && edit !== "none",
  };
  a.url = siteUrl(cfg, a.pubkey);
  const html = stampPage(opts.html ?? readFileSync(file, "utf8"), a);
  // The title stays in the ledger and in what the agent is told. For a sealed
  // page it is never published.
  if (!a.title) a.title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || "").trim();
  // The whole page is sealed and uploaded again on every save, by a phone as
  // often as not.
  if (Buffer.byteLength(html) > 3_000_000) {
    fail(`this page is ${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB, and a page is uploaded whole on every save. Keep it under 3 MB: make the pictures in it smaller.`);
  }
  const allow = many(flags["allow-origin"]);
  const warnings = [];
  if (a.sealed) {
    const blocked = foreignLoads(html).filter((o) => !allow.some((x) => norm(x) === o));
    if (blocked.length && !flags["allow-blocked"]) {
      fail(`this page loads from ${blocked.join(", ")}. An encrypted page may only load what is inside it: ` +
        `put the script, style, font or image in the file itself. (--allow-origin=<origin> lets one through, ` +
        `and tells that origin when the page is opened.)`);
    }
    if (allow.length) warnings.push(`the page may load from ${allow.join(", ")}, which learns when and from where it is opened`);
    a.policy = shellPolicy({ relays: a.relays, servers: a.servers, allow,
      connect: ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom"] });   // where a phone signer answers
  }
  if (visibility === "public" && !cfg.allowPublic) fail("public artifacts are turned off in this agent's settings. Use --visibility=link.");
  if (visibility === "public" && !flags.public && !opts.html) {
    fail("a public artifact can be read by anyone and found by anyone who looks. Pass --public as well to confirm that is what was asked for.");
  }

  const hint = editHint(html, a);
  if (hint) warnings.push(hint);
  const out = await withPool((pool) => putPage(pool, a, keys, html, cfg));
  a.hash = out.hash; a.seenHash = out.hash; a.savedAt = out.manifest.created_at;
  a.blobs = [out.hash];
  const ledger = readLedger();
  ledger.artifacts[a.id] = a;
  writeLedger(ledger);
  remember(a, digest(html), html);
  if (out.refused.length) warnings.push(`stored on ${out.servers.length} of ${a.servers.length} servers. Refused: ${out.refused.join("; ")}`);
  if (out.relays.length < a.relays.length) warnings.push(`accepted by ${out.relays.length} of ${a.relays.length} relays`);
  return { id: a.id, title: a.title, visibility, edit, ...linksOf(a, keys),
    expires: expires ? new Date(expires * 1000).toISOString() : null,
    members: members.map((m) => ({ npub: nip19.npubEncode(m.pubkey), role: m.role })),
    relays: out.relays, servers: out.servers, ...(warnings.length ? { warnings } : {}) };
}

function listPage() {
  const title = one(flags.title) || fail("usage: list-page --title=\"Shopping\" [--note=…] [--item=…]… [--out=list.html]");
  const items = [].concat(flags.item ?? []).filter((x) => x !== true).map(String);
  if (flags.items) {
    const raw = readFileSync(one(flags.items) === "-" ? 0 : one(flags.items), "utf8");
    items.push(...raw.split("\n").map((l) => l.trim()).filter(Boolean));
  }
  const row = (text) => {
    const done = /^\[x\]\s*/i.test(text);
    const label = text.replace(/^\[[ x]\]\s*/i, "").replace(/^[-*]\s+/, "");
    return `\n    <li class="item"><input type="checkbox" aria-label="Done"${done ? " checked" : ""}><span class="text" editable="single-line">${esc(label)}</span>` +
      `<button type="button" title="Remove this item" aria-label="Remove this item" onclick="listRemove(this)">&times;</button></li>`;
  };
  // Next to the script in the skill's folder, or in the package the CLI runs from.
  const tpl = readFileSync([join(HERE, "..", "assets", "list.html"),
    join(HERE, "..", "skills", "nsite-artifacts", "assets", "list.html")].find(existsSync), "utf8");
  const html = tpl.replaceAll("{{title}}", esc(title)).replace("{{note}}", esc(one(flags.note) === true ? "" : one(flags.note) || ""))
    .replace("{{items}}", items.map(row).join("") + (items.length ? "\n  " : ""))
    .replace(/<html lang="en"/, `<html lang="${esc(one(flags.lang) || "en")}"`);
  const out = resolve(one(flags.out) || "list.html");
  writeFileSync(out, html);
  return { file: out, items: items.length, next: `create ${out} --edit=link --title="${title}"` };
}

// The page as it is, against the page as this tool last saw it. Reading is what
// "seen" means: the next status or read reports only what came after this one.
// --peek looks without moving that mark.
async function look(id) {
  const ledger = readLedger();
  const a = entryOf(ledger, id);
  const keys = await keysFrom({ edit: a.secret });
  const page = await withPool((pool) => fetchPage(pool, a, keys));
  const text = digest(page.html);
  let before = "";
  try { before = readFileSync(seenFile(a), "utf8"); } catch { /* first read */ }
  const beforeHtml = seenHtml(a);
  const changed = page.hash !== a.seenHash;
  const mark = () => {
    if (flags.peek) return;
    a.seenHash = page.hash; a.hash = page.hash; a.savedAt = page.manifest.created_at;
    if (!a.blobs.includes(page.hash)) a.blobs.push(page.hash);
    writeLedger(ledger);
    remember(a, text, page.html);
  };
  return { a, page, text, before, beforeHtml, changed, mark,
    savedAt: new Date(page.manifest.created_at * 1000).toISOString() };
}

// What a person said on the page since this tool last looked: new comments,
// and ones that got a reply or changed state.
function commentSummary(now, beforeHtml) {
  const was = new Map(beforeHtml ? commentsOf(beforeHtml).map((c) => [c.id, c]) : []);
  const fresh = [];
  for (const c of now) {
    const old = was.get(c.id);
    const isNew = !old;
    const answered = !!old && c.replies.length > old.replies.length;
    const moved = !!old && c.state !== old.state;
    if (isNew || answered || moved) fresh.push({ ...c, news: isNew ? "new" : answered ? "reply" : "state" });
  }
  return fresh;
}

async function read(id) {
  const r = await look(id);
  const { a, page, text } = r;
  const now = commentsOf(page.html);
  const out = {
    id: a.id, title: a.title, changed: r.changed, savedAt: r.savedAt,
    ...(r.changed ? { changes: changes(r.before, text) } : {}),
    // Said once, and where to look: the list itself comes from `comments`.
    ...(now.length ? { comments: { open: now.filter((c) => c.state === "open").length, resolved: now.filter((c) => c.state === "resolved").length,
      newSinceLastRead: commentSummary(now, r.beforeHtml).map((c) => c.id) } } : {}),
  };
  // `changes` knows words and ticks. When the page itself was edited, which is
  // what an ordinary editing tool does, the diff of the markup says exactly what.
  if (flags.diff && r.changed) {
    out.diff = r.beforeHtml == null ? { note: "no earlier copy of this page was kept, so there is nothing to compare with" }
      : unifiedDiff(r.beforeHtml, page.html);
  }
  const want = one(flags.as) || "text";
  if (want === "html") out.html = page.html;
  else out.text = text;
  if (flags.out) { writeFileSync(resolve(one(flags.out)), page.html); out.file = resolve(one(flags.out)); delete out.html; }
  r.mark();
  return out;
}

// What changed in the page since this tool last read it: a unified diff of the
// markup, the changes to the words, and the comments added or answered. Reading
// this way moves the mark like `read` does.
async function diff(id) {
  const r = await look(id);
  const now = commentsOf(r.page.html);
  const out = { id: r.a.id, title: r.a.title, changed: r.changed, savedAt: r.savedAt };
  if (r.changed) {
    out.changes = changes(r.before, r.text);
    out.markup = r.beforeHtml == null ? { note: "no earlier copy of this page was kept" } : unifiedDiff(r.beforeHtml, r.page.html);
    const fresh = commentSummary(now, r.beforeHtml);
    if (fresh.length) out.comments = fresh;
  }
  r.mark();
  return out;
}

// The comments on a page, with where each one is, newest news first. Open ones
// unless --all. This is the way to read a page somebody has been commenting on:
// it does not print the page.
async function comments(id) {
  const r = await look(id);
  const all = commentsOf(r.page.html);
  const fresh = new Map(commentSummary(all, r.beforeHtml).map((c) => [c.id, c.news]));
  const shown = (flags.all ? all : all.filter((c) => c.state === "open")).map((c) => ({ ...c, ...(fresh.has(c.id) ? { news: fresh.get(c.id) } : {}) }));
  shown.sort((x, y) => (fresh.has(y.id) - fresh.has(x.id)) || String(x.at).localeCompare(String(y.at)));
  const out = {
    id: r.a.id, title: r.a.title, pageChanged: r.changed, savedAt: r.savedAt,
    open: all.filter((c) => c.state === "open").length, resolved: all.filter((c) => c.state === "resolved").length,
    ...(r.changed ? { changes: changes(r.before, r.text).length + " changed lines since you last read it; run read or diff to see them" } : {}),
    comments: shown,
  };
  if (!all.length) out.note = "no comments on this page" + (r.a.comments === false || r.a.edit === "none" ? " (comments are off for it: it cannot be edited by link or members)" : "");
  r.mark();
  return out;
}

// Change one comment inside the page's markup, and publish it. The page is
// edited as text so nothing else in it moves: a reply is a paragraph added to
// the comment, resolving flips its state and takes the highlight off the words.
const COMMENT_ID = /^[A-Za-z0-9]{3,16}$/;
async function commentAct(id, cid, kind) {
  if (!id || !cid) fail(`usage: ${kind} <id> <comment-id>${kind === "reply" ? ' --text="…"' : ""} (see: comments <id>)`);
  if (!COMMENT_ID.test(cid)) fail(`"${cid}" is not a comment id`);
  const text = one(flags.text);
  if (kind === "reply" && (!text || text === true)) fail('reply needs --text="what you did or answer"');
  const by = String(one(flags.by) || "Agent");
  const cfg = settings();
  const ledger = readLedger();
  const a = entryOf(ledger, id);
  const keys = await keysFrom({ edit: a.secret });
  return withPool(async (pool) => {
    const live = await fetchPage(pool, a, keys);
    if (live.hash !== a.seenHash && !flags.force) {
      fail(`${a.id} was changed after you last read it. Run "comments ${a.id}" to see what changed, then ${kind} again.`);
    }
    const re = new RegExp(`<article\\b[^>]*\\bnc:comment="${cid}"[^>]*>[\\s\\S]*?</article>`);
    const art = re.exec(live.html)?.[0];
    if (!art) fail(`no comment "${cid}" on ${a.id}. Run "comments ${a.id} --all" for the ids.`);
    let next = art;
    if (kind === "reply") {
      const p = `<p nc:reply nc:by="${esc(by)}" nc:at="${new Date().toISOString()}">${esc(text)}</p>`;
      next = next.replace(/<\/article>$/, p + "</article>");
    }
    if (kind === "resolve" || (kind === "reply" && flags.resolve)) next = next.replace(/\bnc:state="[^"]*"/, 'nc:state="resolved"');
    if (kind === "reopen") next = next.replace(/\bnc:state="[^"]*"/, 'nc:state="open"');
    let html = live.html.replace(art, () => next);
    if (/nc:state="resolved"/.test(next)) {
      // The highlight goes: words wrapped for this comment are unwrapped, and its
      // id comes off anything else it was attached to.
      html = html.replace(new RegExp(`<mark\\b[^>]*\\bnc:c="${cid}"[^>]*>([\\s\\S]*?)</mark>`, "g"), "$1")
        .replace(/\bnc:c="([^"]*)"/g, (m, ids) => {
          const rest = ids.split(/\s+/).filter((t) => t && t !== cid);
          return rest.length === ids.split(/\s+/).filter(Boolean).length ? m : rest.length ? `nc:c="${rest.join(" ")}"` : "";
        });
    }
    adoptMembers(a, live.shell);
    html = stampPage(html, a);
    const out = await putPage(pool, a, keys, html, cfg, { live: live.manifest, table: live.table });
    a.hash = out.hash; a.seenHash = out.hash; a.savedAt = out.manifest.created_at;
    a.blobs.push(out.hash);
    writeLedger(ledger);
    remember(a, digest(html), html);
    const now = commentsOf(html).find((c) => c.id === cid);
    return { id: a.id, comment: cid, state: now?.state, replies: now?.replies.length, savedAt: new Date(out.manifest.created_at * 1000).toISOString() };
  });
}

async function status(id) {
  const ledger = readLedger();
  const targets = id ? [entryOf(ledger, id)] : Object.values(ledger.artifacts).filter((a) => !a.deleted);
  let dirty = false;
  return withPool(async (pool) => {
    const rows = [];
    for (const a of targets) {
      const m = await newest(pool, a.relays, { kinds: [15128], authors: [a.pubkey] });
      const hash = m?.tags.find((t) => t[0] === "path" && t[1] === "/index.html")?.[2] || null;
      // Deleting from the page's own panel leaves an empty manifest, and a
      // deletion request signed by the page's key, which a relay that honours
      // it applies to the empty manifest too. Either one says so.
      if (!hash && !a.deleted) {
        const req = m ? null : await newest(pool, a.relays, { kinds: [5], authors: [a.pubkey] });
        if (m || req) { a.deleted = (m || req).created_at; a.deletedBy = "page"; dirty = true; }
      }
      rows.push({ id: a.id, title: a.title, published: !!hash, changed: !!hash && hash !== a.seenHash,
        ...(a.deleted ? { deleted: new Date(a.deleted * 1000).toISOString() } : {}),
        savedAt: m ? new Date(m.created_at * 1000).toISOString() : null,
        expires: a.expires ? new Date(a.expires * 1000).toISOString() : null });
    }
    if (dirty) writeLedger(ledger);
    return id ? rows[0] : { artifacts: rows, changed: rows.filter((r) => r.changed).map((r) => r.id),
      deleted: rows.filter((r) => r.deleted && !r.published).map((r) => r.id) };
  });
}

// People added from the page's own panel are in the published shell and not
// in the ledger. Taken into the ledger before anything is sealed again, so an
// agent's update does not quietly take them off.
function adoptMembers(a, shell) {
  if (!shell?.wraps?.length) return;
  const known = new Set((a.members || []).map((m) => m.pubkey));
  for (const w of shell.wraps) if (!known.has(w.p)) { a.members = [...(a.members || []), { pubkey: w.p, role: w.r === "edit" ? "edit" : "read" }]; known.add(w.p); }
}

async function update(id, file) {
  if (!file) fail("usage: update <id> <file.html>");
  const cfg = settings();
  const ledger = readLedger();
  const a = entryOf(ledger, id);
  const keys = await keysFrom({ edit: a.secret });
  return withPool(async (pool) => {
    const live = await fetchPage(pool, a, keys);
    // Somebody saved the page after this agent last read it. Publishing now
    // would throw their change away, so read first and build on that.
    if (live.hash !== a.seenHash && !flags.force) {
      fail(`${a.id} was changed after you last read it (saved ${new Date(live.manifest.created_at * 1000).toISOString()}). ` +
        `Run "read ${a.id}" to see the change, make yours on top of it, then update. --force overwrites it.`);
    }
    if (flags.expires) a.expires = parseExpiry(one(flags.expires));
    adoptMembers(a, live.shell);
    const html = stampPage(readFileSync(file, "utf8"), a);
    const out = await putPage(pool, a, keys, html, cfg, { live: live.manifest, table: live.table });
    a.hash = out.hash; a.seenHash = out.hash; a.savedAt = out.manifest.created_at;
    a.blobs.push(out.hash);
    writeLedger(ledger);
    remember(a, digest(html), html);
    const hint = editHint(html, a);
    return { id: a.id, ...linksOf(a, keys), savedAt: new Date(out.manifest.created_at * 1000).toISOString(), ...(hint ? { warnings: [hint] } : {}) };
  });
}

async function share(id) {
  const cfg = settings();
  const ledger = readLedger();
  const a = entryOf(ledger, id);
  if (!a.sealed) fail("a public artifact has nothing to share by key: send its link");
  const add = [
    ...many(flags.member).map((m) => ({ pubkey: toHex(m), role: "edit" })),
    ...many(flags["member-read"]).map((m) => ({ pubkey: toHex(m), role: "read" })),
  ];
  if (!add.length) fail("usage: share <id> --member=<npub> | --member-read=<npub>");
  const keys = await keysFrom({ edit: a.secret });
  return withPool(async (pool) => {
    const live = await fetchPage(pool, a, keys);
    adoptMembers(a, live.shell);
    a.members = [...a.members.filter((m) => !add.some((n) => n.pubkey === m.pubkey)), ...add];
    const out = await putPage(pool, a, keys, live.html, cfg, { live: live.manifest, table: live.table });
    if (a.seenHash === live.hash) a.seenHash = out.hash;
    a.hash = out.hash; a.blobs.push(out.hash);
    writeLedger(ledger);
    return { id: a.id, members: a.members.map((m) => ({ npub: nip19.npubEncode(m.pubkey), role: m.role })) };
  });
}

async function remove(a, keys, cfg, pool) {
  // Every version this key ever published: the manifest names the current
  // page and each snapshot names an older one.
  // Here every relay is waited for: what one of them still holds is what has to go.
  const events = await ask(pool, a.relays, { kinds: [15128, 5128, 10002], authors: [a.pubkey] }, { grace: TIMEOUT.relay });
  const pages = new Set(a.blobs || []);
  for (const ev of events) for (const t of ev.tags) if (t[0] === "path" && t[1] === "/index.html") pages.add(t[2]);
  const newestAt = Math.max(now(), ...events.map((e) => e.created_at + 1));

  // First an empty manifest, so a relay that ignores deletion requests still
  // stops naming the page. It expires by itself a day later.
  const tomb = finalizeEvent({ kind: 15128, created_at: newestAt, content: "",
    tags: [["x", hashOf(enc.encode("")), "aggregate"], ["expiration", String(now() + 86400)]] }, keys.sk);
  await publish(pool, a.relays, tomb);
  // The same for the key's relay list. relay.nsite.lol takes manifests and
  // lists and refuses deletion requests, so there replacing is the only way.
  await publish(pool, a.relays, finalizeEvent({ kind: 10002, created_at: newestAt, content: "",
    tags: [["expiration", String(now() + 86400)]] }, keys.sk));
  // Then the request to delete everything, the tombstone included.
  const del = finalizeEvent({ kind: 5, created_at: newestAt + 1, content: "artifact removed",
    tags: [["a", `15128:${a.pubkey}:`], ["a", `10002:${a.pubkey}:`], ...events.map((e) => ["e", e.id]), ["e", tomb.id],
      ["k", "15128"], ["k", "5128"], ["k", "10002"]] }, keys.sk);
  const relays = await publish(pool, a.relays, del);

  // The page's own bytes, every version. The runtime's blobs are everybody's
  // and stay where they are.
  const signers = [keys.sk, ...(cfg.uploader ? [nip19.decode(cfg.uploader).data] : [])];
  const blobs = [];
  for (const hash of pages) {
    let rows = [];
    for (const sk of signers) {
      rows = await dropBlob(a.servers, hash, sk);
      if (rows.every((r) => r.state !== "refused")) break;
    }
    blobs.push(...rows.map((r) => ({ hash: hash.slice(0, 12), ...r })));
  }
  return { relays, blobs, left: blobs.filter((b) => b.state === "refused") };
}

async function del(id) {
  const cfg = settings();
  const ledger = readLedger();
  const a = entryOf(ledger, id);
  const keys = await keysFrom({ edit: a.secret });
  const out = await withPool((pool) => remove(a, keys, cfg, pool));
  a.deleted = now();
  // The key is kept until nothing is left to delete with it.
  if (!out.left.length && !flags["keep-key"]) delete a.secret;
  writeLedger(ledger);
  return { id: a.id, deleted: true, relays: out.relays.length,
    blobs: { deleted: out.blobs.filter((b) => b.state === "deleted").length, gone: out.blobs.filter((b) => b.state === "gone").length, refused: out.left },
    ...(a.sealed ? {} : { note: "this page was public. Copies somebody already fetched are theirs to keep." }) };
}

async function sweep() {
  const cfg = settings();
  const ledger = readLedger();
  const due = Object.values(ledger.artifacts).filter((a) => !a.deleted && a.secret && a.expires && a.expires <= now());
  const retry = Object.values(ledger.artifacts).filter((a) => a.deleted && a.secret && !flags["no-retry"]);
  const done = [];
  await withPool(async (pool) => {
    for (const a of [...due, ...retry]) {
      try {
        const keys = await keysFrom({ edit: a.secret });
        const out = await remove(a, keys, cfg, pool);
        a.deleted = a.deleted || now();
        if (!out.left.length) delete a.secret;
        done.push({ id: a.id, title: a.title, left: out.left.length });
      } catch (e) { done.push({ id: a.id, title: a.title, error: e.message }); }
      writeLedger(ledger);
    }
  });
  const soon = Object.values(ledger.artifacts).filter((a) => !a.deleted && a.expires && a.expires - now() < 3 * 86400)
    .map((a) => ({ id: a.id, title: a.title, expires: new Date(a.expires * 1000).toISOString() }));
  return { deleted: done, expiringSoon: soon };
}

async function rekey(id) {
  const cfg = settings();
  const ledger = readLedger();
  const old = entryOf(ledger, id);
  const keys = await keysFrom({ edit: old.secret });
  const drop = many(flags.remove).map(toHex);
  const page = await withPool((pool) => fetchPage(pool, old, keys));
  // A new key is a new address: nothing published under the old one can be
  // made to stop working for somebody who already holds it, except by deleting it.
  const made = await create(null, { html: page.html, visibility: old.visibility, edit: old.edit, title: old.title,
    expires: old.expires, members: (old.members || []).filter((m) => !drop.includes(m.pubkey)) });
  const gone = await del(old.id);
  return { ...made, replaces: old.id, oldDeleted: gone.blobs };
}

// Move artifacts onto the runtime this tool would publish with today. Only the
// manifest changes: the page links /nsite-clay.js by its plain name, so its
// bytes, sealed or not, stay exactly as they are, and so does the link.
async function upgrade(id) {
  const cfg = settings();
  const ledger = readLedger();
  const targets = id ? [entryOf(ledger, id)] : Object.values(ledger.artifacts).filter((a) => !a.deleted && a.secret);
  if (!targets.length) return { upgraded: [], current: [] };
  const upgraded = [], current = [], failed = [];
  await withPool(async (pool) => {
    for (const a of targets) {
      try {
        const keys = await keysFrom({ edit: a.secret });
        const live = await fetchPage(pool, a, keys);
        const uploader = cfg.uploader ? nip19.decode(cfg.uploader).data : keys.sk;
        const want = await putRuntime(pool, a, live.html, cfg, uploader);
        const moved = Object.keys(want).filter((p) => live.table[p] !== want[p]);
        if (!moved.length) { current.push(a.id); continue; }
        const out = await publishTable(pool, a, keys.sk, { ...live.table, ...want }, live.manifest);
        a.savedAt = out.manifest.created_at;
        upgraded.push({ id: a.id, files: moved });
      } catch (e) { failed.push({ id: a.id, error: e.message }); if (id) throw e; }
    }
  });
  writeLedger(ledger);
  return { upgraded, current, ...(failed.length ? { failed } : {}) };
}

function list() {
  const ledger = readLedger();
  return { artifacts: Object.values(ledger.artifacts).filter((a) => flags.all || !a.deleted).map((a) => ({
    id: a.id, title: a.title, visibility: a.visibility, edit: a.edit, url: a.url,
    created: new Date(a.created * 1000).toISOString(),
    expires: a.expires ? new Date(a.expires * 1000).toISOString() : null,
    ...(a.deleted ? { deleted: new Date(a.deleted * 1000).toISOString() } : {}),
  })) };
}

async function links(id) {
  const a = entryOf(readLedger(), id);
  if (!a.secret) fail(`${a.id} was deleted`);
  return { id: a.id, ...linksOf(a, await keysFrom({ edit: a.secret })) };
}

const HELP = `nsite-artifacts: publish a page, read what people changed, take it down.

  list-page --title=T [--item=…]… [--items=file|-] [--note=…] [--out=list.html]
  create <file.html> [--visibility=link|private|public] [--edit=none|link|members] [--no-comments]
         [--member=npub]… [--member-read=npub]… [--expires=30d|never] [--title=T]
  read <id> [--as=text|html] [--out=file.html] [--diff] [--peek]
  diff <id>              what changed in the page since you last read it, as a diff
  comments <id> [--all] [--peek]       what people wrote on the page, and where
  reply <id> <comment> --text="…" [--resolve] [--by=Agent]
  resolve <id> <comment>   |   reopen <id> <comment>
  status [id]
  update <id> <file.html> [--expires=…] [--force]
  share <id> --member=npub | --member-read=npub
  rekey <id> [--remove=npub]…
  links <id>
  upgrade [id]           move pages onto the runtime this tool publishes with
  list [--all]
  delete <id>
  sweep

Settings: ${join(HOME, "config.json")} (relays, servers, gateway, runtime, uploader, defaults)
or NSITE_ARTIFACTS_RELAYS, _SERVERS, _GATEWAY, _RUNTIME, _UPLOADER, _HOME.`;

const commands = {
  create: () => create(positional[0]), "list-page": listPage, read: () => read(positional[0]),
  diff: () => diff(positional[0]), comments: () => comments(positional[0]),
  reply: () => commentAct(positional[0], positional[1], "reply"),
  resolve: () => commentAct(positional[0], positional[1], "resolve"),
  reopen: () => commentAct(positional[0], positional[1], "reopen"),
  status: () => status(positional[0]), update: () => update(positional[0], positional[1]),
  share: () => share(positional[0]), rekey: () => rekey(positional[0]), links: () => links(positional[0]),
  list, delete: () => del(positional[0]), sweep, upgrade: () => upgrade(positional[0]),
};

/** Run one command. Resolves to the process exit code. */
export async function main(argv) {
  parseArgs(argv);
  if (!commands[cmd]) { console.log(HELP); return cmd === "help" ? 0 : 2; }
  try {
    const out = JSON.stringify(await commands[cmd](), null, 2) + "\n";
    // Waited for: a page with a picture in it is longer than a pipe's buffer,
    // and leaving before it drains hands the caller half a JSON object.
    await new Promise((done) => process.stdout.write(out, done));
    return 0;
  } catch (e) {
    if (e instanceof Fail) { console.error("nsite-artifacts: " + e.message); return 1; }
    console.error("nsite-artifacts: " + (e?.stack || e));
    return 3;
  }
}

// Run directly, as the skill does. Imported, as the CLI does, it only exports.
const direct = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (direct) process.exit(await main(process.argv.slice(2)));
