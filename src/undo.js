import { undo as hyperUndo } from "./vendor/hyper-undo/index.js";

const EXCLUDED = '[nc\\:chrome], [nc\\:transient], .nc-ui-chrome, [no-save], [no-snapshot], [clay~="no-save"], [clay~="no-snapshot"]';
const RUNTIME = new Set(["contenteditable", "spellcheck", "nc:armed", "nc:keep-editable",
  "nc:spellcheck", "nc:highlight", "nc:feed-count", "nc:pubkey", "nc:owner-here",
  "nc:editmode", "nc:status", "nc:ready", "nc:editable", "nc:outdated", "nc:editing",
  "nc:reading", "nc:cms-rules", "nc:cms-open"]);
const excluded = (node) => !!(node?.nodeType === 1 ? node : node?.parentElement)?.closest?.(EXCLUDED);

export class Undo {
  constructor(nc) { this.nc = nc; this.doc = nc.doc; }

  start() {
    const sync = () => {
      if (this.nc.isOwner && this.nc.editRequested) this.enable();
      else this.disable();
    };
    for (const event of ["nsiteclay:login", "nsiteclay:logout", "nsiteclay:edit-gate"]) this.nc.addEventListener(event, sync);
    sync();
  }

  enable() {
    if (this.engine) return;
    this.engine = hyperUndo.create({ scope: this.doc.documentElement, bindKeys: false,
      ignoreNode: excluded, ignoreAttribute: (name) => RUNTIME.has(name), maxHistory: 100 });
    this.engine.start();
    for (const event of ["commit", "undo", "redo", "clear"]) this.engine.on(event, () => {
      if (event !== "clear") this.nc.dirty = true;
      this.draw();
    });
    this.key = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || excluded(e.target)) return;
      const k = e.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      e.preventDefault();
      k === "y" || e.shiftKey ? this.redo() : this.undo();
    };
    this.doc.addEventListener("keydown", this.key, true);
    this.draw();
  }

  disable() {
    this.doc.removeEventListener("keydown", this.key, true);
    this.engine?.stop(); this.engine = null;
    this.buttons?.remove(); this.buttons = null;
  }

  get canUndo() { return this.engine?.canUndo || false; }
  get canRedo() { return this.engine?.canRedo || false; }
  flush() { this.engine?.flush(); }
  clear() { this.engine?.clear(); }
  commit(label, fn) {
    if (!this.engine) return fn();
    let result;
    this.engine.commit(label, () => { result = fn(); return result; });
    return result;
  }
  recordValue(target, options) { this.engine?.recordValue(target, options); }
  undo() { this.navigate("undo"); }
  redo() { this.navigate("redo"); }
  navigate(direction) {
    if (!this.engine || !this.nc.isOwner) return;
    this.engine[direction]();
    // Rebuild chrome around restored live nodes without making the rebuild an edit.
    this.engine.pause();
    try {
      this.nc.editable.refresh(); this.nc.blocks.refresh();
      if (this.nc.cms.isOpen) this.nc.cms.open(this.nc.cms.name);
    } finally { this.engine.resume(); }
    this.draw();
  }

  draw() {
    const bar = this.doc.querySelector(".nc-bar");
    if (!bar || !this.engine) return;
    if (!this.buttons?.isConnected) {
      this.buttons = this.doc.createElement("span");
      this.buttons.setAttribute("nc:chrome", "");
      this.buttons.className = "nc-undo-controls";
      this.buttons.style.cssText = "display:inline-flex;gap:.3rem";
      const lang = this.doc.documentElement.lang.slice(0, 2);
      const labels = { es: ["Deshacer", "Rehacer"], sk: ["Späť", "Znova"], cs: ["Zpět", "Znovu"] }[lang] || ["Undo", "Redo"];
      for (const [i, action] of ["undo", "redo"].entries()) {
        const b = this.doc.createElement("button"); b.type = "button";
        b.textContent = labels[i]; b.dataset.ncUndoAction = action;
        b.onclick = () => this[action](); this.buttons.append(b);
      }
      bar.querySelector("[data-nc-save]")?.before(this.buttons);
      if (!this.buttons.isConnected) bar.append(this.buttons);
    }
    this.buttons.children[0].disabled = !this.canUndo;
    this.buttons.children[1].disabled = !this.canRedo;
  }
}
