// The artifact tool against relays, servers and a gateway that misbehave (see
// test/fault-net.mjs), and the ledger against runs that overlap or die.
// No browser: the bundled script the skill ships, run as a child process.
//
//   node test/artifact-faults.mjs
import "../bin/node-compat.mjs";     // so this file also runs on Node 18
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { startFaultNet } from "./fault-net.mjs";

const SCRIPT = new URL("../skills/nsite-artifacts/scripts/artifact.mjs", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
const S = mkdtempSync(join(tmpdir(), "nc-faults-"));
const net = await startFaultNet({ relays: 3, servers: 3 });
process.on("exit", () => { try { net.close(); } catch {} try { rmSync(S, { recursive: true, force: true }); } catch {} });

const base = { ...process.env, ...net.env, NSITE_ARTIFACTS_HOME: S + "/home", NSITE_ARTIFACTS_RUNTIME: ROOT,
  NSITE_ARTIFACTS_RETRY_MS: "40", NSITE_ARTIFACTS_READBACK_MS: "60" };
// Async, because the relays and servers live in this process.
function run(args, extra = {}) {
  return new Promise((done) => {
    const p = spawn("node", [SCRIPT, ...args], { env: { ...base, ...extra } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { let json = null; try { json = JSON.parse(out); } catch {} done({ code, json, err: err.trim(), out }); });
  });
}
const A = async (...args) => { const r = await run(args); return r.json ?? { error: r.err, code: r.code }; };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const ledger = (home = S + "/home") => JSON.parse(readFileSync(join(home, "ledger.json"), "utf8"));
const pubOf = (id, home) => ledger(home).artifacts[id].pubkey;
const indexOf = (relay, pubkey) => relay.manifestOf(pubkey)?.tags.find((t) => t[0] === "path" && t[1] === "/index.html")?.[2];
const onServers = (hash) => net.servers.filter((s) => s.blobs.has(hash)).length;
const gw = async (made) => { const r = await fetch(made.url); return { status: r.status, etag: r.headers.get("etag") }; };
const reset = () => { for (const s of net.servers) Object.assign(s, { lieHead: false, dropBodies: false, wrongDescriptor: false, fail429: 0, refuse: false }); for (const r of net.relays) Object.assign(r, { drop: false, down: false }); net.gateway.thaw(); };

let n = 0, failed = 0;
const t = (name, pass, detail = "") => { n++; if (!pass) failed++; console.log((pass ? "ok   " : "FAIL ") + name + (pass ? "" : "   " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500))); };

const page = (body, extra = "") => `<!doctype html><html lang="en"${extra}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Faults</title></head><body>${body}</body></html>`;
const file = (name, html) => { const p = join(S, name); writeFileSync(p, html); return p; };
const LIST = file("list.html", page(`<h1 editable="single-line">Faults</h1><ul><li><input type="checkbox"> One</li><li><input type="checkbox"> Two</li></ul>`));

// ---------------------------------------------------------------- the basics
{
  const v = await run(["--version"]);
  t("--version says which tool this is", /^\d+\.\d+\.\d+/.test(v.json?.tool || "") && v.json?.skill, v.out);
  const made = await A("create", LIST, "--edit=link", "--title", "Two words");
  t("create on a healthy network is verified everywhere", made.verified === true && made.relays?.ok === 3 && made.servers?.ok === 3 && made.gateway === "current", made);
  t("--title with a space before its value", made.title === "Two words", made.title);
  const hash = indexOf(net.relays[0], pubOf(made.id));
  t("every server holds the page", onServers(hash) === 3);
  const noValue = await run(["create", LIST, "--title"]);
  t("a value flag with no value is refused in words", noValue.code === 1 && /--title needs a value/.test(noValue.err), noValue.err);
  const out = join(S, "read.html");
  const rd = await A("read", made.id, "--as=html", "--out=" + out);
  t("read --out writes a file only its owner can read", (statSync(out).mode & 0o777) === 0o600, (statSync(out).mode & 0o777).toString(8));
  t("and the file says which version it was made from", readFileSync(out, "utf8").includes(`<meta name="nc:base" content="${hash}">`), rd);
  const up = await A("update", made.id, out);
  t("update reports how it landed, and prints no link", up.verified === true && up.relays?.ok === 3 && !up.link && !up.editLink, up);
  const after = ledger().artifacts[made.id];
  t("the version it replaced is retired in the ledger, not deleted", after.retired?.some((r) => r.hash === hash) && onServers(hash) === 3, after.retired);
  globalThis.first = made;
}

// --------------------------------------------- B1: a gateway serving the past
{
  const made = await A("create", LIST, "--edit=link");
  const pk = pubOf(made.id);
  const v1 = indexOf(net.relays[0], pk);
  net.gateway.freeze();                       // the gateway keeps v1's manifest
  const f = join(S, "b1.html");
  await A("read", made.id, "--as=html", "--out=" + f);
  writeFileSync(f, readFileSync(f, "utf8").replace("Two", "Two and a half"));
  const u1 = await A("update", made.id, f);
  await A("read", made.id, "--as=html", "--out=" + f);
  writeFileSync(f, readFileSync(f, "utf8").replace("One", "One more"));
  const u2 = await A("update", made.id, f);
  const v3 = indexOf(net.relays[0], pk);
  t("two updates while the gateway is stale both land", u1.verified && u2.verified && v3 !== v1, [u1, u2]);
  t("they say the gateway still serves an older version", u2.gateway === "older", u2.gateway);
  const g = await gw(made);
  t("the gateway, still on the first manifest, serves the page and not a 502", g.status === 200 && g.etag?.includes(v1), g);
  const vf = await run(["verify", made.id]);
  t("verify calls that healthy, with a note", vf.code === 0 && vf.json?.ok && vf.json.gateway?.serves === "older", vf.json || vf.err);
  const sw = await run(["sweep"], { NSITE_ARTIFACTS_RETIRE_AFTER: "0" });
  t("sweep deletes nothing while the gateway serves an older version", onServers(v1) === 3 && sw.json?.oldVersions?.some((o) => o.id === made.id && o.deleted === 0), sw.json || sw.err);
  net.gateway.thaw();
  const young = await run(["sweep"], { NSITE_ARTIFACTS_RETIRE_AFTER: "1h" });
  t("nor before the retired versions are old enough", onServers(v1) === 3, young.json);
  const blobsBefore = ledger().artifacts[made.id].blobs.length;
  const old = await run(["sweep"], { NSITE_ARTIFACTS_RETIRE_AFTER: "0" });
  t("once everything serves the newest and they are old enough, sweep deletes them", onServers(v1) === 0 && onServers(v3) === 3, old.json);
  t("and the ledger forgets them", ledger().artifacts[made.id].retired.length === 0 && ledger().artifacts[made.id].blobs.length < blobsBefore, ledger().artifacts[made.id]);
  t("the page still opens", (await gw(made)).status === 200);
  globalThis.b1 = made;
}

// --------------------------------------------- servers that lie
{
  reset();
  net.servers[0].lieHead = true; net.servers[0].dropBodies = true;     // 200s HEAD, keeps nothing
  const made = await A("create", LIST, "--edit=link");
  const hash = made.id ? indexOf(net.relays[0], pubOf(made.id)) : null;
  t("a server that answers HEAD but keeps no body is not counted", made.verified === true && made.servers?.ok === 2 && onServers(hash) === 2, made);
  t("and the answer says which one", (made.servers?.failed || []).some((w) => w.includes(net.servers[0].url) && /does not serve it/.test(w)), made.servers);
  net.servers[1].wrongDescriptor = true;
  const before = net.relays[0].stored().filter((e) => e.kind === 15128).length;
  const r = await run(["create", LIST, "--edit=link"]);
  t("with only one server really holding it, create fails before publishing", r.code === 1 && /only 1 of 3 servers hold the page/.test(r.err), r.err);
  t("no manifest went out", net.relays[0].stored().filter((e) => e.kind === 15128).length === before);
  t("and nothing is left pending in the ledger", !Object.values(ledger().artifacts).some((a) => a.state === "pending"), Object.values(ledger().artifacts).map((a) => a.state));
  reset();
  net.servers[2].fail429 = 2;
  const slow = await A("create", LIST, "--edit=link");
  t("a server that says 429 twice is retried and counted", slow.servers?.ok === 3, slow);
}

// --------------------------------------------- relays that drop events
{
  reset();
  const made = await A("create", LIST, "--edit=link");
  const pk = pubOf(made.id);
  const f = join(S, "relay.html");
  await A("read", made.id, "--as=html", "--out=" + f);
  net.relays[2].drop = true;
  writeFileSync(f, readFileSync(f, "utf8").replace("One", "Uno"));
  const u = await A("update", made.id, f);
  t("one of three relays dropping the manifest still publishes, and says so", u.verified === true && u.relays?.ok === 2 && (u.relays.lagging || []).some((l) => l.includes(net.relays[2].url)), u);
  t("the relay that dropped it still names a page that exists", onServers(indexOf(net.relays[2], pk)) === 3);
  const fix = await A("doctor", made.id, "--fix");
  t("doctor --fix cannot make a relay that drops events take it, and says so", (fix.actions || []).some((x) => /sent the current manifest again/.test(x)), fix);
  net.relays[2].drop = false;
  const fix2 = await A("doctor", made.id, "--fix");
  t("once it takes events again, doctor --fix brings it up to date", indexOf(net.relays[2], pk) === indexOf(net.relays[0], pk) && fix2.after?.ok, fix2);

  // A relay that cannot be reached at all costs one timeout, not one per round.
  net.relays[1].down = true;
  await A("read", made.id, "--as=html", "--out=" + f);
  const started = Date.now();
  const down = await A("update", made.id, f, "--force");
  t("a relay that is down is reported and not waited for over and over", down.verified === true && (down.relays?.lagging || []).some((l) => l.includes(net.relays[1].url) && /unreachable|none/.test(l)) && Date.now() - started < 30000, { down, ms: Date.now() - started });
  net.relays[1].down = false;
  await A("doctor", made.id, "--fix");

  // The relay the gateway reads drops it: the previous version is put back.
  const was = indexOf(net.relays[0], pk);
  await A("read", made.id, "--as=html", "--out=" + f);
  net.relays[0].drop = true;
  writeFileSync(f, readFileSync(f, "utf8").replace("Uno", "Eins"));
  const r = await run(["update", made.id, f]);
  t("without the gateway's relay, update fails", r.code === 1 && /previous version was put back/.test(r.err), r.err);
  net.relays[0].drop = false;
  t("every relay names the previous version, and its page exists", net.relays.every((x) => indexOf(x, pk) === was) && onServers(was) === 3, net.relays.map((x) => indexOf(x, pk)));
  const rd = await A("read", made.id);
  t("and reading shows the previous text", /Uno/.test(rd.text || "") && !/Eins/.test(rd.text || ""), rd);
}

// --------------------------------------------- verify and doctor on a broken page
{
  reset();
  const made = await A("create", LIST, "--edit=link");
  const pk = pubOf(made.id);
  const hash = indexOf(net.relays[0], pk);
  net.servers[1].blobs.delete(hash);
  const d = await run(["doctor", made.id]);
  t("doctor without --fix lists what is missing and changes nothing", d.json?.blobs?.some((b) => b.path === "/index.html" && b.ok === 2) && onServers(hash) === 2, d.json);
  const fx = await A("doctor", made.id, "--fix");
  t("doctor --fix copies the page to the server that lost it", onServers(hash) === 3 && fx.after?.ok, fx);
  for (const s of net.servers) s.blobs.delete(hash);
  const v = await run(["verify", made.id]);
  t("verify says broken and exits 1 when the page is on no server", v.code === 1 && v.json?.health === "broken", v.json || v.err);
  t("the gateway answers 502 then, as nsite.lol does", (await gw(made)).status === 502);
  const st = await A("status", made.id);
  t("status says so too", st.health === "broken", st);
  const fx2 = await A("doctor", made.id, "--fix");
  t("doctor --fix publishes again the last version read here", fx2.after?.ok && (await gw(made)).status === 200, fx2);
  const all = await run(["verify"]);
  t("verify over everything is read-only and answers for each", Array.isArray(all.json?.artifacts) && all.json.artifacts.length >= 1, all.err);
}

// --------------------------------------------- B6: comments do not hide a change
{
  reset();
  const made = await A("create", LIST, "--edit=link");
  const f = join(S, "b6.html");
  await A("read", made.id, "--as=html", "--out=" + f);
  // Somebody else edits the page: another home with the page adopted from its link.
  const other = { NSITE_ARTIFACTS_HOME: S + "/other" };
  const links = await A("links", made.id);
  const ad = (await run(["adopt", links.editLink], other)).json;
  t("adopt takes a page into another ledger from its edit link", ad?.adopted === true && ad.id === made.id, ad);
  const g = join(S, "b6-other.html");
  await run(["read", made.id, "--as=html", "--out=" + g], other);
  writeFileSync(g, readFileSync(g, "utf8").replace("Two", "Two, changed by someone else"));
  const theirs = (await run(["update", made.id, g], other)).json;
  t("the other ledger can update it", theirs?.verified, theirs);
  const c = await A("comments", made.id);
  t("comments mentions that the page changed", c.pageChanged === true, c);
  const d = await A("diff", made.id);
  t("diff shows the change", d.changed === true && JSON.stringify(d.changes).includes("someone else"), d);
  writeFileSync(f, readFileSync(f, "utf8").replace("One", "One, the agent's change"));
  const up = await run(["update", made.id, f]);
  t("an update from the file read before that change is refused, after comments and diff", up.code === 1 && /changed after you last read it into this file/.test(up.err), up.err);
  const rd = await A("read", made.id);
  t("and read still reports the change", rd.changed === true && JSON.stringify(rd.changes).includes("someone else"), rd);
  const ex = join(S, "export.json");
  const e = await A("export", made.id, "--out=" + ex);
  t("export writes the entry to a file only its owner can read", e.file === ex && (statSync(ex).mode & 0o777) === 0o600 && !JSON.stringify(e).includes(ledger().artifacts[made.id].secret), e);
  const im = (await run(["import", ex], { NSITE_ARTIFACTS_HOME: S + "/third" })).json;
  t("import takes it into another ledger", im?.added?.includes(made.id), im);
}

// --------------------------------------------- comments: $ in a reply
{
  reset();
  const html = page(`<h1>Notes</h1><p editable>Buy <mark nc:c="abc123">milk</mark> today.</p>` +
    `<aside nc:comments hidden><article nc:comment="abc123" nc:state="open" nc:by="Jana" nc:at="2026-11-17T10:00:00.000Z"><blockquote>milk</blockquote><p nc:text>Oat milk?</p></article></aside>`);
  const made = await A("create", file("c.html", html), "--edit=link");
  const text = "That is $$5, and $& and $` and $' stay as typed.";
  const r = await A("reply", made.id, "abc123", "--text=" + text, "--resolve", "--by=Agent");
  t("a reply reports how it landed", r.state === "resolved" && r.verified === true, r);
  const c = await A("comments", made.id, "--all");
  t("dollar signs in a reply are kept exactly", c.comments?.[0]?.replies?.[0]?.text === text, c.comments?.[0]?.replies);
  t("and do not copy the page into itself", ((await A("read", made.id, "--as=html", "--peek")).html.match(/nc:comment="abc123"/g) || []).length === 1);
}

// --------------------------------------------- B5: share on a read-only page
{
  reset();
  const made = await A("create", LIST, "--edit=none");
  const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));
  const s = await A("share", made.id, "--member=" + npub);
  t("--member on a page nobody may edit gives read access only", s.members?.[0]?.role === "read" && (s.warnings || []).some((w) => /read it only/.test(w)) && s.verified, s);
}

