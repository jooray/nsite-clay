#!/usr/bin/env node
// Copy each template into site/t/<name>/ for the published gallery, and its
// screenshot into site/shots/. Templates link the shared files from the site
// root, so they need no copies of their own here.
import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync, rmSync, statSync as stat } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const out = join("site", "t");
rmSync(out, { recursive: true, force: true });
let staged = 0;
let thumbed = 0;

for (const name of readdirSync("templates")) {
  if (name.startsWith("_")) continue;
  const dir = join("templates", name);
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, "index.html"))) continue;
  mkdirSync(join(out, name), { recursive: true });
  for (const f of readdirSync(dir)) {
    const from = join(dir, f);
    if (statSync(from).isFile()) copyFileSync(from, join(out, name, f));
  }
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
