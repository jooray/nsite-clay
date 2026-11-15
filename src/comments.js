// Comments on a page: select some text, or pick a part of the page, and say what
// should be different.
//
// A page that opts in with `nc:comments` on <html> gets a Comments button for
// whoever can save it. A comment is markup in the document, like everything
// else here, so it is saved with the page, travels with it, and an agent that
// reads the page back can find it without any other service:
//
//   <aside nc:comments hidden>
//     <article nc:comment="c7k2f9" nc:state="open" nc:by="Jana" nc:at="2026-11-15T10:30:00.000Z">
//       <blockquote nc:quote>the words that were selected</blockquote>
//       <p nc:text>Please make this shorter.</p>
//       <p nc:reply nc:by="Agent" nc:at="...">Done, it is one sentence now.</p>
//     </article>
//   </aside>
//
// and, where it was made, the anchor: `<mark nc:c="c7k2f9">` around the words, or
// `nc:c="c7k2f9"` on the element that was picked. Marks exist only while a
// comment is open, so a page with nothing to answer carries no highlights.
//
// The controls are drawn by the runtime and marked `nc:chrome`, so they are
// never saved and every page gets them through an upgrade.
import { nip19 } from "nostr-tools";
import { toast } from "./ui.js";

// Order: en, es, sk, cs, as in pages.js.
const WORDS = {
  button: ["Comments", "Comentarios", "Komentáre", "Komentáře"],
  title: ["Comments on this page", "Comentarios en esta página", "Komentáre k tejto stránke", "Komentáře k této stránce"],
  hint: ["Select some words on the page and press Comment, or pick a part of the page. Whoever looks after this page sees them.",
    "Selecciona unas palabras de la página y pulsa Comentar, o elige una parte de la página. Quien se ocupa de la página los verá.",
    "Označ na stránke pár slov a stlač Komentovať, alebo vyber časť stránky. Uvidí ich ten, kto sa o stránku stará.",
    "Označ na stránce pár slov a stiskni Komentovat, nebo vyber část stránky. Uvidí je ten, kdo se o stránku stará."],
  comment: ["Comment", "Comentar", "Komentovať", "Komentovat"],
  onSelection: ["Comment on the selected words", "Comentar las palabras seleccionadas", "Komentovať označené slová", "Komentovat označená slova"],
  pick: ["Pick a part of the page", "Elegir una parte de la página", "Vybrať časť stránky", "Vybrat část stránky"],
  picking: ["Click the part of the page you mean. Esc cancels.", "Haz clic en la parte de la página que quieres. Esc cancela.",
    "Klikni na časť stránky, ktorú myslíš. Esc zruší.", "Klikni na část stránky, kterou myslíš. Esc zruší."],
  none: ["No comments yet.", "Todavía no hay comentarios.", "Zatiaľ žiadne komentáre.", "Zatím žádné komentáře."],
  newTitle: ["New comment", "Comentario nuevo", "Nový komentár", "Nový komentář"],
  yourComment: ["What should be different?", "¿Qué debería ser distinto?", "Čo by malo byť inak?", "Co by mělo být jinak?"],
  save: ["Save", "Guardar", "Uložiť", "Uložit"],
  cancel: ["Cancel", "Cancelar", "Zrušiť", "Zrušit"],
  close: ["Close", "Cerrar", "Zavrieť", "Zavřít"],
  reply: ["Reply", "Responder", "Odpovedať", "Odpovědět"],
  send: ["Send", "Enviar", "Poslať", "Odeslat"],
  resolve: ["Resolve", "Resolver", "Vyriešiť", "Vyřešit"],
  reopen: ["Reopen", "Reabrir", "Znova otvoriť", "Znovu otevřít"],
  remove: ["Delete", "Eliminar", "Zmazať", "Smazat"],
  sure: ["Delete for good?", "¿Eliminar para siempre?", "Zmazať navždy?", "Smazat navždy?"],
  open: ["open", "abiertos", "otvorené", "otevřené"],
  resolved: ["Resolved", "Resueltos", "Vyriešené", "Vyřešené"],
  saved: ["Comment saved", "Comentario guardado", "Komentár je uložený", "Komentář je uložen"],
  failed: ["The comment could not be saved: {why}", "No se pudo guardar el comentario: {why}",
    "Komentár sa nepodarilo uložiť: {why}", "Komentář se nepodařilo uložit: {why}"],
  lost: ["The commented words are no longer on the page.", "Las palabras comentadas ya no están en la página.",
    "Komentované slová už na stránke nie sú.", "Komentovaná slova už na stránce nejsou."],
  page: ["whole page", "toda la página", "celá stránka", "celá stránka"],
  restored: ["Your comment was saved again after the page reloaded.", "Su comentario se guardó de nuevo tras recargar la página.",
    "Váš komentár sa po obnovení stránky uložil znova.", "Váš komentář se po obnovení stránky uložil znovu."],
};

