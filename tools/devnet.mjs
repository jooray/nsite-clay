#!/usr/bin/env node
// A whole nsite stack on localhost: a relay, a Blossom server, and a gateway.
//
// Developing against public relays means publishing every experiment to
// somebody else's disk forever, and every half-finished draft to a public
// gateway. None of these three services is complicated enough to justify that,
// so here they are, in memory, gone when you stop the process.
//
//   relay    ws://127.0.0.1:4869    NIP-01 REQ/EVENT/CLOSE, replaceable kinds
//   blossom  http://127.0.0.1:4870  BUD-01 GET, BUD-02 PUT /upload
//   gateway  http://127.0.0.1:4871  NIP-5A resolution, ?npub= or a Host label
//
// Nothing here is hardened. It is a development fixture, it trusts its caller,
// and it should never be exposed beyond localhost.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { verifyEvent, nip19 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

const RELAY_PORT = Number(process.env.DEVNET_RELAY_PORT || 4869);
const BLOB_PORT = Number(process.env.DEVNET_BLOSSOM_PORT || 4870);
const GATEWAY_PORT = Number(process.env.DEVNET_GATEWAY_PORT || 4871);
const quiet = process.argv.includes("--quiet");
const log = (...a) => { if (!quiet) console.log(...a); };

// ---------------------------------------------------------------- the relay

const events = [];                 // regular events, in arrival order
const replaceable = new Map();     // "kind:pubkey:d" -> newest event
const subscriptions = new Set();   // { ws, id, filters }

const dTag = (ev) => ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
const isReplaceable = (k) => (k >= 10000 && k < 20000) || (k >= 30000 && k < 40000) || k === 0 || k === 3;
const isEphemeral = (k) => k >= 20000 && k < 30000;

function matches(filter, ev) {
  if (filter.ids && !filter.ids.includes(ev.id)) return false;
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  if (filter.authors && !filter.authors.includes(ev.pubkey)) return false;
  if (filter.since && ev.created_at < filter.since) return false;
  if (filter.until && ev.created_at > filter.until) return false;
  for (const [key, want] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const name = key.slice(1);
    const have = ev.tags.filter((t) => t[0] === name).map((t) => t[1]);
    if (!want.some((w) => have.includes(w))) return false;
  }
  return true;
}

function stored() {
  return [...events, ...replaceable.values()];
}

function store(ev) {
  if (isEphemeral(ev.kind)) return true;
  if (isReplaceable(ev.kind)) {
    const key = `${ev.kind}:${ev.pubkey}:${dTag(ev)}`;
    const prev = replaceable.get(key);
    // NIP-01: the newest wins, and on a tie the lower id wins.
    if (prev && (prev.created_at > ev.created_at ||
      (prev.created_at === ev.created_at && prev.id <= ev.id))) return false;
    replaceable.set(key, ev);
    return true;
  }
  if (events.some((e) => e.id === ev.id)) return false;
  events.push(ev);
  return true;
}

const relayHttp = createServer((req, res) => {
  // NIP-11, so a client can see what it is talking to.
  if ((req.headers.accept || "").includes("application/nostr+json")) {
    res.writeHead(200, { "Content-Type": "application/nostr+json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({
      name: "nsite-clay devnet", description: "In-memory relay for local development.",
      supported_nips: [1, 9, 11], software: "nsite-clay/tools/devnet.mjs",
      limitation: { max_message_length: 5_000_000, payment_required: false, auth_required: false },
    }));
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`nsite-clay devnet relay\nstored: ${stored().length} events\n`);
});

new WebSocketServer({ server: relayHttp }).on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const [verb, ...rest] = msg;

    if (verb === "EVENT") {
      const ev = rest[0];
      if (!verifyEvent(ev)) return ws.send(JSON.stringify(["OK", ev?.id ?? "", false, "invalid: bad signature"]));
      const fresh = store(ev);
      ws.send(JSON.stringify(["OK", ev.id, true, ""]));
      if (!fresh && !isEphemeral(ev.kind)) return;
      for (const sub of subscriptions) {
        if (sub.filters.some((f) => matches(f, ev))) {
          sub.ws.send(JSON.stringify(["EVENT", sub.id, ev]));
        }
      }
      log(`  relay   <- kind ${ev.kind} ${ev.id.slice(0, 8)} from ${ev.pubkey.slice(0, 8)}`);
      return;
    }

    if (verb === "REQ") {
      const [id, ...filters] = rest;
      const sub = { ws, id, filters };
      subscriptions.add(sub);
      ws.__subs = (ws.__subs || new Map()).set(id, sub);
      const hits = stored()
        .filter((ev) => filters.some((f) => matches(f, ev)))
        .sort((a, b) => b.created_at - a.created_at);
      const limit = Math.min(...filters.map((f) => f.limit ?? Infinity));
      for (const ev of (Number.isFinite(limit) ? hits.slice(0, limit) : hits)) {
        ws.send(JSON.stringify(["EVENT", id, ev]));
      }
      ws.send(JSON.stringify(["EOSE", id]));
      return;
    }

    if (verb === "CLOSE") {
      const sub = ws.__subs?.get(rest[0]);
      if (sub) { subscriptions.delete(sub); ws.__subs.delete(rest[0]); }
    }
  });

  ws.on("close", () => { for (const s of ws.__subs?.values() ?? []) subscriptions.delete(s); });
});

// -------------------------------------------------------------- the blossom

