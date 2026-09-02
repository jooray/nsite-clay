// A form for the page, generated from the page.
//
// Clicking into a document to change it is fine for someone who wrote it and
// knows where everything is. It is not fine for the person who inherits it and
// only wants to change the price, the date and the third paragraph. HyperClay
// solves that with a rules block mapping field names to CSS selectors and a
// sidebar generated from it, which is a good idea and this is it.
//
// The rules live in the document, so they are published with it:
//
//   <script type="application/json" nc:cms>
//   {
//     "title":   ".site-title",
//     "hero":    "img.hero@src",
//     "open":    ".status@data-open",
//     "tags":    ".tag[]",
//     "posts":   [".post", { "heading": ".post-title", "body": ".post-body" }]
//   }
//   </script>
//
// Nothing here is a database. Every field reads and writes the DOM directly, so
// the page you are looking at is the state, and Save publishes it like any other
// edit.
import { toast } from "./ui.js";

// ".post-title@data-x" -> { selector: ".post-title", attr: "data-x" }
// A bare selector means the element's text.
function parseTarget(spec) {
  const at = String(spec).lastIndexOf("@");
  // An @ inside a selector (an attribute selector, say) is not a field marker,
  // so only a trailing @name counts.
  if (at > 0 && /^[a-zA-Z_:][\w:.-]*$/.test(spec.slice(at + 1))) {
    return { selector: spec.slice(0, at).trim(), attr: spec.slice(at + 1) };
  }
  return { selector: String(spec).trim(), attr: null };
}

const BOOL = new Set(["checked", "selected", "disabled", "hidden", "open"]);

function readOne(el, attr) {
  if (!el) return "";
  if (!attr) return el.textContent.trim();
  if (BOOL.has(attr)) return attr in el ? !!el[attr] : el.hasAttribute(attr);
  if (attr === "value" && "value" in el) return el.value;
  return el.getAttribute(attr) ?? "";
}

function writeOne(el, attr, value) {
  if (!el) return;
  if (!attr) { el.textContent = value; return; }
  if (BOOL.has(attr)) {
    if (attr in el) el[attr] = !!value;
    value ? el.setAttribute(attr, "") : el.removeAttribute(attr);
    return;
  }
  if (attr === "value" && "value" in el) { el.value = value; return; }
  value === "" ? el.removeAttribute(attr) : el.setAttribute(attr, value);
}

export class Cms {
  constructor(nc) {
    this.nc = nc;
    this.doc = nc.doc;
    this.panel = null;
  }

  // The rules block, by name. A page may carry more than one.
  rules(name = "cms") {
    const sel = name === "cms"
      ? 'script[nc\\:cms], script[nc\\:cms="cms"]'
      : `script[nc\\:cms="${CSS.escape(name)}"]`;
    const el = this.doc.querySelector(sel);
    if (!el) return null;
    try { return JSON.parse(el.textContent || "{}"); }
    catch (e) { throw new Error(`The nc:cms rules are not valid JSON: ${e.message}`); }
  }

  get isOpen() { return !!this.panel?.isConnected; }

  toggle(name) { return this.isOpen ? this.close() : this.open(name); }

  close() {
    this.panel?.remove();
    this.panel = null;
    this.doc.documentElement.removeAttribute("nc:cms-open");
    return null;
  }

  open(name = "cms") {
    if (!this.nc.isOwner) { toast("Only the owner can edit this page.", { doc: this.doc }); return null; }
    let rules;
    try { rules = this.rules(name); }
    catch (e) { toast(e.message, { doc: this.doc }); return null; }
    if (!rules) {
      toast('No <script type="application/json" nc:cms> block on this page.', { doc: this.doc });
      return null;
    }
    this.close();
    this.injectStyles();

    const panel = this.doc.createElement("aside");
    panel.className = "nc-cms";
    // Runtime chrome: it is removed from the save, so it never reaches a reader
    // and never appears in the published file.
    panel.setAttribute("nc:chrome", "");

    const head = this.doc.createElement("header");
    const h = this.doc.createElement("strong");
    h.textContent = "Page content";
    const x = this.doc.createElement("button");
    x.type = "button"; x.className = "nc-cms-x"; x.textContent = "Close";
    x.onclick = () => this.close();
    head.append(h, x);

    const body = this.doc.createElement("div");
    body.className = "nc-cms-body";

    const note = this.doc.createElement("p");
    note.className = "nc-cms-note";
    note.textContent = "Changes land on the page as you type. Press Save to publish them.";

    for (const [key, spec] of Object.entries(rules)) {
      try { this.buildField(body, key, spec, this.doc); }
      catch (e) {
        const bad = this.doc.createElement("p");
        bad.className = "nc-cms-note";
        bad.textContent = `${key}: ${e.message}`;
        body.appendChild(bad);
      }
    }

    panel.append(head, note, body);
    this.doc.body.appendChild(panel);
    this.panel = panel;
    this.doc.documentElement.setAttribute("nc:cms-open", "true");
    return panel;
  }

  // ---- fields --------------------------------------------------------------