const CHROME_SKIP = "[nc\\:chrome], aside[nc\\:comments], script, style, template, textarea, select, option, noscript";

const CSS = `
mark[nc\\:c] { background: #ffe66d; color: #1c1900; border-radius: 2px; padding: 0 .08em; cursor: pointer; }
[nc\\:c]:not(mark) { outline: 2px dashed #e0a800; outline-offset: 3px; }
.ncc-btn, .ncc-bubble, .ncc-panel, .ncc-form, .ncc-pick { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  color-scheme: light dark; color: CanvasText; box-sizing: border-box; }
.ncc-btn *, .ncc-bubble *, .ncc-panel *, .ncc-form * { box-sizing: border-box; }
.ncc-btn { position: fixed; z-index: 2147483600; right: max(60px, calc(env(safe-area-inset-right) + 60px)); bottom: max(12px, env(safe-area-inset-bottom));
  height: 40px; min-width: 40px; padding: 0 .75rem; display: inline-flex; align-items: center; gap: .4rem; border-radius: 20px;
  border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); background: Canvas; color: CanvasText; cursor: pointer;
  box-shadow: 0 4px 14px -6px rgba(0,0,0,.45); opacity: .86; font-weight: 600; }
.ncc-btn:hover, .ncc-btn:focus-visible { opacity: 1; }
.ncc-btn b { background: #c47f00; color: #fff; border-radius: 10px; padding: 0 .45em; font-size: .78rem; line-height: 1.5; }
.ncc-bubble { position: absolute; z-index: 2147483601; padding: .4rem .85rem; border-radius: 10px; border: 2px solid #1c1900; background: #ffe66d; color: #1c1900;
  font-weight: 700; font-size: 15px; cursor: pointer; box-shadow: 0 6px 18px -6px rgba(0,0,0,.6); }
.ncc-panel { position: fixed; z-index: 2147483602; top: 0; right: 0; bottom: 0; width: min(24rem, 100vw); display: flex; flex-direction: column;
  background: Canvas; border-left: 1px solid color-mix(in srgb, CanvasText 22%, transparent); box-shadow: -10px 0 30px -18px rgba(0,0,0,.5); }
.ncc-panel header { display: flex; align-items: center; gap: .5rem; padding: .8rem 1rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
.ncc-panel header h2 { margin: 0; font-size: 1rem; flex: 1; }
.ncc-panel .ncc-body { overflow: auto; padding: .6rem 1rem 1.2rem; flex: 1; }
.ncc-panel .ncc-tools { display: flex; gap: .5rem; flex-wrap: wrap; margin: .5rem 0 .8rem; }
.ncc-panel p.ncc-hint { margin: 0 0 .6rem; font-size: .85rem; opacity: .75; }
.ncc-item { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 10px; padding: .6rem .75rem; margin: 0 0 .7rem; }
.ncc-item[data-state="resolved"] { opacity: .6; }
.ncc-item blockquote { margin: 0 0 .4rem; padding: 0 0 0 .6rem; border-left: 3px solid #e0a800; font-size: .85rem; opacity: .8; overflow-wrap: anywhere; }
.ncc-item p { margin: 0 0 .35rem; overflow-wrap: anywhere; white-space: pre-wrap; }
.ncc-item .ncc-who { font-size: .76rem; opacity: .7; }
.ncc-item .ncc-reply { margin-left: .8rem; padding-left: .6rem; border-left: 2px solid color-mix(in srgb, CanvasText 20%, transparent); }
.ncc-item .ncc-acts { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .4rem; }
.ncc-b { font: inherit; font-size: .82rem; padding: .3rem .65rem; border-radius: 7px; cursor: pointer; background: transparent;
  color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); }
.ncc-b:hover { background: color-mix(in srgb, CanvasText 10%, transparent); }
.ncc-b.main { background: #1c1900; color: #ffe66d; border-color: #1c1900; }
.ncc-form { position: fixed; z-index: 2147483603; width: min(22rem, calc(100vw - 1.5rem)); padding: .8rem; border-radius: 12px; background: Canvas;
  border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); box-shadow: 0 18px 48px -18px rgba(0,0,0,.6); }
.ncc-form blockquote { margin: 0 0 .5rem; padding-left: .6rem; border-left: 3px solid #e0a800; font-size: .85rem; max-height: 4.5rem; overflow: hidden; opacity: .85; }
.ncc-form textarea, .ncc-panel textarea { width: 100%; font: inherit; padding: .5rem .6rem; border-radius: 8px; color: CanvasText;
  background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 35%, transparent); margin: 0 0 .5rem; }
.ncc-form textarea { min-height: 9rem; resize: vertical; }
.ncc-panel textarea { min-height: 6rem; resize: vertical; }
.ncc-form .ncc-row { display: flex; gap: .5rem; justify-content: flex-end; }
.ncc-pick { position: fixed; z-index: 2147483599; pointer-events: none; border: 2px solid #e0a800; background: rgba(255,230,109,.25); border-radius: 3px; }
.ncc-tip { position: fixed; z-index: 2147483604; left: 50%; top: .8rem; transform: translateX(-50%); padding: .5rem .9rem; border-radius: 8px;
  background: #1c1900; color: #ffe66d; font: 600 14px system-ui, sans-serif; }
`;

