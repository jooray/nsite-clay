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
//   status [id]          has anybody saved it since I last read it? is it healthy?
//   verify [id]          check every relay, server and the gateway (read-only)
//   doctor <id> [--fix]  repair what verify found
//   update <id> <file>   publish new content under the same link
//   share <id>           give one more key access
//   rekey <id>           move to a new key and link (the way to remove someone)
//   adopt <editLink>     take a page into this ledger from its edit link
//   list                 everything in the ledger
//   delete <id>          take it down now
//   sweep                take down what expired, finish deletions, drop old versions
//   workspace …          one site with many pages under one key (see below)
//
// Everything prints one JSON object on stdout. Errors go to stderr with a
// non-zero exit, and never include a key.
//
// A publish is checked before and after: every blob is read back from every
// server before the manifest is signed, and the manifest is read back from
// every relay after. The version a save replaces is not deleted then; it is
// retired, and deleted by a later run once every relay and the gateway have
// moved on (src/retire.js says why).
import "./node-compat.mjs";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, realpathSync,
  openSync, writeSync, closeSync, unlinkSync, statSync, appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, webcrypto } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { finalizeEvent, getPublicKey, nip19, verifyEvent } from "nostr-tools";
// The pool from its own entry point: that is the copy useWebSocketImplementation
// configures. Node before 22 has no WebSocket of its own.
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { parse, serialize } from "parse5";
import WebSocket from "ws";
import {
  assertShell, b64u, buildShell, fragmentOf, keysFrom, newSecret, openText, parseFragment, parseShell, sealText, shellPolicy,
  unb64u, usePlatform, wrapFor,
} from "../src/seal.js";
import {
  MAX_RETIRED, RETIRE_AFTER, etagHash, mergeRetired, namedHashes, planRetired, retiredFor, retiredOf, retiredTags,
} from "../src/retire.js";

if (typeof globalThis.WebSocket === "undefined") useWebSocketImplementation(WebSocket);
// Node's own Web Crypto and raw DEFLATE, so the sealing code does not depend on
// which of them this Node version has as globals.
usePlatform({ crypto: webcrypto, deflate: (b) => deflateRawSync(b), inflate: (b) => inflateRawSync(b) });

const HERE = dirname(fileURLToPath(import.meta.url));
/* global __NC_VERSION__ */
const VERSION = typeof __NC_VERSION__ === "string" ? __NC_VERSION__ : (() => {
  try { return JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version; } catch { return "unknown"; }
})();
// The oldest Node this runs on. The bundle is built for it (build.mjs) and its
// first line refuses anything older in a plain sentence.
const NODE_MIN = 18;

// ------------------------------------------------------------- configuration

// Set by main(), so the same file is the `nsite-clay artifact` subcommand and
// the one-file script the agent skill ships.
let cmd = "help", positional = [], flags = {}, exitCode = 0;
// Flags that never take a value. Every other flag takes one, written as
// --name=value or as --name value.
const BOOLEAN = new Set(["public", "force", "peek", "all", "diff", "resolve", "keep-key", "no-comments", "allow-blocked",
  "fix", "no-retry", "version", "help", "from-seen", "json", "no-workspace", "update-servers", "remove-index"]);
