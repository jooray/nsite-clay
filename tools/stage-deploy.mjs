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

// Paths that exist in every language, so a translated copy must point at its own.
const LOCALISED = ["/", "/guide.html", "/templates.html", "/docs.html", "/index.html"];

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
    let out = source
      .replace(/<html lang="en"/, `<html lang="${lang}"`)
      // The copy has to say where it actually lives. A page watches its own
      // manifest entry to know when a newer version exists, so a Slovak copy
      // claiming to be /deploy.html compares its own bytes against the English
      // file's hash, never matches, and reloads itself forever.
      .replace(/nc:path="\/([^"]*)"/, `nc:path="/${lang}/$1"`)
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(">)/, `$1${description}$2`);

    // Every link in the copy has to lead to that language's page. Left alone,
    // a reader of the Slovak publisher who presses Guide lands in English, and
    // a check that the target file exists says nothing is wrong, because
    // /guide.html does exist.
    //
    // The language switcher and the hreflang alternates are the exception:
    // those name every language on purpose, so they are lifted out first and
    // put back untouched.
    const kept = [];
    out = out
      .replace(/<span class="langs">[\s\S]*?<\/span>\s*<\/p>/,
               (m) => `\u0000${kept.push(m) - 1}\u0000`)
      .replace(/<link rel="alternate"[^>]*>/g, (m) => `\u0000${kept.push(m) - 1}\u0000`);

    for (const path of LOCALISED) {
      out = out.split(`href="${path}"`).join(`href="/${lang}${path === "/" ? "/" : path}"`);
    }
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
    if (out === source) {
      console.warn(`stage-deploy: nothing was substituted in ${page} for ${lang}`);
    }
    mkdirSync(join("site", lang), { recursive: true });
    writeFileSync(join("site", lang, page), out);
    made++;
  }
}
console.log(`staged ${made} translated page${made === 1 ? "" : "s"} into site/{${LANGS.join(",")}}/`);

// A page that misreports its own path reloads itself forever: it watches the
// manifest entry for the path it claims, compares that hash against the bytes it
// was served, and never matches. Cheap to check, and invisible until somebody
// opens the page and watches it flicker.
{
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name))
                    : (e.name.endsWith(".html") ? [join(dir, e.name)] : []));
  let wrong = 0;
  for (const file of walk("site")) {
    const want = "/" + file.split("/").slice(1).join("/");
    // A missing nc:path is not a free pass: it defaults to /index.html, which
    // is exactly how the staged templates ended up in a reload loop.
    const said = (readFileSync(file, "utf8").match(/nc:path="([^"]*)"/) || [])[1]
      || "/index.html";
    if (said !== want) {
      console.error(`stage-deploy: ${file} says nc:path="${said}" but lives at ${want}. ` +
                    `It will reload itself in a loop.`);
      wrong++;
    }
  }
  if (wrong) process.exitCode = 1;
}

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