const id6 = () => {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return "c" + [...a].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 6);
};
const tokens = (v) => (v || "").split(/\s+/).filter(Boolean);

export class Comments {
  constructor(nc) {
    this.nc = nc;
    this.doc = nc.doc;
    this._range = null;
  }

  say(key, vars = {}) {
    const lang = ["en", "es", "sk", "cs"].indexOf((this.doc.documentElement.lang || "en").slice(0, 2).toLowerCase());
    let text = WORDS[key]?.[Math.max(lang, 0)] || WORDS[key]?.[0] || key;
    for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(v);
    return text;
  }

  /** The page asked for comments. */
  get enabled() { return this.doc.documentElement.hasAttribute("nc:comments"); }
  /** Whoever can save the page can comment on it: the comment is saved with it. */
  get can() { return this.enabled && this.nc.isOwner; }

  start() {
    if (!this.enabled) return;
    this._style();
    // Known before the first comment is written, so saving it does not wait.
    this.nc.addEventListener("nsiteclay:login", () => { if (this.can) this.author(); });
    const sync = () => this.sync();
    for (const e of ["nsiteclay:login", "nsiteclay:logout"]) this.nc.addEventListener(e, sync);
    this.doc.addEventListener("selectionchange", () => {
      this._selection();
      // A finger has no mouseup: the selection settling is the signal.
      if (this._coarse()) { clearTimeout(this._selTimer); this._selTimer = setTimeout(() => this._bubbleFor(), 350); }
    });
    this.doc.addEventListener("mouseup", () => setTimeout(() => this._bubbleFor(), 0));
    this.doc.addEventListener("keyup", (e) => { if (e.key.startsWith("Arrow") || e.key === "Shift") setTimeout(() => this._bubbleFor(), 0); });
    // A highlight is a way into its comment.
    this.doc.addEventListener("click", (e) => {
      if (!this.can) return;
      const m = e.target.closest?.("mark[nc\\:c]");
      if (m && !m.closest("[nc\\:chrome]") && !this.doc.getSelection()?.toString()) this.panel(tokens(m.getAttribute("nc:c"))[0]);
    });
    sync();
  }

  _style() {
    if (this.doc.getElementById("nc-comments-style")) return;
    const s = this.doc.createElement("style");
    s.id = "nc-comments-style"; s.setAttribute("nc:chrome", "");
    s.textContent = CSS;
    // Readers see the words as they were: the anchor is there for whoever answers.
    s.textContent += `\nhtml:not([nc\\:owner-here="true"]) mark[nc\\:c] { background: none; color: inherit; padding: 0; cursor: auto; }` +
      `\nhtml:not([nc\\:owner-here="true"]) [nc\\:c]:not(mark) { outline: 0; }`;
    this.doc.head.append(s);
  }

  // ---- the page's comments --------------------------------------------------

  container(create = false) {
    let c = this.doc.querySelector("aside[nc\\:comments]");
    if (!c && create) {
      c = this.doc.createElement("aside");
      c.setAttribute("nc:comments", "");
      c.hidden = true;
      c.style.display = "none";
      this.doc.body.append(c);
    }
    return c;
  }

