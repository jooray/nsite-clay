// The money maths, against the official vectors in cashubtc/nuts/tests.
//
// This file exists because an implementation of BDHKE can be perfectly
// self-consistent and still wrong. The first version here passed its own blind,
// sign, unblind round trip while hashing the domain separator that NUT-00 says
// to use raw, so every point it produced was one no mint would have agreed
// with. The round trip did not catch it. These vectors did, immediately.
//
// Run: node test/cashu.mjs
import { hashToCurve, blind, unblind, splitAmount, outputsFor, decodeToken, encodeToken, keysetIdInt, verifyDleq, derive, inputFee, Point } from "../src/cashu.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
let pass = 0, fail = 0;
const t = (name, ok, got) => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "   got " + got}`); };

// --- hash to curve, official NUT-00 vectors ---
for (const [msg, want] of [
  ["0000000000000000000000000000000000000000000000000000000000000000","024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725"],
  ["0000000000000000000000000000000000000000000000000000000000000001","022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf"],
  ["0000000000000000000000000000000000000000000000000000000000000002","026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f"],
]) {
  const got = hashToCurve(hexToBytes(msg)).toHex(true);
  t(`hash_to_curve ${msg.slice(-1)}`, got === want, got);
}

// --- blinded messages ---
for (const [x, r, want] of [
  ["d341ee4871f1f889041e63cf0d3823c713eea6aff01e80f1719f08f9e5be98f6","99fce58439fc37412ab3468b73db0569322588f62fb3a49182d67e23d877824a","033b1a9737a40cc3fd9b6af4b723632b76a67a36782596304612a6c2bfb5197e6d"],
  ["f1aaf16c2239746f369572c0784d9dd3d032d952c2d992175873fb58fae31a60","f78476ea7cc9ade20f9e05e58a804cf19533f03ea805ece5fee88c8e2874ba50","029bdf2d716ee366eddf599ba252786c1033f47e230248a4612a5670ab931f1763"],
]) {
  const got = blind(hexToBytes(x), BigInt("0x"+r)).toHex(true);
  t("blinded message", got === want, got);
}

// --- blinded signatures (we play the mint) ---
for (const [k, B_, want] of [
  ["0000000000000000000000000000000000000000000000000000000000000001","02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2","02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2"],
  ["7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f","02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2","0398bc70ce8184d27ba89834d19f5199c84443c31131e48d3c1214db24247d005d"],
]) {
  const got = Point.fromHex(B_).multiply(BigInt("0x"+k)).toHex(true);
  t("blind signature", got === want, got);
}

// --- full round trip: blind, sign as the mint, unblind, verify k*Y == C ---
{
  const k = BigInt("0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f");
  const K = Point.BASE.multiply(k);
  const secret = hexToBytes("d341ee4871f1f889041e63cf0d3823c713eea6aff01e80f1719f08f9e5be98f6");
  const r = BigInt("0x99fce58439fc37412ab3468b73db0569322588f62fb3a49182d67e23d877824a");
  const Bq = blind(secret, r);
  const Cq = Bq.multiply(k);
  const C = unblind(Cq, r, K);
  const expected = hashToCurve(secret).multiply(k);
  t("blind, sign, unblind round trip", C.toHex(true) === expected.toHex(true), C.toHex(true));
}

// --- amounts ---
t("splitAmount(1000)", JSON.stringify(splitAmount(1000)) === "[8,32,64,128,256,512]", JSON.stringify(splitAmount(1000)));
t("splitAmount(2000) cannot be halved", !(() => {
  const c = splitAmount(2000);
  const seen = new Set([0]);
  for (const v of c) for (const s of [...seen]) seen.add(s + v);
  return seen.has(1000);
})());
t("outputsFor([1000,1000]) sums to 2000 in two halves",
  outputsFor([1000,1000]).reduce((a,b)=>a+b,0) === 2000 && outputsFor([1000,1000]).length === 12);
t("keysetIdInt is in range", keysetIdInt("009a1f293253e41e") < 2147483647);

// --- NUT-12 DLEQ: play the mint, produce a real proof, then check it ---
{
  const k = BigInt("0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f");
  const K = Point.BASE.multiply(k);
  const secret = hexToBytes("d341ee4871f1f889041e63cf0d3823c713eea6aff01e80f1719f08f9e5be98f6");
  const r = BigInt("0x99fce58439fc37412ab3468b73db0569322588f62fb3a49182d67e23d877824a");
  const Bq = blind(secret, r);
  const Cq = Bq.multiply(k);
  const ORDER = Point.CURVE().n;
  const nonce = BigInt("0x" + "42".repeat(32)) % ORDER;
  const R1 = Point.BASE.multiply(nonce), R2 = Bq.multiply(nonce);
  const e = sha256(utf8ToBytes([R1, R2, K, Cq].map((p) => p.toHex(false)).join("")));
  const sNum = (nonce + (BigInt("0x" + bytesToHex(e)) * k)) % ORDER;
  const dleq = { e: bytesToHex(e), s: sNum.toString(16).padStart(64, "0") };
  t("a real DLEQ proof verifies", verifyDleq(dleq, Bq, Cq, K) === true);
  // A mint that signed with a different key, or tampered with C_, must fail.
  t("a tampered C_ is rejected", verifyDleq(dleq, Bq, Cq.add(Point.BASE), K) === false);
  t("a wrong mint key is rejected", verifyDleq(dleq, Bq, Cq, Point.BASE.multiply(k + 1n)) === false);
  t("a missing proof is a false, not a throw", verifyDleq({}, Bq, Cq, K) === false);
}

// --- NUT-13: the same counter must rebuild the same secret ---
{
  const seed = new Uint8Array(64).fill(7);
  const a = derive(seed, "009a1f293253e41e", 0);
  const b = derive(seed, "009a1f293253e41e", 0);
  const c = derive(seed, "009a1f293253e41e", 1);
  t("the same counter derives the same secret", bytesToHex(a.secret) === bytesToHex(b.secret) && a.r === b.r);
  t("a different counter derives a different one", bytesToHex(a.secret) !== bytesToHex(c.secret));
  const other = derive(new Uint8Array(64).fill(8), "009a1f293253e41e", 0);
  t("a different seed derives a different one", bytesToHex(a.secret) !== bytesToHex(other.secret));
}

// --- NUT-02 fees ---
{
  const proofs = Array.from({ length: 12 }, () => ({ id: "x" }));
  t("twelve inputs at 100 ppk cost 2", inputFee(proofs, { x: 100 }) === 2);
  t("twelve inputs at 0 ppk cost nothing", inputFee(proofs, { x: 0 }) === 0);
  t("ten inputs at 100 ppk cost exactly 1", inputFee(proofs.slice(0, 10), { x: 100 }) === 1);
}

// --- token codec ---
{
  const tok = encodeToken({ mint: "https://cashu.cz", proofs: [{ id:"009a1f293253e41e", amount:2, secret:"abc", C:"02aaa" }] });
  const back = decodeToken(tok);
  t("cashuA round trip", back.mint === "https://cashu.cz" && back.proofs[0].amount === 2 && back.unit === "sat");
}
console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail ? 1 : 0);
