// Settings that belong to the document, so they live in the document.
//
// There is nowhere else to put them. A preference in localStorage would follow
// the browser rather than the page, so opening your own site on another machine
// would lose it, and a visitor's browser would carry settings for a page they
// do not own. These are attributes on <html>: they travel with the file, they
// are visible in the markup, and a save persists them like everything else.
//
// Nothing private goes here. Anyone can read a published page.
import { modal, checkbox, toast } from "./ui.js";

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

  // The front door to a runtime upgrade. It has to be here rather than on the
  // toolbar: the toolbar is markup in the document, so a page published before a
  // button existed will never grow one, whereas every template already carries a
  // Settings button and always will. A dialog the runtime draws reaches every
  // page that will ever exist.
  runtimeRow(body) {
    const label = this.doc.createElement("label");
    label.textContent = "Runtime";
    const row = this.doc.createElement("div");
    row.className = "nc-row";

    const what = this.doc.createElement("span");
    what.className = "nc-hint";
    what.style.margin = "0";
    what.textContent = `nsite-clay ${this.nc.version}`;

    const btn = this.doc.createElement("button");
    btn.type = "button";
    btn.style.marginLeft = "auto";
    btn.textContent = "Check for an update";
    btn.onclick = () => this.nc.upgrade.prompt();

    row.append(what, btn);
    body.append(label, row);
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
        autosave = checkbox(body, { label: "Save automatically", checked: this.autosave, note:
          "Publishes a new version a few seconds after you stop typing. Off by default, because " +
          "every save stores the whole page again and files a version." });
        gate = checkbox(body, { label: "Hide the editing controls until the URL ends in #edit",
          checked: this.editGate === "hash", note:
          "Readers get the page with nothing to click. Add #edit to the address to bring the " +
          "controls back." });
        this.runtimeRow(body);
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
