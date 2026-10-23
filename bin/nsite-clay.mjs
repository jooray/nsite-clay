#!/usr/bin/env node
// nsite-clay CLI: scaffold a site, publish one, download one, and take one down.
//
// Publishing is the same three steps the browser performs on save, which is why
// this tool exists at all: something has to put the first version online before
// the document can start saving itself.
//
//   1. every file becomes a Blossom blob, addressed by its own sha256
//   2. a NIP-5A manifest maps paths to those hashes, signed by the site owner
//   3. a kind-5128 snapshot pins that set of hashes as a permanent version
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, extname, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool, verifyEvent } from "nostr-tools";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import WebSocket from "ws";
import { ensureRelayList, LOOKUP_RELAYS } from "../src/relay-list.js";
useWebSocketImplementation(WebSocket);

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".txt": "text/plain", ".md": "text/markdown", ".xml": "application/xml",
  ".woff2": "font/woff2", ".woff": "font/woff",
};

const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
  // The gateway keeps a live subscription to its own relay and re-syncs the
  // rest on a timer, so publishing here is the difference between one second
  // and ten minutes before a change is visible.
  "wss://relay.nsite.lol",
];
const DEFAULT_SERVERS = ["https://cdn.hzrd149.com", "https://nostr.download"];

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("-")) || "help";
const positional = argv.filter((a) => !a.startsWith("-")).slice(1);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => {
  const i = a.indexOf("=");
  return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));

const list = (v, d) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);
// `let`, because a directory that came from `pull` says where its site lives,
// and that is a better default than the public list. A flag still wins.
let RELAYS = list(flags.relays, DEFAULT_RELAYS);
let SERVERS = list(flags.servers, DEFAULT_SERVERS);
const relaysPinned = typeof flags.relays === "string";
const serversPinned = typeof flags.servers === "string";

const die = (msg) => { console.error("nsite-clay: " + msg); process.exit(1); };

// ------------------------------------------------------------------ signing

// A NIP-46 connection belongs to a client keypair, and the bunker grants its
// permissions to that key. Minting a throwaway key per run therefore works
// exactly once: the URI's one-time secret is spent on the first connect, and
// every later run turns up as an app the bunker has never authorised, which it
// answers with "already connected" followed by "no permission". So the client
// key is kept, one per bunker, and reused.
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "nsite-clay");
const BUNKER_FILE = join(CONFIG_DIR, "bunkers.json");

function readBunkers() {
  try { return JSON.parse(readFileSync(BUNKER_FILE, "utf8")); } catch { return {}; }
}

function rememberClientKey(remotePubkey, secretHex, userPubkey, relays) {
  const all = readBunkers();
  all[remotePubkey] = { clientSecret: secretHex, userPubkey, relays, saved: new Date().toISOString() };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(BUNKER_FILE, JSON.stringify(all, null, 2));
  try { chmodSync(BUNKER_FILE, 0o600); } catch { /* best effort on odd filesystems */ }
}

// A connection saved for this key, if there is one. The URI is needed once: its
// secret is spent on the first connect, and what lasts is the client key the
// bunker approved, its pubkey and its relays, which is everything a later run
// needs to reach it again without asking anybody for a new link.
function savedConnection(owner) {
  if (!owner) return null;
  const found = Object.entries(readBunkers())
    .filter(([, v]) => v.userPubkey === owner && v.clientSecret && v.relays?.length)
    .sort((a, b) => String(b[1].saved).localeCompare(String(a[1].saved)))[0];
  return found ? { pubkey: found[0], relays: found[1].relays, secret: null, stored: found[1] } : null;
}

// One interface over a raw key and a remote signer, so `deploy` does not care
// which the person used. `owner` is the key the site belongs to, when the
// caller knows it, so a connection saved on an earlier run can be found again.
async function getSigner({ owner } = {}) {
  // Prefer the environment: a bunker:// URI carries a secret, and anything on
  // argv is visible to every other process on the machine through `ps`.
  const bunker = process.env.NOSTR_BUNKER_URI || flags.bunker;
  const raw = flags.sec || process.env.NOSTR_SECRET_KEY;
  const saved = !bunker && !raw && !flags.fresh ? savedConnection(owner) : null;
  if (bunker || saved) {
    if (!process.env.NOSTR_BUNKER_URI && flags.bunker) {
      console.error("nsite-clay: warning, --bunker puts the connection secret in your process list.\n" +
                    "  Prefer NOSTR_BUNKER_URI=… in the environment.");
    }
    const bp = saved || await parseBunkerInput(String(bunker));
    if (!bp) die("could not parse that bunker:// URI");
    if (!bp.relays?.length) die("that bunker:// URI names no relays");
    const stored = saved ? saved.stored : (flags.fresh ? null : readBunkers()[bp.pubkey]);
    const clientKey = stored
      ? Uint8Array.from(Buffer.from(stored.clientSecret, "hex"))
      : generateSecretKey();
    // fromBunker, not the constructor: the constructor's second argument is
    // options, so `new BunkerSigner(key, bp)` leaves the pointer unset and
    // connect() dies on it.
    const signer = BunkerSigner.fromBunker(clientKey, { pubkey: bp.pubkey, relays: bp.relays, secret: bp.secret || null });
    // A signer that never answers is the commonest failure, and without a
    // deadline it looks identical to a slow one. Say which relays were tried.
    const deadline = Number(flags.timeout || 60) * 1000;
    const withTimeout = (p) => Promise.race([p, new Promise((_, rej) =>
      setTimeout(() => rej(new Error(
        `no answer within ${deadline / 1000}s. Relays tried: ${bp.relays.join(", ")}. ` +
        `Is the signer running and connected to at least one of them, and is there a ` +
        `prompt waiting for approval?`)), deadline))]);

    if (saved) {
      // Already approved on an earlier run. There is no secret left to present,
      // and the requests below are the real test of whether it still holds.
      process.stderr.write(`connecting to the signer saved for this key in ${BUNKER_FILE}…\n`);
    } else {
      // A bunker that already holds a session for this client answers `connect`
      // with "already connected", which is a success in every sense that
      // matters. With a client key it approved before, whatever it says about
      // a spent secret is beside the point: get_public_key below decides.
      process.stderr.write("connecting to the signer…\n");
      try { await withTimeout(signer.connect()); }
      catch (e) {
        const msg = String(e?.message ?? e);
        if (/no answer within/.test(msg)) die(msg);
        if (!stored && !/already connected/i.test(msg)) {
          die(`the signer refused the connection ("${msg}").\n` +
              `  A bunker:// secret is single use. If this link was used before, by this tool\n` +
              `  on another machine or by another app, ask for a fresh link from the signer.`);
        }
      }
    }
    // NIP-46: the pubkey on the transport is a per-connection routing key, not
    // the user. The identity only comes from an explicit get_public_key.
    // A refusal here is almost always the connection lacking a permission, so
    // say which request was refused rather than passing on a bare "no permission".
    const ask = async (what, fn) => {
      try { return await withTimeout(fn()); }
      catch (e) {
        const msg = String(e?.message ?? e);
        if (/no permission|denied|unauthori[sz]ed|not authori[sz]ed|unknown client/i.test(msg)) {
          die(`the signer refused ${what} ("${msg}").\n` +
              `  Grant this connection: get_public_key, sign_event:24242 (Blossom uploads),\n` +
              `  sign_event:15128 and sign_event:35128 (the nsite manifest), sign_event:5128 (versions),\n` +
              `  sign_event:10002 (a relay list, only if the key has none),\n` +
              `  and for unpublish, sign_event:5 (deletion requests).\n` +
              `  In most signers that means approving the prompt in the app.\n` +
              (stored
                ? `  This run reused the client key saved in ${BUNKER_FILE}. If the connection was\n` +
                  `  revoked in the signer, get a new bunker:// URI and pass --fresh to connect as a new app.`
                : `  A bunker:// secret is single use, so a URI already spent on an earlier\n` +
                  `  connection cannot authorise a new one. Get a fresh URI from the signer.`));
        }
        die(`${what} failed: ${msg}`);
      }
    };
    const pubkey = await ask("get_public_key", () => signer.getPublicKey());
    rememberClientKey(bp.pubkey, Buffer.from(clientKey).toString("hex"), pubkey, bp.relays);
    return {
      pubkey,
      remote: true,
      sign: (t) => ask(`sign_event kind ${t.kind}`, () => signer.signEvent(t)),
      // For what a deploy can live without: a refusal throws rather than ending
      // the run, which by then has already published the site.
      trySign: (t) => withTimeout(signer.signEvent(t)),
      close: () => signer.close().catch(() => {}),
    };
  }
  if (!raw) {
    die("no key. Set NOSTR_BUNKER_URI=bunker://… for a remote signer (needed once: the connection\n" +
        `  is saved in ${BUNKER_FILE} and found again for the same key), or pass --sec=nsec1… /\n` +
        "  NOSTR_SECRET_KEY for a raw key.");
  }
  const s = String(raw).trim();
  if (s.startsWith("npub")) die("that is a public key; signing needs the nsec");
  const sec = s.startsWith("nsec") ? nip19.decode(s).data : Uint8Array.from(Buffer.from(s, "hex"));
  if (sec.length !== 32) die("secret key must be an nsec or 64 hex characters");
  const sign = async (t) => finalizeEvent(t, sec);
  return { pubkey: getPublicKey(sec), sign, trySign: sign, close: () => {} };
}

