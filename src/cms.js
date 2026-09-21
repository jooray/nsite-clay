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
import { sanitizeAs } from "./sanitize.js";

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
  if (attr === "innerHTML") return sanitizeAs(el.localName, el.innerHTML, el.ownerDocument);
  if (BOOL.has(attr)) return attr in el ? !!el[attr] : el.hasAttribute(attr);
  if (attr === "value" && "value" in el) return el.value;
  return el.getAttribute(attr) ?? "";
}

function writeOne(el, attr, value) {
  if (!el) return;
  if (!attr) { el.textContent = value; return; }
  if (attr === "innerHTML") { el.innerHTML = sanitizeAs(el.localName, String(value), el.ownerDocument); return; }
  if (BOOL.has(attr)) {
    if (attr in el) el[attr] = !!value;
    value ? el.setAttribute(attr, "") : el.removeAttribute(attr);
    return;
  }
  if (attr === "value" && "value" in el) { el.value = value; return; }
  value === "" ? el.removeAttribute(attr) : el.setAttribute(attr, value);
}

function validateValue(el, attr, value) {
  if (!el) throw new Error("The field no longer exists on the page.");
  if (/^(on|nc:)/i.test(attr || "") || ["srcdoc", "style"].includes(attr)) throw new Error("This attribute cannot be changed through the content form.");
  if (BOOL.has(attr) && typeof value !== "boolean") throw new Error("Choose on or off for this field.");
  if (!BOOL.has(attr) && !["string", "number"].includes(typeof value)) throw new Error("This field needs text or a number.");
  if (["href", "src", "action", "formaction"].includes(attr) && value !== "") {
    const protocol = new URL(String(value), el.ownerDocument.baseURI).protocol;
    if (!["http:", "https:", "mailto:", "tel:"].includes(protocol)) throw new Error("Use a web address, email address or phone link.");
  }
}

