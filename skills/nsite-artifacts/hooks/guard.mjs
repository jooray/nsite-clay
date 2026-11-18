#!/usr/bin/env node
// A guard that runs outside the model, before a tool call does.
//
// The artifact tool already refuses to publish in the clear unless it is told
// to twice. This is for a person who wants that taken out of the model's hands
// altogether: wired in as a pre-tool hook, it stops a shell command that would
// publish a page publicly, publish one with a different tool, point the tool
// somewhere else than its settings say, or read the folder that holds the keys.
//
// It is a tripwire, not a wall. It reads the command as text, so a command
// built at run time from pieces can get past it. The control that holds is in
// the tool: "allowPublic": false and "locked": true in its settings file.
//
// Input: the hook's JSON on stdin, in the shape Claude Code sends to PreToolUse
// ({ "tool_name": "Bash", "tool_input": { "command": "…" } }) and that several
// other harnesses accept for their pre-tool shell hooks. File tools (Read,
// Grep, Glob and the like) are checked by their path, pattern and glob.
// Output: nothing and exit 0 to allow; a reason on stderr and exit 2 to block.
// Input that cannot be read is blocked: a guard that lets through what it does
// not understand guards nothing.
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw); } catch {
  console.error("The nsite-artifacts guard could not read this tool call, so it is blocked.");
  process.exit(2);
}
const ti = input?.tool_input ?? {};
const command = String(ti.command ?? ti.cmd ?? "");
const paths = [ti.file_path, ti.path, ti.pattern, ti.glob, ti.notebook_path].filter((x) => typeof x === "string").join("\n");
// Quotes do not change what a shell runs: --visibility="public" is --visibility=public.
const flat = command.replace(/\\\n/g, " ").replace(/["']/g, "");
const isArtifact = /artifact(\.mjs)?\b/.test(flat);
// A command starts at the beginning, or after ; & | ( or a newline, or after
// env/npx/sudo and assignments.
const at = String.raw`(?:^|[;&|(\n]\s*|\b(?:npx|sudo|env|exec|command)\s+(?:-\S+\s+)*)(?:\w+=\S*\s+)*`;

const KEYS = "That folder holds the keys of every published page. Use the artifact commands (list, links, read, export) instead of reading it.";
const rules = [
  [() => isArtifact && /--visibility[= ]+(public\b|\$)/.test(flat),
    "Publishing a public page is turned off here. Use --visibility=link, or ask the user to publish it themselves."],
  [() => isArtifact && /(^|\s)--public\b/.test(flat),
    "Publishing a public page is turned off here. Use --visibility=link, or ask the user to publish it themselves."],
  [() => isArtifact && /(^|\s)--(runtime|gateway|relays|servers|uploader)\b/.test(flat),
    "Where pages are published and which runtime they load is decided by the settings file, not by a flag. Leave those flags out."],
  [() => isArtifact && /--allow-blocked\b/.test(flat),
    "A page that loads from other sites is not published encrypted. Put what it needs inside the file."],
  [() => /\bNSITE_ARTIFACTS_[A-Z_]+\s*=/.test(flat) || (isArtifact && /\bXDG_CONFIG_HOME\s*=/.test(flat)),
    "The artifact tool's settings and key folder are not changed from a command. Run it without NSITE_ARTIFACTS_ variables."],
  [() => new RegExp(at + String.raw`(?:nsite-clay|nsyte)\s+(?:deploy|upload|publish)\b`).test(flat) ||
      new RegExp(at + String.raw`nak\s+(?:event|blossom)\b`).test(flat) ||
      new RegExp(at + String.raw`surge(?:\s|$)`).test(flat) ||
      new RegExp(at + String.raw`vercel\s+(?:deploy|--prod)\b`).test(flat) ||
      new RegExp(at + String.raw`wrangler\s+pages\b`).test(flat) ||
      new RegExp(at + String.raw`gh\s+gist\s+create\b`).test(flat),
    "Pages are published only with the nsite-artifacts script, which encrypts them. Use: artifact create <file.html>"],
  // The folder, however it is reached: by its full path, from its parent, by a
  // variable, or by a file tool.
  [() => /nsite-clay\/artifacts\b|\$\{?NSITE_ARTIFACTS_HOME\b/.test(flat) ||
      (/nsite-clay\b/.test(flat) && /(^|[\s/])artifacts(\/|\s|$)|\bledger\.json\b|\bconfig\.json\b|\bseen\b/.test(flat)) ||
      (/\bledger\.json\b/.test(flat) && /nsite|artifact/.test(flat)),
    KEYS],
  [() => /nsite-clay\/artifacts\b|nsite-clay\/?$|nsite-clay\/(ledger|seen)|\bledger\.json\b/m.test(paths) ||
      (/nsite-clay\b/.test(paths) && /\*\*|ledger|seen|config\.json/.test(paths)),
    KEYS],
];
for (const [test, reason] of rules) {
  if (test()) { console.error(reason); process.exit(2); }
}
process.exit(0);