// ------------------------------------------------------------------ blossom

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Blossom is content addressed, so a blob whose bytes have not changed is
// already there under the same name. Asking first turns a weekly republish of an
// unchanged site into a handful of HEAD requests instead of a full re-upload,
// and it saves a signature per blob, which for a remote signer is a prompt.
// fetch has no timeout of its own, so a server that accepts the connection and
// then says nothing hangs a deploy for as long as anyone is willing to watch it.
const TIMEOUTS = { head: 20000, put: 120000, sign: 180000 };
const until = (ms) => ({ signal: AbortSignal.timeout(ms) });
const why = (err, ms) =>
  err?.name === "TimeoutError" ? `no answer in ${Math.round(ms / 1000)}s` : err?.message || String(err);

async function served(server, hash) {
  const url = `${server.replace(/\/+$/, "")}/${hash}`;
  try {
    let res = await fetch(url, { method: "HEAD", ...until(TIMEOUTS.head) });
    // Not every server implements HEAD. Fall back to asking for one byte.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { headers: { Range: "bytes=0-0" }, ...until(TIMEOUTS.head) });
    }
    return res.ok || res.status === 206;
  } catch { return false; }
}

async function upload(server, bytes, type, signer) {
  const hash = bytesToHex(sha256(bytes));
  let last;
  // One signature, both encodings. BUD-11 specifies base64url without padding
  // and part of the deployed fleet only accepts padded standard base64, but the
  // signed event is the same either way -- signing inside the loop asked a remote
  // signer to approve the same upload twice.
  const ev = await signer.sign({
    kind: 24242, created_at: Math.floor(Date.now() / 1000),
    tags: [["t", "upload"], ["expiration", String(Math.floor(Date.now() / 1000) + 600)], ["x", hash]],
    content: "Upload site file",
  });
  const raw = Buffer.from(JSON.stringify(ev));
  for (const urlsafe of [true, false]) {
    try {
      const auth = "Nostr " + (urlsafe ? b64url(raw) : raw.toString("base64"));
      const res = await fetch(`${server.replace(/\/+$/, "")}/upload`, {
        method: "PUT", headers: { Authorization: auth, "Content-Type": type }, body: bytes,
        ...until(TIMEOUTS.put),
      });
      if (res.ok) return hash;
      last = `${res.status} ${res.headers.get("x-reason") || (await res.text().catch(() => ""))}`.trim();
      if (![400, 401].includes(res.status)) break;
    } catch (e) {
      last = why(e, TIMEOUTS.put);
      // A server that has stopped answering will not answer the other encoding
      // either, and a second full timeout is two more minutes of nothing.
      if (e?.name === "TimeoutError") break;
    }
  }
  throw new Error(`${server}: ${last}`);
}

// ------------------------------------------------------------------ walking

// Files that are never part of a static page, and that a published site can
// never take back: a blob is content-addressed and the manifest naming it is
// signed and public. A dotfile is already skipped below, which covers .env and
// .ssh, but the same secret under a name the shell does not hide is not:
// admin.macaroon, id_rsa, server.pem, env.backup all publish otherwise.
//
// Two rules, because they fail differently. An extension like .pem or .macaroon
// is never a web asset, so it is refused whatever it is called. A name that
// merely mentions env or nsec is refused only when it is not a web asset
// either: what-is-nsec.html and app.env.js are pages, and refusing a page is a
// worse surprise than any rename. --publish-secrets overrides both.
const SECRET_EXT = /\.(pem|key|p12|pfx|macaroon|ppk)$/i;
const SECRET_NAME = /(^|\.)(env|envrc)(\.|$)|^id_(rsa|dsa|ecdsa|ed25519)$|^\.?npmrc$|(^|[-_.])nsec([-_.]|$)/i;
const WEB_ASSET = /\.(html?|css|m?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|ogg|wav)$/i;
const looksSecret = (name) => SECRET_EXT.test(name) || (SECRET_NAME.test(name) && !WEB_ASSET.test(name));

// .nsiteignore, in gitignore syntax, and --exclude=<glob>, which may be given
// more than once or as a comma-separated list. The last rule that matches
// decides, so a later !pattern brings a file back. A pattern with a slash
// anywhere but its end is anchored to the directory being published; one
// without matches a name at any depth. A trailing slash matches directories
// only, and a directory left out takes everything under it along.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) { re += "\\["; continue; }
      re += "[" + glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return re;
}

function ignoreRules(lines) {
  const rules = [];
  for (let line of lines) {
    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    if (!line) continue;
    rules.push({ negate, dirOnly, anchored, re: new RegExp("^" + globToRegExp(line) + "$") });
  }
  return rules;
}

function ignored(rules, rel, isDir) {
  let out = false;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(r.anchored ? rel : name)) out = !r.negate;
  }
  return out;
}

function walk(base, { rules = [], publishSecrets = false } = {}, cur = base, found = { files: [], secrets: [], ignored: [] }) {
  for (const name of readdirSync(cur).sort()) {
    if (name.startsWith(".")) continue;
    const p = join(cur, name);
    const rel = relative(base, p).split("\\").join("/");
    const isDir = statSync(p).isDirectory();
    if (ignored(rules, rel, isDir)) { found.ignored.push(isDir ? rel + "/" : rel); continue; }
    if (isDir) { walk(base, { rules, publishSecrets }, p, found); continue; }
    if (!publishSecrets && looksSecret(name)) { found.secrets.push(rel); continue; }
    found.files.push(p);
  }
  return found;
}

// What a deploy of `dir` publishes, saying out loud what it leaves behind.
function selectFiles(dir) {
  const file = join(dir, ".nsiteignore");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  // Every --exclude counts, not only the last one the flag table kept.
  for (const a of argv) if (a.startsWith("--exclude=")) lines.push(...a.slice(10).split(",").map((s) => s.trim()));
  const found = walk(dir, { rules: ignoreRules(lines), publishSecrets: !!flags["publish-secrets"] });
  if (found.ignored.length) {
    console.log(`Leaving out ${found.ignored.length} matched by .nsiteignore or --exclude:`);
    for (const s of found.ignored) console.log(`  ${s}`);
  }
  if (found.secrets.length) {
    console.log(`Not publishing ${found.secrets.length} file(s) that look like secrets:`);
    for (const s of found.secrets) console.log(`  ${s}`);
    console.log(`Pass --publish-secrets to publish them anyway.`);
  }
  if (!found.files.length) die(`${dir} has nothing to publish`);
  return found.files;
}

// NIP-5A aggregate hash: sha256 over sorted "<hash> <path>\n" lines, path tags
// only, order-independent. It identifies a site version.
const aggregate = (paths) => bytesToHex(sha256(Buffer.from(
  Object.entries(paths).map(([p, h]) => `${h} ${p}\n`).sort().join(""))));

// --------------------------------------------------------------------- init

function templates() {
  try { return readdirSync(join(PKG, "templates")).filter((n) => !n.startsWith("_")).sort(); }
  catch { return []; }
}

