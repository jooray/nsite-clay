#!/usr/bin/env node
// Publish Markdown drafts as kind-30023 long-form events.
//
//   NOSTR_BUNKER_URI="bunker://…" node tools/publish-articles.mjs draft.md …
//
// A draft carries three lines of front matter before a --- rule: Title, Summary
// and Suggested slug. The slug is the article's permanent address, so publishing
// again under the same one is an edit rather than a second article.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SimplePool } from "nostr-tools";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { generateSecretKey } from "nostr-tools";
import WebSocket from "ws";
useWebSocketImplementation(WebSocket);

const R = ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom", "wss://relay.nsite.lol"];
const files = process.argv.slice(2).filter((a) => a !== "--fresh");
const fresh = process.argv.includes("--fresh");

// The bunker grants its permissions to a client keypair, so a throwaway key per
// run works exactly once: the URI's secret is spent on the first connect and
// every later run is an app the bunker has never seen. Reuse the key the CLI
// saved, so publishing an article and deploying the site are the same client.
const BUNKER_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
                         "nsite-clay", "bunkers.json");
const readBunkers = () => { try { return JSON.parse(readFileSync(BUNKER_FILE, "utf8")); } catch { return {}; } };

if (!process.env.NOSTR_BUNKER_URI) {
  console.error("publish-articles: set NOSTR_BUNKER_URI. Passing it on argv would show it in `ps`.");
  process.exit(1);
}
const bp = await parseBunkerInput(process.env.NOSTR_BUNKER_URI);
if (!bp) { console.error("could not parse that bunker:// URI"); process.exit(1); }

const stored = fresh ? null : readBunkers()[bp.pubkey];
const clientKey = stored
  ? Uint8Array.from(Buffer.from(stored.clientSecret, "hex"))
  : generateSecretKey();
const signer = BunkerSigner.fromBunker(clientKey, bp);

const deadline = (p, what) => Promise.race([p, new Promise((_, rej) =>
  setTimeout(() => rej(new Error(
    `${what}: no answer in 60s. Relays tried: ${bp.relays.join(", ")}. ` +
    `Is the signer awake and connected to at least one of them?`)), 60000))]);

process.stderr.write(`connecting to the signer${stored ? " with the saved client key" : ""}…\n`);
try { await deadline(signer.connect(), "connect"); }
catch (e) {
  const m = String(e?.message ?? e);
  if (!/already connected/i.test(m)) { console.error(m); process.exit(1); }
}
const pubkey = await deadline(signer.getPublicKey(), "get_public_key");
console.log("signing as", pubkey.slice(0, 16) + "…");

// A first connection worth keeping: the next run should not have to re-approve.
if (!stored) {
  try {
    const all = readBunkers();
    all[bp.pubkey] = { clientSecret: Buffer.from(clientKey).toString("hex"),
                       userPubkey: pubkey, saved: new Date().toISOString() };
    mkdirSync(join(BUNKER_FILE, ".."), { recursive: true });
    writeFileSync(BUNKER_FILE, JSON.stringify(all, null, 2));
    chmodSync(BUNKER_FILE, 0o600);
  } catch { /* publishing still worked; the next run just reconnects */ }
}

const pool = new SimplePool();
const now = Math.floor(Date.now() / 1000);
for (const f of files) {
  const raw = readFileSync(f, "utf8");
  const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  const summary = raw.match(/^Summary:\s*(.+)$/m)?.[1]?.trim();
  const slug = raw.match(/^Suggested slug:\s*(.+)$/m)?.[1]?.trim();
  const content = raw.split(/^---\s*$/m).slice(1).join("---").trim();
  if (!title || !slug || !content) { console.log("skipping", f, "(missing front matter)"); continue; }
  const ev = await deadline(signer.signEvent({
    kind: 30023, created_at: now,
    tags: [["d", slug], ["title", title], ["summary", summary || ""],
           ["published_at", String(now)], ["t", "nostr"], ["t", "nsite"]],
    content,
  }), "sign " + slug);
  const r = await Promise.allSettled(pool.publish(R, ev));
  const ok = r.filter((x) => x.status === "fulfilled").length;
  console.log(`  ${slug.padEnd(32)} ${ok}/${R.length} relays  ${content.length} chars`);
  console.log(`  ${" ".repeat(32)} https://njump.me/naddr… d=${slug}`);
}
pool.close(R);
await signer.close().catch(() => {});
process.exit(0);
