#!/usr/bin/env node
// decision-board: one entry point for the whole loop.
//
//   board.mjs validate board.json
//   board.mjs build    board.json [out.html] [--carry=page.html]
//   board.mjs publish  board.json [--watch=24h|ISO|until-decided] [--expires=30d] [--notify="text"]
//   board.mjs pull     board.json [<id>] [--settle=45] [--force]
//   board.mjs push     board.json [<id>] [--watch=...|off] [--notify="text"]
//   board.mjs watch    board.json|<id> [--every=600] [--until=ISO|24h] [--settle=45]
//
// Every command prints one JSON object on stdout. Problems go to stderr as a sentence that says what
// to do. Exit codes: 0 fine, 1 refused (validation, a newer save), 2 bad arguments, 3 page gone or
// expired, 4 network or tool failure, 5 (watch only) the deadline passed.
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { notify } from "./notify.mjs";
import { loadBoard, normalize, validate, PAGE_MAX } from "./lib/schema.mjs";
import { render, carryComments } from "./lib/render.mjs";
import { merge } from "./lib/readback.mjs";
import { findTool, runTool, parseDuration, parseUntil } from "./lib/tool.mjs";

class Exit extends Error { constructor(code, msg, out) { super(msg); this.exitCode = code; this.out = out; } }
const fail = (code, msg, out) => { throw new Exit(code, msg, out); };

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const opts = {};
const pos = [];
for (const a of rest) {
  const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(a);
  if (m) opts[m[1]] = m[2] ?? true; else pos.push(a);
}
const boardPath = pos.find((p) => /\.json$/i.test(p)) || null;
const others = pos.filter((p) => p !== boardPath);

function workDir(bp) {
  const dir = join(dirname(resolve(bp)), ".decision-board", basename(bp).replace(/\.json$/i, ""));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const gi = join(dirname(dir), ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "# what the owner wrote on the page, kept for the next build\n*\n");
  return dir;
}

function saveBoard(bp, board) {
  const tmp = `${bp}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(board, null, 2) + "\n");
  renameSync(tmp, bp);
}

function needBoard() {
  if (!boardPath) fail(2, `usage: board.mjs ${cmd} board.json ...`);
  return loadBoard(boardPath);
}

function checked(raw) {
  const v = validate(raw, { boardPath });
  if (v.errors.length) fail(1, `board.json has ${v.errors.length} problem(s):\n- ${v.errors.join("\n- ")}`, { ok: false, errors: v.errors, warnings: v.warnings });
  return v;
}

function idOf(board) {
  const id = others[0] || (board && board.artifact && board.artifact.id);
  if (!id) fail(2, "no page id: give it as an argument, or publish the board first (publish writes artifact.id into board.json)");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(id)) fail(2, `"${id}" is not a page id`);
  return id;
}

function pageFor(board, config, carry) {
  let html = render(board, { config, boardDir: dirname(resolve(boardPath)) });
  let carried = { comments: 0, anchored: 0 };
  if (carry) { const c = carryComments(html, carry); html = c.html; carried = { comments: c.comments, anchored: c.anchored }; }
  const bytes = Buffer.byteLength(html);
  if (bytes > PAGE_MAX) fail(1, `the page is ${Math.round(bytes / 1024)} KB; keep it under ${PAGE_MAX / 1024} KB. The whole page is uploaded on every tick the owner makes: use fewer or smaller pictures.`);
  return { html, bytes, carried };
}

function applyWatch(board, config) {
  const w = opts.watch;
  if (w == null || w === true) return;
  if (w === "off") { delete board.watch; return; }
  const until = w === "until-decided" ? parseUntil("7d") : parseUntil(w);
  if (until == null) fail(2, `--watch=${w} is not a time or a duration (ISO, 4h, 24h, 7d, until-decided, off)`);
  board.watch = { until: new Date(until).toISOString(), everyMin: Math.max(1, Math.round(config.watch.everySeconds / 60)) };
  if (w === "until-decided") board.watch.untilDecided = true;
}

async function tool(config, args, { allowFail = false } = {}) {
  let t;
  try { t = findTool(config); } catch (e) { fail(4, e.message); }
  const r = await runTool(t, args);
  if (r.code !== 0 && !allowFail) {
    if (/changed after you last read it/.test(r.stderr)) fail(1, "the owner saved the page after your last pull. Run pull, act on what it prints, then push again.");
    if (/no relay has|has no page any more|was deleted/.test(r.stderr)) fail(3, r.stderr);
    fail(4, `artifact ${args[0]} failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  return r;
}

