// Building a page out of blocks.
//
// The form generated from `nc:cms` is for changing what a page says. This is for
// changing what a page is made of: add a heading, add a picture, add a video,
// add a Nostr feed, move that one up, throw that one away. It is the composer
// pattern every newsletter tool has, with the difference that a block here is
// not a row in a database. It is markup in the document, so the page a reader
// gets is the page you built, with no renderer in between and nothing to load.
//
// A template declares its own block library as inert `<template>` elements:
//
//   <template nc:block="picture" nc:label="Picture" nc:icon="▥"
//             nc:group="Media" nc:on-add="image">
//     <section class="blk">
//       <figure class="nc-figure">
//         <img nc:slot src="…" alt="">
//         <figcaption editable="single-line">Caption</figcaption>
//       </figure>
//     </section>
//   </template>
//
// A `<template>` renders nothing and is saved with the page, so the library
// travels with the document: whoever inherits the file can keep adding blocks
// without fetching anything. `nc:on-add` names a picker to run once the block
// lands, and `nc:slot` marks what that picker acts on.
//
// The controls are drawn by the runtime and marked `nc:chrome`, so they are
// stripped from every save. That is the opposite of the advice in
// templates/_shared/CONTRACT.md, and deliberately: an authored gear belongs in
// the file because it is particular to the thing it sits on, whereas a rail that
// is identical above every block would be the same twelve buttons copied into
// the file a dozen times, growing with the page and going stale the moment this
// file changes.
import { modal, toast } from "./ui.js";

// A block is a direct element child of the container that is not runtime
// furniture and not part of the library.
const isBlock = (el) =>
  el.nodeType === 1 &&
  el.tagName !== "TEMPLATE" &&
  !el.hasAttribute("nc:chrome");

export class Blocks {
  constructor(nc) {
    this.nc = nc;
    this.doc = nc.doc;
    this.on = false;
  }

  // ---- reading the document ------------------------------------------------

  containers() { return [...this.doc.querySelectorAll("[nc\\:blocks]")]; }

  container(el) { return el?.closest?.("[nc\\:blocks]") || this.containers()[0] || null; }

  blocksIn(container) {
    return [...(container?.children || [])].filter(isBlock);
  }

  // The library is document-wide rather than per container, so a page with two
  // block areas offers the same set in both.
  library() {
    const out = new Map();
    for (const tpl of this.doc.querySelectorAll("template[nc\\:block]")) {
      const name = tpl.getAttribute("nc:block");
      if (!name || out.has(name)) continue;
      out.set(name, {
        name,
        label: tpl.getAttribute("nc:label") || name,
        icon: tpl.getAttribute("nc:icon") || "▦",
        group: tpl.getAttribute("nc:group") || "Blocks",
        onAdd: tpl.getAttribute("nc:on-add") || "",
        hint: tpl.getAttribute("nc:hint") || "",
        tpl,
      });
    }
    return out;
  }

  typeOf(block) { return block?.getAttribute?.("nc:block-type") || ""; }

  // ---- changing the document -----------------------------------------------

  // `before` is the block to insert in front of; leaving it out appends.
  async add(name, { container = null, before = null } = {}) {
    const kind = this.library().get(name);
    if (!kind) { toast(`No block called "${name}" in this page's library.`, { doc: this.doc }); return null; }
    const host = container || this.container(before) || this.containers()[0];
    if (!host) { toast("This page has no block area to add to.", { doc: this.doc }); return null; }

    const node = kind.tpl.content.firstElementChild?.cloneNode(true);
    if (!node) { toast(`The "${name}" block template is empty.`, { doc: this.doc }); return null; }
    // Stamped so the rail knows which picker to reopen later, and so a person
    // reading the saved file can tell what each section was made from.
    node.setAttribute("nc:block-type", name);

    before ? before.before(node) : host.appendChild(node);
    this.nc.dom.armed(node);
    this.refresh();

    // A picture block with no picture is not worth adding, so the picker opens
    // straight away. Backing out of it removes the block again rather than
    // leaving an empty frame behind for someone to work out how to delete.
    if (kind.onAdd) {
      const filled = await this.runHook(kind.onAdd, node);
      if (!filled) { this.nc.dom.remove(node); this.refresh(); return null; }
    }
    node.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    return node;
  }