  label(host, text) {
    const l = this.doc.createElement("label");
    l.className = "nc-cms-label";
    l.textContent = text;
    host.appendChild(l);
    return l;
  }

  // One scalar bound to one element.
  buildField(host, key, spec, root) {
    if (Array.isArray(spec)) return this.buildList(host, key, spec, root);
    if (spec && typeof spec === "object") return this.buildGroup(host, key, spec, root);

    const s = String(spec);
    if (s.endsWith("[]")) return this.buildScalarList(host, key, s.slice(0, -2), root);

    const { selector, attr } = parseTarget(s);
    const el = root.querySelector(selector);
    const wrap = this.doc.createElement("div");
    wrap.className = "nc-cms-field";
    this.label(wrap, key);

    if (!el) {
      const miss = this.doc.createElement("p");
      miss.className = "nc-cms-note";
      miss.textContent = `nothing matches ${selector}`;
      wrap.appendChild(miss);
      host.appendChild(wrap);
      return wrap;
    }

    const current = readOne(el, attr);
    let input;

    if (typeof current === "boolean") {
      input = this.doc.createElement("input");
      input.type = "checkbox";
      input.checked = current;
      wrap.classList.add("nc-cms-check");
      wrap.prepend(input);
    } else if (!attr && (String(current).length > 70 || /\n/.test(current))) {
      input = this.doc.createElement("textarea");
      input.rows = Math.min(10, Math.max(3, String(current).split(/\n/).length + 1));
      input.value = current;
      wrap.appendChild(input);
    } else {
      input = this.doc.createElement("input");
      input.type = "text";
      input.value = current;
      wrap.appendChild(input);
    }
    input.className = "nc-input";

    const commit = () => {
      writeOne(el, attr, input.type === "checkbox" ? input.checked : input.value);
      this.nc.dirty = true;
      this.nc._emit("nsiteclay:cms", { key, element: el });
    };
    input.addEventListener("input", commit);
    input.addEventListener("change", commit);

    // A picture field is worth a picker rather than a URL to paste by hand.
    if (attr === "src" && el.tagName === "IMG" && this.nc.media?.promptImage) {
      const pick = this.doc.createElement("button");
      pick.type = "button"; pick.className = "nc-cms-pick"; pick.textContent = "Choose a picture";
      pick.onclick = async () => {
        const picked = await this.nc.media.promptImage({ target: el }).catch(() => null);
        if (picked) { input.value = el.getAttribute("src") || ""; this.nc.dirty = true; }
      };
      wrap.appendChild(pick);
    }

    host.appendChild(wrap);
    return wrap;
  }

  // { "author": { "name": ".name", "url": "a.site@href" } }
  buildGroup(host, key, spec, root) {
    const box = this.doc.createElement("fieldset");
    box.className = "nc-cms-group";
    const legend = this.doc.createElement("legend");
    legend.textContent = key;
    box.appendChild(legend);
    for (const [k, v] of Object.entries(spec)) this.buildField(box, k, v, root);
    host.appendChild(box);
    return box;
  }

  // ".tag[]" — many elements, one value each.
  buildScalarList(host, key, selector, root) {
    const box = this.doc.createElement("fieldset");
    box.className = "nc-cms-group";
    const legend = this.doc.createElement("legend");
    legend.textContent = key;
    box.appendChild(legend);

    const { selector: sel, attr } = parseTarget(selector);
    const draw = () => {
      [...box.querySelectorAll(".nc-cms-row")].forEach((n) => n.remove());
      const els = [...root.querySelectorAll(sel)];
      for (const el of els) {
        const row = this.doc.createElement("div");
        row.className = "nc-cms-row";
        const input = this.doc.createElement("input");
        input.type = "text"; input.className = "nc-input";
        input.value = readOne(el, attr);
        input.addEventListener("input", () => {
          writeOne(el, attr, input.value);
          this.nc.dirty = true;
        });
        const del = this.doc.createElement("button");
        del.type = "button"; del.textContent = "Remove";
        del.onclick = () => { this.nc.dom.remove(el); draw(); };
        row.append(input, del);
        box.insertBefore(row, box.lastElementChild?.classList?.contains("nc-cms-add")
          ? box.lastElementChild : null);
      }
    };

    const add = this.doc.createElement("button");
    add.type = "button"; add.className = "nc-cms-add"; add.textContent = `Add ${key}`;
    add.onclick = () => {
      const els = [...root.querySelectorAll(sel)];
      const last = els[els.length - 1];
      if (!last) { toast(`Nothing matches ${sel} to copy.`, { doc: this.doc }); return; }
      const copy = this.nc.dom.clone(last);
      writeOne(copy, attr, "");
      draw();
    };
    box.appendChild(add);
    draw();
    host.appendChild(box);
    return box;
  }

