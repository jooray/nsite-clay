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

// Push to every configured server; succeed if at least one takes it. Blossom is
// deliberately redundant: the blob is content-addressed, so more copies is
// strictly better and any one of them can serve it.
export async function uploadAll(servers, bytes, opts) {
  const results = await Promise.allSettled(servers.map((s) => upload(s, bytes, opts)));
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = results.filter((r) => r.status === "rejected").map((r) => String(r.reason));
  if (!ok.length) throw new Error("No Blossom server accepted the blob:\n" + failed.join("\n"));
  return { hash: hashBytes(bytes), ok, failed };
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
