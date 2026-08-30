// Blossom (BUD-01/02/11) from the browser. Blossom servers must send
// `Access-Control-Allow-Origin: *`, so a page on any origin can push blobs.
import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";

export function hashBytes(bytes) { return bytesToHex(sha256(bytes)); }

export function hashText(text) { return hashBytes(new TextEncoder().encode(text)); }

// BUD-11 says base64url without padding. Some deployed servers still only
// accept padded standard base64, so we try the spec form first and fall back.
function b64(bytes, urlsafe) {
  let s = btoa(String.fromCharCode(...bytes));
  return urlsafe ? s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : s;
}

async function authHeader(signer, { verb, hash, reason, urlsafe }) {
  const event = await signer.sign({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", verb],
      ["expiration", String(Math.floor(Date.now() / 1000) + 600)],
      ...(hash ? [["x", hash]] : []),
    ],
    content: reason,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  return "Nostr " + b64(bytes, urlsafe);
}

// Upload one blob to one server. Resolves to a BUD-02 blob descriptor.
export async function upload(server, bytes, { signer, type = "text/html" }) {
  const hash = hashBytes(bytes);
  const base = server.replace(/\/+$/, "");
  let lastError;
  // BUD-11 says base64url without padding; some deployed servers only accept
  // padded standard base64. Worse, a server that omits `Access-Control-Allow-
  // Origin` on its *error* responses turns its own 400 into an opaque browser
  // network error, so a rejected encoding throws rather than returning -- which
  // is why each attempt is caught rather than left to unwind the loop.
  for (const urlsafe of [true, false]) {
    try {
      const res = await fetch(`${base}/upload`, {
        method: "PUT",
        // No X-SHA-256: it is optional in BUD-02, and some servers fail the CORS
        // preflight when it appears in Access-Control-Request-Headers. The hash
        // is already bound into the auth event's `x` tag.
        headers: {
          Authorization: await authHeader(signer, { verb: "upload", hash, reason: "Upload document", urlsafe }),
          "Content-Type": type,
        },
        body: bytes,
      });
      if (res.ok) return { ...(await res.json().catch(() => ({}))), sha256: hash, server: base };
      lastError = new Error(`${base}: ${res.status} ${res.headers.get("x-reason") || (await res.text().catch(() => ""))}`);
      if (res.status !== 400 && res.status !== 401) break;
    } catch (err) {
      lastError = new Error(`${base}: ${err.message} (CORS or network)`);
    }
  }
  throw lastError;
}

// Does this server already serve these exact bytes?
//
// Blobs are addressed by their own hash, so the same file uploaded by a hundred
// people is one blob. Asking first is what stops the hundred and first from
// pushing another copy of a 300 kB runtime that is already there.
//
// A 200 alone is not quite enough. A server that answers everything with an
// empty 200 would have us skip an upload the site then depends on, so where a
// length is given it has to match. Anything uncertain is treated as absent,
// because a needless upload is a wasted request and a wrongly skipped one is a
// broken page.
export async function has(server, hash, size) {
  const url = `${server.replace(/\/+$/, "")}/${hash}`;
  try {
    let res = await fetch(url, { method: "HEAD" });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { headers: { Range: "bytes=0-0" } });
      if (res.status === 206) return true;
    }
    if (!res.ok) return false;
    const len = res.headers.get("content-length");
    return len == null || Number(len) === size;
  } catch { return false; }
}

// Push to every configured server; succeed if at least one has it afterwards.
// Blossom is deliberately redundant: the blob is content-addressed, so more
// copies is strictly better and any one of them can serve it.
//
// A server that already holds the blob is left alone, and one that has dropped
// it gets it back, so publishing the same file twice repairs rather than
// duplicates. Pass `check: false` for bytes that cannot already be there.
export async function uploadAll(servers, bytes, opts = {}) {
  const hash = hashBytes(bytes);
  const { check = true } = opts;

  const present = check
    ? await Promise.all(servers.map((s) => has(s, hash, bytes.length)))
    : servers.map(() => false);
  const held = servers.filter((_, i) => present[i])
    .map((s) => ({ sha256: hash, server: s.replace(/\/+$/, ""), url: `${s.replace(/\/+$/, "")}/${hash}`, reused: true }));
  const missing = servers.filter((_, i) => !present[i]);
  if (!missing.length) return { hash, ok: held, failed: [], uploaded: 0 };

  const results = await Promise.allSettled(missing.map((s) => upload(s, bytes, opts)));
  const sent = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = results.filter((r) => r.status === "rejected").map((r) => String(r.reason));
  const ok = [...held, ...sent];
  if (!ok.length) throw new Error("No Blossom server accepted the blob:\n" + failed.join("\n"));
  return { hash, ok, failed, uploaded: sent.length };
}

// What this key has already uploaded (BUD-12). Servers that do not implement it
// are skipped rather than treated as an error, because the listing is a
// convenience: everything still works by URL or by uploading again.
export async function list(servers, pubkey, { signer } = {}) {
  const seen = new Map();
  await Promise.all(servers.map(async (server) => {
    const base = server.replace(/\/+$/, "");
    try {
      const headers = signer
        ? { Authorization: await authHeader(signer, { verb: "list", reason: "List uploads", urlsafe: true }) }
        : {};
      const res = await fetch(`${base}/list/${pubkey}`, { headers });
      if (!res.ok) return;
      for (const blob of await res.json()) {
        if (!blob?.sha256 || seen.has(blob.sha256)) continue;
        seen.set(blob.sha256, { ...blob, url: blob.url || `${base}/${blob.sha256}`, server: base });
      }
    } catch { /* a server without a listing is not a failure */ }
  }));
  return [...seen.values()].sort((a, b) => (b.uploaded || 0) - (a.uploaded || 0));
}

// Fetch a blob and refuse it unless the bytes hash to what the manifest claims.
// This is what makes a gateway untrusted for everything except the entry document.
export async function fetchVerified(servers, hash, { as = "text" } = {}) {
  for (const server of servers) {
    try {
      const res = await fetch(`${server.replace(/\/+$/, "")}/${hash}`);
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (hashBytes(buf) !== hash) continue;      // silently wrong server: skip it
      return as === "bytes" ? buf : new TextDecoder().decode(buf);
    } catch { /* try the next server */ }
  }
  throw new Error(`No server served ${hash} with matching bytes`);
}
