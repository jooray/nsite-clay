import * as esbuild from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

// A published page's only record of which runtime it runs is the content hash in
// its asset URL, which says nothing to a person. The version goes in so the
// upgrade offer can name what you have and what is on offer.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const notices = ["parse5", "entities", "quickcrop", "hyper-undo"].map((name) =>
  `${name}\n${readFileSync(`node_modules/${name}/LICENSE`, "utf8")}`).join("\n\n");
writeFileSync("dist/THIRD-PARTY-LICENSES.txt", notices);

// The source-preserving serialiser and the HTML parser it needs are a third of
// the runtime, and only the owner of the page, at the moment they save, has any
// use for them. Everybody else is reading. So they are built as their own file
// and fetched when editing starts, not when the page loads.
for (const [outfile, format, globalName, entry] of [
  ["dist/nsite-clay.js", "iife", "NsiteClayBundle", "src/index.js"],
  ["dist/nsite-clay.esm.js", "esm", undefined, "src/index.js"],
  ["dist/nsite-clay-source.js", "iife", "NsiteClaySource", "src/vendor/clay-source/source-map.js"],
]) {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true, minify: true, format, globalName, outfile,
    target: ["es2022"], legalComments: "none",
    define: { __NC_VERSION__: JSON.stringify(version) },
    banner: { js: `/* nsite-clay ${version} - a single HTML file that edits and republishes itself. MIT-0.\n${notices.replace(/\*\//g, "* /")}\n*/` },
  });
  const b = readFileSync(outfile);
  console.log(outfile, (b.length / 1024).toFixed(1) + "KB", "gz " + (gzipSync(b).length / 1024).toFixed(1) + "KB");
}
