#!/usr/bin/env node
// nsite-clay CLI: scaffold a site, and publish one.
//
// Publishing is the same three steps the browser performs on save, which is why
// this tool exists at all: something has to put the first version online before
// the document can start saving itself.
//
//   1. every file becomes a Blossom blob, addressed by its own sha256
//   2. a NIP-5A manifest maps paths to those hashes, signed by the site owner
//   3. a kind-5128 snapshot pins that set of hashes as a permanent version
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, writeFileSync, copyFileSync } from "node:fs";
import { join, relative, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool } from "nostr-tools";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import WebSocket from "ws";
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
const DEFAULT_SERVERS = ["https://cdn.hzrd149.com", "https://blossom.primal.net"];

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("-")) || "help";
const positional = argv.filter((a) => !a.startsWith("-")).slice(1);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => {
  const i = a.indexOf("=");
  return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));

const list = (v, d) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);
const RELAYS = list(flags.relays, DEFAULT_RELAYS);
const SERVERS = list(flags.servers, DEFAULT_SERVERS);

const die = (msg) => { console.error("nsite-clay: " + msg); process.exit(1); };

// ------------------------------------------------------------------ signing

// One interface over a raw key and a remote signer, so `deploy` does not care
// which the person used.
async function getSigner() {
  const bunker = flags.bunker || process.env.NOSTR_BUNKER_URI;
  if (bunker) {
    const bp = await parseBunkerInput(String(bunker));
    if (!bp) die("could not parse that bunker:// URI");
    if (!bp.relays?.length) die("that bunker:// URI names no relays");
    const clientKey = generateSecretKey();
    // fromBunker, not the constructor: the constructor's second argument is
    // options, so `new BunkerSigner(key, bp)` leaves the pointer unset and
    // connect() dies on it.
    const signer = BunkerSigner.fromBunker(clientKey, bp);
    // A bunker that already holds a session for this secret answers `connect`
    // with "already connected", which is a success in every sense that matters.
    try { await signer.connect(); }
    catch (e) { if (!/already connected/i.test(String(e?.message ?? e))) throw e; }
    // NIP-46: the pubkey on the transport is a per-connection routing key, not
    // the user. The identity only comes from an explicit get_public_key.
    // A refusal here is almost always the connection lacking a permission, so
    // say which request was refused rather than passing on a bare "no permission".
    const ask = async (what, fn) => {
      try { return await fn(); }
      catch (e) {
        const msg = String(e?.message ?? e);
        if (/no permission|denied|unauthorized/i.test(msg)) {
          die(`the signer refused ${what} ("${msg}").\n` +
              `  Grant this connection: get_public_key, sign_event:24242 (Blossom uploads),\n` +
              `  sign_event:15128 and sign_event:35128 (the nsite manifest), sign_event:5128 (versions).\n` +
              `  In most signers that means approving the prompt, or reconnecting with those perms.`);
        }
        die(`${what} failed: ${msg}`);
      }
    };
    const pubkey = await ask("get_public_key", () => signer.getPublicKey());
    return {
      pubkey,
      sign: (t) => ask(`sign_event kind ${t.kind}`, () => signer.signEvent(t)),
      close: () => signer.close().catch(() => {}),
    };
  }
  const raw = flags.sec || process.env.NOSTR_SECRET_KEY;
  if (!raw) die("no key: pass --sec=nsec1… or --bunker=bunker://… (or set NOSTR_SECRET_KEY / NOSTR_BUNKER_URI)");
  const s = String(raw).trim();
  if (s.startsWith("npub")) die("that is a public key; signing needs the nsec");
  const sec = s.startsWith("nsec") ? nip19.decode(s).data : Uint8Array.from(Buffer.from(s, "hex"));
  if (sec.length !== 32) die("secret key must be an nsec or 64 hex characters");
  return { pubkey: getPublicKey(sec), sign: async (t) => finalizeEvent(t, sec), close: () => {} };
}