// --------------------------------------------- B13, B14: what goes into a page
{
  reset();
  const tricky = page(`<h1 editable="single-line">Mine</h1>`, ` NC:OWNER='npub1fake' nc:relays=wss://evil.example nc:servers="https://evil.example"`);
  const made = await A("create", file("tricky.html", tricky), "--edit=link");
  const html = (await A("read", made.id, "--as=html", "--peek")).html || "";
  const tag = /<html\b[^>]*>/i.exec(html)?.[0] || "";
  t("the tool's own attributes replace the file's, in any case or quoting", tag.startsWith(`<html nc:owner="${ledger().artifacts[made.id].npub}"`) && !/npub1fake|evil\.example/i.test(tag), tag);
  const big = file("big.html", page(`<h1 editable>Big</h1><p>${"x".repeat(3_200_000)}</p>`));
  const f = join(S, "tricky-cur.html");
  await A("read", made.id, "--as=html", "--out=" + f);
  writeFileSync(big, readFileSync(f, "utf8").replace("</body>", `<p>${"x".repeat(3_200_000)}</p></body>`));
  const r = await run(["update", made.id, big]);
  t("update refuses a page over 3 MB", r.code === 1 && /under 3 MB/.test(r.err), r.err);
  writeFileSync(big, readFileSync(f, "utf8").replace("</head>", `<script src="https://cdn.example.com/x.js"></script></head>`));
  const r2 = await run(["update", made.id, big]);
  t("and an encrypted page that starts loading from another site", r2.code === 1 && /loads from https:\/\/cdn\.example\.com/.test(r2.err), r2.err);
}

