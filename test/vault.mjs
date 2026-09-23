// The vault against a real relay and a real signer, not a mock.
//
// The claim being tested is the one that matters to somebody who paid: the AI
// credit and the wallet seed behind it come back on a device that has never
// seen them, and a stranger reading the same relay learns nothing. So this runs
// two real browser pages against the devnet relay, and checks the second one
// starts with an empty localStorage before it is allowed to prove anything.
//
// Run: node test/vault.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const NSEC = "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y";
const NPUB = "npub16kwfcualkq4kz6vgs8tze0j4jkpgs53h48ghmpnj80s7cvfjspwsh4uk9u";
const devnet = spawn("node", ["tools/devnet.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
let up = false;
devnet.stdout.on("data", (d) => { if (/relay|listening|ready/i.test(String(d))) up = true; });
for (let i = 0; i < 60 && !up; i++) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 1500));

const page0 = readFileSync("site/t/cms/index.html", "utf8")
  .replace(/nc:owner="[^"]*"/, `nc:owner="${NPUB}"`)
  .replace(/nc:path="[^"]*"/, 'nc:path="/index.html"')
  .replace(/nc:relays="[^"]*"/, 'nc:relays="ws://127.0.0.1:4869"');
const srv = createServer((q, r) => {
  const p = new URL(q.url, "http://l").pathname;
  if (p === "/" || p === "/index.html") { r.writeHead(200, { "Content-Type": "text/html" }); return r.end(page0); }
  const f = p.startsWith("/nsite-clay") && p.endsWith(".js") && !p.includes("chrome")
    ? join("dist", p.includes("source") ? "nsite-clay-source.js" : "nsite-clay.js") : join("site", p);
  try { r.writeHead(200, { "Content-Type": { ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" }[extname(f)] || "application/octet-stream" }); r.end(readFileSync(f)); }
  catch { r.writeHead(404); r.end(); }
}).listen(4801, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));

const browser = await chromium.launch({ channel: "chrome" });
const out = [];
const t = (name, pass, detail = "") => { out.push([name, pass, detail]); };

// --- device one: sign in, write the vault -----------------------------------
const one = await browser.newPage();
one.on("pageerror", (e) => out.push(["pageerror(1)", false, e.message]));
await one.goto("http://127.0.0.1:4801/#edit");
await one.evaluate(async () => { await nc.ready; });
const before = await one.evaluate(() => ({ usable: nc.vault.usable, pubkey: !!nc.pubkey }));
t("a vault is unusable before sign-in", before.usable === false && before.pubkey === false);

await one.evaluate((n) => nc.login("nsec", { key: n }), NSEC);
await one.waitForTimeout(400);
const wrote = await one.evaluate(async () => {
  const empty = await nc.vault.load();
  const ok = await nc.vault.save({ ai: { "https://routstr.cypherpunk.today/v1": "sk-secret-abc" },
                                   wallet: { seed: "seed-words-here", mint: "https://cashu.cz" } });
  return { usable: nc.vault.usable, emptyAtFirst: JSON.stringify(empty), saved: ok };
});
t("a signed-in nsec signer can encrypt", wrote.usable === true);
t("an empty vault reads as empty, not as broken", wrote.emptyAtFirst === "{}");
t("saving reaches a relay", wrote.saved === true);

// --- device two: a fresh browser, nothing local ------------------------------
const two = await browser.newPage();
two.on("pageerror", (e) => out.push(["pageerror(2)", false, e.message]));
await two.goto("http://127.0.0.1:4801/#edit");
await two.evaluate(async () => { await nc.ready; });
// Read before signing in: signing in is what goes and fetches the credit, so
// after it this browser is supposed to have something.
const localStorageHadNothing = await two.evaluate(() => !window.localStorage.getItem("nsite-clay.ai"));
await two.evaluate((n) => nc.login("nsec", { key: n }), NSEC);
await two.waitForTimeout(400);
const read = await two.evaluate(async () => ({ v: await nc.vault.load() }));
t("a second device starts with nothing in this browser", localStorageHadNothing === true);
t("and reads the AI key back off the relays", read.v?.ai?.["https://routstr.cypherpunk.today/v1"] === "sk-secret-abc");
t("and the wallet seed with it", read.v?.wallet?.seed === "seed-words-here");

// --- the credit follows the owner into their own page ------------------------
//
// The bug this covers: credit is bought in the publisher and spent in the
// published page, which is a different origin, so nothing the publisher put in
// localStorage is visible here. Somebody who had just paid opened their own page
// and was told they had no credit.
const adopted = await two.evaluate(async () => {
  const found = await nc.ai.adopt();
  return { found, key: nc.ai.client.session().key,
    kept: JSON.parse(window.localStorage.getItem("nsite-clay.ai") || "{}") };
});
t("signing in is enough to find the credit its owner paid for",
  adopted.found === true && adopted.key === "sk-secret-abc");
// One relay round trip per browser, not one per edit.
t("and this browser keeps it from then on",
  adopted.kept?.nodes?.["https://routstr.cypherpunk.today/v1"]?.key === "sk-secret-abc",
  JSON.stringify(adopted.kept).slice(0, 120));

const dialog = await two.evaluate(async () => {
  nc.ai.edit(null);
  await new Promise((r) => setTimeout(r, 200));
  const panel = [...document.querySelectorAll(".nc-ui")].at(-1);
  const text = panel.querySelector(".nc-hint.nc-bad")?.textContent || "";
  const out = { bad: text, submitDisabled: panel.querySelector("button[type=submit]").disabled };
  panel.querySelector(".nc-cancel").click();
  return out;
});
t("so the edit dialog does not claim there is none", !/credit/i.test(dialog.bad), dialog.bad);
t("and generating is offered rather than blocked", dialog.submitDisabled === false);

// --- what a stranger sees ----------------------------------------------------
const seen = await two.evaluate(async () => {
  const ev = await nc.pool.get(["ws://127.0.0.1:4869"], { kinds: [30078], authors: [nc.pubkey], "#d": ["nsite-clay"], limit: 1 });
  return { kind: ev?.kind, d: ev?.tags?.find((x) => x[0] === "d")?.[1], content: ev?.content || "" };
});
t("it is one replaceable kind 30078 under a d tag", seen.kind === 30078 && seen.d === "nsite-clay");
t("and the secret is not in it", !seen.content.includes("sk-secret-abc") && !seen.content.includes("seed-words-here"),
  seen.content.slice(0, 40));

// --- merge, not clobber ------------------------------------------------------
const merged = await two.evaluate(async () => {
  await nc.vault.save({ note: "written by the second device" });
  nc.vault.forget();
  return await nc.vault.load({ force: true });
});
t("a second device merges instead of erasing the first", merged?.ai?.["https://routstr.cypherpunk.today/v1"] === "sk-secret-abc" && merged?.note === "written by the second device");

// --- a key bought inside a page is backed up without being asked -------------
//
// The gap this covers: buying credit from inside a published page put the key
// in that browser and nowhere else, so the next device found nothing and the
// owner had to know about a button called "Save to my Nostr relays".
const kept = await two.evaluate(async () => {
  const base = nc.ai.client.session().base;
  nc.ai.client.setKey("sk-bought-in-the-page", base);
  const ok = await nc.ai.keepOnRelays(base);
  nc.vault.forget();
  const back = await nc.vault.load({ force: true });
  return { ok, stored: back?.ai?.[base], seed: back?.wallet?.seed };
});
t("a key bought in a page reaches the owner's relays by itself", kept.ok === true && kept.stored === "sk-bought-in-the-page");
t("and nothing else in the vault is disturbed", kept.seed === "seed-words-here");

// --- several writes in one second ------------------------------------------
//
// A replaceable event does not replace one with the same created_at, and buying
// credit writes three times in a row. Whichever of them lost the tie used to
// say it had succeeded.
const rapid = await two.evaluate(async () => {
  const oks = [];
  for (const patch of [{ pending: { credit: "a" } }, { pending: { credit: "b" } }, { pending: null, marker: "last" }]) {
    oks.push(await nc.vault.save(patch));
  }
  nc.vault.forget();
  const back = await nc.vault.load({ force: true });
  return { oks, marker: back?.marker, pending: back?.pending, seed: back?.wallet?.seed };
});
t("three writes inside a second all land", rapid.oks.every(Boolean));
t("and the last one is the one that survives", rapid.marker === "last" && rapid.pending === null,
  JSON.stringify(rapid).slice(0, 120));
t("with everything written before them still there", rapid.seed === "seed-words-here");

for (const [name, pass, detail] of out) console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? "   (" + detail + ")" : ""}`);
console.log(`\n${out.filter((r) => r[1]).length}/${out.length} passed`);
await browser.close(); srv.close(); devnet.kill();
process.exit(out.every((r) => r[1]) ? 0 : 1);