  // The pickers the runtime already has, addressed at a slot inside the block.
  async runHook(hook, block) {
    const slot = block.querySelector("[nc\\:slot]") || block;
    try {
      if (hook === "image") return await this.nc.media.promptImage({ target: slot });
      if (hook === "video") return await this.nc.media.promptVideo({ target: slot });
      if (hook === "feed") {
        const el = block.querySelector("[nc\\:feed]") || slot;
        return await this.nc.feed.promptInsert({ target: el });
      }
      if (hook === "post") return await this.nc.compose.pickIntoPage(block);
    } catch (e) {
      toast(e.message || String(e), { doc: this.doc });
      return null;
    }
    toast(`This block asks for "${hook}", which this version does not know how to do.`, { doc: this.doc });
    return block;
  }

  // Reopen whatever picker built this block. The rail shows the button only for
  // block types that declare a hook, so there is nothing to do for a heading.
  configure(block) {
    const kind = this.library().get(this.typeOf(block));
    if (!kind?.onAdd) return null;
    return this.runHook(kind.onAdd, block);
  }

  // ---- the palette ---------------------------------------------------------

  async open({ container = null, before = null } = {}) {
    if (!this.nc.isOwner) { toast("Only the owner can change this page.", { doc: this.doc }); return null; }
    const lib = this.library();
    if (!lib.size) {
      toast("This page carries no block library, so there is nothing to add.", { doc: this.doc });
      return null;
    }

    const picked = await modal({
      doc: this.doc,
      title: "Add a block",
      hint: "Every block is markup in this page. Readers get it as a plain document.",
      submitLabel: "Close",
      noCancel: true,
      build: (body, h) => {
        const groups = new Map();
        for (const kind of lib.values()) {
          if (!groups.has(kind.group)) groups.set(kind.group, []);
          groups.get(kind.group).push(kind);
        }
        for (const [group, kinds] of groups) {
          const label = this.doc.createElement("label");
          label.textContent = group;
          const grid = this.doc.createElement("div");
          grid.className = "nc-blk-palette";
          for (const kind of kinds) {
            const b = this.doc.createElement("button");
            b.type = "button";
            b.className = "nc-blk-choice";
            const icon = this.doc.createElement("span");
            icon.className = "nc-blk-icon";
            icon.setAttribute("aria-hidden", "true");
            icon.textContent = kind.icon;
            const name = this.doc.createElement("b");
            name.textContent = kind.label;
            b.append(icon, name);
            if (kind.hint) {
              const small = this.doc.createElement("small");
              small.textContent = kind.hint;
              b.appendChild(small);
            }
            b.onclick = () => h.close(kind.name);
            grid.appendChild(b);
          }
          body.append(label, grid);
        }
      },
      onSubmit: () => null,
    });

    return picked ? this.add(picked, { container, before }) : null;
  }

  // ---- the controls --------------------------------------------------------

  start() {
    const sync = () => (this.nc.isOwner && this.nc.editRequested ? this.arm() : this.disarm());
    for (const ev of ["nsiteclay:login", "nsiteclay:logout", "nsiteclay:edit-gate"]) {
      this.nc.addEventListener(ev, sync);
    }
    // New markup can bring new blocks with it, and a block with no rail cannot
    // be moved or deleted.
    this.nc.addEventListener("nsiteclay:dom", () => { if (this.on) this.refresh(); });
    sync();
  }

  arm() {
    if (!this.containers().length) return;
    this.on = true;
    this.injectStyles();
    this.doc.documentElement.setAttribute("nc:blocks-on", "true");
    this.refresh();
  }

  disarm() {
    this.on = false;
    this.doc.documentElement.removeAttribute("nc:blocks-on");
    for (const el of [...this.doc.querySelectorAll(".nc-blk-rail, .nc-blk-add")]) el.remove();
  }

  // Rails and insert points are rebuilt rather than patched. There are a few
  // dozen of them at most, they carry no state worth keeping, and a rebuild
  // cannot leave one attached to a block that has since moved.
  refresh() {
    if (!this.on) return;
    for (const el of [...this.doc.querySelectorAll(".nc-blk-rail, .nc-blk-add")]) el.remove();
    for (const container of this.containers()) {
      const blocks = this.blocksIn(container);
      for (const block of blocks) {
        block.appendChild(this.rail(block));
        container.insertBefore(this.adder(container, block), block);
      }
      container.appendChild(this.adder(container, null));
    }
  }