// --------------------------------------------- B12: ids
{
  const home = S + "/ids";
  mkdirSync(home, { recursive: true });
  const fake = (id) => ({ id, pubkey: id.repeat(8), npub: "npub1x", title: id, url: `http://${id}.localhost/`, relays: [], servers: [] });
  writeFileSync(join(home, "ledger.json"), JSON.stringify({ v: 1, artifacts: { abcd1111: fake("abcd1111"), abcd2222: fake("abcd2222") } }));
  const amb = await run(["links", "abcd"], { NSITE_ARTIFACTS_HOME: home });
  t("an id prefix that fits two artifacts is refused, naming both", amb.code === 1 && /matches 2 artifacts/.test(amb.err) && /abcd1111/.test(amb.err) && /abcd2222/.test(amb.err), amb.err);
  const short = await run(["delete", "ab"], { NSITE_ARTIFACTS_HOME: home });
  t("a prefix shorter than 4 characters is refused", short.code === 1 && /too short/.test(short.err), short.err);
  writeFileSync(join(home, "ledger.json"), "{ not json");
  const broken = await run(["list"], { NSITE_ARTIFACTS_HOME: home });
  t("a damaged ledger is never treated as an empty one", broken.code === 1 && /damaged/.test(broken.err), broken.err);
}

