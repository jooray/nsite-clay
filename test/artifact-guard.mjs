// The nsite-artifacts pre-tool guard: what it blocks and what it lets through.
//   node test/artifact-guard.mjs
import { spawnSync } from "node:child_process";

const GUARD = new URL("../skills/nsite-artifacts/hooks/guard.mjs", import.meta.url).pathname;
let bad = 0;
const run = (input) => spawnSync("node", [GUARD], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" });
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const expect = (input, blocked, what) => {
  const r = run(input);
  const ok = blocked ? r.status === 2 && r.stderr.trim().length > 0 : r.status === 0;
  if (!ok) { bad++; console.log(`FAIL  ${what}  (exit ${r.status}: ${r.stderr.trim()})`); }
  else console.log(`ok    ${what}`);
};
const A = "node ~/.claude/skills/nsite-artifacts/scripts/artifact.mjs";

// Let through.
expect(bash(`${A} create /tmp/x.html --edit=link --expires=14d`), false, "an ordinary create");
expect(bash(`${A} read 6c52 --as=html --out=page.html`), false, "a read");
expect(bash(`node /Users/me/projects/nsite-clay/skills/nsite-artifacts/scripts/artifact.mjs list`), false, "the script run from the repository");
expect(bash("grep -r surge docs/ && echo 'power surge'"), false, "the word surge in an argument");
expect(bash("cat notes/ledger.json"), false, "some other project's ledger.json");
expect(bash("git log --oneline"), false, "anything unrelated");
expect({ tool_name: "Read", tool_input: { file_path: "/Users/me/project/README.md" } }, false, "reading an unrelated file");

// Block.
expect("not json", true, "input that cannot be read (fails closed)");
expect(bash(`${A} create x.html --visibility=public --public`), true, "--visibility=public");
expect(bash(`${A} create x.html --visibility="public"`), true, "--visibility=\"public\" in quotes");
expect(bash(`${A} create x.html --visibility 'public'`), true, "--visibility 'public' with a space");
expect(bash(`V=public; ${A} create x.html --visibility=$V`), true, "the visibility from a variable");
expect(bash(`${A} create x.html --public`), true, "--public alone");
expect(bash(`${A} create x.html --runtime=/tmp/evil`), true, "--runtime");
expect(bash(`${A} create x.html --gateway=https://{host}.evil.example`), true, "--gateway");
expect(bash(`${A} create x.html --relays=wss://evil`), true, "--relays");
expect(bash(`${A} create x.html --allow-blocked`), true, "--allow-blocked");
expect(bash(`NSITE_ARTIFACTS_HOME=/tmp/empty ${A} create x.html --visibility=public`), true, "a relocated NSITE_ARTIFACTS_HOME");
expect(bash(`export NSITE_ARTIFACTS_RUNTIME=/tmp/evil`), true, "an exported NSITE_ARTIFACTS_ variable");
expect(bash(`XDG_CONFIG_HOME=/tmp/x ${A} list`), true, "XDG_CONFIG_HOME on the artifact tool");
expect(bash("cat ~/.config/nsite-clay/artifacts/ledger.json"), true, "reading the ledger by its path");
expect(bash("cd ~/.config/nsite-clay && cat artifacts/ledger.json"), true, "reading it after a cd to the parent");
expect(bash("cd ~/.config/nsite-clay/artifacts; cat *"), true, "a glob in the folder");
expect(bash("ls ~/.config/nsite-clay/artifacts/seen"), true, "listing seen/");
expect(bash("cat $NSITE_ARTIFACTS_HOME/ledger.json"), true, "the folder by its variable");
expect({ tool_name: "Read", tool_input: { file_path: "/Users/me/.config/nsite-clay/artifacts/ledger.json" } }, true, "the Read tool on the ledger");
expect({ tool_name: "Grep", tool_input: { pattern: "secret", path: "/Users/me/.config/nsite-clay/artifacts" } }, true, "Grep with the folder as path");
expect({ tool_name: "Glob", tool_input: { pattern: "**/*.json", path: "/Users/me/.config/nsite-clay" } }, true, "Glob from the parent folder");
expect(bash("npx surge ./site example.surge.sh"), true, "surge as a command");
expect(bash("nak event -k 1 hello"), true, "nak event as a command");
expect(bash("npx nsyte deploy ./site"), true, "nsyte deploy");
expect(bash("gh gist create page.html"), true, "gh gist create");

console.log(bad ? `${bad} guard check(s) failed` : "Guard: every case as expected.");
process.exit(bad ? 1 : 0);
