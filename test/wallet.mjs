// The wallet's arithmetic, and the one property everything else rests on:
// money that went out can be rebuilt from the seed and the counter.
//
// The network paths are exercised against a mint simulated here rather than a
// real one, because a real one costs real satoshis per run. What that does and
// does not prove is written at the bottom.
//
// Run: node test/wallet.mjs
import { Wallet } from "../src/wallet.js";
import { outputsFor, splitAmount, derive, blind, unblind, Point, decodeToken, encodeToken } from "../src/cashu.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

let pass = 0, fail = 0;
const t = (name, ok, got = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "   " + got}`); };

// --- a mint that really signs, so proofs are real ----------------------------
const MINT = "https://mint.test";
const KEYSET = "009a1f293253e41e";
const k = {};                       // one private key per denomination, as a mint has
for (let a = 1; a <= 1 << 20; a <<= 1) k[a] = BigInt("0x" + bytesToHex(new Uint8Array(32).fill(a % 251 || 7)));
const pub = Object.fromEntries(Object.entries(k).map(([a, key]) => [a, Point.BASE.multiply(key).toHex(true)]));

const calls = [];
const issued = new Map();
let loseMintReply = false;
const fakeFetch = async (url, opts) => {
  const path = String(url).replace(MINT + "/v1/", "");
  const body = opts?.body ? JSON.parse(opts.body) : undefined;
  calls.push(path);
  const reply = (o) => ({ ok: true, json: async () => o });
  if (path === "keysets") return reply({ keysets: [{ id: KEYSET, unit: "sat", active: true, input_fee_ppk: 0 }] });
  if (path.startsWith("keys/")) return reply({ keysets: [{ id: KEYSET, unit: "sat", keys: pub }] });
  if (path === "mint/quote/bolt11") return reply({ quote: "q1", request: "lnbc...", state: "UNPAID" });
  if (path.startsWith("mint/quote/bolt11/")) return reply({ quote: "q1", state: "PAID" });
  if (path === "restore") {
    const outputs = body.outputs.filter((o) => issued.has(o.B_)).reverse();
    return reply({ outputs, signatures: outputs.map((o) => issued.get(o.B_)) });
  }
  if (path === "mint/bolt11" || path === "swap") {
    const signatures = body.outputs.map((o) => ({
      id: o.id, amount: o.amount, C_: Point.fromHex(o.B_).multiply(k[o.amount]).toHex(true),
    }));
    body.outputs.forEach((o, i) => issued.set(o.B_, signatures[i]));
    if (loseMintReply) { loseMintReply = false; throw new Error("Connection dropped after the mint signed"); }
    return reply({ signatures });
  }
  throw new Error("unexpected " + path);
};

// --- a vault that behaves like the real one ----------------------------------
let stored = {};
const nc = {
  vault: {
    usable: true,
    async load() { return stored; },
    async save(patch) { stored = { ...stored, ...patch }; return true; },
  },
};
const w = new Wallet(nc);
globalThis.fetch = fakeFetch;

// --- denominations chosen so a split needs no swap ---------------------------
t("2000 asks for two halves, not the canonical six",
  JSON.stringify(outputsFor([1000, 1000])) === "[8,8,32,32,64,64,128,128,256,256,512,512]");
t("and the canonical 2000 could not have been halved",
  !(() => { const c = splitAmount(2000); const s = new Set([0]); for (const v of c) for (const x of [...s]) s.add(x + v); return s.has(1000); })());

// --- minting produces two real tokens ----------------------------------------
const [credit, donation] = await w.mint(MINT, KEYSET, "q1", [1000, 1000]);
const a = decodeToken(credit), b = decodeToken(donation);
t("two tokens come out", !!credit && !!donation);
t("each is worth exactly 1000",
  a.proofs.reduce((n, p) => n + p.amount, 0) === 1000 && b.proofs.reduce((n, p) => n + p.amount, 0) === 1000);
t("no proof is in both", !a.proofs.some((p) => b.proofs.some((q) => q.secret === p.secret)));
t("no swap was needed", !calls.includes("swap"), calls.join(","));

// --- the proofs are ones the mint would actually accept ----------------------
{
  const p = a.proofs[0];
  const { hashToCurve } = await import("../src/cashu.js");
  const expected = hashToCurve(new TextEncoder().encode(p.secret)).multiply(k[p.amount]);
  t("a proof satisfies k*H2C(secret) == C", expected.toHex(true) === p.C, p.C);
}

// --- the counter is what makes a dropped connection survivable ---------------
t("the counter was written before the mint was asked", stored.wallet.counter === 12);
{
  const seed = hexToBytes(stored.wallet.seed);
  const again = derive(seed, KEYSET, 0);
  const first = a.proofs.concat(b.proofs).find((p) => p.secret === new TextDecoder().decode(again.secret));
  t("and the same counter rebuilds a secret that was issued", !!first);
}
{
  const before = stored.wallet.counter;
  await w.reserve(3);
  t("reserving again never reuses a counter", stored.wallet.counter === before + 3);
}

// --- a vault that will not save must stop the spend, not risk it -------------
{
  const w2 = new Wallet({ vault: { usable: true, async load() { return stored; }, async save() { return false; } } });
  let msg = "";
  try { await w2.reserve(2); } catch (e) { msg = e.message; }
  t("a counter that cannot be saved stops the spend", /nothing was spent/.test(msg), msg);
}

// A fresh Wallet instance has no in-memory transaction state. It must restore
// the exact issued outputs, even when the mint returns them in a different order.
{
  stored = {}; calls.length = 0;
  loseMintReply = true;
  try { await new Wallet(nc).mint(MINT, KEYSET, "lost-reply", [1000, 1000]); } catch {}
  t("a lost mint reply leaves its quote and counters on relays", stored.wallet.mint.quote === "lost-reply" && stored.wallet.counter === 12);
  const tokens = await new Wallet(nc).mint(MINT, KEYSET, "lost-reply", [1000, 1000]);
  t("a new browser restores both halves", tokens.every((token) => decodeToken(token).proofs.reduce((sum, p) => sum + p.amount, 0) === 1000));
  t("restoration never mints or reserves twice", calls.filter((p) => p === "mint/bolt11").length === 1 && stored.wallet.counter === 12);
  await w.finishMint();
  t("recovery metadata clears only after the caller parks the tokens", !stored.wallet.mint && stored.wallet.counter === 12);
}
{
  stored = {}; calls.length = 0;
  const refused = new Wallet({ vault: { usable: true, async load() { return stored; }, async save() { return false; } } });
  try { await refused.mint(MINT, KEYSET, "unsaved", [1000, 1000]); } catch {}
  t("no payment is collected when its recovery record cannot be saved", !calls.includes("mint/bolt11"));
}

// --- splitting a token somebody already holds --------------------------------
{
  stored = {};
  const fresh = new Wallet(nc);
  const [whole] = await fresh.mint(MINT, KEYSET, "q1", [2000]);
  const out = await fresh.split(whole, [1000, 1000]);
  const sums = out.parts.map((tok) => decodeToken(tok).proofs.reduce((n, p) => n + p.amount, 0));
  t("a held token splits into the parts asked for", JSON.stringify(sums) === "[1000,1000]", JSON.stringify(sums));
  t("and that one did need a swap", calls.includes("swap"));
}

// --- refusing is better than approximating -----------------------------------
{
  let msg = "";
  try { new Wallet(nc).cut([{ amount: 8, id: "x", secret: "s", C: "c" }], [1000], MINT); }
  catch (e) { msg = e.message; }
  t("coins that do not add up are refused", /do not add up/.test(msg), msg);
}

console.log(`\n${pass}/${pass + fail} passed`);
console.log("\nNot covered here: a real mint's responses, a real Lightning payment, and");
console.log("a real mint's NUT-09 compatibility. Lost replies and reordered restore");
console.log("responses are simulated above; no satoshi has moved.");
process.exit(fail ? 1 : 0);
