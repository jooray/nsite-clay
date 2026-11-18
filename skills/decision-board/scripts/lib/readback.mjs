// Reading the owner's answers out of a saved page, and merging them into board.json.
import { key } from "./schema.mjs";

// Entities a browser writes when it serialises a page. A non-breaking space (iOS keyboards insert
// them) becomes a plain space: in a note it never means anything else.
export function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/ /g, " ");
}

const attrs = (tag) => {
  const o = {};
  for (const m of tag.matchAll(/([^\s=<>"'\/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g)) {
    o[m[1].toLowerCase()] = m[3] ?? m[4] ?? (m[2] ?? "");
  }
  return o;
};

// { fields: { "c-x": ["a"], "n-x": "text", ... }, present: Set of field names that exist on the page }
export function readFields(html) {
  // Leave out what is not the form: the comments block, scripts and templates.
  const body = String(html)
    .replace(/<aside\b[^>]*\bnc:comments\b[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, "");
  const checked = {}, text = {}, present = new Set();
  for (const m of body.matchAll(/<input\b[^>]*>/gi)) {
    const a = attrs(m[0].slice(6, -1));
    if (!a.name || !["radio", "checkbox"].includes((a.type || "").toLowerCase())) continue;
    const name = decode(a.name);
    present.add(name);
    checked[name] ||= [];
    if ("checked" in a) checked[name].push(decode(a.value ?? "on"));
  }
  for (const m of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const a = attrs(m[1]);
    if (!a.name) continue;
    const name = decode(a.name);
    present.add(name);
    text[name] = decode(m[2]).replace(/^\n/, "").trim();
  }
  return { checked, text, present };
}

const labelOf = (i, c) => (i.options.find((o) => o.id === c) || {}).label || c;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Merges the page into the board (a normalized board, changed in place) and returns the delta: only
// what is different from what the board held before.
export function merge(board, html, { now = new Date() } = {}) {
  const { checked, text, present } = readFields(html);
  const delta = { decided: [], notes: [], tests: [], commands: [] };
  for (const i of board.items) {
    const k = key(i.id);
    if (i.kind !== "text" && present.has(`c-${k}`)) {
      const got = checked[`c-${k}`] || [];
      const v = i.kind === "multi" ? got : got.length ? got[0] : null;
      if (!same(v, i.choice)) {
        delta.decided.push({ id: i.id, title: i.title, choice: v, label: i.kind === "multi" ? v.map((c) => labelOf(i, c)) : v == null ? null : labelOf(i, v), was: i.choice });
        i.choice = v;
      }
    }
    if (present.has(`n-${k}`)) {
      const n = text[`n-${k}`] || "";
      if (n !== (i.note || "")) {
        if (i.kind === "text") delta.decided.push({ id: i.id, title: i.title, answer: n, was: i.note || "" });
        else delta.notes.push({ id: i.id, title: i.title, note: n });
        i.note = n;
      }
    }
  }
  for (const t of board.testing) {
    const k = key(t.id);
    let moved = false;
    if (present.has(`t-${k}`)) {
      const r = (checked[`t-${k}`] || [])[0] || null;
      if (r !== (t.result ?? null)) { t.result = r; moved = true; }
    }
    if (present.has(`tn-${k}`)) {
      const n = text[`tn-${k}`] || "";
      if (n !== (t.note || "")) { t.note = n; moved = true; }
    }
    if (moved) delta.tests.push({ id: t.id, title: t.title, result: t.result ?? null, note: t.note || "" });
  }
  // The command box. Its text moves into the log as a new instruction and the box is emptied on the
  // next push, so the same words are never handled twice. If the agent did not push since, the page
  // still shows text that is already in the log: that is not new.
  if (present.has("agent-instructions")) {
    const draft = text["agent-instructions"] || "";
    const log = board.commands.log;
    const last = log[log.length - 1];
    if (draft && !(last && last.text === draft)) {
      const n = log.reduce((m, c) => Math.max(m, parseInt(String(c.id || "").replace(/\D/g, ""), 10) || 0), 0) + 1;
      const entry = { id: `k${n}`, at: now.toISOString(), text: draft, state: "new" };
      log.push(entry);
      delta.commands.push({ id: entry.id, text: draft });
    }
    board.commands.draft = "";
  }
  delete board.agentInstructions;
  const open = board.items.filter((i) => i.status === "open");
  delta.undecided = open.filter((i) => (i.kind === "text" ? !i.note : i.kind === "multi" ? !i.choice.length : i.choice == null)).length;
  delta.untested = board.testing.filter((t) => !t.result).length;
  return delta;
}
