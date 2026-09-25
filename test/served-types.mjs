#!/usr/bin/env node
// Some Blossom servers ignore the Content-Type a file was uploaded with and
// guess it from the bytes, the way `file` does, and gateways pass that guess on.
// blossom.primal.net served the shared stylesheet as text/html because a
// comment near its top mentioned <html>, and a browser will not apply a
// stylesheet served as HTML: every page fetched through it lost its design.
// So nothing we ship as CSS or JavaScript may look like HTML near its start.
//   node test/served-types.mjs
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const files = [];
for (const dir of ["templates/_shared", "dist", "site"]) {
  if (!existsSync(join(ROOT, dir))) continue;
  for (const f of readdirSync(join(ROOT, dir))) if (/\.(css|m?js)$/.test(f)) files.push(join(dir, f));
}
// Ask libmagic itself, through file(1), rather than guess at its rules: it is
// what those servers run, and a pattern of our own was both stricter and wrong.
const probe = spawnSync("file", ["-b", "--mime-type", ...files.map((f) => join(ROOT, f))], { encoding: "utf8" });
if (probe.status !== 0) { console.log("Served types: file(1) is not available, skipped."); process.exit(0); }
const types = probe.stdout.trim().split("\n");
let fail = 0;
files.forEach((f, i) => {
  if (/html/.test(types[i])) { fail++; console.log(`FAIL  ${f} is read as ${types[i]}`); }
});
console.log(fail ? `${fail} file(s) could be served as text/html` : `Served types: ${files.length} CSS and JS files read as what they are.`);
process.exit(fail ? 1 : 0);
