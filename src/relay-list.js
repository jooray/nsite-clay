// A gateway finds a site through its owner's relay list (kind 10002), which it
// looks up on these two relays before reading the manifest from the relays on
// the list. A key that has never published one is found only on relays a
// gateway's operator happens to read, so a first site from a fresh key shows on
// nsite.lol and answers 404 elsewhere.
export const LOOKUP_RELAYS = ["wss://purplepag.es", "wss://user.kindpag.es"];

// Accepts relay lists and manifests and refuses everything else, so it belongs
// in the set a list is sent to and never in the list: a client told to post a
// note there would be turned away.
const LIST_ONLY = new Set(["wss://relay.nsite.lol"]);
const norm = (url) => String(url).trim().replace(/\/+$/, "");
// A devnet on this machine is a world of its own: there the local relays are
// the only place a list could be, and the public lookup relays are never asked
// or written to.
const isLocal = (url) => /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);

/** What one relay says about a filter: the events, or null if it did not answer. */
async function ask(pool, url, filter, ms) {
  let relay;
  try { relay = await pool.ensureRelay(url, { connectionTimeout: ms }); } catch { return null; }
  return new Promise((resolve) => {
    const found = [];
    let sub;
    const timer = setTimeout(() => { try { sub?.close(); } catch {} resolve(null); }, ms);
    try {
      sub = relay.subscribe([filter], {
        onevent: (ev) => found.push(ev),
        // Settle before closing: closing fires onclose at once, and the first
        // settle wins, so the other order reports every answer as silence.
        oneose: () => { clearTimeout(timer); resolve(found); try { sub.close(); } catch {} },
        onclose: () => { clearTimeout(timer); resolve(null); },
      });
    } catch { clearTimeout(timer); resolve(null); }
  });
}

/**
 * Publish a relay list for `pubkey` naming `relays`, but only when it provably
 * has none. A relay list is part of somebody's Nostr identity and a new one
 * replaces the old, so "none found" counts only when both lookup relays
 * answered: a lookup that timed out could be hiding the list their client
 * wrote, and overwriting that would break their Nostr everywhere else.
 *
 * Resolves to "written", "present", "unknown" (a lookup relay did not answer,
 * so nothing was written), "empty" (no relay to list), or "failed" (nobody
 * accepted it). Never throws: a site is live whatever happens here.
 */
export async function ensureRelayList(pool, signer, pubkey, relays, { timeout = 6000 } = {}) {
  try {
    const listed = [...new Set(relays.map(norm))].filter((r) => /^wss?:\/\//.test(r) && !LIST_ONLY.has(r));
    const deployed = relays.map(norm);
    const lookups = deployed.length && deployed.every(isLocal) ? deployed : LOOKUP_RELAYS;
    const where = [...new Set([...lookups, ...deployed])];
    const answers = await Promise.all(where.map((url) => ask(pool, url, { kinds: [10002], authors: [pubkey], limit: 1 }, timeout)));
    if (answers.some((a) => a?.some((ev) => ev.pubkey === pubkey && ev.kind === 10002))) return "present";
    if (lookups.some((url) => answers[where.indexOf(url)] === null)) return "unknown";
    if (!listed.length) return "empty";
    const event = await signer.sign({ kind: 10002, created_at: Math.floor(Date.now() / 1000), tags: listed.map((r) => ["r", r]), content: "" });
    const sent = await Promise.allSettled(pool.publish(where, event));
    return sent.some((r) => r.status === "fulfilled") ? "written" : "failed";
  } catch {
    return "failed";
  }
}