// ------------------------------------------------------------------ blossom

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function upload(server, bytes, type, signer) {
  const hash = bytesToHex(sha256(bytes));
  let last;
  // BUD-11 specifies base64url without padding; part of the deployed fleet only
  // accepts padded standard base64, so try both before giving up on a server.
  for (const urlsafe of [true, false]) {
    try {
      const ev = await signer.sign({
        kind: 24242, created_at: Math.floor(Date.now() / 1000),
        tags: [["t", "upload"], ["expiration", String(Math.floor(Date.now() / 1000) + 600)], ["x", hash]],
        content: "Upload site file",
      });
      const raw = Buffer.from(JSON.stringify(ev));
      const auth = "Nostr " + (urlsafe ? b64url(raw) : raw.toString("base64"));
      const res = await fetch(`${server.replace(/\/+$/, "")}/upload`, {
        method: "PUT", headers: { Authorization: auth, "Content-Type": type }, body: bytes,
      });
      if (res.ok) return hash;
      last = `${res.status} ${res.headers.get("x-reason") || (await res.text().catch(() => ""))}`.trim();
      if (![400, 401].includes(res.status)) break;
    } catch (e) { last = e.message; }
  }
  throw new Error(`${server}: ${last}`);
}

// ------------------------------------------------------------------ walking

function walk(base, cur = base, out = []) {
  for (const name of readdirSync(cur)) {
    if (name.startsWith(".")) continue;
    const p = join(cur, name);
    statSync(p).isDirectory() ? walk(base, p, out) : out.push(p);
  }
  return out;
}

// NIP-5A aggregate hash: sha256 over sorted "<hash> <path>\n" lines, path tags
// only, order-independent. It identifies a site version.
const aggregate = (paths) => bytesToHex(sha256(Buffer.from(
  Object.entries(paths).map(([p, h]) => `${h} ${p}\n`).sort().join(""))));

// --------------------------------------------------------------------- init

function cmdInit() {
  const dir = positional[0] || "site";
  if (existsSync(join(dir, "index.html"))) die(`${dir}/index.html already exists`);
  mkdirSync(dir, { recursive: true });

  let owner = flags.npub;
  let generated = null;
  if (!owner) {
    const sec = generateSecretKey();
    owner = nip19.npubEncode(getPublicKey(sec));
    generated = nip19.nsecEncode(sec);
  }

  const tpl = readFileSync(join(PKG, "examples", "notes.html"), "utf8")
    .replace(/nc:owner="[^"]*"/, `nc:owner="${owner}"`)
    .replace(/nc:site="[^"]*"\n\s*/, "");           // a fresh site is a root site
  writeFileSync(join(dir, "index.html"), tpl);
  copyFileSync(join(PKG, "dist", "nsite-clay.js"), join(dir, "nsite-clay.js"));

  console.log(`Created ${dir}/index.html and ${dir}/nsite-clay.js`);
  console.log(`Owner: ${owner}`);
  if (generated) {
    console.log(`\nThis key was generated for you. It is the only thing that can publish`);
    console.log(`this site, and it is not stored anywhere. Save it now:\n`);
    console.log(`  ${generated}\n`);
  }
  console.log(`Publish it with:\n  nsite-clay deploy ${dir} --sec=nsec1…`);
}

// ------------------------------------------------------------------- deploy

