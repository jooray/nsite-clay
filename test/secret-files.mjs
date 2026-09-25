#!/usr/bin/env node
// What deploy leaves out, and, the half that matters more, what it still
// publishes. A rule that eats an ordinary page is worse than no rule: the first
// costs a rename, the second costs a site nobody can explain.
//
// Plain node, no browser: this is the CLI's file walk, driven through the real
// binary with --dry-run, which needs no key and publishes nothing.
//   node test/secret-files.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI = fileURLToPath(new URL("../bin/nsite-clay.mjs", import.meta.url));

let fail = 0;
const t = (name, pass, detail = "") => {
  if (!pass) fail++;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${!pass && detail ? "  (" + detail + ")" : ""}`);
};

// Build a directory, run a dry deploy over it, and read back the three lists.
function deploy(files, args = [], ignore = null) {
  const dir = mkdtempSync(join(tmpdir(), "nsite-walk-"));
  try {
    for (const f of files) { mkdirSync(join(dir, dirname(f)), { recursive: true }); writeFileSync(join(dir, f), "x"); }
    if (ignore !== null) writeFileSync(join(dir, ".nsiteignore"), ignore);
    const run = spawnSync(process.execPath, [CLI, "deploy", dir, "--dry-run", ...args], { encoding: "utf8", timeout: 30_000 });
    const out = (run.stdout || "") + (run.stderr || "");
    const section = (head) => {
      const at = out.split("\n").findIndex((l) => l.startsWith(head));
      if (at < 0) return [];
      const lines = [];
      for (const l of out.split("\n").slice(at + 1)) { if (!l.startsWith("  ")) break; lines.push(l.trim().replace(/^\//, "")); }
      return lines;
    };
    return { out, status: run.status, published: section("Would publish"), secrets: section("Not publishing"), ignored: section("Leaving out") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REFUSED = [
  "admin.macaroon", "readonly.macaroon",
  "id_rsa", "id_ed25519",
  "server.pem", "privkey.pem", "cert.key", "store.p12", "store.pfx", "putty.ppk",
  "env.backup", "env.production", "my.env", "npmrc",
  "nsec.txt", "my-nsec-backup.txt",
];

const PUBLISHED = [
  // Ordinary pages and assets. Every one of these would be a bug to refuse.
  "index.html", "about.html", "style.css", "nsite-clay.js", "logo.svg", "photo.png",
  "README.md", "llms.txt", "feed.xml", "manifest.json",
  // Words that merely contain a scary substring.
  "keynote.md", "monkey.png", "turkey.jpg", "keyboard.svg", "environment.html",
  "tokens.css", "design-tokens.json", "secretary.html", "envelope.svg",
  "p2-new-key.png",
  // Web pages about the scary thing. On Nostr these are ordinary content.
  "what-is-nsec.html", "npub-vs-nsec.png", "env.html", "app.env.js", "how-to-store-your-nsec.html",
];

{
  console.log("secrets:");
  const r = deploy([...REFUSED, ...PUBLISHED]);
  for (const n of REFUSED) t(`refuses ${n}`, r.secrets.includes(n) && !r.published.includes(n), "published, should not be");
  for (const n of PUBLISHED) t(`publishes ${n}`, r.published.includes(n), "refused, should not be");
  t("says why, and how to override", /look like secrets/.test(r.out) && /--publish-secrets/.test(r.out));

  const nested = deploy(["index.html", "sub/deep.pem", "sub/page.html"]);
  t("a nested secret is refused too", nested.secrets.includes("sub/deep.pem") && nested.published.includes("sub/page.html"));

  const forced = deploy(["index.html", "id_rsa", "server.pem"], ["--publish-secrets"]);
  t("--publish-secrets publishes them anyway", forced.published.includes("id_rsa") && forced.published.includes("server.pem") && !forced.secrets.length);

  const dot = deploy(["index.html", ".env", ".ssh/id_rsa"]);
  t("dotfiles are still never published, nor listed", dot.published.join() === "index.html" && !dot.secrets.length);
}

{
  console.log("\n.nsiteignore and --exclude:");
  const files = ["index.html", "style.css", "README.md", "docs/README.md", "deploy.sh", "drafts/a.html",
    "drafts/b/c.html", "notes/keep.md", "notes/x.md", "img/a.png", "img/raw/a.png"];
  const r = deploy(files, ["--exclude=style.css", "--exclude=*.sh,img/raw/"],
    "# a comment, then a blank line\n\n/README.md\ndrafts/\nnotes/*\n!notes/keep.md\n");
  t("an anchored pattern matches only at the root", r.ignored.includes("README.md") && r.published.includes("docs/README.md"));
  t("a directory pattern leaves out everything under it", r.ignored.includes("drafts/") && !r.published.some((p) => p.startsWith("drafts/")));
  t("a later !pattern brings a file back", r.published.includes("notes/keep.md") && r.ignored.includes("notes/x.md"));
  t("--exclude can be repeated", r.ignored.includes("style.css"));
  t("and comma-separated, globs and directories alike", r.ignored.includes("deploy.sh") && r.ignored.includes("img/raw/"));
  t("everything else is published", ["index.html", "img/a.png", "docs/README.md"].every((p) => r.published.includes(p)));
  t("the ignore file itself is not published", !r.published.includes(".nsiteignore"));

  const any = deploy(["a.log", "sub/b.log", "sub/c.html"], [], "*.log\n");
  t("an unanchored pattern matches at any depth", any.published.join() === "sub/c.html");
  const deep = deploy(["a/tmp/x.html", "tmp/y.html", "z.html"], [], "**/tmp/\n");
  t("**/ matches at the root and below", deep.published.join() === "z.html");

  const none = deploy(["index.html"], ["--exclude=*.html"]);
  t("excluding everything is an error, not an empty site", none.status !== 0 && /nothing to publish/.test(none.out));
}

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
