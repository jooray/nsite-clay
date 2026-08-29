#!/usr/bin/env node
// Copy each template into site/t/<name>/ for the published gallery, and its
// screenshot into site/shots/. Templates link the shared files from the site
// root, so they need no copies of their own here.
import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const out = join("site", "t");
rmSync(out, { recursive: true, force: true });
let staged = 0;

for (const name of readdirSync("templates")) {
  if (name.startsWith("_")) continue;
  const dir = join("templates", name);
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, "index.html"))) continue;
  mkdirSync(join(out, name), { recursive: true });
  for (const f of readdirSync(dir)) {
    const from = join(dir, f);
    if (statSync(from).isFile()) copyFileSync(from, join(out, name, f));
  }
  const shot = join("media", "templates", `${name}.png`);
  if (existsSync(shot)) copyFileSync(shot, join("site", "shots", `t-${name}.png`));
  staged++;
}
console.log(`staged ${staged} template${staged === 1 ? "" : "s"} into site/t/`);
