// The wallet, which is a pipe rather than an account.
//
// It exists to take one payment, cut it into the pieces somebody asked for, and
// hand every piece onward before the page is closed. It never holds a balance
// across a page load, because bearer money sitting in a browser that a gateway
// serves is the one thing worth stealing, and having nothing is the only defence
// that does not depend on trusting the gateway.
//
// The counter is the safety mechanism and the reason this is not frightening.
// Secrets come from the vault's seed and a counter (NUT-13), and the counter is
// written to the vault BEFORE the mint is asked for anything. If the reply is
// lost, if the tab dies, if the gateway hangs, the same counter rebuilds exactly
// the same outputs and NUT-09 restore finds them at the mint. Money cannot be
// stranded by a dropped connection, only delayed.

import {
  blind, unblind, verifyDleq, derive, splitAmount, outputsFor, inputFee,
  decodeToken, encodeToken, Point,
} from "./cashu.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const TIMEOUT = 30000;

export class Wallet {
  constructor(nc) { this.nc = nc; }

  async api(mint, path, body) {
    const url = mint.replace(/\/+$/, "") + "/v1/" + path;
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json())?.detail || ""; } catch {}
      throw new Error(detail || `The mint answered ${response.status}.`);
    }
    return response.json();
  }

  /**
   * The mints a Routstr node will accept, cheapest first.
   *
   * Never hardcoded. When a mint dies the node's operator changes it in one
   * config and every already-published page follows on its next payment, which
   * is the whole point: a page cannot be sent new JavaScript.
   */
  async mints(nodeBase) {
    const info = await this.nc.ai.client.info({ ...this.nc.ai.client.session(), base: nodeBase });
    const list = (info?.mints || info?.cashu_mints || []).filter((m) => /^https:\/\//.test(m));
    if (!list.length) throw new Error("This node did not say which mints it accepts.");
    const priced = await Promise.all(list.map(async (mint) => {
      try {
        const { keysets } = await this.api(mint, "keysets");
        const active = keysets.find((k) => k.active && k.unit === "sat");
        return active ? { mint, id: active.id, fee: active.input_fee_ppk ?? 0 } : null;
      } catch { return null; }
    }));
    const usable = priced.filter(Boolean).sort((a, b) => a.fee - b.fee);
    if (!usable.length) throw new Error("None of this node's mints answered.");
    return usable;
  }

  /** The seed, made once and kept in the vault so any device can rebuild it. */
  async seed() {
    const vault = this.nc.vault;
    if (!vault?.usable) throw new Error("This signer cannot encrypt, so a wallet cannot be kept safely.");
    const data = await vault.load();
    if (data === null) throw new Error("The stored wallet could not be read, so it was not replaced.");
    if (data.wallet?.seed) return { seed: hexToBytes32(data.wallet.seed), counter: data.wallet.counter || 0 };
    const seed = crypto.getRandomValues(new Uint8Array(64));
    await vault.save({ wallet: { seed: bytesToHex(seed), counter: 0 } });
    return { seed, counter: 0 };
  }

  /**
   * Reserve `n` output slots and write the new counter down before using them.
   *
   * Written first, always. A counter saved after a successful request is a
   * counter that is wrong exactly when it matters, and reusing one means asking
   * the mint to sign a secret it has already signed.
   */
  async reserve(n) {
    const { seed, counter } = await this.seed();
    const ok = await this.nc.vault.save({ wallet: { seed: bytesToHex(seed), counter: counter + n } });
    if (!ok) throw new Error("The wallet counter could not be saved, so nothing was spent.");
    return { seed, from: counter };
  }

  /** Blinded outputs for a list of amounts, plus what is needed to unblind them. */
  outputs(seed, from, amounts, keysetId) {
    return amounts.map((amount, i) => {
      const { secret, r } = derive(seed, keysetId, from + i);
      return { amount, id: keysetId, secret, r, B_: blind(secret, r).toHex(true) };
    });
  }

  /** Turn the mint's signatures into proofs, checking the mint's own DLEQ. */
  async proofs(mint, keysetId, prepared, signatures) {
    const { keysets } = await this.api(mint, `keys/${keysetId}`);
    const keys = keysets?.[0]?.keys || {};
    return signatures.map((sig, i) => {
      const p = prepared[i];
      const K = Point.fromHex(keys[String(p.amount)]);
      const C = unblind(Point.fromHex(sig.C_), p.r, K);
      // A mint that does not supply a proof cannot be checked; one that supplies
      // a wrong proof is signing with a key it does not publish, and that is
      // never acceptable.
      if (sig.dleq && !verifyDleq(sig.dleq, Point.fromHex(p.B_), Point.fromHex(sig.C_), K)) {
        throw new Error("This mint signed with a key it does not publish.");
      }
      return { id: p.id, amount: p.amount, secret: new TextDecoder().decode(p.secret), C: C.toHex(true) };
    });
  }

  /** Ask a mint for a Lightning invoice that pays into this wallet. */
  async invoice(mint, amount) {
    const quote = await this.api(mint, "mint/quote/bolt11", { amount, unit: "sat" });
    if (!quote?.request || !quote?.quote) throw new Error("The mint did not return an invoice.");
    return quote;
  }

  async paid(mint, quoteId) {
    const q = await this.api(mint, `mint/quote/bolt11/${encodeURIComponent(quoteId)}`);
    return q?.state === "PAID" || q?.paid === true;
  }

  /**
   * Mint the invoice into exactly the denominations the caller will need.
   *
   * `parts` is what the money is for, e.g. [1000, 1000]. Asking for the union of
   * their decompositions means the result can be cut up afterwards with no swap
   * and no fee, which is what lets one invoice pay for two things. The canonical
   * decomposition of 2000 cannot be halved at all.
   */
  async mint(mintUrl, keysetId, quoteId, parts) {
    const amounts = outputsFor(parts);
    const { seed, from } = await this.reserve(amounts.length);
    const prepared = this.outputs(seed, from, amounts, keysetId);
    const { signatures } = await this.api(mintUrl, "mint/bolt11", {
      quote: quoteId,
      outputs: prepared.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ })),
    });
    const all = await this.proofs(mintUrl, keysetId, prepared, signatures);
    return this.cut(all, parts, mintUrl);
  }

  /**
   * Partition proofs into tokens worth exactly `parts`, or refuse.
   *
   * Largest first, which is exact rather than lucky when the proofs came from
   * outputsFor(parts): every part is a sum of distinct powers of two and the
   * pool holds exactly those. It refuses rather than approximating, because a
   * token that is one satoshi short of what a node was promised fails later,
   * somewhere less obvious.
   */
  cut(proofs, parts, mint) {
    let left = [...proofs].sort((a, b) => b.amount - a.amount);
    return parts.map((want) => {
      const take = [];
      let have = 0;
      const rest = [];
      for (const p of left) {
        if (have + p.amount <= want) { have += p.amount; take.push(p); } else rest.push(p);
      }
      if (have !== want) throw new Error(`These coins do not add up to ${want}.`);
      left = rest;
      return encodeToken({ mint, proofs: take });
    });
  }

  /**
   * Cut a token somebody already holds into `parts`.
   *
   * Their wallet chose the denominations, so this needs a real swap and the
   * mint's input fee comes out of it. Taken from the largest part, so the
   * donation and the credit are never both short.
   */
  async split(token, parts) {
    const { mint, proofs } = decodeToken(token);
    const { keysets } = await this.api(mint, "keysets");
    const fees = Object.fromEntries(keysets.map((k) => [k.id, k.input_fee_ppk ?? 0]));
    const active = keysets.find((k) => k.active && k.unit === "sat");
    const total = proofs.reduce((n, p) => n + p.amount, 0);
    const fee = inputFee(proofs, fees);
    const wanted = parts.reduce((n, p) => n + p, 0);
    if (total - fee < wanted) {
      throw new Error(`This token holds ${total} and ${wanted + fee} is needed, including the mint's ${fee} fee.`);
    }

    // Whatever is left after the parts and the fee comes back as change rather
    // than being left with the mint.
    const change = total - fee - wanted;
    const target = change > 0 ? [...parts, change] : [...parts];
    const amounts = outputsFor(target);
    const { seed, from } = await this.reserve(amounts.length);
    const prepared = this.outputs(seed, from, amounts, active.id);
    const { signatures } = await this.api(mint, "swap", {
      inputs: proofs,
      outputs: prepared.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ })),
    });
    const all = await this.proofs(mint, active.id, prepared, signatures);
    const cut = this.cut(all, target, mint);
    return { parts: cut.slice(0, parts.length), change: change > 0 ? cut[parts.length] : null, fee };
  }
}

function hexToBytes32(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