// --------------------------------------------- a key in an error
{
  const bogus = "nsec1" + "q".repeat(40) + "garbage";
  const r = await run(["create", LIST, "--edit=link"], { NSITE_ARTIFACTS_UPLOADER: bogus });
  t("a mistyped uploader key is reported without the key", r.code === 1 && /not a valid nsec/.test(r.err) && !r.err.includes(bogus.slice(5, 30)), r.err);
  t("and that failed create leaves nothing behind", !Object.values(ledger().artifacts).some((a) => a.state === "pending"));
}

// --------------------------------------------- B4: killed between publish and ledger
{
  reset();
  const r = await run(["create", LIST, "--edit=link"], { NSITE_ARTIFACTS_TEST_EXIT: "after-publish" });
  const pending = Object.values(ledger().artifacts).filter((a) => a.state === "pending");
  t("a create killed after its manifest went out has its key in the ledger already", r.code === 9 && pending.length === 1 && pending[0].secret && pending[0].blobs.length === 1, { code: r.code, pending });
  const pk = pending[0]?.pubkey, hash = pending[0]?.blobs[0];
  t("the page it published is live", indexOf(net.relays[0], pk) === hash);
  const young = await A("sweep");
  t("sweep leaves a pending page alone while it is young", ledger().artifacts[pending[0].id].state === "pending", young);
  const sw = await run(["sweep"], { NSITE_ARTIFACTS_PENDING_AFTER: "0" });
  const e = ledger().artifacts[pending[0].id];
  t("and later takes it down, since its link was never handed out", e.deleted && /never finished/.test(e.deletedBy) && !indexOf(net.relays[0], pk) && onServers(hash) === 0, { e, sw: sw.json });
}

