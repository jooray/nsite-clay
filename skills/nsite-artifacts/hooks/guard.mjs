#!/usr/bin/env node
// A guard that runs outside the model, before a shell command does.
//
// The artifact tool already refuses to publish in the clear unless it is told
// to twice. This is for a person who wants that taken out of the model's hands
// altogether: wired in as a pre-tool hook, it stops any shell command that
// would publish a page publicly, or publish one with a different tool, and it
// stops the ledger of keys from being read.
//
// Input: the hook's JSON on stdin, in the shape Claude Code sends to PreToolUse
// ({ "tool_name": "Bash", "tool_input": { "command": "…" } }). Hermes Agent
// documents its pre_tool_call shell hooks as accepting the same shape.
// Output: nothing and exit 0 to allow; a reason on stderr and exit 2 to block.
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try { input = JSON.parse(raw); } catch { process.exit(0); }
const command = String(input?.tool_input?.command ?? input?.tool_input?.cmd ?? "");
const path = String(input?.tool_input?.file_path ?? input?.tool_input?.path ?? "");

const rules = [
  [/artifact(\.mjs)?\b[^|;&]*--visibility[= ]public|artifact(\.mjs)?\b[^|;&]*--public\b/,
    "Publishing a public page is turned off here. Use --visibility=link, or ask the user to publish it themselves."],
  [/\b(nsite-clay|nsyte)\s+(deploy|upload|publish)\b|\bnak\s+(event|blossom)\b|\bsurge\b|\bvercel\s+(deploy|--prod)\b|\bwrangler\s+pages\b|\bgh\s+gist\s+create\b/,
    "Pages are published only with the nsite-artifacts script, which encrypts them. Use: artifact create <file.html>"],
  [/nsite-clay\/artifacts\/(ledger\.json|config\.json|seen\/)/,
    "That folder holds the keys of every published page. Use the artifact commands (list, links, read) instead of reading it."],
  [/--allow-blocked\b/, "A page that loads from other sites is not published encrypted. Put what it needs inside the file."],
];
for (const [pattern, reason] of rules) {
  if (pattern.test(command) || pattern.test(path)) { console.error(reason); process.exit(2); }
}
process.exit(0);
