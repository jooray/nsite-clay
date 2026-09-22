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
await two.evaluate((n) => nc.login("nsec", { key: n }), NSEC);
await two.waitForTimeout(400);
const read = await two.evaluate(async () => {
  const localStorageHadNothing = !window.localStorage.getItem("nsite-clay.ai");
  const v = await nc.vault.load();
  return { localStorageHadNothing, v };
});
t("a second device starts with nothing in this browser", read.localStorageHadNothing === true);
t("and reads the AI key back off the relays", read.v?.ai?.["https://routstr.cypherpunk.today/v1"] === "sk-secret-abc");
t("and the wallet seed with it", read.v?.wallet?.seed === "seed-words-here");

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

for (const [name, pass, detail] of out) console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? "   (" + detail + ")" : ""}`);
console.log(`\n${out.filter((r) => r[1]).length}/${out.length} passed`);
await browser.close(); srv.close(); devnet.kill();
process.exit(out.every((r) => r[1]) ? 0 : 1);