async function cmdDeploy() {
  const dir = positional[0];
  if (!dir) die("usage: nsite-clay deploy <dir> [--sec=… | --bunker=…] [--site=name]");
  if (!existsSync(dir)) die(`no such directory: ${dir}`);
  const site = flags.site || "";
  if (site && !/^[a-z0-9-]{1,13}$/.test(site) || site.endsWith("-")) {
    if (site) die("--site must be 1-13 characters of [a-z0-9-] and must not end with a dash");
  }

  const signer = await getSigner();
  const pub = signer.pubkey;

  const fingerprint = !flags["no-fingerprint"];
  const isHtml = (f) => /\.html?$/i.test(f);
  const files = walk(dir);
  if (!files.length) die(`${dir} is empty`);
  const contents = new Map(files.map((f) => [f, readFileSync(f)]));
  const pathOf = (f) => "/" + relative(dir, f).split("\\").join("/");
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
      rename.set(p, `${p.slice(0, p.length - ext.length)}-${bytesToHex(sha256(contents.get(f))).slice(0, 8)}${ext}`);
    }
    const rules = [...rename].sort((a, b) => b[0].length - a[0].length);  // longest first
    for (const f of files) {
      if (!isHtml(f)) continue;
      let text = contents.get(f).toString("utf8");
      for (const [from, to] of rules) {
        text = text.split(from).join(to).split(from.slice(1)).join(to.slice(1));
      }
      contents.set(f, Buffer.from(text, "utf8"));
    }
  }

  const paths = {};
  for (const f of files) {
    const bytes = contents.get(f);
    const path = rename.get(pathOf(f)) || pathOf(f);
    const type = TYPES[extname(f).toLowerCase()] || "application/octet-stream";
    const results = await Promise.allSettled(SERVERS.map((s) => upload(s, bytes, type, signer)));
    const ok = results.filter((r) => r.status === "fulfilled");
    if (!ok.length) die(`${path} was refused by every server:\n  ` +
      results.map((r) => r.reason?.message).join("\n  "));
    paths[path] = ok[0].value;
    // The unfingerprinted path stays in the manifest pointing at the same blob.
    // Nothing new links to it, but a reader still holding a cached copy of the
    // previous document does, and it costs one tag.
    const original = pathOf(f);
    if (path !== original) paths[original] = ok[0].value;
    console.log(`  ${path.padEnd(34)} ${paths[path].slice(0, 12)}…  ${String(bytes.length).padStart(8)} B  ${ok.length}/${SERVERS.length}`);
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
  const now = Math.floor(Date.now() / 1000);
  const manifest = await signer.sign({ kind, created_at: now, tags, content: "" });
  const snap = await signer.sign({
    kind: 5128, created_at: now, content: "",
    tags: [["a", `${kind}:${pub}:${site}`], ...tags.filter((t) => t[0] !== "d")],
  });

  const pool = new SimplePool();
  const sent = await Promise.allSettled(pool.publish(RELAYS, manifest));
  const accepted = sent.filter((r) => r.status === "fulfilled").length;
  if (!accepted) die("no relay accepted the manifest:\n  " +
    sent.map((r, i) => `${RELAYS[i]}: ${r.reason?.message || r.reason}`).join("\n  "));
  await Promise.allSettled(pool.publish(RELAYS, snap));
  pool.close(RELAYS);
  await signer.close();

  // Blossom servers are told where the blobs are; without this a gateway that
  // has no `server` hint and no kind-10063 for the author answers 404.
  const b36 = BigInt("0x" + pub).toString(36).padStart(50, "0");
  const url = site
    ? `https://${b36}${site}.nsite.lol/`
    : `https://${nip19.npubEncode(pub)}.nsite.lol/`;
  console.log(`\n  manifest  kind ${kind}  ${manifest.id}`);
  console.log(`  aggregate ${agg}`);
  console.log(`  version   v${BigInt("0x" + snap.id).toString(36).padStart(50, "0")}.nsite.lol`);
  console.log(`  relays    ${accepted}/${RELAYS.length} accepted`);
  console.log(`\n  ${url}\n`);
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
  console.log(`nsite-clay — a single HTML file that edits and republishes itself

  nsite-clay init [dir]        scaffold a site (generates a key unless --npub is given)
  nsite-clay deploy <dir>      publish a directory as an nsite
  nsite-clay keygen            print a fresh keypair and the URL it would live at

Signing
  --sec=nsec1… | NOSTR_SECRET_KEY        a raw key
  --bunker=bunker://… | NOSTR_BUNKER_URI a remote signer (nsec.app, Amber over a bunker)

Deploy options
  --site=name         publish as a named site (kind 35128) instead of the root site
  --title=…           --description=…   --source=<repo url>
  --relays=a,b,c      default: ${DEFAULT_RELAYS.join(",")}
  --servers=a,b       default: ${DEFAULT_SERVERS.join(",")}
  --no-fingerprint    do not put content hashes in asset paths

Once a site is published, the owner opens it, signs in, and edits it in the page.
Saving from the browser republishes it; this CLI is only needed for the first
version and for changes made outside the browser.
`);
}

const commands = { init: cmdInit, deploy: cmdDeploy, keygen: cmdKeygen, help: cmdHelp };
const run = commands[cmd] || cmdHelp;
await run();
process.exit(0);
