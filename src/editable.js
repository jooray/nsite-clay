// The `editable` attribute, after ClayJS's RichClay: mark a container, and in
// edit mode a person types into it directly. Enter makes a paragraph; the
// floating toolbar's block menu turns one into a heading, a list, a quote or a
// code block. Nothing is written to disk but the markup itself — the attribute
// stays behind as an inert marker and the toolbar never reaches a save.
//
// Commands go through document.execCommand. It is deprecated and its output
// varies slightly between engines, which is why every block change is followed
// by a normalise pass; the alternative is a full selection/range editor, which
// is a library rather than a feature.
import { sanitize } from "./sanitize.js";

const BLOCKS = [
  { cmd: "P", label: "Paragraph", key: "0" },
  { cmd: "H1", label: "Heading 1", key: "1" },
  { cmd: "H2", label: "Heading 2", key: "2" },
  { cmd: "H3", label: "Heading 3", key: "3" },
  { cmd: "BLOCKQUOTE", label: "Quote" },
  { cmd: "PRE", label: "Code block" },
];

const MARKS = [
  { cmd: "bold", label: "Bold", glyph: "B", style: "font-weight:700" },
  { cmd: "italic", label: "Italic", glyph: "I", style: "font-style:italic" },
  { cmd: "strikeThrough", label: "Strikethrough", glyph: "S", style: "text-decoration:line-through" },
];

