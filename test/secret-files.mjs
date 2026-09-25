#!/usr/bin/env node
// What deploy refuses to publish, and — the half that matters more — what it
// still publishes. A rule that eats an ordinary page is worse than no rule:
// the first one costs a rename, the second costs a site nobody can explain.
//
// Plain node, no browser: this is the CLI's file walk, not the runtime.
//   node test/secret-files.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// The pattern under test, read out of the CLI so this file cannot drift from it.
const src = readFileSync(new URL("../bin/nsite-clay.mjs", import.meta.url), "utf8");
const line = /^const SECRET_FILE = (\/.*\/[a-z]*);$/m.exec(src);
if (!line) { console.error("could not find SECRET_FILE in bin/nsite-clay.mjs"); process.exit(1); }
const SECRET_FILE = eval(line[1]);

const REFUSED = [
  "admin.macaroon", "readonly.macaroon",
  "id_rsa", "id_ed25519",
  "server.pem", "privkey.pem", "cert.key", "store.p12", "store.pfx", "putty.ppk",
  "env.backup", "env.production", "my.env", ".envrc", "npmrc",
  "nsec.txt", "my-nsec-backup.txt",
];

const PUBLISHED = [
  // Ordinary pages and assets. Every one of these would be a bug to refuse.
  "index.html", "about.html", "style.css", "nsite-clay.js", "logo.svg", "photo.png",
  "README.md", "llms.txt", "feed.xml", "manifest.json",
  // Words that merely contain a scary substring.
  "keynote.md", "monkey.png", "turkey.jpg", "keyboard.svg", "environment.html",
  "tokens.css", "design-tokens.json", "secretary.html", "envelope.svg",
  // His own repo has this one; a wider rule refused it.
  "p2-new-key.png",
];

let fail = 0;
const t = (name, pass, detail = "") => {
  if (!pass) fail++;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

console.log("refuses:");
for (const n of REFUSED) t(n, SECRET_FILE.test(n), SECRET_FILE.test(n) ? "" : "published, should not be");

console.log("\npublishes:");
for (const n of PUBLISHED) t(n, !SECRET_FILE.test(n), SECRET_FILE.test(n) ? "refused, should not be" : "");

// End to end through the real walk: a directory with both kinds in it.
console.log("\nwalk():");
const dir = mkdtempSync(join(tmpdir(), "nsite-secret-"));
try {
  mkdirSync(join(dir, "sub"));
  for (const n of ["index.html", "style.css", "keynote.md"]) writeFileSync(join(dir, n), "x");
  for (const n of ["id_rsa", "admin.macaroon", "env.backup"]) writeFileSync(join(dir, n), "x");
  writeFileSync(join(dir, "sub", "deep.pem"), "x");        // nested, must also be refused
  writeFileSync(join(dir, "sub", "page.html"), "x");
  writeFileSync(join(dir, ".env"), "x");                    // dotfile: already skipped before this change

  // Drive the real binary. Importing it would run main() and print the help.
  // Unreachable relay/server, so it lists the skips and then fails on upload —
  // which is exactly the ordering that matters: nothing leaves the machine.
  const cli = fileURLToPath(new URL("../bin/nsite-clay.mjs", import.meta.url));
  const key = randomBytes(32).toString("hex");   // throwaway, never a real one
  const run = spawnSync(process.execPath, [cli, "deploy", dir, "--relays=wss://127.0.0.1:1", "--servers=http://127.0.0.1:1"],
    { env: { ...process.env, NOSTR_SECRET_KEY: key }, encoding: "utf8", timeout: 60_000 });
  const out = (run.stdout || "") + (run.stderr || "");

  for (const n of ["id_rsa", "admin.macaroon", "env.backup", "sub/deep.pem"]) {
    t(`names ${n} as skipped`, new RegExp(`^\\s+${n.replace(".", "\\.")}$`, "m").test(out));
  }
  t("says why, and how to override", /look like secrets/.test(out) && /Rename one to publish it anyway/.test(out));
  t("never uploaded a secret", !/\/id_rsa|\/admin\.macaroon|\/env\.backup|deep-[0-9a-f]{8}\.pem/.test(out), "a skipped file reached the upload list");
  t("still walks the real files", /index\.html/.test(out));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