  button(label, title, fn, { primary = false } = {}) {
    const b = this.doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    if (primary) b.className = "nc-primary";
    // The rail sits inside editable markup often enough that a press would
    // otherwise move the caret and scroll the page before the click lands.
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
    return b;
  }

  rail(block) {
    const rail = this.doc.createElement("menu");
    rail.className = "nc-blk-rail";
    rail.setAttribute("nc:chrome", "");
    const has = !!this.library().get(this.typeOf(block))?.onAdd;
    rail.append(
      this.button("↑", "Move this block up", () => this.moveBlock(block, -1)),
      this.button("↓", "Move this block down", () => this.moveBlock(block, 1)),
    );
    if (has) rail.appendChild(this.button("⚙", "Change what this block shows", () => this.configure(block)));
    rail.append(
      this.button("⧉", "Duplicate this block", () => { this.nc.dom.clone(block); this.refresh(); }),
      this.button("✕", "Delete this block", () => this.removeBlock(block)),
    );
    return rail;
  }

  // Not nc.dom.move: that walks every sibling, and between any two blocks sits
  // an insert point of ours. Moving against the unfiltered list would swap a
  // block with a "+" button and appear to do nothing.
  moveBlock(block, dir) {
    const blocks = this.blocksIn(this.container(block));
    const i = blocks.indexOf(block);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= blocks.length) return block;
    dir < 0 ? blocks[j].before(block) : blocks[j].after(block);
    this.nc.dom.armed(block);
    this.refresh();
    return block;
  }

  // Its own question rather than nc.dom.removeClosestAsk, which without a
  // selector climbs to the nearest [nc:block] and would find the container
  // instead: a page with one delete button that empties the whole page.
  async removeBlock(block) {
    const ok = await modal({
      doc: this.doc,
      title: "Delete this block?",
      hint: "It goes when you next save the page. Version history keeps the old one either way.",
      submitLabel: "Delete",
      onSubmit: () => true,
    });
    if (!ok) return null;
    this.nc.dom.remove(block);
    this.refresh();
    return block;
  }

  adder(container, before) {
    const wrap = this.doc.createElement("div");
    wrap.className = "nc-blk-add";
    wrap.setAttribute("nc:chrome", "");
    wrap.appendChild(this.button("+", before ? "Add a block here" : "Add a block at the end",
      () => this.open({ container, before })));
    return wrap;
  }

  // The base stylesheet carries these. A page that has set the variables has the
  // stylesheet, so only a document without it gets the plain fallback, and a
  // template that restyled the rail keeps its version.
  injectStyles() {
    if (this._styled) return;
    this._styled = true;
    if (getComputedStyle(this.doc.documentElement).getPropertyValue("--nc-radius").trim()) return;
    const s = this.doc.createElement("style");
    s.setAttribute("nc:chrome", "");
    s.textContent = `
html[nc\\:blocks-on="true"] [nc\\:blocks] > *:not(.nc-blk-add) { position: relative; outline: 1px dashed #3a3350; }
.nc-blk-rail { position: absolute; top: 4px; right: 4px; display: flex; gap: 2px; margin: 0; padding: 3px;
  list-style: none; background: #1b1726; border: 1px solid #3a3350; border-radius: 8px; z-index: 20; }
.nc-blk-rail button, .nc-blk-add button { font: 13px/1 system-ui, sans-serif; cursor: pointer; color: #eee;
  background: transparent; border: 0; border-radius: 6px; padding: 4px 7px; }
.nc-blk-rail button:hover, .nc-blk-add button:hover { background: #2c2540; }
.nc-blk-add { display: flex; justify-content: center; padding: 2px 0; grid-column: 1 / -1; flex-basis: 100%; }
.nc-blk-add button { border: 1px dashed #3a3350; width: 100%; }
.nc-blk-palette { display: grid; gap: .5rem; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
  margin: .3rem 0 1rem; }
.nc-blk-choice { display: grid; gap: .15rem; justify-items: start; align-content: start; text-align: left; padding: .6rem .7rem;
  font: inherit; cursor: pointer; color: #eee; background: #14121b; border: 1px solid #3a3350; border-radius: 9px; }
.nc-blk-choice:hover { border-color: #8c64e1; }
.nc-blk-icon { font-size: 1.3rem; line-height: 1; }
.nc-blk-choice small { color: #9a92ad; font-size: .76rem; }`;
    this.doc.head.appendChild(s);
  }
}
