// A Cashu wallet, small enough to be worth having and small enough to read.
//
// This is bearer money in a page a gateway serves, so it is deliberately not a
// wallet you keep anything in. It exists to take one payment, cut it in two and
// send both halves onward in the same breath, then be empty again. Nothing is
// held across a page load. The strongest defence against a hostile gateway is
// having nothing worth stealing when it arrives.
//
// It is hand-written rather than pulled from a library because everything hard
// was already paid for: secp256k1 point arithmetic, sha256 and base64 are all in
// the bundle for Nostr. cashu-ts would add 186 KB to do the same four curve
// operations. Measured, not assumed.
//
// Every number here is checked against the official vectors in
// cashubtc/nuts/tests, which test/cashu.mjs runs. Do not change the maths
// without running them.
//
// The two ways to lose somebody's money, both guarded below:
//
//   1. An interrupted swap or mint. Once the request is sent the inputs are
//      spent, and if the reply is lost the outputs are gone unless they can be
//      regenerated. That is why secrets are derived from a seed and a counter
//      (NUT-13) rather than drawn at random: the same counter rebuilds the same
//      outputs, and NUT-09 restore finds them at the mint. The counter is
//      written down before the request, never after.
//   2. A mint that signs with a key it made up for one user, which fingerprints
//      them and cannot be proven wrong offline. NUT-12 DLEQ catches it, so every
//      proof is verified when the mint supplies the proof to verify.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad, base64 } from "@scure/base";
import { HDKey } from "@scure/bip32";

// @noble/curves 2.x calls it Point and exposes the curve parameters through a
// function rather than a constant.
const Point = secp256k1.Point;
const ORDER = Point.CURVE().n;

// ---------------------------------------------------------------- NUT-00 BDHKE

// Domain separation keeps this hash from colliding with any other use of
// sha256 over the same bytes. These are the separator's own bytes, not a hash
// of them: hashing them first is self-consistent and produces points that no
// mint agrees with, which the official vectors catch immediately.
const DOMAIN = utf8ToBytes("Secp256k1_HashToCurve_Cashu_");

/** Map arbitrary bytes onto a curve point, by counter until one lands. */
export function hashToCurve(message) {
  const base = sha256(concatBytes(DOMAIN, message));
  for (let counter = 0; counter < 0x10000; counter++) {
    const le = new Uint8Array(4);
    new DataView(le.buffer).setUint32(0, counter, true);
    try {
      return Point.fromHex("02" + bytesToHex(sha256(concatBytes(base, le))));
    } catch { /* not on the curve; try the next counter */ }
  }
  throw new Error("No curve point for this secret");
}

/** B_ = Y + rG, the blinded message the mint signs without seeing the secret. */
export function blind(secretBytes, r) {
  const Y = hashToCurve(secretBytes);
  return Y.add(Point.BASE.multiply(r));
}

/** C = C_ - rK, unblinding the mint's signature into a spendable proof. */
export function unblind(Cq, r, K) {
  return Cq.subtract(K.multiply(r));
}

// ---------------------------------------------------------------- NUT-12 DLEQ

/**
 * Verify the mint signed with the same key it publishes.
 *
 * Without this a mint can sign each user with a distinct key, which both
 * fingerprints them and makes a proof unprovable offline. Returns false rather
 * than throwing, so a mint that omits the proof is a missing check and not a
 * crash; the caller decides whether missing is acceptable.
 */
export function verifyDleq(dleq, Bq, Cq, K) {
  try {
    const e = hexToBytes(dleq.e), s = hexToBytes(dleq.s);
    const eNum = bytesToNumber(e), sNum = bytesToNumber(s);
    const R1 = Point.BASE.multiply(sNum).subtract(K.multiply(eNum));
    const R2 = Bq.multiply(sNum).subtract(Cq.multiply(eNum));
    const hash = sha256(utf8ToBytes(
      [R1, R2, K, Cq].map((p) => p.toHex(false)).join("")
    ));
    return bytesToHex(hash) === dleq.e;
  } catch { return false; }
}

function bytesToNumber(b) { return BigInt("0x" + bytesToHex(b)); }

// ------------------------------------------------------------- NUT-13 secrets

/**
 * Secrets derived from a seed, so an interrupted request is recoverable.
 *
 * The path is NUT-13's: m/129372'/0'/{keyset}'/{counter}'/{0 secret, 1 blinding}.
 * The seed is 64 random bytes rather than a BIP39 phrase, because this wallet is
 * never meant to hold a balance worth importing elsewhere and the English
 * wordlist costs 16 KB gzipped that every reader of every page would carry.
 */
