import * as esbuild from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

// A published page's only record of which runtime it runs is the content hash in
// its asset URL, which says nothing to a person. The version goes in so the
// upgrade offer can name what you have and what is on offer.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

for (const [outfile, format, globalName] of [
  ["dist/nsite-clay.js", "iife", "NsiteClayBundle"],
  ["dist/nsite-clay.esm.js", "esm", undefined],
]) {
  await esbuild.build({
    entryPoints: ["src/index.js"],
    bundle: true, minify: true, format, globalName, outfile,
    target: ["es2022"], legalComments: "none",
    define: { __NC_VERSION__: JSON.stringify(version) },
    banner: { js: `/* nsite-clay ${version} - a single HTML file that edits and republishes itself. MIT-0. */` },
  });
  const b = readFileSync(outfile);
  console.log(outfile, (b.length / 1024).toFixed(1) + "KB", "gz " + (gzipSync(b).length / 1024).toFixed(1) + "KB");
}
