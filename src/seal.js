// Sealed pages: the format, and nothing that touches a network or a DOM.
//
// A sealed page is an ordinary nsite-clay document whose content travels as
// ciphertext inside a plaintext "shell". The shell is what a gateway serves and
// what Blossom stores; the page itself exists only in a browser, or in a tool,
// that holds a key. This file is the whole format, and it is the same code in
// the browser runtime and in the command line tool, so the two cannot drift.
//
//   secret key  sk   32 bytes. The artifact's own Nostr key. Signs manifests,
//                    so holding it is what "can edit" means.
//   read key    K    HKDF-SHA256(sk). Decrypts the page. Cannot sign, and does
//                    not lead back to sk, so a read link is never an edit link.
//
// Web Crypto and raw DEFLATE only, so there is no dependency to audit and none
// to bundle. Every current browser has both as globals. Node has Web Crypto as
// a global only from 19 and "deflate-raw" streams only from 20.12, so the
// command line tool hands in node:crypto and node:zlib through usePlatform().
import { getPublicKey } from "nostr-tools";
import { v2 as nip44 } from "nostr-tools/nip44";

export const SEAL_VERSION = "1";
const LABEL = "nsite-clay/sealed/v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------------ encoding

export function b64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text) {
  const s = atob(String(text).trim().replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

let wc = globalThis.crypto;
let codec = null;

/**
 * Where Web Crypto and raw DEFLATE come from, for a platform without them as
 * globals. `deflate` and `inflate` take and return a Uint8Array (sync or async)
 * and must be raw DEFLATE (RFC 1951), which is what the browser's
 * CompressionStream("deflate-raw") writes, so either side opens the other's.
 */
export function usePlatform({ crypto, deflate, inflate } = {}) {
  if (crypto) wc = crypto;
  if (deflate && inflate) codec = { deflate, inflate };
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------- keys

export function newSecret() { return wc.getRandomValues(new Uint8Array(32)); }

/** The read key that belongs to an artifact's secret key. One way. */
export async function readKeyOf(sk) {
  const ikm = await wc.subtle.importKey("raw", sk, "HKDF", false, ["deriveBits"]);
  const bits = await wc.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(LABEL), info: enc.encode("read") }, ikm, 256);
  return new Uint8Array(bits);
}

/**
 * Everything a link or a ledger entry gives you, from whichever secret it
 * held. An edit secret alone implies the read key. Both together are a page
 * that shares its signing key with other pages (a workspace, where one key
 * signs one site with many pages): there the read key is the page's own and
 * does not follow from the signing key, so a link to one page opens that page
 * only. `split` says which of the two it is.
 */
export async function keysFrom({ edit, read }) {
  if (edit) {
    const sk = typeof edit === "string" ? unb64u(edit) : edit;
    if (sk.length !== 32) throw new Error("An edit secret is 32 bytes");
    const own = await readKeyOf(sk);
    const given = read ? (typeof read === "string" ? unb64u(read) : read) : null;
    if (given && given.length !== 32) throw new Error("A read key is 32 bytes");
    const split = !!given && hex(given) !== hex(own);
    return { sk, pubkey: getPublicKey(sk), K: split ? given : own, ...(split ? { split: true } : {}) };
  }
  const K = typeof read === "string" ? unb64u(read) : read;
  if (!K || K.length !== 32) throw new Error("A read key is 32 bytes");
  return { sk: null, pubkey: null, K };
}

/** `#k=…` or `#e=…` out of a URL fragment. Anything else in it is left alone. */
export function parseFragment(hash) {
  const out = {};
  for (const part of String(hash || "").replace(/^#/, "").split("&")) {
    const m = /^([ke])=([A-Za-z0-9_-]{43})$/.exec(part);
    if (m) out[m[1] === "e" ? "edit" : "read"] = m[2];
  }
  return out;
}

// -------------------------------------------------------------- the envelope

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
const deflate = async (bytes) => codec ? new Uint8Array(await codec.deflate(bytes)) : pipe(bytes, new CompressionStream("deflate-raw"));
const inflate = async (bytes) => codec ? new Uint8Array(await codec.inflate(bytes)) : pipe(bytes, new DecompressionStream("deflate-raw"));

// Padmé (Nikitin et al., PETS 2019): round the length up so that at most
// log log of it is visible, for at most about 12% more bytes. Without it the
// ciphertext is as long as the page, and "the list got one item longer" is
// readable by anybody watching the manifest.
export function padme(len) {
  if (len < 2) return len;
  const e = Math.floor(Math.log2(len));
  const s = Math.floor(Math.log2(e)) + 1;
  const mask = (1 << (e - s)) - 1;
  return (len + mask) & ~mask;
}

// What the ciphertext is bound to. A sealed blob lifted into another artifact,
// or to another path of this one, fails to open rather than opening as
// something its author never put there.
const aad = ({ owner, site = "", path }) => enc.encode([LABEL, owner, site, path].join("\n"));

/**
 * Seal a document. `html` is the page exactly as it would have been published
 * unsealed. Resolves to the text that goes inside the shell.
 */
export async function sealText(html, K, where) {
  const packed = await deflate(enc.encode(html));
  const body = new Uint8Array(Math.max(padme(packed.length + 4), 64));
  new DataView(body.buffer).setUint32(0, packed.length);
  body.set(packed, 4);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const key = await wc.subtle.importKey("raw", K, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await wc.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(where) }, key, body));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64u(out);
}

