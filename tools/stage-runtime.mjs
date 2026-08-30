#!/usr/bin/env node
// What a published page reads to find out whether its runtime has moved on.
//
// The hashes never come from here: those are read out of the project's signed
// manifest, so a notes file cannot talk a page into installing something the key
// did not publish. This is only the half a person reads -- which version, when,
// and what changed -- so that the offer says something more useful than "the
// bytes are different".
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const releases = JSON.parse(readFileSync("docs/releases.json", "utf8"));
const here = releases.find((r) => r.version === version);

if (!here) {
  console.warn(`stage-runtime: docs/releases.json has no entry for ${version}. ` +
               `The update offer will name the version and list the files, with nothing to read.`);
}

const out = { version, released: here?.released || null, notes: here?.notes || [] };
writeFileSync("site/runtime.json", JSON.stringify(out, null, 2) + "\n");
console.log(`staged site/runtime.json for ${version}` +
            (here ? ` (${out.notes.length} note${out.notes.length === 1 ? "" : "s"})` : ", no notes"));
