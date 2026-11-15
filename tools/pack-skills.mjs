#!/usr/bin/env node
// Packs every skill under skills/ into a zip: dist-skills/<name>-<version>.zip
// and a stable-named copy dist-skills/<name>.zip. No zip binary and no
// dependency: the format is written here. Output is deterministic, so two packs
// of the same tree are byte-identical.
//
//   node tools/pack-skills.mjs [outDir] [--skills=<dir>]
//
// The archive holds one top-level folder, <name>/, with SKILL.md directly in it.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_TOTAL = 5 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The small YAML subset a SKILL.md header uses: `key: value`, and one level of
// nesting under a key with no value (metadata:).
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) throw new Error("SKILL.md has no frontmatter");
  const out = {};
  let parent = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const nested = /^\s+/.test(line);
    const kv = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`frontmatter line is not "key: value": ${line.trim().slice(0, 40)}`);
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) throw new Error(`frontmatter "${kv[1]}" must be a single line, not a block scalar`);
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (nested && parent) out[parent][kv[1]] = v;
    else if (v === "") { out[kv[1]] = {}; parent = kv[1]; }
    else { out[kv[1]] = v; parent = null; }
  }
  return out;
}

function validate(dir, name) {
  const skillPath = join(dir, "SKILL.md");
  if (!existsSync(skillPath)) throw new Error("SKILL.md is missing");
  const text = readFileSync(skillPath, "utf8");
  if (/[–—]/.test(text)) throw new Error("SKILL.md contains an em or en dash");
  const fm = parseFrontmatter(text);
  if (typeof fm.name !== "string" || !fm.name) throw new Error("frontmatter has no name");
  if (!/^[a-z0-9-]+$/.test(fm.name) || fm.name.length > 64) throw new Error(`name "${fm.name}" must be a-z, 0-9 and hyphens, at most 64 characters`);
  if (fm.name !== name) throw new Error(`name "${fm.name}" does not equal the folder name "${name}"`);
  if (typeof fm.description !== "string" || !fm.description.trim()) throw new Error("frontmatter has no description");
  if (fm.description.length > 1024) throw new Error(`description is ${fm.description.length} characters, the limit is 1024`);
  const version = fm.metadata && fm.metadata.version;
  if (!version) throw new Error("frontmatter has no metadata.version");
  if (!/^[A-Za-z0-9._+-]+$/.test(version)) throw new Error(`metadata.version "${version}" is not usable in a file name`);
  return { version };
}

function collect(dir, rel = "") {
  const files = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const n = entry.name;
    if (n.startsWith(".") || n === "node_modules" || n.endsWith(".map")) continue;
    const r = rel ? `${rel}/${n}` : n;
    if (entry.isDirectory()) files.push(...collect(dir, r));
    else if (entry.isFile()) files.push(r);
  }
  return files;
}

function modeFor(rel, data) {
  const shebang = data.length > 2 && data[0] === 0x23 && data[1] === 0x21;
  return shebang || rel.startsWith("hooks/") || rel.startsWith("scripts/") ? 0o755 : 0o644;
}

export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01 00:00:00
  for (const { path, data, mode } of entries) {
    const name = Buffer.from(path, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const method = useDeflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function packSkill(skillsDir, name, outDir) {
  const dir = join(skillsDir, name);
  const { version } = validate(dir, name);
  const rels = collect(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // SKILL.md first, so the archive opens on it.
  rels.splice(0, rels.length, "SKILL.md", ...rels.filter((r) => r !== "SKILL.md"));
  const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
  for (const m of skill.matchAll(/`((?:scripts|references|assets|hooks)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g)) {
    if (!rels.includes(m[1])) throw new Error(`SKILL.md mentions ${m[1]} but the file does not exist`);
  }
  let total = 0;
  const entries = rels.map((rel) => {
    const data = readFileSync(join(dir, rel));
    total += data.length;
    return { path: `${name}/${rel}`, data, mode: modeFor(rel, data) };
  });
  if (total > MAX_TOTAL) throw new Error(`the skill is ${total} bytes, the limit is ${MAX_TOTAL}`);
  const zip = buildZip(entries);
  mkdirSync(outDir, { recursive: true });
  const versioned = join(outDir, `${name}-${version}.zip`);
  const stable = join(outDir, `${name}.zip`);
  writeFileSync(versioned, zip);
  writeFileSync(stable, zip);
  return { name, version, files: entries.map((e) => e.path), bytes: zip.length, versioned, stable };
}

export function packAll(skillsDir, outDir) {
  const names = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name).sort();
  return names.map((n) => {
    try { return packSkill(skillsDir, n, outDir); }
    catch (e) { throw new Error(`skill ${n}: ${e.message}`); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const skillsArg = args.find((a) => a.startsWith("--skills="));
  const outArg = args.find((a) => !a.startsWith("--"));
  const skillsDir = skillsArg ? resolve(skillsArg.slice(9)) : join(ROOT, "skills");
  const outDir = outArg ? resolve(outArg) : join(ROOT, "dist-skills");
  try {
    // The default folder holds only what this version packs, never an old release's zips.
    if (!outArg && existsSync(outDir)) for (const f of readdirSync(outDir)) if (f.endsWith(".zip")) rmSync(join(outDir, f));
    for (const r of packAll(skillsDir, outDir)) console.log(`packed ${r.versioned.replace(ROOT + "/", "")} (${r.bytes} bytes, ${r.files.length} files)`);
  } catch (e) {
    console.error(`pack-skills: ${e.message}`);
    process.exit(1);
  }
}
