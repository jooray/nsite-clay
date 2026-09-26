#!/usr/bin/env node
// When a publish writes a relay list for the owner's key, and when it must not.
// A relay list is part of somebody's Nostr identity and a new one replaces the
// old, so every case where the old one might exist has to leave it alone.
// Plain node, a fake pool, nothing on the network.
//   node test/relay-list.mjs
import { ensureRelayList, LOOKUP_RELAYS } from "../src/relay-list.js";

let fail = 0;
const t = (name, pass, detail = "") => {
  if (!pass) fail++;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${!pass && detail ? "  (" + detail + ")" : ""}`);
};

const PK = "a".repeat(64);
// answers: url -> [] (answered, nothing), [event] (answered, found), or "silent".
function fakePool(answers = {}, { accept = true } = {}) {
  const asked = [], published = [];
  return {
    asked, published,
    async ensureRelay(url) {
      asked.push(url);
      if (answers[url] === "silent") throw new Error("no connection");
      return {
        // Like the real one, closing a subscription calls onclose at once.
        subscribe(filters, { onevent, oneose, onclose }) {
          setTimeout(() => { for (const ev of answers[url] || []) onevent(ev); oneose(); }, 1);
          return { close() { onclose?.("closed by caller"); } };
        },
      };
    },
    publish(urls, ev) {
      published.push({ urls, ev });
      return urls.map(() => accept ? Promise.resolve("ok") : Promise.reject(new Error("blocked")));
    },
  };
}
const signer = { sign: async (e) => ({ ...e, pubkey: PK, id: "x", sig: "y" }) };
const DEPLOY = ["wss://nos.lol", "wss://relay.primal.net/", "wss://relay.nsite.lol"];

{
  const pool = fakePool();
  const state = await ensureRelayList(pool, signer, PK, DEPLOY, { timeout: 200 });
  const ev = pool.published[0]?.ev;
  t("a key with no relay list anywhere gets one", state === "written" && ev?.kind === 10002);
  t("naming the relays the site was deployed to", JSON.stringify(ev?.tags) === JSON.stringify([["r", "wss://nos.lol"], ["r", "wss://relay.primal.net"]]),
    JSON.stringify(ev?.tags));
  t("but not relay.nsite.lol, which accepts nothing a client would post", !ev?.tags.some((x) => x[1].includes("nsite.lol")));
  t("sent to the lookup relays and the deploy relays", LOOKUP_RELAYS.every((u) => pool.published[0]?.urls.includes(u)) &&
    pool.published[0]?.urls.includes("wss://relay.nsite.lol"));
}
{
  const existing = { kind: 10002, pubkey: PK, tags: [["r", "wss://my.own.relay"]] };
  const pool = fakePool({ "wss://relay.primal.net": [existing] });
  const state = await ensureRelayList(pool, signer, PK, DEPLOY, { timeout: 200 });
  t("a key that already has one, on any relay asked, is left alone", state === "present" && !pool.published.length);
}
{
  const pool = fakePool({ [LOOKUP_RELAYS[0]]: "silent" });
  const state = await ensureRelayList(pool, signer, PK, DEPLOY, { timeout: 200 });
  t("a lookup relay that does not answer means nothing is written", state === "unknown" && !pool.published.length);
}
{
  const pool = fakePool({ "wss://nos.lol": "silent" });
  const state = await ensureRelayList(pool, signer, PK, DEPLOY, { timeout: 200 });
  t("a silent deploy relay does not stop it, when both lookups answered", state === "written");
}
{
  const pool = fakePool();
  const state = await ensureRelayList(pool, signer, PK, ["wss://relay.nsite.lol"], { timeout: 200 });
  t("nothing to list is not a list", state === "empty" && !pool.published.length);
}
{
  const pool = fakePool({}, { accept: false });
  t("no relay accepting it is reported, not thrown", await ensureRelayList(pool, signer, PK, DEPLOY, { timeout: 200 }) === "failed");
  const refusing = { sign: async () => { throw new Error("no permission"); } };
  t("nor is a signer that refuses", await ensureRelayList(fakePool(), refusing, PK, DEPLOY, { timeout: 200 }) === "failed");
}
{
  const LOCAL = ["ws://127.0.0.1:7777"];
  const pool = fakePool();
  const state = await ensureRelayList(pool, signer, PK, LOCAL, { timeout: 200 });
  t("a local devnet is its own world: the public lookup relays are never asked",
    state === "written" && !pool.asked.some((u) => LOOKUP_RELAYS.includes(u)));
  t("nor written to", !pool.published.some((p) => p.urls.some((u) => LOOKUP_RELAYS.includes(u))));
}

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