// Flags that take a value only as --name=value, and are `true` bare, so
// `create --workspace page.html` does not read the file name as the value.
const OPTIONAL = new Set(["workspace"]);
function parseArgs(argv) {
  positional = []; flags = {}; exitCode = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    let k, v;
    if (eq >= 0) { k = a.slice(2, eq); v = a.slice(eq + 1); }
    else {
      k = a.slice(2); v = true;
      if (!BOOLEAN.has(k) && !OPTIONAL.has(k) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) v = argv[++i];
    }
    flags[k] = k in flags ? [].concat(flags[k], v) : v;       // --member may repeat
  }
  cmd = positional.shift() || (flags.version ? "version" : "help");
}
const many = (v) => (v == null || v === true ? [] : [].concat(v).flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean));
const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
/** A flag that takes a value. `--title` with nothing after it is a mistake, not `true`. */
function val(name) {
  const v = one(flags[name]);
  if (v === true) fail(`--${name} needs a value: --${name}=…`);
  return v;
}

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };
// Nothing that looks like a key leaves this process in an error.
const redact = (s) => String(s)
  .replace(/nsec1[02-9ac-hj-np-z]{20,}/gi, "nsec1…")
  .replace(/([#&][ek])=[A-Za-z0-9_-]{20,}/g, "$1=…");

const HOME = process.env.NSITE_ARTIFACTS_HOME ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "nsite-clay", "artifacts");
const LEDGER = join(HOME, "ledger.json");
const LOCK = LEDGER + ".lock";
const LOG = join(HOME, "log.jsonl");

/** "48h", "2d", "90m", "3600" (seconds) or "0". */
function duration(text, fallback) {
  if (text == null || text === "") return fallback;
  if (/^\d+$/.test(String(text))) return Number(text);
  const m = /^(\d+)\s*(s|m|h|d|w)$/.exec(String(text).trim());
  if (!m) fail(`not a duration: ${text} (use 48h, 2d or a number of seconds)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2]];
}

// Settings come from flags, then the environment, then a config file next to
// the ledger, then the public defaults. The config file is how a person points
// every artifact their agent makes at their own relay, Blossom server and
// gateway once, without the agent having to know. With "locked": true in it,
// flags and environment variables for those are refused or ignored.
let settingsCache = null;
function settings() {
  if (settingsCache) return settingsCache;
  const path = join(HOME, "config.json");
  let file = {};
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, "utf8")); } catch { fail(`the settings file ${path} is not valid JSON`); }
  }
  const locked = file.locked === true;
  if (locked) {
    const tried = ["relays", "servers", "gateway", "runtime", "uploader"].filter((k) => flags[k] !== undefined);
    if (tried.length) fail(`the settings in ${path} are locked, so --${tried[0]} is not accepted. The person who set them up decides where pages go.`);
  }
  const env = (name) => (locked ? undefined : process.env[name]);
  const pick = (flag, name, key, fallback) =>
    many(flags[flag]).length ? many(flags[flag]) : env(name) ? many(env(name)) : file[key] || fallback;
  settingsCache = {
    locked,
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
    gateway: one(flags.gateway) || env("NSITE_ARTIFACTS_GATEWAY") || file.gateway || "https://{host}.nsite.lol",
    // The relay the gateway reads. A page that this relay does not have is not
    // published, whatever the others say. Unset, the first relay.
    gatewayRelay: file.gatewayRelay || null,
    // Where the runtime comes from: a directory holding nsite-clay.js, or the
    // nsite of the key that publishes it.
    // Run from the nsite-clay package, the runtime is the one that came with it.
    runtime: one(flags.runtime) || env("NSITE_ARTIFACTS_RUNTIME") || file.runtime ||
      (existsSync(join(HERE, "..", "dist", "nsite-clay.js")) ? join(HERE, "..") : null),
    runtimeOwner: file.runtimeOwner || "npub12edc7326qsryw5rw5yw0yh57fmj9r8jf4c8xazz6333w305qgnms9ypvj2",
    // A key that pays for, or is allowed on, the Blossom servers. Blob uploads
    // are authorised by whoever signs the upload, which need not be the key
    // that signs the manifest, so one allow-listed key can carry the bytes of
    // every artifact. Unset, each artifact's own key uploads its own.
    uploader: env("NSITE_ARTIFACTS_UPLOADER") || file.uploader || null,
    defaults: { visibility: "link", edit: "none", expires: "30d", ...(file.defaults || {}) },
    // Set to false by a person who never wants their agent to publish in the
    // clear. No flag overrides it: it is changed in the file or not at all.
    allowPublic: file.allowPublic !== false,
    // How many servers must hold a page, read back byte for byte, before its
    // manifest is signed. Never more than there are servers.
    minServers: Math.max(1, Number(env("NSITE_ARTIFACTS_MIN_SERVERS") || file.minServers || 2)),
    // How long a replaced version is kept before it may be deleted.
    retireAfter: duration(env("NSITE_ARTIFACTS_RETIRE_AFTER") ?? file.retireAfter, RETIRE_AFTER),
    // Whether to ask the gateway what it serves. Off, nothing retired is ever
    // deleted by this tool, because nothing can show the gateway has moved on.
    gatewayCheck: file.gatewayCheck !== false && env("NSITE_ARTIFACTS_GATEWAY_CHECK") !== "0",
    // The workspace new pages go into, by name, when create is not told:
    // null keeps one site per page, the default.
    workspace: process.env.NSITE_ARTIFACTS_WORKSPACE || file.workspace || null,
  };
  return settingsCache;
}

// The key that signs uploads and deletions of blobs.
function uploaderKey(cfg, sk) {
  if (!cfg.uploader) return sk;
  const u = String(cfg.uploader).trim();
  if (/^[0-9a-f]{64}$/i.test(u)) return hexToBytes(u.toLowerCase());
  try { const d = nip19.decode(u); if (d.type === "nsec") return d.data; } catch { /* below */ }
  // Never the value itself: a mistyped key is still most of a key.
  fail("the uploader in the settings (config.json \"uploader\" or NSITE_ARTIFACTS_UPLOADER) is not a valid nsec");
}
const signersOf = (cfg, sk) => {
  try { return [...new Set([sk, ...(cfg.uploader ? [uploaderKey(cfg, sk)] : [])])]; } catch { return [sk]; }
};

// ------------------------------------------------------------------- ledger

// The ledger is the agent's memory of what it made and the only copy of each
// artifact's key outside the links it handed out. Mode 600. Every change takes
// a lock, reads the file again, changes one entry and renames a fresh copy into
// place, so two runs of this tool at once cannot overwrite each other's keys,
// and a crash cannot leave half of one. The lock is never held across a
// network call: a command does its network work, then locks and merges.
function readLedger() {
  let text;
  try { text = readFileSync(LEDGER, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return { v: 1, artifacts: {}, workspaces: {} };
    fail(`cannot read the ledger ${LEDGER}: ${e.code || e.message}`);
  }
  try {
    const l = JSON.parse(text);
    if (!l || typeof l.artifacts !== "object") throw new Error("shape");
    if (!l.workspaces || typeof l.workspaces !== "object") l.workspaces = {};
    return l;
  } catch {
    // Starting from an empty one would write over every key in it.
    fail(`the ledger ${LEDGER} is damaged, so nothing was changed. Restore it from a backup, or move it away to start a new one.`);
  }
}
function writeLedger(ledger) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const tmp = `${LEDGER}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  renameSync(tmp, LEDGER);
  chmodSync(LEDGER, 0o600);
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function lock() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const end = Date.now() + 20000;
  for (;;) {
    try {
      const fd = openSync(LOCK, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return;
    } catch (e) { if (e.code !== "EEXIST") throw e; }
    // A lock whose owner died, or that is far older than any change takes.
    try {
      const info = JSON.parse(readFileSync(LOCK, "utf8"));
      if (!alive(info.pid) || Date.now() - info.at > 30000) { unlinkSync(LOCK); continue; }
    } catch {
      try { if (Date.now() - statSync(LOCK).mtimeMs > 5000) { unlinkSync(LOCK); continue; } } catch { continue; }
    }
    if (Date.now() > end) fail(`the ledger is locked by another run of this tool (${LOCK}). Try again in a moment.`);
    sleepSync(40);
  }
}
function unlock() { try { unlinkSync(LOCK); } catch { /* gone */ } }
/** Lock, read, change, write. `fn` gets the ledger as it is on disk now. */
function withLedger(fn) {
  lock();
  try {
    const ledger = readLedger();
    const out = fn(ledger);
    writeLedger(ledger);
    return out;
  } finally { unlock(); }
}
/** Change one entry as it is on disk now. A missing entry is an error unless `create`. */
function patch(id, fn) {
  return withLedger((l) => {
    const e = l.artifacts[id];
    if (!e) fail(`${id} is no longer in the ledger`);
    fn(e, l);
    return e;
  });
}
const addBlobs = (e, hashes) => { e.blobs = [...new Set([...(e.blobs || []), ...hashes.filter(Boolean)])]; };
const dropBlobs = (e, hashes) => {
  const gone = new Set(hashes);
  e.blobs = (e.blobs || []).filter((h) => !gone.has(h));
  e.retired = (e.retired || []).filter((r) => !gone.has(r.hash));
};

function entryOf(ledger, id, { deleted = false } = {}) {
  if (!id || id === true) fail("which artifact? Give its id (see: list)");
  id = String(id);
  const all = Object.values(ledger.artifacts);
  const bare = id.split("#")[0].replace(/\/+$/, "");
  // A workspace's npub is every one of its pages' npub, so it names none of them.
  let hit = ledger.artifacts[id] || all.find((a) => (!a.workspace && (a.npub === id || a.pubkey === id)) || (a.url && a.url.replace(/\/+$/, "") === bare));
  if (!hit) {
    if (id.length < 4) fail(`"${id}" is too short to pick one artifact: give at least 4 characters of its id`);
    const hits = all.filter((a) => a.id.startsWith(id));
    const live = hits.filter((a) => !a.deleted);
    const pool = live.length ? live : deleted ? hits : [];
    if (pool.length > 1) fail(`"${id}" matches ${pool.length} artifacts: ${pool.map((a) => `${a.id} (${a.title || "untitled"})`).join(", ")}. Give more of the id.`);
    hit = pool[0] || hits[0];
  }
  if (!hit) fail(`no artifact "${id}" in ${LEDGER}`);
  if (hit.deleted && !deleted) {
    fail(`${hit.id} was deleted on ${iso(hit.deleted)}${hit.replacedBy ? `; it was replaced by ${hit.replacedBy}` : ""}`);
  }
  return hit;
}
async function keysOf(a) {
  if (!a.secret) fail(`${a.id} was deleted and its key is gone${a.replacedBy ? `; it was replaced by ${a.replacedBy}` : ""}`);
  // A workspace page keeps its own read key; the key that signs is the workspace's.
  if (a.workspace) return keysFrom({ edit: workspaceOf(a).secret, read: a.secret });
  return keysFrom({ edit: a.secret });
}
// Where in its site a page lives. One site per page: the root.
const pathOf = (a) => a.path || "/index.html";
const whereOf = (a) => ({ owner: a.pubkey, site: "", path: pathOf(a) });

// What this tool did, one line each, with ids and hashes and never a key: the
// answer to "why is this page gone" that the ledger alone cannot give.
function log(entry) {
  try {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch { /* a log is not worth failing a command for */ }
}

// ------------------------------------------------------------------- helpers

const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);
const hashOf = (bytes) => bytesToHex(sha256(bytes));
const enc = new TextEncoder();
const norm = (u) => String(u).trim().replace(/\/+$/, "");
const TIMEOUT = { head: 15000, get: 30000, put: 60000, relay: 8000, connect: 5000, gateway: 15000 };
// Waits between retries and read-back rounds. Shorter only in tests.
const RETRY_MS = Number(process.env.NSITE_ARTIFACTS_RETRY_MS ?? 1000);
const READBACK_MS = Number(process.env.NSITE_ARTIFACTS_READBACK_MS ?? 1500);
const MAX_BLOB = 12_000_000;
const MAX_PAGE = 3_000_000;
const until = (ms) => ({ signal: AbortSignal.timeout(ms) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const union = (...lists) => [...new Set(lists.flat().filter(Boolean).map(norm))];
const isLocal = (urls) => urls.every((r) => /\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(r));
const tableOf = (m) => Object.fromEntries((m?.tags || []).filter((t) => t[0] === "path").map((t) => [t[1], t[2]]));
const serversOf = (m) => (m?.tags || []).filter((t) => t[0] === "server" && t[1]).map((t) => norm(t[1]));
const newestOf = (events) => [...events].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0] || null;

function toHex(key) {
  const k = String(key).trim();
  if (/^[0-9a-f]{64}$/i.test(k)) return k.toLowerCase();
  try { const d = nip19.decode(k); if (d.type === "npub") return d.data; if (d.type === "nprofile") return d.data.pubkey; } catch { /* below */ }
  fail(/^nsec1/.test(k) ? "that is a secret key (nsec), not a public one. Give the person's npub." : `not a public key: ${k.slice(0, 70)}`);
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

// -------------------------------------------------------------------- relays

async function publish(pool, relays, event) {
  if (!relays.length) return [];
  const sent = await Promise.allSettled(pool.publish(relays, event, { maxWait: TIMEOUT.relay }));
  return relays.filter((_, i) => sent[i].status === "fulfilled");
}

// One relay, by itself: what it returns for `filter`, or null when it cannot
// be reached. Events that do not verify, or are by somebody else, are dropped.
// A relay that could not be reached once in this run is not waited for again.
const deadRelays = new Set();
async function queryOne(pool, relay, filter, ms = TIMEOUT.relay) {
  if (deadRelays.has(relay)) return null;
  try { await pool.ensureRelay(relay, { connectionTimeout: TIMEOUT.connect }); } catch { deadRelays.add(relay); return null; }
  const evs = await pool.querySync([relay], filter, { maxWait: ms }).catch(() => null);
  if (!evs) return null;
  return evs.filter((e) => verifyEvent(e) && (!filter.authors || filter.authors.includes(e.pubkey)));
}

/** Every relay, each waited for up to the timeout: Map relay -> events | null. */
async function askEach(pool, relays, filter, ms) {
  return new Map(await Promise.all(relays.map(async (r) => [r, await queryOne(pool, r, filter, ms)])));
}

// For reading: every relay is asked, and the answer is taken once a majority
// of them has answered and a moment more has passed, or all of them have. One
// fast relay with an old copy no longer decides what the page is.
function ask(pool, relays, filter, { grace = 1500 } = {}) {
  return new Promise((done) => {
    const per = new Map();
    let left = relays.length, timer = null;
    const need = Math.floor(relays.length / 2) + 1;
    const finish = () => { clearTimeout(timer); done(per); };
    if (!left) return finish();
    for (const r of relays) {
      queryOne(pool, r, filter).then((evs) => {
        per.set(r, evs);
        if (--left === 0) return finish();
        if (!timer && relays.length - left >= need) timer = setTimeout(finish, grace);
      });
    }
  });
}
const flat = (per) => { const m = new Map(); for (const evs of per.values()) for (const e of evs || []) m.set(e.id, e); return [...m.values()]; };

/** Where each relay stands against `manifest`: current, older, newer, none, unreachable. */
// With `path`, for a page that shares its site: a relay is current when its
// newest manifest names the same version of that page, whatever else changed.
function standing(relays, per, manifest, path = null) {
  return relays.map((url) => {
    if (!per.has(url)) return { url, has: "no answer" };
    const evs = per.get(url);
    if (evs == null) return { url, has: "unreachable" };
    const top = newestOf(evs.filter((e) => e.kind === 15128));
    if (!top) return { url, has: "none" };
    if (manifest && top.id === manifest.id) return { url, has: "current" };
    if (path && manifest && tableOf(top)[path] && tableOf(top)[path] === tableOf(manifest)[path]) return { url, has: "current" };
    if (path && manifest && !tableOf(top)[path] && top.created_at <= manifest.created_at) return { url, has: "none" };
    return { url, has: manifest && top.created_at > manifest.created_at ? "newer" : "older", id: top.id, created_at: top.created_at, hash: tableOf(top)[path || "/index.html"] || null };
  });
}

// After a manifest went out: read it back from every relay by itself, send it
// again to any relay that does not have it, and say whether enough of them do.
// Enough is the relay the gateway reads plus a majority.
async function confirmPublish(pool, a, manifest, cfg) {
  let rows = [];
  for (let round = 0; round < 4; round++) {
    if (round) await sleep(READBACK_MS * round);
    rows = standing(a.relays, await askEach(pool, a.relays, { kinds: [15128], authors: [a.pubkey] }, TIMEOUT.relay), manifest);
    const lag = rows.filter((r) => r.has === "older" || r.has === "none");
    if (!lag.length || round === 3) break;
    await publish(pool, lag.map((r) => r.url), manifest);
  }
  const current = rows.filter((r) => r.has === "current").length;
  const need = Math.floor(a.relays.length / 2) + 1;
  const gw = norm(cfg.gatewayRelay || a.relays[0]);
  const gwRow = rows.find((r) => r.url === gw);
  const newer = rows.filter((r) => r.has === "newer");
  return {
    rows, current, of: a.relays.length, need, gatewayRelay: gw,
    ok: current >= need && (!gwRow || gwRow.has === "current") && !newer.length,
    lagging: rows.filter((r) => r.has !== "current").map((r) => `${r.url} (${r.has})`),
    conflict: newer.length ? newer : null,
  };
}

// ------------------------------------------------------------------ blossom

// A body read with a ceiling, so a server that answers with a film is stopped
// at the size no page can have.
async function readCapped(res, cap = MAX_BLOB) {
  const len = Number(res.headers.get("content-length"));
  if (len && len > cap) { try { await res.body?.cancel(); } catch { /* closing */ } throw new Error("too large"); }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { try { await reader.cancel(); } catch { /* closing */ } throw new Error("too large"); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** One server's copy of a blob, checked: { state: ok | missing | mismatch | unreachable, bytes? }. */
async function getBlob(server, hash, { cap = MAX_BLOB } = {}) {
  try {
    const res = await fetch(`${norm(server)}/${hash}`, until(TIMEOUT.get));
    if (res.status >= 500 || res.status === 429) { try { await res.body?.cancel(); } catch { /* closing */ } return { state: "unreachable", why: String(res.status) }; }
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* closing */ } return { state: "missing", why: String(res.status) }; }
    const bytes = await readCapped(res, cap);
    return hashOf(bytes) === hash ? { state: "ok", bytes } : { state: "mismatch" };
  } catch (e) {
    return e?.message === "too large" ? { state: "mismatch", why: "too large" } : { state: "unreachable", why: e?.name === "TimeoutError" ? "no answer" : e?.message };
  }
}

// Whether a server says it holds a blob, strictly: HEAD with no redirect
// followed, a 200, and exactly the right length. A soft 404 page, a redirect
// to a landing page or a cached HEAD after a DELETE do not count. True, false,
// or null when it cannot be told this way.
async function held(server, hash, size) {
  try {
    const res = await fetch(`${norm(server)}/${hash}`, { method: "HEAD", redirect: "manual", ...until(TIMEOUT.head) });
    if (res.status === 405 || res.status === 501 || (res.status >= 300 && res.status < 400)) return null;
    if (!res.ok) return false;
    const len = res.headers.get("content-length");
    return size == null ? true : len != null && Number(len) === size;
  } catch { return null; }
}

function blossomAuth(sk, verb, hash, ttl = 600) {
  const ev = finalizeEvent({
    kind: 24242, created_at: now(), content: verb === "delete" ? "Delete artifact file" : "Upload artifact file",
    tags: [["t", verb], ["x", hash], ["expiration", String(now() + ttl)]],
  }, sk);
  const raw = Buffer.from(JSON.stringify(ev));
  // BUD-11 says base64url without padding; part of the fleet wants standard.
  return [raw.toString("base64url"), raw.toString("base64")].map((b) => "Nostr " + b);
}

// One upload, retried on 429, 5xx and timeouts with a growing wait. What the
// server answers is checked: a descriptor for other bytes is a refusal.
async function putBlob(server, bytes, type, sk, expires) {
  const hash = hashOf(bytes);
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(RETRY_MS * 3 ** (attempt - 1));
    let again = false;
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
        if (res.ok) {
          const d = await res.json().catch(() => null);
          if (d && typeof d.sha256 === "string" && d.sha256.toLowerCase() !== hash) throw new Error(`${server}: stored other bytes than were sent (${d.sha256.slice(0, 12)}…)`);
          if (d && d.size != null && Number(d.size) !== bytes.length) throw new Error(`${server}: stored ${d.size} bytes of ${bytes.length}`);
          return true;
        }
        last = `${res.status} ${res.headers.get("x-reason") || (await res.text().catch(() => ""))}`.trim().slice(0, 200);
        if (res.status === 429 || res.status >= 500) { again = true; break; }
        if (![400, 401].includes(res.status)) break;
      } catch (e) {
        if (/stored/.test(e?.message)) throw e;
        last = e?.name === "TimeoutError" ? "no answer" : e?.message || String(e);
        again = true; break;
      }
    }
    if (!again) break;
  }
  throw new Error(`${server}: ${last}`);
}

// Blobs this machine read back in full from a server lately. The runtime is
// the same 600 kB on every page, and reading it back on every save would cost
// more than the save; a strict HEAD is enough within a day of a full check.
const VERIFIED = join(HOME, "verified.json");
let verifiedCache = null;
const verifiedKey = (s, h) => `${norm(s)} ${h}`;
function recentlyVerified(server, hash) {
  if (!verifiedCache) { try { verifiedCache = JSON.parse(readFileSync(VERIFIED, "utf8")); } catch { verifiedCache = {}; } }
  return now() - (verifiedCache[verifiedKey(server, hash)] || 0) < 86400;
}
function noteVerified(server, hash) {
  recentlyVerified(server, hash);
  verifiedCache[verifiedKey(server, hash)] = now();
  const keep = Object.entries(verifiedCache).filter(([, t]) => now() - t < 86400 * 2);
  try { mkdirSync(HOME, { recursive: true, mode: 0o700 }); writeFileSync(VERIFIED, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 }); } catch { /* a cache */ }
}

/**
 * Put a blob on every server and check, on every one, that it now serves those
 * exact bytes. `always` skips asking first (a sealed page is new by
 * construction). Resolves to one row per server: { server, state, why? }.
 */
async function placeBlob(servers, bytes, type, sk, expires, { always = false, cache = false } = {}) {
  const hash = hashOf(bytes);
  return Promise.all(servers.map(async (s) => {
    if (!always) {
      const h = await held(s, hash, bytes.length);
      if (h && cache && recentlyVerified(s, hash)) return { server: s, state: "ok" };
      if (h) {
        const g = await getBlob(s, hash);
        if (g.state === "ok") { if (cache) noteVerified(s, hash); return { server: s, state: "ok" }; }
      }
    }
    try { await putBlob(s, bytes, type, sk, expires); }
    catch (e) { return { server: s, state: "refused", why: e.message }; }
    // What a server says it took is not what it serves.
    let g = await getBlob(s, hash);
    if (g.state !== "ok") { await sleep(RETRY_MS / 2); g = await getBlob(s, hash); }
    if (g.state === "ok") { if (cache) noteVerified(s, hash); return { server: s, state: "ok" }; }
    return { server: s, state: g.state, why: `${s}: took the upload but ${g.state === "missing" ? "does not serve it" : g.state === "mismatch" ? "serves other bytes" : "could not be read back"}` };
  }));
}

/** Who holds `hash` now, checked. A recent full check plus a strict HEAD counts. */
async function holders(servers, hash, { cache = false } = {}) {
  return Promise.all(servers.map(async (s) => {
    if (cache && recentlyVerified(s, hash) && (await held(s, hash, null)) === true) return { server: s, state: "ok" };
    const g = await getBlob(s, hash);
    if (g.state === "ok" && cache) noteVerified(s, hash);
    return { server: s, state: g.state };
  }));
}

async function fetchBlob(servers, hash) {
  for (const s of servers) {
    const g = await getBlob(s, hash);
    if (g.state === "ok") return g.bytes;
  }
  fail(`no server has ${hash.slice(0, 12)}… any more`);
}

// Delete one blob from every server, with each key that may own it there.
async function dropBlob(servers, hash, signers) {
  const out = [];
  for (const s of servers) {
    let state = "refused";
    for (const sk of signers) {
      for (const auth of blossomAuth(sk, "delete", hash)) {
        try {
          const res = await fetch(`${norm(s)}/${hash}`, { method: "DELETE", headers: { Authorization: auth }, ...until(TIMEOUT.put) });
          if (res.ok) { state = "deleted"; break; }
          if (res.status === 404) { state = "gone"; break; }
          if (![400, 401, 403].includes(res.status)) break;
        } catch { break; }
      }
      if (state !== "refused") break;
    }
    out.push({ server: s, state });
  }
  return out;
}

/** Delete each of `list` everywhere. Resolves to the hashes no server keeps. */
async function purge(servers, list, signers) {
  const gone = [];
  for (const r of list) {
    const rows = await dropBlob(servers, r.hash, signers);
    if (rows.every((x) => x.state !== "refused")) gone.push(r.hash);
  }
  return gone;
}

// -------------------------------------------------------------------- gateway

/**
 * What the gateway serves for the page: its status and the hash of what it
 * served (from nsite.lol's ETag, which is the blob's sha256, or the bytes).
 * `serves` is current, older (a version this tool knows), other, none (404),
 * error (any other failure, the "Bad Gateway" kind) or unreachable.
 */
async function gatewayState(cfg, a, want, known = []) {
  if (!cfg.gatewayCheck) return { serves: "unchecked" };
  try {
    const res = await fetch(a.url, { headers: { "Cache-Control": "no-cache" }, ...until(TIMEOUT.gateway) });
    let got = etagHash(res.headers.get("etag"));
    if (res.ok && !got) got = hashOf(await readCapped(res));
    else { try { await res.body?.cancel(); } catch { /* closing */ } }
    const serves = !res.ok ? (res.status === 404 ? "none" : "error") : got === want ? "current" : known.includes(got) ? "older" : "other";
    return { status: res.status, ...(got ? { hash: got } : {}), serves };
  } catch (e) {
    return { serves: "unreachable", why: e?.name === "TimeoutError" ? "no answer" : e?.message };
  }
}

// ------------------------------------------------------------------ runtime

const RUNTIME_FILES = { "/nsite-clay.js": "text/javascript", "/nsite-clay-source.js": "text/javascript",
  "/nsite-clay-base.css": "text/css", "/nsite-clay-chrome.js": "text/javascript" };

// The page links its runtime from its own root, so the artifact's manifest has
// to name those files. Their blobs are the same for every artifact, so after
// the first one this uploads nothing: the servers already hold them.
// `also` is what the page's manifest already carries. A runtime file the page
// does not name in its markup (the serialiser the editor loads is one) can still be
// in its manifest from an earlier publish, and an upgrade that leaves it behind
// leaves the page offering an update to itself.
// What a runtime must say about itself before a workspace page goes onto it
// (src/sealed.js, Sealed.FEATURES): it opens a page whose read key is its own,
// and its delete button takes out that page and not the whole site.
const WORKSPACE_FEATURES = ["nc-split-keys-1", "nc-workspace-delete-1"];
function needWorkspaceRuntime(text) {
  if (!WORKSPACE_FEATURES.every((f) => text.includes(f))) {
    fail("the nsite-clay runtime these pages would load is too old for a workspace page: it would not open it, and its delete " +
      "button would take down every page of the workspace. Use a newer one: --runtime=<directory with nsite-clay.js>, or " +
      "\"runtime\" in the settings file, or wait for the next nsite-clay release.");
  }
}

async function runtimeFiles(cfg, pool, html, sealed, also = [], { workspace = false } = {}) {
  const wanted = Object.keys(RUNTIME_FILES).filter((p) => html.includes(p) || p === "/nsite-clay.js" || also.includes(p));
  if (cfg.runtime) {
    const files = wanted.map((p) => {
      const file = [join(cfg.runtime, p), join(cfg.runtime, "dist", p), join(cfg.runtime, "templates", "_shared", p)].find(existsSync);
      if (!file) fail(`the runtime directory ${cfg.runtime} has no ${p.slice(1)}`);
      const bytes = new Uint8Array(readFileSync(file));
      return { path: p, bytes, hash: hashOf(bytes), type: RUNTIME_FILES[p] };
    });
    if (workspace) needWorkspaceRuntime(new TextDecoder().decode(files.find((f) => f.path === "/nsite-clay.js").bytes));
    return files;
  }
  // Straight from the project's own nsite, the same place a published page
  // reads its upgrades from. The manifest is signed and every blob is checked
  // against the hash it names, so neither the relay nor the server is trusted.
  const owner = toHex(cfg.runtimeOwner);
  const lookup = [...new Set([...cfg.relays, "wss://relay.nsite.lol", "wss://relay.primal.net"])];
  const manifest = newestOf(flat(await ask(pool, lookup, { kinds: [15128], authors: [owner] })));
  if (!manifest) fail("could not find the nsite-clay runtime on the relays. Pass --runtime=<dir> with nsite-clay.js in it.");
  const table = tableOf(manifest);
  const from = [...new Set([...serversOf(manifest), ...cfg.servers])];
  const files = wanted.map((p) => {
    if (!table[p]) fail(`the published runtime has no ${p}`);
    let got = null;
    return { path: p, hash: table[p], type: RUNTIME_FILES[p], fetch: async () => (got ||= await fetchBlob(from, table[p])) };
  });
  // A runtime from before sealed pages existed would serve the shell and never
  // open it. Checked once per runtime build and remembered.
  if (sealed || workspace) {
    const engine = files.find((f) => f.path === "/nsite-clay.js");
    const okFile = join(HOME, "runtime-ok.json");
    const mark = workspace ? engine.hash + ":workspace" : engine.hash;
    let ok = [];
    try { ok = JSON.parse(readFileSync(okFile, "utf8")); } catch { /* none yet */ }
    if (!ok.includes(mark)) {
      const text = new TextDecoder().decode(await engine.fetch());
      if (!text.includes("application/nc-sealed")) {
        fail("the published nsite-clay runtime cannot open encrypted pages yet. Use a newer one: " +
          "--runtime=<directory with nsite-clay.js>, or \"runtime\" in the settings file.");
      }
      if (workspace) needWorkspaceRuntime(text);
      mkdirSync(HOME, { recursive: true, mode: 0o700 });
      writeFileSync(okFile, JSON.stringify([...ok, mark].slice(-20)), { mode: 0o600 });
    }
  }
  return files;
}

// The runtime files a page links, on the artifact's own servers, each read
// back from at least one of them.
async function putRuntime(pool, a, html, cfg, uploader, also = []) {
  const paths = {};
  for (const f of await runtimeFiles(cfg, pool, html, a.sealed, also, { workspace: !!a.workspace })) {
    const ready = a.servers.every((s) => recentlyVerified(s, f.hash)) &&
      (await Promise.all(a.servers.map((s) => held(s, f.hash, f.bytes?.length ?? null)))).every((h) => h === true);
    if (!ready) {
      const rows = await placeBlob(a.servers, f.bytes || await f.fetch(), f.type, uploader, null, { cache: true });
      if (!rows.some((r) => r.state === "ok")) fail(`no Blossom server holds ${f.path} after upload, so nothing was published: ${rows.map((r) => r.why || r.state).join("; ")}`);
    }
    paths[f.path] = f.hash;
  }
  return paths;
}

// Bytes for a hash, from wherever they can be had: the page's servers, the
// configured ones, a local runtime directory.
async function findBytes(cfg, a, hash, extra = []) {
  for (const s of union(a.servers, cfg.servers, extra)) {
    const g = await getBlob(s, hash);
    if (g.state === "ok") return g.bytes;
  }
  if (cfg.runtime) {
    for (const p of Object.keys(RUNTIME_FILES)) {
      for (const f of [join(cfg.runtime, p), join(cfg.runtime, "dist", p), join(cfg.runtime, "templates", "_shared", p)]) {
        if (existsSync(f)) { const b = new Uint8Array(readFileSync(f)); if (hashOf(b) === hash) return b; }
      }
    }
  }
  return null;
}

// Every path of a table other than the page itself is on at least one server,
// read back; one that is on none is put back from wherever it can be found.
async function ensurePaths(cfg, a, paths, uploader) {
  for (const [p, hash] of Object.entries(paths)) {
    if (p === "/index.html") continue;
    const rows = await holders(a.servers, hash, { cache: true });
    if (rows.some((r) => r.state === "ok")) continue;
    const bytes = await findBytes(cfg, a, hash);
    if (!bytes) fail(`no server has ${p} of ${a.id} any more and no copy of it was found, so nothing was published. Run "upgrade ${a.id}".`);
    const put = await placeBlob(a.servers, bytes, RUNTIME_FILES[p] || "application/octet-stream", uploader, null, { cache: true });
    if (!put.some((r) => r.state === "ok")) fail(`no server took ${p} back, so nothing was published`);
  }
}

// --------------------------------------------------------------- workspaces
//
// A workspace is one site under one key, with many pages in it: each page is
// /<id>/index.html, sealed with a read key of its own, so a link to one page
// opens that page and no other. The agent keeps one key instead of one per
// page, and a Blossom server that takes uploads only from keys it knows has to
// be told about one key once.
//
// What makes it harder than a site per page: a site's manifest is one
// replaceable event that lists every path, so two writers that each publish
// their own idea of the whole list can drop each other's pages. So nothing
// here ever writes a whole list. A change is a set of paths to set or drop,
// merged into the manifest as it is on the relays right now, with every other
// tag kept exactly as it was:
//
//   1. one run at a time per workspace on this machine (a lock file, held
//      across the network work, which the ledger's lock never is);
//   2. the newest manifest from every relay, the change merged into it, and
//      the result signed with a created_at above it;
//   3. read again right before it is sent: if anything moved, back to 2;
//   4. sent, read back from every relay. A newer manifest without this change
//      means another writer won the race: back to 2, from theirs;
//   5. a moment later, read once more, for a writer whose read came just
//      before this one was sent: if this change is gone, back to 2.
//
// Bounded: after COMMIT_TRIES rounds it says so and leaves the workspace to
// `workspace verify`, which finds a page whose path went missing, and
// `workspace doctor --fix`, which puts it back.

const SETTLE_MS = Number(process.env.NSITE_ARTIFACTS_SETTLE_MS ?? 2000);
const COMMIT_TRIES = 6;
const WS_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const wsFilter = (ws) => ({ kinds: [15128], authors: [ws.pubkey] });
const isRuntimePath = (p) => Object.prototype.hasOwnProperty.call(RUNTIME_FILES, p);

function workspaceOf(a, ledger = readLedger()) {
  const ws = ledger.workspaces[a.workspace];
  if (!ws) fail(`${a.id} belongs to the workspace "${a.workspace}", which is not in this ledger. Take it in with "workspace adopt <file>".`);
  return ws;
}

/** Which workspace a command means: a name, true for the configured or "default" one, or null for none. */
function workspaceName(cfg, given) {
  if (flags["no-workspace"]) return null;
  const v = given !== undefined ? given : one(flags.workspace);
  const name = v === undefined ? cfg.workspace : v === true ? (cfg.workspace || "default") : v;
  if (name == null || name === "" || name === false) return null;
  if (!WS_NAME.test(String(name))) fail(`"${name}" is not a workspace name: lower case letters, digits, - and _, at most 32`);
  return String(name);
}

function needWorkspace(name, ledger = readLedger()) {
  const ws = ledger.workspaces[name];
  if (!ws) {
    fail(`there is no workspace "${name}" here. Make one with "workspace init${name === "default" ? "" : ` --name=${name}`}", ` +
      `or take one in from another machine with "workspace adopt <file>".`);
  }
  return ws;
}

// One writer per workspace on this machine. Unlike the ledger's lock this one
// is held across network calls, which is the point of it, so it waits longer.
async function withWorkspaceLock(name, fn) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const file = join(HOME, `workspace-${name}.lock`);
  const end = Date.now() + Number(process.env.NSITE_ARTIFACTS_WS_LOCK_MS ?? 180000);
  for (;;) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      break;
    } catch (e) { if (e.code !== "EEXIST") throw e; }
    try {
      const info = JSON.parse(readFileSync(file, "utf8"));
      if (!alive(info.pid) || Date.now() - info.at > 600000) { unlinkSync(file); continue; }
    } catch {
      try { if (Date.now() - statSync(file).mtimeMs > 5000) { unlinkSync(file); continue; } } catch { continue; }
    }
    if (Date.now() > end) fail(`the workspace "${name}" is being written by another run of this tool (${file}). Try again in a moment.`);
    await sleep(80 + Math.floor(Math.random() * 120));
  }
  try { return await fn(); } finally { try { unlinkSync(file); } catch { /* gone */ } }
}

/** Whether manifest `m` carries `change`: every path it sets, at that hash, and none it drops. */
function holds(m, change) {
  const t = tableOf(m);
  return Object.entries(change.set || {}).every(([p, h]) => t[p] === h) && (change.drop || []).every((p) => !t[p]);
}

