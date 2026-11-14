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
  // The Cashu wallet is a publisher feature: somebody buying credit needs it,
  // a reader of a published page never does. Inlined it would cost every reader
  // 9.8 KB gzipped; here it costs 23 KB once, to the one person who is paying.
  ["dist/nsite-clay-wallet.js", "iife", "NsiteClayWallet", "src/wallet-entry.js"],
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

// The agent skill's tool, as one file with its dependencies inside, so an agent
// in a container runs it with node and nothing else. Same source as
// `nsite-clay artifact`.
await esbuild.build({
  entryPoints: ["bin/artifact.mjs"], bundle: true, minify: true, platform: "node", format: "esm", target: "node18",
  outfile: "skills/nsite-artifacts/scripts/artifact.mjs", legalComments: "none",
  banner: { js: `// nsite-artifacts ${version}. Built from bin/artifact.mjs and src/seal.js of nsite-clay (nostr-tools, @noble/hashes, parse5 and ws inside). MIT-0.\n// One file, nothing to install: node artifact.mjs help\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
});
{
  const b = readFileSync("skills/nsite-artifacts/scripts/artifact.mjs");
  console.log("skills/nsite-artifacts/scripts/artifact.mjs", (b.length / 1024).toFixed(1) + "KB");
}
