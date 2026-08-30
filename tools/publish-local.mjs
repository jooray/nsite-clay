#!/usr/bin/env node
// The publisher, on a stack that lives entirely on this machine.
//
// `npm run site:serve` serves the real site, and the publisher on it publishes
// to real relays and real Blossom servers. That is correct, and it is not what
// you want while poking at it: every experiment lands on somebody else's disk
// for good.
//
// So this starts tools/devnet.mjs and serves site/ with the relay and Blossom
// lists rewritten to point at it. Publish as often as you like; stop the
// process and every trace is gone.
//
//   npm run publish:local
//
// It prints the publisher's address and the gateway's. Sites are addressed by
// hostname, the way a gateway serves them: browsers resolve anything under
// .localhost to loopback, and an npub is exactly 63 characters, which is all a
// DNS label may hold. So a published page and its assets resolve without a
// query string, exactly as in production.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = Number(process.env.PUBLISH_LOCAL_PORT || 4792);
const RELAY = "ws://127.0.0.1:4869";
const BLOSSOM = "http://127.0.0.1:4870";
const GATEWAY_PORT = 4871;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".txt": "text/plain", ".md": "text/markdown", ".woff2": "font/woff2" };

// Both the wizard and the templates it uploads. The wizard publishes the bytes
// it is served, so rewriting here is what keeps the published page talking to
// localhost rather than reaching for a public relay on its first save.
const local = (html) => html
  .replace(/nc:relays="[^"]*"/g, `nc:relays="${RELAY}"`)
  .replace(/nc:servers="[^"]*"/g, `nc:servers="${BLOSSOM}"`);

const devnet = spawn("node", [join("tools", "devnet.mjs")], { stdio: "inherit" });
const stop = () => { try { devnet.kill(); } catch {} };
for (const sig of ["SIGINT", "SIGTERM", "exit"]) process.on(sig, stop);

const server = createServer((req, res) => {
  let path = decodeURIComponent(req.url.split("?")[0]);
  if (path.endsWith("/")) path += "index.html";
  const file = join("site", path);
  let body;
  try { body = readFileSync(file); }
  catch { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found\n"); }
  const ext = extname(file).toLowerCase();
  if (ext === ".html") body = Buffer.from(local(body.toString("utf8")), "utf8");
  res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(body);
});

// Bound to the loopback address explicitly. Left to itself Node listens on every
// interface, which on a machine where something already holds 127.0.0.1:4792
// means binding the IPv6 wildcard instead and quietly serving nothing to anyone
// who asked for 127.0.0.1. Better to refuse to start and say which port.
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`\n  Port ${PORT} is taken. Free it, or pick another:\n` +
                `      PUBLISH_LOCAL_PORT=4796 npm run publish:local\n`);
  stop();
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  setTimeout(() => {
    console.log(`
  publisher   http://127.0.0.1:${PORT}/deploy.html
  guide       http://127.0.0.1:${PORT}/guide.html
  templates   http://127.0.0.1:${PORT}/templates.html

  Relays and Blossom point at the devnet above, so nothing leaves this machine.
  Publish, then open what the wizard shows you as:

      http://<the npub it printed>.localhost:${GATEWAY_PORT}/

  Add #edit to that address and sign in with the same key to edit the page.
  A Nostr feed will find nothing, because the devnet relay holds only what you
  published to it. Everything else is the real thing.

  Ctrl-C stops both, and the devnet forgets everything it held.
`);
  }, 700);
});
