#!/usr/bin/env node
// Taking a site down, a page out, and a version out of the history, through
// the real CLI against the devnet, which honours NIP-09 and Blossom deletes the
// way a relay and a server that implement them do. Nothing reaches a public
// relay: --relays and --servers pin both lists to this machine.
//   node test/unpublish.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { generateSecretKey, getPublicKey, nip19, SimplePool } from "nostr-tools";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import WebSocket from "ws";
import { localPorts } from "./local-ports.mjs";
useWebSocketImplementation(WebSocket);

const CLI = fileURLToPath(new URL("../bin/nsite-clay.mjs", import.meta.url));
const DEVNET = fileURLToPath(new URL("../tools/devnet.mjs", import.meta.url));

let fail = 0;
const t = (name, pass, detail = "") => {
  if (!pass) fail++;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${!pass && detail ? "  (" + detail + ")" : ""}`);
};

const [relayPort, blossomPort, gatewayPort] = await localPorts(3);
const RELAY = `ws://127.0.0.1:${relayPort}`;
const BLOSSOM = `http://127.0.0.1:${blossomPort}`;
const GATEWAY = `http://127.0.0.1:${gatewayPort}`;
const devnet = spawn(process.execPath, [DEVNET, "--quiet"], {
  stdio: "ignore",
  env: { ...process.env, DEVNET_RELAY_PORT: relayPort, DEVNET_BLOSSOM_PORT: blossomPort, DEVNET_GATEWAY_PORT: gatewayPort },
});
for (let i = 0; i < 50; i++) {
  try { await fetch(BLOSSOM + "/"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const sec = generateSecretKey();
const pub = getPublicKey(sec);
const npub = nip19.npubEncode(pub);
const b36 = BigInt("0x" + pub).toString(36).padStart(50, "0");
const env = { ...process.env, NOSTR_SECRET_KEY: nip19.nsecEncode(sec), NOSTR_BUNKER_URI: "" };
const pinned = [`--relays=${RELAY}`, `--servers=${BLOSSOM}`];
const cli = (...args) => {
  const run = spawnSync(process.execPath, [CLI, ...args, ...pinned], { encoding: "utf8", env, timeout: 60_000 });
  return { status: run.status, out: (run.stdout || "") + (run.stderr || "") };
};
const hash = (s) => bytesToHex(sha256(Buffer.from(s)));
const page = async (path, site = "") => (await fetch(`${GATEWAY}${path}?site=${site ? b36 + site : npub}`)).status;
const blob = async (s) => (await fetch(`${BLOSSOM}/${hash(s)}`, { method: "HEAD" })).status;
const tick = () => new Promise((r) => setTimeout(r, 1100));   // a newer manifest needs a newer second

const work = mkdtempSync(join(tmpdir(), "nsite-unpublish-"));
const write = (dir, files) => {
  mkdirSync(join(work, dir), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(work, dir, name), body);
  return join(work, dir);
};

try {
  const SHARED = "/* the same runtime every site links */";
  const ABOUT_1 = "<!doctype html><title>about</title><p>first";
  const root = write("root", { "index.html": "<!doctype html><title>home</title>", "about.html": ABOUT_1, "shared.js": SHARED });
  const first = cli("deploy", root, "--no-relay-list");
  const firstVersion = first.out.match(/version\s+(v[0-9a-z]{50})\.nsite\.lol/)?.[1];
  t("a root site is deployed", first.status === 0 && firstVersion, first.out);
  await tick();
  writeFileSync(join(root, "about.html"), "<!doctype html><title>about</title><p>second");
  t("and deployed again, so it has a history", cli("deploy", root, "--no-relay-list").status === 0);
  const blog = write("blog", { "index.html": "<!doctype html><title>blog</title>", "shared.js": SHARED });
  t("a named site shares one blob with it", cli("deploy", blog, "--site=blog", "--no-relay-list").status === 0);
  t("both are served", await page("/about.html") === 200 && await page("/", "blog") === 200);

  {
    const dry = cli("unpublish", "--npub=" + npub);
    t("without --yes it says what it would do", dry.status === 0 && /Unpublish the root site/.test(dry.out) && /Nothing was sent/.test(dry.out), dry.out);
    t("and does nothing", await page("/") === 200 && await blob(SHARED) === 200);
  }

  {
    const run = cli("unpublish", "--path=/about.html", "--yes");
    t("one page comes out", run.status === 0 && await page("/about.html") === 404, run.out);
    t("and the rest of the site stays", await page("/") === 200);
    const missing = cli("unpublish", "--path=/nope.html", "--yes");
    t("a page that is not there is refused, naming what is", missing.status !== 0 && /index\.html/.test(missing.out), missing.out);
  }

  {
    const run = cli("unpublish", `--version=${firstVersion}`, "--yes");
    t("a version is deleted by its address", run.status === 0, run.out);
    const pool = new SimplePool();
    const snaps = await pool.querySync([RELAY], { kinds: [5128], authors: [pub] });
    const firstId = BigInt("0x" + [...firstVersion.slice(1)].reduce((a, c) => a * 36n + BigInt(parseInt(c, 36)), 0n).toString(16)).toString(16).padStart(64, "0");
    t("the relay no longer has it", !snaps.some((e) => e.id === firstId) && snaps.length >= 3, `${snaps.length} left`);
    pool.close([RELAY]);
    t("the blob only it used is deleted", await blob(ABOUT_1) === 404);
    t("the blobs other versions use are not", await blob(SHARED) === 200 && await page("/") === 200);
  }

  {
    const run = cli("unpublish", "--yes");
    t("the root site is unpublished", run.status === 0 && await page("/") === 404, run.out);
    const pool = new SimplePool();
    const left = await pool.querySync([RELAY], { kinds: [15128, 5128], authors: [pub], "#a": [`15128:${pub}:`] });
    const manifest = await pool.querySync([RELAY], { kinds: [15128], authors: [pub] });
    pool.close([RELAY]);
    t("its manifest and its whole history are gone from the relay", !left.length && !manifest.length, `${left.length} + ${manifest.length}`);
    t("its own blobs are deleted", await blob("<!doctype html><title>home</title>") === 404);
    t("the blob the named site still uses is not", await blob(SHARED) === 200);
    t("and the named site is still served", await page("/", "blog") === 200 && await page(`/shared-${hash(SHARED).slice(0, 8)}.js`, "blog") === 200);
    const again = cli("unpublish", "--yes");
    t("unpublishing it again finds nothing and says so", again.status !== 0 && /has anything/.test(again.out), again.out);
  }

  {
    const run = cli("unpublish", "--site=blog", "--yes");
    t("the named site is unpublished too", run.status === 0 && await page("/", "blog") === 404, run.out);
    t("and now nothing uses the shared blob, so it goes", await blob(SHARED) === 404);
  }
} finally {
  devnet.kill();
  rmSync(work, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
