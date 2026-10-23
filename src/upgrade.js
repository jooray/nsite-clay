// Moving a published site to a newer runtime.
//
// A page published today hardcodes the URLs of the three shared files it runs
// on, and a gateway serves those with a cache lifetime, so the deployed copy is
// pinned to the engine it was deployed with. That is the right default -- a
// site that silently changed under its owner would not be theirs -- but it
// leaves no way to take a fix, and the whole point of a file that edits itself
// is that it does not need anybody's build server to change.
//
// So the runtime upgrades the same way everything else here moves: over Nostr.
// The project publishes its own nsite; that manifest is a signed event naming
// content-addressed blobs; fetchVerified re-hashes whatever a Blossom server
// returns before believing a byte of it. A server therefore cannot lie, and the
// only thing being trusted is the key the page names in `nc:runtime-owner` --
// the same key its owner trusted when they published from it. It is never
// automatic: an owner is shown what changed and presses the button.
//
// What this does not do is rewrite the document. The template's stylesheet, its
// <template nc:block> library and its toolbar buttons are the author's page, not
// the runtime's, and an upgrade that edited somebody's markup would be a
// different and much worse promise. The engine changes; the page stays put.
//
// A site is usually more than one page, all of them named in the one manifest
// and all pointing at the same stamped engine. So an upgrade taken on any page
// moves every page of the site: it reads each sibling document the manifest
// names, changes the attribute values that name a moved file and not one other
// byte, and publishes all of them in the same manifest. An old name is retired
// only once no page loads it any more.
import { verifyEvent } from "nostr-tools";
import { manifestPaths, manifestServers } from "./manifest.js";
import { readConfig } from "./config.js";
import { fetchVerified, has, hashBytes, signUploads, uploadAll } from "./blossom.js";
import { modal, toast } from "./ui.js";

// The shared files every template names from the site root. The last is not a
// script tag but the file nc:source points at: the serialiser is a third of the
// runtime and is fetched only when a page is edited, so it is named in an
// attribute rather than loaded by the document.
const SHARED = [
  { canonical: "/nsite-clay.js", type: "text/javascript" },
  { canonical: "/nsite-clay-base.css", type: "text/css" },
  { canonical: "/nsite-clay-chrome.js", type: "text/javascript" },
  { canonical: "/nsite-clay-source.js", type: "text/javascript", attribute: "nc:source" },
];

// Where the human-readable half of the offer comes from. The hashes never do:
// those are read out of the signed manifest, so a notes file cannot talk a page
// into installing something the key did not publish.
const NOTES = "/runtime.json";

// A deployed document points at content-stamped copies -- /nsite-clay-1f3a9c02.js
// rather than /nsite-clay.js -- because a new build has to be a new URL for a
// cache to notice it. Zero or more stamps: a file that has been through both the
// CLI and the web publisher wears two.
const STAMPED = /^(.*?)((?:-[0-9a-f]{8})*)(\.[a-z]+)$/;

// Where this browser writes down what it has already installed. A gateway can
// go on handing out the copy of the page it already has for minutes after the
// manifest names a newer one, and that copy still points at the old engine, so
// without this the page offers the very update the person has just applied and
// there is no way for them to tell that anything worked.
const APPLIED = "nsite-clay.upgraded";

// A site's documents, as the manifest names them. Anything else in the table is
// a picture, a font or a file somebody linked, and an upgrade has no business
// with it.
const PAGE = /\.html?$/i;

// How many other pages one upgrade will read. Each is a Blossom fetch and, when
// it changes, an upload a phone signer has to approve, so a site past this is
// better redeployed with the CLI. The pages past it are left exactly as they
// are, and so is every file they may load.
export const MAX_PAGES = 200;

// The attributes a reference to a shared file sits in, and so the only places
// a sibling's bytes are ever changed.
const REF_ATTRS = ["src", "href", "nc:source"];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Elements whose content is text rather than markup. A tag written inside a
// script or a textarea is not a tag, so only the opening tag is looked at.
const RAW_TEXT = "script|style|textarea|title|xmp|iframe|noembed|noframes";
const TAG = `<[a-zA-Z](?:"[^"]*"|'[^']*'|[^'">])*>`;
const TOKENS = new RegExp(
  `<!--[\\s\\S]*?(?:-->|$)|<(${RAW_TEXT})\\b(?:"[^"]*"|'[^']*'|[^'">])*>[\\s\\S]*?(?:<\\/\\1\\s*>|$)|${TAG}`, "gi");
