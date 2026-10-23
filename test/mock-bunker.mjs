#!/usr/bin/env node
// A NIP-46 remote signer holding one test key, for the devnet.
//
// It behaves the way the signers people actually use do in the one respect that
// trips every client up: a bunker:// secret is spent on the first connect. A
// client that comes back with the same client key is recognised and served; a
// client with a new key and a spent secret is refused, and so is any request
// from a client that never connected. That is the difference between a tool
// that keeps its connection and one that asks for a new link every run.
//
// As a module:
//   const bunker = await startBunker({ relay, secretKey });
//   bunker.uri()    // a fresh bunker:// link with a new one-time secret
//   bunker.close()
//
// As a process (for a hand-run session on the devnet):
//   node test/mock-bunker.mjs --relay=ws://127.0.0.1:4869 --sec=<hex|nsec> [--port=4873]
// prints one link, and GET http://127.0.0.1:<port>/new prints another.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { finalizeEvent, getPublicKey, generateSecretKey, nip19, nip44, SimplePool, verifyEvent } from "nostr-tools";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
useWebSocketImplementation(WebSocket);

const toBytes = (k) => {
  if (k instanceof Uint8Array) return k;
  const s = String(k).trim();
  if (s.startsWith("nsec")) return nip19.decode(s).data;
  return Uint8Array.from(Buffer.from(s, "hex"));
};

export async function startBunker({ relay, secretKey, signerKey = generateSecretKey(), log = () => {} }) {
  const userKey = toBytes(secretKey);
  const userPub = getPublicKey(userKey);
  const signerPub = getPublicKey(signerKey);
  const relays = [relay];
  const pool = new SimplePool();
  const fresh = new Set();          // secrets not spent yet
  const clients = new Set();        // client pubkeys that connected with one
  const stats = { requests: 0, refused: 0, signed: [] };

  const reply = async (to, id, result, error) => {
    const content = nip44.encrypt(JSON.stringify(error ? { id, result: "", error } : { id, result }),
      nip44.getConversationKey(signerKey, to));
    const ev = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [["p", to]], content }, signerKey);
    await Promise.any(pool.publish(relays, ev)).catch(() => {});
  };

  const handle = async (ev) => {
    if (!verifyEvent(ev)) return;
    let req;
    try { req = JSON.parse(nip44.decrypt(ev.content, nip44.getConversationKey(signerKey, ev.pubkey))); }
    catch { return; }
    const { id, method, params = [] } = req;
    const from = ev.pubkey;
    stats.requests++;
    log(`bunker  <- ${method} from ${from.slice(0, 8)}`);
    if (method === "connect") {
      const secret = params[1] || "";
      if (fresh.has(secret)) {
        fresh.delete(secret);
        clients.add(from);
        return reply(from, id, secret || "ack");
      }
      if (clients.has(from)) return reply(from, id, "ack");
      stats.refused++;
      return reply(from, id, null, secret ? "invalid secret: this connection link was already used" : "no permission: unknown client");
    }
    if (!clients.has(from)) { stats.refused++; return reply(from, id, null, "no permission: this client never connected"); }
    if (method === "ping") return reply(from, id, "pong");
    if (method === "get_public_key") return reply(from, id, userPub);
    if (method === "sign_event") {
      const t = JSON.parse(params[0]);
      const signed = finalizeEvent({ kind: t.kind, created_at: t.created_at, tags: t.tags || [], content: t.content || "" }, userKey);
      stats.signed.push(signed.kind);
      return reply(from, id, JSON.stringify(signed));
    }
    if (method === "nip44_encrypt") return reply(from, id, nip44.encrypt(params[1], nip44.getConversationKey(userKey, params[0])));
    if (method === "nip44_decrypt") return reply(from, id, nip44.decrypt(params[1], nip44.getConversationKey(userKey, params[0])));
    return reply(from, id, null, `unsupported method ${method}`);
  };

  const sub = pool.subscribe(relays, { kinds: [24133], "#p": [signerPub], since: Math.floor(Date.now() / 1000) - 5 }, {
    onevent: (ev) => { handle(ev).catch((e) => log(`bunker  error ${e.message}`)); },
  });
  await new Promise((r) => setTimeout(r, 300));

  return {
    userPub, signerPub, stats, clients,
    uri() {
      const secret = randomBytes(12).toString("hex");
      fresh.add(secret);
      return `bunker://${signerPub}?relay=${encodeURIComponent(relay)}&secret=${secret}`;
    },
    close() { try { sub.close(); } catch {} pool.close(relays); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const relay = arg("relay") || `ws://127.0.0.1:${process.env.DEVNET_RELAY_PORT || 4869}`;
  const sec = arg("sec") || process.env.MOCK_BUNKER_SEC;
  if (!sec) { console.error("mock-bunker: pass --sec=<hex|nsec> (or MOCK_BUNKER_SEC)"); process.exit(1); }
  const bunker = await startBunker({ relay, secretKey: sec, log: process.argv.includes("--quiet") ? () => {} : console.log });
  const port = Number(arg("port") || 4873);
  createServer((q, r) => {
    if (q.url === "/new") { r.writeHead(200, { "Content-Type": "text/plain" }); return r.end(bunker.uri() + "\n"); }
    r.writeHead(200, { "Content-Type": "application/json" });
    r.end(JSON.stringify({ user: nip19.npubEncode(bunker.userPub), clients: [...bunker.clients], ...bunker.stats }) + "\n");
  }).listen(port, "127.0.0.1");
  console.log(`mock bunker for ${nip19.npubEncode(bunker.userPub)} on ${relay}`);
  console.log(`  new link: curl -s http://127.0.0.1:${port}/new`);
  console.log(`  ${bunker.uri()}`);
}