// The live manifest with `change` merged in. Every tag that is not a path
// this change touches stays byte for byte as it was, in its place; the
// aggregate and the retired list are worked out again from the result, and a
// workspace's manifest never expires (each page expires by itself, by sweep).
function mergeManifest(ws, live, change, sk) {
  const liveTable = tableOf(live);
  const removed = ws.removed || {};
  const set = new Map(Object.entries(change.set || {}));
  const drop = new Set(change.drop || []);
  // A path this ledger took out, which a browser tab that still had an older
  // table put back on its next save: it names a file that is gone. Out again.
  const healed = Object.keys(liveTable).filter((p) => !set.has(p) && (removed[p] || []).includes(liveTable[p]));
  for (const p of healed) drop.add(p);
  for (const [p, h] of Object.entries(change.setIfMissing || {})) if (!liveTable[p] && !set.has(p)) set.set(p, h);
  const pathTags = [], rest = [];
  for (const tag of live?.tags || []) {
    if (tag[0] === "path") {
      if (drop.has(tag[1])) continue;
      if (set.has(tag[1])) { pathTags.push(["path", tag[1], set.get(tag[1])]); set.delete(tag[1]); continue; }
      pathTags.push(tag);
      continue;
    }
    if (["x", "expiration", "retired", "d"].includes(tag[0])) continue;
    rest.push(tag);
  }
  for (const [p, h] of set) pathTags.push(["path", p, h]);
  const paths = Object.fromEntries(pathTags.map((x) => [x[1], x[2]]));
  for (const s of ws.servers) if (!rest.some((x) => x[0] === "server" && norm(x[1] || "") === s)) rest.push(["server", s]);
  if (change.sealed && !rest.some((x) => x[0] === "sealed")) rest.push(["sealed", "1"]);
  const forget = new Set(change.forget || []);
  const retired = mergeRetired([retiredOf(live), change.retire || []], Object.values(paths)).filter((r) => !forget.has(r.hash));
  const lines = Object.entries(paths).map(([p, h]) => `${h} ${p}\n`).sort().join("");
  const tags = [...pathTags, ["x", hashOf(enc.encode(lines)), "aggregate"], ...rest, ...retiredTags(retired.slice(-MAX_RETIRED))];
  const created_at = Math.max(now(), (live?.created_at ?? 0) + 1);
  // Nothing to say that the live one does not say already.
  const canon = (list) => list.filter((x) => x[0] !== "x").map((x) => JSON.stringify(x)).sort().join("\n");
  const same = !!live && canon(tags) === canon(live.tags);
  return { event: finalizeEvent({ kind: 15128, created_at, tags, content: "" }, sk), paths, healed, same };
}

// After a workspace manifest went out: every relay read back by itself. A
// relay is current when it returns this manifest, or a later one that still
// carries this change (another writer merged on top of it). A later one that
// does not means this change lost a race, and the caller merges again.
async function confirmWorkspace(pool, ws, manifest, change, cfg) {
  let rows = [];
  const tops = new Map();
  for (let round = 0; round < 4; round++) {
    if (round) await sleep(READBACK_MS * round);
    const per = await askEach(pool, ws.relays, wsFilter(ws), TIMEOUT.relay);
    rows = ws.relays.map((url) => {
      const evs = per.get(url);
      if (evs == null) return { url, has: "unreachable" };
      const top = newestOf(evs);
      if (!top) return { url, has: "none" };
      tops.set(url, top);
      if (top.id === manifest.id) return { url, has: "current" };
      if (top.created_at >= manifest.created_at) return holds(top, change) ? { url, has: "current", merged: top.id } : { url, has: "newer", id: top.id };
      return { url, has: "older" };
    });
    if (rows.some((r) => r.has === "newer")) break;
    const lag = rows.filter((r) => r.has === "older" || r.has === "none");
    if (!lag.length || round === 3) break;
    await publish(pool, lag.map((r) => r.url), manifest);
  }
  const current = rows.filter((r) => r.has === "current").length;
  const need = Math.floor(ws.relays.length / 2) + 1;
  const gw = norm(cfg.gatewayRelay || ws.relays[0]);
  const gwRow = rows.find((r) => r.url === gw);
  return {
    rows, current, of: ws.relays.length, need, gatewayRelay: gw,
    ok: current >= need && (!gwRow || gwRow.has === "current"),
    lagging: rows.filter((r) => r.has !== "current").map((r) => `${r.url} (${r.has})`),
    lost: rows.some((r) => r.has === "newer"), conflict: null, tops: [...tops.values()],
  };
}

/**
 * Change some paths of a workspace's manifest and nothing else (see above).
 * `change`: { set: {path: hash}, setIfMissing: {path: hash}, drop: [path],
 * expect: {path: hash|null}, retire: [{hash, at, path}], forget: [hash], sealed }.
 * `expect` is what the caller built on: a path that moved since fails with
 * code "moved", before anything is sent. Resolves to { manifest, relays, attempts }.
 */
async function commitPaths(pool, ws, cfg, change) {
  const sk = unb64u(ws.secret);
  return withWorkspaceLock(ws.name, async () => {
    let why = "";
    for (let attempt = 0; attempt < COMMIT_TRIES; attempt++) {
      if (attempt) await sleep(RETRY_MS * attempt + Math.floor(Math.random() * RETRY_MS));
      const live = newestOf(flat(await askEach(pool, ws.relays, wsFilter(ws))));
      // Another writer merged this change in already, after a race this lost.
      if (attempt && live && holds(live, change)) {
        return { manifest: live, relays: await confirmWorkspace(pool, ws, live, change, cfg), attempts: attempt + 1, base: live };
      }
      const table = tableOf(live);
      for (const [p, want] of Object.entries(change.expect || {})) {
        if ((table[p] ?? null) !== want) {
          const e = new Fail(`${p} in the workspace "${ws.name}" changed while this was being written`);
          e.code = "moved"; e.now = table[p] ?? null;
          throw e;
        }
      }
      const { event, healed, same } = mergeManifest(ws, live, change, sk);
      if (same) return { manifest: live, relays: await confirmWorkspace(pool, ws, live, change, cfg), attempts: attempt + 1, base: live, unchanged: true };
      const again = newestOf(flat(await askEach(pool, ws.relays, wsFilter(ws))));
      if ((again?.id || null) !== (live?.id || null)) { why = "the workspace's manifest changed while this was being written"; continue; }
      const pause = Number(process.env.NSITE_ARTIFACTS_TEST_PAUSE_MS || 0);
      if (pause) await sleep(pause);
      const took = await publish(pool, ws.relays, event);
      if (!took.length) { why = "no relay accepted the workspace's manifest"; continue; }
      dieAt("after-publish");
      const relays = await confirmWorkspace(pool, ws, event, change, cfg);
      if (relays.lost) { why = "another writer published the workspace at the same moment"; log({ cmd: "commit", workspace: ws.name, retry: attempt + 1, why }); continue; }
      if (healed.length) log({ cmd: "commit", workspace: ws.name, healed });
      if (!relays.ok) return { manifest: event, relays, attempts: attempt + 1, base: live, healed };
      if (SETTLE_MS) {
        await sleep(SETTLE_MS);
        const later = newestOf(flat(await askEach(pool, ws.relays, wsFilter(ws))));
        if (later && later.id !== event.id && !holds(later, change)) {
          why = "another writer replaced the workspace's manifest a moment later, without this change";
          log({ cmd: "commit", workspace: ws.name, retry: attempt + 1, why });
          continue;
        }
      }
      return { manifest: event, relays, attempts: attempt + 1, base: live, healed };
    }
    const e = new Fail(`${why}, ${COMMIT_TRIES} times in a row, so this change may not be in the workspace "${ws.name}". ` +
      `Run "workspace verify --name=${ws.name}", then try again.`);
    e.published = true;
    throw e;
  });
}

// Every relay's newest manifest of a workspace, and the newest of them.
async function workspaceTops(pool, ws) {
  const per = await askEach(pool, ws.relays, wsFilter(ws));
  const tops = [...per.values()].map((evs) => newestOf(evs || [])).filter(Boolean);
  return { per, tops, newest: newestOf(tops) };
}