const LEAF = Symbol("content field");
function bindings(spec, root) {
  if (Array.isArray(spec)) {
    return [...root.querySelectorAll(spec[0])].filter((el) => !el.hasAttribute("nc:cms-template"))
      .map((el) => bindings(spec[1], el));
  }
  if (spec && typeof spec === "object") return Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, bindings(v, root)]));
  const list = String(spec).endsWith("[]");
  const { selector, attr } = parseTarget(list ? spec.slice(0, -2) : spec);
  if (list) return [...root.querySelectorAll(selector)].filter((el) => !el.hasAttribute("nc:cms-template")).map((el) => ({ [LEAF]: true, el, attr }));
  return { [LEAF]: true, el: root.querySelector(selector), attr };
}
function extract(bound) {
  if (bound[LEAF]) return readOne(bound.el, bound.attr);
  if (Array.isArray(bound)) return bound.map(extract);
  return Object.fromEntries(Object.entries(bound).map(([k, v]) => [k, extract(v)]));
}
function planWrites(bound, values, out) {
  if (bound[LEAF]) { validateValue(bound.el, bound.attr, values); out.push([bound.el, bound.attr, values]); return; }
  if (Array.isArray(bound)) {
    if (!Array.isArray(values) || values.length !== bound.length) throw new Error("Use the list controls to add or remove items before updating their values.");
    values.forEach((value, i) => planWrites(bound[i], value, out)); return;
  }
  if (!values || Array.isArray(values) || typeof values !== "object") throw new Error("A group needs an object of field values.");
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(bound, key)) throw new Error(`Unknown content field: ${key}`);
    planWrites(bound[key], value, out);
  }
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

  getData(name = "cms") {
    const rules = this.rules(name);
    if (!rules) throw new Error("This page has no content rules.");
    return extract(bindings(rules, this.doc));
  }

  write(el, attr, value) {
    if (!this.nc.isOwner) throw new Error("Only the owner can change this page.");
    validateValue(el, attr, value);
    if (attr && (attr === "value" || BOOL.has(attr)) && attr in el) {
      this.nc.undo.recordValue(el, { prop: attr, oldValue: el[attr], newValue: value });
    }
    writeOne(el, attr, value);
    this.nc.dirty = true;
  }

  setData(values, name = "cms") {
    if (!this.nc.isOwner) throw new Error("Only the owner can change this page.");
    const rules = this.rules(name);
    if (!rules) throw new Error("This page has no content rules.");
    const writes = [];
    planWrites(bindings(rules, this.doc), values, writes);
    this.nc.undo.commit("Update page content", () => { for (const args of writes) this.write(...args); });
    this.nc.editable.refresh();
    if (this.isOpen) this.open(this.name);
    this.nc._emit("nsiteclay:cms", { values });
    return this.getData(name);
  }

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
    this.name = name;
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
    const label = this.label(wrap, key);

    if (!el) {
      const miss = this.doc.createElement("p");
      miss.className = "nc-cms-note";
      miss.textContent = `nothing matches ${selector}`;
      wrap.appendChild(miss);
      host.appendChild(wrap);
      return wrap;
    }

    const current = readOne(el, attr);
    const type = el.getAttribute("nc:cms-type") || el.getAttribute("data-hcms-component") || "";
    const rich = attr === "innerHTML";
    let input;

    if (rich) {
      input = this.doc.createElement("div");
      input.setAttribute("editable", ""); input.setAttribute("role", "textbox");
      input.setAttribute("aria-multiline", "true");
      input.innerHTML = current; this.nc.editable.arm(input);
      wrap.appendChild(input);
    } else if (type === "select") {
      input = this.doc.createElement("select");
      const choices = JSON.parse(el.getAttribute("nc:cms-options") || el.getAttribute("data-hcms-options") || "[]");
      if (!Array.isArray(choices) || !choices.length) throw new Error("A select field needs a JSON list in nc:cms-options.");
      for (const choice of choices) {
        const o = this.doc.createElement("option");
        o.value = typeof choice === "object" ? choice.value : choice;
        o.textContent = typeof choice === "object" ? choice.label : choice; input.append(o);
      }
      input.value = current; wrap.append(input);
    } else if (typeof current === "boolean") {
      input = this.doc.createElement("input");
      input.type = "checkbox";
      input.checked = current;
      wrap.classList.add("nc-cms-check");
      wrap.prepend(input);
    } else if (type === "textarea" || (!attr && (String(current).length > 70 || /\n/.test(current)))) {
      input = this.doc.createElement("textarea");
      input.rows = Math.min(10, Math.max(3, String(current).split(/\n/).length + 1));
      input.value = current;
      wrap.appendChild(input);
    } else {
      input = this.doc.createElement("input");
      input.type = ["number", "date", "time", "url", "email", "color"].includes(type) ? type : "text";
      input.value = current;
      wrap.appendChild(input);
    }
    input.className = "nc-input";
    input.id = "nc-cms-" + Math.random().toString(36).slice(2);
    label.htmlFor = input.id;
    if (rich) { label.id = input.id + "-label"; input.setAttribute("aria-labelledby", label.id); }
    for (const constraint of ["min", "max", "step", "required", "pattern", "maxlength"]) {
      const value = el.getAttribute("nc:cms-" + constraint);
      if (value !== null) input.setAttribute(constraint, value);
    }
    const error = this.doc.createElement("p"); error.className = "nc-cms-note"; error.setAttribute("role", "alert");

    const commit = () => {
      input.setCustomValidity?.("");
      if (input.checkValidity && !input.checkValidity()) { error.textContent = input.validationMessage; return; }
      try {
        this.write(el, attr, rich ? input.innerHTML : input.type === "checkbox" ? input.checked : input.value);
        error.textContent = "";
        this.nc._emit("nsiteclay:cms", { key, element: el });
      } catch (e) { error.textContent = e.message; }
    };
    input.addEventListener("input", commit);
    input.addEventListener("change", commit);
    wrap.append(error);

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
.nc-cms input:not([type=checkbox]), .nc-cms textarea, .nc-cms select, .nc-cms [role=textbox] { width: 100%; box-sizing: border-box;
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
