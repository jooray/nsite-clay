// How skills/nsite-artifacts/scripts/artifact.mjs is built from bin/artifact.mjs.
// Used by build.mjs to write it, and by test/skills.mjs to rebuild it in memory
// and fail when the committed copy is not what the source builds to.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ARTIFACT_OUT = "skills/nsite-artifacts/scripts/artifact.mjs";

export function artifactBuildOptions(version) {
  return {
    absWorkingDir: ROOT,
    entryPoints: ["bin/artifact.mjs"], bundle: true, minify: true, platform: "node", format: "esm", target: "node18",
    outfile: ARTIFACT_OUT, legalComments: "none",
    define: { __NC_VERSION__: JSON.stringify(version) },
    // The first statement refuses a Node too old for it, in a sentence, before
    // anything in the bundle can fail in a way nobody can read.
    banner: { js: `// nsite-artifacts ${version}. Built from bin/artifact.mjs, src/seal.js and src/retire.js of nsite-clay (nostr-tools, @noble/hashes, parse5 and ws inside). MIT-0.\n// One file, nothing to install: node artifact.mjs help\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);\nif (Number(process.versions.node.split(".")[0]) < 18) { console.error("nsite-artifacts: this needs Node.js 18 or newer, and this is Node " + process.versions.node + ". Install a newer Node and run it again."); process.exit(1); }` },
  };
}