// ----------------------------------------------------------------- the page

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// What the tool decides and the model does not: whose page this is and where
// it lives. Whatever the file said about those is replaced, in any case and
// with any quoting, and the tool's own attributes come first, because a
// browser keeps the first of two attributes with the same name.
const OWNED = new Set(["nc:owner", "nc:site", "nc:path", "nc:relays", "nc:servers", "nc:sealed", "nc:expires"]);
const HTML_TAG = /<html\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const BASE_META = /<meta\b[^>]*\bname\s*=\s*["']?nc:base\b[^>]*>\n?/gi;
function stampPage(html, { npub, relays, servers, edit, comments, path }) {
  if (!/<html\b/i.test(html)) fail("that file is not an HTML document: it has no <html> element");
  // Comments are for pages somebody can change: a comment is saved with the page.
  const withComments = comments !== false && edit !== "none";
  let out = html.replace(BASE_META, "").replace(HTML_TAG, (_, attrs) => {
    const kept = [];
    let has = false;
    for (const m of attrs.matchAll(ATTR)) {
      const name = m[1].toLowerCase();
      if (OWNED.has(name)) continue;
      if (name === "nc:comments") has = true;
      kept.push(m[0]);
    }
    const ours = `nc:owner="${npub}" nc:path="${path || "/index.html"}" nc:relays="${relays.join(",")}" nc:servers="${servers.join(",")}"`;
    return `<html ${ours}${kept.length ? " " + kept.join(" ") : ""}${withComments && !has ? " nc:comments" : ""}>`;
  });
  if (!/<script\b[^>]*\bsrc\s*=\s*["']?\/nsite-clay(-[0-9a-f]{8})?\.js/i.test(out)) {
    const tag = `<script src="/nsite-clay.js"></script>`;
    out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, () => tag + "\n</head>") : out.replace(HTML_TAG, (m) => m + tag);
  }
  return out;
}

// The version a file handed out by `read --as=html` was made from, carried in
// the file itself, so `update` can refuse it when the page moved on since.
function withBase(html, hash) {
  const meta = `<meta name="nc:base" content="${hash}">\n`;
  const clean = html.replace(BASE_META, "");
  return /<head\b[^>]*>/i.test(clean) ? clean.replace(/<head\b[^>]*>\n?/i, (m) => m + meta) : clean.replace(HTML_TAG, (m) => m + meta);
}
const baseOf = (html) => /<meta\b[^>]*\bname\s*=\s*["']?nc:base["']?[^>]*\bcontent\s*=\s*["']?([0-9a-f]{64})/i.exec(html)?.[1] || null;

// A page can be opened with an edit link and still have nothing in it to change:
// the runtime only lets people type into what is marked editable, and into fields
// and boxes a page draws itself. An agent that forgets this sends an edit link and
// the person finds a page they cannot touch. Said when the page is made.
function editHint(html, { edit, comments }) {
  if (edit === "none") return null;
  const editable = /<[a-z][^>]*[\s"']editable(?=[\s=>/])/i.test(html) || /\scontenteditable\b/i.test(html);
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

// What every path that publishes a page checks first: create, update, reply,
// share, doctor. Returns warnings; refuses what cannot work. An origin the
// published page already loads from (`was`) is only warned about: refusing it
// would refuse every change to a page somebody else broke.
function checkPage(html, a, was = null) {
  const size = Buffer.byteLength(html);
  if (size > MAX_PAGE) {
    fail(`this page is ${(size / 1e6).toFixed(1)} MB, and a page is uploaded whole on every save. Keep it under 3 MB: make the pictures in it smaller.`);
  }
  if (!a.sealed) return [];
  const allow = a.allow || allowedBy(a.policy);
  const blocked = foreignLoads(html).filter((o) => !allow.some((x) => norm(x) === o));
  const already = was ? foreignLoads(was) : [];
  if (blocked.some((o) => !already.includes(o)) && !a.allowBlocked) {
    fail(`this page loads from ${blocked.join(", ")}. An encrypted page may only load what is inside it: ` +
      `put the script, style, font or image in the file itself. (--allow-origin=<origin> on create lets one through, ` +
      `and tells that origin when the page is opened.)`);
  }
  return blocked.length ? [`the page loads from ${blocked.join(", ")}, which its policy blocks: those parts will not show`] : [];
}

// The origins an older entry's policy lets through, for entries from before
// the ledger kept them as a list.
const allowedBy = (policy) => (/script-src 'self' 'unsafe-inline'([^;]*)/.exec(policy || "")?.[1] || "").trim().split(/\s+/).filter(Boolean);

async function sealPage(html, a, keys) {
  const where = whereOf(a);
  const sealed = await sealText(html, keys.K, where);
  const engine = /<script\b[^>]*\bsrc\s*=\s*["']?(\/nsite-clay(?:-[0-9a-f]{8})?\.js)/i.exec(html)[1];
  const shell = buildShell({
    owner: a.npub, path: where.path, relays: a.relays, servers: a.servers,
    lang: /<html\b[^>]*\blang\s*=\s*["']?([^"'\s>]*)/i.exec(html)?.[1] || "en",
    title: a.shellTitle || "Private page", policy: a.policy,
    head: `<script src="${engine}" nc:shell></script>`,
    sealed, expires: a.expires || null,
    wraps: (a.members || []).map((m) => wrapFor(keys.sk, m.pubkey, m.role, keys.K, { split: !!keys.split })),
  });
  assertShell(shell);
  // And it opens with the key every reader has. A save nobody could read back
  // is worse than no save.
  if (await openText(parseShell(shell).sealed, keys.K, where) !== html) fail("the sealed page did not open again, so nothing was published");
  return shell;
}

// The page as it is published now: the manifest, the bytes, and for a sealed
// page the text inside. `forWrite` waits for every relay and refuses anything
// but the newest version, because what follows builds on it.
async function fetchPage(pool, a, keys, { forWrite = false } = {}) {
  const filter = { kinds: [15128], authors: [a.pubkey] };
  const per = forWrite ? await askEach(pool, a.relays, filter) : await ask(pool, a.relays, filter);
  const manifests = flat(per).filter((e) => e.kind === 15128).sort((x, y) => y.created_at - x.created_at);
  if (!manifests.length) {
    const reached = [...per.values()].filter((v) => v != null).length;
    fail(reached ? `no relay has ${a.id} any more. It may have expired or been deleted.` : `no relay could be reached to read ${a.id}. Check the network and try again.`);
  }
  const newest = manifests[0];
  const warnings = [];
  const relays = standing(a.relays, per, newest, a.workspace ? pathOf(a) : null);
  const behind = relays.filter((r) => r.has === "older" || r.has === "none");
  if (behind.length) warnings.push(`${behind.length} of ${a.relays.length} relays have an older version or none: ${behind.map((r) => r.url).join(", ")}`);
  let used = newest, bytes = null;
  const path = pathOf(a);
  for (const m of manifests) {
    const hash = tableOf(m)[path];
    if (!hash) {
      if (m === newest) fail(`${a.id} has no page any more (it was deleted)`);
      continue;
    }
    const servers = union(a.servers, serversOf(m));
    for (const s of servers) { const g = await getBlob(s, hash); if (g.state === "ok") { bytes = g.bytes; break; } }
    if (bytes) { used = m; break; }
    if (forWrite || m !== newest) break;
  }
  if (!bytes) {
    fail(used === newest || forWrite
      ? `the newest version of ${a.id} (saved ${iso(newest.created_at)}) is on no server any more. Run "doctor ${a.id}" to see what is left and "doctor ${a.id} --fix" to repair it.`
      : `no server has any recent version of ${a.id} any more`);
  }
  if (used !== newest) warnings.push(`the newest version (saved ${iso(newest.created_at)}) is on no server; this is the one saved ${iso(used.created_at)}. Run "doctor ${a.id} --fix".`);
  const table = tableOf(used);
  const hash = table[path];
  const text = new TextDecoder().decode(bytes);
  const shell = parseShell(text);
  // The ledger says whether this artifact is sealed, not the bytes that came
  // back. A plain page where a sealed one should be is a fault, not content.
  if (a.sealed && !shell) fail(`${a.id} is a sealed artifact, but what is published is not sealed. Not reading it.`);
  const html = shell ? await openText(shell.sealed, keys.K, whereOf(a)) : text;
  return { manifest: used, newest, fallback: used !== newest, table, hash, html, shell, relays, warnings };
}

// One manifest naming `paths`, newer than `live`. No version snapshot: an
// artifact keeps only its current version, and names the ones it retired.
function signManifest(a, sk, paths, live, retired = []) {
  const lines = Object.entries(paths).map(([p, h]) => `${h} ${p}\n`).sort().join("");
  const expiration = a.expires ? [["expiration", String(a.expires)]] : [];
  const tags = [
    ...Object.entries(paths).map(([p, h]) => ["path", p, h]),
    ["x", hashOf(enc.encode(lines)), "aggregate"],
    ...a.servers.map((s) => ["server", s]),
    // A sealed page publishes nothing about itself: no title, no description.
    ...(a.sealed ? [["sealed", "1"]] : a.title ? [["title", String(a.title)]] : []),
    ...expiration,
    // The newest ones, if there are more than a manifest should carry; the
    // ledger keeps all of them.
    ...retiredTags(retired.slice(-MAX_RETIRED)),
  ];
  const created_at = Math.max(now(), (live?.created_at ?? 0) + 1);
  return finalizeEvent({ kind: 15128, created_at, tags, content: "" }, sk);
}

// Gateways other than nsite.lol find a site through its key's relay list, and a
// key made a moment ago has none. Also sent again when the expiry changes.
const listRelays = (a) => [...new Set([...a.relays, ...(isLocal(a.relays) ? [] : ["wss://purplepag.es", "wss://user.kindpag.es"])])];
async function publishRelayList(pool, a, sk, created_at) {
  const list = finalizeEvent({ kind: 10002, created_at, content: "",
    tags: [...a.relays.filter((r) => !/relay\.nsite\.lol/.test(r)).map((r) => ["r", r]),
      ...(a.expires ? [["expiration", String(a.expires)]] : [])] }, sk);
  await publish(pool, listRelays(a), list);
}

// For tests only: stop dead at a named point, the way a harness that times a
// command out does.
const dieAt = (point) => { if (process.env.NSITE_ARTIFACTS_TEST_EXIT === point) process.exit(9); };

/**
 * Publish `html` as the artifact's page. In order:
 *   1. seal, upload to every server, read back from every one; fewer than
 *      `minServers` holding it and nothing is published;
 *   2. the runtime files, each on at least one server;
 *   3. the manifest is read again, and if somebody saved meanwhile nothing is
 *      published;
 *   4. the manifest goes out, naming the version it replaces as retired;
 *   5. it is read back from every relay and sent again to any that lack it;
 *      without the gateway's relay and a majority, the previous manifest is
 *      put back (possible, because nothing was deleted) and this fails;
 *   6. the gateway is asked what it serves, and retired versions whose time
 *      has come, on a page everything agrees on, are deleted.
 * `onUploaded(hash)` runs between 1 and 4, so the ledger knows the blob before
 * anything names it.
 */
async function publishPage(pool, a, keys, html, cfg, { live = null, table = null, onUploaded = null } = {}) {
  const sk = keys.sk;
  const uploader = uploaderKey(cfg, sk);
  const body = enc.encode(a.sealed ? await sealPage(html, a, keys) : html);
  const hash = hashOf(body);
  const need = Math.min(cfg.minServers, a.servers.length);
  const rows = await placeBlob(a.servers, body, "text/html", uploader, a.expires, { always: true });
  const on = rows.filter((r) => r.state === "ok").map((r) => r.server);
  onUploaded?.(hash);
  if (on.length < need) {
    fail(`only ${on.length} of ${a.servers.length} servers hold the page after upload (${need} needed), so nothing was published. ` +
      rows.filter((r) => r.state !== "ok").map((r) => r.why || `${r.server}: ${r.state}`).join("; ") + refusalHint(rows, uploader));
  }
  if (a.workspace) return publishInWorkspace(pool, a, keys, html, cfg, { live, hash, rows, on, uploader });

  const paths = table ? { ...table } : await putRuntime(pool, a, html, cfg, uploader);
  if (table) await ensurePaths(cfg, a, paths, uploader);
  const before = paths["/index.html"];
  paths["/index.html"] = hash;

  if (live) {
    const again = newestOf(flat(await askEach(pool, a.relays, { kinds: [15128], authors: [a.pubkey] })));
    if (again && again.id !== live.id && again.created_at >= live.created_at) {
      await dropBlob(a.servers, hash, signersOf(cfg, sk));
      fail(`${a.id} was saved by somebody else while this was uploading (at ${iso(again.created_at)}), so nothing was published. Run "read ${a.id}" and make the change again.`);
    }
  }

  const t = now();
  const inUse = Object.values(paths);
  const fresh = before && !inUse.includes(before) ? [{ hash: before, at: t }] : [];
  const retired = mergeRetired([a.retired || [], retiredOf(live), fresh], inUse);
  const manifest = signManifest(a, sk, paths, live, retired);
  const took = await publish(pool, a.relays, manifest);
  if (!took.length) {
    await dropBlob(a.servers, hash, signersOf(cfg, sk));
    fail("no relay accepted the page's manifest, so nothing changed. Try again in a moment.");
  }
  dieAt("after-publish");
  if (!live) await publishRelayList(pool, a, sk, manifest.created_at);

  const relays = await confirmPublish(pool, a, manifest, cfg);
  if (!relays.ok && !relays.conflict) {
    const why = `the new version reached ${relays.current} of ${relays.of} relays` +
      (relays.rows.find((r) => r.url === relays.gatewayRelay)?.has !== "current" ? `, and not ${relays.gatewayRelay}, which the gateway reads` : "");
    if (live) {
      // Back to what was there. Nothing was deleted, so it still opens; this
      // version stays named as retired, for the relays that did take it.
      const back = signManifest(a, sk, tableOf(live), manifest, mergeRetired([retired, [{ hash, at: t }]], Object.values(tableOf(live))));
      await publish(pool, a.relays, back);
      const e = new Fail(`${why}, so the previous version was put back and nothing changed. Try again later; "verify ${a.id}" shows each relay.`);
      e.retired = mergeRetired([retired, [{ hash, at: t }]], Object.values(tableOf(live)));
      throw e;
    }
    const e = new Fail(`${why}, so the page was taken down again. Try again later.`);
    e.published = true;
    throw e;
  }
  const gateway = await gatewayState(cfg, a, hash, [before, ...retired.map((r) => r.hash)].filter(Boolean));
  const settled = relays.current === relays.of && gateway.serves === "current";
  const plan = planRetired(retired, { now: t, after: cfg.retireAfter, settled, max: Infinity });
  const purged = plan.purge.length ? await purge(a.servers, plan.purge, signersOf(cfg, sk)) : [];
  return {
    hash, manifest, servers: on, serverRows: rows, relays, gateway, purged,
    retired: retired.filter((r) => !purged.includes(r.hash)),
    conflict: relays.conflict,
  };
}

// A server that answers 401 or 403 to an upload usually takes uploads only
// from keys it was told about. Say which key that is: it is public.
function refusalHint(rows, uploader) {
  if (!rows.some((r) => r.state === "refused" && /: 40[13]\b/.test(r.why || ""))) return "";
  return `. A server that answers 401 or 403 may take uploads only from keys it allows: ask its operator to allow ` +
    `${nip19.npubEncode(getPublicKey(uploader))}, or leave it out of "servers" in the settings.`;
}

// The workspace half of publishPage: the same upload, then one path changed
// in the shared manifest (see commitPaths), the version it replaced retired
// under this path, and only this page's own retired versions ever deleted,
// never one that a path of any relay's manifest still names.
async function publishInWorkspace(pool, a, keys, html, cfg, { live, hash, rows, on, uploader }) {
  const ws = workspaceOf(a);
  const path = pathOf(a);
  const runtime = await putRuntime(pool, a, html, cfg, uploader);
  const before = live ? tableOf(live)[path] || null : null;
  const t = now();
  const fresh = before && before !== hash ? [{ hash: before, at: t, path }] : [];
  const forget = [...(a.forget || [])];
  const change = { set: { [path]: hash }, setIfMissing: runtime, expect: { [path]: before }, retire: fresh, forget, sealed: a.sealed };
  let res;
  try { res = await commitPaths(pool, ws, cfg, change); }
  catch (e) {
    if (e.code === "moved") {
      await dropBlob(a.servers, hash, signersOf(cfg, keys.sk));
      fail(`${a.id} was saved by somebody else while this was uploading, so nothing was published. Run "read ${a.id}" and make the change again.`);
    }
    throw e;
  }
  if (!res.relays.ok) {
    const why = `the new version reached ${res.relays.current} of ${res.relays.of} relays` +
      (res.relays.rows.find((r) => r.url === res.relays.gatewayRelay)?.has !== "current" ? `, and not ${res.relays.gatewayRelay}, which the gateway reads` : "");
    const back = [{ hash, at: t, path }];
    if (before) {
      await commitPaths(pool, ws, cfg, { set: { [path]: before }, retire: back, sealed: a.sealed }).catch(() => {});
      const e = new Fail(`${why}, so the previous version was put back and nothing changed. Try again later; "verify ${a.id}" shows each relay.`);
      e.retired = mergeRetired([a.retired || [], back]);
      throw e;
    }
    const e = new Fail(`${why}, so the page was taken down again. Try again later.`);
    e.published = true;
    throw e;
  }
  const gateway = await gatewayState(cfg, a, hash, [before, ...(a.retired || []).map((r) => r.hash)].filter(Boolean));
  const own = mergeRetired([a.retired || [], retiredFor(retiredOf(res.manifest), path), fresh]).filter((r) => r.hash !== hash);
  const settled = res.relays.current === res.relays.of && gateway.serves === "current";
  const named = namedHashes([res.manifest, ...res.relays.tops]);
  const plan = planRetired(own.filter((r) => !named.has(r.hash)), { now: t, after: cfg.retireAfter, settled, max: Infinity });
  const purged = plan.purge.length ? await purge(a.servers, plan.purge, signersOf(cfg, keys.sk)) : [];
  return {
    hash, manifest: res.manifest, servers: on, serverRows: rows, relays: res.relays, gateway, purged,
    retired: own.filter((r) => !purged.includes(r.hash)), conflict: null, forgotten: forget,
  };
}

// What every write reports about how it landed.
function landed(res, a, cfg) {
  const need = Math.min(cfg.minServers, a.servers.length);
  const out = {
    verified: res.relays.ok && res.servers.length >= need,
    relays: { ok: res.relays.current, of: res.relays.of, ...(res.relays.lagging.length ? { lagging: res.relays.lagging } : {}) },
    servers: { ok: res.servers.length, of: a.servers.length,
      ...(res.servers.length < a.servers.length ? { failed: res.serverRows.filter((r) => r.state !== "ok").map((r) => r.why || r.server) } : {}) },
    gateway: res.gateway.serves,
  };
  const warnings = [];
  if (res.relays.lagging.length) warnings.push(`${res.relays.of - res.relays.current} of ${res.relays.of} relays do not have this version yet: ${res.relays.lagging.join(", ")}`);
  if (res.servers.length < a.servers.length) warnings.push(`stored on ${res.servers.length} of ${a.servers.length} servers`);
  const refused = res.serverRows.filter((r) => r.state === "refused" && /: 40[13]\b/.test(r.why || "")).map((r) => r.server);
  if (refused.length) {
    warnings.push(`${refused.join(", ")} refused the upload (401 or 403), so the page is on the other servers. A server that takes uploads only from keys it allows ` +
      `needs to be told about the key that uploads (${a.workspace ? `"workspace list" shows it` : `in a workspace that is one key for every page`}).`);
  }
  if (res.gateway.serves === "error") warnings.push(`the gateway answers ${res.gateway.status} for the page right now. The new version is published; if this lasts, run "verify ${a.id}".`);
  if (res.conflict) warnings.push(`somebody saved a newer version while this one went out (${res.conflict.map((r) => r.url).join(", ")}). Run "read ${a.id}" to see which one is there.`);
  return { out, warnings };
}

// The fields of a ledger entry that a successful publish changes.
function applyPublish(e, res) {
  e.hash = res.hash; e.savedAt = res.manifest.created_at; e.state = "live";
  addBlobs(e, [res.hash]);
  e.retired = mergeRetired([e.retired || [], res.retired]).filter((r) => r.hash !== res.hash && !res.purged.includes(r.hash));
  if (res.purged.length) dropBlobs(e, res.purged);
  // A workspace page's deleted versions leave the shared manifest's retired
  // list on its next save.
  if (e.workspace) e.forget = [...new Set([...(e.forget || []).filter((h) => !(res.forgotten || []).includes(h)), ...res.purged])];
  e.serverState = Object.fromEntries(res.serverRows.map((r) => [r.server, r.state]));
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

// Line by line, in order, which is all a list needs. Two rows with the same
// words are told apart by which of them they are, first, second, and so on.
function changes(before, after) {
  const bare = (l) => l.replace(/^\[[ x]\] /, "");
  const keyed = (text) => {
    const seen = new Map();
    return text.split("\n").filter((l) => l.trim()).map((l) => {
      const b = bare(l), n = seen.get(b) || 0;
      seen.set(b, n + 1);
      return [`${b}\u0000${n}`, l];
    });
  };
  const a = keyed(before), b = keyed(after);
  const was = new Map(a), is = new Map(b);
  const out = [];
  for (const [k, l] of b) {
    const old = was.get(k);
    if (old === undefined) out.push({ change: "added", line: l });
    else if (old !== l) out.push({ change: l.startsWith("[x]") ? "checked" : "unchecked", line: bare(l) });
  }
  for (const [k, l] of a) if (!is.has(k)) out.push({ change: "removed", line: l });
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

// Two marks per page, kept apart: the page as `read` last saw it, which the
// update guard and `changes` are measured against, and the comments as
// `comments` last listed them. Looking at comments never moves the first.
const seenFile = (a) => join(HOME, "seen", a.id + ".txt");
const seenHtmlFile = (a) => join(HOME, "seen", a.id + ".html");
const commentsMarkFile = (a) => join(HOME, "seen", a.id + ".comments.json");
function remember(a, text, html) {
  mkdirSync(join(HOME, "seen"), { recursive: true, mode: 0o700 });
  writeFileSync(seenFile(a), text, { mode: 0o600 });
  if (html != null) writeFileSync(seenHtmlFile(a), html, { mode: 0o600 });
}
function seenHtml(a) { try { return readFileSync(seenHtmlFile(a), "utf8"); } catch { return null; } }
const markOf = (list) => list.map((c) => ({ id: c.id, state: c.state, replies: c.replies.length }));
function commentsMark(a) { try { return JSON.parse(readFileSync(commentsMarkFile(a), "utf8")); } catch { return null; } }
function saveCommentsMark(a, mark) {
  mkdirSync(join(HOME, "seen"), { recursive: true, mode: 0o700 });
  writeFileSync(commentsMarkFile(a), JSON.stringify(mark), { mode: 0o600 });
}

// ----------------------------------------------------------------- commands

function linksOf(a, keys) {
  const read = a.sealed ? `${a.url}#${fragmentOf(keys, { edit: false })}` : a.url;
  const edit = `${a.url}#${fragmentOf(keys)}`;
  // The one link to send, by what the artifact was made for. A private
  // artifact is opened by signing in, so its link carries no key at all.
  const share = a.visibility === "private" ? a.url : a.edit === "link" ? edit : read;
  return { url: a.url, link: share, readLink: a.visibility === "private" ? null : read, editLink: a.edit === "link" ? edit : null };
}

const publicOf = (a) => ({ id: a.id, title: a.title });

async function create(file, opts = {}) {
  const cfg = settings();
  if (!file && opts.html == null) fail("usage: create <file.html> [--visibility=public|link|private] [--edit=none|link|members] [--member=npub…] [--expires=30d] [--title=…]");
  const visibility = opts.visibility || val("visibility") || cfg.defaults.visibility;
  const edit = opts.edit || val("edit") || cfg.defaults.edit;
  if (!["public", "link", "private"].includes(visibility)) fail("--visibility is public, link or private");
  if (!["none", "link", "members"].includes(edit)) fail("--edit is none, link or members");
  if (visibility === "private" && edit === "link") fail("a private artifact has no link that opens it, so it cannot have an edit link. Use --edit=members, or --visibility=link.");
  const members = (opts.members || [
    ...many(flags.member).map((m) => ({ pubkey: toHex(m), role: edit === "none" ? "read" : "edit" })),
    ...many(flags["member-read"]).map((m) => ({ pubkey: toHex(m), role: "read" })),
  ]);
  if (visibility === "private" && !members.length) fail("a private artifact opens only for its members. Add --member=<npub> for each person, or use --visibility=link.");
  if (edit === "members" && !members.some((m) => m.role === "edit")) fail("--edit=members needs at least one --member=<npub>");
  if (visibility === "public" && !cfg.allowPublic) fail("public artifacts are turned off in this agent's settings. Use --visibility=link.");
  if (visibility === "public" && !flags.public && opts.html == null) {
    fail("a public artifact can be read by anyone and found by anyone who looks. Pass --public as well to confirm that is what was asked for.");
  }

  // In a workspace the key that signs is the workspace's, and the page gets a
  // read key of its own; otherwise a fresh key, which is also its read key.
  const wsName = workspaceName(cfg, opts.workspace);
  const ws = wsName ? needWorkspace(wsName) : null;
  const sk = ws ? unb64u(ws.secret) : opts.sk || newSecret();
  uploaderKey(cfg, sk);       // a broken uploader key fails here, before anything is written
  const keys = ws ? await keysFrom({ edit: sk, read: newSecret() }) : await keysFrom({ edit: sk });
  const expires = opts.expires !== undefined ? opts.expires : parseExpiry(val("expires") ?? cfg.defaults.expires);
  const allow = opts.allow ?? many(flags["allow-origin"]);
  // The workspace's owner, if it names one, can open each of its pages with
  // their own key as well as by link.
  if (ws?.owner && visibility !== "public" && !members.some((m) => m.pubkey === ws.owner)) members.push({ pubkey: ws.owner, role: edit === "none" ? "read" : "edit" });
  const ledgerNow = readLedger();
  let id = bytesToHex(sha256(enc.encode(keys.pubkey))).slice(0, 8);
  if (ws) do id = bytesToHex(randomBytes(4)); while (ledgerNow.artifacts[id]);
  const path = ws ? opts.path || `/${id}/index.html` : "/index.html";
  const a = {
    id, ...(ws ? { workspace: ws.name, path } : {}),
    pubkey: keys.pubkey, npub: nip19.npubEncode(keys.pubkey), secret: b64u(ws ? keys.K : sk),
    title: opts.title || val("title") || "", visibility, edit, sealed: visibility !== "public",
    members, created: now(), expires, relays: (ws ? ws.relays : cfg.relays).map(norm), servers: (ws ? ws.servers : cfg.servers).map(norm),
    shellTitle: opts.shellTitle ?? (val("shell-title") || undefined),
    comments: opts.comments ?? (!flags["no-comments"] && edit !== "none"),
    ...(allow.length ? { allow } : {}),
    ...(opts.allowBlocked ?? flags["allow-blocked"] ? { allowBlocked: true } : {}),
    state: "pending", blobs: [], retired: [],
  };
  a.url = ws ? ws.url + (path === "/index.html" ? "" : path.replace(/index\.html$/, "").slice(1)) : siteUrl(cfg, a.pubkey);
  const html = stampPage(opts.html ?? readFileSync(file, "utf8"), a);
  // The title stays in the ledger and in what the agent is told. For a sealed
  // page it is never published.
  if (!a.title) a.title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || "").trim();
  const warnings = checkPage(html, a);
  if (a.sealed) {
    if (allow.length) warnings.push(`the page may load from ${allow.join(", ")}, which learns when and from where it is opened`);
    a.policy = shellPolicy({ relays: a.relays, servers: a.servers, allow,
      connect: ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom"] });   // where a phone signer answers
  }
  const hint = editHint(html, a);
  if (hint) warnings.push(hint);
  if (ws && (edit === "link" || members.some((m) => m.role === "edit" && m.pubkey !== ws.owner))) {
    warnings.push(`this page is in the workspace "${ws.name}": whoever can edit it holds the workspace's key, so they could also change or take down ` +
      `its other pages (not read them). Give the edit link only to the person the workspace belongs to; for anybody else, make the page without --workspace.`);
  }

  // The key is in the ledger before anything is published, so a run that is
  // killed half way leaves a page this tool can still find and take down.
  withLedger((l) => {
    if (l.artifacts[a.id]) fail(`an artifact ${a.id} is already in the ledger`);
    l.artifacts[a.id] = a;
  });
  log({ cmd: "create", id: a.id, state: "pending", visibility, edit });
  let res;
  try {
    res = await withPool((pool) => publishPage(pool, a, keys, html, cfg, { onUploaded: (h) => patch(a.id, (e) => addBlobs(e, [h])) }));
  } catch (err) {
    await abandon(a, keys, cfg, !!err.published).catch(() => {});
    throw err;
  }
  const e = patch(a.id, (e) => { applyPublish(e, res); e.seenHash = res.hash; });
  remember(e, digest(html), html);
  const { out: how, warnings: more } = landed(res, a, cfg);
  log({ cmd: "create", id: a.id, state: "live", hash: res.hash, ...how });
  warnings.push(...more);
  return { id: a.id, title: a.title, ...(ws ? { workspace: ws.name } : {}), visibility, edit, ...linksOf(a, keys),
    expires: expires ? iso(expires) : null,
    members: members.map((m) => ({ npub: nip19.npubEncode(m.pubkey), role: m.role })),
    ...how, ...(warnings.length ? { warnings } : {}) };
}

// A create that failed: nothing was handed out, so nothing needs to stay. What
// was uploaded is deleted; a manifest that went out is tombstoned. The entry
// goes from the ledger only once nothing is left that its key could reach.
async function abandon(a, keys, cfg, published) {
  const e = readLedger().artifacts[a.id];
  if (!e) return;
  if (published) {
    const out = await withPool((pool) => remove(e, keys, cfg, pool));
    patch(a.id, (x) => { x.deleted = now(); x.deletedBy = "create failed"; x.pendingRelays = out.lingering; x.state = "failed"; if (!out.left.length && !out.lingering.length) delete x.secret; });
    return;
  }
  const left = [];
  for (const h of e.blobs || []) {
    const rows = await dropBlob(a.servers, h, signersOf(cfg, keys.sk));
    if (rows.some((r) => r.state === "refused")) left.push(h);
  }
  withLedger((l) => {
    if (!left.length) delete l.artifacts[a.id];
    else Object.assign(l.artifacts[a.id], { deleted: now(), deletedBy: "create failed", state: "failed", blobs: left });
  });
  log({ cmd: "create", id: a.id, state: "abandoned", left: left.length });
}

function listPage() {
  const title = val("title") || fail("usage: list-page --title=\"Shopping\" [--note=…] [--item=…]… [--out=list.html]");
  const items = [].concat(flags.item ?? []).filter((x) => x !== true).map(String);
  if (flags.items) {
    const from = val("items");
    const raw = readFileSync(from === "-" ? 0 : from, "utf8");
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
  const note = one(flags.note) === true ? "" : one(flags.note) || "";
  const html = tpl.replaceAll("{{title}}", () => esc(title)).replace("{{note}}", () => esc(note))
    .replace("{{items}}", () => items.map(row).join("") + (items.length ? "\n  " : ""))
    .replace(/<html lang="en"/, () => `<html lang="${esc(val("lang") || "en")}"`);
  const out = resolve(val("out") || "list.html");
  writeFileSync(out, html, { mode: 0o600 });
  return { file: out, items: items.length, next: `create ${out} --edit=link --title="${title.replace(/"/g, "'")}"` };
}

// The page as it is, against the page as this tool last read it. `mark()`
// makes this the version "seen": the next read reports only what came after.
async function look(id) {
  const a = entryOf(readLedger(), id);
  const keys = await keysOf(a);
  const page = await withPool((pool) => fetchPage(pool, a, keys));
  const text = digest(page.html);
  let before = "";
  try { before = readFileSync(seenFile(a), "utf8"); } catch { /* first read */ }
  const beforeHtml = seenHtml(a);
  const changed = page.hash !== a.seenHash;
  const mark = () => {
    if (flags.peek || page.fallback) return;
    const e = patch(a.id, (e) => {
      e.seenHash = page.hash; e.hash = page.hash; e.savedAt = page.manifest.created_at;
      addBlobs(e, [page.hash]);
    });
    remember(e, text, page.html);
  };
  return { a, keys, page, text, before, beforeHtml, changed, mark, savedAt: iso(page.manifest.created_at) };
}

// What a person said on the page since a mark: new comments, and ones that got
// a reply or changed state. `was` is a list of { id, state, replies }.
function commentSummary(list, was) {
  const old = new Map((was || []).map((c) => [c.id, c]));
  const fresh = [];
  for (const c of list) {
    const o = old.get(c.id);
    const isNew = !o;
    const answered = !!o && c.replies.length > o.replies;
    const moved = !!o && c.state !== o.state;
    if (isNew || answered || moved) fresh.push({ ...c, news: isNew ? "new" : answered ? "reply" : "state" });
  }
  return fresh;
}
const markOfHtml = (html) => (html ? markOf(commentsOf(html)) : []);

async function read(id) {
  const r = await look(id);
  const { a, page, text } = r;
  const all = commentsOf(page.html);
  const out = {
    id: a.id, title: a.title, changed: r.changed, savedAt: r.savedAt,
    ...(r.changed ? { changes: changes(r.before, text) } : {}),
    // Said once, and where to look: the list itself comes from `comments`.
    ...(all.length ? { comments: { open: all.filter((c) => c.state === "open").length, resolved: all.filter((c) => c.state === "resolved").length,
      newSinceLastRead: commentSummary(all, markOfHtml(r.beforeHtml)).map((c) => c.id) } } : {}),
    ...(page.warnings.length ? { warnings: page.warnings } : {}),
  };
  // `changes` knows words and ticks. When the page itself was edited, which is
  // what an ordinary editing tool does, the diff of the markup says exactly what.
  if (flags.diff && r.changed) {
    out.diff = r.beforeHtml == null ? { note: "no earlier copy of this page was kept, so there is nothing to compare with" }
      : unifiedDiff(r.beforeHtml, page.html);
  }
  const want = val("as") || "text";
  // The file to edit carries the version it was made from, so an update from
  // it is refused if the page moved on in the meantime.
  if (want === "html") out.html = withBase(page.html, page.hash);
  else out.text = text;
  if (flags.out) {
    const file = resolve(val("out"));
    writeFileSync(file, withBase(page.html, page.hash), { mode: 0o600 });
    chmodSync(file, 0o600);
    out.file = file; delete out.html;
  }
  r.mark();
  return out;
}

// What changed in the page since this tool last read it: a unified diff of the
// markup, the changes to the words, and the comments added or answered. It
// does not move the mark: only `read` does, so a diff never hides a change
// from the read that follows it.
async function diff(id) {
  const r = await look(id);
  const all = commentsOf(r.page.html);
  const out = { id: r.a.id, title: r.a.title, changed: r.changed, savedAt: r.savedAt };
  if (r.changed) {
    out.changes = changes(r.before, r.text);
    out.markup = r.beforeHtml == null ? { note: "no earlier copy of this page was kept" } : unifiedDiff(r.beforeHtml, r.page.html);
    const fresh = commentSummary(all, markOfHtml(r.beforeHtml));
    if (fresh.length) out.comments = fresh;
  }
  if (r.page.warnings.length) out.warnings = r.page.warnings;
  return out;
}

// The comments on a page, with where each one is, newest news first. Open ones
// unless --all. This is the way to read a page somebody has been commenting on:
// it does not print the page, and it does not count as reading the page.
async function comments(id) {
  const r = await look(id);
  const all = commentsOf(r.page.html);
  const was = commentsMark(r.a) ?? markOfHtml(r.beforeHtml);
  const fresh = new Map(commentSummary(all, was).map((c) => [c.id, c.news]));
  const shown = (flags.all ? all : all.filter((c) => c.state === "open")).map((c) => ({ ...c, ...(fresh.has(c.id) ? { news: fresh.get(c.id) } : {}) }));
  shown.sort((x, y) => (fresh.has(y.id) - fresh.has(x.id)) || String(x.at).localeCompare(String(y.at)));
  const out = {
    id: r.a.id, title: r.a.title, pageChanged: r.changed, savedAt: r.savedAt,
    open: all.filter((c) => c.state === "open").length, resolved: all.filter((c) => c.state === "resolved").length,
    ...(r.changed ? { changes: changes(r.before, r.text).length + " changed lines since you last read it; run read or diff to see them" } : {}),
    comments: shown,
  };
  if (!all.length) out.note = "no comments on this page" + (r.a.comments === false || r.a.edit === "none" ? " (comments are off for it: it cannot be edited by link or members)" : "");
  if (!flags.peek && !r.page.fallback) saveCommentsMark(r.a, markOf(all));
  return out;
}

// Change one comment inside the page's markup, and publish it. The page is
// edited as text so nothing else in it moves: a reply is a paragraph added to
// the comment, resolving flips its state and takes the highlight off the words.
// It works on the page as it is now, so it cannot overwrite a change it has not
// seen; it says when there was one.
const COMMENT_ID = /^[A-Za-z0-9]{3,16}$/;
async function commentAct(id, cid, kind) {
  if (!id || !cid) fail(`usage: ${kind} <id> <comment-id>${kind === "reply" ? ' --text="…"' : ""} (see: comments <id>)`);
  if (!COMMENT_ID.test(cid)) fail(`"${cid}" is not a comment id`);
  const text = kind === "reply" ? val("text") : null;
  if (kind === "reply" && !text) fail('reply needs --text="what you did or answer"');
  const by = String(val("by") || "Agent");
  const cfg = settings();
  const a = entryOf(readLedger(), id);
  const keys = await keysOf(a);
  return withPool(async (pool) => {
    const live = await fetchPage(pool, a, keys, { forWrite: true });
    const unseen = live.hash !== a.seenHash;
    const re = new RegExp(`<article\\b[^>]*\\bnc:comment="${cid}"[^>]*>[\\s\\S]*?</article>`);
    const art = re.exec(live.html)?.[0];
    if (!art) fail(`no comment "${cid}" on ${a.id}. Run "comments ${a.id} --all" for the ids.`);
    let next = art;
    if (kind === "reply") {
      const p = `<p nc:reply nc:by="${esc(by)}" nc:at="${new Date().toISOString()}">${esc(text)}</p>`;
      // A function, so "$&" or "$'" in the text is text and not a pattern.
      next = next.replace(/<\/article>$/, () => p + "</article>");
    }
    if (kind === "resolve" || (kind === "reply" && flags.resolve)) next = next.replace(/\bnc:state="[^"]*"/, 'nc:state="resolved"');
    if (kind === "reopen") next = next.replace(/\bnc:state="[^"]*"/, 'nc:state="open"');
    let html = live.html.replace(art, () => next);
    if (/nc:state="resolved"/.test(next)) {
      // The highlight goes: words wrapped for this comment are unwrapped, and its
      // id comes off anything else it was attached to.
      html = html.replace(new RegExp(`<mark\\b[^>]*\\bnc:c="${cid}"[^>]*>([\\s\\S]*?)</mark>`, "g"), (_, inner) => inner)
        .replace(/\bnc:c="([^"]*)"/g, (m, ids) => {
          const rest = ids.split(/\s+/).filter((t) => t && t !== cid);
          return rest.length === ids.split(/\s+/).filter(Boolean).length ? m : rest.length ? `nc:c="${rest.join(" ")}"` : "";
        });
    }
    adoptMembers(a, live.shell);
    html = stampPage(html, a);
    const warnings = [...live.warnings, ...checkPage(html, a, live.html)];
    const res = await publishPage(pool, a, keys, html, cfg, { live: live.manifest, table: live.table,
      onUploaded: (h) => patch(a.id, (e) => addBlobs(e, [h])) }).catch((err) => { if (err.retired) patch(a.id, (e) => { e.retired = err.retired; }); throw err; });
    const e = patch(a.id, (e) => {
      applyPublish(e, res); e.members = a.members;
      // The person's change stays unread: this reply is not a reading of it.
      if (!unseen) e.seenHash = res.hash;
    });
    if (!unseen) remember(e, digest(html), html);
    const now2 = commentsOf(html).find((c) => c.id === cid);
    // The agent's own answer is not news to it.
    const mark = commentsMark(a);
    if (mark) saveCommentsMark(a, [...mark.filter((c) => c.id !== cid), { id: cid, state: now2?.state, replies: now2?.replies.length || 0 }]);
    const { out: how, warnings: more } = landed(res, a, cfg);
    log({ cmd: kind, id: a.id, comment: cid, hash: res.hash, ...how });
    warnings.push(...more);
    if (unseen) warnings.push(`the page was changed since you last read it, and that change is kept. Run "read ${a.id}" to see it.`);
    return { id: a.id, comment: cid, state: now2?.state, replies: now2?.replies.length, savedAt: iso(res.manifest.created_at),
      ...(unseen ? { pageChanged: true } : {}), ...how, ...(warnings.length ? { warnings } : {}) };
  });
}

/**
 * Everything that can be checked about one artifact, without changing
 * anything. `deep` reads every blob back from every server; otherwise one
 * strict HEAD per server for the page and none for the runtime.
 */
async function inspect(pool, cfg, a, { deep = true } = {}) {
  const path = pathOf(a);
  if (a.deleted) {
    const per = await askEach(pool, a.relays, { kinds: [15128], authors: [a.pubkey] });
    const lingering = a.relays.filter((r) => { const top = newestOf(per.get(r) || []); return top && tableOf(top)[path]; });
    const gw = cfg.gatewayCheck ? await gatewayState(cfg, a, null, a.blobs || []) : { serves: "unchecked" };
    return {
      id: a.id, title: a.title, deleted: iso(a.deleted), deletedBy: a.deletedBy || "cli",
      ...(a.replacedBy ? { replacedBy: a.replacedBy } : {}),
      // A gateway that still answers anything but 404 is answering from a
      // manifest it read before the page was deleted.
      gateway: { ...(gw.status ? { status: gw.status } : {}), stale: !["none", "unreachable", "unchecked"].includes(gw.serves),
        ...(gw.serves === "unreachable" ? { unreachable: true } : {}) },
      ...(lingering.length ? { lingering } : {}), keyKept: !!a.secret,
      ok: !lingering.length, health: lingering.length ? "degraded" : "ok",
      problems: lingering.length ? [`${lingering.length} relays still name the page: ${lingering.join(", ")}. "sweep" retries${a.secret ? "" : ", but the key is gone"}.`] : [],
    };
  }
  const per = await askEach(pool, a.relays, { kinds: [15128], authors: [a.pubkey] });
  const newest = newestOf(flat(per).filter((e) => e.kind === 15128));
  const problems = [], notes = [];
  let broken = false;
  const relays = standing(a.relays, per, newest, a.workspace ? path : null);
  const base = { id: a.id, title: a.title, ...(a.workspace ? { workspace: a.workspace } : {}), ...(a.state === "pending" ? { state: "pending" } : {}) };
  if (!newest || !tableOf(newest)[path]) {
    const reached = relays.some((r) => r.has !== "unreachable");
    if (reached && a.expires && a.expires <= now()) {
      return { ...base, ok: false, health: "expired", relays, problems: [`it expired on ${iso(a.expires)} and was never taken down: run sweep, which also deletes what is left of it on the servers`] };
    }
    if (reached && newest && a.workspace) {
      const kept = a.hash ? (await holders(union(a.servers, serversOf(newest)), a.hash)).some((r) => r.state === "ok") : false;
      return { ...base, ok: false, health: "broken", lost: true, relays, problems: [kept
        ? `the workspace's manifest no longer names this page, although its file is still there: another writer dropped it. "doctor ${a.id} --fix" puts it back.`
        : `the workspace's manifest no longer names this page and its file is gone: it was probably deleted from the page itself. "status ${a.id}" records that.`] };
    }
    return { ...base, ok: false, health: "broken", relays, problems: [reached ? "no relay has a manifest for this page" : "no relay could be reached"] };
  }
  const table = tableOf(newest);
  const servers = union(a.servers, serversOf(newest));
  const need = Math.min(cfg.minServers, a.servers.length);
  const blobs = [];
  // A page of a workspace answers for itself and the runtime it loads, not for its neighbours.
  for (const [p, hash] of Object.entries(table).filter(([x]) => !a.workspace || x === path || isRuntimePath(x))) {
    const isPage = p === path;
    let rows;
    if (isPage && !deep) rows = await Promise.all(servers.map(async (s) => ({ server: s, state: (await held(s, hash, null)) === true ? "ok" : "missing" })));
    else if (!isPage && !deep) continue;
    else rows = await holders(servers, hash, { cache: !isPage });
    const ok = rows.filter((r) => r.state === "ok").length;
    blobs.push({ path: p, hash, ok, of: servers.length, ...(ok < servers.length ? { lacking: rows.filter((r) => r.state !== "ok").map((r) => `${r.server} (${r.state})`) } : {}) });
    if (!ok) { broken = true; problems.push(`${p} is on no server`); }
    else if (isPage && ok < need) problems.push(`the page is on ${ok} of ${servers.length} servers (${need} wanted)`);
  }
  const current = relays.filter((r) => r.has === "current").length;
  const gwRelay = norm(cfg.gatewayRelay || a.relays[0]);
  const lag = relays.filter((r) => r.has !== "current");
  if (lag.length) {
    const gwLags = lag.some((r) => r.url === gwRelay);
    (gwLags || current < Math.floor(a.relays.length / 2) + 1 ? problems : notes)
      .push(`${lag.length} of ${a.relays.length} relays lack the newest version: ${lag.map((r) => `${r.url} (${r.has})`).join(", ")}`);
  }
  // A relay with an older manifest is harmless while the blob it names exists.
  for (const r of relays.filter((x) => x.has === "older" && x.hash)) {
    const left = (await Promise.all(servers.map((s) => held(s, r.hash, null)))).some((h) => h === true);
    if (!left) problems.push(`${r.url} still names a version that is on no server: anyone it answers gets an error`);
  }
  const known = [...(a.blobs || []), ...retiredOf(newest).map((r) => r.hash), ...(a.retired || []).map((r) => r.hash)];
  const gateway = await gatewayState(cfg, a, table[path], known);
  if (gateway.serves === "error") {
    broken = true;
    const fine = !problems.length && relays.every((r) => r.has === "current" || r.has === "unreachable");
    problems.push(fine
      ? `the gateway answers ${gateway.status} although every relay and server has the page: it is serving an older version from its cache, whose file is gone. Nothing here can speed that up; it clears by itself, usually within a day`
      : `the gateway answers ${gateway.status} for the page`);
  }
  else if (gateway.serves === "older") notes.push("the gateway still serves an older version from its cache; that version is kept until it moves on");
  else if (gateway.serves === "other") problems.push("the gateway serves a page this tool does not know");
  else if (gateway.serves === "none") problems.push("the gateway does not find the page (404)");
  else if (gateway.serves === "unreachable") notes.push("the gateway could not be reached");
  const retired = mergeRetired([a.retired || [], a.workspace ? retiredFor(retiredOf(newest), path) : retiredOf(newest)], Object.values(table));
  return {
    ...base, ok: !problems.length, health: broken ? "broken" : problems.length ? "degraded" : "ok",
    savedAt: iso(newest.created_at), hash: table[path],
    relays: relays.map((r) => ({ url: r.url, has: r.has })), ...(blobs.length ? { blobs } : {}),
    gateway: { serves: gateway.serves, ...(gateway.status ? { status: gateway.status } : {}) },
    ...(retired.length ? { retired: retired.length } : {}),
    problems, ...(notes.length ? { notes } : {}),
  };
}

async function status(id) {
  const cfg = settings();
  const ledger = readLedger();
  const targets = id ? [entryOf(ledger, id, { deleted: true })] : Object.values(ledger.artifacts).filter((a) => !a.deleted);
  return withPool(async (pool) => {
    const rows = await Promise.all(targets.map(async (a) => {
      const m = newestOf(flat(await ask(pool, a.relays, { kinds: [15128], authors: [a.pubkey] })));
      const hash = m ? tableOf(m)[pathOf(a)] || null : null;
      // A workspace page that is gone from the manifest while its file is
      // still on a server was dropped by another writer, not deleted: that is
      // a fault for doctor, and the page is not written off.
      const lost = !hash && a.workspace && m && !a.deleted && a.state !== "pending" && a.hash &&
        (await holders(union(a.servers, serversOf(m)), a.hash)).some((r) => r.state === "ok");
      // Deleting from the page's own panel leaves an empty manifest, and a
      // deletion request signed by the page's key, which a relay that honours
      // it applies to the empty manifest too. Either one says so. In a
      // workspace it leaves a manifest without the page's path.
      if (!hash && !lost && !a.deleted && a.state !== "pending") {
        const req = m || a.workspace ? null : newestOf(flat(await ask(pool, a.relays, { kinds: [5], authors: [a.pubkey] })));
        if (m || req) {
          const at = (m || req).created_at;
          patch(a.id, (e, l) => {
            if (!e.deleted) { e.deleted = at; e.deletedBy = "page"; }
            // So a browser tab that puts the path back from an older table is undone.
            const w = e.workspace && l.workspaces[e.workspace];
            if (w) { w.removed = w.removed || {}; w.removed[pathOf(e)] = [...new Set([...(w.removed[pathOf(e)] || []), ...(e.blobs || [])])]; }
          });
          a.deleted = at; a.deletedBy = "page";
          log({ cmd: "status", id: a.id, deletedBy: "page" });
        }
      }
      const h = a.deleted ? null : await inspect(pool, cfg, a, { deep: false });
      return { id: a.id, title: a.title, published: !!hash, changed: !!hash && hash !== a.seenHash,
        ...(a.state === "pending" ? { state: "pending" } : {}),
        ...(a.deleted ? { deleted: iso(a.deleted), deletedBy: a.deletedBy || "cli", ...(a.replacedBy ? { replacedBy: a.replacedBy } : {}) } : {}),
        ...(h ? { health: h.health, ...(h.problems.length ? { problems: h.problems } : {}) } : {}),
        // A workspace's manifest changes with every page in it; while this
        // page is the version last seen, its own time is the one in the ledger.
        savedAt: a.workspace && hash && hash === a.hash && a.savedAt ? iso(a.savedAt) : m ? iso(m.created_at) : null,
        ...(a.workspace ? { workspace: a.workspace } : {}),
        expires: a.expires ? iso(a.expires) : null };
    }));
    return id ? rows[0] : { artifacts: rows, changed: rows.filter((r) => r.changed).map((r) => r.id),
      deleted: rows.filter((r) => r.deleted && !r.published).map((r) => r.id),
      unhealthy: rows.filter((r) => r.health && r.health !== "ok").map((r) => r.id) };
  });
}

// Read-only. Exit 1 when anything is wrong, so a scheduled job can say so.
async function verify(id) {
  const cfg = settings();
  const ledger = readLedger();
  const targets = id ? [entryOf(ledger, id, { deleted: true })] : Object.values(ledger.artifacts).filter((a) => !a.deleted && a.state !== "failed");
  const rows = await withPool((pool) => Promise.all(targets.map((a) => inspect(pool, cfg, a, { deep: true }))));
  // Over everything: each workspace as a whole as well, which finds a page
  // another writer dropped from the shared manifest.
  const spaces = id ? [] : await withPool((pool) => Promise.all(Object.values(ledger.workspaces).map(async (ws) => {
    const r = await checkWorkspace(pool, cfg, ws, { deep: false });
    return { workspace: ws.name, ok: r.ok, health: r.health, problems: r.problems };
  })));
  if (rows.some((r) => !r.ok) || spaces.some((w) => !w.ok)) exitCode = 1;
  return id ? rows[0] : { ok: rows.every((r) => r.ok) && spaces.every((w) => w.ok), artifacts: rows, ...(spaces.length ? { workspaces: spaces } : {}) };
}

// verify, then with --fix: blobs copied to servers that lack them, the
// manifest sent again to relays that lack it, and if the page is on no server
// at all, the last version this tool read published again.
async function doctor(id) {
  const cfg = settings();
  const a = entryOf(readLedger(), id, { deleted: true });
  return withPool(async (pool) => {
    const before = await inspect(pool, cfg, a, { deep: true });
    if (!flags.fix) {
      if (!before.ok) exitCode = 1;
      return { ...before, ...(before.ok ? {} : { next: `doctor ${a.id} --fix` }) };
    }
    const keys = await keysOf(a);
    const actions = [];
    if (a.deleted) {
      const out = await remove(a, keys, cfg, pool);
      patch(a.id, (e) => { e.pendingRelays = out.lingering; if (!out.left.length && !out.lingering.length && !flags["keep-key"]) delete e.secret; });
      actions.push(`sent the deletion again; ${out.lingering.length} relays still name it`);
      const after = await inspect(pool, cfg, readLedger().artifacts[a.id], { deep: true });
      if (!after.ok) exitCode = 1;
      return { id: a.id, actions, after };
    }
    const uploader = uploaderKey(cfg, keys.sk);
    const per = await askEach(pool, a.relays, { kinds: [15128], authors: [a.pubkey] });
    const newest = newestOf(flat(per).filter((e) => e.kind === 15128));
    const own = pathOf(a);
    // A workspace page that another writer dropped from the manifest: put its
    // path back, at the version this ledger knows, if a server still has it,
    // or else publish again the copy kept here.
    if (a.workspace && newest && !tableOf(newest)[own]) {
      const servers = union(a.servers, serversOf(newest));
      const kept = a.hash && (await holders(servers, a.hash)).some((r) => r.state === "ok");
      if (kept) {
        const res = await commitPaths(pool, workspaceOf(a), cfg, { set: { [own]: a.hash }, expect: { [own]: null }, sealed: a.sealed });
        actions.push(`put the page back into the workspace's manifest (${res.relays.current} of ${res.relays.of} relays)`);
      } else {
        const seen = seenHtml(a);
        if (!seen) fail(`${a.id} is gone from the workspace's manifest and its file from every server, and no copy of it was kept here. It cannot be repaired; offer to make it again.`);
        const html = stampPage(seen, a);
        checkPage(html, a, seen);
        const res = await publishPage(pool, a, keys, html, cfg, { onUploaded: (h) => patch(a.id, (e) => addBlobs(e, [h])) });
        patch(a.id, (e) => { applyPublish(e, res); e.seenHash = res.hash; });
        remember(a, digest(html), html);
        actions.push("published again the last version read here, into the workspace");
      }
      log({ cmd: "doctor", id: a.id, actions });
      const after = await inspect(pool, cfg, readLedger().artifacts[a.id], { deep: true });
      if (!after.ok) exitCode = 1;
      return { id: a.id, before: before.problems, actions, after };
    }
    if (!newest || !tableOf(newest)[own]) fail(`no relay has a manifest for ${a.id}, so there is nothing to repair from. If it should exist, create it again.`);
    const table = tableOf(newest);
    const servers = union(a.servers, serversOf(newest));
    let pageGone = false;
    for (const [path, hash] of Object.entries(table).filter(([x]) => !a.workspace || x === own || isRuntimePath(x))) {
      const rows = await holders(servers, hash);
      const lacking = rows.filter((r) => r.state !== "ok").map((r) => r.server).filter((s) => a.servers.includes(s));
      if (!lacking.length) continue;
      const bytes = await findBytes(cfg, a, hash, servers);
      if (!bytes) { if (path === own) pageGone = true; else actions.push(`${path}: no copy found anywhere`); continue; }
      const put = await placeBlob(lacking, bytes, RUNTIME_FILES[path] || "text/html", uploader, path === own ? a.expires : null, { always: true });
      actions.push(`${path}: copied to ${put.filter((r) => r.state === "ok").length} of ${lacking.length} servers that lacked it`);
    }
    const lag = standing(a.relays, per, newest).filter((r) => r.has === "older" || r.has === "none");
    if (lag.length) {
      const took = await publish(pool, lag.map((r) => r.url), newest);
      actions.push(`sent the current manifest again to ${took.length} of ${lag.length} relays that lacked it`);
    }
    if (pageGone) {
      const seen = seenHtml(a);
      if (!seen) fail(`the page of ${a.id} is on no server and no copy of it was kept here. It cannot be repaired; offer to make it again.`);
      if (a.seenHash !== table[own] && !flags["from-seen"]) {
        fail(`the newest version of ${a.id} (saved ${iso(newest.created_at)}) is on no server, and the last copy kept here is an older one. ` +
          `"doctor ${a.id} --fix --from-seen" publishes that older copy; tell the user that a later change was lost.`);
      }
      const html = stampPage(seen, a);
      checkPage(html, a, seen);
      const res = await publishPage(pool, a, keys, html, cfg, { live: newest, table, onUploaded: (h) => patch(a.id, (e) => addBlobs(e, [h])) });
      patch(a.id, (e) => { applyPublish(e, res); e.seenHash = res.hash; });
      remember(a, digest(html), html);
      actions.push(`published again the last version read here (${a.seenHash === table[own] ? "the current one" : "an older one"})`);
    }
    log({ cmd: "doctor", id: a.id, actions });
    const after = await inspect(pool, cfg, readLedger().artifacts[a.id], { deep: true });
    if (!after.ok) exitCode = 1;
    return { id: a.id, before: before.problems, actions, after };
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
  const a = entryOf(readLedger(), id);
  const keys = await keysOf(a);
  const raw = readFileSync(file, "utf8");
  const base = baseOf(raw);
  return withPool(async (pool) => {
    const live = await fetchPage(pool, a, keys, { forWrite: true });
    // Somebody saved the page after the version this file was made from, or,
    // for a file that does not say, after this agent last read it. Publishing
    // now would throw their change away, so read first and build on that.
    if (live.hash !== (base || a.seenHash) && !flags.force) {
      fail(base
        ? `${a.id} was changed after you last read it into this file (saved ${iso(live.manifest.created_at)}). Run "read ${a.id} --as=html --out=<file>" again, redo your change on the new file, then update. --force overwrites the change.`
        : `${a.id} was changed after you last read it (saved ${iso(live.manifest.created_at)}). ` +
          `Run "read ${a.id}" to see the change, make yours on top of it, then update. --force overwrites it.`);
    }
    const expiresBefore = a.expires;
    if (flags.expires) a.expires = parseExpiry(val("expires"));
    adoptMembers(a, live.shell);
    const html = stampPage(raw, a);
    const warnings = [...live.warnings, ...checkPage(html, a, live.html)];
    const res = await publishPage(pool, a, keys, html, cfg, { live: live.manifest, table: live.table,
      onUploaded: (h) => patch(a.id, (e) => addBlobs(e, [h])) }).catch((err) => { if (err.retired) patch(a.id, (e) => { e.retired = err.retired; }); throw err; });
    // A workspace's relay list is the workspace's, and never expires.
    if (a.expires !== expiresBefore && !a.workspace) await publishRelayList(pool, a, keys.sk, res.manifest.created_at);
    const e = patch(a.id, (e) => { applyPublish(e, res); e.seenHash = res.hash; e.members = a.members; e.expires = a.expires; });
    remember(e, digest(html), html);
    const hint = editHint(html, a);
    if (hint) warnings.push(hint);
    const { out: how, warnings: more } = landed(res, a, cfg);
    log({ cmd: "update", id: a.id, hash: res.hash, ...how });
    warnings.push(...more);
    // No links here: the link did not change, and every printed link is a key
    // in somebody's transcript. `links <id>` has them.
    return { id: a.id, url: a.url, savedAt: iso(res.manifest.created_at),
      ...(a.expires !== expiresBefore ? { expires: iso(a.expires) } : {}), ...how, ...(warnings.length ? { warnings } : {}) };
  });
}

async function share(id) {
  const cfg = settings();
  const a = entryOf(readLedger(), id);
  if (!a.sealed) fail("a public artifact has nothing to share by key: send its link");
  const warnings = [];
  // A page nobody may edit gives nobody the key that edits it.
  const asEdit = a.edit === "none" ? "read" : "edit";
  if (asEdit === "read" && many(flags.member).length) warnings.push("this page was made so that nobody can edit it, so the people added can read it only");
  const add = [
    ...many(flags.member).map((m) => ({ pubkey: toHex(m), role: asEdit })),
    ...many(flags["member-read"]).map((m) => ({ pubkey: toHex(m), role: "read" })),
  ];
  if (!add.length) fail("usage: share <id> --member=<npub> | --member-read=<npub>");
  const keys = await keysOf(a);
  return withPool(async (pool) => {
    const live = await fetchPage(pool, a, keys, { forWrite: true });
    adoptMembers(a, live.shell);
    a.members = [...(a.members || []).filter((m) => !add.some((n) => n.pubkey === m.pubkey)), ...add];
    const res = await publishPage(pool, a, keys, live.html, cfg, { live: live.manifest, table: live.table,
      onUploaded: (h) => patch(a.id, (e) => addBlobs(e, [h])) });
    patch(a.id, (e) => { const seen = e.seenHash === live.hash; applyPublish(e, res); e.members = a.members; if (seen) e.seenHash = res.hash; });
    const { out: how, warnings: more } = landed(res, a, cfg);
    log({ cmd: "share", id: a.id, hash: res.hash, members: a.members.length, ...how });
    warnings.push(...more);
    return { id: a.id, members: a.members.map((m) => ({ npub: nip19.npubEncode(m.pubkey), role: m.role })), ...how, ...(warnings.length ? { warnings } : {}) };
  });
}

// Take a page down: an empty manifest first, so a relay that ignores deletion
// requests still stops naming the page, an empty relay list, a deletion
// request for everything, then every version's bytes. Then every relay is read
// back, and the ones still naming the page are returned as `lingering`.
async function remove(a, keys, cfg, pool) {
  if (a.workspace) return removeFromWorkspace(a, keys, cfg, pool);
  const per = await askEach(pool, a.relays, { kinds: [15128, 5128, 10002], authors: [a.pubkey] });
  const events = flat(per);
  const pages = new Set([...(a.blobs || []), ...(a.retired || []).map((r) => r.hash)]);
  for (const ev of events) {
    if (ev.kind !== 10002 && tableOf(ev)["/index.html"]) pages.add(tableOf(ev)["/index.html"]);
    for (const r of retiredOf(ev)) pages.add(r.hash);
  }
  const newestAt = Math.max(now(), ...events.map((e) => e.created_at + 1));
  // It expires by itself a day later.
  const tomb = finalizeEvent({ kind: 15128, created_at: newestAt, content: "",
    tags: [["x", hashOf(enc.encode("")), "aggregate"], ["expiration", String(now() + 86400)]] }, keys.sk);
  const took = await publish(pool, a.relays, tomb);
  // The same for the key's relay list, everywhere it was sent. relay.nsite.lol
  // takes manifests and lists and refuses deletion requests, so there
  // replacing is the only way.
  const everywhere = listRelays(a);
  await publish(pool, everywhere, finalizeEvent({ kind: 10002, created_at: newestAt, content: "",
    tags: [["expiration", String(now() + 86400)]] }, keys.sk));
  // Then the request to delete everything, the tombstone included.
  const del = finalizeEvent({ kind: 5, created_at: newestAt + 1, content: "artifact removed",
    tags: [["a", `15128:${a.pubkey}:`], ["a", `10002:${a.pubkey}:`], ...events.map((e) => ["e", e.id]), ["e", tomb.id],
      ["k", "15128"], ["k", "5128"], ["k", "10002"]] }, keys.sk);
  await publish(pool, everywhere, del);

  // The page's own bytes, every version. The runtime's blobs are everybody's
  // and stay where they are.
  const servers = union(a.servers, ...events.map(serversOf));
  const blobs = [];
  for (const hash of pages) {
    const rows = await dropBlob(servers, hash, signersOf(cfg, keys.sk));
    blobs.push(...rows.map((r) => ({ hash, ...r })));
  }
  const after = await askEach(pool, a.relays, { kinds: [15128], authors: [a.pubkey] });
  const lingering = a.relays.filter((r) => {
    const evs = after.get(r);
    if (evs == null) return true;
    const top = newestOf(evs);
    return !!(top && tableOf(top)["/index.html"]);
  });
  const left = blobs.filter((b) => b.state === "refused");
  const goneHashes = [...pages].filter((h) => !left.some((b) => b.hash === h));
  return { relays: took, lingering, blobs, left: left.map((b) => ({ hash: b.hash.slice(0, 12), server: b.server })), gone: goneHashes };
}

// One page of a workspace: its path out of the shared manifest (everything
// else kept, see commitPaths), then its own versions deleted from the servers,
// never one that a path of any relay's manifest still names. The workspace,
// its key and its other pages stay. The path and its hashes are remembered,
// so a browser tab that puts the path back from an older table is undone on
// the next write.
async function removeFromWorkspace(a, keys, cfg, pool) {
  const ws = workspaceOf(a);
  const path = pathOf(a);
  const { tops } = await workspaceTops(pool, ws);
  const pages = new Set([...(a.blobs || []), ...(a.retired || []).map((r) => r.hash)]);
  for (const top of tops) {
    if (tableOf(top)[path]) pages.add(tableOf(top)[path]);
    for (const r of retiredFor(retiredOf(top), path)) pages.add(r.hash);
  }
  withLedger((l) => {
    const w = l.workspaces[ws.name];
    if (w) { w.removed = w.removed || {}; w.removed[path] = [...new Set([...(w.removed[path] || []), ...pages])]; }
  });
  ws.removed = { ...(ws.removed || {}), [path]: [...pages] };
  let took = [];
  try {
    const res = await commitPaths(pool, ws, cfg, { drop: [path], forget: [...pages] });
    took = res.relays.rows.filter((r) => r.has === "current").map((r) => r.url);
  } catch { /* the relays read back below say what happened */ }
  const after = await workspaceTops(pool, ws);
  const named = namedHashes(after.tops);
  const lingering = ws.relays.filter((r) => {
    const evs = after.per.get(r);
    if (evs == null) return true;
    const top = newestOf(evs);
    return !!(top && tableOf(top)[path]);
  });
  const servers = union(a.servers, ...after.tops.map(serversOf));
  const blobs = [];
  for (const hash of pages) {
    if (named.has(hash)) { blobs.push({ hash, server: "*", state: "kept: still named" }); continue; }
    const rows = await dropBlob(servers, hash, signersOf(cfg, keys.sk));
    blobs.push(...rows.map((r) => ({ hash, ...r })));
  }
  const left = blobs.filter((b) => b.state === "refused" || b.state === "kept: still named");
  const goneHashes = [...pages].filter((h) => !left.some((b) => b.hash === h));
  return { relays: took, lingering, blobs, left: left.map((b) => ({ hash: b.hash.slice(0, 12), server: b.server })), gone: goneHashes };
}

async function del(id, { replacedBy = val("replaced-by"), by = "cli" } = {}) {
  const cfg = settings();
  const a = entryOf(readLedger(), id, { deleted: true });
  const keys = await keysOf(a);
  if (replacedBy) entryOf(readLedger(), replacedBy);
  const out = await withPool((pool) => remove(a, keys, cfg, pool));
  // The key is kept until nothing is left to delete with it: no relay still
  // naming the page, no server still holding a version of it.
  const done = !out.left.length && !out.lingering.length;
  const e = patch(a.id, (e) => {
    e.deleted = e.deleted || now(); e.deletedBy = e.deletedBy || by; e.state = "deleted";
    if (replacedBy) e.replacedBy = entryOf(readLedger(), replacedBy).id;
    dropBlobs(e, out.gone);
    e.pendingRelays = out.lingering;
    e.removeTries = (e.removeTries || 0) + 1;
    if (done && !flags["keep-key"]) delete e.secret;
  });
  log({ cmd: "delete", id: a.id, by: e.deletedBy, replacedBy: e.replacedBy, relays: out.relays.length, lingering: out.lingering, left: out.left.length });
  return { id: a.id, deleted: true, relays: { took: out.relays.length, of: a.relays.length, ...(out.lingering.length ? { stillNaming: out.lingering } : {}) },
    blobs: { deleted: out.blobs.filter((b) => b.state === "deleted").length, gone: out.blobs.filter((b) => b.state === "gone").length, refused: out.left },
    keyKept: !!e.secret, ...(e.replacedBy ? { replacedBy: e.replacedBy } : {}),
    note: (a.sealed ? "" : "this page was public. Copies somebody already fetched are theirs to keep. ") +
      "The gateway may go on answering from its cache for up to a day, with an error page instead of the page." +
      (done ? "" : ` Not everything confirmed the deletion yet; "sweep" tries again and the key is kept until it does.`) };
}

// Retired versions whose time has come, for one live artifact.
// In a workspace: this page's own retired versions only, and never one that a
// path of any relay's manifest still names.
async function purgeRetired(pool, cfg, a, keys) {
  const path = pathOf(a);
  const per = await askEach(pool, a.relays, { kinds: [15128], authors: [a.pubkey] });
  const newest = newestOf(flat(per).filter((e) => e.kind === 15128));
  if (!newest || !tableOf(newest)[path]) return { purged: [], waiting: 0 };
  const table = tableOf(newest);
  const named = namedHashes([...per.values()].map((evs) => newestOf(evs || [])).filter(Boolean));
  const list = mergeRetired([a.retired || [], a.workspace ? retiredFor(retiredOf(newest), path) : retiredOf(newest)], Object.values(table))
    .filter((r) => !named.has(r.hash));
  if (!list.length) return { purged: [], waiting: 0 };
  const due = list.filter((r) => now() - r.at >= cfg.retireAfter);
  if (!due.length) return { purged: [], waiting: list.length };
  const allCurrent = standing(a.relays, per, newest, a.workspace ? path : null).every((r) => r.has === "current");
  const gw = allCurrent ? await gatewayState(cfg, a, table[path], list.map((r) => r.hash)) : { serves: "not asked" };
  const settled = allCurrent && gw.serves === "current";
  const plan = planRetired(list, { now: now(), after: cfg.retireAfter, settled, max: Infinity });
  const purged = plan.purge.length ? await purge(union(a.servers, serversOf(newest)), plan.purge, signersOf(cfg, keys.sk)) : [];
  patch(a.id, (e) => {
    e.retired = list.filter((r) => !purged.includes(r.hash)); dropBlobs(e, purged);
    if (e.workspace && purged.length) e.forget = [...new Set([...(e.forget || []), ...purged])];
  });
  if (purged.length) log({ cmd: "purge", id: a.id, purged });
  return { purged, waiting: list.length - purged.length, ...(settled ? {} : { why: !allCurrent ? "not every relay has the newest version" : `the gateway serves ${gw.serves}` }) };
}

async function sweep() {
  const cfg = settings();
  const ledger = readLedger();
  const all = Object.values(ledger.artifacts);
  const pendingAfter = duration(process.env.NSITE_ARTIFACTS_PENDING_AFTER, 3600);
  // A create that never finished: its link was never handed out.
  const stale = all.filter((a) => a.state === "pending" && !a.deleted && a.secret && now() - a.created >= pendingAfter);
  const due = all.filter((a) => !a.deleted && a.state !== "pending" && a.secret && a.expires && a.expires <= now());
  const retry = all.filter((a) => a.deleted && a.secret && !flags["no-retry"] && (a.removeTries || 0) < 14 &&
    ((a.pendingRelays || []).length || (a.blobs || []).length || a.state === "pending"));
  const gaveUp = all.filter((a) => a.deleted && a.secret && (a.removeTries || 0) >= 14).map((a) => a.id);
  const live = all.filter((a) => !a.deleted && a.secret && a.state !== "pending" && !due.includes(a));
  const done = [], retiring = [];
  await withPool(async (pool) => {
    for (const a of [...stale, ...due, ...retry]) {
      try {
        const keys = await keysOf(a);
        const out = await remove(a, keys, cfg, pool);
        const by = stale.includes(a) ? "sweep: create never finished" : due.includes(a) ? "sweep: expired" : null;
        patch(a.id, (e) => {
          e.deleted = e.deleted || now(); if (by && !e.deletedBy) e.deletedBy = by; e.state = "deleted";
          dropBlobs(e, out.gone); e.pendingRelays = out.lingering; e.removeTries = (e.removeTries || 0) + 1;
          if (!out.left.length && !out.lingering.length) delete e.secret;
        });
        log({ cmd: "sweep", id: a.id, by, lingering: out.lingering, left: out.left.length });
        done.push({ id: a.id, title: a.title, ...(by ? { why: by.replace("sweep: ", "") } : { why: "finishing a deletion" }),
          ...(out.left.length ? { left: out.left.length } : {}), ...(out.lingering.length ? { lingering: out.lingering.length } : {}) });
      } catch (e) { done.push({ id: a.id, title: a.title, error: redact(e.message) }); }
    }
    for (const a of live) {
      try {
        const keys = await keysOf(a);
        const r = await purgeRetired(pool, cfg, a, keys);
        if (r.purged.length || r.waiting) retiring.push({ id: a.id, deleted: r.purged.length, kept: r.waiting, ...(r.why ? { why: r.why } : {}) });
      } catch (e) { retiring.push({ id: a.id, error: redact(e.message) }); }
    }
  });
  const soon = Object.values(readLedger().artifacts).filter((a) => !a.deleted && a.expires && a.expires - now() < 3 * 86400)
    .map((a) => ({ id: a.id, title: a.title, expires: iso(a.expires) }));
  return { deleted: done, oldVersions: retiring, expiringSoon: soon, ...(gaveUp.length ? { gaveUp } : {}) };
}

async function rekey(id) {
  const a = entryOf(readLedger(), id);
  const keys = await keysOf(a);
  const drop = many(flags.remove).map(toHex);
  const cfg = settings();
  const page = await withPool((pool) => fetchPage(pool, a, keys, { forWrite: true }));
  if (page.hash !== a.seenHash && !flags.force) {
    fail(`${a.id} was changed after you last read it. Run "read ${a.id}" first, so that change is not marked as seen unread, then rekey. --force skips this.`);
  }
  // A new key is a new address: nothing published under the old one can be
  // made to stop working for somebody who already holds it, except by deleting it.
  const made = await create(null, { html: page.html.replace(BASE_META, ""), visibility: a.visibility, edit: a.edit, title: a.title,
    expires: a.expires, members: (a.members || []).filter((m) => !drop.includes(m.pubkey)),
    comments: a.comments, shellTitle: a.shellTitle, allow: a.allow || [], allowBlocked: a.allowBlocked, workspace: a.workspace || null });
  // Saved while this ran: the new page is from before that save. Undo, and say so.
  const again = await withPool((pool) => fetchPage(pool, a, keys, { forWrite: true })).catch(() => null);
  if (!again || again.hash !== page.hash) {
    await del(made.id, { replacedBy: null, by: "rekey rolled back" }).catch(() => {});
    fail(`${a.id} was saved while it was being moved to a new key, so the move was undone and the old link still works. Run "read ${a.id}" and rekey again.`);
  }
  const gone = await del(a.id, { replacedBy: made.id, by: "rekey" });
  return { ...made, replaces: a.id, oldDeleted: gone.blobs,
    ...(a.workspace ? { note: "The page has a new read key and link. Whoever had an edit link to it still holds the workspace's key: that cannot be taken back inside the workspace." } : {}) };
}

// Move artifacts onto the runtime this tool would publish with today. Only the
// manifest changes: the page links /nsite-clay.js by its plain name, so its
// bytes, sealed or not, stay exactly as they are, and so does the link.
async function upgrade(id) {
  const cfg = settings();
  const ledger = readLedger();
  const targets = id ? [entryOf(ledger, id)] : Object.values(ledger.artifacts).filter((a) => !a.deleted && a.secret && a.state !== "pending");
  if (!targets.length) return { upgraded: [], current: [] };
  const upgraded = [], current = [], failed = [];
  await withPool(async (pool) => {
    for (const a of targets) {
      try {
        const keys = await keysOf(a);
        const live = await fetchPage(pool, a, keys, { forWrite: true });
        const uploader = uploaderKey(cfg, keys.sk);
        const want = await putRuntime(pool, a, live.html, cfg, uploader, Object.keys(live.table));
        const moved = Object.keys(want).filter((p) => live.table[p] !== want[p]);
        if (!moved.length) { current.push(a.id); continue; }
        // A workspace shares its runtime between its pages: the root's files
        // change, merged into the manifest as it is now, and nothing else.
        if (a.workspace) {
          const res = await commitPaths(pool, workspaceOf(a), cfg, { set: Object.fromEntries(moved.map((p) => [p, want[p]])), sealed: a.sealed });
          log({ cmd: "upgrade", id: a.id, workspace: a.workspace, files: moved, relays: `${res.relays.current}/${res.relays.of}` });
          upgraded.push({ id: a.id, workspace: a.workspace, files: moved, verified: res.relays.ok, relays: { ok: res.relays.current, of: res.relays.of } });
          continue;
        }
        // A save from a phone in the seconds the runtime took to upload would
        // otherwise be thrown away by a manifest built on the older table.
        const again = newestOf(flat(await askEach(pool, a.relays, { kinds: [15128], authors: [a.pubkey] })));
        if (again && again.id !== live.manifest.id) { failed.push({ id: a.id, error: "saved while this ran; run upgrade again" }); continue; }
        const retired = mergeRetired([a.retired || [], retiredOf(live.manifest)], Object.values({ ...live.table, ...want }));
        const manifest = signManifest(a, keys.sk, { ...live.table, ...want }, live.manifest, retired);
        const took = await publish(pool, a.relays, manifest);
        if (!took.length) { failed.push({ id: a.id, error: "no relay accepted the manifest" }); continue; }
        const relays = await confirmPublish(pool, a, manifest, cfg);
        patch(a.id, (e) => { e.savedAt = manifest.created_at; e.retired = retired; });
        log({ cmd: "upgrade", id: a.id, files: moved, relays: `${relays.current}/${relays.of}` });
        upgraded.push({ id: a.id, files: moved, verified: relays.ok, relays: { ok: relays.current, of: relays.of } });
      } catch (e) { failed.push({ id: a.id, error: redact(e.message) }); if (id) throw e; }
    }
  });
  return { upgraded, current, ...(failed.length ? { failed } : {}) };
}

// Take a page into this ledger from its edit link: for a harness whose home
// directory does not survive, or a page made on another machine.
async function adopt(link) {
  if (!link) fail("usage: adopt <edit link>   (the whole link, with #e=… at the end)");
  let url;
  try { url = new URL(link); } catch { fail("that is not a link"); }
  const given = parseFragment(url.hash);
  const secret = given.edit;
  if (!secret) fail("adopt needs the edit link, the one with #e=… at the end. A read link cannot change or delete the page.");
  const keys = await keysFrom(given);
  const npub = nip19.npubEncode(keys.pubkey);
  if (!url.hostname.toLowerCase().startsWith(npub)) {
    const b36 = BigInt("0x" + keys.pubkey).toString(36).padStart(50, "0");
    if (!url.hostname.toLowerCase().startsWith(b36)) fail("the key in that link does not belong to the page it points at");
  }
  if (keys.split || (url.pathname !== "/" && url.pathname !== "")) return adoptWorkspacePage(url, keys);
  const id = bytesToHex(sha256(enc.encode(keys.pubkey))).slice(0, 8);
  const known = readLedger().artifacts[id];
  if (known && !known.deleted) return { id, adopted: false, note: "already in the ledger" };
  const cfg = settings();
  const a = {
    id, pubkey: keys.pubkey, npub, secret: b64u(keys.sk), title: "", visibility: "link", edit: val("edit") || "link",
    sealed: true, members: [], created: now(), expires: null, relays: union(cfg.relays), servers: cfg.servers.map(norm),
    url: `${url.origin}/`, state: "live", blobs: [], retired: [], comments: true,
  };
  if (!["none", "link", "members"].includes(a.edit)) fail("--edit is none, link or members");
  return withPool(async (pool) => {
    const lookup = union(a.relays, ["wss://relay.nsite.lol"]);
    const m = newestOf(flat(await askEach(pool, lookup, { kinds: [15128], authors: [a.pubkey] })));
    if (!m || !tableOf(m)["/index.html"]) fail("no relay has a page for that link. It may have expired or been deleted.");
    a.sealed = m.tags.some((t) => t[0] === "sealed");
    a.visibility = a.sealed ? "link" : "public";
    a.servers = union(serversOf(m).length ? serversOf(m) : a.servers);
    const exp = Number(m.tags.find((t) => t[0] === "expiration")?.[1]);
    if (exp) a.expires = exp;
    a.created = m.created_at;
    const page = await fetchPage(pool, a, keys);
    adoptMembers(a, page.shell);
    a.title = (/<title[^>]*>([^<]*)<\/title>/i.exec(page.html)?.[1] || "").trim();
    a.comments = /<html\b[^>]*\bnc:comments\b/i.test(page.html);
    const relaysAttr = /<html\b[^>]*\bnc:relays="([^"]*)"/i.exec(page.html)?.[1];
    if (relaysAttr) a.relays = union(relaysAttr.split(/[,\s]+/));
    if (page.shell) {
      if (page.shell.title && page.shell.title !== "Private page") a.shellTitle = page.shell.title;
      if (page.shell.policy) a.policy = page.shell.policy;
    }
    a.hash = page.hash; a.seenHash = page.hash; a.savedAt = page.manifest.created_at;
    a.blobs = [page.hash]; a.retired = retiredOf(page.manifest);
    withLedger((l) => { l.artifacts[a.id] = a; });
    remember(a, digest(page.html), page.html);
    log({ cmd: "adopt", id: a.id, hash: page.hash });
    return { id: a.id, title: a.title, url: a.url, adopted: true, sealed: a.sealed,
      expires: a.expires ? iso(a.expires) : null };
  });
}

// The ledger entries, keys included, into a file only this user can read:
// for moving them to another home. Never to stdout.
function exportLedger(id) {
  const out = val("out") || fail("usage: export [id] --out=<file>   (the file holds the keys; it is written readable by you only)");
  const ledger = readLedger();
  const picked = id ? [entryOf(ledger, id, { deleted: true })] : Object.values(ledger.artifacts);
  // A workspace page is opened with its workspace's key, so that goes too.
  const spaces = [...new Set(picked.map((a) => a.workspace).filter(Boolean))];
  const file = resolve(out);
  writeFileSync(file, JSON.stringify({ v: 1, artifacts: Object.fromEntries(picked.map((a) => [a.id, a])),
    ...(spaces.length || !id ? { workspaces: Object.fromEntries(Object.entries(ledger.workspaces).filter(([n]) => !id || spaces.includes(n))) } : {}) }, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, artifacts: picked.map(publicOf), ...(spaces.length ? { workspaces: spaces, warning: "The file also holds the key of each workspace these pages are in, which can change every page in it." } : {}) };
}
function importLedger(file) {
  if (!file) fail("usage: import <file>   (a file written by export)");
  let data;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { fail("that file is not an export of this ledger"); }
  if (!data || typeof data.artifacts !== "object") fail("that file is not an export of this ledger");
  const added = [], kept = [];
  withLedger((l) => {
    for (const w of Object.values(data.workspaces || {})) {
      if (!w?.name || !w.secret) continue;
      if (l.workspaces[w.name] && l.workspaces[w.name].pubkey !== w.pubkey) fail(`there is a workspace "${w.name}" here already, with another key, so nothing was imported`);
      if (!l.workspaces[w.name]) l.workspaces[w.name] = w;
    }
    for (const a of Object.values(data.artifacts)) {
      if (!a?.id || !a.pubkey) continue;
      if (l.artifacts[a.id]) { kept.push(a.id); continue; }
      l.artifacts[a.id] = a; added.push(a.id);
    }
  });
  return { added, alreadyHere: kept };
}

function list() {
  const ledger = readLedger();
  const only = flags.workspace !== undefined ? workspaceName(settings()) : null;
  return { artifacts: Object.values(ledger.artifacts).filter((a) => (flags.all || !a.deleted) && (!only || a.workspace === only)).map((a) => ({
    id: a.id, title: a.title, ...(a.workspace ? { workspace: a.workspace } : {}), visibility: a.visibility, edit: a.edit, url: a.url,
    created: iso(a.created),
    expires: a.expires ? iso(a.expires) : null,
    ...(a.state && a.state !== "live" && a.state !== "deleted" ? { state: a.state } : {}),
    ...(a.deleted ? { deleted: iso(a.deleted), deletedBy: a.deletedBy || "cli", ...(a.replacedBy ? { replacedBy: a.replacedBy } : {}) } : {}),
  })) };
}

async function links(id) {
  const a = entryOf(readLedger(), id);
  return { id: a.id, ...linksOf(a, await keysOf(a)) };
}

// ------------------------------------------------------- workspace commands

function newWorkspaceEntry(name, sk, cfg, { owner = null } = {}) {
  const pubkey = getPublicKey(sk);
  return {
    name, pubkey, npub: nip19.npubEncode(pubkey), secret: b64u(sk), created: now(),
    relays: union(cfg.relays), servers: cfg.servers.map(norm), url: siteUrl(cfg, pubkey), removed: {},
    ...(owner ? { owner } : {}),
  };
}
/** The workspace a `workspace …` command means: --name, or the configured one, or "default". */
function wsNameArg(cfg) {
  const name = flags.name !== undefined ? val("name") : cfg.workspace || "default";
  if (!WS_NAME.test(String(name))) fail(`"${name}" is not a workspace name: lower case letters, digits, - and _, at most 32`);
  return String(name);
}
const uploaderNpub = (cfg, ws) => nip19.npubEncode(getPublicKey(uploaderKey(cfg, unb64u(ws.secret))));
function keyBytes(text) {
  const k = String(text || "").trim();
  if (/^[0-9a-f]{64}$/i.test(k)) return hexToBytes(k.toLowerCase());
  try { const d = nip19.decode(k); if (d.type === "nsec") return d.data; } catch { /* below */ }
  return null;
}

async function wsInit() {
  const cfg = settings();
  const name = wsNameArg(cfg);
  const owner = flags.owner !== undefined ? toHex(val("owner")) : null;
  const existing = readLedger().workspaces[name];
  if (existing) {
    if (!flags["update-servers"] && !owner) {
      fail(`there is a workspace "${name}" here already (${existing.npub}). "workspace list" shows it. --update-servers takes the relays ` +
        `and servers from the settings for the pages made from now on; --owner=<npub> sets whose key opens its pages.`);
    }
    const w = withLedger((l) => {
      const x = l.workspaces[name];
      if (flags["update-servers"]) { x.relays = union(cfg.relays); x.servers = cfg.servers.map(norm); }
      if (owner) x.owner = owner;
      return x;
    });
    log({ cmd: "workspace init", workspace: name, updated: true });
    return { workspace: name, npub: w.npub, url: w.url, updated: true, relays: w.relays, servers: w.servers, uploader: uploaderNpub(cfg, w),
      ...(w.owner ? { owner: nip19.npubEncode(w.owner) } : {}),
      note: "Pages made from now on use these relays and servers. Pages made earlier keep theirs." };
  }
  const sk = newSecret();
  uploaderKey(cfg, sk);
  const ws = newWorkspaceEntry(name, sk, cfg, { owner });
  // The key is kept before anything goes out, as with a page.
  withLedger((l) => {
    if (l.workspaces[name]) fail(`there is a workspace "${name}" here already`);
    l.workspaces[name] = ws;
  });
  log({ cmd: "workspace init", workspace: name, npub: ws.npub });
  const warnings = [];
  let published = null;
  try {
    await withPool(async (pool) => {
      const runtime = await putRuntime(pool, { workspace: name, servers: ws.servers, sealed: true }, "", cfg, uploaderKey(cfg, sk));
      const res = await commitPaths(pool, ws, cfg, { set: {}, setIfMissing: runtime, sealed: true });
      await publishRelayList(pool, { relays: ws.relays, expires: null }, sk, res.manifest.created_at);
      published = { verified: res.relays.ok, relays: { ok: res.relays.current, of: res.relays.of } };
    });
  } catch (e) {
    warnings.push(`the workspace is made and its key is kept, but its first manifest did not go out (${redact(e.message)}). The first page made in it publishes it.`);
  }
  return {
    workspace: name, npub: ws.npub, url: ws.url, relays: ws.relays, servers: ws.servers,
    uploader: uploaderNpub(cfg, ws), ...(owner ? { owner: nip19.npubEncode(owner) } : {}), ...(published || {}),
    note: `Make pages in it with: create <file.html> --workspace${name === "default" ? "" : `=${name}`}. Each page gets its own link. ` +
      `A Blossom server that takes uploads only from keys it allows needs to allow ${uploaderNpub(cfg, ws)} once.`,
    ...(warnings.length ? { warnings } : {}),
  };
}

async function wsList() {
  const cfg = settings();
  const ledger = readLedger();
  const names = flags.name !== undefined ? [wsNameArg(cfg)] : Object.keys(ledger.workspaces);
  for (const n of names) needWorkspace(n, ledger);
  const rows = await withPool((pool) => Promise.all(names.map(async (name) => {
    const ws = ledger.workspaces[name];
    const { newest, tops } = await workspaceTops(pool, ws);
    const table = tableOf(newest);
    const mine = Object.values(ledger.artifacts).filter((a) => a.workspace === name);
    const known = new Set(mine.map((a) => a.path));
    return {
      name, npub: ws.npub, url: ws.url, relays: ws.relays, servers: ws.servers, uploader: uploaderNpub(cfg, ws),
      ...(ws.owner ? { owner: nip19.npubEncode(ws.owner) } : {}),
      ...((cfg.workspace || "default") === name ? { default: true } : {}),
      reached: `${tops.length} of ${ws.relays.length} relays`, savedAt: newest ? iso(newest.created_at) : null,
      pages: mine.filter((a) => !a.deleted).map((a) => ({
        id: a.id, title: a.title, path: a.path, url: a.url, expires: a.expires ? iso(a.expires) : null,
        published: !!table[a.path], ...(table[a.path] && table[a.path] !== a.seenHash ? { changed: true } : {}),
        ...(a.id === ws.index ? { index: true } : {}),
      })),
      // Pages another machine or harness made with the same key: in the
      // manifest, not in this ledger. Their paths say nothing; only the count.
      otherPages: Object.keys(table).filter((p) => !isRuntimePath(p) && !known.has(p)).length,
    };
  })));
  return { workspaces: rows };
}

// Everything that can be checked about a workspace as a whole, read-only.
async function checkWorkspace(pool, cfg, ws, { deep = true } = {}) {
  const ledger = readLedger();
  const { per, tops, newest } = await workspaceTops(pool, ws);
  const problems = [], notes = [];
  const relays = standing(ws.relays, per, newest).map((r) => ({ url: r.url, has: r.has }));
  const base = { workspace: ws.name, npub: ws.npub };
  if (!newest) {
    const reached = relays.some((r) => r.has !== "unreachable");
    return { ...base, ok: false, health: "broken", relays, problems: [reached ? "no relay has the workspace's manifest" : "no relay could be reached"], lost: [], resurrected: [], blobs: [] };
  }
  const table = tableOf(newest);
  const removed = ws.removed || {};
  const lag = relays.filter((r) => r.has !== "current");
  if (lag.length) {
    const gw = norm(cfg.gatewayRelay || ws.relays[0]);
    (lag.some((r) => r.url === gw) || relays.length - lag.length < Math.floor(ws.relays.length / 2) + 1 ? problems : notes)
      .push(`${lag.length} of ${ws.relays.length} relays lack the newest manifest: ${lag.map((r) => `${r.url} (${r.has})`).join(", ")}`);
  }
  const servers = union(ws.servers, serversOf(newest));
  const blobs = [];
  if (deep) {
    for (const [p, h] of Object.entries(table)) {
      const rows = await holders(servers, h, { cache: isRuntimePath(p) });
      const ok = rows.filter((r) => r.state === "ok").length;
      if (ok < servers.length) blobs.push({ path: p, hash: h, ok, of: servers.length, lacking: rows.filter((r) => r.state !== "ok").map((r) => r.server) });
      if (!ok) problems.push(`${p} is on no server`);
    }
  }
  const mine = Object.values(ledger.artifacts).filter((a) => a.workspace === ws.name && !a.deleted && a.state !== "pending");
  const lost = mine.filter((a) => !table[a.path]).map((a) => a.id);
  if (lost.length) problems.push(`${lost.length} page(s) made here are not in the workspace's manifest: ${lost.join(", ")}. "workspace doctor --fix" puts back each one whose file, or a copy kept here, is still there.`);
  const resurrected = Object.keys(table).filter((p) => (removed[p] || []).includes(table[p]));
  if (resurrected.length) problems.push(`${resurrected.length} page(s) deleted here are named again (a browser tab saved an older list): ${resurrected.join(", ")}. "workspace doctor --fix" takes them out.`);
  const dropped = new Set();
  for (const top of tops) for (const [p, h] of Object.entries(tableOf(top))) if (!table[p] && !(removed[p] || []).includes(h) && !mine.some((a) => a.path === p)) dropped.add(p);
  if (dropped.size) {
    notes.push(`${dropped.size} path(s) that an older manifest on some relay names are not in the newest one. If a page there was not deleted, ` +
      `it was lost in a race between two writers, and the machine that made it puts it back with "workspace doctor --fix".`);
  }
  if (!table["/nsite-clay.js"] && Object.keys(table).some((p) => !isRuntimePath(p))) problems.push(`the workspace names no /nsite-clay.js, so none of its pages opens. Run "upgrade".`);
  const pages = [];
  for (const a of mine.filter((x) => table[x.path])) {
    const r = await inspect(pool, cfg, a, { deep });
    pages.push({ id: a.id, title: a.title, health: r.health, ...(r.problems.length ? { problems: r.problems } : {}) });
  }
  const ok = !problems.length && pages.every((p) => p.health === "ok");
  return {
    ...base, ok, health: problems.some((p) => /on no server|names no/.test(p)) || pages.some((p) => p.health === "broken") || lost.length ? "broken" : ok ? "ok" : "degraded",
    savedAt: iso(newest.created_at), relays, paths: Object.keys(table).length, pages,
    otherPages: Object.keys(table).filter((p) => !isRuntimePath(p) && !mine.some((a) => a.path === p) && !resurrected.includes(p)).length,
    ...(blobs.length ? { blobs } : {}), lost, resurrected, problems, ...(notes.length ? { notes } : {}),
  };
}

async function wsVerify({ fix = false } = {}) {
  const cfg = settings();
  const name = wsNameArg(cfg);
  const ws = needWorkspace(name);
  const before = await withPool((pool) => checkWorkspace(pool, cfg, ws));
  if (!fix) {
    if (!before.ok) exitCode = 1;
    return { ...before, ...(before.ok ? {} : { next: `workspace doctor${flags.name !== undefined ? ` --name=${name}` : ""} --fix` }) };
  }
  const actions = [];
  await withPool(async (pool) => {
    const ledger = readLedger();
    // Pages the manifest lost, at the version this ledger knows, if a server has it.
    const set = {};
    for (const id of before.lost) {
      const a = ledger.artifacts[id];
      if (a.hash && (await holders(union(a.servers, ws.servers), a.hash)).some((r) => r.state === "ok")) set[a.path] = a.hash;
    }
    if (Object.keys(set).length || before.resurrected.length) {
      const res = await commitPaths(pool, ws, cfg, { set, drop: before.resurrected, sealed: true });
      if (Object.keys(set).length) actions.push(`put ${Object.keys(set).length} lost page(s) back into the manifest`);
      if (before.resurrected.length) actions.push(`took out ${before.resurrected.length} page(s) that were deleted and came back`);
      actions.push(`the manifest reached ${res.relays.current} of ${res.relays.of} relays`);
    }
    // Files a server lacks, copied from one that has them.
    const uploader = uploaderKey(cfg, unb64u(ws.secret));
    for (const b of before.blobs || []) {
      const lacking = b.lacking.filter((s) => ws.servers.includes(s));
      if (!lacking.length) continue;
      const bytes = await findBytes(cfg, { servers: ws.servers }, b.hash);
      if (!bytes) { actions.push(`${b.path}: no copy found anywhere`); continue; }
      const put = await placeBlob(lacking, bytes, RUNTIME_FILES[b.path] || "text/html", uploader, null, { always: true });
      actions.push(`${b.path}: copied to ${put.filter((r) => r.state === "ok").length} of ${lacking.length} servers that lacked it`);
    }
    const { per, newest } = await workspaceTops(pool, ws);
    if (newest) {
      const lag = ws.relays.filter((r) => per.get(r) != null && newestOf(per.get(r) || [])?.id !== newest.id);
      if (lag.length) {
        const took = await publish(pool, lag, newest);
        actions.push(`sent the newest manifest again to ${took.length} of ${lag.length} relays that lacked it`);
      }
    }
  });
  // What is left is a page's own: each one that still has a problem gets its doctor.
  const mid = await withPool((pool) => checkWorkspace(pool, cfg, readLedger().workspaces[name]));
  for (const p of mid.pages.filter((x) => x.health !== "ok")) {
    try { const r = await doctor(p.id); actions.push(`${p.id}: ${(r.actions || []).join("; ") || "nothing to do"}`); }
    catch (e) { actions.push(`${p.id}: ${redact(e.message)}`); }
  }
  for (const id of mid.lost) {
    try { const r = await doctor(id); actions.push(`${id}: ${(r.actions || []).join("; ") || "nothing to do"}`); }
    catch (e) { actions.push(`${id}: ${redact(e.message)}`); }
  }
  log({ cmd: "workspace doctor", workspace: name, actions });
  const after = await withPool((pool) => checkWorkspace(pool, cfg, readLedger().workspaces[name]));
  exitCode = after.ok ? 0 : 1;
  return { workspace: name, before: before.problems, actions, after };
}

// A workspace from another machine or harness: a file `workspace export`
// wrote, or a file (or stdin, "-") that holds its secret key. The key is never
// printed back.
async function wsAdopt(src) {
  if (!src) fail("usage: workspace adopt <file> | -  [--name=N]   (a file written by workspace export, or a file holding the nsec; - reads it from stdin)");
  const cfg = settings();
  const warnings = [];
  let text;
  if (src === "-") text = readFileSync(0, "utf8");
  else if (keyBytes(src)) {
    text = src;
    warnings.push("a key given on the command line can end up in the shell's history and in a transcript. Next time give a file that holds it, or pipe it in with -.");
  } else {
    try { text = readFileSync(resolve(src), "utf8"); } catch (e) { fail(`cannot read ${src}: ${e.code || e.message}`); }
  }
  let data = null;
  try { data = JSON.parse(text); } catch { /* a key */ }
  let sk, from = null, pages = {};
  if (data && typeof data === "object" && data.workspace?.secret) {
    from = data.workspace; sk = unb64u(from.secret); pages = data.artifacts || {};
    if (sk.length !== 32) fail("that file is not one written by workspace export");
  } else {
    sk = keyBytes(String(text).trim().split(/\s+/)[0]);
    if (!sk) fail("that is neither a file written by workspace export nor a secret key (nsec1… or 64 hex characters)");
  }
  const pubkey = getPublicKey(sk);
  const name = flags.name !== undefined ? wsNameArg(cfg) : from?.name || cfg.workspace || "default";
  if (!WS_NAME.test(name)) fail(`"${name}" is not a workspace name`);
  const added = [], kept = [];
  let fresh = false;
  withLedger((l) => {
    const had = l.workspaces[name];
    if (had && had.pubkey !== pubkey) fail(`there is a workspace "${name}" here already, with another key. Give this one another name: --name=…`);
    const other = Object.values(l.workspaces).find((w) => w.pubkey === pubkey && w.name !== name);
    if (other) fail(`that key is the workspace "${other.name}" here already`);
    if (!had) {
      fresh = true;
      l.workspaces[name] = from ? { ...newWorkspaceEntry(name, sk, cfg), ...from, name, removed: from.removed || {} } : newWorkspaceEntry(name, sk, cfg);
    } else if (from?.removed) {
      for (const [p, hs] of Object.entries(from.removed)) had.removed[p] = [...new Set([...(had.removed?.[p] || []), ...hs])];
    }
    for (const a of Object.values(pages)) {
      if (!a?.id || !a.pubkey || a.pubkey !== pubkey) continue;
      if (l.artifacts[a.id]) { kept.push(a.id); continue; }
      l.artifacts[a.id] = { ...a, workspace: name };
      added.push(a.id);
    }
  });
  log({ cmd: "workspace adopt", workspace: name, fresh, pages: added.length });
  const ws = readLedger().workspaces[name];
  const { newest } = await withPool((pool) => workspaceTops(pool, ws));
  const table = tableOf(newest);
  return {
    workspace: name, npub: ws.npub, adopted: fresh, pages: added, ...(kept.length ? { alreadyHere: kept } : {}),
    published: !!newest, paths: Object.keys(table).filter((p) => !isRuntimePath(p)).length,
    ...(from ? {} : { note: "Only the key came in: pages made elsewhere stay in the workspace, and this ledger can add its own, but it can open only pages whose links it is given (adopt <edit link>) or that a workspace export brings." }),
    ...(warnings.length ? { warnings } : {}),
  };
}

function wsExport() {
  const cfg = settings();
  const name = wsNameArg(cfg);
  const ledger = readLedger();
  const ws = needWorkspace(name, ledger);
  const out = val("out") || fail("usage: workspace export --out=<file> [--name=N]   (the file holds the workspace's secret key; it is written readable by you only)");
  const file = resolve(out);
  if (existsSync(file) && !flags.force) fail(`${file} exists already. Give another file, or --force to write over it.`);
  const pages = Object.values(ledger.artifacts).filter((a) => a.workspace === name && !a.deleted);
  const body = JSON.stringify({ v: 1, kind: "nsite-artifacts workspace", workspace: ws, artifacts: Object.fromEntries(pages.map((a) => [a.id, a])) }, null, 2);
  writeFileSync(file, body, { mode: 0o600, flag: flags.force ? "w" : "wx" });
  chmodSync(file, 0o600);
  log({ cmd: "workspace export", workspace: name, pages: pages.length });
  return {
    file, workspace: name, npub: ws.npub, pages: pages.map(publicOf),
    warning: "This file holds the workspace's secret key and the key of every page in it. Whoever has it can read those pages and change or " +
      "take down any page of the workspace. Do not print it, paste it into a chat or commit it. Copy it only to a machine or harness you trust, " +
      "run \"workspace adopt <file>\" there, and then delete it.",
  };
}

// The page at the workspace's root. Nothing by default, so the site's address
// says nothing. On request a sealed page of its own, with its own link,
// listing the pages chosen and their links: whoever has that link can open
// every page on it.
async function wsIndex() {
  const cfg = settings();
  const name = wsNameArg(cfg);
  const ledger = readLedger();
  needWorkspace(name, ledger);
  const ws = ledger.workspaces[name];
  const current = ws.index ? ledger.artifacts[ws.index] : null;
  if (flags["remove-index"]) {
    if (!current || current.deleted) return { workspace: name, index: null, note: "there was no index page" };
    const out = await del(current.id, { replacedBy: null, by: "workspace index" });
    withLedger((l) => { delete l.workspaces[name].index; });
    return { workspace: name, removed: current.id, relays: out.relays };
  }
  const which = many(flags.pages);
  if (!which.length) fail("usage: workspace index --pages=all|<id>,<id>… [--links=read|edit] [--title=…] [--lang=…] | workspace index --remove-index");
  const mode = val("links") || "read";
  if (!["read", "edit"].includes(mode)) fail("--links is read or edit");
  const mine = Object.values(ledger.artifacts).filter((a) => a.workspace === name && !a.deleted && a.path !== "/index.html");
  const picked = which.includes("all") ? mine : which.map((id) => {
    const a = entryOf(ledger, id);
    if (a.workspace !== name) fail(`${a.id} is not in the workspace "${name}"`);
    return a;
  });
  const rows = [];
  for (const a of picked) {
    const l = linksOf(a, await keysOf(a));
    rows.push({ title: a.title || a.id, href: mode === "edit" && l.editLink ? l.editLink : l.readLink || l.url });
  }
  const title = val("title") || "Pages";
  const html = `<!doctype html>\n<html lang="${esc(val("lang") || "en")}">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(title)}</title>\n` +
    `<style>:root{color-scheme:light dark}body{font:17px/1.5 system-ui,sans-serif;max-width:36rem;margin:0 auto;padding:1.5rem 1rem}` +
    `li{margin:.6rem 0}a{display:inline-block;padding:.3rem 0}</style>\n</head>\n<body>\n<main>\n<h1>${esc(title)}</h1>\n<ul>\n` +
    rows.map((r) => `<li><a href="${esc(r.href)}">${esc(r.title)}</a></li>`).join("\n") + `\n</ul>\n</main>\n</body>\n</html>\n`;
  const note = `Whoever has the link to this index can open every page listed on it${mode === "edit" ? ", and change them" : ""}.`;
  if (current && !current.deleted) {
    const keys = await keysOf(current);
    return withPool(async (pool) => {
      const live = await fetchPage(pool, current, keys, { forWrite: true });
      const page = stampPage(html, current);
      const res = await publishPage(pool, current, keys, page, cfg, { live: live.manifest, table: live.table,
        onUploaded: (h) => patch(current.id, (e) => addBlobs(e, [h])) });
      const e = patch(current.id, (e) => { applyPublish(e, res); e.seenHash = res.hash; });
      remember(e, digest(page), page);
      const { out: how } = landed(res, current, cfg);
      return { workspace: name, id: current.id, pages: rows.length, ...how, note: `${note} Its link did not change: "links ${current.id}".` };
    });
  }
  const made = await create(null, { html, workspace: name, path: "/index.html", visibility: "link", edit: "none", expires: null, title, comments: false });
  withLedger((l) => { l.workspaces[name].index = made.id; });
  return { ...made, pages: rows.length, note };
}

async function workspaceCmd(sub) {
  switch (sub) {
    case "init": return wsInit();
    case "list": return wsList();
    case "verify": return wsVerify();
    case "doctor": return wsVerify({ fix: !!flags.fix });
    case "adopt": return wsAdopt(positional[1]);
    case "export": return wsExport();
    case "index": return wsIndex();
    default: fail("usage: workspace init | list | verify | doctor [--fix] | adopt <file> | export --out=<file> | index   (see help)");
  }
}

// A page of a workspace, from its edit link: the workspace's key comes with
// it, and becomes a workspace here if it is not one yet.
async function adoptWorkspacePage(url, keys) {
  const cfg = settings();
  let dir = url.pathname.replace(/index\.html$/, "");
  if (!dir.endsWith("/")) dir += "/";
  const path = dir === "/" ? "/index.html" : dir + "index.html";
  const ledger = readLedger();
  let ws = Object.values(ledger.workspaces).find((w) => w.pubkey === keys.pubkey);
  const fresh = !ws;
  if (!ws) {
    const name = flags.name !== undefined ? wsNameArg(cfg) : `adopted-${keys.pubkey.slice(0, 8)}`;
    ws = { ...newWorkspaceEntry(name, keys.sk, cfg), url: `${url.origin}/` };
  }
  const existing = Object.values(ledger.artifacts).find((x) => x.workspace === ws.name && x.path === path && !x.deleted);
  if (existing) return { id: existing.id, adopted: false, note: "already in the ledger" };
  const edit = val("edit") || "link";
  if (!["none", "link", "members"].includes(edit)) fail("--edit is none, link or members");
  return withPool(async (pool) => {
    const { newest } = await workspaceTops(pool, ws);
    if (!newest || !tableOf(newest)[path]) fail("no relay has a page for that link. It may have expired or been deleted.");
    let id = path === "/index.html" ? bytesToHex(randomBytes(4)) : dir.split("/").filter(Boolean).pop();
    if (!/^[0-9a-z_-]{1,64}$/i.test(id) || ledger.artifacts[id]) id = bytesToHex(randomBytes(4));
    const a = {
      id, workspace: ws.name, path, pubkey: keys.pubkey, npub: ws.npub, secret: b64u(keys.K), title: "",
      visibility: "link", edit, sealed: true, members: [], created: newest.created_at, expires: null,
      relays: ws.relays, servers: union(serversOf(newest).length ? serversOf(newest) : ws.servers),
      url: ws.url + (path === "/index.html" ? "" : dir.slice(1)), state: "live", blobs: [], retired: [], comments: true,
    };
    const page = await fetchPage(pool, a, keys);
    a.sealed = !!page.shell; a.visibility = a.sealed ? "link" : "public";
    adoptMembers(a, page.shell);
    a.title = (/<title[^>]*>([^<]*)<\/title>/i.exec(page.html)?.[1] || "").trim();
    a.comments = /<html\b[^>]*\bnc:comments\b/i.test(page.html);
    const exp = Number(page.shell?.attrs?.["nc:expires"] || 0);
    if (exp) a.expires = exp;
    if (page.shell?.title && page.shell.title !== "Private page") a.shellTitle = page.shell.title;
    if (page.shell?.policy) a.policy = page.shell.policy;
    a.hash = page.hash; a.seenHash = page.hash; a.savedAt = newest.created_at;
    a.blobs = [page.hash]; a.retired = retiredFor(retiredOf(newest), path);
    withLedger((l) => {
      if (fresh) {
        if (l.workspaces[ws.name] && l.workspaces[ws.name].pubkey !== ws.pubkey) fail(`there is a workspace "${ws.name}" here already, with another key. Give this one a name: --name=…`);
        l.workspaces[ws.name] = l.workspaces[ws.name] || ws;
      }
      l.artifacts[a.id] = a;
    });
    remember(a, digest(page.html), page.html);
    log({ cmd: "adopt", id: a.id, workspace: ws.name, hash: page.hash });
    return { id: a.id, title: a.title, url: a.url, workspace: ws.name, adopted: true, sealed: a.sealed,
      expires: a.expires ? iso(a.expires) : null, ...(fresh ? { note: `the workspace "${ws.name}" came with it` } : {}) };
  });
}

function version() {
  let skill = null;
  try { skill = /^\s*version:\s*"?([^"\n]+)"?/m.exec(readFileSync(join(HERE, "..", "SKILL.md"), "utf8"))?.[1] || null; } catch { /* not in a skill folder */ }
  return { tool: VERSION, ...(skill ? { skill } : {}), node: process.versions.node, home: HOME };
}

const HELP = `nsite-artifacts ${VERSION}: publish a page, read what people changed, take it down.

  list-page --title=T [--item=…]… [--items=file|-] [--note=…] [--out=list.html]
  create <file.html> [--visibility=link|private|public] [--edit=none|link|members] [--no-comments]
         [--member=npub]… [--member-read=npub]… [--expires=30d|never] [--title=T]
  read <id> [--as=text|html] [--out=file.html] [--diff] [--peek]
  diff <id>              what changed in the page since you last read it, as a diff
  comments <id> [--all] [--peek]       what people wrote on the page, and where
  reply <id> <comment> --text="…" [--resolve] [--by=Agent]
  resolve <id> <comment>   |   reopen <id> <comment>
  status [id]            changed since last read? and a quick health check
  verify [id]            every relay, server and the gateway, checked (exit 1 if not ok)
  doctor <id> [--fix] [--from-seen]    repair what verify found
  update <id> <file.html> [--expires=…] [--force]
  share <id> --member=npub | --member-read=npub
  rekey <id> [--remove=npub]…
  links <id>
  upgrade [id]           move pages onto the runtime this tool publishes with
  adopt <edit link>      take a page into this ledger
  export [id] --out=file | import <file>
  list [--all]
  delete <id> [--replaced-by=<id>] [--keep-key]
  sweep                  expired pages, unfinished deletions, old versions
  --version

One site with many pages under one key (optional; without it every page is its own site):
  workspace init [--name=N] [--owner=npub] [--update-servers]
  create <file.html> --workspace[=N] …   the page goes to /<id>/ of that site, with its own link
  workspace list [--name=N]              its pages, and how many others are in it
  workspace verify [--name=N]            the shared manifest and every page in it (exit 1 if not ok)
  workspace doctor [--name=N] [--fix]    repair: lost pages back, deleted ones out, files, relays
  workspace export --out=file [--name=N] the key and its pages, for another machine (secret: 0600)
  workspace adopt <file>|- [--name=N]    take one in from export, or from a file holding its nsec
  workspace index --pages=all|id,… [--links=read|edit] | --remove-index    a page at its root
  --no-workspace         one site for this page, even when the settings name a workspace

Settings: ${join(HOME, "config.json")} (relays, servers, gateway, runtime, uploader, defaults,
minServers, retireAfter, gatewayCheck, gatewayRelay, workspace, locked)
or NSITE_ARTIFACTS_RELAYS, _SERVERS, _GATEWAY, _RUNTIME, _UPLOADER, _WORKSPACE, _HOME.`;

const commands = {
  create: () => create(positional[0]), "list-page": listPage, read: () => read(positional[0]),
  diff: () => diff(positional[0]), comments: () => comments(positional[0]),
  reply: () => commentAct(positional[0], positional[1], "reply"),
  resolve: () => commentAct(positional[0], positional[1], "resolve"),
  reopen: () => commentAct(positional[0], positional[1], "reopen"),
  status: () => status(positional[0]), verify: () => verify(positional[0]), doctor: () => doctor(positional[0]),
  update: () => update(positional[0], positional[1]),
  share: () => share(positional[0]), rekey: () => rekey(positional[0]), links: () => links(positional[0]),
  adopt: () => adopt(positional[0]), export: () => exportLedger(positional[0]), import: () => importLedger(positional[0]),
  list, delete: () => del(positional[0]), sweep, upgrade: () => upgrade(positional[0]), version,
  workspace: () => workspaceCmd(positional[0]),
};

/** Run one command. Resolves to the process exit code. */
export async function main(argv) {
  if (Number(process.versions.node.split(".")[0]) < NODE_MIN) {
    console.error(`nsite-artifacts: this needs Node.js ${NODE_MIN} or newer, and this is Node ${process.versions.node}. Install a newer Node and run it again.`);
    return 1;
  }
  parseArgs(argv);
  settingsCache = null;
  if (flags.version && cmd === "help") cmd = "version";
  if (!commands[cmd]) { console.log(HELP); return cmd === "help" ? 0 : 2; }
  try {
    const out = JSON.stringify(await commands[cmd](), null, 2) + "\n";
    // Waited for: a page with a picture in it is longer than a pipe's buffer,
    // and leaving before it drains hands the caller half a JSON object.
    await new Promise((done) => process.stdout.write(out, done));
    return exitCode;
  } catch (e) {
    if (e instanceof Fail) { console.error("nsite-artifacts: " + redact(e.message)); return 1; }
    console.error("nsite-artifacts: " + redact(e?.stack || e));
    return 3;
  }
}

// Run directly, as the skill does. Imported, as the CLI does, it only exports.
const direct = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (direct) process.exit(await main(process.argv.slice(2)));