export function derive(seed, keysetId, counter) {
  const master = HDKey.fromMasterSeed(seed);
  const base = `m/129372'/0'/${keysetIdInt(keysetId)}'/${counter}'`;
  const secretKey = master.derive(`${base}/0`).privateKey;
  const blindKey = master.derive(`${base}/1`).privateKey;
  if (!secretKey || !blindKey) throw new Error("Could not derive a secret");
  // NUT-13: the secret is the hex of the derived key, as text.
  return { secret: utf8ToBytes(bytesToHex(secretKey)), r: bytesToNumber(blindKey) % ORDER };
}

/** A keyset id as the integer NUT-13's derivation path wants. */
export function keysetIdInt(id) {
  return Number(BigInt("0x" + id) % 2147483647n);
}

// ------------------------------------------------------------------- amounts

/** The powers of two a sum is made of, smallest first. */
export function splitAmount(n) {
  const out = [];
  for (let p = 1; n > 0; p <<= 1, n >>= 1) if (n & 1) out.push(p);
  return out;
}

/**
 * The denominations to ask a mint for so a payment can be cut up afterwards
 * without another round trip.
 *
 * This is the whole reason Simple setup works with one invoice. The canonical
 * decomposition of 2000 is [16,64,128,256,512,1024], and no subset of it sums to
 * 1000: without the 1024 the most reachable is 976. Asking for the union of two
 * 1000s instead gives two clean halves, costs nothing because minting has no
 * inputs and therefore no NUT-02 fee, and needs no swap.
 */
export function outputsFor(parts) {
  return parts.flatMap(splitAmount).sort((a, b) => a - b);
}

/** NUT-02: ceil(sum of per-proof fees / 1000), charged on inputs only. */
export function inputFee(proofs, feesByKeyset) {
  const ppk = proofs.reduce((n, p) => n + (feesByKeyset[p.id] ?? 0), 0);
  return Math.ceil(ppk / 1000);
}

// -------------------------------------------------------------- token codec

/** Decode cashuA (v3 JSON) or cashuB (v4 CBOR). */
export function decodeToken(token) {
  const text = String(token).trim();
  if (text.startsWith("cashuA")) {
    const json = JSON.parse(new TextDecoder().decode(b64(text.slice(6))));
    const entry = json.token?.[0];
    if (!entry) throw new Error("This token carries nothing");
    return { mint: entry.mint, unit: json.unit || "sat", proofs: entry.proofs, memo: json.memo };
  }
  if (text.startsWith("cashuB")) {
    const d = decodeCbor(b64(text.slice(6)));
    const proofs = (d.t || []).flatMap((e) =>
      (e.p || []).map((p) => ({ id: bytesToHex(e.i), amount: p.a, secret: p.s, C: bytesToHex(p.c) })));
    return { mint: d.m, unit: d.u || "sat", proofs, memo: d.d };
  }
  throw new Error("That is not a Cashu token.");
}

/** Encode as cashuA, which every wallet and every mint reads. */
export function encodeToken({ mint, unit = "sat", proofs, memo }) {
  const body = { token: [{ mint, proofs }], unit };
  if (memo) body.memo = memo;
  return "cashuA" + base64urlnopad.encode(utf8ToBytes(JSON.stringify(body)));
}

function b64(s) {
  // Tokens in the wild carry padding NUT-00 says they should not.
  const clean = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  return base64.decode(clean + "=".repeat((4 - (clean.length % 4)) % 4));
}

// A CBOR subset: just enough for a v4 token, which is maps, arrays, byte
// strings, text strings and small unsigned integers.
function decodeCbor(bytes) {
  let i = 0;
  const read = () => {
    const b = bytes[i++], major = b >> 5, info = b & 31;
    const len = info < 24 ? info
      : info === 24 ? bytes[i++]
      : info === 25 ? ((bytes[i++] << 8) | bytes[i++])
      : info === 26 ? (new DataView(bytes.buffer, bytes.byteOffset + (i += 4) - 4, 4).getUint32(0))
      : (() => { throw new Error("Unsupported token encoding"); })();
    switch (major) {
      case 0: return len;
      case 2: { const v = bytes.slice(i, i + len); i += len; return v; }
      case 3: { const v = new TextDecoder().decode(bytes.slice(i, i + len)); i += len; return v; }
      case 4: { const a = []; for (let n = 0; n < len; n++) a.push(read()); return a; }
      case 5: { const o = {}; for (let n = 0; n < len; n++) { const k = read(); o[k] = read(); } return o; }
      default: throw new Error("Unsupported token encoding");
    }
  };
  return read();
}

export { Point };
