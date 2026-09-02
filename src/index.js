// nsite-clay runtime.
//
// A single HTML file that edits and republishes itself. The document holds the
// interface, the behaviour, the content and the state; a save serialises the
// whole DOM, pushes those bytes to Blossom as one content-addressed blob, and
// republishes the NIP-5A nsite manifest that points at it.
//
// There is no backend. The relays hold the manifest, the Blossom servers hold
// the bytes, and the browser does everything in between.
import { SimplePool, verifyEvent, nip19 } from "nostr-tools";
import { readConfig, siteAddress, siteKind, toHex } from "./config.js";
import { LocalSigner, Nip07Signer, Nip46Signer } from "./signer.js";
import { fetchVerified, has, hashBytes, hashText, signUploads, uploadAll } from "./blossom.js";
import { aggregateHash, buildManifest, buildSnapshot, manifestPaths, manifestServers } from "./manifest.js";
import { snapshot } from "./snapshot.js";
import { sanitize, sanitizeAs } from "./sanitize.js";
import { Editable } from "./editable.js";
import { Media, parseVideoUrl } from "./media.js";
import { Feed, readFeedConfig, postUrl, addressOf } from "./feed.js";
import { Compose } from "./compose.js";
import { Settings } from "./settings.js";
import { Dom, State } from "./dom.js";
import { Cms } from "./cms.js";
import { Blocks } from "./blocks.js";
import { Upgrade, stamp, unstamp } from "./upgrade.js";
import { qrSvg, qrElement } from "./qr.js";
import { toast, notice, field, modal, checkbox } from "./ui.js";

const STORAGE = "nsite-clay.session";

// The two files a page needs in order to still be editable after the save.
const ENGINE = new Set(["/nsite-clay.js", "/nsite-clay-chrome.js"]);

// Stamped in by build.mjs. Reading src/ directly is allowed by the package, and
// an honest "unknown" beats a crash when nobody ran the build.
export const VERSION = typeof __NC_VERSION__ === "string" ? __NC_VERSION__ : "0.0.0-src";

// A publish succeeds the moment one relay accepts it -- waiting for the whole
// set would add every dead relay's full timeout to every save. Only when all of
// them have refused is it an error, and then it names them, because
// Promise.any's AggregateError says nothing useful.
function publishToAny(pool, relays, event) {
  const sent = pool.publish(relays, event);
  if (!sent.length) return Promise.reject(new Error("No relays configured"));
  return new Promise((resolve, reject) => {
    const errors = [];
    let pending = sent.length;
    sent.forEach((p, i) => p.then(
      () => resolve(event),
      (err) => {
        errors.push(`${relays[i]}: ${err?.message || err}`);
        if (--pending === 0) reject(new Error(`No relay accepted kind ${event.kind}: ${errors.join("; ")}`));
      },
    ));
  });
}

class NsiteClay extends EventTarget {
  constructor(doc = document) {
    super();
    this.doc = doc;
    this.cfg = readConfig(doc);
    this.pool = new SimplePool();
    this.signer = null;
    this.editable = new Editable(this);
    this.media = new Media(this);
    this.feed = new Feed(this);
    this.compose = new Compose(this);
    this.settings = new Settings(this);
    this.dom = new Dom(this);
    this.state = new State(this);
    this.cms = new Cms(this);
    this.blocks = new Blocks(this);
    this.upgrade = new Upgrade(this);
    this.version = VERSION;
    this.status = "idle";
    this._subs = [];
    this._transforms = [];
  }

  get pubkey() { return this.signer?.pubkey || null; }
  get isOwner() { return !!this.pubkey && this.pubkey === this.cfg.owner; }
  get npub() { return this.pubkey ? nip19.npubEncode(this.pubkey) : null; }

