// Reads nsite-clay configuration out of the document itself.
// The document is the database, so it is also its own config file: everything
// the runtime needs lives on <html> as nc:* attributes.
import { nip19 } from "nostr-tools";

// relay.nsite.lol last on purpose: a gateway keeps a live subscription to its
// own relay, so a save that skips it is invisible there until the gateway's
// next resync, and readers meanwhile get a stale page.
const DEFAULT_RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom", "wss://relay.nsite.lol"];
const DEFAULT_SERVERS = ["https://cdn.hzrd149.com", "https://blossom.primal.net"];

function list(value, fallback) {
  if (!value) return fallback.slice();
  return value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

export function toHex(key) {
  if (!key) return null;
  const k = key.trim();
  if (/^[0-9a-f]{64}$/i.test(k)) return k.toLowerCase();
  try {
    const { type, data } = nip19.decode(k);
    if (type === "npub") return data;
    if (type === "nprofile") return data.pubkey;
  } catch { /* fall through */ }
  return null;
}

export function readConfig(doc = document) {
  const html = doc.documentElement;
  const attr = (n) => html.getAttribute(n);

  const owner = toHex(attr("nc:owner"));
  return {
    owner,
    // transport
    relays: list(attr("nc:relays"), DEFAULT_RELAYS),
    servers: list(attr("nc:servers"), DEFAULT_SERVERS),
    // nsite addressing: empty name => root site (kind 15128), else named (35128)
    site: (attr("nc:site") || "").trim(),
    path: (attr("nc:path") || "/index.html").trim(),
    // Off unless asked for: every save stores the whole page again and files a
    // version, so a timer turns one paragraph into a dozen published versions.
    autosave: html.hasAttribute("autosave") || html.hasAttribute("nc:autosave"),
    // "hash" keeps the editing controls hidden until the URL ends in #edit.
    editGate: (attr("nc:edit-gate") || "always").toLowerCase() === "hash" ? "hash" : "always",
    // A saved document hardcodes its own asset URLs and has no update channel,
    // so it watches its own manifest instead. Opt out with nc:autoreload="false".
    autoreload: (attr("nc:autoreload") || "").toLowerCase() !== "false",
  };
}

export function siteKind(cfg) { return cfg.site ? 35128 : 15128; }

export function siteAddress(cfg) {
  return `${siteKind(cfg)}:${cfg.owner}:${cfg.site}`;
}