// Typing "# " at the start of a block makes it a heading, "- " a list, and so
// on. RichClay has no such rules; they cost little and nobody who has used a
// modern editor expects to reach for a menu to start a bulleted list.
const INPUT_RULES = [
  [/^#\s$/, (d) => d.execCommand("formatBlock", false, "H1")],
  [/^##\s$/, (d) => d.execCommand("formatBlock", false, "H2")],
  [/^###\s$/, (d) => d.execCommand("formatBlock", false, "H3")],
  [/^[-*]\s$/, (d) => d.execCommand("insertUnorderedList")],
  [/^1\.\s$/, (d) => d.execCommand("insertOrderedList")],
  [/^>\s$/, (d) => d.execCommand("formatBlock", false, "BLOCKQUOTE")],
  [/^```$/, (d) => d.execCommand("formatBlock", false, "PRE")],
];

const tokensOf = (el) => new Set((el.getAttribute("editable") || "").split(/\s+/).filter(Boolean));

// Elements that hold words but cannot hold boxes. Anything block-shaped inside
// one of these is markup the parser will rearrange the moment it is written out
// and read back, so it never gets to survive a save.
const INLINE = new Set(["A", "SPAN", "CITE", "B", "I", "EM", "STRONG", "SMALL", "CODE",
                        "LABEL", "TIME", "ABBR", "SUB", "SUP", "MARK", "S", "U", "DEL", "INS"]);
const BLOCKISH = "p, div, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, pre, " +
                 "section, article, figure, figcaption, table, header, footer";

// The rule the sanitiser uses, so a typed link cannot go anywhere pasted markup
// could not.
const SAFE_URL = /^(https?:|mailto:|#|\/)/i;

// A single line takes the words and drops the shape, whitespace included: a
// pasted paragraph should not arrive carrying the source document's line breaks.
const oneLine = (s) => (s || "").replace(/\s+/g, " ").trim();

export class Editable {
  constructor(nc) {
    this.nc = nc;
    this.doc = nc.doc;
    this.on = false;
    this.bar = null;
  }

  elements() { return [...this.doc.querySelectorAll("[editable]")]; }

  // Arming is per element and repeatable on purpose. A page that inserts a new
  // note, row or card calls this again to pick it up, and calling it when
  // editing is already on must arm the new nodes rather than return early.
  enable() {
    const first = !this.on;
    this.on = true;
    if (first) {
      try { this.doc.execCommand("defaultParagraphSeparator", false, "p"); } catch {}
      this._bind();
    }
    for (const el of this.elements()) this.arm(el);
    this.doc.documentElement.setAttribute("nc:editable", "true");
  }

  // Idempotent: the guard attribute stops a second call stacking another
  // keydown listener on a single-line region.
  arm(el) {
    if (el.hasAttribute("nc:armed")) return el;
    el.setAttribute("nc:armed", "");
    el.contentEditable = "true";
    el.setAttribute("nc:keep-editable", "");
    // The red underline is editing machinery, not content, so it is marked as
    // ours and comes off again in disable() and on every save. An authored value
    // is left alone: a page saying spellcheck="false" on a code block means it.
    if (!el.hasAttribute("spellcheck")) {
      el.spellcheck = true;
      el.setAttribute("nc:spellcheck", "");
    }
    if (tokensOf(el).has("single-line")) el.addEventListener("keydown", blockEnter);
    return el;
  }

  refresh() { if (this.on) this.enable(); }

  disable() {
    if (!this.on) return;
    this.on = false;
    for (const el of this.elements()) {
      el.removeAttribute("contenteditable");
      el.removeAttribute("nc:keep-editable");
      el.removeAttribute("nc:armed");
      if (el.hasAttribute("nc:spellcheck")) {
        el.removeAttribute("spellcheck");
        el.removeAttribute("nc:spellcheck");
      }
      el.removeEventListener("keydown", blockEnter);
    }
    this._unbind();
    this.hideBar();
    this.doc.documentElement.removeAttribute("nc:editable");
  }

  // ---- wiring -------------------------------------------------------------

  _bind() {
    this._onSel = () => this.syncBar();
    this._onKey = (e) => this.onKeydown(e);
    this._onInput = (e) => this.onInput(e);
    this._onPaste = (e) => this.onPaste(e);
    this._onDown = (e) => { if (this.bar && !this.bar.contains(e.target)) this.syncBar(); };
    this.doc.addEventListener("selectionchange", this._onSel);
    this.doc.addEventListener("keydown", this._onKey, true);
    this.doc.addEventListener("input", this._onInput, true);
    this.doc.addEventListener("paste", this._onPaste, true);
    this.doc.addEventListener("mouseup", this._onDown, true);
    this.doc.defaultView.addEventListener("scroll", this._onSel, true);
  }

  _unbind() {
    this.doc.removeEventListener("selectionchange", this._onSel);
    this.doc.removeEventListener("keydown", this._onKey, true);
    this.doc.removeEventListener("input", this._onInput, true);
    this.doc.removeEventListener("paste", this._onPaste, true);
    this.doc.removeEventListener("mouseup", this._onDown, true);
    this.doc.defaultView.removeEventListener("scroll", this._onSel, true);
  }

  host(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el && !el.hasAttribute?.("editable")) el = el.parentElement;
    return el;
  }

  activeHost() {
    const sel = this.doc.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const el = this.host(sel.anchorNode);
    return el && el.isContentEditable ? el : null;
  }

  // ---- keyboard -----------------------------------------------------------

  onKeydown(e) {
    const host = this.activeHost();
    if (!host) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    const run = (fn) => { e.preventDefault(); fn(); this.syncBar(); this.nc.dirty = true; };
    if (k === "b") return run(() => this.exec("bold"));
    if (k === "i") return run(() => this.exec("italic"));
    if (k === "u") return run(() => this.exec("underline"));
    if (k === "k") return run(() => this.link());
    if (e.shiftKey && k === "7") return run(() => this.list("insertOrderedList"));
    if (e.shiftKey && k === "8") return run(() => this.list("insertUnorderedList"));
    if (e.shiftKey && k === "9") return run(() => this.block("BLOCKQUOTE"));
    if (e.altKey && "0123".includes(e.key)) {
      const b = BLOCKS.find((x) => x.key === e.key);
      if (b) return run(() => this.block(b.cmd));
    }
  }

  onInput(e) {
    const host = this.host(e.target);
    if (!host || !host.isContentEditable) return;
    this.nc.dirty = true;
    // "# " and "- " make blocks, and a single line has nowhere to put one.
    if (tokensOf(host).has("no-markdown") || tokensOf(host).has("single-line")) return;
    const sel = this.doc.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode || sel.anchorNode.nodeType !== 3) return;
    const text = sel.anchorNode.textContent.slice(0, sel.anchorOffset);
    for (const [re, apply] of INPUT_RULES) {
      if (!re.test(text)) continue;
      // Remove the shorthand, then apply the block change to the empty line.
      const r = this.doc.createRange();
      r.setStart(sel.anchorNode, sel.anchorOffset - text.length);
      r.setEnd(sel.anchorNode, sel.anchorOffset);
      r.deleteContents();
      apply(this.doc);
      this.normalise(host);
      this.syncBar();
      return;
    }
  }

  // Paste arrives as whatever the source app produced. Clean HTML output is the
  // whole point of a malleable file, so it goes through the same allowlist that
  // contributed markup does.
  //
  // A single line is the exception, and takes text with no markup at all. The
  // allowlist passes <p> and <div>, and a browser asked to put one of those
  // inside an inline host splits the host to make room: paste a paragraph into a
  // button and Chrome nests a second <a> inside the first. Nested anchors are
  // not representable in HTML, so the save writes them out and the next load
  // parses them back as siblings -- a page that has grown a second button, empty,
  // with nothing on the block rail that can reach inside a block to remove it.
  onPaste(e) {
    const host = this.activeHost();
    if (!host) return;
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (tokensOf(host).has("single-line")) {
      this.exec("insertText", oneLine(html ? this.textOf(html) : text));
    }
    else if (html) this.exec("insertHTML", sanitize(html));
    else this.exec("insertText", text);
    this.normalise(host);
    this.nc.dirty = true;
  }

  // The words out of pasted markup. Sanitised first, so the body of a <script>
  // the source app included does not arrive as visible text.
  textOf(html) {
    const holder = this.doc.createElement("div");
    holder.innerHTML = sanitize(html);
    // A paragraph boundary is a word boundary. Plain textContent would run the
    // last word of one block into the first word of the next.
    for (const el of [...holder.querySelectorAll(BLOCKISH + ", br")]) el.before(" ");
    return holder.textContent;
  }

  // ---- commands -----------------------------------------------------------

  exec(cmd, value = null) { try { this.doc.execCommand(cmd, false, value); } catch {} }

  // A list is flow content, so it needs the guard block() has: asked for one
  // inside a single line, the browser puts a <ul> inside the host and the next
  // parse rearranges it. The buttons are hidden there too, so this only catches
  // the keyboard shortcut and the "- " input rule.
  list(cmd) {
    const host = this.activeHost();
    if (!host || tokensOf(host).has("single-line")) return;
    this.exec(cmd);
    this.normalise(host);
  }

  block(tag) {
    const host = this.activeHost();
    if (!host || tokensOf(host).has("single-line")) return;
    // Leaving a list needs the list command toggled off, not a formatBlock.
    if (this.state().list && tag) {
      this.exec(this.state().list === "ul" ? "insertUnorderedList" : "insertOrderedList");
    }
    this.exec("formatBlock", `<${tag.toLowerCase()}>`);
    this.normalise(host);
  }

  link() {
    // A host that is itself a link -- a button block's <a> -- is already the
    // link, and state() never notices, because it only walks up as far as the
    // host. Asked to create one anyway, the browser makes a link inside a link
    // by splitting the host, which is the other way a page grows a second empty
    // button. Edit the anchor that is already there instead, which is also the
    // only way to change where a button points.
    const own = this.activeHost()?.closest("a");
    if (own) return this.retarget(own);

    const sel = this.doc.getSelection();
    if (!sel || sel.isCollapsed) return;
    const existing = this.state().link;
    if (existing) return this.exec("unlink");
    const url = this.doc.defaultView.prompt("Link to:", "https://");
    if (!url) return;
    if (!SAFE_URL.test(url)) return;
    this.exec("createLink", url);
  }

  // Point an existing anchor somewhere else, or clear it. Emptying the box
  // removes the href rather than the element: the element is the button.
  retarget(a) {
    const url = this.doc.defaultView.prompt("Link to:", a.getAttribute("href") || "https://");
    if (url === null) return;
    if (!url.trim()) { a.removeAttribute("href"); this.nc.dirty = true; return; }
    if (!SAFE_URL.test(url.trim())) return;
    a.setAttribute("href", url.trim());
    this.nc.dirty = true;
  }

  // execCommand output varies by engine. Strip the debris it leaves behind so
  // the bytes on disk are markup a person would have written by hand.
  normalise(host) {
    for (const el of [...host.querySelectorAll("font, span[style]")]) {
      el.replaceWith(...el.childNodes);
    }
    for (const el of [...host.querySelectorAll("[style]")]) el.removeAttribute("style");
    for (const el of [...host.querySelectorAll("div")]) {
      if (el.closest("pre, blockquote, li")) continue;
      const p = this.doc.createElement("p");
      p.append(...el.childNodes);
      el.replaceWith(p);
    }

    // An <a> inside an <a> is not something the HTML parser can represent. It
    // gets into the live DOM when an editing command splits the host to make
    // room for what it was told to insert, and it stays there, looking fine,
    // until a save writes it out and the next load reads it back as two
    // siblings. Unwrapping it here is what stops that becoming bytes.
    for (const el of [...host.querySelectorAll("a a")]) el.replaceWith(...el.childNodes);

    // An inline host cannot hold boxes. Keep the words and drop the boxes,
    // rather than leave markup the parser will rearrange behind our back.
    if (INLINE.has(host.tagName) || host.closest("a")) {
      for (const el of [...host.querySelectorAll(BLOCKISH)]) el.replaceWith(...el.childNodes);
    }

    // One line means one line, however the break got in -- a pasted "a\nb"
    // reaches insertText as a <br> rather than as two blocks.
    if (tokensOf(host).has("single-line")) {
      for (const el of [...host.querySelectorAll("br")]) el.replaceWith(" ");
    }
  }

  state() {
    const q = (c) => { try { return this.doc.queryCommandState(c); } catch { return false; } };
    const host = this.activeHost();
    let block = "P", list = null, link = false;
    if (host) {
      const sel = this.doc.getSelection();
      let el = sel?.anchorNode?.nodeType === 1 ? sel.anchorNode : sel?.anchorNode?.parentElement;
      while (el && el !== host) {
        const t = el.tagName;
        if (!list && (t === "UL" || t === "OL")) list = t.toLowerCase();
        if (t === "A") link = true;
        if (!list && ["H1", "H2", "H3", "BLOCKQUOTE", "PRE", "P"].includes(t)) { block = t; break; }
        el = el.parentElement;
      }
    }
    return { bold: q("bold"), italic: q("italic"), strikeThrough: q("strikeThrough"), block, list, link, host };
  }

  // ---- the floating toolbar ------------------------------------------------

  buildBar() {
    if (this.bar) return this.bar;
    const bar = this.doc.createElement("div");
    bar.setAttribute("nc:chrome", "");        // stripped from every save
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Text formatting");
    // Styled from the page's own variables, so the toolbar belongs to the
    // document rather than looking like a visitor from another application.
    bar.style.cssText = "position:absolute;z-index:2147483646;display:none;gap:2px;align-items:center;" +
      "padding:4px;border-radius:var(--nc-radius,9px);" +
      "background:var(--nc-panel,#14181c);color:var(--nc-ink,#eef2f4);" +
      "border:1px solid var(--nc-edge,transparent);" +
      "box-shadow:var(--nc-shadow,0 10px 30px -12px rgba(0,0,0,.7));" +
      "font:13px/1 var(--nc-chrome-font,ui-sans-serif,system-ui,sans-serif)";

    const mk = (tag, css, attrs = {}) => {
      const el = this.doc.createElement(tag);
      el.style.cssText = css;
      Object.assign(el, attrs);
      return el;
    };
    const btnCss = "font:inherit;cursor:pointer;border:0;border-radius:var(--nc-radius-sm,6px);" +
      "background:transparent;color:inherit;padding:5px 8px;min-width:28px";

    const select = mk("select", btnCss + ";background:var(--nc-bg,#1e242a);color:inherit;padding:5px 6px", { title: "Block style" });
    for (const b of BLOCKS) {
      const o = this.doc.createElement("option");
      o.value = b.cmd; o.textContent = b.label;
      select.appendChild(o);
    }
    select.onchange = () => { this.block(select.value); this.nc.dirty = true; this.syncBar(); };
    bar.appendChild(select);
    this.select = select;

    const sep = () => bar.appendChild(mk("span", "width:1px;height:18px;background:var(--nc-edge,#39424a);margin:0 3px"));
    sep();

    this.markBtns = [];
    for (const m of MARKS) {
      const b = mk("button", btnCss + ";" + m.style, { type: "button", title: m.label, textContent: m.glyph });
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => { this.exec(m.cmd); this.nc.dirty = true; this.syncBar(); };
      bar.appendChild(b);
      this.markBtns.push([b, m.cmd]);
    }
    sep();

    this.listBtns = [];
    for (const [cmd, title, glyph] of [
      ["insertUnorderedList", "Bulleted list", "\u2022 \u2013"],
      ["insertOrderedList", "Numbered list", "1."],
    ]) {
      const b = mk("button", btnCss, { type: "button", title, textContent: glyph });
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => { this.list(cmd); this.nc.dirty = true; this.syncBar(); };
      bar.appendChild(b);
      this.listBtns.push(b);
    }

    const linkBtn = mk("button", btnCss, { type: "button", title: "Link (⌘K)", textContent: "🔗" });
    linkBtn.onmousedown = (e) => e.preventDefault();
    linkBtn.onclick = () => { this.link(); this.nc.dirty = true; this.syncBar(); };
    bar.appendChild(linkBtn);

    sep();

    // Block-level inserts. They act at the caret, which is why they live on the
    // same toolbar as the text controls rather than in a separate menu.
    for (const [title, glyph, run] of [
      ["Insert an image", "🖼", () => this.nc.media.promptImage()],
      ["Insert a video", "🎬", () => this.nc.media.promptVideo()],
      ["Insert a Nostr feed", "⚡", () => this.nc.feed.promptInsert()],
    ]) {
      const b = mk("button", btnCss, { type: "button", title, textContent: glyph });
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => { this.hideBar(); run(); };
      bar.appendChild(b);
    }
    sep();

    const clear = mk("button", btnCss, { type: "button", title: "Clear formatting", textContent: "⌫" });
    clear.onmousedown = (e) => e.preventDefault();
    clear.onclick = () => {
      this.exec("removeFormat"); this.exec("unlink");
      const h = this.activeHost(); if (h) this.normalise(h);
      this.nc.dirty = true; this.syncBar();
    };
    bar.appendChild(clear);

    this.doc.body.appendChild(bar);
    this.bar = bar;
    return bar;
  }

  hideBar() { if (this.bar) this.bar.style.display = "none"; }

  syncBar() {
    if (!this.on) return;
    const st = this.state();
    const host = st.host;
    if (!host || tokensOf(host).has("no-toolbar")) return this.hideBar();
    const sel = this.doc.getSelection();
    if (!sel || !sel.rangeCount) return this.hideBar();
    if (tokensOf(host).has("toolbar-on-select") && sel.isCollapsed) return this.hideBar();

    const bar = this.buildBar();
    bar.style.display = "flex";
    // A collapsed caret has a zero-width rect in some engines; fall back to the
    // block the caret sits in so the toolbar never lands at the page origin.
    let r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) r = (this.host(sel.anchorNode) || host).getBoundingClientRect();
    const win = this.doc.defaultView;
    const top = r.top + win.scrollY - bar.offsetHeight - 8;
    const left = r.left + win.scrollX + r.width / 2 - bar.offsetWidth / 2;
    bar.style.top = Math.max(win.scrollY + 4, top) + "px";
    bar.style.left = Math.max(4, Math.min(left, win.innerWidth - bar.offsetWidth - 4)) + "px";

    // A single line takes no blocks and no lists, so the controls that would
    // make one are not offered there rather than offered and refused.
    const single = tokensOf(host).has("single-line");
    this.select.style.display = single ? "none" : "";
    for (const b of this.listBtns) b.style.display = single ? "none" : "";
    this.select.value = st.list ? "P" : st.block;
    for (const [b, cmd] of this.markBtns) {
      b.style.background = st[cmd] ? "color-mix(in srgb, var(--nc-accent, #31404b) 30%, transparent)" : "transparent";
    }
  }
}

function blockEnter(e) { if (e.key === "Enter") e.preventDefault(); }