/** The reverse. Throws on a wrong key, a moved blob or a damaged one. */
export async function openText(text, K, where) {
  const raw = unb64u(text);
  const key = await wc.subtle.importKey("raw", K, "AES-GCM", false, ["decrypt"]);
  let body;
  try {
    body = new Uint8Array(await wc.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: aad(where) }, key, raw.subarray(12)));
  } catch { throw Object.assign(new Error("This key does not open this page"), { code: "wrong-key" }); }
  const len = new DataView(body.buffer, body.byteOffset).getUint32(0);
  return dec.decode(await inflate(body.subarray(4, 4 + len)));
}

// -------------------------------------------------------------------- wraps

/**
 * A key for one member, readable by their signer and by nobody else. NIP-44,
 * from the artifact's key to theirs, so they open it with
 * nip44_decrypt(<artifact pubkey>, c), which Amber and every bunker answer.
 */
export function wrapFor(sk, memberHex, role, K, { split = false } = {}) {
  // A page whose read key does not follow from its signing key hands an
  // editor both, as "<edit>.<read>".
  const secret = role === "edit" ? b64u(sk) + (split ? "." + b64u(K) : "") : b64u(K);
  const c = nip44.encrypt(secret, nip44.utils.getConversationKey(sk, memberHex));
  return { p: memberHex, r: role, c };
}

/** The fragment that opens a page: `e=…` (and `&k=…` for a split page) or `k=…`. */
export function fragmentOf(keys, { edit = true } = {}) {
  if (edit && keys.sk) return `e=${b64u(keys.sk)}${keys.split ? `&k=${b64u(keys.K)}` : ""}`;
  return `k=${b64u(keys.K)}`;
}

/** A member's side: `decrypt(pubkey, ciphertext)` is their signer's nip44Decrypt. */
export async function unwrap(wraps, memberHex, ownerHex, decrypt) {
  const mine = (wraps || []).filter((w) => w.p === memberHex).sort((a, b) => (a.r === "edit" ? 0 : 1) - (b.r === "edit" ? 0 : 1));
  for (const w of mine) {
    try {
      const secret = await decrypt(ownerHex, w.c);
      if (w.r !== "edit") return { read: secret };
      const [edit, read] = String(secret).split(".");
      return read ? { edit, read } : { edit };
    } catch { /* the next entry */ }
  }
  return null;
}

// ---------------------------------------------------------------- the shell

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const origin = (url) => { try { return new URL(url).origin.replace(/^ws/, "http"); } catch { return null; } };
const wsOrigin = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return null; } };

/**
 * The policy a sealed page runs under. It is written once, by the tool that
 * creates the artifact, and every later save copies it unchanged: the page
 * cannot widen what it may talk to by saving itself.
 *
 * What it does: nothing loads from, and nothing is sent by fetch, XHR, beacon,
 * WebSocket, image, font, frame or form to, an origin that is not the page's
 * own, its relays or its Blossom servers. What it does not do is stop a script
 * that is already running from navigating the tab somewhere with data in the
 * address: no Content-Security-Policy can. See the specification, section 6.
 */