const OPENING = new RegExp("^" + TAG);

/**
 * Repoint references to moved files, and change nothing else.
 *
 * `moves` maps an exact old path to its new one. What is replaced is the value
 * of a src, href or nc:source attribute, inside a real tag, that is exactly an
 * old path, with any query or fragment after it kept as it was. Prose,
 * comments, code samples and script bodies naming the same file are text, not
 * references, and come back byte for byte. Nothing is reserialised: the page
 * goes out with its owner's own whitespace, quoting and entities.
 */
export function retarget(html, moves) {
  if (!moves.size) return html;
  const names = REF_ATTRS.map(escapeRe).join("|");
  const froms = [...moves.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const ATTR = new RegExp(
    `(\\s(?:${names})\\s*=\\s*)(?:"(${froms})([?#][^"]*)?"|'(${froms})([?#][^']*)?'|(${froms})([?#][^\\s"'=<>\`]*)?(?=[\\s>]|$))`,
    "gi");
  const inTag = (tag) => tag.replace(ATTR, (m, lead, dq, dqRest, sq, sqRest, bare, bareRest) => {
    const from = dq ?? sq ?? bare;
    // Case-blind so that SRC= is found; the path itself has to match exactly.
    if (!moves.has(from)) return m;
    const to = moves.get(from);
    if (dq !== undefined) return `${lead}"${to}${dqRest || ""}"`;
    if (sq !== undefined) return `${lead}'${to}${sqRest || ""}'`;
    return `${lead}${to}${bareRest || ""}`;
  });
  return html.replace(TOKENS, (token, raw) => {
    if (token.startsWith("<!--")) return token;
    if (!raw) return inTag(token);
    const open = OPENING.exec(token)?.[0] || "";
    return inTag(open) + token.slice(open.length);
  });
}

// A few at a time: enough that a ten-page site does not read its pages one
// after another, few enough that a big one does not open fifty connections to
// somebody's Blossom server at once.
async function eachLimited(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

// "a and b", "a, b and c". Two file names read as a sentence, not as a list.
function andList(items) {
  if (items.length < 2) return items[0] || "";
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

export function unstamp(path) {
  const m = STAMPED.exec(path);
  return m ? m[1] + m[3] : path;
}

export function stamp(path, hash) {
  const m = STAMPED.exec(unstamp(path));
  return m ? `${m[1]}-${hash.slice(0, 8)}${m[3]}` : path;
}

export class Upgrade {
  constructor(nc) {
    this.nc = nc;
    this.doc = nc.doc;
    this._asked = false;
  }

  // ---- reading the document -----------------------------------------------

  // Every reference this page makes to one of the shared files, with the
  // canonical name its stamp was made from. Also asked of a sibling page read
  // out of the manifest, and there a missing nc:source means nothing at all: a
  // page that never named the serialiser is not pointed at one by an upgrade
  // taken somewhere else.
  refs(doc = this.doc, { assumeSource = true } = {}) {
    const out = [];
    for (const el of doc.querySelectorAll("script[src], link[href]")) {
      const attr = el.tagName === "SCRIPT" ? "src" : "href";
      const url = el.getAttribute(attr) || "";
      if (!url.startsWith("/") || url.startsWith("//")) continue;
      const path = url.split(/[?#]/)[0];
      const kind = SHARED.find((s) => s.canonical === unstamp(path));
      if (kind && !kind.attribute) out.push({ el, attr, path, ...kind });
    }
    // Files named by an attribute rather than by a tag. A page published before
    // the serialiser was split out names none, and saying so with the canonical
    // path is what lets this upgrade install it and point the page at it, rather
    // than leaving that page on full serialisation for ever.
    for (const kind of SHARED.filter((s) => s.attribute)) {
      const declared = doc.documentElement.getAttribute(kind.attribute) || "";
      const named = declared.startsWith("/") && !declared.startsWith("//");
      if (!named && !assumeSource) continue;
      const path = named ? declared.split(/[?#]/)[0] : kind.canonical;
      out.push({ el: doc.documentElement, attr: kind.attribute, path, ...kind });
    }
    return out;
  }

  // The other documents of this site, by path. This page is not among them: it
  // is saved from the live DOM, unsaved edits and all.
  _siblings(table) {
    return Object.keys(table).filter((p) => PAGE.test(p) && p !== this.nc.cfg.path).sort();
  }

  // ---- reading the other key's site ---------------------------------------

  async source() {
    const owner = this.nc.cfg.runtimeOwner;
    if (!owner) return null;
    const ev = await this.nc.manifestOf(owner, "");
    if (!ev || !verifyEvent(ev)) return null;
    return {
      paths: manifestPaths(ev),
      // Its servers first, then ours: the blob is the same either way, and
      // whichever answers first with the right bytes wins.
      servers: [...new Set([...manifestServers(ev), ...this.nc.cfg.servers])],
    };
  }

  // A plan, or null when there is nothing to do. Comparison is by hash rather
  // than by version: the version is what a person reads, the hash is what
  // decides, and a page whose stylesheet is current but whose engine is not
  // should be offered the engine alone.
  async check() {
    const src = await this.source();
    if (!src) return null;

    let notes = null;
    if (src.paths[NOTES]) {
      try { notes = JSON.parse(await fetchVerified(src.servers, src.paths[NOTES])); } catch { /* the offer works without it */ }
    }

    const mine = await this.nc._currentPaths();
    // Everything the runtime key publishes, whether or not this page names it:
    // a sibling can be behind on a file this page already has.
    const want = {};
    for (const s of SHARED) if (src.paths[s.canonical]) want[s.canonical] = src.paths[s.canonical];
    const files = [];
    for (const ref of this.refs()) {
      const want = src.paths[ref.canonical];
      if (!want) continue;                       // that key does not publish this one
      if (mine[ref.path] === want) continue;     // we already serve those bytes
      files.push({ ...ref, hash: want });
    }
    if (!files.length) { this._forget(); return null; }

    return {
      running: this.nc.version,
      version: notes?.version || null,
      released: notes?.released || null,
      notes: Array.isArray(notes?.notes) ? notes.notes : [],
      files,
      want,
      // Counted from the table, so the offer can say what it will touch without
      // reading every page first. A page that does not run nsite-clay is in the
      // count and is left alone.
      pages: 1 + this._siblings(mine).length,
      servers: src.servers,
      // True when every file this plan would install is one this browser has
      // already installed on this site. Then the site is current and the
      // document in front of us is a stale copy, which is a different thing to
      // say and a different thing to do about it.
      stale: this._alreadyApplied(files),
    };
  }

  // ---- what this browser has already done ----------------------------------

  _key(path = this.nc.cfg.path) {
    const c = this.nc.cfg;
    return `${APPLIED}:${c.owner || ""}:${c.site || ""}:${path || ""}`;
  }

  // Kept for a day. Past that, a plan naming the same hashes is more likely to
  // mean the owner restored an older version and wants the update again than a
  // gateway still sitting on a copy from yesterday.
  _applied() {
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(this._key()) || "null"); } catch { /* private mode */ }
    if (!rec || !rec.hashes || Date.now() - rec.at > 24 * 3600 * 1000) return null;
    return rec;
  }

  // Written for every page the upgrade moved, not only this one: a sibling
  // opened a minute later can come out of a gateway's cache just the same, and
  // should say so rather than offer the update a second time. All pages of a
  // site share one origin, so they share this storage.
  _remember(plan, paths = [this.nc.cfg.path]) {
    const hashes = { ...(plan.want || {}) };
    for (const f of plan.files) hashes[f.canonical] = f.hash;
    const rec = JSON.stringify({ at: Date.now(), version: plan.version, hashes });
    for (const path of paths) {
      try { localStorage.setItem(this._key(path), rec); }
      catch { /* nothing is lost but the reminder */ }
    }
  }

  _forget() {
    try { localStorage.removeItem(this._key()); } catch { /* nothing to clear */ }
  }

  _alreadyApplied(files) {
    const rec = this._applied();
    return !!rec && files.every((f) => rec.hashes[f.canonical] === f.hash);
  }

  // ---- doing it ------------------------------------------------------------

  // One sibling document, read from Blossom by the hash the manifest names.
  //
  // `state` is what the upgrade may do with it: "ours" is an nsite-clay page of
  // this owner's site on this runtime key and is moved with this one; "none"
  // loads none of the shared files and is left alone; "foreign" runs nsite-clay
  // for somebody else, or from another runtime key, or with upgrades off, and is
  // not ours to rewrite; "unread" could not be fetched or decoded, so nothing is
  // known about what it loads.
  async _readPage(path, hash, servers) {
    const page = { path, hash, state: "unread", refs: [], moves: new Map() };
    let bytes;
    try { bytes = await fetchVerified(servers, hash, { as: "bytes" }); } catch { return page; }
    // Fatal, and keeping a byte order mark: a page is only rewritten when its
    // text turns back into exactly the bytes it came from.
    try { page.text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return page; }
    const doc = new DOMParser().parseFromString(page.text, "text/html");
    page.refs = this.refs(doc, { assumeSource: false });
    if (!page.refs.length) { page.state = "none"; return page; }
    const theirs = readConfig(doc), ours = this.nc.cfg;
    page.state = theirs.owner === ours.owner && theirs.site === ours.site &&
      !!theirs.runtimeOwner && theirs.runtimeOwner === ours.runtimeOwner ? "ours" : "foreign";
    return page;
  }

  // Fetch, store on the owner's own Blossom servers, repoint every page of the
  // site, and publish one manifest carrying all of it. After this the site is
  // still served entirely from where its owner put it; nothing of ours is in
  // the path.
  //
  // This page is saved from the live document, as any save is. Every other page
  // is read from Blossom, has the attribute values that name a moved file
  // changed and nothing else, and goes into the same manifest. A page that
  // cannot be read or rewritten is left as it was, and then no old file is
  // retired, because nothing says that page does not still load it.
  async apply(plan, onProgress = () => {}) {
    if (!this.nc.isOwner) throw new Error("Only the site owner can change this page");
    const cfg = this.nc.cfg;
    const want = plan.want || Object.fromEntries(plan.files.map((f) => [f.canonical, f.hash]));
    const table = await this.nc._currentPaths();
    const siteServers = [...new Set([...cfg.servers,
      ...(this.nc._manifest ? manifestServers(this.nc._manifest) : [])])];

    // Where one reference goes, or null when it already loads the newer bytes.
    // A page that links the plain name keeps the plain name -- the blob behind
    // it simply changes. Only a stamped reference has to move, because its
    // whole purpose is to be a URL a cache has never seen.
    const target = (ref) => {
      const hash = want[ref.canonical];
      if (!hash || table[ref.path] === hash) return null;
      return { hash, to: ref.path === ref.canonical ? ref.path : stamp(ref.canonical, hash) };
    };

    // ---- read the other pages
    const others = this._siblings(table);
    const reading = others.slice(0, MAX_PAGES);
    const pages = others.slice(MAX_PAGES).map((path) => ({ path, hash: table[path], state: "unread", refs: [], moves: new Map() }));
    let read = 0;
    await eachLimited(reading, 4, async (path) => {
      onProgress({ stage: "read", path, done: read, total: reading.length });
      pages.push(await this._readPage(path, table[path], siteServers));
      read++;
    });
    pages.sort((a, b) => (a.path < b.path ? -1 : 1));

    // ---- work out every move, on this page and on the others
    const files = new Map();          // canonical -> hash being installed
    const extraPaths = {};
    const retire = new Set();         // old names something moved off
    const own = [];
    const note = (ref, m) => {
      files.set(ref.canonical, m.hash);
      extraPaths[m.to] = m.hash;
      if (m.to !== ref.path) retire.add(ref.path);
    };
    for (const ref of this.refs()) {
      const m = target(ref);
      if (!m) continue;
      note(ref, m);
      if (m.to !== ref.path) own.push({ ref, to: m.to, was: ref.el.getAttribute(ref.attr) });
    }
    for (const page of pages) {
      if (page.state !== "ours") continue;
      for (const ref of page.refs) {
        const m = target(ref);
        if (!m) continue;
        note(ref, m);
        page.touched = true;
        if (m.to !== ref.path) page.moves.set(ref.path, m.to);
      }
      // Only plain names: the table change is the whole of it.
      if (page.touched && !page.moves.size) page.state = "moved";
    }

    // ---- the shared files themselves
    let done = 0;
    for (const [canonical, hash] of files) {
      onProgress({ stage: "file", path: canonical, done, total: files.size });
      const bytes = await fetchVerified(plan.servers, hash, { as: "bytes" });
      await uploadAll(cfg.servers, bytes, {
        signer: this.nc.signer, type: SHARED.find((s) => s.canonical === canonical).type, check: true,
      });
      done++;
    }

    // ---- the other pages, rewritten
    const enc = new TextEncoder();
    const rewritten = [];
    for (const page of pages) {
      if (page.state !== "ours" || !page.moves.size) continue;
      const text = retarget(page.text, page.moves);
      // Read back what came out. Every reference has to be where it was sent and
      // nothing else may have moved; a page this cannot be sure of keeps its
      // own bytes, and the files it loads stay with it.
      const back = this.refs(new DOMParser().parseFromString(text, "text/html"), { assumeSource: false });
      const expected = page.refs.map((r) => page.moves.get(r.path) || r.path);
      if (back.length !== expected.length || back.some((r, i) => r.path !== expected[i])) {
        page.state = "unwritten";
        continue;
      }
      page.bytes = enc.encode(text);
      page.next = hashBytes(page.bytes);
      rewritten.push(page);
    }
    const expect = {};
    if (rewritten.length) {
      // Asked first and signed in one burst, as a publish does, so a phone signer
      // approves exactly the uploads that happen and all of them at once.
      const present = await Promise.all(rewritten.map((p) =>
        Promise.all(cfg.servers.map((s) => has(s, p.next, p.bytes.length)))));
      const needed = rewritten.filter((_, i) => present[i].some((x) => !x)).map((p) => p.next);
      const signed = needed.length ? await signUploads(this.nc.signer, needed) : new Map();
      done = 0;
      for (const [i, page] of rewritten.entries()) {
        onProgress({ stage: "page", path: page.path, done, total: rewritten.length });
        try {
          await uploadAll(cfg.servers, page.bytes, {
            signer: this.nc.signer, type: "text/html", known: present[i], signed: signed.get(page.next),
          });
          extraPaths[page.path] = page.next;
          // Published only if that page is still what was read, so a save made
          // to it from another tab in the meantime is not overwritten.
          expect[page.path] = page.hash;
          page.state = "moved";
        } catch { page.state = "unwritten"; }
        done++;
      }
    }

    // ---- what can be retired
    //
    // Only a stamped name, only one this upgrade moved something off, and only
    // when every page of the site was read and none of them loads it any more.
    const dropPaths = [];
    if (!pages.some((p) => p.state === "unread")) {
      const loaded = new Set();
      const ownTo = new Map(own.map((o) => [o.ref.path, o.to]));
      for (const r of this.refs()) loaded.add(ownTo.get(r.path) || r.path);
      for (const p of pages) {
        for (const r of p.refs) loaded.add(p.state === "moved" ? p.moves.get(r.path) || r.path : r.path);
      }
      for (const p of retire) if (!loaded.has(p) && unstamp(p) !== p && p !== cfg.path) dropPaths.push(p);
    }
    const kept = pages.filter((p) => p.state === "unread" || p.state === "unwritten" ||
      (p.state === "foreign" && p.refs.some((r) => target(r)))).map((p) => p.path);

    onProgress({ stage: "manifest", path: "the manifest", done: 0, total: 1 });
    for (const { ref, to } of own) ref.el.setAttribute(ref.attr, to);
    let out;
    try {
      // report: false, because this save is not one the person made about their
      // own writing. A page with a link to a page they have not written yet would
      // otherwise answer "Update" with a panel about broken links, which is true,
      // unrelated, and not what they pressed.
      out = await this.nc.save({ extraPaths, dropPaths, expect, report: false });
    } catch (err) {
      // Nothing was published, so this page goes back to naming what the live
      // manifest still serves. Left moved, the next ordinary save would point it
      // at files the table has never heard of.
      for (const { ref, was } of own) {
        if (was === null) ref.el.removeAttribute(ref.attr); else ref.el.setAttribute(ref.attr, was);
      }
      throw err;
    }
    const moved = pages.filter((p) => p.state === "moved").map((p) => p.path);
    this._remember(plan, [cfg.path, ...moved]);
    return { ...out, files: files.size, pages: 1 + moved.length, kept, dropped: dropPaths };
  }

  // ---- the offer -----------------------------------------------------------

  async promptFor(plan) {
    let saved;
    const ok = await modal({
      doc: this.doc,
      title: plan.version ? `nsite-clay ${plan.version} is available` : "A newer runtime is available",
      hint: `This page runs ${plan.running}. Updating copies the newer files onto your own Blossom ` +
            `servers and republishes your manifest, so nothing of anybody else's ends up in the way.`,
      submitLabel: "Update",
      build: (body) => {
        // Release notes are prose. They went in the same boxed one-line list the
        // version history uses, which cut every one of them off mid-word and put
        // a sideways scrollbar under the lot. The thing the dialog exists to be
        // read has to be the thing that reads.
        if (plan.notes.length) {
          const l = this.doc.createElement("label");
          l.textContent = "What changed";
          const list = this.doc.createElement("ul");
          list.className = "nc-notes";
          for (const text of plan.notes.slice(0, 10)) {
            const li = this.doc.createElement("li");
            li.textContent = text;
            list.appendChild(li);
          }
          body.append(l, list);
        }
        // The file names were a second list of their own, which is a lot of
        // furniture for two paths nobody needs to act on. They belong in the
        // sentence that says what is about to happen.
        const note = this.doc.createElement("p");
        note.className = "nc-hint";
        note.style.margin = "1.2rem 0 0";
        const names = andList(plan.files.map((f) => f.canonical));
        const many = (plan.pages || 1) > 1;
        // Every page of a site loads the same files, so an update that moved one
        // page would leave the others pointing at a file that is gone. Saying it
        // is all of them is what the owner of a five-page site needs to hear
        // before pressing a button on one.
        note.textContent = many
          ? `This replaces ${names} and nothing else, on all ${plan.pages} pages of this site at ` +
            "once, so no page is left pointing at a file that is gone. The pages themselves are " +
            "untouched: their blocks, words and design stay as they are, and version history " +
            "keeps the old ones, so this is reversible."
          : `This replaces ${names} and nothing else. Your page is untouched: the blocks, the ` +
            "words and the design stay as they are, and version history keeps the old one, so " +
            "this is reversible.";
        if (plan.pages - 1 > MAX_PAGES) {
          note.textContent += ` Only the first ${MAX_PAGES} other pages are updated from here; ` +
            "the rest keep the runtime they have, and so do the files they load.";
        }
        body.appendChild(note);
      },
      onSubmit: async (h) => {
        saved = await this.apply(plan, ({ stage, path, done, total }) => {
          const n = `(${Math.min(done + 1, total)}/${total})`;
          h.status(stage === "read" ? `Reading the other pages of this site ${n}…`
            : stage === "manifest" ? "Publishing the manifest…"
            : `Updating ${path} ${n}…`);
        });
        return true;
      },
    });
    if (ok) {
      this.installed(plan, saved?.hash);
      // Said, and not buried: a page left behind still works, but it is on the
      // old runtime until it is fixed, and its owner should know which one.
      if (saved?.kept?.length) {
        toast(`${saved.kept.length === 1 ? "One page" : saved.kept.length + " pages"} could not be ` +
          `updated and kept the runtime ${saved.kept.length === 1 ? "it" : "they"} had, with every ` +
          `file ${saved.kept.length === 1 ? "it loads" : "they load"}: ${andList(saved.kept)}.`,
          { doc: this.doc, ms: 12000 });
      }
    }
    return ok;
  }

  // What the Settings dialog calls: check, then either offer or say there is
  // nothing to take. Says something either way, because a button that sometimes
  // does nothing visible reads as a broken button.
  async prompt() {
    if (!this.nc.cfg.runtimeOwner) {
      toast("This page is set not to look for runtime updates.", { doc: this.doc });
      return null;
    }
    let plan;
    try { plan = await this.check(); }
    catch (e) { toast(e.message || String(e), { doc: this.doc }); return null; }
    if (!plan) {
      toast(`This page is running the current runtime (${this.nc.version}).`, { doc: this.doc });
      return null;
    }
    if (plan.stale) {
      toast(`${plan.version ? "nsite-clay " + plan.version : "The update"} is already published on ` +
            `your site. This copy of the page is an older one; reload to pick it up.`,
            { doc: this.doc, ms: 6000 });
      return null;
    }
    return this.promptFor(plan);
  }

  // ---- the offer that comes to you ----------------------------------------

  // Checked once, when an owner opens the page for editing. A reader never
  // triggers it: they are not going to press the button, and the check is a
  // relay query made on their behalf that nobody asked for.
  start() {
    const look = () => {
      if (this._asked || !this.nc.isOwner || !this.nc.editRequested) return;
      if (!this.nc.cfg.runtimeOwner) return;
      this._asked = true;
      this.check().then((plan) => {
        if (!plan) return;
        plan.stale ? this.staleNotice(plan) : this.notice(plan);
      }).catch(() => {});
    };
    for (const ev of ["nsiteclay:login", "nsiteclay:edit-gate"]) this.nc.addEventListener(ev, look);
    look();
  }

  // Styled inline rather than from the stylesheet, because a page whose engine
  // is out of date has an out of date stylesheet too, and the one notice that
  // must be legible is this one.
  bar(message, actions) {
    const bar = this.doc.createElement("div");
    bar.setAttribute("nc:chrome", "");          // never reaches a save
    bar.setAttribute("role", "status");
    // Above a dialog rather than beside it: the update can be taken from inside
    // Settings, which stays open, and the bar that says what happened next has
    // to be the thing on top.
    bar.style.cssText = "position:fixed;z-index:2147483647;left:50%;top:1rem;" +
      "transform:translateX(-50%);display:flex;gap:.75rem;align-items:center;max-width:calc(100vw - 2rem);" +
      "font:14px/1.4 ui-sans-serif,system-ui,sans-serif;padding:.6rem .9rem;border-radius:10px;" +
      "background:#101418;color:#f4f6f7;box-shadow:0 8px 30px -10px rgba(0,0,0,.6)";
    const msg = this.doc.createElement("span");
    msg.textContent = message;
    bar.appendChild(msg);

    const btnCss = "font:inherit;cursor:pointer;border:1px solid #4a5560;background:#1c2329;" +
      "color:inherit;border-radius:7px;padding:.25rem .7rem;white-space:nowrap";
    actions.forEach(([label, fn], i) => {
      const b = this.doc.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = btnCss + (i === actions.length - 1 ? ";border-color:transparent" : "");
      b.onclick = () => fn(bar);
      bar.appendChild(b);
    });

    this.doc.body.appendChild(bar);
    return bar;
  }

  notice(plan) {
    return this.bar(
      plan.version
        ? `nsite-clay ${plan.version} is available. This page runs ${plan.running}.`
        : "A newer nsite-clay runtime is available for this page.",
      [
        ["See what changed", (bar) => { bar.remove(); this.promptFor(plan); }],
        ["Not now", (bar) => bar.remove()],
      ],
    );
  }

  /**
   * The update went through and this page is still running the old engine.
   *
   * It reloads itself, but not at once: the bytes have to reach a gateway
   * first, and a reload before they do hands back the copy being replaced. That
   * is what made this a button somebody pressed twice. So it waits for its own
   * address to serve what was just saved, and goes then.
   *
   * A reload does cost the sign-in, since no signer survives one, so it says so
   * and can be stopped. It is never done over unsaved work.
   */
  installed(plan, hash) {
    const name = plan.version ? "nsite-clay " + plan.version : "The newer runtime";
    if (!hash || this.nc.dirty) {
      return this.bar(`${name} is on your site. Reload the page to start running it.`, [
        ["Reload", () => this.nc.reloadToLatest(hash)],
        ["Later", (bar) => bar.remove()],
      ]);
    }
    const stop = new AbortController();
    const bar = this.bar(
      `${name} is on your site. This page will reload into it as soon as your gateway has it, ` +
      `and you can sign in again after that.`,
      [
        ["Reload now", () => this.nc.reloadToLatest(hash)],
        ["Stay on this page", (b) => { stop.abort(); b.remove(); }],
      ],
    );
    const line = bar.firstChild;
    this.nc.reloadWhenServed(hash, {
      signal: stop.signal,
      // A wait with nothing moving in it is the thing that reads as a freeze,
      // and this one is somebody else's cache, so it can be a minute.
      onStatus: ({ waited }) => {
        if (waited > 8) line.textContent = `${name} is on your site. Waiting for your gateway to serve it (${waited}s).`;
      },
    }).then((reloaded) => {
      if (reloaded || stop.signal.aborted) return;
      line.textContent = `${name} is on your site, but your gateway is still serving the old copy. ` +
        `Reload whenever you like; it will arrive.`;
    }).catch(() => {});
    return bar;
  }

  // Same button, different reason: this browser has already published the
  // update, and what came back is a copy of the page from before it. Only a
  // gateway can do that, and only for as long as it holds what it cached, so
  // the honest thing is to say so rather than offer the update a second time.
  staleNotice(plan) {
    return this.bar(
      `${plan.version ? "nsite-clay " + plan.version : "The newer runtime"} is already published on ` +
      `your site. This is an older copy of the page; a gateway can serve one for a few minutes.`,
      [
        ["Reload", () => this.nc.reloadToLatest()],
        ["Not now", (bar) => bar.remove()],
      ],
    );
  }
}