  /** Every comment on the page, oldest first. */
  list() {
    return [...this.doc.querySelectorAll("aside[nc\\:comments] > article[nc\\:comment]")].map((el) => ({
      id: el.getAttribute("nc:comment"),
      state: el.getAttribute("nc:state") === "resolved" ? "resolved" : "open",
      by: el.getAttribute("nc:by") || "",
      at: el.getAttribute("nc:at") || "",
      quote: el.querySelector(":scope > blockquote[nc\\:quote]")?.textContent || "",
      text: el.querySelector(":scope > p[nc\\:text]")?.textContent || "",
      replies: [...el.querySelectorAll(":scope > p[nc\\:reply]")].map((r) => ({
        by: r.getAttribute("nc:by") || "", at: r.getAttribute("nc:at") || "", text: r.textContent,
      })),
      el,
    }));
  }

  anchors(id) {
    return [...this.doc.querySelectorAll("[nc\\:c]")].filter((el) => tokens(el.getAttribute("nc:c")).includes(id));
  }

  /**
   * The key of the person looking at the page, when they came in as somebody:
   * a member of an encrypted page, or anyone signed in with their own key. A
   * page opened by its edit link has only the page's own key, which says nothing
   * about who is typing, so those comments carry no author.
   */
  identity() {
    const nc = this.nc;
    if (nc.sealed.active) return nc.sealed.state?.member || null;
    const kind = nc.signer?.kind;
    return kind === "nip07" || kind === "nip46" ? nc.pubkey : null;
  }

  /** { by, pk }: the profile name of that person, never typed and never changed here. */
  author() {
    const pk = this.identity();
    if (!pk) return Promise.resolve({ by: "", pk: "" });
    if (this._author?.hex === pk) return this._author.promise;
    const npub = nip19.npubEncode(pk);
    const short = npub.slice(0, 12) + "…" + npub.slice(-4);
    const nc = this.nc;
    const relays = [...new Set([...(nc.cfg.relays || []), "wss://purplepag.es", "wss://relay.damus.io"])];
    const lookup = Promise.race([
      nc.pool.querySync(relays, { kinds: [0], authors: [pk] }).then((evs) => {
        const ev = evs.sort((a, b) => b.created_at - a.created_at)[0];
        const p = ev ? JSON.parse(ev.content) : {};
        return String(p.display_name || p.displayName || p.name || "").trim();
      }),
      new Promise((r) => setTimeout(() => r(""), 3500)),
    ]).catch(() => "").then((name) => ({ by: name || short, pk: npub }));
    this._author = { hex: pk, promise: lookup };
    return lookup;
  }

  /**
   * Add a comment. `range` anchors it to words, `element` to a part of the
   * page, neither to the page as a whole. Returns the new comment's id.
   */
  add({ text, by = "", pk = "", range = null, element = null }) {
    const id = id6();
    let quote = "";
    if (range) {
      quote = range.toString().replace(/\s+/g, " ").trim().slice(0, 400);
      this._wrap(range, id);
    } else if (element) {
      quote = (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160)
        || element.getAttribute("alt") || `<${element.localName}>`;
      element.setAttribute("nc:c", [...tokens(element.getAttribute("nc:c")), id].join(" "));
    } else quote = this.say("page");
    const doc = this.doc;
    const art = doc.createElement("article");
    art.setAttribute("nc:comment", id);
    art.setAttribute("nc:state", "open");
    if (by) art.setAttribute("nc:by", by);
    if (pk) art.setAttribute("nc:pk", pk);
    art.setAttribute("nc:at", new Date().toISOString());
    const q = doc.createElement("blockquote"); q.setAttribute("nc:quote", ""); q.textContent = quote;
    const p = doc.createElement("p"); p.setAttribute("nc:text", ""); p.textContent = text;
    art.append(q, p);
    this.container(true).append(art);
    // Written down before anything is saved. A save is refused when somebody else
    // saved the page first, and the person is then asked to reload, which would
    // take a comment that exists only in this copy with it.
    this._pending({ id, text, by, pk, at: art.getAttribute("nc:at"), quote, kind: range ? "words" : element ? "part" : "page" });
    this._changed();
    return id;
  }

  replyTo(id, text, by = "", pk = "") {
    const art = this.list().find((c) => c.id === id)?.el;
    if (!art) return false;
    const p = this.doc.createElement("p");
    p.setAttribute("nc:reply", "");
    if (by) p.setAttribute("nc:by", by);
    if (pk) p.setAttribute("nc:pk", pk);
    p.setAttribute("nc:at", new Date().toISOString());
    p.textContent = text;
    art.append(p);
    this._changed();
    return true;
  }

  resolve(id, on = true) {
    const c = this.list().find((x) => x.id === id);
    if (!c) return false;
    c.el.setAttribute("nc:state", on ? "resolved" : "open");
    if (on) this._unanchor(id); else this._reanchor(c);
    this._changed();
    return true;
  }

