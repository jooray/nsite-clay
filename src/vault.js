// The owner's secrets, kept where the owner already is.
//
// Two things now belong to whoever holds the key to a page and to nothing else:
// the AI credit they paid for, and the wallet seed behind it. Neither can live
// in the document, because a published page is public and its whole history is
// public with it. Until now they lived in this browser's localStorage and the
// only way to move them was to download a file, which is a chore people do not
// do and cannot do on a phone.
//
// So they live on the owner's own relays, in one replaceable event, encrypted
// to the owner's own key. Any device that can sign for that key can read them
// back; nobody else can read them at all. There is no account, no server and
// nothing new to back up, because the key that already proves ownership of the
// page is the key that opens this.
//
// NIP-78 (kind 30078) rather than NIP-60: this is application data, not a
// wallet other clients are expected to share. Leaking that an npub uses
// nsite-clay costs nothing, since that npub published an nsite-clay page in
// public.
//
// Every failure here is survivable by design. A signer that cannot encrypt, a
// relay that will not answer, a decrypt that fails: each one leaves the secret
// where it already was, in this browser, and says so. Nothing in here may cost
// somebody the thing they were in the middle of doing.

const KIND = 30078;
const TAG = "nsite-clay";

export class Vault {
  constructor(nc) { this.nc = nc; this.loaded = null; }

  /** Whether this signer can do the encryption at all. */
  get usable() {
    const s = this.nc.signer;
    return !!(s && typeof s.nip44Encrypt === "function" && typeof s.nip44Decrypt === "function");
  }

  relays() {
    const list = this.nc.cfg?.relays || [];
    return list.length ? list : ["wss://relay.nsite.lol", "wss://nos.lol"];
  }

  /**
   * Read the vault. Returns an object, `{}` when there is nothing stored yet,
   * and null when it could not be read at all, which is a different thing: an
   * empty vault may be written over, an unreadable one must not be.
   */
  async load({ force = false } = {}) {
    if (this.loaded && !force) return this.loaded;
    if (!this.usable || !this.nc.pubkey) return null;
    let event;
    try {
      event = await this.nc.pool.get(this.relays(), {
        kinds: [KIND], authors: [this.nc.pubkey], "#d": [TAG], limit: 1,
      });
    } catch { return null; }
    if (!event) return (this.loaded = {});
    try {
      const plain = await this.nc.signer.nip44Decrypt(this.nc.pubkey, event.content);
      const data = JSON.parse(plain);
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      this.at = Math.max(this.at || 0, event.created_at);
      return (this.loaded = data);
    } catch {
      // Readable event, unreadable contents: a different key wrote it, or the
      // signer refused. Either way this is not an empty vault and must not be
      // treated as one.
      return null;
    }
  }

  /**
   * Merge `patch` into the vault and publish it.
   *
   * Reads first so a second device does not erase what the first one saved.
   * Returns true only when a relay accepted it.
   */
  async save(patch) {
    if (!this.usable || !this.nc.pubkey) return false;
    const current = await this.load({ force: true });
    if (current === null) throw new Error("The stored copy could not be read, so it was not overwritten.");
    // A replaceable event does not replace one with the same created_at: NIP-01
    // breaks that tie by event id, so the newer write is dropped on a coin flip
    // and says it succeeded. Several writes inside one second is not a corner
    // case here, it is what buying credit does, so each one gets a later second
    // than the last whatever the clock says.
    const at = Math.max(Math.floor(Date.now() / 1000), (this.at || 0) + 1);
    const next = { ...current, ...patch, v: 1, updated: at };
    const content = await this.nc.signer.nip44Encrypt(this.nc.pubkey, JSON.stringify(next));
    const event = await this.nc.signer.sign({
      kind: KIND, created_at: at,
      tags: [["d", TAG]], content,
    });
    const relays = this.relays();
    const results = await Promise.allSettled(this.nc.pool.publish(relays, event));
    const ok = results.some((r) => r.status === "fulfilled");
    if (ok) { this.loaded = next; this.at = at; }
    return ok;
  }

  /** Forget the local copy, so the next read comes from the relays. */
  forget() { this.loaded = null; }
}
