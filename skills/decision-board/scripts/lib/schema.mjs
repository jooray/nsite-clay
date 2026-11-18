// board.json: reading it, upgrading a 0.2 board in memory, and checking it before anything is built.
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { parseUntil } from "./tool.mjs";

export const STATUSES = ["open", "in_progress", "shipped", "postponed", "rejected", "dropped"];
export const KINDS = ["choice", "multi", "text"];
export const PROJECT_STATES = ["on_track", "waiting_on_you", "blocked", "done"];
export const COMMAND_STATES = ["new", "doing", "done", "declined"];
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const IMAGE_MAX = 150 * 1024;
export const PAGE_MAX = 1024 * 1024;

// The form field key of an id. Unchanged for ids that follow ID_RE; older ids keep the 0.2 mapping,
// so pages built by 0.2 still read back.
export const key = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");

export function loadBoard(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch (e) { throw new Error(`cannot read ${path}: ${e.code || e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`); }
}

// 0.2 label names that mean the same thing under a new name. "done" was the "decided" badge in 0.2
// and is a section title now, so an old board's value for it is dropped, with the others that are gone.
const LEGACY = { open: "decide", actions: "toDo", agent: "command", agentHint: "commandHint", none: "allClear" };
const GONE = ["done", "undecided", "of", "less", "links"];

// Fills in what a 0.2 board leaves out. Works on a copy; the file is changed only by pull.
export function normalize(raw) {
  const d = JSON.parse(JSON.stringify(raw || {}));
  if (d.schema !== 3) {
    if (d.labels && typeof d.labels === "object") {
      for (const [o, n] of Object.entries(LEGACY)) if (d.labels[o] != null && d.labels[n] == null) d.labels[n] = d.labels[o];
      for (const o of [...Object.keys(LEGACY), ...GONE]) delete d.labels[o];
    }
    if (d.watch) delete d.watch.tz;
    d.schema = 3;
  }
  d.items = Array.isArray(d.items) ? d.items : [];
  for (const i of d.items) {
    if (i && typeof i === "object") {
      if (i.id != null) i.id = String(i.id);
      i.kind = i.kind || "choice";
      i.status = i.status || "open";
      i.options = Array.isArray(i.options) ? i.options : [];
      for (const o of i.options) if (o && o.id != null) o.id = String(o.id);
      if (i.kind === "multi") i.choice = Array.isArray(i.choice) ? i.choice.map(String) : i.choice == null ? [] : [String(i.choice)];
      else i.choice = i.choice == null || i.choice === "" ? null : String(i.choice);
      i.note = i.note || "";
    }
  }
  d.testing = Array.isArray(d.testing) ? d.testing : [];
  for (const t of d.testing) if (t && t.id != null) t.id = String(t.id);
  d.done = Array.isArray(d.done) ? d.done : [];
  d.next = Array.isArray(d.next) ? d.next : [];
  d.actions = Array.isArray(d.actions) ? d.actions : [];
  d.evidence = Array.isArray(d.evidence) ? d.evidence : [];
  if (!d.commands || typeof d.commands !== "object") d.commands = { draft: d.agentInstructions || "", log: [] };
  d.commands.draft = d.commands.draft || "";
  d.commands.log = Array.isArray(d.commands.log) ? d.commands.log : [];
  return d;
}