  addDocumentTransform(fn) { this._transforms.push(fn); }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
    this.doc.documentElement.setAttribute("nc:status", this.status);
  }
  _set(status, detail) { this.status = status; this._emit("nsiteclay:status", { status, ...detail }); }

  // ---- identity -----------------------------------------------------------

  async login(method = "auto", opts = {}) {
    if (method === "auto") method = Nip07Signer.available() ? "nip07" : "nip46";
    if (method === "nip07") this.signer = new Nip07Signer();
    else if (method === "nsec" || method === "local") {
      this.signer = await LocalSigner.fromInput(opts.key, opts.password);
    }
    else if (method === "bunker") this.signer = await Nip46Signer.fromBunkerUri(opts.uri);
    else if (method === "nip46") return this.connectRemote(opts);
    else throw new Error(`Unknown login method: ${method}`);
    await this.signer.connect();
    this._afterLogin();
    return this.pubkey;
  }

  // Amber and friends: hand back a nostrconnect:// URI to show as a QR or a deep
  // link, and a promise that settles when the signer answers.
  //
  // The handshake goes to cfg.signerRelays, not cfg.relays. The site's own relay
  // set is chosen to carry manifests, and at least one of its members refuses
  // kind 24133 outright, which is a sign-in that hangs with nothing to see.
  //
  // The title goes in as the app name and is cut short, because every character
  // of it is another character of URI and the URI is a QR code somebody has to
  // photograph. A long <title> is not worth an unscannable code.
  connectRemote({ relays } = {}) {
    const { uri, promise, cancel } = Nip46Signer.nostrconnect({
      relays: relays || this.cfg.signerRelays,
      name: (this.doc.title || "nsite-clay").slice(0, 40),
    });
    const ready = promise.then((signer) => { this.signer = signer; this._afterLogin(); return this.pubkey; });
    this._emit("nsiteclay:connect-uri", { uri });
    return { uri, ready, cancel };
  }

  _afterLogin() {
    const html = this.doc.documentElement;
    html.setAttribute("nc:pubkey", this.pubkey);
    html.setAttribute("nc:owner-here", String(this.isOwner));
    html.setAttribute("nc:editmode", String(this.isOwner));
    try { localStorage.setItem(STORAGE, JSON.stringify({ kind: this.signer.kind, pubkey: this.pubkey })); } catch {}
    if (this.isOwner && this.editRequested) this.editable.enable();
    this._emit("nsiteclay:login", { pubkey: this.pubkey, isOwner: this.isOwner });
  }

  async logout() {
    await this.signer?.close?.();
    this.signer = null;
    const html = this.doc.documentElement;
    for (const a of ["nc:pubkey", "nc:owner-here"]) html.removeAttribute(a);
    html.setAttribute("nc:editmode", "false");
    this.editable.disable();
    try { localStorage.removeItem(STORAGE); } catch {}
    this._emit("nsiteclay:logout", {});
  }

  // ---- saving --------------------------------------------------------------

  // Everything the runtime injected comes off the clone before serialisation,
  // so the bytes on Blossom are the document as authored, not as running.
  _cleanClone(clone) {
    // nc:autosave and nc:edit-gate are settings and stay. The rest is runtime
    // state that means nothing in a file.
    for (const a of ["nc:pubkey", "nc:owner-here", "nc:editmode", "nc:status", "nc:ready",
                     "nc:editable", "nc:outdated", "nc:editing", "nc:reading",
                     "nc:cms-rules", "nc:cms-open"]) clone.removeAttribute(a);
    for (const el of [...clone.querySelectorAll("[nc\\:chrome]")]) el.remove();
    // A feed's items and an opened video frame are fetched at view time. They
    // are not this document's content and must not be frozen into it.
    for (const el of [...clone.querySelectorAll("[nc\\:transient]")]) el.remove();
    for (const el of [...clone.querySelectorAll("[nc\\:feed]")]) el.removeAttribute("nc:feed-count");
    for (const el of [...clone.querySelectorAll("dialog[open]")]) el.removeAttribute("open");
    // `editable` survives as an inert marker; the contenteditable it implies is
    // machinery and never reaches disk.
    for (const el of [...clone.querySelectorAll("[contenteditable]")]) el.removeAttribute("contenteditable");
    for (const el of [...clone.querySelectorAll("[nc\\:keep-editable]")]) el.removeAttribute("nc:keep-editable");
    for (const el of [...clone.querySelectorAll("[nc\\:armed]")]) el.removeAttribute("nc:armed");
    // Same for the spellchecker: the runtime turns it on to edit with, and a
    // published file carrying spellcheck="true" on every heading is machinery
    // that leaked. Only the ones we set are marked, so an authored value stays.
    for (const el of [...clone.querySelectorAll("[nc\\:spellcheck]")]) {
      el.removeAttribute("spellcheck");
      el.removeAttribute("nc:spellcheck");
    }
    // The parts tree marks whichever element the pointer is over. Left behind,
    // it would publish one element wearing an outline nobody asked for.
    for (const el of [...clone.querySelectorAll("[nc\\:highlight]")]) el.removeAttribute("nc:highlight");
  }

  getHTML() {
    return snapshot(this.doc, {
      forSave: true,
      transforms: [...this._transforms, (clone) => this._cleanClone(clone)],
    });
  }

  // One save = one blob upload, one replaceable manifest, one version snapshot.
  async save({ extraPaths = {}, dropPaths = [], snapshotVersion = true } = {}) {
    if (!this.signer) throw new Error("Not signed in");
    if (!this.isOwner) throw new Error("Only the site owner can save this document");
    const html = this.getHTML();
    // A caller changing the path table -- swapping the runtime for a newer blob
    // at the same name -- can leave the document byte-identical, and the
    // shortcut below would skip the very publish that carries the change.
    const tableOnly = Object.keys(extraPaths).length > 0 || dropPaths.length > 0;
    // Identical bytes deduplicate to the same Blossom blob anyway; skipping
    // spares the relays a version event that says nothing new.
    if (!tableOnly && hashText(html) === this._ownHash) { this._set("saved", { skipped: true }); return { skipped: true, hash: this._ownHash }; }
    this._set("saving");
    try {
      const paths = { ...(await this._currentPaths()), ...extraPaths };
      // Paths the caller is retiring. An upgraded runtime would otherwise leave
      // its predecessor named in the table for the life of the site. Nothing is
      // destroyed by this: every kind-5128 snapshot still names the old hash and
      // the blob is still on Blossom, so an old version still restores. The
      // check below is what keeps it safe -- drop the engine out from under a
      // document that still loads it and the save refuses -- and the document's
      // own path can never be dropped at all.
      for (const p of dropPaths) if (p !== this.cfg.path) delete paths[p];

      // Checked before the upload, so a save that cannot go through does not
      // spend somebody's Blossom quota first.
      const missing = this._missingRefs(html, paths);
      if (missing.engine.length) {
        throw new Error(
          `This page loads ${missing.engine.join(", ")}, which the manifest does not list. ` +
          `Publishing it would leave a page that can no longer edit itself, and nothing in a ` +
          `browser could put that back. Deploy the whole directory with the CLI to rebuild the ` +
          `path table.`);
      }

      const bytes = new TextEncoder().encode(html);
      const { hash } = await uploadAll(this.cfg.servers, bytes, { signer: this.signer, type: "text/html" });
      paths[this.cfg.path] = hash;

      const manifest = await this.signer.sign(buildManifest(this.cfg, paths, { title: this.doc.title }));
      await publishToAny(this.pool, this.cfg.relays, manifest);

      let version = null;
      if (snapshotVersion) {
        version = await this.signer.sign(buildSnapshot(this.cfg, manifest));
        this.pool.publish(this.cfg.relays, version).forEach((p) => p.catch(() => {}));
      }
      this._ownHash = hash;
      this._manifest = manifest;
      this._set("saved", { hash, manifest, version, missing });
      return { hash, bytes: bytes.length, manifest, version, aggregate: aggregateHash(paths), missing };
    } catch (err) {
      this._set("error", { error: String(err) });
      throw err;
    }
  }

  // A manifest is the whole path table, so a save that cannot read the current
  // one would silently unpublish every other file in the site.
  //
  // Reading it is not enough on its own. Relays disagree, and the one that
  // answers may hand back an older manifest than the page was served under.
  // Publishing that table with a new /index.html merged in produces a manifest
  // whose document references an asset the table no longer lists, which is a
  // broken site. So take the union of every table we have seen, newest value
  // winning per path, and never drop a path.
  async _currentPaths() {
    const seen = [this._bootManifest, this._manifest, await this.currentManifest()].filter(Boolean);
    if (!seen.length) return {};
    const newest = seen.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
    this._manifest = newest;
    const merged = {};
    for (const ev of seen.sort((a, b) => a.created_at - b.created_at)) {
      Object.assign(merged, manifestPaths(ev));
    }
    return merged;
  }

  // Every same-origin thing the document points at.
  _referencedPaths(html) {
    const { loads, links } = this._referenceMap(html);
    return [...new Set([...loads, ...links])];
  }

  // The same references, split by what a missing one costs.
  //
  // A file the page *loads* is a hole in the page: a script that 404s takes the
  // page's behaviour with it. A file the page *links to* is a dead link, and on
  // a site being written one page at a time that is the ordinary state of an
  // afternoon. The two are not the same problem and must not have the same
  // answer.
  _referenceMap(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const loads = new Set(), links = new Set();
    const add = (set, value) => {
      if (!value) return;
      // One srcset holds several URLs, each followed by its descriptor.
      for (const candidate of String(value).split(",")) {
        const url = candidate.trim().split(/\s+/)[0];
        if (!url || !url.startsWith("/") || url.startsWith("//")) continue;
        set.add(url.split(/[?#]/)[0]);
      }
    };
    const LOADING_REL = /\b(stylesheet|icon|manifest|preload|prefetch|modulepreload)\b/i;
    for (const el of doc.querySelectorAll("[src], [srcset], [href], form[action], object[data], video[poster]")) {
      const tag = el.tagName.toLowerCase();
      // A <link> is either, and only its rel says which: a stylesheet is
      // fetched to draw the page, rel="alternate" is a page to go to.
      const navigates = tag === "a" || tag === "area" || tag === "form" || tag === "base"
        || (tag === "link" && !LOADING_REL.test(el.getAttribute("rel") || ""));
      const set = navigates ? links : loads;
      add(set, el.getAttribute("src"));
      add(set, el.getAttribute("srcset"));
      add(set, el.getAttribute("href"));
      if (tag === "form") add(set, el.getAttribute("action"));
      if (tag === "object") add(set, el.getAttribute("data"));
      if (tag === "video") add(set, el.getAttribute("poster"));
    }
    return { loads, links };
  }

  // What the manifest does not name. Three lists, because there are three
  // different things to do about it: fix the engine before publishing, redeploy
  // a missing asset, or write the page that a link is waiting for.
  _missingRefs(html, paths) {
    const have = new Set(Object.keys(paths));
    have.add(this.cfg.path);
    // A gateway resolves a directory the way any web server does, so a link to
    // /blog/ is answered by /blog/index.html in the table. Without this every
    // correctly deployed multi-page site would report itself broken.
    const known = (p) => {
      if (have.has(p)) return true;
      if (p.endsWith("/")) return have.has(p + "index.html");
      if (/\.[a-z0-9]+$/i.test(p.slice(p.lastIndexOf("/") + 1))) return false;
      return have.has(p + "/index.html") || have.has(p + ".html");
    };
    const { loads, links } = this._referenceMap(html);
    const assets = [...loads].filter((p) => !known(p));
    // The one that cannot be undone from a browser: the page that would fix it
    // is the page that no longer loads. The stylesheet is not in this list
    // because a page without it is ugly, not lost.
    return {
      engine: assets.filter((p) => ENGINE.has(unstamp(p))),
      assets: assets.filter((p) => !ENGINE.has(unstamp(p))),
      links: [...links].filter((p) => !known(p)),
    };
  }

  async currentManifest() {
    const f = this.cfg.site
      ? { kinds: [35128], authors: [this.cfg.owner], "#d": [this.cfg.site], limit: 1 }
      : { kinds: [15128], authors: [this.cfg.owner], limit: 1 };
    return this.pool.get(this.cfg.relays, f);
  }

  // ---- publishing a whole site from the browser ----------------------------

  // What the CLI's `deploy` does, without the CLI: upload every file to Blossom,
  // then publish one NIP-5A manifest naming the lot. `files` is a list of
  // { path, bytes, type } and the signed-in key becomes the owner, which is the
  // difference from save(): this page publishes on behalf of whoever is holding
  // the keyboard, not on behalf of the key that owns this page.
  //
  // The table is merged with what that key has already published, because a
  // manifest is the whole path table and one that forgets a path unpublishes it.
  // Someone adding a page at /notes/ must not lose the page at /.
  async publishFiles(files, { site = "", title = "", servers, relays, merge = true, onProgress } = {}) {
    if (!this.signer) throw new Error("Sign in first");
    const pubkey = this.signer.pubkey;
    const to = servers?.length ? servers : this.cfg.servers;
    const on = relays?.length ? relays : this.cfg.relays;
    const step = onProgress || (() => {});
    const cfg = { owner: pubkey, site, servers: to, relays: on };

    const existing = merge ? await this.manifestOf(pubkey, site).catch(() => null) : null;
    const paths = existing ? manifestPaths(existing) : {};

    // Ask, then sign, then upload. Blobs are content addressed, so most of a
    // publish is usually already on the servers from whoever published before;
    // signing first would have a phone signer approve uploads that never happen,
    // and a second publish of an unchanged site would ask for approvals it has
    // no use for at all. Asking first means the signatures are exactly the ones
    // needed, and they are all taken in one burst rather than one appearing
    // between each upload.
    //
    // `server` progress is reported from here rather than from uploadAll,
    // because the asking and the uploading are now two separate passes.
    const onServer = (path) => (server, state, detail) =>
      step({ stage: "server", path, server, state, detail });

    const plan = [];
    for (const f of files) {
      const hash = hashBytes(f.bytes);
      const say = onServer(f.path);
      step({ stage: "checking", path: f.path, done: plan.length, total: files.length });
      const present = await Promise.all(to.map(async (s) => {
        say(s, "checking");
        const held = await has(s, hash, f.bytes.length);
        say(s, held ? "present" : "absent");
        return held;
      }));
      plan.push({ f, hash, present });
      paths[f.path] = hash;
    }

    const needed = plan.filter((p) => p.present.some((x) => !x)).map((p) => p.hash);
    const signed = needed.length
      ? await signUploads(this.signer, needed, {
          onSign: (n, total) => step({ stage: "signing", done: n, total }),
        })
      : new Map();

    let done = 0, sent = 0, reused = 0;
    for (const { f, hash, present } of plan) {
      step({ stage: "upload", path: f.path, done, total: files.length });
      const r = await uploadAll(to, f.bytes, {
        signer: this.signer, type: f.type, known: present, signed: signed.get(hash),
        onServer: onServer(f.path),
      });
      r.uploaded ? sent++ : reused++;
      done++;
    }

    step({ stage: "manifest", done, total: files.length, uploaded: sent, reused });
    const manifest = await this.signer.sign(buildManifest(cfg, paths, { title }));
    // Every relay at once, resolving on the first acceptance: a dead relay in the
    // list costs nothing, and only a set where all of them refused is an error.
    await publishToAny(this.pool, on, manifest);

    // The version snapshot is filed after the manifest and never awaited: the
    // site is live either way, and a slow relay should not hold up the news.
    const version = await this.signer.sign(buildSnapshot(cfg, manifest));
    this.pool.publish(on, version).forEach((p) => p.catch(() => {}));

    step({ stage: "done", done, total: files.length, uploaded: sent, reused });
    return { pubkey, manifest, version, paths, uploaded: sent, reused, aggregate: aggregateHash(paths) };
  }

  // Anyone's current manifest, not just this page's owner. The wizard needs it
  // to answer "is there already a site here" before it overwrites one.
  async manifestOf(pubkey, site = "") {
    const f = site
      ? { kinds: [35128], authors: [pubkey], "#d": [site], limit: 1 }
      : { kinds: [15128], authors: [pubkey], limit: 1 };
    const ev = await this.pool.get(this.cfg.relays, f);
    return ev && verifyEvent(ev) ? ev : null;
  }

  // ---- version history -----------------------------------------------------

  // Blobs are immutable and deduplicate by hash, so a version is just an event
  // naming a set of them. Nothing is ever overwritten.
  async versions(limit = 50) {
    const evs = await this.pool.querySync(this.cfg.relays, {
      kinds: [5128], authors: [this.cfg.owner], "#a": [siteAddress(this.cfg)], limit,
    });
    return evs.filter(verifyEvent).sort((a, b) => b.created_at - a.created_at);
  }

  // Read a past version straight from Blossom, refusing bytes that do not hash
  // to what the snapshot claims. No gateway is trusted for this.
  async readVersion(snapshotEvent, path = this.cfg.path) {
    const paths = manifestPaths(snapshotEvent);
    const servers = [...new Set([...manifestServers(snapshotEvent), ...this.cfg.servers])];
    if (!paths[path]) throw new Error(`Version has no ${path}`);
    return fetchVerified(servers, paths[path]);
  }

  // Publish an old version's path table as the current manifest. Nothing is
  // destroyed: the restore is itself a new version.
  async restore(snapshotEvent) {
    if (!this.isOwner) throw new Error("Only the site owner can restore");
    const paths = manifestPaths(snapshotEvent);
    const manifest = await this.signer.sign(buildManifest(this.cfg, paths, { title: this.doc.title }));
    await publishToAny(this.pool, this.cfg.relays, manifest);
    const version = await this.signer.sign(buildSnapshot(this.cfg, manifest));
    this.pool.publish(this.cfg.relays, version).forEach((p) => p.catch(() => {}));
    this._manifest = manifest;
    return { manifest, version };
  }

  // ---- staying current -----------------------------------------------------

  // A published document hardcodes its own asset URLs and is served with a cache
  // lifetime, so a reader who loaded it an hour ago keeps running the old bytes
  // with no way to know. The manifest is a replaceable event, so the document
  // watches its own: the moment the hash for its path stops matching the bytes
  // this tab was served, a newer version exists. Push, not polling.
  onCanonicalHost() {
    const host = this.doc.location.hostname || "";
    const label = host.split(".")[0].toLowerCase();
    if (!label || !this.cfg.owner) return false;
    const b36 = BigInt("0x" + this.cfg.owner).toString(36).padStart(50, "0");
    return this.cfg.site
      ? label === b36 + this.cfg.site
      : label === nip19.npubEncode(this.cfg.owner).toLowerCase() || label === b36;
  }

  async _watchVersion() {
    if (!this.cfg.owner || !this.cfg.autoreload) return;
    // Only the published document at its canonical address has an update
    // channel. A local copy, a fork on another host, or a file opened from disk
    // is a different artifact, not an outdated version of this one.
    if (!this.onCanonicalHost()) return;
    try {
      const res = await fetch(this.doc.location.href, { cache: "reload" });
      this._servedHash = hashText(await res.text());
    } catch { return; }
    const f = this.cfg.site
      ? { kinds: [35128], authors: [this.cfg.owner], "#d": [this.cfg.site] }
      : { kinds: [15128], authors: [this.cfg.owner] };
    this._subs.push(this.pool.subscribe(this.cfg.relays, f, {
      onevent: (ev) => { if (verifyEvent(ev)) this._onManifest(ev); },
    }));
  }

  _onManifest(ev) {
    if (this._manifest && this._manifest.created_at > ev.created_at) return;
    this._manifest = ev;
    const latest = manifestPaths(ev)[this.cfg.path];
    if (!latest || !this._servedHash) return;
    if (latest === this._servedHash) return;   // we are the current version
    if (latest === this._ownHash) return;      // our own save; this tab is ahead
    this.doc.documentElement.setAttribute("nc:outdated", "true");
    this._emit("nsiteclay:outdated", { served: this._servedHash, latest });
    this._offerReload(latest);
  }

  // Reload through a fresh URL rather than location.reload(): the document and
  // its assets are served with a cache lifetime, and a plain reload is entitled
  // to hand back the very bytes we are trying to replace.
  reloadToLatest(hash) {
    const url = new URL(this.doc.location.href);
    url.searchParams.set("v", String(hash || Date.now()).slice(0, 12));
    this.doc.location.replace(url.toString());
  }

  // Editing controls appear when the gate is open. With nc:edit-gate="hash"
  // that means the URL ends in #edit, so a reader gets the page and nothing to
  // click, and the owner gets the controls by asking for them.
  get editRequested() {
    if (this.cfg.editGate !== "hash") return true;
    return /^#edit\b/i.test(this.doc.location.hash || "");
  }

  applyEditGate() {
    const on = this.editRequested;
    this.root.setAttribute("nc:editing", String(on));
    this.root.setAttribute("nc:edit-gate", this.cfg.editGate);
    if (!on) this.editable.disable();
    else if (this.isOwner) this.editable.enable();
    this._emit("nsiteclay:edit-gate", { open: on });
  }

  get root() { return this.doc.documentElement; }

  // Leaving with unsaved work should cost a keystroke, not a page of writing.
  _guardUnload() {
    this.doc.defaultView.addEventListener("beforeunload", (e) => {
      if (!this.dirty) return;
      e.preventDefault();
      e.returnValue = "";        // the wording is the browser's, not ours
      return "";
    });
  }

  // `autosave` on <html>: save once edits settle, never more often than the
  // throttle, and always on ⌘S / Ctrl+S whether or not autosave is on.
  _armSaving() {
    this.doc.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (this.isOwner) this.save().catch(() => {});
      }
    });
    const DEBOUNCE = 2500, THROTTLE = 15000;
    let timer = null, last = 0;
    const schedule = () => {
      // Checked per keystroke rather than at boot, so turning it on in the
      // settings takes effect without a reload.
      if (!this.settings.autosave || !this.isOwner) return;
      clearTimeout(timer);
      const wait = Math.max(DEBOUNCE, last + THROTTLE - Date.now());
      timer = setTimeout(() => { last = Date.now(); this.save().catch(() => {}); }, wait);
    };
    this.doc.addEventListener("input", schedule, true);
    this.addEventListener("nsiteclay:autosave-now", schedule);
  }

  get dirty() { return this._dirty === true; }
  set dirty(v) { this._dirty = !!v; }

  // Tracked for the document rather than by it. Any typing into editable markup
  // or a form control counts; a successful save clears it. Password fields are
  // excluded: a half-typed key is not work worth keeping.
  _trackDirty() {
    this.doc.addEventListener("input", (e) => {
      const el = e.target;
      if (!el || el.type === "password") return;
      if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) this._dirty = true;
    }, true);
    this.addEventListener("nsiteclay:status", (e) => {
      if (e.detail?.status === "saved") this._dirty = false;
    });
    if (this.cfg.watchDom) this._watchDom();
  }

  // Off unless a page asks for it with nc:watch-dom.
  //
  // getHTML() serialises the live DOM, so a change made from the console, from
  // devtools or from the page's own script is saved like any other -- but
  // nothing notices it, so autosave does not fire and the unload guard does not
  // warn about work it would lose. This closes that, for a page that wants it
  // closed.
  //
  // Opt-in, because a DOM changes for plenty of reasons that are not edits: a
  // carousel advancing, a script updating a clock, a widget polling. On a page
  // like that, with autosave on, this would publish a new version every few
  // seconds forever. Only the page's author knows which kind of page theirs is.
  _watchDom() {
    // Runtime furniture is not content. Rails, the toolbar, modals and a feed's
    // fetched items all come off the save clone anyway, so a mutation that only
    // touches those has changed nothing that would ever be published.
    const ours = (node) => {
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      return !!el?.closest?.("[nc\\:chrome], [nc\\:transient]");
    };
    // Attributes the runtime sets on the way in and strips on the way out.
    const MACHINERY = new Set(["contenteditable", "spellcheck"]);

    this._domWatch = new MutationObserver((records) => {
      for (const m of records) {
        if (m.type === "attributes" &&
            (MACHINERY.has(m.attributeName) || m.attributeName?.startsWith("nc:"))) continue;
        if (ours(m.target)) continue;
        if (m.type === "childList" &&
            [...m.addedNodes, ...m.removedNodes].every(ours)) continue;
        this._dirty = true;
        return;
      }
    });
    this._domWatch.observe(this.doc.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  }

  _offerReload(latest) {
    if (this._reloadOffered) return;
    this._reloadOffered = true;
    const banner = this.doc.createElement("div");
    banner.setAttribute("nc:chrome", "");       // never reaches a save
    banner.setAttribute("role", "status");
    banner.style.cssText = "position:fixed;z-index:2147483647;left:50%;bottom:1rem;" +
      "transform:translateX(-50%);display:flex;gap:.75rem;align-items:center;" +
      "font:14px/1.4 ui-sans-serif,system-ui,sans-serif;padding:.6rem .9rem;border-radius:10px;" +
      "background:#101418;color:#f4f6f7;box-shadow:0 8px 30px -10px rgba(0,0,0,.6)";
    const msg = this.doc.createElement("span");
    const btn = this.doc.createElement("button");
    btn.textContent = "Reload";
    btn.style.cssText = "font:inherit;cursor:pointer;border:1px solid #4a5560;background:#1c2329;" +
      "color:inherit;border-radius:7px;padding:.25rem .7rem";
    btn.onclick = () => this.reloadToLatest(latest);
    banner.append(msg, btn);
    this.doc.body.appendChild(banner);

    if (this.dirty) {
      msg.textContent = "A newer version of this page was published. You have unsaved changes.";
      return;
    }
    let n = 5;
    msg.textContent = `A newer version was published. Reloading in ${n}…`;
    const tick = setInterval(() => {
      if (this.dirty) { clearInterval(tick); msg.textContent = "A newer version was published."; return; }
      if (--n <= 0) { clearInterval(tick); this.reloadToLatest(latest); return; }
      msg.textContent = `A newer version was published. Reloading in ${n}…`;
    }, 1000);
  }

  destroy() { for (const s of this._subs) s.close?.(); this.pool.close(this.cfg.relays); }
}