// --------------------------------------------- B3: runs that overlap
{
  reset();
  // Something for sweep to do while creates run: an expired page.
  const old = await A("create", LIST, "--edit=link", "--expires=2020-01-01");
  const runs = [run(["sweep"]), run(["create", LIST, "--edit=link"]), run(["create", LIST, "--edit=link"]), run(["create", LIST, "--edit=link"]), run(["status"])];
  const res = await Promise.all(runs);
  const made = res.slice(1, 4).map((r) => r.json?.id);
  const l = ledger();
  t("three creates during a sweep all keep their keys", made.every((id) => id && l.artifacts[id]?.secret && l.artifacts[id].state === "live"), res.map((r) => r.err || r.json?.id));
  t("and the sweep did its own work", l.artifacts[old.id]?.deleted, l.artifacts[old.id]);
  t("no lock or temporary ledger file is left", !existsSync(join(S, "home", "ledger.json.lock")) && !readdirSync(join(S, "home")).some((f) => f.endsWith(".tmp")), readdirSync(join(S, "home")));
}

// --------------------------------------------- B7: delete with a relay that drops it
{
  reset();
  const made = await A("create", LIST, "--edit=link");
  const pk = pubOf(made.id);
  net.relays[1].drop = true;
  const d = await A("delete", made.id, "--replaced-by=" + globalThis.first.id);
  t("delete says which relay still names the page, and keeps the key", d.keyKept === true && (d.relays?.stillNaming || []).includes(net.relays[1].url), d);
  t("it records who deleted it and what replaced it", ledger().artifacts[made.id].deletedBy === "cli" && ledger().artifacts[made.id].replacedBy === globalThis.first.id);
  const v = await run(["verify", made.id]);
  t("verify on a deleted page says when, and that a relay still names it", v.code === 1 && v.json?.deleted && (v.json.lingering || []).length === 1, v.json || v.err);
  net.relays[1].drop = false;
  const sw = await A("sweep");
  t("a later sweep finishes it and only then drops the key", !ledger().artifacts[made.id].secret && !indexOf(net.relays[1], pk), sw);
  const log = readFileSync(join(S, "home", "log.jsonl"), "utf8");
  t("the log records the delete and holds no key", /"cmd":"delete"/.test(log) && !Object.values(ledger().artifacts).some((a) => a.secret && log.includes(a.secret)));
  const st = await A("status", made.id);
  t("status on it names the replacement", st.replacedBy === globalThis.first.id, st);
}

