#!/usr/bin/env node
// The general version of the instructions a page copies for its owner's own
// coding agent, staged onto the project site as /llms-edit.txt.
//
// It is the same template the runtime fills in, called with no facts, so the
// published text and the one in every page cannot say different things.
import { writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { agentInstructions, GENERAL_PATH } from "../src/agent-brief.js";

const text = agentInstructions(null);
// The site's writing rule, checked where it is cheapest to keep.
if (/[–—]/.test(text)) {
  console.error("stage-agent: the agent instructions contain an em or en dash.");
  process.exitCode = 1;
}
writeFileSync("site" + GENERAL_PATH, text);
console.log(`staged site${GENERAL_PATH} (${text.split("\n").length} lines)`);

// The nsite-clay skill ships both briefs, so the zip works offline and cannot
// drift from the site.
const refs = "skills/nsite-clay-web-builder/references";
mkdirSync(refs, { recursive: true });
copyFileSync("site/llms.txt", `${refs}/llms.txt`);
copyFileSync("site" + GENERAL_PATH, `${refs}/llms-edit.txt`);
console.log(`copied llms.txt and llms-edit.txt into ${refs}`);
