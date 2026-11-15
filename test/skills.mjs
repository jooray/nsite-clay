#!/usr/bin/env node
// The skill zips: what they hold, that packing is deterministic, that they are
// valid archives, and that a broken skill is refused.
//   node test/skills.mjs
import { mkdtempSync, readFileSync, cpSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { packAll } from "../tools/pack-skills.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SKILLS = join(ROOT, "skills");
let fail = 0;
const check = (ok, what) => { if (!ok) { fail++; console.log(`FAIL  ${what}`); } };

const tmp = mkdtempSync(join(tmpdir(), "skills-test-"));
const a = packAll(SKILLS, join(tmp, "a"));
const b = packAll(SKILLS, join(tmp, "b"));

// A minimal zip reader: central directory names only.
function names(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), com = buf.readUInt16LE(p + 32);
    out.push(buf.subarray(p + 46, p + 46 + len).toString("utf8"));
    p += 46 + len + extra + com;
  }
  return out;
}

const expected = {
  "nsite-artifacts": ["SKILL.md", "assets/list.html", "hooks/guard.mjs", "scripts/artifact.mjs"],
  "nsite-clay-web-builder": ["SKILL.md", "references/llms-edit.txt", "references/llms.txt"],
};
for (const [name, files] of Object.entries(expected)) {
  const r = a.find((x) => x.name === name);
  check(r, `${name} was packed`);
  if (!r) continue;
  const zip = readFileSync(r.versioned);
  const got = names(zip);
  check(got[0] === `${name}/SKILL.md`, `${name}: first entry is ${name}/SKILL.md, got ${got[0]}`);
  check(got.every((n) => n.startsWith(`${name}/`)), `${name}: one top-level folder`);
  for (const f of files) check(got.includes(`${name}/${f}`), `${name}: holds ${f}`);
  check(readFileSync(r.stable).equals(zip), `${name}: stable copy equals versioned zip`);
  check(r.versioned.endsWith(`${name}-${r.version}.zip`), `${name}: versioned name`);
  const rb = b.find((x) => x.name === name);
  check(readFileSync(rb.versioned).equals(zip), `${name}: two packs are byte-identical`);
  const un = spawnSync("unzip", ["-tq", r.versioned], { encoding: "utf8" });
  if (!un.error) check(un.status === 0, `${name}: unzip -t says ${un.stdout}${un.stderr}`);
}

// The shipped references are the site's briefs.
for (const [ref, site] of [["llms.txt", "llms.txt"], ["llms-edit.txt", "llms-edit.txt"]]) {
  const s = join(ROOT, "site", site);
  if (!existsSync(s)) { console.log(`note: site/${site} not staged, comparison skipped`); continue; }
  check(readFileSync(join(SKILLS, "nsite-clay-web-builder/references", ref)).equals(readFileSync(s)), `references/${ref} equals site/${site} (run npm run site:build)`);
}

// The bundled script in the zip is the one in the repo.
{
  const un = spawnSync("unzip", ["-p", join(tmp, "a", "nsite-artifacts.zip"), "nsite-artifacts/scripts/artifact.mjs"], { maxBuffer: 1 << 26 });
  if (!un.error) check(un.stdout.equals(readFileSync(join(SKILLS, "nsite-artifacts/scripts/artifact.mjs"))), "artifact.mjs in the zip equals the repo file");
}

// A deliberately bad skill is refused.
{
  const bad = join(tmp, "bad");
  cpSync(join(SKILLS, "nsite-clay-web-builder"), join(bad, "wrong-name"), { recursive: true });
  let msg = "";
  try { packAll(bad, join(tmp, "bad-out")); } catch (e) { msg = e.message; }
  check(/does not equal the folder name/.test(msg), `wrong folder name is rejected (got "${msg}")`);
  const dash = join(tmp, "dash");
  cpSync(join(SKILLS, "nsite-clay-web-builder"), join(dash, "nsite-clay-web-builder"), { recursive: true });
  writeFileSync(join(dash, "nsite-clay-web-builder/SKILL.md"), readFileSync(join(dash, "nsite-clay-web-builder/SKILL.md"), "utf8") + "\nbad — dash\n");
  msg = "";
  try { packAll(dash, join(tmp, "dash-out")); } catch (e) { msg = e.message; }
  check(/dash/.test(msg), `an em dash is rejected (got "${msg}")`);
  const gone = join(tmp, "gone");
  cpSync(join(SKILLS, "nsite-clay-web-builder"), join(gone, "nsite-clay-web-builder"), { recursive: true });
  rmSync(join(gone, "nsite-clay-web-builder/references/llms.txt"));
  msg = "";
  try { packAll(gone, join(tmp, "gone-out")); } catch (e) { msg = e.message; }
  check(/does not exist/.test(msg), `a mentioned file that is missing is rejected (got "${msg}")`);
}

rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `${fail} skill check(s) failed` : `Skills: ${a.map((r) => `${r.name}-${r.version}`).join(", ")} pack, deterministic and valid.`);
process.exit(fail ? 1 : 0);
