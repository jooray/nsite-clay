#!/usr/bin/env node
// decision-board without a browser and without the network: build, validate, the round trip
// through a saved page (pull, merge, push with comments carried), the watcher, settings and notify.
// The artifact tool is a stub (test/fixtures/decision-board-stub-artifact.mjs).
//   node test/decision-board.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validate } from "../skills/decision-board/scripts/lib/schema.mjs";
import { readFields } from "../skills/decision-board/scripts/lib/readback.mjs";
import { parseUntil } from "../skills/decision-board/scripts/lib/tool.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SKILL = join(ROOT, "skills/decision-board");
const BOARD = join(SKILL, "scripts/board.mjs");
const STUB = join(ROOT, "test/fixtures/decision-board-stub-artifact.mjs");
let fail = 0, count = 0;
const check = (ok, what) => { count++; if (!ok) { fail++; console.log(`FAIL  ${what}`); } };

const tmp = mkdtempSync(join(tmpdir(), "db-test-"));
const xdg = join(tmp, "xdg");
mkdirSync(join(xdg, "decision-board"), { recursive: true });
const state = join(tmp, "stub.json");
const setStub = (s) => { writeFileSync(state, JSON.stringify(s)); writeFileSync(state + ".calls", ""); };
const stub = () => JSON.parse(readFileSync(state, "utf8"));
const calls = () => readFileSync(state + ".calls", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const userConfig = (c) => writeFileSync(join(xdg, "decision-board/config.json"), JSON.stringify(c));
userConfig({});

function run(args, { env = {}, script = BOARD, input } = {}) {
  const e = { ...process.env, XDG_CONFIG_HOME: xdg, DECISION_BOARD_ARTIFACT_TOOL: STUB, STUB_STATE: state, ...env };
  delete e.DECISION_BOARD_CONFIG; delete e.DECISION_BOARD_NOTIFY_COMMAND;
  for (const [k, v] of Object.entries(env)) if (v === null) delete e[k];
  const r = spawnSync(process.execPath, [script, ...args], { env: e, encoding: "utf8", input, timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, out: r.stdout, err: r.stderr };
}

// ---- build and the browser's serialisation ---------------------------------------------------
const work = join(tmp, "proj");
mkdirSync(work);
cpSync(join(SKILL, "assets/examples"), work, { recursive: true });
const bp = join(work, "audit.json");
{
  const r = run(["build", bp]);
  check(r.code === 0, `build the audit example: ${r.err}`);
  check(r.json && existsSync(r.json.out), "build writes the page into the work folder");
  check(existsSync(join(work, ".decision-board/.gitignore")), "the work folder ignores itself in git");
  const html = readFileSync(r.json.out, "utf8");
  check(!/<[^>]+\snc:chrome[\s>=]/.test(html.replace(/<script>[\s\S]*?<\/script>/g, "")), "C1: no nc:chrome in static markup");
  check(!/\/nsite-clay\.js/.test(html), "the page does not link the runtime itself");
  check(html.indexOf("token-expiry") < html.indexOf("export-format"), "P0 first");
  check(html.indexOf('class="testing"') < html.indexOf('class="cmd"') && html.indexOf('class="cmd"') < html.indexOf('class="done"'), "order: decide, testing, command box, done");
}

// Simulates what the runtime saves: checked attributes, textarea text, entities, a comment block.
function ownerSaves(html) {
  return html
    .replace('name="c-token-expiry" value="30d">', 'name="c-token-expiry" value="30d" checked="">')
    .replace(/(<textarea name="n-export-format"[^>]*>)<\/textarea>/, "$1also CSV&nbsp;later &amp; &lt;b&gt;</textarea>")
    .replace('name="t-sync-two-phones" value="fail">', 'name="t-sync-two-phones" value="fail" checked>')
    .replace(/(<textarea id="agent-instructions"[^>]*>)<\/textarea>/, "$1verify the migration on a copy first</textarea>")
    .replace("</body>", '<aside nc:comments hidden><article nc:comment="c7k2f9" nc:state="open" nc:at="2026-11-17T10:00:00Z"><blockquote nc:quote>a stolen phone keeps access forever</blockquote><p>Is that true for the web app too?</p></article></aside></body>');
}

{
  const page = readFileSync(join(work, ".decision-board/audit/page.html"), "utf8");
  setStub({ html: ownerSaves(page), changed: true, savedAt: "2026-11-17T10:00:00.000Z",
    comments: [{ id: "c7k2f9", state: "open", quote: "a stolen phone keeps access forever", text: "Is that true for the web app too?", replies: [], fresh: true }] });
  const raw = JSON.parse(readFileSync(bp, "utf8"));
  raw.artifact = { id: "stub1" };
  writeFileSync(bp, JSON.stringify(raw));

  const r = run(["pull", bp]);
  check(r.code === 0, `pull: ${r.err}`);
  const d = r.json || {};
  check(d.changed === true, "pull: changed");
  check(d.decided?.[0]?.id === "token-expiry" && d.decided[0].choice === "30d" && d.decided[0].was === null && /30 days/.test(d.decided[0].label), "pull: the decision, its label and what it was");
  check(d.notes?.[0]?.note === "also CSV later & <b>", `pull: note decoded, nbsp as a space (${JSON.stringify(d.notes)})`);
  check(d.tests?.[0]?.result === "fail", "pull: test result");
  check(d.commands?.[0]?.text === "verify the migration on a copy first" && d.commands[0].id === "k1", "pull: the command box text is a new instruction");
  check(d.comments?.[0]?.id === "c7k2f9", "pull: the new comment");
  check(d.undecided === 2 && d.untested === 0, `pull: counts (${d.undecided}, ${d.untested})`);
  check(r.out.length < 1500, `pull prints a small delta (${r.out.length} bytes)`);
  const b = JSON.parse(readFileSync(bp, "utf8"));
  check(b.items[0].choice === "30d" && b.commands.draft === "" && b.commands.log[0].state === "new", "pull: merged into board.json, box emptied");
  check(b.schema === 3, "pull: board is schema 3");

  // Nothing new: no read, no blob.
  const again = run(["pull", bp]);
  check(again.json?.changed === false, "pull again: unchanged");
  setStub({ ...stub(), changed: false });
  writeFileSync(state + ".calls", "");
  run(["pull", bp]);
  check(calls().map((c) => c[0]).join(",") === "status", "pull with nothing new runs status only");

  // The owner saves again before the agent pushed: the box still shows the old text.
  setStub({ ...stub(), changed: true });
  const r2 = run(["pull", bp]);
  check(!r2.json?.commands, "H4: text already in the log is not a new instruction");
  check(/no answer/.test(r2.json?.note || ""), "pull says when a save changed nothing");

  // The agent acts and pushes.
  const b2 = JSON.parse(readFileSync(bp, "utf8"));
  b2.commands.log[0].state = "done"; b2.commands.log[0].reply = "Ran it on a copy, no data lost.";
  b2.items[2].status = "postponed";
  writeFileSync(bp, JSON.stringify(b2));
  const p = run(["push", bp, "--watch=24h"]);
  check(p.code === 0, `push: ${p.err}`);
  check(p.json?.comments?.comments === 1 && p.json.comments.anchored === 1, `C2: the comment is carried and re-anchored (${JSON.stringify(p.json?.comments)})`);
  const pushed = stub().html;
  check(/<aside nc:comments hidden><article nc:comment="c7k2f9"/.test(pushed), "C2: comments block in the pushed page");
  check(/<mark nc:c="c7k2f9">a stolen phone keeps access forever<\/mark>/.test(pushed), "C2: open comment highlighted again");
  const f = readFields(pushed);
  check(f.text["agent-instructions"] === "", "the pushed page has an empty command box");
  check(/Ran it on a copy/.test(pushed), "the pushed page shows the reply");
  check(f.text["n-export-format"] === "also CSV later & <b>", "the note survives the round trip");
  check(f.checked["t-sync-two-phones"]?.[0] === "fail", "the test result survives the round trip");
  check(/data-until="\d{4}-/.test(pushed), "push --watch writes the deadline into the page");
  check(JSON.parse(readFileSync(bp, "utf8")).watch?.until, "push --watch writes the deadline into board.json");

  // The owner saved after the pull: push refuses.
  setStub({ ...stub(), changed: true });
  const p2 = run(["push", bp]);
  check(p2.code === 1 && /pull/.test(p2.err), "push refuses over a save it has not seen");

  setStub({ ...stub(), changed: false, deleted: "2026-11-17T11:00:00Z" });
  check(run(["pull", bp]).code === 3, "pull: a deleted page is exit 3");
  setStub({ ...stub(), deleted: null, mode: "offline" });
  const off = run(["pull", bp]);
  check(off.code === 4 && off.json?.offline, "C3: pull offline is a failure, not gone");
}

// ---- validate ---------------------------------------------------------------------------------
{
  const base = { title: "t", items: [] };
  const v = (o) => validate({ ...base, ...o });
  const col = v({ items: [{ id: "a.b", title: "x", kind: "text" }, { id: "a_b", title: "y", kind: "text" }] });
  check(col.errors.some((e) => /same field name/.test(e)), "H1: colliding ids are an error");
  check(v({ items: [{ id: "a", title: "x", status: "done", options: [] }] }).errors.some((e) => /status "done"/.test(e)), "H2: unknown status is an error");
  check(v({ items: [{ id: "a", title: "x", options: [{ id: "1", label: "a", recommended: true }, { id: "2", label: "b", recommended: true }] }] }).errors.some((e) => /2 recommended/.test(e)), "two recommended options are an error");
  check(v({ items: [{ id: "a", title: "x", options: [{ id: "1", label: "a" }], choice: "9" }] }).errors.some((e) => /not one of its options/.test(e)), "a choice that is no option is an error");
  check(v({ subtitle: "see https://x.example/#e=abcdefabcdefabcdefabcdef" }).errors.some((e) => /key/.test(e)), "a keyed link is refused");
  check(v({ subtitle: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" }).errors.length > 0, "an nsec is refused");
  check(v({ watch: { until: "next tuesday" } }).errors.some((e) => /watch.until/.test(e)), "a bad watch.until is an error");
  check(v({ items: [{ id: "a", title: "x", options: [] }] }).errors.some((e) => /no options/.test(e)), "M4: an open card with no options needs kind text");
  check(v({ items: [{ id: "a", title: "x", options: [{ id: "1", label: "a", image: "https://x.example/a.png" }] }] }).errors.some((e) => /web address/.test(e)), "a remote image is refused");
  check(validate({ items: [] }).errors.some((e) => /title/.test(e)), "M6: a missing title is an error");
  check(v({ subtitle: "a \u2014 b" }).warnings.some((w) => /dash/.test(w)), "a dash is a warning");

  // H3: a numeric option id keeps the choice through build and read back.
  const nb = join(tmp, "num.json");
  writeFileSync(nb, JSON.stringify({ title: "n", items: [{ id: "n", title: "n", why: "w", details: "d", options: [{ id: 2, label: "two" }, { id: 3, label: "three" }], choice: 2 }] }));
  const r = run(["build", nb, join(tmp, "num.html")]);
  check(r.code === 0 && readFields(readFileSync(join(tmp, "num.html"), "utf8")).checked["c-n"]?.[0] === "2", "H3: a numeric option id stays checked");
  // M1: a label that closes the script.
  writeFileSync(nb, JSON.stringify({ title: "n", labels: { take: "</script><img src=x onerror=alert(1)>" }, items: [] }));
  run(["build", nb, join(tmp, "m1.html")]);
  const m1 = readFileSync(join(tmp, "m1.html"), "utf8");
  check(!/<\/script><img/.test(m1), "M1: a label cannot close the script");
  // A bad board exits 1 and says why.
  writeFileSync(nb, "{ not json");
  const bad = run(["validate", nb]);
  check(bad.code === 1 && /not valid JSON/.test(bad.err) && !/at JSON.parse/.test(bad.err), "invalid JSON is one sentence, no stack");
  check(run(["validate"]).code === 2, "no board is a usage error");
}

// ---- Slovak labels ----------------------------------------------------------------------------
{
  const sb = join(tmp, "sk.json");
  writeFileSync(sb, JSON.stringify({ title: "t", lang: "sk", items: [{ id: "a", title: "x", why: "w", details: "d", options: [{ id: "y", label: "Y", recommended: true }] }] }));
  run(["build", sb, join(tmp, "sk.html")]);
  const h = readFileSync(join(tmp, "sk.html"), "utf8");
  check(/<html lang="sk"/.test(h) && />Rozhodnite</.test(h) && /Vziať odporúčané/.test(h), "lang sk uses locales/sk.json");
  userConfig({ language: "sk" });
  writeFileSync(sb, JSON.stringify({ title: "t", items: [] }));
  run(["build", sb, join(tmp, "sk2.html")]);
  check(/<html lang="sk"/.test(readFileSync(join(tmp, "sk2.html"), "utf8")), "the language setting picks the page language");
  userConfig({});
}

// ---- a 0.2 board ------------------------------------------------------------------------------
{
  const old = { title: "Old", lang: "en", actions: ["Try it on two phones."], agentInstructions: "do X first",
    watch: { everyMin: 10, until: "2026-11-18T12:00:00Z", tz: "Europe/Somewhere" }, labels: { done: "decided", agent: "Notes for the agent" },
    items: [{ id: "q", title: "Q", why: "w", details: { context: "c" }, options: [{ id: "y", label: "Yes", recommended: true }, { id: "n", label: "No" }], choice: null, note: "" },
      { id: "ci", title: "CI", status: "shipped", options: [] }] };
  const ob = join(tmp, "old.json");
  writeFileSync(ob, JSON.stringify(old));
  const r = run(["build", ob, join(tmp, "old.html")]);
  check(r.code === 0, `0.2 board builds: ${r.err}`);
  const h = readFileSync(join(tmp, "old.html"), "utf8");
  check(/do X first<\/textarea>/.test(h), "0.2: agentInstructions fills the command box");
  check(/Notes for the agent/.test(h), "0.2: an old label name still applies");
  check(/Try it on two phones/.test(h), "0.2: actions are shown");
  check(/<h2>What was done<\/h2>/.test(h) === false && !/>decided</.test(h), "0.2: the old 'done' label is not used as a section title");
}

// ---- watch ------------------------------------------------------------------------------------
{
  const w = (args, s, env) => { setStub(s); const t = Date.now(); const r = run(["watch", "stub1", ...args], { env }); r.ms = Date.now() - t; return r; };
  const old = new Date(Date.now() - 3600e3).toISOString();
  let r = w(["--every=1", "--settle=0"], { changed: true, savedAt: old });
  check(r.code === 0 && r.json?.event === "changed", `watch: changed is exit 0 (${r.code} ${r.err})`);
  r = w(["--every=0.05", "--until=1h"], { mode: "offline" });
  check(r.code === 4 && r.json?.event === "error", `C3: offline five times is an error, not gone (${r.code})`);
  r = w(["--every=1"], { deleted: "2026-11-17T00:00:00Z" });
  check(r.code === 3 && r.json?.event === "gone", "watch: deleted is exit 3");
  r = w(["--every=1"], { expires: "2020-01-01T00:00:00Z" });
  check(r.code === 3 && r.json?.event === "expired", "M8: expired is reported as expired");
  r = w(["--every=1", "--until=2020-01-01T00:00:00Z"], { changed: false });
  check(r.code === 5 && r.json?.event === "deadline", "C4: an ISO deadline fires");
  r = w(["--every=60", "--until=1.5h"], { changed: true, savedAt: old });
  check(r.code === 0, "C4: a fractional duration is accepted");
  r = w(["--every=abc"], { changed: false });
  check(r.code === 2, "C4: a bad interval is exit 2, before any call");
  check(calls().length === 0, "C4: no tool call with a bad interval");
  r = w(["--every=1", "--settle=0"], { changed: true, savedAt: old, mode: "warn" });
  check(r.code === 0 && r.json?.event === "changed", "C4: a warning on stderr does not hide a change");
  r = w(["--every=10", `--until=${Math.floor(Date.now() / 1000) + 2}`], { changed: false });
  check(r.code === 5 && r.ms < 6000, `M7: the sleep stops at the deadline (${r.ms} ms)`);
  r = w(["--every=1", "--settle=2"], { changed: true, savedAt: new Date().toISOString() });
  check(r.code === 0 && r.ms >= 1500, `M10: a fresh save waits for the settle time (${r.ms} ms)`);
  setStub({ changed: false });
  r = run(["watch", "nope", "--every=1"]);
  check(r.code === 2, "an unknown id is exit 2 at once");
  r = run(["watch", "stub1", "--every=1"], { env: { DECISION_BOARD_ARTIFACT_TOOL: join(tmp, "missing.mjs") } });
  check(r.code === 4 && /not found/.test(r.err), "H6: a missing tool is an error at once");
  // Through a symlinked skill folder the tool next to the link is found.
  const skills = join(tmp, "skills");
  mkdirSync(join(skills, "nsite-artifacts/scripts"), { recursive: true });
  cpSync(STUB, join(skills, "nsite-artifacts/scripts/artifact.mjs"));
  symlinkSync(SKILL, join(skills, "decision-board"));
  setStub({ changed: true, savedAt: old });
  r = run(["watch", "stub1", "--every=1", "--settle=0"], { script: join(skills, "decision-board/scripts/board.mjs"), env: { DECISION_BOARD_ARTIFACT_TOOL: null } });
  check(r.code === 0, `H6: the tool is found next to a symlinked skill (${r.err})`);
  // The 0.2 wrapper.
  setStub({ changed: true, savedAt: old });
  const sh = spawnSync("sh", [join(SKILL, "scripts/watch.sh"), "stub1", "1", "2020-01-01T00:00:00Z"], { env: { ...process.env, XDG_CONFIG_HOME: xdg, DECISION_BOARD_ARTIFACT_TOOL: STUB, STUB_STATE: state }, encoding: "utf8" });
  check(sh.status === 0 && /"changed"/.test(sh.stdout), `watch.sh still works (${sh.status} ${sh.stderr})`);
  // watch takes the deadline from the board.
  setStub({ changed: true, savedAt: old });
  r = run(["watch", bp, "--every=1", "--settle=0"]);
  check((r.code === 0 && r.json?.until === JSON.parse(readFileSync(bp, "utf8")).watch.until), `watch takes the deadline from board.json (${r.code} ${r.out})`);
  check(parseUntil("2026-11-18T14:00:00Z") === Date.parse("2026-11-18T14:00:00Z") && parseUntil("1700000000") === 1700000000000 && parseUntil("nope") === null, "parseUntil: ISO, unix seconds, rubbish");
}

// ---- settings, notify, publish ----------------------------------------------------------------
{
  const sink = join(tmp, "sink.txt");
  const sinkScript = join(tmp, "sink.mjs");
  writeFileSync(sinkScript, `import { writeFileSync } from "node:fs"; let s = ""; for await (const c of process.stdin) s += c; writeFileSync(${JSON.stringify(sink)}, s);`);
  const NPUB = "npub1" + "q".repeat(58);
  // A project file may not set the notify command or the owner.
  writeFileSync(join(work, "decision-board.config.json"), JSON.stringify({ language: "en", notify: { command: ["touch", join(tmp, "pwned")] }, ownerNpub: NPUB, artifactTool: "/bin/false" }));
  userConfig({});
  let r = run([bp], { script: join(SKILL, "scripts/config.mjs"), env: { DECISION_BOARD_ARTIFACT_TOOL: null } });
  check(r.json && r.json.config.notify.command === null && r.json.config.ownerNpub === null && r.json.config.artifactTool === null, "a project file cannot set commands or the owner");
  check(r.json && r.json.ignored.length === 3, "and config.mjs says what it ignored");
  setStub({ changed: false });
  r = run(["notify-test"], { script: join(SKILL, "scripts/notify.mjs"), env: { DECISION_BOARD_ARTIFACT_TOOL: STUB } });
  check(!existsSync(join(tmp, "pwned")), "the project's notify command never ran");
  check(r.json?.notified === false && r.code === 0, "no notify command: notified false, exit 0");

  // The user's file: a string command (as people write it) and an owner.
  userConfig({ ownerNpub: NPUB, notify: { command: `${process.execPath} ${sinkScript}`, includeEditLink: true } });
  r = run(["--id=stub1", "Decided two things."], { script: join(SKILL, "scripts/notify.mjs") });
  check(r.json?.notified === true && r.json.withLink === true, `notify sends (${r.err})`);
  check(!/STUBKEY/.test(r.out), "notify never prints the link");
  check(/Decided two things\.\n\nhttps:\/\/stub\.invalid\/#e=STUBKEY/.test(readFileSync(sink, "utf8")), "the message carries the whole edit link");

  // publish: link access, the owner as a member too, link not printed when notify worked.
  const pb = join(work, "cover-image.json");
  setStub({});
  r = run(["publish", pb, "--watch=24h", "--notify=Here is the board."]);
  check(r.code === 0, `publish: ${r.err}`);
  const created = stub().created || [];
  check(created.includes("--visibility=link") && created.includes("--edit=link") && created.includes(`--member=${NPUB}`), `publish: link access plus the owner as a member (${created.join(" ")})`);
  check(r.json?.notified === true && !r.json.link && !/STUBKEY/.test(r.out), "publish: link sent by notify, not printed");
  check(JSON.parse(readFileSync(pb, "utf8")).artifact?.id === "stub1", "publish records the id in board.json");
  check(/data:image\/webp;base64,/.test(stub().html), "images are inside the page");
  check(run(["publish", pb]).code === 1, "publishing twice is refused");
  // A page published before the owner was configured gets the membership on the next push, once.
  rmSync(join(work, ".decision-board/cover-image/state.json"));
  setStub({ ...stub(), changed: false });
  run(["push", pb]);
  run(["push", pb]);
  check(stub().shared === 1, `push adds the owner as a member once (${stub().shared})`);
  // Without notify the link is printed for the chat.
  userConfig({});
  setStub({});
  const raw = JSON.parse(readFileSync(pb, "utf8")); delete raw.artifact; writeFileSync(pb, JSON.stringify(raw));
  r = run(["publish", pb]);
  check(r.json?.link && /only/.test(r.json.linkNote), "publish without notify prints the link with a warning");
  check(!(stub().created || []).some((a) => a.startsWith("--member")), "no owner configured: no member");
  check(!(stub().created || []).some((a) => a.startsWith("--workspace")), "no workspace configured: none passed on");
  // A workspace in the user's file is passed on to create.
  userConfig({ workspace: "boards" });
  setStub({});
  { const raw2 = JSON.parse(readFileSync(pb, "utf8")); delete raw2.artifact; writeFileSync(pb, JSON.stringify(raw2)); }
  r = run(["publish", pb]);
  check(r.code === 0 && (stub().created || []).includes("--workspace=boards"), `workspace in the settings: create gets --workspace=boards (${(stub().created || []).join(" ")})`);
  userConfig({ workspace: "Not A Name" });
  r = run([pb], { script: join(SKILL, "scripts/config.mjs") });
  check(r.code === 1 && r.json.problems.some((p) => /workspace/.test(p)), "a workspace that is not a name is a settings problem");
  userConfig({ access: "members" });
  r = run([pb], { script: join(SKILL, "scripts/config.mjs") });
  check(r.code === 1 && r.json.problems.some((p) => /ownerNpub/.test(p)), "members access without an owner is a settings problem");
}

// ---- what ships -------------------------------------------------------------------------------
{
  const files = spawnSync("find", [SKILL, "-type", "f"], { encoding: "utf8" }).stdout.trim().split("\n");
  for (const f of files.filter((x) => /\.(md|mjs|json|sh|txt)$/.test(x) || /LICENSE$/.test(x))) {
    const t = readFileSync(f, "utf8");
    check(!/[\u2013\u2014]/.test(t), `${f.replace(SKILL + "/", "")}: no em or en dash`);
    check(!/npub1[02-9ac-hj-np-z]{58}/.test(t), `${f.replace(SKILL + "/", "")}: no real npub`);
    check(!/\.claude\//.test(t) || /harness-claude-code/.test(f), `${f.replace(SKILL + "/", "")}: no harness paths outside the harness reference`);
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `${fail} of ${count} decision-board check(s) failed` : `decision-board: ${count} checks passed.`);
process.exit(fail ? 1 : 0);
