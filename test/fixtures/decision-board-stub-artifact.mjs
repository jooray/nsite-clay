#!/usr/bin/env node
// A stand-in for nsite-artifacts' artifact.mjs, for test/decision-board.mjs. Its whole world is one
// JSON file named by STUB_STATE: { html, changed, published, deleted, savedAt, comments, mode }.
// Every call is appended to STUB_STATE + ".calls".
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const file = process.env.STUB_STATE;
const st = JSON.parse(readFileSync(file, "utf8"));
const save = () => writeFileSync(file, JSON.stringify(st));
const [cmd, id, ...rest] = process.argv.slice(2);
appendFileSync(file + ".calls", JSON.stringify([cmd, id, ...rest]) + "\n");
const opt = (n) => { const a = rest.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const out = (o) => console.log(JSON.stringify(o));
const die = (m) => { console.error(m); process.exit(1); };
if (id && id !== "stub1" && cmd !== "create") die(`no artifact "${id}" in /stub/ledger.json`);

if (st.mode === "fail") die("boom");
switch (cmd) {
  case "status":
    if (st.mode === "warn") console.error("(node:1) ExperimentalWarning: something");
    if (st.mode === "offline") { out({ id, published: false, changed: false, savedAt: null, expires: null }); break; }
    out({ id, published: !st.deleted, changed: !!st.changed && !st.deleted, savedAt: st.savedAt || null, expires: st.expires || null, ...(st.deleted ? { deleted: st.deleted } : {}) });
    break;
  case "read": {
    const peek = rest.includes("--peek");
    const o = { id, changed: !!st.changed, savedAt: st.savedAt };
    const open = (st.comments || []).filter((c) => c.state === "open");
    if ((st.comments || []).length) o.comments = { open: open.length, resolved: st.comments.length - open.length, newSinceLastRead: peek ? [] : (st.comments || []).filter((c) => c.fresh).map((c) => c.id) };
    writeFileSync(opt("out"), st.html);
    o.file = opt("out");
    if (!peek) { st.changed = false; for (const c of st.comments || []) c.fresh = false; save(); }
    out(o);
    break;
  }
  case "comments":
    out({ id, comments: (st.comments || []).filter((c) => c.state === "open").map(({ fresh, ...c }) => c) });
    break;
  case "update":
    if (st.changed) die(`${id} was changed after you last read it (saved ${st.savedAt}). Run "read ${id}" to see the change.`);
    st.html = readFileSync(rest[0], "utf8");
    st.savedAt = new Date().toISOString();
    st.updates = (st.updates || 0) + 1;
    save();
    out({ id, link: "https://stub.invalid/#e=STUBKEYSTUBKEYSTUBKEY", savedAt: st.savedAt });
    break;
  case "create":
    st.html = readFileSync(id, "utf8");
    st.created = rest;
    save();
    out({ id: "stub1", title: opt("title"), link: "https://stub.invalid/#e=STUBKEYSTUBKEYSTUBKEY", expires: "2030-01-01T00:00:00.000Z" });
    break;
  case "links":
    out({ id, url: "https://stub.invalid/", link: "https://stub.invalid/#e=STUBKEYSTUBKEYSTUBKEY", editLink: "https://stub.invalid/#e=STUBKEYSTUBKEYSTUBKEY" });
    break;
  case "share":
    st.shared = (st.shared || 0) + 1;
    save();
    out({ id, members: [] });
    break;
  default:
    die(`stub: unknown command ${cmd}`);
}
