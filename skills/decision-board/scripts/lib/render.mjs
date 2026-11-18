// board (normalized) -> one self-contained HTML page.
//
// Rule that keeps a saved page whole: nothing in the static markup carries nc:chrome. The runtime
// removes every nc:chrome element from what it saves, so anything marked that way would be gone for
// the next person who opens the page. Buttons, the counter, the watch line and the save status are
// pure UI: the inline script draws them at load, with nc:chrome, from data attributes. Content (the
// long-form context, notes) lives in plain <details>.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { key, imagePath } from "./schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LOCALES = join(HERE, "..", "..", "locales");

export const LABELS = {
  decide: "Decide",
  testing: "Needs your testing",
  toDo: "To do",
  command: "Tell the agent",
  commandHint: "Write here as you would in the chat. The agent reads it the next time it checks.",
  done: "What was done",
  next: "What is next",
  later: "Later",
  decided: "Already decided",
  evidence: "What was checked",
  take: "Take recommended",
  takeAll: "Take all recommendations",
  recommended: "recommended",
  clear: "Clear",
  more: "More context",
  note: "Add a note",
  notePlaceholder: "Your note",
  answer: "Your answer",
  context: "Context",
  decision: "What is decided",
  whyNow: "Why now",
  recommendation: "Why this recommendation",
  other: "More",
  links: "Links",
  expect: "Expected",
  pass: "Works",
  fail: "Does not work",
  result: "Result",
  testNote: "What happened?",
  showAll: "Show all ({n})",
  toDecide: "{n} to decide",
  toTest: "{n} to test",
  allClear: "Nothing is waiting on you.",
  watching: "The agent checks this page every {every} min until {until}.",
  watchEnded: "Automatic checking ended {until}. Tell the agent in the chat when you want it to look.",
  watchOff: "The agent is not watching this page. Tell it in the chat when you are done.",
  saving: "Saving",
  saved: "Saved",
  state: { on_track: "On track", waiting_on_you: "Waiting on you", blocked: "Blocked", done: "Done" },
  status: { in_progress: "In progress", shipped: "Done", postponed: "Postponed", rejected: "Rejected", dropped: "Dropped" },
  cmdState: { new: "New", doing: "Working on it", done: "Done", declined: "Declined" },
};

export function labelsFor(board, config) {
  const lang = String(board.lang || (config && config.language) || "en");
  const L = JSON.parse(JSON.stringify(LABELS));
  const merge = (src) => {
    for (const [k, v] of Object.entries(src || {})) {
      if (v && typeof v === "object" && L[k] && typeof L[k] === "object") Object.assign(L[k], v);
      else if (typeof v === "string") L[k] = v;
    }
  };
  for (const tag of [...new Set([lang.split("-")[0], lang])]) {
    const f = join(LOCALES, `${tag}.json`);
    if (tag !== "en" && existsSync(f)) merge(JSON.parse(readFileSync(f, "utf8")));
  }
  merge(board.labels);
  return { L, lang };
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// JSON for inside a <script>: no "</script>", no line separators.
const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const PR = (p) => ({ P0: 0, P1: 1, P2: 2, P3: 3 }[p] ?? 9);
const MIME = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".avif": "image/avif" };

