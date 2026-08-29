import * as esbuild from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

for (const [outfile, format, globalName] of [
  ["dist/nsite-clay.js", "iife", "NsiteClayBundle"],
  ["dist/nsite-clay.esm.js", "esm", undefined],
]) {
  await esbuild.build({
    entryPoints: ["src/index.js"],
    bundle: true, minify: true, format, globalName, outfile,
    target: ["es2022"], legalComments: "none",
    banner: { js: "/* nsite-clay - a single HTML file that edits and republishes itself. MIT-0. */" },
  });
  const b = readFileSync(outfile);
  console.log(outfile, (b.length / 1024).toFixed(1) + "KB", "gz " + (gzipSync(b).length / 1024).toFixed(1) + "KB");
}
