#!/usr/bin/env node
// A whole "edit it with your own agent" session on this machine, for trying
// the instructions on a real agent without anything reaching a public relay.
//
//   node tools/agent-session.mjs <work dir>
//
// It starts the devnet on free ports, publishes a two-page site from the cms
// template under a fresh key, runs a NIP-46 bunker holding that key, opens the
// page in the installed Chrome, signs in, presses Settings and "Copy
// instructions for your own agent", and reads what landed on the clipboard.
// Then it writes into <work dir>:
//
//   instructions.txt   what the page copied, exactly
//   bunker.txt         a fresh bunker:// link, the one a person would paste
//   session.json       ports, keys and addresses, for tools/agent-verify.mjs
//   agent-work/        an empty directory to hand the agent
//   bin/nsite-clay     a shim that runs this checkout's CLI, with its own
//                      config directory so a test connection never lands in
//                      the real one
//
// and keeps everything running until it is stopped. GET /new on the bunker
// port prints another link.
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { chromium } from "playwright";
import { localPorts } from "../test/local-ports.mjs";
import { startBunker } from "../test/mock-bunker.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "bin/nsite-clay.mjs");
const work = resolve(process.argv[2] || "agent-session");
mkdirSync(work, { recursive: true });

const [relayPort, blossomPort, gatewayPort, bunkerPort] = await localPorts(4);
const RELAY = `ws://127.0.0.1:${relayPort}`;
const BLOSSOM = `http://127.0.0.1:${blossomPort}`;
const devnet = spawn(process.execPath, [join(ROOT, "tools/devnet.mjs"), "--quiet"], {
  stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: relayPort, DEVNET_BLOSSOM_PORT: blossomPort, DEVNET_GATEWAY_PORT: gatewayPort },
});
const stopAll = [() => devnet.kill()];
const stop = () => { for (const f of stopAll) try { f(); } catch {} };
process.on("exit", stop);
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { stop(); process.exit(0); });
for (let i = 0; i < 50; i++) {
  try { await fetch(BLOSSOM + "/"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

// ---- the site --------------------------------------------------------------
const sec = generateSecretKey();
const pub = getPublicKey(sec);
const npub = nip19.npubEncode(pub);
const nsec = nip19.nsecEncode(sec);
const src = join(work, "published-source");
if (existsSync(src)) spawnSync("rm", ["-rf", src]);
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
let r = run(["init", src, "--template=cms", `--npub=${npub}`]);
if (r.status) throw new Error(r.stdout + r.stderr);
const local = (html) => html
  .replace(/nc:relays="[^"]*"/, `nc:relays="${RELAY}"`)
  .replace(/nc:servers="[^"]*"/, `nc:servers="${BLOSSOM}"`);
const home = local(readFileSync(join(src, "index.html"), "utf8"));
writeFileSync(join(src, "index.html"), home);
const about = home
  .replace(/<html lang="en"/, '<html lang="en" nc:path="/about.html"')
  .replace(/<title>[^<]*<\/title>/, "<title>About Kettle &amp; Pine</title>")
  .replace('<h1 class="site-title" editable="single-line">Kettle &amp; Pine</h1>',
           '<h1 class="site-title" editable="single-line">About us</h1>')
  .replace(/We bake four things properly[\s\S]*?Saturday\.<\/p>/,
           "Two of us run the bakery: Ana bakes and Tomas talks to the customers.</p>");
writeFileSync(join(src, "about.html"), about);
r = run(["deploy", src, `--relays=${RELAY}`, `--servers=${BLOSSOM}`], { NOSTR_SECRET_KEY: nsec, NOSTR_BUNKER_URI: "" });
if (r.status) throw new Error(r.stdout + r.stderr);

// ---- the signer --------------------------------------------------------------
const bunker = await startBunker({ relay: RELAY, secretKey: sec, log: (m) => console.log(m) });
stopAll.push(() => bunker.close());
const http = createServer((q, s) => {
  if (q.url === "/new") { s.writeHead(200, { "Content-Type": "text/plain" }); return s.end(bunker.uri() + "\n"); }
  s.writeHead(200, { "Content-Type": "application/json" });
  s.end(JSON.stringify({ clients: [...bunker.clients], ...bunker.stats }) + "\n");
}).listen(bunkerPort, "127.0.0.1");
stopAll.push(() => http.close());

// ---- the page, in a browser ----------------------------------------------------
const site = `http://${npub}.localhost:${gatewayPort}/`;
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext();
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: site.replace(/\/$/, "") });
const page = await context.newPage();
// Only the devnet. A feed block or an upgrade check asks public relays otherwise.
await page.routeWebSocket((url) => !url.href.startsWith(RELAY), (ws) => ws.close());
await page.goto(site + "#edit");
await page.evaluate(async (k) => { await nc.ready; await nc.login("nsec", { key: k }); }, nsec);
await page.waitForFunction(() => nc.isOwner && nc._manifest);
await page.locator("[data-nc-settings]").first().click();
const button = page.locator("[data-nc-agent]");
await button.waitFor();
await page.screenshot({ path: join(work, "settings.png") });
await button.click();
await page.waitForTimeout(800);
let text = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
if (!text) text = await page.locator("[data-nc-agent-text]").inputValue().catch(() => "");
await page.screenshot({ path: join(work, "copied.png") });
await browser.close();
if (!text.includes(npub)) throw new Error("the clipboard does not hold the instructions:\n" + text.slice(0, 400));
writeFileSync(join(work, "instructions.txt"), text);

// ---- what the agent gets -------------------------------------------------------
const link = bunker.uri();
writeFileSync(join(work, "bunker.txt"), link + "\n");
mkdirSync(join(work, "bin"), { recursive: true });
mkdirSync(join(work, "agent-config"), { recursive: true });
mkdirSync(join(work, "agent-work"), { recursive: true });
const shim = join(work, "bin", "nsite-clay");
writeFileSync(shim, `#!/bin/sh\nXDG_CONFIG_HOME="\${XDG_CONFIG_HOME:-${join(work, "agent-config")}}" exec "${process.execPath}" "${CLI}" "$@"\n`);
chmodSync(shim, 0o755);
writeFileSync(join(work, "session.json"), JSON.stringify({
  npub, pubkey: pub, nsec, relay: RELAY, blossom: BLOSSOM, gateway: `http://127.0.0.1:${gatewayPort}`, site,
  bunker: `http://127.0.0.1:${bunkerPort}`, shim, published: src,
}, null, 2));
console.log(`\nagent session ready in ${work}`);
console.log(`  site         ${site}`);
console.log(`  instructions ${join(work, "instructions.txt")} (${text.split("\n").length} lines)`);
console.log(`  bunker link  ${join(work, "bunker.txt")}`);
console.log(`  shim         ${shim}`);
console.log(`  another link curl -s http://127.0.0.1:${bunkerPort}/new`);
console.log(`\nRunning until stopped.`);