function cmdInit() {
  const dir = positional[0] || "site";
  if (existsSync(join(dir, "index.html"))) die(`${dir}/index.html already exists`);

  // A template is a starting point, not a blank page. Everything ships with the
  // chrome wired up and the edit gate on.
  const name = flags.template ? String(flags.template) : null;
  if (name && !templates().includes(name)) {
    die(`no template called "${name}". Available: ${templates().join(", ") || "none built yet"}`);
  }
  mkdirSync(dir, { recursive: true });

  let owner = flags.npub;
  let generated = null;
  if (!owner) {
    const sec = generateSecretKey();
    owner = nip19.npubEncode(getPublicKey(sec));
    generated = nip19.nsecEncode(sec);
  }

  const source = name
    ? join(PKG, "templates", name, "index.html")
    : join(PKG, "examples", "notes.html");
  const tpl = readFileSync(source, "utf8")
    .replace(/nc:owner="[^"]*"/, `nc:owner="${owner}"`)
    .replace(/nc:site="[^"]*"\n\s*/, "");           // a fresh site is a root site
  writeFileSync(join(dir, "index.html"), tpl);
  copyFileSync(join(PKG, "dist", "nsite-clay.js"), join(dir, "nsite-clay.js"));
  // The serialiser that keeps the author's formatting on save. Templates name it
  // in nc:source, and a page without it falls back to reprinting the file.
  if (existsSync(join(PKG, "dist", "nsite-clay-source.js"))) {
    copyFileSync(join(PKG, "dist", "nsite-clay-source.js"), join(dir, "nsite-clay-source.js"));
  }

  // Templates link these from the root rather than carrying copies, so one
  // upgrade fixes every page built from them.
  const shared = join(PKG, "templates", "_shared");
  for (const f of ["nsite-clay-base.css", "nsite-clay-chrome.js"]) {
    if (existsSync(join(shared, f))) copyFileSync(join(shared, f), join(dir, f));
  }
  // A template may bring its own assets.
  if (name) {
    for (const f of readdirSync(join(PKG, "templates", name))) {
      if (f === "index.html" || f.startsWith(".")) continue;
      const from = join(PKG, "templates", name, f);
      if (statSync(from).isFile()) copyFileSync(from, join(dir, f));
    }
  }

  console.log(`Created ${dir}/ from the ${name || "default"} template`);
  console.log(`Owner: ${owner}`);
  if (generated) {
    console.log(`\nThis key was generated for you. It is the only thing that can publish`);
    console.log(`this site, and it is not stored anywhere. Save it now:\n`);
    console.log(`  ${generated}\n`);
  }
  console.log(`Publish it with:\n  nsite-clay deploy ${dir} --sec=nsec1…`);
  console.log(`Then edit it in the browser at your page's address with #edit on the end.`);
}

// ------------------------------------------------------------------- shared

// What `pull` leaves beside the files it wrote. A dotfile, so it is never
// published. `deploy` reads it to publish back to the same site, relays and
// servers, and to tell a page edited here from a page somebody changed in the
// browser while the directory was away.
const RECORD = ".nsite-clay.json";

function readRecord(dir) {
  try {
    const r = JSON.parse(readFileSync(join(dir, RECORD), "utf8"));
    return r && /^[0-9a-f]{64}$/.test(r.pubkey || "") ? r : null;
  } catch { return null; }
}

function writeRecord(dir, rec) {
  writeFileSync(join(dir, RECORD), JSON.stringify(rec, null, 2) + "\n");
}

const isHtmlPath = (p) => /\.html?$/i.test(p);
const hashOf = (bytes) => bytesToHex(sha256(bytes));
const base36 = (pub) => BigInt("0x" + pub).toString(36).padStart(50, "0");
const siteUrl = (pub, site) => site
  ? `https://${base36(pub)}${site}.nsite.lol/`
  : `https://${nip19.npubEncode(pub)}.nsite.lol/`;
const words = (v) => (typeof v === "string" && v.trim() ? v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : null);

function hexKey(input) {
  const s = String(input || "").trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  try {
    const { type, data } = nip19.decode(s);
    if (type === "npub") return data;
    if (type === "nprofile") return data.pubkey;
  } catch { /* not a key */ }
  return null;
}

// npub1…, hex, nprofile1…, or an address a gateway serves: the npub as the
// first label, or the 50-character base36 key followed by a site name, or the
// ?npub= a local gateway takes.
function parseSiteAddress(input) {
  let s = String(input).trim();
  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return null; }
    s = u.searchParams.get("npub") || u.searchParams.get("site") || u.hostname.split(".")[0];
  }
  const key = hexKey(s);
  if (key) return { pubkey: key, site: "" };
  const m = /^([0-9a-z]{50})([a-z0-9-]{1,13})?$/.exec(s.toLowerCase());
  if (m) {
    const n = [...m[1]].reduce((acc, c) => acc * 36n + BigInt(parseInt(c, 36)), 0n);
    if (n < 2n ** 256n) return { pubkey: n.toString(16).padStart(64, "0"), site: m[2] || "" };
  }
  return null;
}

function manifestFilter(pub, site) {
  return site ? { kinds: [35128], authors: [pub], "#d": [site] } : { kinds: [15128], authors: [pub] };
}

// Every relay asked, the newest answer kept. Relays disagree, and the first to
// answer is not necessarily the one with the latest version.
async function newestManifest(pool, relays, pub, site) {
  const found = await pool.querySync(relays, manifestFilter(pub, site), { maxWait: QUERY_WAIT }).catch(() => []);
  return found.filter((e) => e.pubkey === pub && verifyEvent(e))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0] || null;
}

// Fetch a blob from whichever server has it, and believe it only if it hashes
// to the name it was asked for.
async function fetchBlob(servers, hash) {
  const errors = [];
  for (const s of servers) {
    try {
      const res = await fetch(`${norm(s)}/${hash}`, until(TIMEOUTS.put));
      if (!res.ok) { errors.push(`${s}: ${res.status}`); continue; }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (hashOf(bytes) !== hash) { errors.push(`${s}: served bytes that do not match the hash`); continue; }
      return bytes;
    } catch (e) { errors.push(`${s}: ${why(e, TIMEOUTS.put)}`); }
  }
  throw new Error(errors.join("; ") || "no servers to ask");
}

