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
import { verifyEvent } from "nostr-tools";
import { manifestPaths, manifestServers } from "./manifest.js";
import { fetchVerified, uploadAll } from "./blossom.js";
import { modal, toast } from "./ui.js";

// The three files every template links from the site root.
const SHARED = [
  { canonical: "/nsite-clay.js", type: "text/javascript" },
  { canonical: "/nsite-clay-base.css", type: "text/css" },
  { canonical: "/nsite-clay-chrome.js", type: "text/javascript" },
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
  // canonical name its stamp was made from.
  refs() {
    const out = [];
    for (const el of this.doc.querySelectorAll("script[src], link[href]")) {
      const attr = el.tagName === "SCRIPT" ? "src" : "href";
      const url = el.getAttribute(attr) || "";
      if (!url.startsWith("/") || url.startsWith("//")) continue;
      const path = url.split(/[?#]/)[0];
      const kind = SHARED.find((s) => s.canonical === unstamp(path));
      if (kind) out.push({ el, attr, path, ...kind });
    }
    return out;
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
    const files = [];
    for (const ref of this.refs()) {
      const want = src.paths[ref.canonical];
      if (!want) continue;                       // that key does not publish this one
      if (mine[ref.path] === want) continue;     // we already serve those bytes
      files.push({ ...ref, hash: want });
    }
    if (!files.length) return null;

    return {
      running: this.nc.version,
      version: notes?.version || null,
      released: notes?.released || null,
      notes: Array.isArray(notes?.notes) ? notes.notes : [],
      files,
      servers: src.servers,
    };
  }

  // ---- doing it ------------------------------------------------------------

  // Fetch, store on the owner's own Blossom servers, repoint the document, and
  // publish one manifest carrying all of it. After this the site is still served
  // entirely from where its owner put it; nothing of ours is in the path.
  async apply(plan, onProgress = () => {}) {
    if (!this.nc.isOwner) throw new Error("Only the site owner can change this page");
    const extraPaths = {};
    const dropPaths = [];
    let done = 0;

    for (const f of plan.files) {
      onProgress({ path: f.canonical, done, total: plan.files.length });
      const bytes = await fetchVerified(plan.servers, f.hash, { as: "bytes" });
      await uploadAll(this.nc.cfg.servers, bytes, {
        signer: this.nc.signer, type: f.type, check: true,
      });
      // A page that links the plain name keeps the plain name -- the blob behind
      // it simply changes. Only a stamped reference has to move, because its
      // whole purpose is to be a URL a cache has never seen.
      const to = f.path === f.canonical ? f.path : stamp(f.canonical, f.hash);
      extraPaths[to] = f.hash;
      if (to !== f.path) {
        f.el.setAttribute(f.attr, to);
        dropPaths.push(f.path);
      }
      done++;
    }

    onProgress({ path: "the manifest", done, total: plan.files.length });
    const out = await this.nc.save({ extraPaths, dropPaths });
    return { ...out, files: plan.files.length };
  }

  // ---- the offer -----------------------------------------------------------

  async promptFor(plan) {
    const ul = (parent, label, items) => {
      const l = this.doc.createElement("label");
      l.textContent = label;
      const list = this.doc.createElement("ul");
      list.className = "nc-list";
      for (const text of items) {
        const li = this.doc.createElement("li");
        const b = this.doc.createElement("b");
        b.textContent = text;
        li.appendChild(b);
        list.appendChild(li);
      }
      parent.append(l, list);
    };

    const ok = await modal({
      doc: this.doc,
      title: plan.version ? `nsite-clay ${plan.version} is available` : "A newer runtime is available",
      hint: `This page runs ${plan.running}. Updating copies the newer files onto your own Blossom ` +
            `servers and republishes your manifest, so nothing of anybody else's ends up in the way.`,
      submitLabel: "Update",
      build: (body) => {
        if (plan.notes.length) ul(body, "What changed", plan.notes.slice(0, 10));
        ul(body, "Files", plan.files.map((f) => f.canonical));
        const note = this.doc.createElement("p");
        note.className = "nc-hint";
        note.style.margin = "1rem 0 0";
        note.textContent = "This replaces the engine, the toolbar script and the stylesheet. " +
          "It does not touch your page: the blocks, the words and the design stay as they are. " +
          "Version history keeps the old one, so this is reversible.";
        body.appendChild(note);
      },
      onSubmit: async (h) => {
        await this.apply(plan, ({ path, done, total }) =>
          h.status(`Updating ${path} (${Math.min(done + 1, total)}/${total})…`));
        return true;
      },
    });
    if (ok) this.nc.reloadToLatest();
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
      this.check().then((plan) => { if (plan) this.notice(plan); }).catch(() => {});
    };
    for (const ev of ["nsiteclay:login", "nsiteclay:edit-gate"]) this.nc.addEventListener(ev, look);
    look();
  }

  // Styled inline rather than from the stylesheet, because a page whose engine
  // is out of date has an out of date stylesheet too, and the one notice that
  // must be legible is this one.
  notice(plan) {
    const bar = this.doc.createElement("div");
    bar.setAttribute("nc:chrome", "");          // never reaches a save
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;z-index:2147483646;left:50%;top:1rem;" +
      "transform:translateX(-50%);display:flex;gap:.75rem;align-items:center;max-width:calc(100vw - 2rem);" +
      "font:14px/1.4 ui-sans-serif,system-ui,sans-serif;padding:.6rem .9rem;border-radius:10px;" +
      "background:#101418;color:#f4f6f7;box-shadow:0 8px 30px -10px rgba(0,0,0,.6)";
    const msg = this.doc.createElement("span");
    msg.textContent = plan.version
      ? `nsite-clay ${plan.version} is available. This page runs ${plan.running}.`
      : "A newer nsite-clay runtime is available for this page.";

    const btnCss = "font:inherit;cursor:pointer;border:1px solid #4a5560;background:#1c2329;" +
      "color:inherit;border-radius:7px;padding:.25rem .7rem;white-space:nowrap";
    const see = this.doc.createElement("button");
    see.textContent = "See what changed";
    see.style.cssText = btnCss;
    see.onclick = () => { bar.remove(); this.promptFor(plan); };
    const not = this.doc.createElement("button");
    not.textContent = "Not now";
    not.style.cssText = btnCss + ";border-color:transparent";
    not.onclick = () => bar.remove();

    bar.append(msg, see, not);
    this.doc.body.appendChild(bar);
    return bar;
  }
}
