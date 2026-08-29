#!/usr/bin/env node
// Publish Markdown drafts as kind-30023 long-form events.
//
//   NOSTR_BUNKER_URI="bunker://…" node tools/publish-articles.mjs draft.md …
//
// A draft carries three lines of front matter before a --- rule: Title, Summary
// and Suggested slug. The slug is the article's permanent address, so publishing
// again under the same one is an edit rather than a second article.
import { readFileSync } from "node:fs";
import { SimplePool } from "nostr-tools";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { generateSecretKey } from "nostr-tools";
import WebSocket from "ws";
useWebSocketImplementation(WebSocket);

const R = ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom", "wss://relay.nsite.lol"];
const files = process.argv.slice(2);

const bp = await parseBunkerInput(process.env.NOSTR_BUNKER_URI);
const signer = BunkerSigner.fromBunker(generateSecretKey(), bp);
const deadline = (p, what) => Promise.race([p, new Promise((_, rej) =>
  setTimeout(() => rej(new Error(`${what}: no answer in 60s. Is the signer awake?`)), 60000))]);
process.stderr.write("connecting to the signer…\n");
try { await deadline(signer.connect(), "connect"); }
catch (e) { const m = String(e?.message ?? e); if (!/already connected/i.test(m)) { console.error(m); process.exit(1); } }
const pubkey = await deadline(signer.getPublicKey(), "get_public_key");
console.log("signing as", pubkey.slice(0, 16) + "…");

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
}
pool.close(R);
await signer.close().catch(() => {});
process.exit(0);