// --------------------------------------------- B15: rekey keeps the settings
{
  reset();
  const html = page(`<h1 editable="single-line">Pic</h1><img src="https://img.example.com/a.png" alt="">`);
  const made = await A("create", file("pic.html", html), "--edit=link", "--no-comments", "--shell-title=Our trip", "--allow-origin=https://img.example.com");
  t("a page with an allowed origin is made", made.verified, made);
  // Saved by somebody else: rekey wants it read first.
  const links = await A("links", made.id);
  const other = { NSITE_ARTIFACTS_HOME: S + "/rk" };
  await run(["adopt", links.editLink], other);
  const g = join(S, "rk.html");
  await run(["read", made.id, "--as=html", "--out=" + g], other);
  writeFileSync(g, readFileSync(g, "utf8").replace("Pic", "Picture"));
  await run(["update", made.id, g], other);
  const refused = await run(["rekey", made.id]);
  t("rekey refuses while there is an unread change", refused.code === 1 && /read/.test(refused.err), refused.err);
  await A("read", made.id);
  const rk = await A("rekey", made.id);
  const nu = ledger().artifacts[rk.id];
  t("rekey moves it to a new key", rk.id && rk.id !== made.id && rk.replaces === made.id, rk);
  t("with comments off, its shell title and its allowed origin", nu && nu.comments === false && nu.shellTitle === "Our trip" && (nu.allow || []).includes("https://img.example.com"), nu);
  t("and the old one is deleted, naming its replacement", ledger().artifacts[made.id].deleted && ledger().artifacts[made.id].replacedBy === rk.id);
  const rd = await A("read", rk.id);
  t("the new page has the change that was read", /Picture/.test(rd.text || ""), rd);
}

