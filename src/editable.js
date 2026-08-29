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
    el.spellcheck = true;
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
    if (e.shiftKey && k === "7") return run(() => this.exec("insertOrderedList"));
    if (e.shiftKey && k === "8") return run(() => this.exec("insertUnorderedList"));
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
    if (tokensOf(host).has("no-markdown")) return;
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
  onPaste(e) {
    const host = this.activeHost();
    if (!host) return;
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (html) this.exec("insertHTML", sanitize(html));
    else this.exec("insertText", text);
    this.normalise(host);
    this.nc.dirty = true;
  }

  // ---- commands -----------------------------------------------------------

  exec(cmd, value = null) { try { this.doc.execCommand(cmd, false, value); } catch {} }

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
    const sel = this.doc.getSelection();
    if (!sel || sel.isCollapsed) return;
    const existing = this.state().link;
    if (existing) return this.exec("unlink");
    const url = this.doc.defaultView.prompt("Link to:", "https://");
    if (!url) return;
    if (!/^(https?:|mailto:|#|\/)/i.test(url)) return;   // same rule the sanitiser uses
    this.exec("createLink", url);
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

    const listBtns = [
      ["insertUnorderedList", "Bulleted list", "\u2022 \u2013"],
      ["insertOrderedList", "Numbered list", "1."],
    ];
    for (const [cmd, title, glyph] of listBtns) {
      const b = mk("button", btnCss, { type: "button", title, textContent: glyph });
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => { this.exec(cmd); this.nc.dirty = true; this.syncBar(); };
      bar.appendChild(b);
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

    const single = tokensOf(host).has("single-line");
    this.select.style.display = single ? "none" : "";
    this.select.value = st.list ? "P" : st.block;
    for (const [b, cmd] of this.markBtns) {
      b.style.background = st[cmd] ? "color-mix(in srgb, var(--nc-accent, #31404b) 30%, transparent)" : "transparent";
    }
  }
}

function blockEnter(e) { if (e.key === "Enter") e.preventDefault(); }