  // [".post", { "heading": ".post-title" }] — a card per match.
  buildList(host, key, spec, root) {
    const [itemSel, shape] = spec;
    const box = this.doc.createElement("fieldset");
    box.className = "nc-cms-group nc-cms-list";
    const legend = this.doc.createElement("legend");
    legend.textContent = key;
    box.appendChild(legend);

    const add = this.doc.createElement("button");
    add.type = "button"; add.className = "nc-cms-add"; add.textContent = `Add ${key}`;

    const draw = () => {
      [...box.querySelectorAll(".nc-cms-card")].forEach((n) => n.remove());
      // A template item is the shape to copy and is not itself content.
      const items = [...root.querySelectorAll(itemSel)].filter((el) => !el.hasAttribute("nc:cms-template"));
      for (const el of items) {
        const card = this.doc.createElement("div");
        card.className = "nc-cms-card";
        const bar = this.doc.createElement("div");
        bar.className = "nc-cms-cardbar";

        const mk = (text, fn, title) => {
          const b = this.doc.createElement("button");
          b.type = "button"; b.textContent = text;
          if (title) b.title = title;
          b.onclick = fn;
          return b;
        };
        bar.append(
          mk("↑", () => { this.nc.dom.move(el, -1, itemSel); draw(); }, "Move up"),
          mk("↓", () => { this.nc.dom.move(el, 1, itemSel); draw(); }, "Move down"),
          mk("Duplicate", () => { this.nc.dom.clone(el); draw(); }),
          mk("Remove", async () => {
            const ok = await this.nc.dom.removeClosestAsk(el, itemSel, `this ${key.replace(/s$/, "")}`);
            if (ok) draw();
          }),
        );
        card.appendChild(bar);
        for (const [k, v] of Object.entries(shape)) this.buildField(card, k, v, el);
        box.insertBefore(card, add);
      }
      if (!items.length) {
        const none = this.doc.createElement("p");
        none.className = "nc-cms-note nc-cms-card";
        none.textContent = `nothing matches ${itemSel} yet`;
        box.insertBefore(none, add);
      }
    };

    add.onclick = () => {
      const tpl = root.querySelector(`${itemSel}[nc\\:cms-template]`);
      const all = [...root.querySelectorAll(itemSel)];
      const source = tpl || all[all.length - 1];
      if (!source) { toast(`Nothing matches ${itemSel} to copy.`, { doc: this.doc }); return; }
      const copy = this.nc.dom.clone(source);
      copy.removeAttribute("nc:cms-template");
      copy.removeAttribute("hidden");
      draw();
    };

    box.appendChild(add);
    draw();
    host.appendChild(box);
    return box;
  }

  // The base stylesheet carries these. Inject a plain fallback only when it is
  // absent, so a template that restyled the panel keeps its version.
  injectStyles() {
    if (this._styled) return;
    this._styled = true;
    const styled = getComputedStyle(this.doc.documentElement)
      .getPropertyValue("--nc-radius").trim();
    if (styled) return;
    const s = this.doc.createElement("style");
    s.setAttribute("nc:chrome", "");
    s.textContent = `
.nc-cms * { display: revert; position: static; float: none; margin: revert;
  padding: revert; width: revert; height: revert; max-width: none; max-height: none; }
.nc-cms { display: block; position: fixed; top: 0; right: 0; bottom: 0; width: min(23rem, 100%);
  background: #14121b; color: #eee; border-left: 1px solid #332f3f; z-index: 2147483000;
  overflow-y: auto; padding: 1rem; font: 14px/1.5 system-ui, sans-serif; }
.nc-cms header { display: flex; justify-content: space-between; align-items: center;
  gap: .5rem; margin-bottom: .5rem; }
.nc-cms button { font: inherit; padding: .3rem .6rem; border-radius: 8px;
  border: 1px solid #423c52; background: #1e1a28; color: inherit; cursor: pointer; }
.nc-cms input[type=text], .nc-cms textarea { width: 100%; box-sizing: border-box;
  font: inherit; padding: .4rem .55rem; border-radius: 8px; border: 1px solid #423c52;
  background: #0f0d15; color: inherit; }
.nc-cms-field { margin: 0 0 .75rem; }
.nc-cms-label { display: block; font-size: .78rem; text-transform: uppercase;
  letter-spacing: .06em; opacity: .65; margin-bottom: .25rem; }
.nc-cms-check { display: flex; align-items: center; gap: .5rem; }
.nc-cms-check .nc-cms-label { margin: 0; text-transform: none; letter-spacing: 0; }
.nc-cms-group { border: 1px solid #332f3f; border-radius: 10px; padding: .7rem;
  margin: 0 0 .9rem; }
.nc-cms-group legend { padding: 0 .35rem; font-size: .78rem; text-transform: uppercase;
  letter-spacing: .06em; opacity: .65; }
.nc-cms-card { border: 1px solid #2b2735; border-radius: 8px; padding: .6rem;
  margin-bottom: .6rem; }
.nc-cms-cardbar, .nc-cms-row { display: flex; gap: .3rem; margin-bottom: .5rem; }
.nc-cms-row input { flex: 1; }
.nc-cms-note { font-size: .82rem; opacity: .6; margin: 0 0 .8rem; }
.nc-cms-pick { margin-top: .35rem; }
@media (max-width: 620px) { .nc-cms { width: 100%; } }`;
    this.doc.head.appendChild(s);
  }
}