// --------------------------------------------- the browser's retired versions
{
  reset();
  // A page saved from a browser names what it replaced in its manifest; the
  // tool's sweep finishes the job when the time comes.
  const made = await A("create", LIST, "--edit=link");
  const pk = pubOf(made.id);
  const f = join(S, "br.html");
  await A("read", made.id, "--as=html", "--out=" + f);
  await A("update", made.id, f, "--force");
  const m = net.relays[0].manifestOf(pk);
  const named = m.tags.filter((x) => x[0] === "retired").map((x) => x[1]);
  t("the manifest names the retired version, so a browser save carries it on", named.length === 1 && onServers(named[0]) === 3, m.tags);
  // Forget it in the ledger: only the manifest knows now, as after a browser save.
  const l = ledger(); l.artifacts[made.id].retired = []; writeFileSync(join(S, "home", "ledger.json"), JSON.stringify(l));
  await run(["sweep"], { NSITE_ARTIFACTS_RETIRE_AFTER: "0" });
  t("sweep deletes a version only the manifest names", onServers(named[0]) === 0, net.servers.map((s) => s.blobs.has(named[0])));
}

// --------------------------------------------- two rows with the same words
{
  reset();
  await run(["list-page", "--title=Twice", "--item=Milk", "--item=Milk", "--item=Bread", "--out=" + join(S, "twice.html")]);
  const made = await A("create", join(S, "twice.html"), "--edit=link");
  const f = join(S, "twice-cur.html");
  await A("read", made.id, "--as=html", "--out=" + f);
  const html = readFileSync(f, "utf8");
  const at = html.lastIndexOf('<input type="checkbox" aria-label="Done">', html.indexOf(">Milk<", html.indexOf(">Milk<") + 1));
  writeFileSync(f, html.slice(0, at) + '<input type="checkbox" aria-label="Done" checked>' + html.slice(at + '<input type="checkbox" aria-label="Done">'.length));
  const other = { NSITE_ARTIFACTS_HOME: S + "/twice-other" };
  await run(["adopt", (await A("links", made.id)).editLink], other);
  await run(["update", made.id, f, "--force"], other);
  const rd = await A("read", made.id);
  t("ticking the second of two equal rows is one change, not an add and a remove", JSON.stringify(rd.changes) === JSON.stringify([{ change: "checked", line: "Milk" }]), rd.changes);
}

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
