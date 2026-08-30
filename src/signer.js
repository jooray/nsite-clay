// Signer abstraction: NIP-07 extension, NIP-46 remote signer (Amber, nsec.app),
// or a raw key for local demos. Every signer exposes the same two members the
// rest of the runtime needs: `pubkey` and `sign(template)`.
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import * as nip49 from "nostr-tools/nip49";
import { BunkerSigner, createAccount, createNostrConnectURI, parseBunkerInput } from "nostr-tools/nip46";

// Ask only for what the runtime actually signs. Every entry costs characters in
// the connect URI and therefore modules in the QR code, so this is the list of
// kinds the runtime really does sign, and nothing kept "just in case":
// the nsite manifest and its versions, Blossom uploads, the two relay lists the
// settings dialog writes, and the notes and articles the composer publishes.
const DEFAULT_PERMS = [
  "get_public_key",
  "sign_event:15128", "sign_event:35128", "sign_event:5128",
  "sign_event:24242",
  "sign_event:10002", "sign_event:10063",
  "sign_event:1", "sign_event:30023",
];

export class Nip07Signer {
  static available() { return typeof window !== "undefined" && !!window.nostr; }
  constructor() { this.kind = "nip07"; this.pubkey = null; }
  async connect() {
    if (!window.nostr) throw new Error("No NIP-07 extension found");
    this.pubkey = await window.nostr.getPublicKey();
    return this.pubkey;
  }
  async sign(template) { return window.nostr.signEvent(template); }
  async close() {}
}

// A key typed or pasted straight into the page. Accepts an `nsec`, a raw
// 64-hex secret, or a NIP-49 `ncryptsec` with its password. The key stays in
// memory for the session and is never written anywhere -- see SPECIFICATION.md
// §8.2 for why this is the weakest of the three signers.
export class LocalSigner {
  constructor(secret) {
    this.kind = "local";
    this.sec = typeof secret === "string" ? LocalSigner.parse(secret) : (secret || generateSecretKey());
    if (!(this.sec instanceof Uint8Array) || this.sec.length !== 32) {
      throw new Error("Secret key must be 32 bytes");
    }
    this.pubkey = getPublicKey(this.sec);
  }

  // Async because ncryptsec needs a password and scrypt is not instant.
  static async fromInput(input, password) {
    const raw = String(input || "").trim();
    if (!raw) throw new Error("Enter a key");
    if (raw.startsWith("ncryptsec")) {
      if (!password) throw new Error("That is an encrypted key. Enter its password too");
      let sec;
      try { sec = nip49.decrypt(raw, password); }
      catch { throw new Error("Wrong password, or the ncryptsec is malformed"); }
      return new LocalSigner(sec);
    }
    return new LocalSigner(raw);
  }

  static parse(input) {
    const raw = String(input || "").trim();
    if (!raw) throw new Error("Enter a key");
    // The two mistakes people actually make, named rather than left as
    // "invalid checksum": a public key, and a key with a stray space in it.
    if (raw.startsWith("npub")) throw new Error("That is a public key. Signing needs the nsec.");
    if (raw.startsWith("ncryptsec")) throw new Error("That key is encrypted and needs a password");
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return hexToBytes(raw.toLowerCase());
    if (raw.startsWith("nsec")) {
      let decoded;
      try { decoded = nip19.decode(raw); }
      catch { throw new Error("That nsec is not valid. Check for a missing or mistyped character"); }
      if (decoded.type !== "nsec") throw new Error(`That is a ${decoded.type}, not an nsec`);
      return decoded.data;
    }
    throw new Error("Not a key: expected nsec1…, ncryptsec1…, or 64 hex characters");
  }

  // Turn a key into something safe enough to write down: NIP-49, scrypt-hardened.
  static encrypt(secret, password, logn = 16) {
    return nip49.encrypt(typeof secret === "string" ? LocalSigner.parse(secret) : secret, password, logn);
  }

  async connect() { return this.pubkey; }
  async sign(template) { return finalizeEvent(template, this.sec); }
  async close() { this.sec = null; }
}

// NIP-46. Two entry points:
//   fromBunkerUri  — the user pastes bunker://... (nsec.app, nostr-connect bunkers)
//   nostrconnect   — we mint the URI and show it as a QR for Amber to scan
export class Nip46Signer {
  constructor(bunker, clientSecret) {
    this.kind = "nip46";
    this.bunker = bunker;
    this.clientSecret = clientSecret;
    this.pubkey = null;
  }

  static async fromBunkerUri(uri, { clientSecret } = {}) {
    const parsed = await parseBunkerInput(uri);
    if (!parsed) throw new Error("Not a bunker:// URI");
    if (!parsed.relays?.length) throw new Error("That bunker URI names no relays");
    const sec = clientSecret || generateSecretKey();
    // fromBunker, not the constructor: the constructor's second argument is
    // options, so the bunker pointer would never be set.
    const bunker = BunkerSigner.fromBunker(sec, parsed);
    // "already connected" means the bunker still holds a session for this
    // secret, which is the outcome we wanted anyway.
    try { await bunker.connect(); }
    catch (e) { if (!/already connected/i.test(String(e?.message ?? e))) throw e; }
    const signer = new Nip46Signer(bunker, sec);
    // NIP-46: event.pubkey on the transport is the remote-signer key, never the
    // user's identity. The user pubkey only comes from get_public_key.
    signer.pubkey = await bunker.getPublicKey();
    return signer;
  }

  // Client-initiated flow, the one Amber wants. Returns { uri, promise, cancel }:
  // render `uri` as a QR and a deep link, await `promise` for the connected
  // signer, and call `cancel()` if the person closes the dialog, because the
  // subscription otherwise sits on the relays until the five minute deadline.
  //
  // `url` is left out by default. A signer shows it as "who is asking", which is
  // worth something, but an nsite origin is a 76 character npub hostname and it
  // pushed the QR from 73 modules to 81. The page title in `name` says who is
  // asking in fewer bytes, and a code nobody can scan says nothing at all.
  static nostrconnect({ relays, name = "nsite-clay", url = "", perms = DEFAULT_PERMS } = {}) {
    const clientSecret = generateSecretKey();
    const clientPubkey = getPublicKey(clientSecret);
    const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const uri = createNostrConnectURI({ clientPubkey, relays, secret, perms, name, url });

    const abort = new AbortController();
    const promise = (async () => {
      // nostr-tools resolves once a kind-24133 frame decrypts to exactly this
      // one-time secret; it then pins that event.pubkey as the remote signer.
      // The abort signal is the fourth argument, in place of the default five
      // minute deadline.
      const bunker = await BunkerSigner.fromURI(clientSecret, uri, {}, abort.signal);
      const signer = new Nip46Signer(bunker, clientSecret);
      // Mandatory second phase: event.pubkey is a routing key, not an identity.
      signer.pubkey = await bunker.getPublicKey();
      return signer;
    })();
    // Nothing may await this promise if the dialog was dismissed first, and an
    // unhandled rejection is not the way to report a cancelled sign-in.
    promise.catch(() => {});

    return { uri, clientPubkey, secret, promise, cancel: () => abort.abort() };
  }

  async connect() { return this.pubkey; }
  async sign(template) { return this.bunker.signEvent(template); }
  async close() { try { await this.bunker.close(); } catch {} }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export { createAccount };
