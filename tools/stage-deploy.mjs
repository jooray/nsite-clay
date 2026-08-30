#!/usr/bin/env node
// The publisher in every language the site speaks, and the guide's pictures.
//
// deploy.html is an application rather than prose: it carries all four languages
// in one strings table and picks by <html lang>, so a translation is a line in
// that table rather than a fork of the page. What each language still needs is
// its own file at its own path, differing only in the language attribute and the
// title a crawler reads. That is what this generates, so nobody keeps four
// copies of an application in step by hand.
//
// guide.html is the other way round. It is mostly writing, and writing is
// translated properly, so site/es/guide.html and its siblings are real files
// with real prose in them. Only the screenshots are shared, and they are staged
// here because they come out of tools/publish-walkthrough.mjs at twice the size
// any page needs.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const LANGS = ["es", "sk", "cs"];

// Only what a crawler and a reader see before the strings table runs.
const TITLES = {
  "deploy.html": {
    es: ["nsite-clay: publica un sitio",
         "Publica un sitio web autoeditable en Nostr desde tu navegador. Elige una plantilla, inicia sesión con tu clave y ya está en línea. Sin terminal y sin cuenta."],
    sk: ["nsite-clay: zverejni stránku",
         "Zverejni si samoupraviteľnú webstránku na Nostri priamo z prehliadača. Vyber šablónu, prihlás sa kľúčom a je online. Bez terminálu a bez účtu."],
    cs: ["nsite-clay: zveřejni stránku",
         "Zveřejni si samoupravitelnou webstránku na Nostru přímo z prohlížeče. Vyber šablonu, přihlas se klíčem a je online. Bez terminálu a bez účtu."],
  },
};

let made = 0;
for (const page of Object.keys(TITLES)) {
  let source;
  try { source = readFileSync(join("site", page), "utf8"); }
  catch { continue; }

  for (const lang of LANGS) {
    const [title, description] = TITLES[page][lang];
    const out = source
      .replace(/<html lang="en"/, `<html lang="${lang}"`)
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(">)/, `$1${description}$2`);
    if (out === source) {
      console.warn(`stage-deploy: nothing was substituted in ${page} for ${lang}`);
    }
    mkdirSync(join("site", lang), { recursive: true });
    writeFileSync(join("site", lang, page), out);
    made++;
  }
}
console.log(`staged ${made} translated page${made === 1 ? "" : "s"} into site/{${LANGS.join(",")}}/`);

// The guide's pictures. They are captured at 2360px for a retina display, which
// is several megabytes for one page, so they go out at the width the guide
// actually draws them and are packed losslessly on the way.
const SHOTS = join("media", "guide-publish");
const DEST = join("site", "shots");
let shots = 0;
try {
  mkdirSync(DEST, { recursive: true });
  for (const f of readdirSync(SHOTS)) {
    if (!f.endsWith(".png")) continue;
    const to = join(DEST, f);
    copyFileSync(join(SHOTS, f), to);
    try { execFileSync("sips", ["--resampleWidth", "1400", to], { stdio: "ignore" }); }
    catch { /* sips is macOS only; the full-size copy still works */ }
    shots++;
  }
} catch { /* no walkthrough has been run yet */ }

if (shots) {
  try {
    const size = () => readdirSync(DEST).reduce((n, f) => n + statSync(join(DEST, f)).size, 0);
    const before = size();
    execFileSync("picopt", ["-q", "-r", DEST], { stdio: "ignore" });
    const saved = before - size();
    console.log(`staged ${shots} guide screenshot${shots === 1 ? "" : "s"}` +
      (saved > 0 ? `, ${(saved / 1024).toFixed(0)} kB smaller after packing` : ""));
  } catch {
    console.log(`staged ${shots} guide screenshots, unoptimised (picopt not found)`);
  }
}
