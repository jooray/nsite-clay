// Relays, Blossom servers and a gateway that misbehave on request, in this
// process, for testing the artifact tool against the faults the public fleet
// was seen to have: a server that answers HEAD for what it does not hold, one
// that takes an upload and keeps nothing, a relay that says OK and stores
// nothing, a gateway that serves a manifest it read hours ago.
//
//   const net = await startFaultNet({ relays: 3, servers: 3 });
//   net.relays[1].drop = true;  net.servers[0].lieHead = true;  net.gateway.freeze();
//
// Everything is in memory and listens on 127.0.0.1 only.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { verifyEvent, nip19 } from "nostr-tools";
import { createHash } from "node:crypto";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const isReplaceable = (k) => (k >= 10000 && k < 20000) || (k >= 30000 && k < 40000) || k === 0 || k === 3;
const dTag = (ev) => ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
const listen = (server, host = "127.0.0.1") => new Promise((r) => server.listen(0, host, () => r(server.address().port)));

function matches(f, ev) {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  for (const [k, want] of Object.entries(f)) {
    if (!k.startsWith("#")) continue;
    const have = ev.tags.filter((t) => t[0] === k.slice(1)).map((t) => t[1]);
    if (!want.some((w) => have.includes(w))) return false;
  }
  return true;
}

async function relay() {
  const ctl = {
    drop: false,     // answer OK, store nothing
    down: false,     // close every connection at once
    regular: [], replaceable: new Map(),
    stored() { return [...this.regular, ...this.replaceable.values()]; },
    manifestOf(pubkey) { return this.replaceable.get(`15128:${pubkey}:`) || null; },
    put(ev) {
      if (ev.kind === 5) {
        for (const [n, v] of ev.tags) {
          if (n === "e") { this.regular = this.regular.filter((e) => e.id !== v); for (const [k, e] of this.replaceable) if (e.id === v) this.replaceable.delete(k); }
          if (n === "a" && v.split(":")[1] === ev.pubkey) { const e = this.replaceable.get(v); if (e && e.created_at <= ev.created_at) this.replaceable.delete(v); }
        }
        this.regular.push(ev);
        return;
      }
      if (isReplaceable(ev.kind)) {
        const k = `${ev.kind}:${ev.pubkey}:${dTag(ev)}`;
        const prev = this.replaceable.get(k);
        if (prev && (prev.created_at > ev.created_at || (prev.created_at === ev.created_at && prev.id <= ev.id))) return;
        this.replaceable.set(k, ev);
        return;
      }
      if (!this.regular.some((e) => e.id === ev.id)) this.regular.push(ev);
    },
  };
  const http = createServer((q, s) => { s.writeHead(200); s.end("relay"); });
  new WebSocketServer({ server: http }).on("connection", (ws) => {
    if (ctl.down) return ws.terminate();
    ws.on("message", (raw) => {
      if (ctl.down) return ws.terminate();
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg[0] === "EVENT") {
        const ev = msg[1];
        if (!verifyEvent(ev)) return ws.send(JSON.stringify(["OK", ev?.id || "", false, "invalid"]));
        if (!ctl.drop) ctl.put(ev);
        return ws.send(JSON.stringify(["OK", ev.id, true, ""]));
      }
      if (msg[0] === "REQ") {
        const [, id, ...filters] = msg;
        const hits = ctl.stored().filter((ev) => filters.some((f) => matches(f, ev))).sort((a, b) => b.created_at - a.created_at);
        const limit = Math.min(...filters.map((f) => f.limit ?? Infinity));
        for (const ev of Number.isFinite(limit) ? hits.slice(0, limit) : hits) ws.send(JSON.stringify(["EVENT", id, ev]));
        ws.send(JSON.stringify(["EOSE", id]));
      }
    });
  });
  ctl.port = await listen(http);
  ctl.url = `ws://127.0.0.1:${ctl.port}`;
  ctl.close = () => http.close();
  return ctl;
}

