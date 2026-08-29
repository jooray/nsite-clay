// Settings that belong to the document, so they live in the document.
//
// There is nowhere else to put them. A preference in localStorage would follow
// the browser rather than the page, so opening your own site on another machine
// would lose it, and a visitor's browser would carry settings for a page they
// do not own. These are attributes on <html>: they travel with the file, they
// are visible in the markup, and a save persists them like everything else.
//
// Nothing private goes here. Anyone can read a published page.
import { modal, toast } from "./ui.js";

export class Settings {
  constructor(nc) {
    this.nc = nc;
    this.doc = nc.doc;
  }

  get root() { return this.doc.documentElement; }

  // Save once edits settle. Off by default: every save is a new Blossom blob
  // and a new version event, so saving on a timer turns a paragraph of typing
  // into a dozen published versions of the page.
  get autosave() { return this.root.hasAttribute("nc:autosave") || this.root.hasAttribute("autosave"); }
  set autosave(on) {
    if (on) this.root.setAttribute("nc:autosave", "");
    else { this.root.removeAttribute("nc:autosave"); this.root.removeAttribute("autosave"); }
    this.nc.cfg.autosave = !!on;
    this.nc.dirty = true;                    // the change itself is unsaved
    this.nc._emit("nsiteclay:settings", { autosave: !!on });
  }

  // Where the editing controls come from. "hash" keeps them out of the way
  // until someone adds #edit to the URL, which is how an owner finds them and
  // how everybody else never sees them.
  get editGate() { return (this.root.getAttribute("nc:edit-gate") || "always").toLowerCase(); }
  set editGate(mode) {
    const m = mode === "hash" ? "hash" : "always";
    if (m === "always") this.root.removeAttribute("nc:edit-gate");
    else this.root.setAttribute("nc:edit-gate", m);
    this.nc.cfg.editGate = m;
    this.nc.dirty = true;
    this.nc.applyEditGate();
    this.nc._emit("nsiteclay:settings", { editGate: m });
  }

  async open() {
    const before = { autosave: this.autosave, editGate: this.editGate };
    let autosave, gate;
    const out = await modal({
      doc: this.doc,
      title: "Page settings",
      hint: "These are attributes on this page, so they are saved with it and travel with the file.",
      submitLabel: "Apply",
      build: (body) => {
        const doc = this.doc;
        const mk = (label, checked, note) => {
          const wrap = doc.createElement("div");
          wrap.className = "nc-field";
          const l = doc.createElement("label");
          l.style.cssText = "display:flex;gap:.55rem;align-items:flex-start;cursor:pointer;color:inherit";
          const cb = doc.createElement("input");
          cb.type = "checkbox"; cb.checked = checked;
          cb.style.cssText = "width:auto;margin-top:.25rem;flex:0 0 auto";
          const txt = doc.createElement("span");
          txt.innerHTML = `<b style="font-weight:600">${label}</b><br><span style="color:#9a92ad;font-size:.85em">${note}</span>`;
          l.append(cb, txt);
          wrap.appendChild(l);
          body.appendChild(wrap);
          return cb;
        };
        autosave = mk("Save automatically", this.autosave,
          "Publishes a new version a few seconds after you stop typing. Off by default, because " +
          "every save stores the whole page again and files a version.");
        gate = mk("Hide the editing controls until the URL ends in #edit", this.editGate === "hash",
          "Readers get the page with nothing to click. Add #edit to the address to bring the " +
          "controls back.");
      },
      onSubmit: () => ({ autosave: autosave.checked, editGate: gate.checked ? "hash" : "always" }),
    });
    if (!out) return null;
    if (out.autosave !== before.autosave) this.autosave = out.autosave;
    if (out.editGate !== before.editGate) this.editGate = out.editGate;
    if (out.autosave !== before.autosave || out.editGate !== before.editGate) {
      toast("Settings changed. Save the page to keep them.", { doc: this.doc });
    }
    return out;
  }
}