// The attributes on <html>, which is where an nsite-clay document keeps its
// configuration.
function rootAttrs(text) {
  const tag = /<html\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const attrs = {};
  for (const m of tag.slice(5).matchAll(/([^\s=<>"'\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

// The two files a page cannot edit itself without, under whatever content
// stamps the CLI and the publisher put on their names.
const ENGINE = new Set(["/nsite-clay.js", "/nsite-clay-chrome.js"]);
const unstamp = (p) => { const m = /^(.*?)((?:-[0-9a-f]{8})*)(\.[a-z]+)$/.exec(p); return m ? m[1] + m[3] : p; };
const engineRefs = (text) => [...text.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']?(\/[^"'\s>]+)/gi)]
  .map((m) => m[1].split(/[?#]/)[0]).filter((p) => !p.startsWith("//") && ENGINE.has(unstamp(p)));

// What would make a published page misbehave in the browser, found before any
// key is asked for. A page that reports the wrong nc:path compares itself with
// somebody else's bytes and reloads forever, or overwrites a sibling when it is
// saved; one that names another site or owner saves somewhere else or not at
// all. None of that shows until somebody opens the page.
function checkDocuments(files, contents, pathOf, site) {
  const problems = [], warnings = [], owners = [];
  for (const f of files) {
    const p = pathOf(f);
    if (!isHtmlPath(p)) continue;
    const text = contents.get(f).toString("utf8");
    const a = rootAttrs(text);
    if (!a || !("nc:owner" in a)) continue;            // a plain page, not an nsite-clay document
    const owner = hexKey(a["nc:owner"]);
    if (!owner) problems.push(`${p}: nc:owner="${a["nc:owner"]}" is not an npub or a hex key`);
    else owners.push([p, owner]);
    const said = (a["nc:path"] || "").trim() || "/index.html";
    if (said !== p) {
      problems.push(`${p}: says nc:path="${said}" but lives at ${p}. Set nc:path="${p}". ` +
        `Every page needs its own, or saving it in the browser overwrites ${said} and the page reloads in a loop.`);
    }
    const named = (a["nc:site"] || "").trim();
    if (named !== site) {
      problems.push(`${p}: says ${named ? `nc:site="${named}"` : "it belongs to the root site"}, but this deploy publishes ` +
        `${site ? `the named site "${site}"` : "the root site"}. Saving it in the browser would write somewhere else.`);
    }
    if (!engineRefs(text).some((r) => unstamp(r) === "/nsite-clay.js")) {
      warnings.push(`${p} has nc:owner but loads no /nsite-clay.js, so it cannot be edited in the browser`);
    }
  }
  const owner = owners.find(([p]) => p === "/index.html")?.[1] || owners[0]?.[1] || null;
  return { problems, warnings, owners, owner };
}

// ------------------------------------------------------------------- deploy

async function cmdDeploy() {
  const dir = positional[0];
  if (!dir) die("usage: nsite-clay deploy <dir> [--site=name]   (sign with NOSTR_BUNKER_URI, a saved connection, or --sec)");
  if (!existsSync(dir)) die(`no such directory: ${dir}`);
  const record = readRecord(dir);
  if (record && typeof flags.site === "string" && flags.site !== (record.site || "")) {
    die(`${dir} was pulled from ${record.site ? `the site "${record.site}"` : "the root site"}, and --site=${flags.site} ` +
        `would publish it somewhere else. Leave --site out, or pull that site into a directory of its own.`);
  }
  const site = typeof flags.site === "string" ? flags.site : (record?.site || "");
  if (flags.site === true || (site && (!/^[a-z0-9-]{1,13}$/.test(site) || site.endsWith("-")))) {
    die("--site must be 1-13 characters of [a-z0-9-] and must not end with a dash");
  }
  // A pulled directory knows where its site lives, which is where the browser
  // saves it. Publishing it to the CLI's public defaults instead would put a
  // version on relays the page never reads.
  if (record) {
    if (!relaysPinned && record.relays?.length) RELAYS = record.relays;
    if (!serversPinned && record.servers?.length) SERVERS = record.servers;
  }

  // Chosen before the signer is asked for anything, so what is being left out
  // is on screen before a bunker prompt, and --dry-run needs no key at all.
  const files = selectFiles(dir);
  const pathOf = (f) => "/" + relative(dir, f).split("\\").join("/");
  const isHtml = (f) => /\.html?$/i.test(f);
  const contents = new Map(files.map((f) => [f, readFileSync(f)]));
  const docs = checkDocuments(files, contents, pathOf, site);
  for (const w of docs.warnings) console.log(`  note: ${w}`);
  if (flags["dry-run"]) {
    if (docs.problems.length) console.log(`Would refuse to publish:\n  ${docs.problems.join("\n  ")}`);
    console.log(`Would publish ${files.length} file(s)${record ? `, to ${record.site ? `the site "${record.site}"` : "the root site"} of ${record.owner}` : ""}:`);
    for (const f of files) console.log(`  ${pathOf(f)}`);
    return;
  }
  const noCheck = !!flags["no-check"];
  if (docs.problems.length && !noCheck) {
    die(`refusing to publish:\n  ${docs.problems.join("\n  ")}\n  Fix the pages, or pass --no-check to publish them as they are.`);
  }

  const signer = await getSigner({ owner: record?.pubkey || docs.owner });
  const pub = signer.pubkey;
  const quit = async (msg) => { await signer.close(); die(msg); };
  if (record && pub !== record.pubkey && !noCheck) {
    await quit(`${dir} was pulled from ${record.owner}, but the signer holds ${nip19.npubEncode(pub)}.\n` +
      `  Only the owner's key can publish that site. Connect the owner's signer.`);
  }
  const strangers = docs.owners.filter(([, o]) => o !== pub);
  if (strangers.length && !noCheck) {
    await quit(`these pages name another owner than the signer (${nip19.npubEncode(pub)}):\n  ` +
      strangers.map(([p, o]) => `${p}: nc:owner is ${nip19.npubEncode(o)}`).join("\n  ") +
      `\n  A page can only be saved in the browser by the key in its nc:owner. Fix nc:owner, or sign with that key.`);
  }

  // The site as it is now. A manifest is the whole path table, so whatever is
  // published and not in this directory would be taken down by this deploy.
  const pool = new SimplePool();
  const live = await newestManifest(pool, RELAYS, pub, site);
  const livePaths = live ? pathsOf(live) : {};
  const local = new Set(files.map(pathOf));
  const carried = {};

  if (record) {
    // Three versions of every path: as pulled, as here, as published now. A
    // path only one side changed takes that side; a path both changed is a
    // conflict, and nobody's work is thrown away without being asked.
    const pulled = record.paths || {};
    const conflicts = [], fromBrowser = [];
    for (const f of files) {
      const p = pathOf(f), was = pulled[p], now = livePaths[p];
      if (!was || !now || now === was) continue;
      const mine = hashOf(contents.get(f));
      if (mine === now) continue;
      if (mine === was) fromBrowser.push([f, p, now]);
      else conflicts.push(p);
    }
    for (const [p, h] of Object.entries(livePaths)) {
      if (local.has(p)) continue;
      // Added after the pull, or a path a directory cannot hold (a dotfile is
      // never published from one): someone else's, and kept as it is.
      if (!(p in pulled) || p.split("/").some((seg) => seg.startsWith("."))) carried[p] = h;
      else if (pulled[p] !== h) conflicts.push(`${p} (deleted here, changed in the browser)`);
      // else it was deleted here on purpose, and stays out.
    }
    if (conflicts.length && !flags.overwrite) {
      await quit(`the published site changed after ${dir} was pulled, and so did these, here:\n  ` +
        conflicts.join("\n  ") +
        `\n  Somebody saved them in the browser meanwhile${live ? ` (latest at ${new Date(live.created_at * 1000).toISOString()})` : ""}.\n` +
        `  Pull the site again into a new directory, make the same change there, and deploy that.\n` +
        `  --overwrite publishes your copies anyway and throws the browser's changes to them away.`);
    }
    const from = [...new Set([...SERVERS, ...(live ? serversOf(live) : [])])];
    for (const [f, p, h] of fromBrowser) {
      let bytes;
      try { bytes = await fetchBlob(from, h); }
      catch (e) { await quit(`${p} was changed in the browser after the pull, and that version could not be fetched: ${e.message}`); }
      writeFileSync(f, bytes);
      contents.set(f, bytes);
      console.log(`  ${p}: changed in the browser after the pull and not here, so that version is kept (and written to ${dir})`);
    }
    // Written into the directory as well, or the next deploy from it would read
    // the path's absence as a deletion made here.
    for (const [p, h] of Object.entries(carried)) {
      const segs = p.split("/").slice(1);
      const to = resolve(dir, ...segs);
      if (segs.some((seg) => !seg || seg.startsWith(".")) || !to.startsWith(resolve(dir) + sep)) continue;
      try {
        const bytes = await fetchBlob(from, h);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, bytes);
        console.log(`  ${p}: added in the browser after the pull, kept as published (and written to ${dir})`);
      } catch (e) {
        await quit(`${p} was added to the site after the pull, and it could not be fetched to keep it: ${e.message}`);
      }
    }
  } else if (live) {
    const missing = Object.keys(livePaths).filter((p) => isHtmlPath(p) && !local.has(p)).sort();
    if (missing.length) {
      if (flags["keep-missing"]) {
        for (const p of missing) carried[p] = livePaths[p];
        console.log(`  keeping ${missing.length} published page${missing.length === 1 ? "" : "s"} this directory does not have (--keep-missing)`);
      } else if (!flags.prune) {
        await quit(`the published site has ${missing.length} page${missing.length === 1 ? "" : "s"} that ${dir} does not:\n  ` +
          missing.join("\n  ") +
          `\n  A deploy publishes the whole path table, so this one would take ${missing.length === 1 ? "it" : "them"} down.\n` +
          `  Pages made or saved in the browser live only on Blossom, not in this directory.\n` +
          `  "nsite-clay pull" downloads the whole site first. Or pass --keep-missing to keep\n` +
          `  ${missing.length === 1 ? "it" : "them"} as published, or --prune to take ${missing.length === 1 ? "it" : "them"} down.`);
      }
    }
  }

  const fingerprint = !flags["no-fingerprint"];
  const rename = new Map();

  // A published document hardcodes its asset URLs and gateways serve them with
  // a cache lifetime, so replacing a blob at the same path is invisible to a
  // browser that already holds one. Putting the content hash in the path makes
  // a new build a new URL, which no cache can satisfy from stock.
  if (fingerprint) {
    for (const f of files) {
      if (isHtml(f)) continue;                      // documents keep linkable paths
      const p = pathOf(f);
      const ext = extname(p);
      const stamp = hashOf(contents.get(f)).slice(0, 8);
      // A file that already wears its own hash, the way a pulled site's assets
      // do, is left alone. Stamping it again gave /app-1a2b3c4d-1a2b3c4d.js and
      // a page that pointed at neither.
      if (p.endsWith(`-${stamp}${ext}`)) continue;
      rename.set(p, `${p.slice(0, p.length - ext.length)}-${stamp}${ext}`);
    }
    const rules = [...rename].sort((a, b) => b[0].length - a[0].length);  // longest first
    for (const f of files) {
      if (!isHtml(f)) continue;
      let text = contents.get(f).toString("utf8");
      // Only where a path is a path. A blind replace across the whole file also
      // rewrote the words a reader sees, so a button labelled "llms.txt" came
      // out as "llms-fab02d05.txt", and a code sample teaching somebody to write
      // <script src="/nsite-clay.js"> published the hashed name, which is wrong
      // for every site but this one.
      //
      // Tags carry the attributes, and script and style bodies can carry a URL
      // too. Everything between tags is what the reader actually reads, and it
      // is left exactly as written.
      const rewrite = (chunk) => {
        for (const [from, to] of rules) {
          chunk = chunk.split(from).join(to).split(from.slice(1)).join(to.slice(1));
        }
        return chunk;
      };
      text = text.replace(
        /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\2\s*>|<[^>]+>/gi,
        (m) => (m.startsWith("<!--") ? m : rewrite(m)));
      contents.set(f, Buffer.from(text, "utf8"));
    }
  }

  // The one hole a browser cannot repair: a page whose engine is not in the
  // table cannot load the editor that would put it back.
  const planned = new Set([...Object.keys(carried), ...files.flatMap((f) => [pathOf(f), rename.get(pathOf(f)) || pathOf(f)])]);
  const holes = files.filter(isHtml).flatMap((f) => engineRefs(contents.get(f).toString("utf8"))
    .filter((r) => !planned.has(r)).map((r) => `${pathOf(f)} loads ${r}`));
  if (holes.length && !noCheck) {
    await quit(`these pages load a runtime file that would not be published:\n  ${[...new Set(holes)].join("\n  ")}\n` +
      `  They would stop being editable, and no browser could put that back. Keep the file in\n` +
      `  the directory (a pulled site has it), or point the page at /nsite-clay.js and /nsite-clay-chrome.js.`);
  }

  const paths = { ...carried };
  let uploads = 0;
  for (const f of files) {
    const bytes = contents.get(f);
    const path = rename.get(pathOf(f)) || pathOf(f);
    const type = TYPES[extname(f).toLowerCase()] || "application/octet-stream";
    const hash = hashOf(bytes);

    // Who has it already, and who needs a copy. A server that dropped a blob
    // gets it back, which is what makes a repeat deploy a repair rather than a
    // no-op, but a server that still has it is left alone.
    const already = await Promise.all(SERVERS.map((s) => served(s, hash)));
    const missing = SERVERS.filter((_, i) => !already[i]);
    const held = already.filter(Boolean).length;

    let sent = 0;
    if (missing.length) {
      const results = await Promise.allSettled(missing.map((s) => upload(s, bytes, type, signer)));
      sent = results.filter((r) => r.status === "fulfilled").length;
      if (!held && !sent) {
        await quit(`${path} is on no server and was refused by every one of them:\n  ` +
          results.map((r) => r.reason?.message).join("\n  "));
      }
      uploads += sent;
    }

    // A pulled site holds both nsite-clay.js and the stamped copy it became, so
    // the two arrive at the same path with the same bytes. Say it once.
    const repeat = paths[path] === hash;
    paths[path] = hash;
    // The unfingerprinted path stays in the manifest pointing at the same blob.
    // Nothing new links to it, but a reader still holding a cached copy of the
    // previous document does, and it costs one tag.
    const original = pathOf(f);
    if (path !== original) paths[original] = hash;
    const note = missing.length ? `${held + sent}/${SERVERS.length}  ${sent} uploaded` : `${held}/${SERVERS.length}  already there`;
    if (!repeat) console.log(`  ${path.padEnd(34)} ${hash.slice(0, 12)}…  ${String(bytes.length).padStart(8)} B  ${note}`);
  }

  const agg = aggregate(paths);
  const tags = [
    ...(site ? [["d", site]] : []),
    ...Object.entries(paths).map(([p, h]) => ["path", p, h]),
    ["x", agg, "aggregate"],
    ...SERVERS.map((s) => ["server", s]),
    ...(flags.title ? [["title", String(flags.title)]] : []),
    ...(flags.description ? [["description", String(flags.description)]] : []),
    ...(flags.source ? [["source", String(flags.source)]] : []),
  ];
  const kind = site ? 35128 : 15128;
  const remember = (ev) => {
    if (!record) return;
    writeRecord(dir, { ...record, relays: RELAYS, servers: SERVERS,
      manifest: { id: ev.id, created_at: ev.created_at }, paths: pathsOf(ev), deployed: new Date().toISOString() });
  };

  // A weekly job that restores an unchanged site should cost nothing. The blobs
  // are content addressed and were checked above, so if the path table still
  // hashes to what the live manifest says, there is nothing to tell anybody: a
  // fresh manifest would carry the same table under a newer timestamp, and the
  // snapshot beside it would file a version identical to the last one.
  if (!flags.force) {
    const liveAgg = live?.tags.find((t) => t[0] === "x" && t[2] === "aggregate")?.[1];
    if (live && (liveAgg === agg || aggregate(livePaths) === agg)) {
      console.log(`\n  unchanged: the published manifest already points at these ${Object.keys(paths).length} paths`);
      if (uploads) console.log(`  ${uploads} blob${uploads === 1 ? "" : "s"} were put back on a server that had dropped them`);
      console.log(`  nothing published. --force republishes anyway.\n`);
      remember(live);
      pool.close(RELAYS);
      await signer.close();
      return;
    }
  }

  // Newer than what is live by at least a second, or a relay keeps the old one.
  const now = Math.max(Math.floor(Date.now() / 1000), (live?.created_at ?? 0) + 1);
  const manifest = await signer.sign({ kind, created_at: now, tags, content: "" });
  const snap = await signer.sign({
    kind: 5128, created_at: now, content: "",
    tags: [["a", `${kind}:${pub}:${site}`], ...tags.filter((t) => t[0] !== "d")],
  });

  const sent = await Promise.allSettled(pool.publish(RELAYS, manifest));
  const accepted = sent.filter((r) => r.status === "fulfilled").length;
  if (!accepted) await quit("no relay accepted the manifest:\n  " +
    sent.map((r, i) => `${RELAYS[i]}: ${r.reason?.message || r.reason}`).join("\n  "));
  await Promise.allSettled(pool.publish(RELAYS, snap));
  remember(manifest);

  // Most gateways find a site through its owner's relay list, and a fresh key
  // has none. Written only when it provably has none; see src/relay-list.js.
  if (!flags["no-relay-list"]) {
    const state = await ensureRelayList(pool, { sign: signer.trySign }, pub, RELAYS);
    console.log({
      written: "\n  relay list published for this key, so gateways that look one up can find the site",
      present: "",
      unknown: "\n  could not ask purplepag.es and user.kindpag.es whether this key has a relay list, so none was written",
      empty: "",
      failed: "\n  no relay accepted the relay list for this key; gateways other than nsite.lol may not find the site",
    }[state] || "");
  }
  pool.close([...RELAYS, ...LOOKUP_RELAYS]);
  await signer.close();

  // Blossom servers are told where the blobs are; without this a gateway that
  // has no `server` hint and no kind-10063 for the author answers 404.
  const url = siteUrl(pub, site);
  console.log(`\n  manifest  kind ${kind}  ${manifest.id}`);
  console.log(`  aggregate ${agg}`);
  console.log(`  version   v${BigInt("0x" + snap.id).toString(36).padStart(50, "0")}.nsite.lol`);
  console.log(`  relays    ${accepted}/${RELAYS.length} accepted`);
  console.log(`\n  ${url}`);
  console.log(`  ${url}#edit   to edit it in the browser\n`);
}

// --------------------------------------------------------------------- pull

// The way back from a published site to a directory: the newest manifest, every
// blob it names, each one checked against its hash, written where its path
// says. Pages made or saved in the browser exist nowhere else, so this is what
// has to happen before a directory can be deployed over a site that has been
// edited in place.
async function cmdPull() {
  const target = positional[0];
  if (!target) die("usage: nsite-clay pull <npub | site address> [dir] [--site=name]");
  const addr = parseSiteAddress(target);
  if (!addr) die(`cannot read a key out of "${target}". Give an npub, a hex key, or the site's address.`);
  const site = typeof flags.site === "string" ? flags.site : addr.site;
  const pub = addr.pubkey;
  const dir = positional[1] || "site";
  if (existsSync(dir) && readdirSync(dir).length && !flags.overwrite) {
    die(`${dir} is not empty. Pull into a new directory, or pass --overwrite to write over what is there.`);
  }

  const pool = new SimplePool();
  let relays = RELAYS.map(norm);
  if (!relaysPinned) {
    // The owner's own relay list says where else to look.
    const lists = await pool.querySync([...new Set([...relays, ...LOOKUP_RELAYS])],
      { kinds: [10002], authors: [pub] }, { maxWait: QUERY_WAIT }).catch(() => []);
    const own = lists.filter((e) => e.pubkey === pub).sort((a, b) => b.created_at - a.created_at)[0];
    const more = (own?.tags || []).filter((t) => t[0] === "r" && /^wss?:\/\//.test(t[1] || "") && t[2] !== "read").map((t) => norm(t[1]));
    relays = [...new Set([...relays, ...more])];
  }
  process.stderr.write(`looking for the manifest on ${relays.length} relay${relays.length === 1 ? "" : "s"}…\n`);
  const live = await newestManifest(pool, relays, pub, site);
  if (!live) {
    pool.close(relays);
    die(`no relay asked has ${site ? `a site called "${site}"` : "a root site"} for ${nip19.npubEncode(pub)}.\n` +
        `  Relays asked: ${relays.join(", ")}\n  Is --site right, or does the site live on other relays (--relays=…)?`);
  }
  let servers = SERVERS.map(norm);
  if (!serversPinned) {
    const lists = await pool.querySync(relays, { kinds: [10063], authors: [pub] }, { maxWait: QUERY_WAIT }).catch(() => []);
    const own = lists.filter((e) => e.pubkey === pub).sort((a, b) => b.created_at - a.created_at)[0];
    const theirs = (own?.tags || []).filter((t) => t[0] === "server" && /^https?:\/\//.test(t[1] || "")).map((t) => t[1]);
    servers = [...new Set([...serversOf(live), ...theirs, ...SERVERS].map(norm))];
  }
  pool.close(relays);

  const paths = pathsOf(live);
  mkdirSync(dir, { recursive: true });
  const root = resolve(dir);
  const got = new Map();
  const failed = [];
  for (const [p, h] of Object.entries(paths).sort()) {
    const segs = p.split("/").slice(1);
    const to = resolve(root, ...segs);
    if (!p.startsWith("/") || p.endsWith("/") || /[\0\\]/.test(p) || segs.some((s) => !s || s === "." || s === "..") ||
        !to.startsWith(root + sep)) {
      console.log(`  ${p}: not a path that can be written as a file, left out`);
      continue;
    }
    let bytes = got.get(h);
    if (!bytes) {
      try { bytes = await fetchBlob(servers, h); got.set(h, bytes); }
      catch (e) { failed.push(`${p}: ${e.message}`); continue; }
    }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes);
    console.log(`  ${p.padEnd(40)} ${h.slice(0, 12)}…  ${String(bytes.length).padStart(8)} B`);
  }
  if (failed.length) {
    die(`could not download ${failed.length} of ${Object.keys(paths).length} files:\n  ${failed.join("\n  ")}\n` +
        `  Servers asked: ${servers.join(", ")}\n` +
        `  The directory is incomplete, so no pull record was written and deploy will not treat it as\n` +
        `  the whole site. Try again, or name the servers that hold them with --servers=…`);
  }

  // Where the browser saves this site, which is where a deploy should go too.
  const index = paths["/index.html"] ? join(dir, "index.html")
    : (Object.keys(paths).filter(isHtmlPath).sort().map((p) => join(dir, ...p.split("/").slice(1)))[0]);
  const attrs = index && existsSync(index) ? rootAttrs(readFileSync(index, "utf8")) : null;
  const record = {
    about: "Written by nsite-clay pull. deploy reads it to publish this directory back to the same site. It is a dotfile, so it is never published.",
    owner: nip19.npubEncode(pub), pubkey: pub, site, kind: live.kind,
    relays: relaysPinned ? RELAYS : (words(attrs?.["nc:relays"]) || DEFAULT_RELAYS),
    servers: serversPinned ? SERVERS : (words(attrs?.["nc:servers"]) || servers),
    manifest: { id: live.id, created_at: live.created_at },
    paths,
    pulled: new Date().toISOString(),
  };
  writeRecord(dir, record);

  const pages = Object.keys(paths).filter(isHtmlPath).sort();
  console.log(`\n  ${Object.keys(paths).length} files from the version published ${new Date(live.created_at * 1000).toISOString()}`);
  console.log(`  pages     ${pages.join(", ") || "none"}`);
  console.log(`  site      ${siteUrl(pub, site)}`);
  console.log(`\n  Edit the files, then publish them back with:\n    nsite-clay deploy ${dir}`);
  console.log(`  It reads ${RECORD} for the site, relays and servers, and keeps anything changed in the browser meanwhile.\n`);
}

// ------------------------------------------------------------------- whoami

// Connect to the signer and say whose key it holds, signing nothing. The first
// connection spends the bunker:// secret and is saved, so this is the place to
// spend it: once, before any real work, with the answer on screen.
async function cmdWhoami() {
  const record = positional[0] ? readRecord(positional[0]) : null;
  const owner = record?.pubkey || hexKey(flags.npub) || null;
  const signer = await getSigner({ owner });
  console.log(nip19.npubEncode(signer.pubkey));
  if (signer.remote) console.log(`  connection saved in ${BUNKER_FILE}; later runs find it for this key without a link`);
  await signer.close();
  if (owner && owner !== signer.pubkey) die(`that is not ${nip19.npubEncode(owner)}, the owner of ${record ? positional[0] : "--npub"}`);
}

// ---------------------------------------------------------------- unpublish

// Nothing on Nostr can be deleted, only asked to be. A relay that implements
// NIP-09 drops the events a kind-5 names and refuses them if they come back; a
// relay that does not keeps them, and a copy nobody knows about is out of reach
// either way. So an unpublish is two things sent as widely as possible: the
// deletion request, and an empty manifest newer than the last one, which every
// relay honours whether or not it reads deletions, because a replaceable event
// replaces. Blossom is the same bargain: a server may delete, keep, or have been
// mirrored somewhere else.
//
// Wide means the relays a deploy writes to, the two a gateway looks a key up on,
// the owner's own relay list, and a set of large public relays that a gateway or
// an aggregator may have copied the manifest from.
const WIDE_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.snort.social",
  "wss://offchain.pub",
  "wss://nostr.bitcoiner.social",
  "wss://nostr.oxtr.dev",
  "wss://relay.nostr.net",
  "wss://nostr-pub.wellorder.net",
  "wss://relay.ditto.pub",
  "wss://nostr.land",
  "wss://nostr.wine",
];
const QUERY_WAIT = 8000;

// A version is named by its snapshot id, as hex, as a note1/nevent1, or as the
// v<base36> label of its own address, pasted bare or as the whole URL.
function snapshotId(input) {
  const s = String(input).trim().replace(/^https?:\/\//, "").split(/[./]/)[0].toLowerCase();
  if (/^[0-9a-f]{64}$/.test(s)) return s;
  if (/^(note|nevent)1/.test(s)) {
    try { const d = nip19.decode(s); return d.type === "note" ? d.data : d.data.id; } catch { return null; }
  }
  if (/^v[0-9a-z]{50}$/.test(s)) {
    const n = [...s.slice(1)].reduce((acc, c) => acc * 36n + BigInt("0123456789abcdefghijklmnopqrstuvwxyz".indexOf(c)), 0n);
    return n.toString(16).padStart(64, "0");
  }
  return null;
}

const pathsOf = (ev) => Object.fromEntries(ev.tags.filter((t) => t[0] === "path" && t[1] && t[2]).map((t) => [t[1], t[2]]));
const serversOf = (ev) => ev.tags.filter((t) => t[0] === "server" && /^https?:\/\//.test(t[1] || "")).map((t) => t[1]);
const norm = (url) => String(url).trim().replace(/\/+$/, "");

async function blossomDelete(server, hash, ev) {
  const raw = Buffer.from(JSON.stringify(ev));
  let last;
  for (const urlsafe of [true, false]) {
    try {
      const auth = "Nostr " + (urlsafe ? b64url(raw) : raw.toString("base64"));
      const res = await fetch(`${server.replace(/\/+$/, "")}/${hash}`, {
        method: "DELETE", headers: { Authorization: auth }, ...until(TIMEOUTS.put),
      });
      if (res.ok || res.status === 404) return res.ok ? "deleted" : "gone";
      last = `${res.status} ${res.headers.get("x-reason") || (await res.text().catch(() => ""))}`.trim().slice(0, 160);
      if (![400, 401].includes(res.status)) break;
    } catch (e) {
      last = why(e, TIMEOUTS.put);
      if (e?.name === "TimeoutError") break;
    }
  }
  throw new Error(last);
}

// Publish to every relay at once and say which took it. A relay that refuses a
// kind or never answers is expected on a list this long, and is not a failure.
async function broadcast(pool, relays, ev) {
  const sent = await Promise.allSettled(pool.publish(relays, ev, { maxWait: QUERY_WAIT }));
  return relays.filter((_, i) => sent[i].status === "fulfilled");
}

async function cmdUnpublish() {
  const site = flags.site ? String(flags.site) : "";
  const kind = site ? 35128 : 15128;
  const pagesToDrop = argv.filter((a) => a.startsWith("--path=")).flatMap((a) => a.slice(7).split(","))
    .map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith("/") ? p : "/" + p));
  const version = flags.version ? snapshotId(flags.version) : null;
  if (flags.version && !version) die("--version takes a snapshot id: hex, note1…, nevent1…, or the v… address of a version");
  if (version && pagesToDrop.length) die("--version and --path do different things; pass one of them");
  const go = !!flags.yes;

  // Reading needs only the public key, so a plan can be shown without the
  // signer. Sending anything needs the signer, and it has to be the owner.
  let signer = null, pub;
  if (flags.npub && !go) {
    try { pub = nip19.decode(String(flags.npub)).data; } catch { die("--npub is not an npub"); }
  } else {
    signer = await getSigner();
    pub = signer.pubkey;
    if (flags.npub && nip19.npubEncode(pub) !== String(flags.npub)) {
      await signer.close();
      die(`the signer holds ${nip19.npubEncode(pub)}, not ${flags.npub}; only a site's owner can unpublish it`);
    }
  }
  const coord = `${kind}:${pub}:${site}`;

  // --relays pins the list, which is what a devnet needs: nothing is looked up
  // or sent anywhere else. Otherwise the list starts wide and grows by whatever
  // relay list the owner has published.
  const pinned = typeof flags.relays === "string";
  let relays = [...new Set((pinned ? RELAYS : [...RELAYS, ...LOOKUP_RELAYS, ...WIDE_RELAYS]).map(norm))];
  const pool = new SimplePool();
  const seen = new Map();
  const filter = { kinds: [15128, 35128, 5128, 10002, 10063], authors: [pub] };
  const gather = async (urls) => {
    const found = await pool.querySync(urls, filter, { maxWait: QUERY_WAIT }).catch(() => []);
    for (const ev of found) if (ev.pubkey === pub) seen.set(ev.id, ev);
  };
  process.stderr.write(`asking ${relays.length} relays what they hold for this key…\n`);
  await gather(relays);
  const all = [...seen.values()];
  const newest = (k) => all.filter((e) => e.kind === k).sort((a, b) => b.created_at - a.created_at)[0];
  const own = newest(10002);
  if (own && !pinned) {
    const more = own.tags.filter((t) => t[0] === "r" && /^wss?:\/\//.test(t[1] || "")).map((t) => norm(t[1]))
      .filter((r) => !relays.includes(r));
    if (more.length) { relays.push(...more); await gather(more); }
  }

  const events = [...seen.values()];
  const dOf = (e) => e.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const isThis = (e) => e.kind === kind && (kind === 15128 || dOf(e) === site);
  const manifests = events.filter(isThis).sort((a, b) => b.created_at - a.created_at);
  const snapshots = events.filter((e) => e.kind === 5128 && e.tags.some((t) => t[0] === "a" && t[1] === coord))
    .sort((a, b) => b.created_at - a.created_at);
  const live = manifests[0];
  const label = site ? `the site "${site}"` : "the root site";

  const servers = [...new Set([
    ...SERVERS, ...[...manifests, ...snapshots].flatMap(serversOf),
    ...(pinned ? [] : (newest(10063)?.tags || []).filter((t) => t[0] === "server").map((t) => t[1])),
  ].filter((s) => /^https?:\/\//.test(s || "")).map(norm))];

  const finish = async () => { pool.close(relays); await signer?.close(); };
  const plan = (lines) => {
    console.log(lines.join("\n"));
    if (!go) {
      console.log(`\nNothing was sent. Run it again with --yes to do this.`);
      return false;
    }
    return true;
  };
  const caveat = () => console.log(
    `\nA deletion is a request. Relays that implement NIP-09 drop what it names; others keep it.\n` +
    `A gateway may serve a cached copy for a while, and anyone who saved a copy still has one.`);

  // ---- one page out of the site: a new version without it
  if (pagesToDrop.length) {
    if (!live) { await finish(); die(`no relay has a manifest for ${label}`); }
    const paths = pathsOf(live);
    const absent = pagesToDrop.filter((p) => !paths[p]);
    if (absent.length) {
      await finish();
      die(`${absent.join(", ")} not in ${label}. It has:\n  ${Object.keys(paths).sort().join("\n  ")}`);
    }
    for (const p of pagesToDrop) delete paths[p];
    if (!Object.keys(paths).length) { await finish(); die("that would leave the site empty; unpublish the whole site instead (no --path)"); }
    if (!plan([
      `Remove from ${label}:`, ...pagesToDrop.map((p) => `  ${p}`),
      `A new version is published without ${pagesToDrop.length === 1 ? "it" : "them"}, with the other ${Object.keys(paths).length} paths as they are.`,
      `Earlier versions in the history still hold ${pagesToDrop.length === 1 ? "it" : "them"}. Delete those with --version, or unpublish the whole site.`,
    ])) return finish();
    const now = Math.max(Math.floor(Date.now() / 1000), live.created_at + 1);
    const tags = [
      ...live.tags.filter((t) => t[0] === "d"),
      ...Object.entries(paths).map(([p, h]) => ["path", p, h]),
      ["x", aggregate(paths), "aggregate"],
      ...live.tags.filter((t) => ["server", "title", "description", "source"].includes(t[0])),
    ];
    const manifest = await signer.sign({ kind, created_at: now, tags, content: "" });
    const snap = await signer.sign({ kind: 5128, created_at: now, content: "", tags: [["a", coord], ...tags.filter((t) => t[0] !== "d")] });
    const took = await broadcast(pool, relays, manifest);
    await broadcast(pool, relays, snap);
    console.log(`\n  new manifest  ${manifest.id}  ${took.length}/${relays.length} relays accepted it`);
    await finish();
    if (!took.length) die("no relay accepted the new manifest");
    return;
  }

  // Every hash something else still points at, so a blob shared with a page that
  // stays up (another named site, the runtime every page links) is never asked
  // to go. `keep` is the set of events that are not being deleted.
  const protectedBy = (keep) => new Set(keep.flatMap((e) => Object.values(pathsOf(e))));

  // ---- one version out of the history
  if (version) {
    const snap = snapshots.find((e) => e.id === version) || events.find((e) => e.id === version && e.kind === 5128);
    if (!snap) { await finish(); die(`no relay asked has a version ${version.slice(0, 12)}… of ${label}. Is --site right?`); }
    const keep = events.filter((e) => e.id !== snap.id && (e.kind === 5128 || e.kind === 15128 || e.kind === 35128));
    const guarded = protectedBy(keep);
    const blobs = [...new Set(Object.values(pathsOf(snap)))].filter((h) => !guarded.has(h));
    const when = new Date(snap.created_at * 1000).toISOString().replace("T", " ").slice(0, 16);
    if (!plan([
      `Delete the version of ${label} from ${when} UTC (${snap.id.slice(0, 12)}…).`,
      `  ${Object.keys(pathsOf(snap)).length} paths; ${blobs.length} of their blobs are used by no other version and will be deleted${flags["keep-blobs"] ? " (not with --keep-blobs)" : ""}.`,
      `  the deletion goes to ${relays.length} relays, the blob deletes to ${servers.length} Blossom servers.`,
    ])) return finish();
    const del = await signer.sign({
      kind: 5, created_at: Math.floor(Date.now() / 1000), content: "Deleted version of an nsite",
      tags: [["e", snap.id], ["k", "5128"]],
    });
    const took = await broadcast(pool, relays, del);
    console.log(`\n  deletion  ${took.length}/${relays.length} relays accepted it`);
    if (!flags["keep-blobs"]) await deleteBlobs(blobs, servers, signer);
    caveat();
    return finish();
  }

  // ---- the whole site
  const others = events.filter((e) => (e.kind === 15128 || e.kind === 35128) ? !isThis(e)
    : e.kind === 5128 && !snapshots.includes(e));
  const guarded = protectedBy(others);
  const hashes = new Set([...manifests, ...snapshots].flatMap((e) => Object.values(pathsOf(e))));
  const blobs = [...hashes].filter((h) => !guarded.has(h));
  const shared = hashes.size - blobs.length;
  if (!live && !snapshots.length) { await finish(); die(`no relay asked has anything for ${label}. Is --site right?`); }
  if (!plan([
    `Unpublish ${label} of ${nip19.npubEncode(pub)}:`,
    `  ${live ? Object.keys(pathsOf(live)).length + " paths in the current version" : "no current manifest found, only history"}, ${snapshots.length} version${snapshots.length === 1 ? "" : "s"} in the history.`,
    `  an empty manifest replaces the current one, and a deletion request names all of it,`,
    `  on ${relays.length} relays.`,
    flags["keep-blobs"]
      ? `  blobs are left on the servers (--keep-blobs).`
      : `  ${blobs.length} blob${blobs.length === 1 ? "" : "s"} to delete from ${servers.length} Blossom server${servers.length === 1 ? "" : "s"}` +
        (shared ? `; ${shared} more are kept because another site or version of this key still uses them.` : "."),
    `  your relay list and your other sites are left alone.`,
  ])) return finish();

  // The empty manifest and the deletion share a timestamp. A relay that reads
  // deletions removes both; one that does not keeps the empty manifest, which is
  // newer than anything it held, so either way no gateway finds the old pages.
  const now = Math.max(Math.floor(Date.now() / 1000), (live?.created_at ?? 0) + 1);
  const tombstone = await signer.sign({ kind, created_at: now, content: "", tags: site ? [["d", site]] : [] });
  const took = await broadcast(pool, relays, tombstone);
  console.log(`\n  empty manifest  ${took.length}/${relays.length} relays accepted it`);

  // One deletion per few hundred ids: a relay caps the size of a message, and a
  // site with a long history can name more events than fit in one.
  const ids = [...manifests, ...snapshots].map((e) => e.id);
  const batches = [];
  for (let i = 0; i < Math.max(ids.length, 1); i += 300) batches.push(ids.slice(i, i + 300));
  let accepted = 0;
  for (const [i, batch] of batches.entries()) {
    const del = await signer.sign({
      kind: 5, created_at: now, content: "Unpublished nsite",
      tags: [...(i === 0 ? [["a", coord]] : []), ...batch.map((id) => ["e", id]), ["k", String(kind)], ["k", "5128"]],
    });
    accepted = Math.max(accepted, (await broadcast(pool, relays, del)).length);
  }
  console.log(`  deletion        ${accepted}/${relays.length} relays accepted it`);
  if (!flags["keep-blobs"]) await deleteBlobs(blobs, servers, signer);
  caveat();
  await finish();
  if (!took.length && !accepted) die("no relay accepted anything");
}

// Ask each server that still has a blob to drop it. One signature per blob,
// shared by every server, and none at all for a blob no server holds.
async function deleteBlobs(hashes, servers, signer) {
  let deleted = 0, gone = 0;
  const refused = [];
  for (const hash of hashes) {
    const holders = (await Promise.all(servers.map(async (s) => ((await served(s, hash)) ? s : null)))).filter(Boolean);
    if (!holders.length) { gone++; continue; }
    const ev = await signer.sign({
      kind: 24242, created_at: Math.floor(Date.now() / 1000), content: "Delete site file",
      tags: [["t", "delete"], ["expiration", String(Math.floor(Date.now() / 1000) + 600)], ["x", hash]],
    });
    const results = await Promise.allSettled(holders.map((s) => blossomDelete(s, hash, ev)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") deleted++;
      else refused.push(`${holders[i]} ${hash.slice(0, 12)}…: ${r.reason?.message || r.reason}`);
    });
  }
  console.log(`  blobs           ${deleted} deleted, ${gone} already on no server, ${refused.length} refused`);
  for (const r of refused.slice(0, 20)) console.log(`    ${r}`);
  if (refused.length > 20) console.log(`    and ${refused.length - 20} more`);
}

// ------------------------------------------------------------------- keygen

function cmdKeygen() {
  const sec = generateSecretKey();
  const pub = getPublicKey(sec);
  console.log(`nsec  ${nip19.nsecEncode(sec)}`);
  console.log(`npub  ${nip19.npubEncode(pub)}`);
  console.log(`site  https://${nip19.npubEncode(pub)}.nsite.lol/`);
}

// --------------------------------------------------------------------- help

function cmdHelp() {
  console.log(`nsite-clay: a single HTML file that edits and republishes itself

  nsite-clay init [dir]        scaffold a site (generates a key unless --npub is given)
                               --template=<name> to start from one of:
                               ${templates().join(", ") || "(none built yet)"}
  nsite-clay pull <site> [dir] download a published site into dir (default: site), every
                               file checked against its hash. <site> is an npub, a hex
                               key or the site's address. Writes dir/.nsite-clay.json, so
                               a deploy of dir goes back to the same site and keeps what
                               was changed in the browser meanwhile.
  nsite-clay deploy <dir>      publish a directory as an nsite. Blobs already on a
                               server are not uploaded again, and a site whose
                               path table has not changed is not republished.
                               --force publishes regardless.
  nsite-clay whoami [dir]      connect to the signer, print the key it holds, sign nothing.
                               The first use of a bunker:// link belongs here.
  nsite-clay unpublish         take a site down: an empty manifest and a deletion request
                               to every relay it can find, and its blobs deleted from the
                               Blossom servers. Shows what it would do; --yes does it.
  nsite-clay keygen            print a fresh keypair and the URL it would live at
  nsite-clay version           print this tool's version (also --version)

Signing
  NOSTR_BUNKER_URI=bunker://…            a remote signer (Amber, Clave, nsec.app). Needed once:
                                         the connection (client key, bunker pubkey, relays)
                                         is saved in ${BUNKER_FILE}
                                         and later runs find it by the site's owner key.
                                         --bunker=… also works but puts the secret in your
                                         process list.
  --sec=nsec1… | NOSTR_SECRET_KEY        a raw key
  --timeout=60                           seconds to wait for the signer to answer
  --fresh                                connect to the bunker as a new app, ignoring the
                                         client key saved for it

Pull options
  --site=name         a named site; an address that names one sets it already
  --relays=a,b,c      look only here (by default: the deploy relays, the lookup relays
                      and the owner's relay list)
  --servers=a,b       download only from these (by default: the manifest's servers, the
                      owner's server list, then the defaults)
  --overwrite         write into a directory that is not empty

Deploy options
  --site=name         publish as a named site (kind 35128) instead of the root site
  --title=…           --description=…   --source=<repo url>
  --relays=a,b,c      default: a pulled directory's own, else ${DEFAULT_RELAYS.join(",")}
  --servers=a,b       default: a pulled directory's own, else ${DEFAULT_SERVERS.join(",")}
  --no-fingerprint    do not put content hashes in asset paths
  --exclude=<glob>    leave matching files out; repeat it or separate with commas.
                      A .nsiteignore file in the directory (gitignore syntax)
                      does the same. Dotfiles are never published.
  --publish-secrets   publish files that look like keys (*.pem, id_rsa, env.backup…),
                      which are otherwise refused
  --dry-run           list what would be published and stop; needs no key
  --no-relay-list     do not publish a relay list (kind 10002) for a key that has
                      none. One is written only when both lookup relays confirm
                      there is none, and it names the relays deployed to.
  A deploy refuses pages whose nc:path, nc:site or nc:owner does not fit where it is
  publishing, and pages that would lose /nsite-clay.js. --no-check publishes anyway.
  From a pulled directory, a file changed only in the browser since the pull is kept,
  and one changed in both places stops the deploy; --overwrite publishes this copy.
  Elsewhere, a published page the directory does not have stops the deploy, because
  publishing would take it down: --keep-missing keeps it, --prune takes it down.

Unpublish options
  --site=name         the named site to take down; without it, the root site
  --path=/about.html  take only these pages out (a new version without them);
                      repeat it or separate with commas
  --version=<id>      delete one version from the history: its snapshot id, as hex,
                      note1…, nevent1…, or its v….nsite.lol address
  --keep-blobs        leave the files on the Blossom servers
  --npub=npub1…       show the plan without connecting a signer
  --relays=a,b,c      send only to these, and look nothing else up. By default it
                      goes to the deploy relays, the lookup relays, your own relay
                      list and a set of large public relays.
  --yes               do it. Without this nothing is signed or sent.
  Relays that implement NIP-09 drop what a deletion names, and Blossom servers
  delete when asked, but neither is obliged to, and copies elsewhere remain.

Once a site is published, the owner opens it, signs in, and edits it in the page.
Saving from the browser republishes it; this CLI is only needed for the first
version and for changes made outside the browser. An agent editing a site from
outside follows ${"https://nsite-clay.cypherpunk.today/llms-edit.txt"}.
`);
}

function cmdVersion() {
  console.log(JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version);
}

const commands = { version: cmdVersion, init: cmdInit, deploy: cmdDeploy, pull: cmdPull, whoami: cmdWhoami, unpublish: cmdUnpublish, keygen: cmdKeygen, help: cmdHelp };
const run = cmd === "help" && flags.version === true ? cmdVersion : commands[cmd] || cmdHelp;
await run();
process.exit(0);
