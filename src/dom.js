// Structural editing, and state that has no visual form.
//
// A page whose content is prose needs a text editor. A page that is a board, a
// checklist or a directory needs to duplicate a card, delete a row and move
// things around, and the DOM is already the database for all of it: the cards
// are the records. What was missing is a set of operations that do the bookkeeping
// (arm the new markup for editing, mark the page unsaved) so a template does not
// have to remember, and so a control can be one attribute instead of a closure.
//
// Nothing here sanitises. This is the owner's own document and they may put what
// they like in it; sanitising applies to pasted content and to other people's
// events, which is a different problem handled elsewhere.
import { modal, toast } from "./ui.js";

const closestOf = (el, selector) =>
  selector ? el.closest(selector) : el.closest("[nc\\:block]") || el.parentElement;

export class Dom {
  constructor(nc) { this.nc = nc; this.doc = nc.doc; }

  // Everything that changes the document goes through here, so there is one
  // place that remembers to arm new regions and mark the page dirty.
  _changed(node) {
    this.nc.editable.refresh();
    this.nc.dirty = true;
    this.nc._emit("nsiteclay:dom", { node });
    return node;
  }

  // ---- the operations a page actually needs -------------------------------

  // Bookkeeping for markup that arrived some other way. Anything built by hand
  // and put into the page still has to be armed for editing and still has to
  // mark the page unsaved, and this is that step without a second copy of it.
  armed(node) { return this._changed(node); }

  clone(el, { after = true } = {}) {
    if (!el) return null;
    const copy = el.cloneNode(true);
    // A copy is a new thing. Anything that identified the original would make
    // two elements claim to be the same one, and anything pointing at one of
    // those ids now points somewhere the copy cannot see: a duplicated
    // <label for="x"> would focus the original's input. Drop both ends rather
    // than leave a reference that quietly does the wrong thing.
    for (const n of [copy, ...copy.querySelectorAll("[id]")]) n.removeAttribute?.("id");
    for (const n of [copy, ...copy.querySelectorAll("[for], [aria-labelledby], [aria-describedby], [aria-controls]")]) {
      for (const a of ["for", "aria-labelledby", "aria-describedby", "aria-controls"]) n.removeAttribute?.(a);
    }
    el[after ? "after" : "before"](copy);
    return this._changed(copy);
  }

  remove(el) {
    if (!el) return null;
    const parent = el.parentElement;
    el.remove();
    return this._changed(parent);
  }

  // Move within the siblings that matter, skipping text nodes and anything the
  // page does not consider part of the list.
  move(el, direction = 1, selector = null) {
    if (!el?.parentElement) return null;
    const siblings = selector
      ? [...el.parentElement.querySelectorAll(`:scope > ${selector}`)]
      : [...el.parentElement.children];
    const i = siblings.indexOf(el);
    const j = i + (direction < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= siblings.length) return el;
    direction < 0 ? siblings[j].before(el) : siblings[j].after(el);
    return this._changed(el);
  }

  // Put markup somewhere. `where` takes the insertAdjacentHTML positions.
  insert(target, html, where = "beforeend") {
    if (!target) return null;
    target.insertAdjacentHTML(where, html);
    const added = where === "beforeend" ? target.lastElementChild
      : where === "afterbegin" ? target.firstElementChild
      : where === "beforebegin" ? target.previousElementSibling
      : target.nextElementSibling;
    return this._changed(added);
  }

  // Add a copy of a <template> to a container. The tidiest way to have an
  // "add another" button: the shape lives in the markup rather than in a string
  // inside a script.
  addFrom(templateId, container, where = "beforeend") {
    const tpl = this.doc.getElementById(templateId);
    if (!tpl || !("content" in tpl)) throw new Error(`No <template id="${templateId}">`);
    const host = typeof container === "string" ? this.doc.querySelector(container) : container;
    if (!host) throw new Error("No container to add to");
    const node = tpl.content.firstElementChild.cloneNode(true);
    where === "afterbegin" ? host.prepend(node) : host.append(node);
    return this._changed(node);
  }

