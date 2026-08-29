// Reads nsite-clay configuration out of the document itself.
// The document is the database, so it is also its own config file: everything
// the runtime needs lives on <html> as nc:* attributes.
import { nip19 } from "nostr-tools";

const DEFAULT_RELAYS = ["wss://nos.lol", "wss://relay.damus.io", "wss://relay.primal.net"];
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
    autosave: html.hasAttribute("autosave") || html.hasAttribute("nc:autosave"),
    // A saved document hardcodes its own asset URLs and has no update channel,
    // so it watches its own manifest instead. Opt out with nc:autoreload="false".
    autoreload: (attr("nc:autoreload") || "").toLowerCase() !== "false",
  };
}

export function siteKind(cfg) { return cfg.site ? 35128 : 15128; }

export function siteAddress(cfg) {
  return `${siteKind(cfg)}:${cfg.owner}:${cfg.site}`;
}