  remove(id) {
    const c = this.list().find((x) => x.id === id);
    if (!c) return false;
    this._unanchor(id);
    c.el.remove();
    if (!this.container()?.children.length) this.container().remove();
    this._changed();
    return true;
  }

  // ---- anchors ----------------------------------------------------------------

  _wrap(range, id) {
    const root = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
    const walker = this.doc.createTreeWalker(root, 4);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (range.intersectsNode(n) && !n.parentElement?.closest(CHROME_SKIP)) nodes.push(n);
    }
    for (const node of nodes) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      if (start >= end) continue;
      let target = node;
      if (end < node.length) node.splitText(end);
      if (start > 0) target = node.splitText(start);
      if (!target.data.trim()) continue;
      const mark = this.doc.createElement("mark");
      mark.setAttribute("nc:c", id);
      target.parentNode.insertBefore(mark, target);
      mark.append(target);
    }
  }

  _unanchor(id) {
    for (const el of this.anchors(id)) {
      const rest = tokens(el.getAttribute("nc:c")).filter((t) => t !== id);
      if (rest.length) { el.setAttribute("nc:c", rest.join(" ")); continue; }
      if (el.localName === "mark") {
        const parent = el.parentNode;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        el.remove();
        parent.normalize();
      } else el.removeAttribute("nc:c");
    }
  }

  // A comment opened again goes back on the words it was made on, if they are
  // still there once.
  _reanchor(c) {
    const quote = c.quote.trim();
    if (!quote || quote === this.say("page")) return;
    const walker = this.doc.createTreeWalker(this.doc.body, 4);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement?.closest(CHROME_SKIP)) continue;
      const at = n.data.indexOf(quote);
      if (at < 0) continue;
      const range = this.doc.createRange();
      range.setStart(n, at); range.setEnd(n, at + quote.length);
      this._wrap(range, c.id);
      return;
    }
  }

  _changed() {
    this.sync();
    this.nc.dirty = true;
    this.nc.dispatchEvent(new CustomEvent("nsiteclay:comments"));
    this._save();
  }

  // A comment is a deliberate act, so it is saved now rather than after the
  // page's autosave settles, which a page may not have at all.
  async _save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(async () => {
      try { await this.nc.save(); this._pending(null); toast(this.say("saved"), { doc: this.doc }); }
      catch (e) { toast(this.say("failed", { why: e?.message || String(e) }), { doc: this.doc }); }
    }, 600);
  }

  // ---- comments that did not get saved --------------------------------------

  _pendingKey() {
    const c = this.nc.cfg;
    return `nsite-clay.comments-pending:${c.owner || ""}:${c.site || ""}:${c.path || ""}`;
  }
  _store() { try { return this.doc.defaultView.sessionStorage; } catch { return null; } }

  /** Remember one more unsaved comment, or with null forget them all (the page was saved with them in it). */
  _pending(record) {
    const store = this._store();
    if (!store) return;
    try {
      if (record === null) { store.removeItem(this._pendingKey()); return; }
      const all = JSON.parse(store.getItem(this._pendingKey()) || "[]");
      if (!all.some((x) => x.id === record.id)) all.push(record);
      store.setItem(this._pendingKey(), JSON.stringify(all.slice(-20)));
    } catch { /* storage full or blocked: the comment still works, it is only not kept across a reload */ }
  }

  /**
   * After a reload: comments this tab wrote and the page never saved are put back,
   * on the words they were made on if those are still there, without an anchor if
   * not, and saved. Nobody retypes anything.
   */
  _restore() {
    if (this._restored) return;
    const store = this._store();
    if (!store) return;
    let all = [];
    try { all = JSON.parse(store.getItem(this._pendingKey()) || "[]"); } catch { return; }
    this._restored = true;
    if (!all.length) return;
    const have = new Set(this.list().map((c) => c.id));
    let added = 0;
    for (const rec of all) {
      if (have.has(rec.id) || !rec.text) continue;
      const doc = this.doc;
      const art = doc.createElement("article");
      art.setAttribute("nc:comment", rec.id);
      art.setAttribute("nc:state", "open");
      if (rec.by) art.setAttribute("nc:by", rec.by);
      if (rec.pk) art.setAttribute("nc:pk", rec.pk);
      art.setAttribute("nc:at", rec.at || new Date().toISOString());
      const q = doc.createElement("blockquote"); q.setAttribute("nc:quote", ""); q.textContent = rec.quote || this.say("page");
      const p = doc.createElement("p"); p.setAttribute("nc:text", ""); p.textContent = rec.text;
      art.append(q, p);
      this.container(true).append(art);
      if (rec.kind === "words" || rec.kind === "part") this._reanchor({ id: rec.id, quote: rec.quote || "" });
      added++;
    }
    if (added) {
      this._changed();
      toast(this.say("restored"), { doc: this.doc });
    } else this._pending(null);
  }

  // ---- drawing ------------------------------------------------------------------

  sync() {
    const want = this.can;
    if (want) setTimeout(() => this._restore(), 0);
    let btn = this.doc.getElementById("nc-comments-btn");
    if (!want) { btn?.remove(); this._closeAll(); return; }
    const open = this.list().filter((c) => c.state === "open").length;
    if (!btn) {
      btn = this.doc.createElement("button");
      btn.type = "button"; btn.id = "nc-comments-btn"; btn.className = "ncc-btn"; btn.setAttribute("nc:chrome", "");
      btn.addEventListener("click", () => this.panel());
      this.doc.body.append(btn);
    }
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
    const label = this.doc.createElement("span"); label.textContent = this.say("button"); label.className = "ncc-label";
    btn.append(label);
    if (open) { const b = this.doc.createElement("b"); b.textContent = String(open); btn.append(b); }
    btn.title = this.say("title");
    if (this.panelEl) this._fill();
  }

  _closeAll() {
    this.panelEl?.remove(); this.panelEl = null;
    this.formEl?.remove(); this.formEl = null;
    this.doc.getElementById("nc-comments-bubble")?.remove();
  }

  _chrome(tag, cls, parent = this.doc.body) {
    const el = this.doc.createElement(tag);
    el.className = cls; el.setAttribute("nc:chrome", "");
    parent.append(el);
    return el;
  }

  // ---- selecting words --------------------------------------------------------

  _valid(range) {
    if (!range || range.collapsed || !range.toString().trim()) return false;
    const a = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
    return !!a && this.doc.body.contains(a) && !a.closest(CHROME_SKIP);
  }

  _selection() {
    if (!this.can) return;
    const sel = this.doc.getSelection();
    if (sel && sel.rangeCount && this._valid(sel.getRangeAt(0))) this._range = sel.getRangeAt(0).cloneRange();
  }

  _coarse() { return !!this.doc.defaultView.matchMedia?.("(pointer: coarse)").matches; }

  _bubbleFor() {
    this.doc.getElementById("nc-comments-bubble")?.remove();
    if (!this.can || this.formEl) return;
    const sel = this.doc.getSelection();
    if (!sel || !sel.rangeCount || !this._valid(sel.getRangeAt(0))) return;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const r = rects[rects.length - 1] || range.getBoundingClientRect();
    const b = this._chrome("button", "ncc-bubble");
    b.id = "nc-comments-bubble"; b.type = "button"; b.textContent = this.say("comment");
    const win = this.doc.defaultView;
    if (this._coarse()) {
      // The phone draws its own menu above the selection and drag handles just
      // under it. The button goes under the handles, beside the words it is about;
      // with no room there, to the bottom of the screen, where neither is.
      const vv = win.visualViewport;
      const limit = (vv ? vv.offsetTop + vv.height : win.innerHeight) - 56;
      const top = r.bottom + 76;
      b.style.left = Math.max(8, Math.min(r.left, win.innerWidth - 140)) + "px";
      b.style.height = "44px";
      if (top <= limit) b.style.top = (win.scrollY + top) + "px";
      else b.style.cssText += ";position:fixed;left:12px;right:auto;bottom:max(12px,env(safe-area-inset-bottom));top:auto";
    } else {
      b.style.left = Math.max(8, Math.min(win.scrollX + r.left, win.scrollX + win.innerWidth - 120)) + "px";
      b.style.top = (win.scrollY + r.bottom + 8) + "px";
    }
    // Pressing it must not collapse the selection it is about.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => { const keep = range.cloneRange(); b.remove(); this.compose({ range: keep }); });
  }

  // ---- picking a part of the page -----------------------------------------------

  pickElement() {
    this._closePanel();
    const doc = this.doc, win = doc.defaultView;
    const box = this._chrome("div", "ncc-pick");
    const tip = this._chrome("div", "ncc-tip"); tip.textContent = this.say("picking");
    let target = null;
    const done = () => {
      for (const [e, f, o] of handlers) doc.removeEventListener(e, f, o);
      box.remove(); tip.remove();
    };
    const under = (x, y) => { const el = doc.elementFromPoint(x, y); return el && !el.matches("html, body") && !el.closest("[nc\\:chrome]") ? el : null; };
    const move = (e) => {
      target = under(e.clientX, e.clientY);
      if (!target) { box.style.display = "none"; return; }
      const r = target.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    };
    const click = (e) => {
      if (e.target.closest?.("[nc\\:chrome]")) return;
      e.preventDefault(); e.stopPropagation();
      const el = under(e.clientX, e.clientY);
      done();
      if (el) this.compose({ element: el });
    };
    const key = (e) => { if (e.key === "Escape") done(); };
    const handlers = [["mousemove", move, true], ["click", click, true], ["keydown", key, true]];
    for (const [e, f, o] of handlers) doc.addEventListener(e, f, o);
    void win;
  }

  // ---- the composer ---------------------------------------------------------------

  compose({ range = null, element = null } = {}) {
    if (!this.can) return;
    this.formEl?.remove();
    const doc = this.doc, win = doc.defaultView;
    const form = this._chrome("form", "ncc-form");
    this.formEl = form;
    const h = doc.createElement("div"); h.style.cssText = "font-weight:700;margin-bottom:.4rem"; h.textContent = this.say("newTitle");
    form.append(h);
    const quote = range ? range.toString().replace(/\s+/g, " ").trim()
      : element ? (element.textContent || "").replace(/\s+/g, " ").trim() || `<${element.localName}>` : "";
    if (quote) { const q = doc.createElement("blockquote"); q.textContent = quote.slice(0, 200); form.append(q); }
    const ta = doc.createElement("textarea"); ta.placeholder = this.say("yourComment"); ta.required = true; ta.name = "text";
    form.append(ta);
    const row = doc.createElement("div"); row.className = "ncc-row";
    const cancel = doc.createElement("button"); cancel.type = "button"; cancel.className = "ncc-b"; cancel.textContent = this.say("cancel");
    const ok = doc.createElement("button"); ok.type = "submit"; ok.className = "ncc-b main"; ok.textContent = this.say("save");
    row.append(cancel, ok); form.append(row);

    // Next to what it is about, where there is room.
    let rect = null;
    if (range) { const rs = range.getClientRects(); rect = rs[rs.length - 1] || range.getBoundingClientRect(); }
    else if (element) rect = element.getBoundingClientRect();
    if (this._coarse()) {
      // On a phone the form sits at the top, clear of the keyboard and of the
      // phone's own selection menu.
      form.style.left = "12px"; form.style.right = "12px"; form.style.top = "max(12px, env(safe-area-inset-top))"; form.style.width = "auto";
      ta.style.fontSize = "16px"; ta.style.minHeight = "10rem";           // below 16px iOS zooms the page in
    } else {
      const w = Math.min(352, win.innerWidth - 24);
      const left = rect ? Math.max(12, Math.min(rect.left, win.innerWidth - w - 12)) : (win.innerWidth - w) / 2;
      let top = rect ? rect.bottom + 10 : 80;
      if (top + 260 > win.innerHeight) top = Math.max(12, (rect ? rect.top : 80) - 270);
      form.style.left = left + "px"; form.style.top = Math.max(12, top) + "px";
    }

    const close = () => { form.remove(); if (this.formEl === form) this.formEl = null; };
    cancel.onclick = close;
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      ok.disabled = true;
      const who = await this.author();
      close();
      doc.getSelection()?.removeAllRanges();
      this.add({ text, by: who.by, pk: who.pk, range, element });
    });
    ta.focus();
  }

  // ---- the list ----------------------------------------------------------------------

  _closePanel() { this.panelEl?.remove(); this.panelEl = null; }

  panel(focusId = null) {
    if (!this.can) return;
    if (this.panelEl && !focusId) { this._closePanel(); return; }
    this._closePanel();
    const doc = this.doc;
    const p = this._chrome("aside", "ncc-panel");
    p.setAttribute("role", "dialog"); p.setAttribute("aria-label", this.say("title"));
    this.panelEl = p;
    const head = doc.createElement("header");
    const h = doc.createElement("h2"); h.textContent = this.say("title");
    const x = doc.createElement("button"); x.type = "button"; x.className = "ncc-b"; x.textContent = this.say("close"); x.onclick = () => this._closePanel();
    head.append(h, x);
    const body = doc.createElement("div"); body.className = "ncc-body";
    p.append(head, body);
    p.addEventListener("keydown", (e) => { if (e.key === "Escape") this._closePanel(); });
    this._fill(focusId);
    x.focus();
  }

  _fill(focusId = null) {
    const body = this.panelEl?.querySelector(".ncc-body");
    if (!body) return;
    const doc = this.doc;
    body.textContent = "";
    const hint = doc.createElement("p"); hint.className = "ncc-hint"; hint.textContent = this.say("hint");
    body.append(hint);
    const tools = doc.createElement("div"); tools.className = "ncc-tools";
    const sel = doc.createElement("button"); sel.type = "button"; sel.className = "ncc-b main"; sel.textContent = this.say("onSelection");
    sel.onclick = () => {
      const r = this._valid(this._range) ? this._range : null;
      if (r) { this._closePanel(); this.compose({ range: r }); } else hint.style.fontWeight = "700";
    };
    const pick = doc.createElement("button"); pick.type = "button"; pick.className = "ncc-b"; pick.textContent = this.say("pick");
    pick.onclick = () => this.pickElement();
    const whole = doc.createElement("button"); whole.type = "button"; whole.className = "ncc-b"; whole.textContent = this.say("page");
    whole.onclick = () => { this._closePanel(); this.compose({}); };
    tools.append(sel, pick, whole);
    body.append(tools);

    const all = this.list();
    if (!all.length) { const n = doc.createElement("p"); n.textContent = this.say("none"); body.append(n); }
    const group = (state) => {
      for (const c of all.filter((x) => x.state === state)) body.append(this._item(c));
    };
    group("open");
    const done = all.filter((c) => c.state === "resolved");
    if (done.length) {
      const t = doc.createElement("p"); t.className = "ncc-hint"; t.style.marginTop = "1rem"; t.textContent = this.say("resolved") + " (" + done.length + ")";
      body.append(t); group("resolved");
    }
    if (focusId) body.querySelector(`[data-id="${focusId}"]`)?.scrollIntoView({ block: "center" });
  }

  _item(c) {
    const doc = this.doc;
    const li = doc.createElement("div"); li.className = "ncc-item"; li.dataset.id = c.id; li.dataset.state = c.state;
    if (c.quote) {
      const q = doc.createElement("blockquote"); q.textContent = c.quote.slice(0, 160);
      q.style.cursor = "pointer"; q.onclick = () => this.show(c.id);
      li.append(q);
    }
    const t = doc.createElement("p"); t.textContent = c.text; li.append(t);
    const who = (by, at) => {
      const w = doc.createElement("div"); w.className = "ncc-who";
      w.textContent = [by, at ? new Date(at).toLocaleString(doc.documentElement.lang || undefined, { dateStyle: "medium", timeStyle: "short" }) : ""].filter(Boolean).join(", ");
      return w;
    };
    li.append(who(c.by, c.at));
    for (const r of c.replies) {
      const rp = doc.createElement("div"); rp.className = "ncc-reply";
      const rt = doc.createElement("p"); rt.textContent = r.text; rp.append(rt, who(r.by, r.at)); li.append(rp);
    }
    const acts = doc.createElement("div"); acts.className = "ncc-acts";
    const btn = (label, fn, cls = "ncc-b") => { const b = doc.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label; b.onclick = fn; acts.append(b); return b; };
    btn(this.say("reply"), () => this._replyBox(li, c));
    btn(c.state === "open" ? this.say("resolve") : this.say("reopen"), () => this.resolve(c.id, c.state === "open"));
    const del = btn(this.say("remove"), () => {
      if (del.dataset.sure) this.remove(c.id);
      else { del.dataset.sure = "1"; del.textContent = this.say("sure"); }
    });
    li.append(acts);
    return li;
  }

  _replyBox(li, c) {
    if (li.querySelector("textarea")) return;
    const doc = this.doc;
    const ta = doc.createElement("textarea"); ta.placeholder = this.say("reply");
    const send = doc.createElement("button"); send.type = "button"; send.className = "ncc-b main"; send.textContent = this.say("send");
    send.onclick = async () => { const v = ta.value.trim(); if (!v) return; const who = await this.author(); this.replyTo(c.id, v, who.by, who.pk); };
    li.append(ta, send);
    ta.focus();
  }

  /** Scroll to what a comment is about and draw the eye to it. */
  show(id) {
    const el = this.anchors(id)[0];
    if (!el) { toast(this.say("lost"), { doc: this.doc }); return; }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.animate?.([{ outlineColor: "#ff4d00", outlineStyle: "solid", outlineWidth: "4px", outlineOffset: "4px" }, { outlineColor: "transparent" }],
      { duration: 1400, easing: "ease-out" });
  }
}