const SECRET = [
  [/nsec1[02-9ac-hj-np-z]{20,}/, "a Nostr secret key (nsec1...)"],
  [/ncryptsec1[02-9ac-hj-np-z]{20,}/, "an encrypted Nostr key"],
  [/#[ek]=[A-Za-z0-9_-]{16,}/, "a page link with its key (#e= or #k=)"],
  [/bunker:\/\//, "a bunker:// connection string"],
  [/nostrconnect:\/\//, "a nostrconnect:// string"],
];

function walkStrings(v, path, out) {
  if (typeof v === "string") out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, n) => walkStrings(x, `${path}[${n}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walkStrings(x, path ? `${path}.${k}` : k, out);
  return out;
}

function hrefOk(h) {
  if (typeof h !== "string" || !h) return false;
  if (/^\s*(javascript|data|vbscript):/i.test(h)) return false;
  return true;
}

export function imagePath(boardDir, p) {
  return isAbsolute(p) ? p : resolve(boardDir, p);
}

// Returns { errors, warnings }. Errors stop a build; warnings are printed and the build goes on.
export function validate(raw, { boardPath = "board.json" } = {}) {
  const errors = [], warnings = [];
  const E = (m) => errors.push(m), W = (m) => warnings.push(m);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: ["board.json must be a JSON object"], warnings };
  const d = normalize(raw);
  const boardDir = dirname(resolve(boardPath));
  if (typeof raw.title !== "string" || !raw.title.trim()) E("title is missing");
  if (raw.schema != null && ![2, 3].includes(raw.schema)) W(`schema ${raw.schema} is unknown; this version writes 3`);
  if (raw.items != null && !Array.isArray(raw.items)) E("items must be an array");

  if (raw.project != null) {
    if (typeof raw.project !== "object") E("project must be an object");
    else if (raw.project.state != null && !PROJECT_STATES.includes(raw.project.state)) E(`project.state is one of ${PROJECT_STATES.join(", ")}, not "${raw.project.state}"`);
  }
  if (raw.watch != null) {
    if (raw.watch.until != null && parseUntil(raw.watch.until) == null) E(`watch.until "${raw.watch.until}" is not a time; write it as ISO, e.g. 2026-11-18T14:00:00Z`);
    if (raw.watch.everyMin != null && !(Number(raw.watch.everyMin) > 0)) E("watch.everyMin must be a positive number");
  }

  const keys = new Map();
  const claim = (k, what) => {
    if (keys.has(k)) E(`${what} and ${keys.get(k)} get the same field name "${k}"; give one of them another id`);
    else keys.set(k, what);
  };
  d.items.forEach((i, n) => {
    const at = `items[${n}]`;
    if (!i || typeof i !== "object") return E(`${at} is not an object`);
    if (!i.id) return E(`${at} has no id`);
    const name = `item "${i.id}"`;
    if (!ID_RE.test(i.id)) W(`${name}: ids should be lower case letters, digits and hyphens (at most 40)`);
    claim("i:" + key(i.id), name);
    if (!i.title) E(`${name} has no title`);
    if (!STATUSES.includes(i.status)) E(`${name}: status "${i.status}" is not one of ${STATUSES.join(", ")}`);
    if (!KINDS.includes(i.kind)) E(`${name}: kind "${i.kind}" is not one of ${KINDS.join(", ")}`);
    if (i.layout != null && !["list", "grid"].includes(i.layout)) E(`${name}: layout is "list" or "grid"`);
    const ids = new Set();
    let rec = 0;
    for (const [m, o] of i.options.entries()) {
      if (!o || o.id == null || o.id === "") { E(`${name}: option ${m + 1} has no id`); continue; }
      if (ids.has(o.id)) E(`${name}: option id "${o.id}" appears twice`);
      ids.add(o.id);
      if (!o.label) E(`${name}: option "${o.id}" has no label`);
      if (o.recommended) rec++;
      if (o.image != null) {
        if (typeof o.image !== "string") E(`${name}: option "${o.id}" image must be a file path`);
        else if (/^https?:/i.test(o.image)) E(`${name}: option "${o.id}" image is a web address. A page may not load from elsewhere: save the picture, shrink it, and give its file path. Put the web address in "link".`);
        else if (!/^data:image\//.test(o.image)) {
          const p = imagePath(boardDir, o.image);
          let size = null;
          try { size = statSync(p).size; } catch { E(`${name}: option "${o.id}" image ${o.image} does not exist`); }
          if (size != null && size > IMAGE_MAX) E(`${name}: option "${o.id}" image is ${Math.round(size / 1024)} KB; the limit is ${IMAGE_MAX / 1024} KB. Make it about 480 px wide WebP or JPEG.`);
          if (!/\.(webp|png|jpe?g|gif|svg|avif)$/i.test(o.image)) E(`${name}: option "${o.id}" image must be webp, png, jpeg, gif, svg or avif`);
        }
        if (!o.alt) W(`${name}: option "${o.id}" has an image without alt text`);
      }
      if (o.link != null) {
        const h = typeof o.link === "string" ? o.link : o.link.href;
        if (!hrefOk(h)) E(`${name}: option "${o.id}" link is not a usable address`);
      }
      for (const f of ["pros", "cons"]) if (o[f] != null && !Array.isArray(o[f])) E(`${name}: option "${o.id}" ${f} must be a list`);
    }
    if (i.kind === "choice" && rec > 1) E(`${name} has ${rec} recommended options; a choice has at most one`);
    if (i.kind !== "text" && i.status === "open" && i.options.length === 0) E(`${name} is open and has no options. Give it options, or "kind": "text" for a written answer.`);
    if (i.kind === "choice" && i.choice != null && !ids.has(i.choice)) E(`${name}: choice "${i.choice}" is not one of its options`);
    if (i.kind === "multi") for (const c of i.choice) if (!ids.has(c)) E(`${name}: choice "${c}" is not one of its options`);
    for (const l of i.links || []) if (!hrefOk(typeof l === "string" ? l : l && l.href)) E(`${name}: a link is not a usable address`);
    if (i.status === "open") {
      if (!i.why) W(`${name} has no "why" sentence`);
      else if (String(i.why).length > 200) W(`${name}: "why" is ${String(i.why).length} characters; keep it to one sentence and move the rest into details`);
      if (!i.details && i.kind !== "text") W(`${name} has no details; a reader who lacks the background cannot decide`);
    }
  });

  d.testing.forEach((t, n) => {
    if (!t || !t.id) return E(`testing[${n}] has no id`);
    if (!ID_RE.test(t.id)) W(`test "${t.id}": ids should be lower case letters, digits and hyphens`);
    claim("t:" + key(t.id), `test "${t.id}"`);
    if (!t.title) E(`test "${t.id}" has no title`);
    if (t.result != null && !["pass", "fail"].includes(t.result)) E(`test "${t.id}": result is null, "pass" or "fail"`);
    if (t.steps != null && !Array.isArray(t.steps)) E(`test "${t.id}": steps must be a list`);
  });
  d.commands.log.forEach((c, n) => {
    if (c.state != null && !COMMAND_STATES.includes(c.state)) E(`commands.log[${n}]: state is one of ${COMMAND_STATES.join(", ")}`);
  });
  for (const [n, x] of d.done.entries()) if (!x || !x.title) E(`done[${n}] has no title`);
  for (const [n, x] of d.next.entries()) if (!x || !(x.title || typeof x === "string")) E(`next[${n}] has no title`);
  if (raw.labels != null && (typeof raw.labels !== "object" || Array.isArray(raw.labels))) E("labels must be an object");

  for (const [p, s] of walkStrings(raw, "", [])) {
    if (/^image$|\.image$/.test(p) && /^data:/.test(s)) continue;
    for (const [re, what] of SECRET) if (re.test(s)) E(`${p} contains ${what}. Never put a key or a keyed link on the page.`);
    if (/[\u2013\u2014]/.test(s)) W(`${p} has an em or en dash; use a comma, a colon or two sentences`);
  }
  return { errors, warnings, board: d };
}