export function shellPolicy({ relays = [], servers = [], connect = [], allow = [] }) {
  const blobs = [...new Set(servers.map(origin).filter(Boolean))];
  const socks = [...new Set([...relays, ...connect].map(wsOrigin).filter(Boolean))];
  const extra = [...new Set(allow.map(origin).filter(Boolean))];
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${extra.map((o) => " " + o).join("")}`,
    `style-src 'self' 'unsafe-inline'${extra.map((o) => " " + o).join("")}`,
    `img-src 'self' data: blob: ${[...blobs, ...extra].join(" ")}`.trim(),
    `media-src 'self' data: blob: ${[...blobs, ...extra].join(" ")}`.trim(),
    `font-src 'self' data:${extra.map((o) => " " + o).join("")}`,
    `connect-src 'self' ${[...blobs, ...socks, ...extra].join(" ")}`.trim(),
    "form-action 'none'", "base-uri 'none'", "object-src 'none'", "frame-src 'none'", "worker-src 'none'",
  ].join("; ");
}

/**
 * The file a gateway serves. Nothing in it says what the page is about: a
 * generic title, no description, and the content only as ciphertext.
 *
 * `head` is the shell's own markup for the runtime (its script and stylesheet
 * links). It sits outside the ciphertext so an upgrade can point a page at a
 * newer runtime without holding the key.
 */
export function buildShell({ owner, site = "", path = "/index.html", relays, servers, lang = "en",
  title = "Private page", policy, head = "", sealed, wraps = [], expires = null, attrs = {} }) {
  const root = {
    lang, "nc:owner": owner, ...(site ? { "nc:site": site } : {}), "nc:path": path,
    "nc:relays": relays.join(" "), "nc:servers": servers.join(" "),
    "nc:sealed": SEAL_VERSION, ...(expires ? { "nc:expires": String(expires) } : {}), ...attrs,
  };
  return [
    "<!doctype html>",
    `<html ${Object.entries(root).map(([k, v]) => `${k}="${esc(v)}"`).join(" ")}>`,
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${esc(policy)}" nc:shell>`,
    `<meta charset="utf-8" nc:shell>`,
    `<meta name="viewport" content="width=device-width, initial-scale=1" nc:shell>`,
    `<meta name="robots" content="noindex, nofollow, noarchive" nc:shell>`,
    `<meta name="referrer" content="no-referrer" nc:shell>`,
    `<title nc:shell>${esc(title)}</title>`,
    head.trim(),
    "</head>",
    "<body>",
    `<noscript nc:shell>This page is encrypted. It opens in a browser with JavaScript, from the link it was shared with.</noscript>`,
    `<script type="application/nc-sealed" nc:shell>${sealed}</script>`,
    `<script type="application/nc-keys" nc:shell>${JSON.stringify({ v: 1, wraps }).replace(/</g, "\\u003c")}</script>`,
    "</body>",
    "</html>",
    "",
  ].filter((l, i, a) => l !== "" || i === a.length - 1).join("\n");
}

/**
 * Read a shell back, from its text alone. Strict on purpose: this runs in a
 * tool with no DOM, and in the save check, where "roughly a shell" is the
 * failure it exists to catch.
 */
export function parseShell(text) {
  const tag = /<html\b([^>]*)>/i.exec(text)?.[1];
  if (tag == null) return null;
  const attrs = {};
  for (const m of tag.matchAll(/([^\s=]+)="([^"]*)"/g)) {
    attrs[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  }
  if (!attrs["nc:sealed"]) return null;
  const block = (type) => new RegExp(`<script type="application/${type}"[^>]*>([^<]*)</script>`).exec(text)?.[1];
  const sealed = block("nc-sealed");
  if (!sealed) return null;
  let wraps = [];
  try { wraps = JSON.parse(block("nc-keys") || "{}").wraps || []; } catch { /* no members */ }
  const head = /<head>([\s\S]*?)<\/head>/i.exec(text)?.[1] || "";
  return {
    attrs, sealed: sealed.trim(), wraps,
    policy: /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i.exec(head)?.[1]
      ?.replace(/&quot;/g, '"').replace(/&amp;/g, "&") || "",
    title: /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] || "",
    // What the shell carries for the runtime: every head line that is not one
    // of the fixed ones above.
    head: head.split("\n").filter((l) => l.trim() &&
      !/^<meta (http-equiv="Content-Security-Policy"|charset|name="(viewport|robots|referrer)")/i.test(l.trim()) &&
      !/^<title\b/i.test(l.trim())).join("\n"),
  };
}

/**
 * The last thing before an upload from a page that opened sealed: the bytes
 * must be a shell and nothing but a shell. A body that holds anything except
 * the three shell elements means plaintext is about to be published, and the
 * save stops instead.
 */
export function assertShell(text) {
  const shell = parseShell(text);
  if (!shell) throw new Error("Refusing to publish: this page is sealed and what was about to be uploaded is not.");
  const body = /<body>([\s\S]*)<\/body>/i.exec(text)?.[1] ?? "";
  const rest = body
    .replace(/<noscript nc:shell>[^<]*<\/noscript>/, "")
    .replace(/<script type="application\/nc-sealed" nc:shell>[A-Za-z0-9_-]+<\/script>/, "")
    .replace(/<script type="application\/nc-keys" nc:shell>[^<]*<\/script>/, "");
  if (rest.trim()) throw new Error("Refusing to publish: there is unencrypted content next to the sealed page.");
  return shell;
}

export { hex as bytesToHex };
