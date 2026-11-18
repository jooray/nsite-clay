// Workspaces: many pages as paths of one site under one key, against relays,
// servers and a gateway in this process (test/fault-net.mjs). Above all, that
// no writer ever drops another writer's page from the shared manifest: two
// machines with the same key writing at once, a write that loses a race, a
// browser tab that puts a deleted page back.
//
//   node test/workspace-faults.mjs
import "../bin/node-compat.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, webcrypto } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { startFaultNet } from "./fault-net.mjs";
import { openText, parseShell, unb64u, usePlatform } from "../src/seal.js";

usePlatform({ crypto: webcrypto, deflate: (b) => deflateRawSync(b), inflate: (b) => inflateRawSync(b) });

const SCRIPT = new URL("../skills/nsite-artifacts/scripts/artifact.mjs", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
const S = mkdtempSync(join(tmpdir(), "nc-ws-"));
const net = await startFaultNet({ relays: 3, servers: 3 });
process.on("exit", () => { try { net.close(); } catch {} try { rmSync(S, { recursive: true, force: true }); } catch {} });

const H1 = S + "/one", H2 = S + "/two";
const base = { ...process.env, ...net.env, NSITE_ARTIFACTS_HOME: H1, NSITE_ARTIFACTS_RUNTIME: ROOT,
  NSITE_ARTIFACTS_RETRY_MS: "40", NSITE_ARTIFACTS_READBACK_MS: "60", NSITE_ARTIFACTS_SETTLE_MS: "250" };
function run(args, extra = {}, input = null) {
  return new Promise((done) => {
    const p = spawn("node", [SCRIPT, ...args], { env: { ...base, ...extra } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    if (input != null) p.stdin.end(input); else p.stdin.end();
    p.on("close", (code) => { let json = null; try { json = JSON.parse(out); } catch {} done({ code, json, err: err.trim(), out }); });
  });
}
const A = async (...args) => { const r = await run(args); return r.json ?? { error: r.err, code: r.code }; };
const B = async (...args) => { const r = await run(args, { NSITE_ARTIFACTS_HOME: H2 }); return r.json ?? { error: r.err, code: r.code }; };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const ledger = (home = H1) => JSON.parse(readFileSync(join(home, "ledger.json"), "utf8"));
const table = (relay, pk) => Object.fromEntries((relay.manifestOf(pk)?.tags || []).filter((t) => t[0] === "path").map((t) => [t[1], t[2]]));
const onServers = (hash) => net.servers.filter((s) => s.blobs.has(hash)).length;
const reset = () => { for (const s of net.servers) Object.assign(s, { lieHead: false, dropBodies: false, wrongDescriptor: false, fail429: 0, refuse: false }); for (const r of net.relays) Object.assign(r, { drop: false, down: false }); net.gateway.thaw(); };
const putEverywhere = (ev) => { for (const r of net.relays) r.put(ev); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0, failed = 0;
const t = (name, pass, detail = "") => { n++; if (!pass) failed++; console.log((pass ? "ok   " : "FAIL ") + name + (pass ? "" : "   " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600))); };

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body>${body}</body></html>`;
const file = (name, html) => { const p = join(S, name); writeFileSync(p, html); return p; };
const LIST = (title) => file(`${title}.html`, page(title, `<h1 editable="single-line">${title}</h1><ul><li><input type="checkbox"> One</li><li><input type="checkbox"> Two</li></ul>`));
// A manifest as another writer would make it: the given table, signed with the workspace's key.
const manifestFrom = (sk, paths, created_at, extra = []) => finalizeEvent({ kind: 15128, created_at, content: "",
  tags: [...Object.entries(paths).map(([p, h]) => ["path", p, h]), ...extra] }, sk);

// ------------------------------------------------------------ init
let ws, sk, pk;
{
  const r = await run(["workspace", "init"]);
  ws = r.json;
  t("workspace init makes a workspace and says where it is", r.code === 0 && ws?.workspace === "default" && /^npub1/.test(ws.npub) && ws.url.includes(ws.npub), r.err || ws);
  const l = ledger();
  sk = unb64u(l.workspaces.default.secret); pk = getPublicKey(sk);
  t("its key is in the ledger, which only its owner can read", (statSync(join(H1, "ledger.json")).mode & 0o777) === 0o600 && l.workspaces.default.pubkey === pk);
  t("and is never printed", !r.out.includes(l.workspaces.default.secret) && !r.out.includes(nip19.nsecEncode(sk)) && !/nsec1/.test(r.out));
  t("it names the key that uploads, for a server that allows only some keys", ws.uploader === ws.npub, ws);
  t("its first manifest is on every relay, with the runtime and no page at the root", net.relays.every((x) => table(x, pk)["/nsite-clay.js"]) && !table(net.relays[0], pk)["/index.html"], table(net.relays[0], pk));
  const again = await run(["workspace", "init"]);
  t("a second init of the same name is refused", again.code === 1 && /already/.test(again.err), again.err);
}

// ------------------------------------------------------------ two pages
let p1, p2;
{
  p1 = await A("create", LIST("Alpha"), "--workspace", "--edit=link", "--expires=30d");
  p2 = await A("create", LIST("Beta"), "--workspace", "--edit=link", "--expires=7d");
  t("create --workspace puts a page at /<id>/ of the workspace", p1.verified && p1.workspace === "default" && p1.url === `${ws.url}${p1.id}/` && p1.gateway === "current", p1);
  t("a second page gets its own path", p2.verified && p2.url === `${ws.url}${p2.id}/` && p2.id !== p1.id, p2);
  const tb = table(net.relays[0], pk);
  t("both are in the manifest, next to the runtime", tb[`/${p1.id}/index.html`] && tb[`/${p2.id}/index.html`] && tb["/nsite-clay.js"], tb);
  const m = net.relays[0].manifestOf(pk);
  t("the manifest never expires, and carries no title", !m.tags.some((x) => x[0] === "expiration" || x[0] === "title"), m.tags);
  t("its paths say nothing but the ids", Object.keys(tb).every((p) => /^\/([0-9a-f]{8}\/index\.html|nsite-clay[-a-z]*\.(js|css))$/.test(p)), Object.keys(tb));
  t("the edit link carries the signing key and the page's own read key", /#e=[A-Za-z0-9_-]{43}&k=[A-Za-z0-9_-]{43}$/.test(p1.editLink) && /#k=[A-Za-z0-9_-]{43}$/.test(p1.readLink), p1.editLink?.replace(/=[^&]+/g, "=…"));
  const k1 = p1.readLink.split("#k=")[1], k2 = p2.readLink.split("#k=")[1];
  t("each page has its own read key", k1 !== k2);
  const shell2 = parseShell(new TextDecoder().decode(net.servers[0].blobs.get(tb[`/${p2.id}/index.html`]).bytes));
  const where2 = { owner: pk, site: "", path: `/${p2.id}/index.html` };
  const opened = await openText(shell2.sealed, unb64u(k2), where2).then(() => true, () => false);
  const crossed = await openText(shell2.sealed, unb64u(k1), where2).then(() => true, () => false);
  t("so one page's link does not open another page", opened && !crossed);
  t("the gateway serves each page at its own path", (await fetch(p1.url)).status === 200 && (await fetch(p2.url)).status === 200);
  t("the site's own address shows nothing", (await fetch(ws.url)).status === 404);
  t("an edit link warns that it holds the workspace's key", (p1.warnings || []).some((w) => /holds the workspace's key/.test(w)), p1.warnings);
}

// ------------------------------------------------------------ update, read, comment
{
  const f = join(S, "a.html");
  await A("read", p1.id, "--as=html", "--out=" + f);
  const beta = table(net.relays[0], pk)[`/${p2.id}/index.html`];
  const tagBefore = JSON.stringify(net.relays[0].manifestOf(pk).tags.find((x) => x[1] === `/${p2.id}/index.html`));
  writeFileSync(f, readFileSync(f, "utf8").replace("Two", "Two and a half"));
  const up = await A("update", p1.id, f);
  t("update of one page lands", up.verified === true, up);
  const m = net.relays[0].manifestOf(pk);
  t("and leaves the other page's entry exactly as it was", JSON.stringify(m.tags.find((x) => x[1] === `/${p2.id}/index.html`)) === tagBefore && table(net.relays[0], pk)[`/${p2.id}/index.html`] === beta);
  const old = ledger().artifacts[p1.id].retired?.[0];
  t("the replaced version is retired under its own path", m.tags.some((x) => x[0] === "retired" && x[1] === old?.hash && x[3] === `/${p1.id}/index.html`), m.tags.filter((x) => x[0] === "retired"));
  const rd = await A("read", p1.id);
  t("read gives the page back", /Two and a half/.test(rd.text || ""), rd);
  const st = await A("status");
  t("status covers workspace pages", st.artifacts?.some((x) => x.id === p1.id && x.workspace === "default" && x.published && x.health === "ok"), st);
  const vf = await run(["verify", p2.id]);
  t("verify on one page checks that page", vf.code === 0 && vf.json?.ok && vf.json.blobs?.every((b) => b.path === `/${p2.id}/index.html` || b.path.startsWith("/nsite-clay")), vf.json || vf.err);
  const html = page("Notes", `<h1>Notes</h1><p editable>Buy <mark nc:c="abc123">milk</mark>.</p><aside nc:comments hidden><article nc:comment="abc123" nc:state="open" nc:by="J" nc:at="2026-11-17T10:00:00.000Z"><blockquote>milk</blockquote><p nc:text>Oat?</p></article></aside>`);
  const c = await A("create", file("c.html", html), "--workspace", "--edit=link");
  const r = await A("reply", c.id, "abc123", "--text=Oat it is.", "--resolve");
  t("reply works on a workspace page", r.state === "resolved" && r.verified, r);
  globalThis.notes = c;
}

// ------------------------------------------------------------ per-path retirement never deletes a named blob
{
  const betaHash = table(net.relays[0], pk)[`/${p2.id}/index.html`];
  const l = ledger();
  l.artifacts[p1.id].retired = [...(l.artifacts[p1.id].retired || []), { hash: betaHash, at: 1, path: `/${p1.id}/index.html` }];
  writeFileSync(join(H1, "ledger.json"), JSON.stringify(l));
  const ownOld = l.artifacts[p1.id].retired[0].hash;
  const sw = await run(["sweep"], { NSITE_ARTIFACTS_RETIRE_AFTER: "0" });
  t("sweep deletes a page's own retired version", onServers(ownOld) === 0, sw.json || sw.err);
  t("but never a blob that a path of the manifest still names, whoever retired it", onServers(betaHash) === 3 && (await fetch(p2.url)).status === 200);
}

// ------------------------------------------------------------ the default stays one site per page
{
  const own = await A("create", LIST("Solo"), "--edit=link");
  t("without --workspace a page is its own site, as before", own.verified && !own.workspace && !own.url.includes(ws.npub) && !/&k=/.test(own.editLink), own);
  const viaEnv = (await run(["create", LIST("Env"), "--edit=link"], { NSITE_ARTIFACTS_WORKSPACE: "default" })).json;
  t("NSITE_ARTIFACTS_WORKSPACE puts it in the workspace", viaEnv?.workspace === "default", viaEnv);
  const not = (await run(["create", LIST("Not"), "--edit=link", "--no-workspace"], { NSITE_ARTIFACTS_WORKSPACE: "default" })).json;
  t("and --no-workspace overrides that", not && !not.workspace && !not.url.includes(ws.npub), not);
  const none = await run(["create", LIST("None"), "--workspace=nosuch"]);
  t("a workspace that is not here is refused, saying how to make one", none.code === 1 && /workspace init --name=nosuch/.test(none.err), none.err);
  globalThis.envPage = viaEnv;
}

// ------------------------------------------------------------ export and adopt
{
  const ex = join(S, "ws.json");
  const r = await run(["workspace", "export", "--out=" + ex]);
  const secret = ledger().workspaces.default.secret;
  t("workspace export writes a file only its owner can read", r.code === 0 && (statSync(ex).mode & 0o777) === 0o600 && readFileSync(ex, "utf8").includes(secret), r.err || r.json);
  t("prints no secret and says loudly what the file is", !r.out.includes(secret) && /secret key/.test(r.json?.warning || ""), r.json);
  const again = await run(["workspace", "export", "--out=" + ex]);
  t("and does not write over a file", again.code === 1 && /exists/.test(again.err), again.err);
  const ad = (await run(["workspace", "adopt", ex], { NSITE_ARTIFACTS_HOME: H2 })).json;
  t("workspace adopt takes it, with its pages, into another home", ad?.adopted === true && ad.npub === ws.npub && ad.pages?.includes(p1.id), ad);
  const rd = await B("read", p1.id);
  t("where its pages can be read", /Two and a half/.test(rd.text || ""), rd);
  // Only the key, from a file and from stdin.
  const keyFile = join(S, "key.txt");
  writeFileSync(keyFile, nip19.nsecEncode(sk) + "\n", { mode: 0o600 });
  const H3 = S + "/three";
  const k = (await run(["workspace", "adopt", keyFile, "--name=work"], { NSITE_ARTIFACTS_HOME: H3 })).json;
  t("or from a file that holds only its nsec", k?.adopted === true && k.npub === ws.npub && k.workspace === "work" && k.paths >= 3, k);
  const lst = (await run(["workspace", "list"], { NSITE_ARTIFACTS_HOME: H3 })).json;
  t("which sees the pages made elsewhere only as a count", lst?.workspaces?.[0]?.pages.length === 0 && lst.workspaces[0].otherPages >= 3, lst);
  const lit = await run(["workspace", "adopt", nip19.nsecEncode(sk), "--name=lit"], { NSITE_ARTIFACTS_HOME: S + "/four" });
  t("a key on the command line is taken with a warning, and not printed back", lit.json?.adopted && (lit.json.warnings || []).some((w) => /history/.test(w)) && !lit.out.includes(nip19.nsecEncode(sk)), lit.json || lit.err);
  const piped = await run(["workspace", "adopt", "-", "--name=piped"], { NSITE_ARTIFACTS_HOME: S + "/five" }, nip19.nsecEncode(sk));
  t("or piped in on stdin", piped.json?.adopted === true, piped.json || piped.err);
  // A page's edit link brings its workspace with it.
  const H6 = S + "/six";
  const one = (await run(["adopt", p2.editLink], { NSITE_ARTIFACTS_HOME: H6 })).json;
  t("adopt <edit link> of a workspace page takes the page and its workspace", one?.adopted && one.workspace && one.id === p2.id, one);
  const rd6 = (await run(["read", p2.id], { NSITE_ARTIFACTS_HOME: H6 })).json;
  t("and can read it", /Beta/.test(rd6?.text || ""), rd6);
}

// ------------------------------------------------------------ two machines, one key, writing at once
{
  reset();
  // Each run holds its read for a moment before it publishes, so two
  // machines' writes interleave: both build on the same manifest.
  const slow = { NSITE_ARTIFACTS_TEST_PAUSE_MS: "400", NSITE_ARTIFACTS_SETTLE_MS: "1200" };
  const runs = [];
  for (let i = 0; i < 3; i++) {
    runs.push(run(["create", LIST(`One${i}`), "--workspace", "--edit=link"], { ...slow, NSITE_ARTIFACTS_HOME: H1 }));
    runs.push(run(["create", LIST(`Two${i}`), "--workspace", "--edit=link"], { ...slow, NSITE_ARTIFACTS_HOME: H2 }));
  }
  const res = await Promise.all(runs);
  const ids = res.map((r) => r.json?.id);
  t("six creates from two machines at once all succeed", ids.every(Boolean), res.map((r) => r.err || r.json?.id));
  const tables = net.relays.map((x) => table(x, pk));
  t("and every relay's manifest names all six pages", tables.every((tb) => ids.every((id) => tb[`/${id}/index.html`])), tables.map((tb) => Object.keys(tb).length));
  t("together with every page made before", tables.every((tb) => tb[`/${p1.id}/index.html`] && tb[`/${p2.id}/index.html`]));
  const raced = [H1, H2].some((h) => /"retry"/.test(readFileSync(join(h, "log.jsonl"), "utf8")));
  console.log(`     (a race was ${raced ? "" : "not "}observed and merged again)`);
  t("no workspace lock file is left", !existsSync(join(H1, "workspace-default.lock")) && !existsSync(join(H2, "workspace-default.lock")));
  globalThis.raceIds = ids;
}

// ------------------------------------------------------------ a writer that read just before this one published
{
  reset();
  // The other machine read the manifest, then this one published, then the
  // other one published its own, built on what it read: without this page.
  const before = net.relays[0].manifestOf(pk);
  const baseTable = table(net.relays[0], pk);
  // Another machine's page, really on the servers.
  const theirBytes = Buffer.from("<!doctype html><title>someone else's page</title>");
  const foreign = sha(theirBytes);
  for (const s of net.servers) s.blobs.set(foreign, { bytes: theirBytes, type: "text/html" });
  const job = run(["create", LIST("Late"), "--workspace", "--edit=link"], { NSITE_ARTIFACTS_SETTLE_MS: "1500" });
  let mine = null;
  for (let i = 0; i < 200 && !mine; i++) {
    await sleep(25);
    const now = net.relays[0].manifestOf(pk);
    if (now && now.id !== before.id) mine = now;
  }
  const theirs = manifestFrom(sk, { ...baseTable, "/foreign1/index.html": foreign }, mine.created_at + 1);
  putEverywhere(theirs);
  const r = await job;
  const tb = table(net.relays[0], pk);
  t("a write that another machine's stale write wiped out is noticed and merged again", r.json?.id && tb[`/${r.json.id}/index.html`] && tb["/foreign1/index.html"] === foreign, { err: r.err, tb: Object.keys(tb) });
  t("and every other page is still there", Object.keys(baseTable).every((p) => tb[p] === baseTable[p]));
  t("the log says why it wrote twice", /another writer (replaced the workspace's manifest|published the workspace at the same moment)/.test(readFileSync(join(H1, "log.jsonl"), "utf8")));
}

// ------------------------------------------------------------ a page lost anyway, found and put back
{
  reset();
  const cur = net.relays[0].manifestOf(pk);
  const tb = table(net.relays[0], pk);
  const lostPath = `/${p1.id}/index.html`;
  const { [lostPath]: gone, ...rest } = tb;
  putEverywhere(manifestFrom(sk, rest, cur.created_at + 1, cur.tags.filter((x) => x[0] === "server")));
  const st = await A("status", p1.id);
  t("status calls a page that fell out of the manifest broken, not deleted", !st.deleted && st.health === "broken" && (st.problems || []).some((p) => /another writer dropped it/.test(p)), st);
  t("and the ledger does not write it off", !ledger().artifacts[p1.id].deleted);
  const v = await run(["workspace", "verify"]);
  t("workspace verify finds it and exits 1", v.code === 1 && v.json?.lost?.includes(p1.id), v.json || v.err);
  const all = await run(["verify"]);
  t("so does verify over everything", all.code === 1 && all.json?.workspaces?.some((w) => !w.ok), all.json?.workspaces || all.err);
  const fx = await run(["workspace", "doctor", "--fix"]);
  t("workspace doctor --fix puts it back", fx.code === 0 && table(net.relays[0], pk)[lostPath] === gone && fx.json?.after?.ok, fx.json || fx.err);
  t("without touching any other page", Object.entries(rest).every(([p, h]) => table(net.relays[0], pk)[p] === h));
}

// ------------------------------------------------------------ delete one page
{
  reset();
  const pathA = `/${globalThis.notes.id}/index.html`;
  const hashA = table(net.relays[0], pk)[pathA];
  const others = Object.entries(table(net.relays[0], pk)).filter(([p]) => p !== pathA);
  const d = await A("delete", globalThis.notes.id);
  const tb = table(net.relays[0], pk);
  t("delete takes out only that page's path", d.deleted && !tb[pathA] && others.every(([p, h]) => tb[p] === h), { d, left: Object.keys(tb).length, was: others.length });
  t("and its file", onServers(hashA) === 0);
  t("the workspace, its key and its other pages stay", ledger().workspaces.default?.secret && (await fetch(p2.url)).status === 200 && (await fetch(`${ws.url}${globalThis.notes.id}/`)).status === 404);
  // A browser tab that still had the older table saves another page, and puts the deleted one back.
  const cur = net.relays[0].manifestOf(pk);
  putEverywhere(manifestFrom(sk, { ...tb, [pathA]: hashA }, cur.created_at + 1, cur.tags.filter((x) => x[0] === "server")));
  const v = await run(["workspace", "verify"]);
  t("workspace verify sees the deleted page named again", v.code === 1 && v.json?.resurrected?.includes(pathA), v.json || v.err);
  const f = join(S, "b2.html");
  await A("read", p2.id, "--as=html", "--out=" + f);
  writeFileSync(f, readFileSync(f, "utf8").replace("One", "Uno"));
  await A("update", p2.id, f);
  t("and the next write takes it out again by itself", !table(net.relays[0], pk)[pathA], Object.keys(table(net.relays[0], pk)));
}

// ------------------------------------------------------------ expiry per page
{
  reset();
  const old = await A("create", LIST("Old"), "--workspace", "--edit=link", "--expires=2020-01-01");
  const path = `/${old.id}/index.html`;
  const before = Object.entries(table(net.relays[0], pk)).filter(([p]) => p !== path);
  const sw = await A("sweep");
  const tb = table(net.relays[0], pk);
  t("sweep takes down an expired page of a workspace", sw.deleted?.some((x) => x.id === old.id && x.why === "expired") && !tb[path], sw);
  t("and nothing else of it", before.every(([p, h]) => tb[p] === h));
}

// ------------------------------------------------------------ servers that take only allowed keys
{
  reset();
  net.servers[0].refuse = true;      // 403 to every upload
  const r = await A("create", LIST("Allow"), "--workspace", "--edit=link");
  t("a server that refuses the upload is passed over for the others", r.verified && r.servers?.ok === 2, r);
  t("and the answer says it may take only keys it allows", (r.warnings || []).some((w) => /refused the upload \(401 or 403\)/.test(w)), r.warnings);
  net.servers[1].refuse = true;
  const r2 = await run(["create", LIST("Allow2"), "--workspace", "--edit=link"]);
  t("with too few servers left nothing is published, and it names the key to allow", r2.code === 1 && r2.err.includes(ws.npub) && /allow/.test(r2.err), r2.err);
  reset();
}

// ------------------------------------------------------------ an index at the root, only on request
{
  reset();
  const ix = await A("workspace", "index", "--pages=" + p2.id, "--title=Boards");
  t("workspace index puts a sealed page at the root, with its own link", ix.verified && ix.url === ws.url && /#k=/.test(ix.link || ""), ix);
  const served = await (await fetch(ws.url)).text();
  t("whose shell says nothing about the pages", served.includes("application/nc-sealed") && !/Boards|Beta/.test(served));
  const rd = await A("read", ix.id, "--as=html");
  t("and which lists only the page chosen, with its link", rd.html?.includes(p2.readLink.replace(/&/g, "&amp;")) && !rd.html.includes(p1.id), rd.html?.slice(0, 400));
  const again = await A("workspace", "index", "--pages=all", "--title=Boards");
  t("run again, it rewrites the same page", again.id === ix.id && again.verified, again);
  const rm = await A("workspace", "index", "--remove-index");
  t("and --remove-index takes it down", rm.removed === ix.id && (await fetch(ws.url)).status === 404, rm);
}

// ------------------------------------------------------------ list, upgrade, an old runtime
{
  const l = await A("workspace", "list");
  const w = l.workspaces?.[0];
  t("workspace list shows the workspace and its pages, with no key", w?.name === "default" && w.pages.some((p) => p.id === p1.id) && !JSON.stringify(l).includes(ledger().workspaces.default.secret), l);
  t("and counts the pages this ledger did not make", w?.otherPages >= 4, w?.otherPages);
  const up = await A("upgrade");
  t("upgrade over workspace pages changes nothing that is current", Array.isArray(up.current) && !(up.failed || []).length, up);
  const oldRt = join(S, "oldruntime");
  mkdirSync(oldRt, { recursive: true });
  writeFileSync(join(oldRt, "nsite-clay.js"), "/* application/nc-sealed, an old runtime */");
  const r = await run(["create", LIST("OldRt"), "--workspace", "--edit=link"], { NSITE_ARTIFACTS_RUNTIME: oldRt });
  t("a runtime too old for workspace pages is refused before anything is published", r.code === 1 && /too old for a workspace page/.test(r.err), r.err);
}

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