const blobs = new Map();   // sha256 -> { bytes, type }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,*",
  "Access-Control-Expose-Headers": "X-Reason,Content-Range",
};

const read = (req) => new Promise((res, rej) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => res(Buffer.concat(chunks)));
  req.on("error", rej);
});

createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  if (req.method === "PUT" && req.url === "/upload") {
    const body = await read(req);
    const hash = bytesToHex(sha256(body));
    // A real server checks the kind-24242 token here. This one only checks that
    // one was sent, so a client with broken auth still fails locally.
    const auth = req.headers.authorization || "";
    if (!/^Nostr /i.test(auth)) {
      res.writeHead(401, { ...CORS, "X-Reason": "Missing Blossom authorization" });
      return res.end("Missing Blossom authorization");
    }
    const created = !blobs.has(hash);
    blobs.set(hash, { bytes: body, type: req.headers["content-type"] || "application/octet-stream" });
    log(`  blossom <- ${hash.slice(0, 12)} ${String(body.length).padStart(8)} B ${created ? "stored" : "dedup"}`);
    res.writeHead(created ? 201 : 200, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      url: `http://127.0.0.1:${BLOB_PORT}/${hash}`,
      sha256: hash, size: body.length,
      type: blobs.get(hash).type, uploaded: Math.floor(Date.now() / 1000),
    }));
  }

  const hash = (req.url || "").slice(1).split(/[.?]/)[0];
  const blob = blobs.get(hash);
  if (!blob) { res.writeHead(404, CORS); return res.end("not found"); }
  res.writeHead(200, { ...CORS, "Content-Type": blob.type, "Content-Length": blob.bytes.length });
  res.end(req.method === "HEAD" ? undefined : blob.bytes);
}).listen(BLOB_PORT, "127.0.0.1");

// -------------------------------------------------------------- the gateway

// Resolve a site the way NIP-5A says: newest manifest for the pubkey, path tag
// to sha256, then the blob. Addressed by ?npub= (simplest for localhost) or by
// the canonical leftmost DNS label if you have wildcard DNS pointing here.
function resolvePubkey(req) {
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams.get("npub") || url.searchParams.get("site");
  const label = (req.headers.host || "").split(":")[0].split(".")[0];
  for (const candidate of [q, label]) {
    if (!candidate) continue;
    if (/^npub1/.test(candidate)) {
      try { return { pubkey: nip19.decode(candidate).data, d: "" }; } catch { /* next */ }
    }
    if (/^[0-9a-f]{64}$/i.test(candidate)) return { pubkey: candidate.toLowerCase(), d: "" };
    if (/^[0-9a-z]{50}/.test(candidate)) {
      const b36 = candidate.slice(0, 50);
      try {
        const n = [...b36].reduce((acc, c) => acc * 36n + BigInt("0123456789abcdefghijklmnopqrstuvwxyz".indexOf(c)), 0n);
        return { pubkey: n.toString(16).padStart(64, "0"), d: candidate.slice(50) };
      } catch { /* next */ }
    }
  }
  return null;
}

createServer(async (req, res) => {
  const target = resolvePubkey(req);
  if (!target) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Add ?npub=npub1… (or point a wildcard hostname here).\n");
  }
  const kind = target.d ? 35128 : 15128;
  const manifest = stored()
    .filter((ev) => ev.kind === kind && ev.pubkey === target.pubkey && (!target.d || dTag(ev) === target.d))
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!manifest) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("no manifest published\n"); }

  let path = new URL(req.url, "http://localhost").pathname;
  if (path.endsWith("/")) path += "index.html";
  const entry = manifest.tags.find((t) => t[0] === "path" && t[1] === path)
    || manifest.tags.find((t) => t[0] === "path" && t[1] === "/404.html");
  if (!entry) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end(`no ${path} in the manifest\n`); }

  const blob = blobs.get(entry[2]);
  if (!blob) { res.writeHead(502, { "Content-Type": "text/plain" }); return res.end("blob missing from the local Blossom\n"); }
  // A gateway must check that the bytes hash to what the manifest claims.
  if (bytesToHex(sha256(blob.bytes)) !== entry[2]) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    return res.end("blob does not match the hash in the manifest\n");
  }
  const ext = path.split(".").pop().toLowerCase();
  const types = { html: "text/html", js: "text/javascript", css: "text/css", png: "image/png",
    svg: "image/svg+xml", jpg: "image/jpeg", json: "application/json", md: "text/markdown" };
  log(`  gateway -> ${path} ${entry[2].slice(0, 8)}`);
  res.writeHead(200, {
    "Content-Type": blob.type || types[ext] || "application/octet-stream",
    // Deliberately no caching: the whole point of a local gateway is seeing the
    // change you just published, not the one you published a minute ago.
    "Cache-Control": "no-store",
  });
  res.end(blob.bytes);
}).listen(GATEWAY_PORT, "127.0.0.1");

relayHttp.listen(RELAY_PORT, "127.0.0.1", () => {
  log(`nsite-clay devnet`);
  log(`  relay    ws://127.0.0.1:${RELAY_PORT}`);
  log(`  blossom  http://127.0.0.1:${BLOB_PORT}`);
  log(`  gateway  http://127.0.0.1:${GATEWAY_PORT}/?npub=npub1…`);
  log(`\nDeploy into it with:`);
  log(`  nsite-clay deploy <dir> --sec=nsec1… \\`);
  log(`    --relays=ws://127.0.0.1:${RELAY_PORT} --servers=http://127.0.0.1:${BLOB_PORT}\n`);
});