function dataUrl(boardDir, p) {
  if (/^data:image\//.test(p)) return p;
  const f = imagePath(boardDir, p);
  return `data:${MIME[extname(f).toLowerCase()] || "application/octet-stream"};base64,${readFileSync(f).toString("base64")}`;
}

function link(l, cls = "") {
  if (!l) return "";
  const href = typeof l === "string" ? l : l.href;
  const label = typeof l === "string" ? l : l.label || l.href;
  if (/^(https?:|mailto:|#|\/)/i.test(href)) return `<a${cls ? ` class="${cls}"` : ""} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  return `<code>${esc(label)}</code>`;
}

function details(i, L) {
  const x = i.details;
  if (!x) return "";
  let body;
  if (typeof x === "string") body = `<p>${esc(x)}</p>`;
  else body = [["context", L.context], ["decision", L.decision], ["why", L.whyNow], ["recommendation", L.recommendation], ["more", L.other]]
    .filter(([k]) => x[k]).map(([k, t]) => `<h4>${esc(t)}</h4><p>${esc(x[k])}</p>`).join("");
  if (!body) return "";
  return `<details class="ctx"><summary>${esc(L.more)}</summary><div class="ctxb">${body}</div></details>`;
}

function option(i, o, k, L, boardDir) {
  const multi = i.kind === "multi";
  const on = multi ? i.choice.includes(o.id) : i.choice === o.id;
  const img = o.image ? `<img src="${esc(dataUrl(boardDir, o.image))}" alt="${esc(o.alt || "")}" loading="lazy">` : "";
  const pc = [...(o.pros || []).slice(0, 3).map((t) => `<li class="pro">${esc(t)}</li>`), ...(o.cons || []).slice(0, 3).map((t) => `<li class="con">${esc(t)}</li>`)].join("");
  return `
      <label class="opt"><input type="${multi ? "checkbox" : "radio"}" name="c-${esc(k)}" value="${esc(o.id)}"${on ? " checked" : ""}>${img}
        <span class="ob"><span class="lab">${esc(o.label)}${o.recommended ? ` <em class="rec">${esc(L.recommended)}</em>` : ""}</span>${o.preview ? `<span class="pv">${esc(o.preview)}</span>` : ""}${pc ? `<ul class="pc">${pc}</ul>` : ""}${o.link ? `<span class="ol">${link(o.link)}</span>` : ""}</span></label>`;
}

function card(i, L, boardDir) {
  const k = key(i.id);
  const opts = [...i.options].sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
  const rec = i.options.filter((o) => o.recommended).map((o) => o.id);
  const links = (i.links || []).map((l) => link(l)).join(" ");
  const text = i.kind === "text";
  const answer = text
    ? `<label class="ans"><span class="sr">${esc(L.answer)}</span><textarea name="n-${esc(k)}" rows="3" placeholder="${esc(L.answer)}">${esc(i.note)}</textarea></label>`
    : `<fieldset class="opts${i.layout === "grid" ? " grid" : ""}"><legend class="sr">${esc(i.title)}</legend>${opts.map((o) => option(i, o, k, L, boardDir)).join("")}
    </fieldset>`;
  const note = text ? "" : `<details class="note"${i.note ? " open" : ""}><summary>${esc(L.note)}</summary><textarea name="n-${esc(k)}" rows="2" placeholder="${esc(L.notePlaceholder)}" aria-label="${esc(L.note)}">${esc(i.note)}</textarea></details>`;
  return `
  <article class="card" id="i-${esc(k)}" data-id="${esc(i.id)}" data-kind="${esc(i.kind)}"${rec.length && !text ? ` data-rec="${esc(rec.join(" "))}"` : ""}>
    <header>${i.priority ? `<span class="pri p${esc(String(i.priority).toLowerCase())}">${esc(i.priority)}</span>` : ""}<h3>${esc(i.title)}</h3>${i.area ? `<span class="area">${esc(i.area)}</span>` : ""}</header>
    ${i.why ? `<p class="why">${esc(i.why)}</p>` : ""}
    ${answer}
    <div class="acts" data-slot="acts"></div>
    ${details(i, L)}${links ? `<p class="links">${links}</p>` : ""}
    ${note}
  </article>`;
}

function test(t, L) {
  const k = key(t.id);
  const steps = (t.steps || []).map((s) => `<li>${esc(s)}</li>`).join("");
  return `
  <article class="card test" id="t-${esc(k)}" data-id="${esc(t.id)}">
    <header><h3>${esc(t.title)}</h3></header>
    ${steps ? `<ol class="steps">${steps}</ol>` : ""}
    ${t.expect ? `<p class="expect"><b>${esc(L.expect)}:</b> ${esc(t.expect)}</p>` : ""}
    ${t.link ? `<p class="links">${link(t.link)}</p>` : ""}
    <fieldset class="pf"><legend class="sr">${esc(L.result)}</legend>
      <label class="opt"><input type="radio" name="t-${esc(k)}" value="pass"${t.result === "pass" ? " checked" : ""}><span>${esc(L.pass)}</span></label>
      <label class="opt"><input type="radio" name="t-${esc(k)}" value="fail"${t.result === "fail" ? " checked" : ""}><span>${esc(L.fail)}</span></label>
    </fieldset>
    <textarea name="tn-${esc(k)}" rows="2" placeholder="${esc(L.testNote)}" aria-label="${esc(L.testNote)}">${esc(t.note || "")}</textarea>
  </article>`;
}

const day = (iso) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "");

export function render(d, { config = null, boardDir = "." } = {}) {
  const { L, lang } = labelsFor(d, config);
  const items = d.items;
  const open = items.filter((i) => i.status === "open").map((i, n) => [i, n]).sort((a, b) => PR(a[0].priority) - PR(b[0].priority) || a[1] - b[1]).map((x) => x[0]);
  const main = open.filter((i) => !i.later);
  const later = open.filter((i) => i.later);
  const statusOrder = ["in_progress", "postponed", "shipped", "rejected", "dropped"];
  const closed = items.filter((i) => i.status !== "open");
  const decidedHtml = statusOrder.map((s) => {
    const g = closed.filter((i) => i.status === s);
    if (!g.length) return "";
    return `<section class="grp s-${s}"><h3>${esc(L.status[s])} <span class="n">${g.length}</span></h3><ul>${g.map((i) => {
      const pick = i.kind === "multi" ? i.choice : i.choice ? [i.choice] : [];
      const labels = pick.map((c) => (i.options.find((o) => o.id === c) || {}).label || c).join(", ");
      return `<li id="i-${esc(key(i.id))}"><span class="t">${esc(i.title)}</span>${labels ? `<span class="w">${esc(labels)}</span>` : ""}${i.note ? `<span class="w nt">${esc(i.note)}</span>` : ""}</li>`;
    }).join("")}</ul></section>`;
  }).join("");

  const p = d.project || {};
  const header = `
  <header class="top">
    <h1>${esc(d.title)}</h1>
    ${d.subtitle ? `<p class="sub">${esc(d.subtitle)}</p>` : ""}
    ${p.state || p.summary ? `<p class="status">${p.state ? `<span class="chip st-${esc(p.state)}">${esc(L.state[p.state] || p.state)}</span> ` : ""}${esc(p.summary || "")}</p>` : ""}
    <p class="glance" data-slot="glance"></p>
    <p class="watch" data-slot="watch"${d.watch && d.watch.until ? ` data-until="${esc(new Date(Date.parse(d.watch.until)).toISOString())}" data-every="${esc(String(d.watch.everyMin || 10))}"` : ""}></p>
  </header>`;

  const decide = main.length || later.length ? `
  <section class="decide"><div class="sh"><h2>${esc(L.decide)}</h2><span data-slot="takeall"></span></div>
  ${main.map((i) => card(i, L, boardDir)).join("")}
  ${later.length ? `<details class="sect"><summary>${esc(L.later)} (${later.length})</summary>${later.map((i) => card(i, L, boardDir)).join("")}</details>` : ""}
  </section>` : "";

  const todo = d.actions.map((a) => `<li>${esc(a)}</li>`).join("");
  const testing = d.testing.length || todo ? `
  <section class="testing"><h2>${esc(L.testing)}</h2>
  ${todo ? `<ul class="todo">${todo}</ul>` : ""}
  ${d.testing.map((t) => test(t, L)).join("")}
  </section>` : "";

  const log = d.commands.log.slice(-5).reverse().map((c) => `<li class="cs-${esc(c.state || "new")}"><span class="chip">${esc(L.cmdState[c.state || "new"] || c.state)}</span> <span class="ct">${esc(c.text)}</span>${c.reply ? `<span class="cr">${esc(c.reply)}</span>` : ""}</li>`).join("");
  const command = `
  <section class="cmd"><h2><label for="agent-instructions">${esc(L.command)}</label></h2>
    <p class="hint">${esc(L.commandHint)}</p>
    <textarea id="agent-instructions" name="agent-instructions" rows="3">${esc(d.commands.draft)}</textarea>
    ${log ? `<ul class="log">${log}</ul>` : ""}
  </section>`;

  const doneRow = (x) => `<li><span class="t">${esc(x.title)}</span>${x.detail ? `<span class="w">${esc(x.detail)}</span>` : ""}${day(x.at) || x.link ? `<span class="w">${day(x.at) ? `<time datetime="${esc(x.at)}">${esc(day(x.at))}</time>` : ""} ${x.link ? link(x.link) : ""}</span>` : ""}</li>`;
  const doneList = [...d.done].reverse();
  const done = doneList.length ? `
  <section class="done"><h2>${esc(L.done)}</h2>
    <ul class="rows">${doneList.slice(0, 5).map(doneRow).join("")}</ul>
    ${doneList.length > 5 ? `<details class="more"><summary>${esc(L.showAll.replace("{n}", doneList.length))}</summary><ul class="rows">${doneList.slice(5).map(doneRow).join("")}</ul></details>` : ""}
  </section>` : "";
  const next = d.next.length ? `
  <section class="next"><h2>${esc(L.next)}</h2>
    <ol class="rows">${d.next.map((x) => typeof x === "string" ? `<li><span class="t">${esc(x)}</span></li>` : `<li><span class="t">${esc(x.title)}</span>${x.detail ? `<span class="w">${esc(x.detail)}</span>` : ""}</li>`).join("")}</ol>
  </section>` : "";
  const decided = decidedHtml ? `<details class="sect"><summary>${esc(L.decided)} (${closed.length})</summary>${decidedHtml}</details>` : "";
  const evidenceBody = d.evidence.map((e) => `<section><h4>${esc(e.title)}</h4><ul>${(e.items || []).map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>`).join("");
  const evidence = evidenceBody ? `<details class="sect"><summary>${esc(L.evidence)}</summary><div class="ev">${evidenceBody}</div></details>` : "";

  const ui = {
    take: L.take, takeAll: L.takeAll, clear: L.clear, toDecide: L.toDecide, toTest: L.toTest, allClear: L.allClear,
    watching: L.watching, watchEnded: L.watchEnded, watchOff: L.watchOff, saving: L.saving, saved: L.saved,
  };

  return `<!doctype html>
<html lang="${esc(lang)}" nc:autosave nc:edit-gate="always" nc:runtime-owner="off">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="decision-board 0.3.0">
<title>${esc(d.title)}</title>
<style>
:root{--ink:#1c1b19;--dim:#655f55;--bg:#f6f3ec;--card:#fffdf8;--edge:#ddd6c8;--accent:#2f6f4f;--accent-bg:#e4f0e8;--warn:#a8650f;--warn-bg:#f8ecd9;--bad:#a33223;--bad-bg:#f7e2de;--p0:#a33223;--p1:#a8650f;--p2:#4a6a8a;--p3:#7a756b;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--ink:#ece7dc;--dim:#a39c8f;--bg:#171614;--card:#201f1c;--edge:#37342e;--accent:#7fc8a0;--accent-bg:#233028;--warn:#e0a860;--warn-bg:#352a1b;--bad:#e08a7c;--bad-bg:#3a2320;--p0:#e08a7c;--p1:#e0a860;--p2:#8fb0d2;--p3:#a39c8f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.25rem 1rem 6rem}
h1{font-size:1.6rem;line-height:1.2;margin:.4rem 0 .25rem;text-wrap:balance}
h2{font-size:1.15rem;margin:2rem 0 .6rem}
.sub,.hint{color:var(--dim);margin:0 0 .5rem}
.status{margin:.6rem 0 .2rem;font-weight:500}
.chip{display:inline-block;border-radius:999px;padding:.05rem .6rem;font-size:.8rem;font-weight:600;background:var(--accent-bg);color:var(--accent);vertical-align:.1rem}
.st-waiting_on_you{background:var(--warn-bg);color:var(--warn)}.st-blocked{background:var(--bad-bg);color:var(--bad)}
.glance{margin:.2rem 0;font-weight:600;color:var(--accent)}
.watch,.state{font-size:.88rem;color:var(--dim);margin:.2rem 0}
.sh{display:flex;align-items:baseline;justify-content:space-between;gap:.5rem;flex-wrap:wrap}
.card{background:var(--card);border:1px solid var(--edge);border-radius:12px;padding:.9rem 1rem;margin:.7rem 0}
.card header{display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem .6rem}
.card h3{font-size:1.05rem;margin:0;flex:1 1 12rem;line-height:1.3}
.pri{font-weight:700;font-size:.8rem;border:1px solid currentColor;border-radius:6px;padding:0 .35rem}
.pp0{color:var(--p0)}.pp1{color:var(--p1)}.pp2{color:var(--p2)}.pp3{color:var(--p3)}
.area{color:var(--dim);font-size:.8rem}
.why{margin:.4rem 0 .6rem;color:var(--dim);font-size:.95rem}
fieldset{border:0;margin:0;padding:0;min-width:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.opt{display:flex;gap:.6rem;align-items:flex-start;padding:.55rem .6rem;border-radius:8px;cursor:pointer;min-height:2.75rem;border:1px solid transparent}
.opt:has(input:checked){background:var(--accent-bg);border-color:var(--accent)}
.opt input{width:1.3rem;height:1.3rem;margin:.1rem 0 0;accent-color:var(--accent);flex:none}
.ob{display:flex;flex-direction:column;gap:.15rem;min-width:0}
.rec{font-style:normal;font-size:.75rem;color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:0 .45rem;white-space:nowrap}
.pv{font-size:.88rem;color:var(--dim);overflow-wrap:anywhere}
.pc{list-style:none;margin:.1rem 0 0;padding:0;font-size:.86rem}
.pc .pro::before{content:"+ ";color:var(--accent);font-weight:700}.pc .con::before{content:"- ";color:var(--bad);font-weight:700}
.ol{font-size:.86rem}
.opts.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem}
.opts.grid .opt{flex-direction:column;border-color:var(--edge);padding:.4rem}
.opts.grid .opt input{position:absolute;opacity:0}
.opts.grid .opt:has(input:focus-visible){outline:2px solid var(--accent)}
.opt img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:6px;background:var(--edge)}
.opts:not(.grid) .opt img{width:5.5rem;flex:none}
.acts{display:flex;flex-wrap:wrap;gap:.5rem;margin:.4rem 0}.acts:empty{display:none}
button{font:inherit;font-size:.9rem;border:1px solid var(--edge);background:none;color:var(--ink);border-radius:8px;padding:.45rem .8rem;min-height:2.6rem;cursor:pointer}
.take{border-color:var(--accent);background:var(--accent);color:var(--card);font-weight:600}
.clear{color:var(--dim)}
textarea{width:100%;font:inherit;font-size:16px;color:var(--ink);background:var(--bg);border:1px solid var(--edge);border-radius:8px;padding:.5rem .6rem;resize:vertical;margin-top:.4rem}
details>summary{cursor:pointer;color:var(--accent);font-size:.92rem;min-height:2.4rem;display:flex;align-items:center}
details.sect>summary{font-weight:600;font-size:1.05rem;color:var(--ink);margin-top:1.4rem}
.ctxb{background:var(--bg);border:1px solid var(--edge);border-radius:8px;padding:.2rem .8rem .6rem;font-size:.93rem}
.ctxb h4{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin:.7rem 0 .15rem}.ctxb p{margin:0}
.links{font-size:.86rem;margin:.3rem 0;overflow-wrap:anywhere}
.card:has(.opts input:checked),.card[data-kind=text]:has(textarea:not(:placeholder-shown)){border-color:var(--accent)}
.steps{margin:.4rem 0;padding-left:1.3rem}.expect{margin:.3rem 0;font-size:.95rem}
.pf{display:flex;gap:.4rem;flex-wrap:wrap}
.todo{margin:0 0 .5rem;padding-left:1.2rem}
.log{list-style:none;margin:.6rem 0 0;padding:0;font-size:.9rem}
.log li{padding:.35rem 0;border-top:1px solid var(--edge);display:flex;flex-wrap:wrap;gap:.2rem .5rem;align-items:baseline}
.log .cr{flex-basis:100%;color:var(--dim)}.cs-declined .chip{background:var(--bad-bg);color:var(--bad)}.cs-new .chip,.cs-doing .chip{background:var(--warn-bg);color:var(--warn)}
.rows{margin:0;padding:0 0 0 1.2rem}.rows li{padding:.25rem 0}
.rows .t,.grp .t{display:block}.rows .w,.grp .w{display:block;color:var(--dim);font-size:.85rem}
.grp{margin:.8rem 0}.grp h3{font-size:.95rem;margin:0 0 .3rem}.grp .n{color:var(--dim);font-weight:400}
.grp ul{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--edge);border-radius:10px}
.grp li{padding:.45rem .8rem;border-top:1px solid var(--edge);font-size:.92rem}.grp li:first-child{border-top:0}.nt{font-style:italic}
.s-shipped .t,.s-rejected .t,.s-dropped .t{text-decoration:line-through;color:var(--dim)}
.ev h4{margin:1rem 0 .2rem}.ev ul{margin:.2rem 0;padding-left:1.2rem;font-size:.92rem;color:var(--dim)}
a{color:var(--accent)}
</style>
</head>
<body>
<main>
${header}
${decide}
${testing}
${command}
${done}
${next}
${decided}
${evidence}
</main>
<script>
(function(){
  var T=${js(ui)};
  var N=window.nc||null;
  function q(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function el(tag,cls,text){var e=document.createElement(tag);e.setAttribute("nc:chrome","");if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
  function changed(){if(N){try{N.dirty=true;N.dispatchEvent(new CustomEvent("nsiteclay:autosave-now"));}catch(e){}}}
  function decided(c){if(c.dataset.kind==="text"){var t=c.querySelector("textarea");return !!(t&&t.value.trim());}return !!c.querySelector(".opts input:checked");}
  function recs(c){return (c.dataset.rec||"").split(" ").filter(Boolean);}
  function setRec(c){var r=recs(c);q(".opts input",c).forEach(function(i){var on=r.indexOf(i.value)>=0;if(i.type==="radio"){if(on)i.checked=true;}else i.checked=on;});}
  function onRec(c){var r=recs(c);if(!r.length)return false;var ins=q(".opts input",c);return ins.every(function(i){return (r.indexOf(i.value)>=0)===i.checked;});}
  function draw(){
    var cards=q("section.decide article.card");
    cards.forEach(function(c){
      var s=c.querySelector("[data-slot=acts]");if(!s)return;s.textContent="";
      if(recs(c).length&&!onRec(c)){var b=el("button","take",T.take);b.type="button";b.setAttribute("data-do","take");s.appendChild(b);}
      if(c.querySelector(".opts input:checked")){var x=el("button","clear",T.clear);x.type="button";x.setAttribute("data-do","clear");s.appendChild(x);}
    });
    var open=cards.filter(function(c){return !decided(c);});
    var tests=q("section.testing article.test").filter(function(t){return !t.querySelector("input:checked");});
    var g=document.querySelector("[data-slot=glance]");
    if(g){g.textContent="";var parts=[];if(open.length)parts.push(T.toDecide.replace("{n}",open.length));if(tests.length)parts.push(T.toTest.replace("{n}",tests.length));g.appendChild(el("span","",parts.length?parts.join(", "):T.allClear));}
    var ta=document.querySelector("[data-slot=takeall]");
    if(ta){ta.textContent="";var can=open.filter(function(c){return recs(c).length;});if(can.length>=3){var b=el("button","take",T.takeAll);b.type="button";b.setAttribute("data-do","takeall");ta.appendChild(b);}}
  }
  function watchLine(){
    var w=document.querySelector("[data-slot=watch]");if(!w)return;w.textContent="";
    var u=w.getAttribute("data-until"),t=u?Date.parse(u):NaN,text;
    if(isNaN(t))text=T.watchOff;
    else{var f;try{f=new Date(t).toLocaleString(document.documentElement.lang||undefined,{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});}catch(e){f=new Date(t).toString();}
      text=(t>Date.now()?T.watching:T.watchEnded).replace("{every}",w.getAttribute("data-every")||"10").replace("{until}",f);}
    w.appendChild(el("span","",text));
  }
  document.addEventListener("click",function(e){
    var b=e.target.closest&&e.target.closest("button[data-do]");if(!b)return;
    var d=b.getAttribute("data-do");
    if(d==="takeall"){q("section.decide article.card").forEach(function(c){if(!decided(c)&&recs(c).length)setRec(c);});}
    else{var c=b.closest("article.card");if(!c)return;
      if(d==="take")setRec(c);
      if(d==="clear")q(".opts input",c).forEach(function(i){i.checked=false;});}
    changed();draw();
  });
  document.addEventListener("change",draw);
  document.addEventListener("input",function(e){if(e.target.closest&&e.target.closest("[data-kind=text]"))draw();keep(e.target);});
  // Typed text that is not saved yet stays on this device, and comes back after a reload.
  var P="db:"+location.pathname+":";
  function store(){try{return window.localStorage;}catch(e){return null;}}
  function keep(t){if(!t||t.tagName!=="TEXTAREA"||!t.name)return;var s=store();if(!s)return;try{s.setItem(P+t.name,JSON.stringify({base:t.defaultValue,v:t.value}));}catch(e){}}
  q("textarea[name]").forEach(function(t){var s=store();if(!s)return;try{var r=JSON.parse(s.getItem(P+t.name)||"null");
    if(r&&r.v!==t.value&&r.base===t.defaultValue){t.value=r.v;var d=t.closest("details");if(d)d.open=true;changed();}else if(r)s.removeItem(P+t.name);}catch(e){}});
  var st=null;
  if(N&&N.addEventListener){
    var h=document.querySelector("header.top");
    st=el("p","state");st.setAttribute("role","status");st.setAttribute("aria-live","polite");if(h)h.appendChild(st);
    N.addEventListener("nsiteclay:status",function(e){var s=e.detail&&e.detail.status;
      st.textContent=s==="saving"?T.saving:s==="saved"?T.saved:s==="error"?String(e.detail.error||"").replace(/^Error: /,""):"";
      if(s==="saved"){var S=store();if(S)q("textarea[name]").forEach(function(t){try{var r=JSON.parse(S.getItem(P+t.name)||"null");if(r&&r.v===t.value)S.removeItem(P+t.name);}catch(e){}});}});
  }
  draw();watchLine();
})();
</script>
</body>
</html>
`;
}

// Puts what the page already holds back into a rebuilt page: the comments block verbatim, and a
// highlight on the words of each open comment where those words are still on the page.
export function carryComments(html, back) {
  const aside = /<aside\b[^>]*\bnc:comments\b[^>]*>[\s\S]*?<\/aside>/i.exec(back || "");
  if (!aside) return { html, comments: 0, anchored: 0 };
  const block = aside[0];
  let out = html.replace(/<\/main>/i, () => `</main>\n${block}`);
  let anchored = 0;
  const unq = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  for (const m of block.matchAll(/<article\b([^>]*\bnc:comment="([A-Za-z0-9]+)"[^>]*)>([\s\S]*?)<\/article>/g)) {
    if (!/nc:state="open"/.test(m[1])) continue;
    const qm = /<blockquote\b[^>]*nc:quote[^>]*>([\s\S]*?)<\/blockquote>/.exec(m[3]);
    if (!qm) continue;
    const quote = unq(qm[1]).trim();
    if (quote.length < 3) continue;
    const needle = esc(quote);
    // Only in text between tags inside <main>, never inside a script, a style or a textarea.
    const start = out.indexOf("<main>"), end = out.indexOf("</main>");
    if (start < 0 || end < 0) break;
    const body = out.slice(start, end);
    const re = /(<(script|style|textarea|title)\b[\s\S]*?<\/\2>)|(<[^>]*>)|([^<]+)/gi;
    let r, done = false, rebuilt = "";
    while ((r = re.exec(body))) {
      if (!done && r[4] && r[4].includes(needle)) {
        rebuilt += r[4].replace(needle, `<mark nc:c="${m[2]}">${needle}</mark>`);
        done = true;
      } else rebuilt += r[0];
    }
    if (done) { out = out.slice(0, start) + rebuilt + out.slice(end); anchored++; }
  }
  return { html: out, comments: [...block.matchAll(/nc:comment="/g)].length, anchored };
}