  // Move a node into a different container. `move` only reorders within one
  // parent, which is not enough for a board: a card going from one column to
  // the next crosses parents, and that is the operation the whole pattern rests
  // on. The node itself travels, so whatever was typed into it comes along.
  moveTo(el, container, where = "beforeend") {
    if (!el) return null;
    const host = typeof container === "string" ? this.doc.querySelector(container) : container;
    if (!host || host === el || el.contains(host)) return null;   // never into its own descendant
    where === "afterbegin" ? host.prepend(el) : host.append(el);
    return this._changed(el);
  }

  toggle(el, className = "hidden") {
    if (!el) return null;
    el.classList.toggle(className);
    return this._changed(el);
  }

  set(el, name, value) {
    if (!el) return null;
    value === null || value === false ? el.removeAttribute(name) : el.setAttribute(name, String(value));
    return this._changed(el);
  }

  // ---- the same operations, addressed from a control inside the block -----
  // A gear button sits inside the thing it acts on, so it says "the card I am
  // in" rather than needing a reference to it.

  cloneClosest(from, selector) { return this.clone(closestOf(from, selector)); }
  removeClosest(from, selector) { return this.remove(closestOf(from, selector)); }
  moveClosest(from, direction, selector) { return this.move(closestOf(from, selector), direction, selector); }
  toggleClosest(from, selector, className) { return this.toggle(closestOf(from, selector), className); }

  // Send the block this control sits in to another container, stepping through
  // the containers in document order so one button can walk a card along.
  moveToClosest(from, selector, containerSelector, step = 1) {
    const el = closestOf(from, selector);
    if (!el) return null;
    const hosts = this.all(containerSelector);
    const here = hosts.findIndex((h) => h.contains(el));
    const next = here + (step < 0 ? -1 : 1);
    if (here < 0 || next < 0 || next >= hosts.length) return el;
    return this.moveTo(el, hosts[next]);
  }

  // Delete is the one worth a question, because a save is a publish.
  async removeClosestAsk(from, selector, what = "this") {
    const el = closestOf(from, selector);
    if (!el) return null;
    const ok = await modal({
      doc: this.doc,
      title: `Delete ${what}?`,
      hint: "It goes when you next save the page. Version history keeps the old one either way.",
      submitLabel: "Delete",
      onSubmit: () => true,
    });
    return ok ? this.remove(el) : null;
  }

  // ---- reading the document as data ---------------------------------------

  // The DOM is the query engine. This is a convenience, not a layer.
  all(selector, root = this.doc) { return [...root.querySelectorAll(selector)]; }

  // Group elements by an attribute, which is what a board or a filtered list
  // wants nine times out of ten.
  by(selector, attribute, root = this.doc) {
    const out = new Map();
    for (const el of this.all(selector, root)) {
      const key = el.getAttribute(attribute) ?? "";
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(el);
    }
    return out;
  }
}

// State with no visual form: a theme, an open tab, a layout. It lives in a JSON
// script block in the document, so it is saved and published like everything
// else, and so it is visible in the file rather than hidden in a browser.
export class State {
  constructor(nc) { this.nc = nc; this.doc = nc.doc; }

  block(id = "app-state") {
    let el = this.doc.getElementById(id);
    if (!el) {
      el = this.doc.createElement("script");
      el.id = id;
      el.type = "application/json";
      el.textContent = "{}";
      this.doc.body.appendChild(el);
    }
    return el;
  }

  get(id = "app-state") {
    try { return JSON.parse(this.block(id).textContent || "{}"); }
    catch { return {}; }
  }

  set(value, id = "app-state") {
    // A "</script>" anywhere in the data would end the block and take the rest
    // of the page with it. JSON escapes the slash harmlessly, so this is safe
    // and still parses.
    this.block(id).textContent = JSON.stringify(value, null, 2).replace(/<\//g, "<\\/");
    this.nc.dirty = true;
    this.nc._emit("nsiteclay:state", { id, value });
    return value;
  }

  update(patch, id = "app-state") { return this.set({ ...this.get(id), ...patch }, id); }
}