const npubTag = (n) => createHash("sha256").update(String(n)).digest("hex").slice(0, 16);
function readState(dir) { try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); } catch { return {}; } }
function writeState(dir, s) { writeFileSync(join(dir, "state.json"), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 }); }

// The owner's npub, when the settings name one, is a member of the page as well as holding the edit
// link: the link is what they use every day, the membership is how they get back in with their own
// key (a signer such as Amber) if the link is lost.
async function ensureOwnerMember(config, id, dir) {
  if (!config.ownerNpub || config.access !== "link") return null;
  const st = readState(dir);
  if (st.ownerMember === npubTag(config.ownerNpub)) return "member";
  await tool(config, ["share", id, `--member=${config.ownerNpub}`]);
  st.ownerMember = npubTag(config.ownerNpub);
  writeState(dir, st);
  return "added";
}

const commands = {
  async validate() {
    const raw = needBoard();
    const v = validate(raw, { boardPath });
    const out = { ok: !v.errors.length, errors: v.errors, warnings: v.warnings };
    if (v.errors.length) fail(1, `board.json has ${v.errors.length} problem(s):\n- ${v.errors.join("\n- ")}`, out);
    return out;
  },

  async build() {
    const raw = needBoard();
    const { config } = loadConfig({ boardPath });
    const v = checked(raw);
    const out = others[0] || join(workDir(boardPath), "page.html");
    const carry = opts.carry && opts.carry !== true ? readFileSync(opts.carry, "utf8") : null;
    const p = pageFor(v.board, config, carry);
    writeFileSync(out, p.html);
    const open = v.board.items.filter((i) => i.status === "open").length;
    return { out, bytes: p.bytes, open, closed: v.board.items.length - open, tests: v.board.testing.length, ...(carry ? { carried: p.carried } : {}), warnings: v.warnings };
  },

  async publish() {
    const raw = needBoard();
    const { config, problems } = loadConfig({ boardPath });
    if (problems.length) fail(2, `settings: ${problems.join("; ")}`);
    if (raw.artifact && raw.artifact.id && !opts.new) fail(1, `this board is already published as ${raw.artifact.id}. Use push to change it, or --new for a second page.`);
    const v = checked(raw);
    const board = v.board;
    applyWatch(board, config);
    const dir = workDir(boardPath);
    const page = join(dir, "page.html");
    writeFileSync(page, pageFor(board, config, null).html);
    const expires = opts.expires && opts.expires !== true ? opts.expires : config.expires;
    const args = ["create", page, `--expires=${expires}`, `--title=${board.title}`];
    if (config.access === "members") args.push("--visibility=private", "--edit=members", `--member=${config.ownerNpub}`);
    else { args.push("--visibility=link", "--edit=link"); if (config.ownerNpub) args.push(`--member=${config.ownerNpub}`); }
    if (config.workspace) args.push(config.workspace === true ? "--workspace" : `--workspace=${config.workspace}`);
    const r = await tool(config, args);
    const id = r.json && r.json.id;
    if (!id) fail(4, `create answered without an id: ${r.stdout.slice(0, 200)}`);
    board.artifact = { id, expires: r.json.expires || null };
    saveBoard(boardPath, board);
    if (config.ownerNpub && config.access === "link") writeState(dir, { ...readState(dir), ownerMember: npubTag(config.ownerNpub) });
    const out = { id, title: board.title, expires: board.artifact.expires, access: config.access, ownerMember: !!config.ownerNpub, warnings: [...v.warnings, ...((r.json && r.json.warnings) || [])] };
    let sent = null;
    if (opts.notify && opts.notify !== true) sent = await notify({ text: opts.notify, id, config });
    if (sent) out.notified = sent.notified;
    if (!sent || !sent.notified) {
      out.link = r.json.link;
      out.linkNote = "Give this link to the owner only, whole, in this chat. Do not store it anywhere; get it again with artifact links <id>.";
      if (sent) out.notifyProblem = sent.reason;
    }
    return out;
  },

  async pull() {
    const raw = needBoard();
    const { config } = loadConfig({ boardPath });
    const id = idOf(raw);
    const s = await tool(config, ["status", id], { allowFail: true });
    if (s.code !== 0) {
      if (/no artifact/i.test(s.stderr)) fail(2, s.stderr);
      fail(4, `status failed: ${s.stderr || `exit ${s.code}`}`);
    }
    const st = s.json || {};
    if (st.deleted) fail(3, `${id} was deleted (${st.deleted}).`, { changed: false, gone: true, deleted: st.deleted });
    if (!st.published) fail(4, "no relay answered with this page. The machine may be offline. Try again later.", { changed: false, offline: true });
    if (!st.changed && !opts.force) return { changed: false, savedAt: st.savedAt || null };
    const settle = parseDuration(opts.settle && opts.settle !== true ? opts.settle : 0) || 0;
    if (settle && st.savedAt && !opts.force) {
      const age = (Date.now() - Date.parse(st.savedAt)) / 1000;
      if (age < settle) return { changed: true, settling: true, savedAt: st.savedAt, retryInSeconds: Math.ceil(settle - age) };
    }
    const dir = workDir(boardPath);
    const file = join(dir, "pulled.html");
    const r = await tool(config, ["read", id, "--as=html", `--out=${file}`]);
    const html = readFileSync(file, "utf8");
    const board = normalize(raw);
    const delta = merge(board, html);
    saveBoard(boardPath, board);
    const out = { changed: true, savedAt: (r.json && r.json.savedAt) || st.savedAt || null };
    for (const k of ["decided", "notes", "tests", "commands"]) if (delta[k].length) out[k] = delta[k];
    const cm = r.json && r.json.comments;
    if (cm && cm.open) {
      const c = await tool(config, ["comments", id, "--peek"], { allowFail: true });
      const fresh = new Set(cm.newSinceLastRead || []);
      const list = (c.json && c.json.comments) || [];
      const news = list.filter((x) => fresh.has(x.id)).map((x) => ({ id: x.id, quote: x.quote, text: x.text, ...(x.replies && x.replies.length ? { lastReply: x.replies[x.replies.length - 1].text } : {}) }));
      if (news.length) out.comments = news;
      out.openComments = cm.open;
    }
    out.undecided = delta.undecided;
    out.untested = delta.untested;
    if (!out.decided && !out.notes && !out.tests && !out.commands && !out.comments) out.note = "the page was saved, but no answer, note, test result, instruction or comment changed";
    return out;
  },

  async push() {
    const raw = needBoard();
    const { config, problems } = loadConfig({ boardPath });
    if (problems.length) fail(2, `settings: ${problems.join("; ")}`);
    const id = idOf(raw);
    const v = checked(raw);
    const board = v.board;
    applyWatch(board, config);
    const dir = workDir(boardPath);
    // The page as it is now carries the comments, with any reply you made since the pull.
    const carryFile = join(dir, "carry.html");
    const peek = await tool(config, ["read", id, "--peek", "--as=html", `--out=${carryFile}`]);
    if (peek.json && peek.json.changed) fail(1, "the owner saved the page after your last pull. Run pull, act on what it prints, then push again.");
    const p = pageFor(board, config, readFileSync(carryFile, "utf8"));
    const page = join(dir, "page.html");
    writeFileSync(page, p.html);
    const r = await tool(config, ["update", id, page]);
    saveBoard(boardPath, board);
    const out = { pushed: true, id, savedAt: (r.json && r.json.savedAt) || null, bytes: p.bytes, comments: p.carried, warnings: [...v.warnings, ...((r.json && r.json.warnings) || [])] };
    try { const m = await ensureOwnerMember(config, id, dir); if (m === "added") out.ownerMember = "added"; }
    catch (e) { out.warnings.push(`could not add the owner as a member: ${e.message}`); }
    if (opts.notify && opts.notify !== true) {
      const n = await notify({ text: opts.notify, id, config });
      out.notified = n.notified;
      if (!n.notified) out.notifyProblem = n.reason;
    }
    return out;
  },

  async watch() {
    const raw = boardPath ? loadBoard(boardPath) : null;
    const { config } = loadConfig({ boardPath });
    const id = idOf(raw);
    const every = opts.every != null ? parseDuration(opts.every) : raw && raw.watch && raw.watch.everyMin ? Number(raw.watch.everyMin) * 60 : config.watch.everySeconds;
    if (!every) fail(2, `--every=${opts.every} is not a duration (600, 10m, 1h)`);
    const untilSrc = opts.until != null ? opts.until : raw && raw.watch && raw.watch.until ? raw.watch.until : config.watch.default;
    const until = untilSrc === "none" ? null : parseUntil(untilSrc);
    if (untilSrc !== "none" && until == null) fail(2, `--until=${untilSrc} is not a time or a duration (ISO, unix seconds, 90m, 24h, 7d)`);
    const settle = opts.settle != null ? parseDuration(opts.settle) ?? (opts.settle === "0" ? 0 : null) : config.watch.settleSeconds;
    if (settle == null) fail(2, `--settle=${opts.settle} is not a duration`);
    let t;
    try { t = findTool(config); } catch (e) { fail(4, e.message, { id, event: "error", reason: "no tool" }); }
    const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
    const ev = (event, extra = {}) => ({ id, event, at: new Date().toISOString(), ...(until ? { until: new Date(until).toISOString() } : {}), ...extra });
    let fails = 0, lastReason = "";
    for (;;) {
      const r = await runTool(t, ["status", id], { timeoutMs: 120000 });
      let wait = every * 1000;
      if (r.code === 0 && r.json) {
        const s = r.json;
        if (s.deleted) fail(3, null, ev("gone", { deleted: s.deleted }));
        if (s.expires && Date.parse(s.expires) < Date.now()) fail(3, null, ev("expired", { expires: s.expires }));
        if (!s.published) { fails++; lastReason = "no relay answered (offline?)"; }
        else {
          fails = 0;
          if (s.changed) {
            const age = s.savedAt ? (Date.now() - Date.parse(s.savedAt)) / 1000 : Infinity;
            if (age >= settle) return ev("changed", { savedAt: s.savedAt });
            wait = Math.min(wait, (settle - age) * 1000 + 1000);
          }
        }
      } else if (/no artifact/i.test(r.stderr)) fail(2, r.stderr, ev("error", { reason: "unknown id" }));
      else { fails++; lastReason = r.timedOut ? "status timed out" : (r.stderr || `exit ${r.code}`).slice(0, 200); }
      if (fails >= 5) fail(4, null, ev("error", { reason: lastReason, failures: fails }));
      if (until != null) {
        const left = until - Date.now();
        if (left <= 0) fail(5, null, ev("deadline"));
        wait = Math.min(wait, left);
      }
      await sleep(wait);
    }
  },
};

const run = commands[cmd];
if (!run) {
  console.error("usage: board.mjs validate|build|publish|pull|push|watch board.json [...]  (see the header of this file)");
  process.exit(2);
}
try {
  const out = await run();
  console.log(JSON.stringify(out, null, cmd === "watch" ? 0 : 2));
  process.exit(0);
} catch (e) {
  if (e instanceof Exit) {
    if (e.out) console.log(JSON.stringify(e.out, null, cmd === "watch" ? 0 : 2));
    if (e.message) console.error(e.message);
    process.exit(e.exitCode);
  }
  console.error(`board: ${e.message}`);
  process.exit(1);
}
