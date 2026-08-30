#!/usr/bin/env node
// Copy each template into site/t/<name>/ for the published gallery, and its
// screenshot into site/shots/. Templates link the shared files from the site
// root, so they need no copies of their own here.
import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync, rmSync, statSync as stat,
         readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const out = join("site", "t");
rmSync(out, { recursive: true, force: true });
let staged = 0;
let thumbed = 0;
let warnings = 0;

// The web publisher reads this rather than carrying a hardcoded list, so a new
// template appears in the wizard by being added to templates/ and nothing else.
//
// `owner` is the load-bearing field. Every template ships demo content written
// under its author's key: the feed pulls their notes, the footer links their
// profile. Publishing one to somebody else means replacing that npub, and the
// only safe way to do it is to know exactly which npub was the placeholder.
const catalogue = [];
const between = (html, re) => (html.match(re) || [])[1] || "";

// The gallery already names and describes every template, in every language the
// site speaks. The publisher needs the same words, so rather than keeping a
// second list in step with the first, read them back out of the gallery pages.
// One place to write a description, four languages that get it.
const LANGS = ["en", "es", "sk", "cs"];
const entities = (t) => t
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

function galleryText(lang) {
  const file = lang === "en" ? join("site", "templates.html") : join("site", lang, "templates.html");
  const out = {};
  let html;
  try { html = readFileSync(file, "utf8"); } catch { return out; }
  const card = /<span class="name">([a-z0-9-]+)<\/span>\s*<h2><a[^>]*>([\s\S]*?)<\/a><\/h2>\s*<p>([\s\S]*?)<\/p>/g;
  for (const m of html.matchAll(card)) {
    out[m[1]] = {
      label: entities(m[2].replace(/<[^>]+>/g, "").trim()),
      description: entities(m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()),
    };
  }
  return out;
}
const gallery = Object.fromEntries(LANGS.map((l) => [l, galleryText(l)]));

for (const name of readdirSync("templates")) {
  if (name.startsWith("_")) continue;
  const dir = join("templates", name);
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, "index.html"))) continue;
  mkdirSync(join(out, name), { recursive: true });
  const files = [];
  for (const f of readdirSync(dir)) {
    const from = join(dir, f);
    if (statSync(from).isFile()) { copyFileSync(from, join(out, name, f)); files.push(f); }
  }

  const html = readFileSync(join(dir, "index.html"), "utf8");
  const owner = between(html, /nc:owner="([^"]*)"/);

  // The publisher personalises a template by replacing its author's npub with
  // the new owner's. A feed pointing at anybody else survives that, so the
  // person who published it gets a page quietly showing a stranger's notes.
  // Catch it here rather than in somebody's published site.
  for (const m of html.matchAll(/nc:(?:feed-)?authors="([^"]*)"|nc:photos="([^"]*)"/g)) {
    for (const npub of (m[1] || m[2] || "").split(/[,\s]+/).filter(Boolean)) {
      if (npub !== owner) {
        console.warn(`stage-templates: ${name} has a feed reading ${npub.slice(0, 16)}…, ` +
                     `which is not its own owner. The publisher cannot rewrite that, so ` +
                     `whoever publishes this template inherits it.`);
        warnings++;
      }
    }
  }

  // What each language calls it, and what it says about it. A template the
  // gallery has not described yet falls back to its own <title> and meta.
  const l10n = {};
  for (const lang of LANGS) {
    const g = gallery[lang]?.[name];
    if (g) l10n[lang] = g;
  }
  if (!l10n.en) {
    console.warn(`stage-templates: ${name} is not in the gallery, so the publisher ` +
                 `will show its <title> and meta description instead of a translated one.`);
    warnings++;
  }

  catalogue.push({
    name,
    l10n,
    title: between(html, /<title>([^<]*)<\/title>/i).replace(/&amp;/g, "&").trim(),
    description: between(html, /<meta\s+name="description"\s+content="([^"]*)"/i)
      .replace(/&amp;/g, "&").trim(),
    owner,
    shot: existsSync(join("media", "templates", `${name}.png`)) ? `/shots/t-${name}.png` : null,
    files: files.sort(),
  });
  // The cards show these at a few hundred pixels wide, so publishing the raw
  // 2560px capture meant the homepage pulled several megabytes of PNG to draw
  // six thumbnails. Downscale on the way in; the card links to the live
  // template, so nothing here needs the full-size file.
  const shot = join("media", "templates", `${name}.png`);
  const dest = join("site", "shots", `t-${name}.png`);
  if (existsSync(shot)) {
    copyFileSync(shot, dest);
    try {
      execFileSync("sips", ["--resampleWidth", "1000", dest], { stdio: "ignore" });
      thumbed++;
    } catch { /* sips is macOS only; the full-size copy still works */ }
  }
  staged++;
}
catalogue.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(out, "index.json"), JSON.stringify(catalogue, null, 2) + "\n");

console.log(`staged ${staged} template${staged === 1 ? "" : "s"} into site/t/` +
            (thumbed ? `, ${thumbed} screenshot${thumbed === 1 ? "" : "s"} resized for the cards` : ""));

// Resizing writes a fresh PNG with none of the packing the committed originals
// have, so the cards would ship a third more bytes than they need. picopt is
// lossless, and optional: without it the site is merely larger.
try {
  const before = readdirSync(join("site", "shots"))
    .reduce((n, f) => n + stat(join("site", "shots", f)).size, 0);
  execFileSync("picopt", ["-q", "-r", join("site", "shots")], { stdio: "ignore" });
  const after = readdirSync(join("site", "shots"))
    .reduce((n, f) => n + stat(join("site", "shots", f)).size, 0);
  const saved = before - after;
  if (saved > 0) {
    console.log(`optimised site/shots, ${(saved / 1024).toFixed(0)} kB smaller ` +
                `(${(after / 1048576).toFixed(2)} MB in all)`);
  }
} catch {
  console.log("picopt not found, so the screenshots ship unoptimised. " +
              "`uv tool install --python 3.14 picopt` if you want them smaller.");
}