async function blossom() {
  const ctl = {
    lieHead: false,        // HEAD 200 with the right length for any hash
    dropBodies: false,     // PUT answers a good descriptor and keeps nothing
    wrongDescriptor: false,// PUT answers a descriptor for other bytes
    fail429: 0,            // the next n PUTs answer 429
    refuse: false,         // PUT answers 403
    puts: 0,
    blobs: new Map(),
  };
  const read = (q) => new Promise((r) => { const c = []; q.on("data", (x) => c.push(x)); q.on("end", () => r(Buffer.concat(c))); });
  const http = createServer(async (q, s) => {
    if (q.method === "PUT" && q.url === "/upload") {
      const body = await read(q);
      ctl.puts++;
      if (ctl.fail429 > 0) { ctl.fail429--; s.writeHead(429, { "X-Reason": "slow down" }); return s.end("slow down"); }
      if (ctl.refuse) { s.writeHead(403, { "X-Reason": "not allowed" }); return s.end("not allowed"); }
      const hash = sha(body);
      if (!ctl.dropBodies) ctl.blobs.set(hash, { bytes: body, type: q.headers["content-type"] || "application/octet-stream" });
      s.writeHead(200, { "Content-Type": "application/json" });
      return s.end(JSON.stringify({ sha256: ctl.wrongDescriptor ? sha(body + "x") : hash, size: body.length, url: `http://127.0.0.1:${ctl.port}/${hash}` }));
    }
    const hash = (q.url || "").slice(1).split(/[.?]/)[0];
    if (q.method === "DELETE") {
      if (!/^Nostr /.test(q.headers.authorization || "")) { s.writeHead(401); return s.end(); }
      if (!ctl.blobs.has(hash)) { s.writeHead(404); return s.end(); }
      ctl.blobs.delete(hash); s.writeHead(200); return s.end();
    }
    const blob = ctl.blobs.get(hash);
    if (q.method === "HEAD" && ctl.lieHead) {
      // Claims everything, with whatever length the real blob would have if it had one.
      s.writeHead(200, { "Content-Length": blob ? blob.bytes.length : (ctl.lieLength?.(hash) ?? 0) });
      return s.end();
    }
    if (!blob) { s.writeHead(404); return s.end("not found"); }
    s.writeHead(200, { "Content-Type": blob.type, "Content-Length": blob.bytes.length });
    s.end(q.method === "HEAD" ? undefined : blob.bytes);
  });
  ctl.port = await listen(http);
  ctl.url = `http://127.0.0.1:${ctl.port}`;
  ctl.close = () => http.close();
  return ctl;
}

// Reads manifests from the first relay, bytes from any server that has them,
// and sends nsite.lol's ETag. freeze() keeps serving the manifests it has now,
// the way a gateway's cache does, until thaw().
async function gateway(relays, servers) {
  const ctl = {
    frozen: null,
    freeze() { this.frozen = new Map(relays[0].replaceable); },
    thaw() { this.frozen = null; },
  };
  const http = createServer((q, s) => {
    const label = (q.headers.host || "").split(":")[0].split(".")[0];
    let pubkey;
    try { pubkey = nip19.decode(label).data; } catch { s.writeHead(400); return s.end("no site"); }
    const table = ctl.frozen || relays[0].replaceable;
    const m = table.get(`15128:${pubkey}:`);
    if (!m) { s.writeHead(404); return s.end("no manifest"); }
    let path = new URL(q.url, "http://x").pathname;
    if (path.endsWith("/")) path += "index.html";
    const entry = m.tags.find((t) => t[0] === "path" && t[1] === path);
    if (!entry) { s.writeHead(404); return s.end("Page not found"); }
    const blob = servers.map((x) => x.blobs.get(entry[2])).find(Boolean);
    if (!blob) { s.writeHead(502); return s.end("Bad Gateway: Unable to retrieve the requested file from storage servers."); }
    s.writeHead(200, { "Content-Type": blob.type, ETag: `W/"${entry[2]}"` });
    s.end(blob.bytes);
  });
  // *.localhost is ::1 to some Node versions and 127.0.0.1 to others; this
  // answers both, on loopback only.
  ctl.port = await listen(http, "::1");
  ctl.alt = createServer(http.listeners("request")[0]);
  await new Promise((r) => ctl.alt.listen(ctl.port, "127.0.0.1", r));
  ctl.template = `http://{host}.localhost:${ctl.port}`;
  ctl.close = () => { http.close(); ctl.alt.close(); };
  return ctl;
}

export async function startFaultNet({ relays: nr = 3, servers: ns = 3 } = {}) {
  const relays = await Promise.all(Array.from({ length: nr }, relay));
  const servers = await Promise.all(Array.from({ length: ns }, blossom));
  const gw = await gateway(relays, servers);
  return {
    relays, servers, gateway: gw,
    env: {
      NSITE_ARTIFACTS_RELAYS: relays.map((r) => r.url).join(","),
      NSITE_ARTIFACTS_SERVERS: servers.map((s) => s.url).join(","),
      NSITE_ARTIFACTS_GATEWAY: gw.template,
    },
    close() { for (const x of [...relays, ...servers, gw]) x.close(); },
  };
}