const nc = new NsiteClay();
nc.ready = (async () => {
  if (document.readyState === "loading") {
    await new Promise((r) => document.addEventListener("DOMContentLoaded", r, { once: true }));
  }
  nc.cfg = readConfig(document);
  nc._trackDirty();
  nc._armSaving();
  nc._guardUnload();
  nc.applyEditGate();
  window.addEventListener("hashchange", () => nc.applyEditGate());
  nc.media.armEmbeds();
  nc.feed.start();
  nc.blocks.start();
  // A toolbar may carry the content form's button on a page that has no rules
  // for it to draw, and a button whose only answer is "there is nothing here"
  // is furniture. The shared stylesheet hides it unless this says otherwise.
  if (nc.doc.querySelector("script[nc\\:cms]")) nc.doc.documentElement.setAttribute("nc:cms-rules", "true");
  nc.upgrade.start();
  nc._watchVersion();
  if (nc.cfg.owner) {
    nc.currentManifest().then((ev) => { if (ev) { nc._manifest = ev; nc._bootManifest = ev; } }).catch(() => {});
  }
  document.documentElement.setAttribute("nc:ready", "true");
  nc._emit("nsiteclay:ready", {});
  return nc;
})();

Object.assign(nc, {
  nip19, verifyEvent, sanitize, sanitizeAs, snapshot, hashText, fetchVerified, LocalSigner, toast, notice, parseVideoUrl, field, modal, checkbox, qrSvg, qrElement,
  VERSION, stamp, unstamp,
  siteAddress: () => siteAddress(nc.cfg), siteKind: () => siteKind(nc.cfg), toHex,
  manifestPaths, manifestServers, aggregateHash, readFeedConfig, postUrl, addressOf,
});

if (typeof window !== "undefined") window.nsiteclay = window.nc = nc;
export default nc;
