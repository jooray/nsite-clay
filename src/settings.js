// Settings that belong to the document, so they live in the document.
//
// There is nowhere else to put them. A preference in localStorage would follow
// the browser rather than the page, so opening your own site on another machine
// would lose it, and a visitor's browser would carry settings for a page they
// do not own. These are attributes on <html>: they travel with the file, they
// are visible in the markup, and a save persists them like everything else.
//
// Nothing private goes here. Anyone can read a published page.
import { modal, checkbox, field, toast } from "./ui.js";
import { agentRow } from "./agent-brief.js";

// The one line here that is about this browser rather than this page. It is
// drawn in the page's language, as the AI settings button below it is.
// Order: en, es, sk, cs.
const WORDS = {
  remember: ["Open the editing controls in this browser without #edit",
    "Abrir los controles de edición en este navegador sin #edit",
    "Zobrazovať ovládanie úprav v tomto prehliadači aj bez #edit",
    "Zobrazovat ovládání úprav v tomto prohlížeči i bez #edit"],
  rememberNote: ["This browser remembers that the owner signed in here, and stays signed in until an hour passes without use, so the other pages open signed in. Unticking this or signing out forgets both.",
    "Este navegador recuerda que el propietario inició sesión aquí y mantiene la sesión hasta que pase una hora sin usarla, así que las demás páginas se abren con la sesión iniciada. Al desmarcar esta casilla o al cerrar sesión se olvidan las dos cosas.",
    "Tento prehliadač si pamätá, že sa tu prihlásil vlastník, a nechá ho prihláseného, kým neprejde hodina bez použitia, takže ďalšie stránky sa otvoria už prihlásené. Zrušením tejto voľby alebo odhlásením sa zabudne oboje.",
    "Tento prohlížeč si pamatuje, že se tu přihlásil vlastník, a nechá ho přihlášeného, dokud neuplyne hodina bez použití, takže další stránky se otevřou už přihlášené. Zrušením této volby nebo odhlášením se zapomene obojí."],
  servers: ["Blossom servers (one address per line)", "Servidores Blossom (una dirección por línea)",
    "Servery Blossom (jedna adresa na riadok)", "Servery Blossom (jedna adresa na řádek)"],
  serversNote: ["Where this page's files are stored. If one of them changes its address or shuts down, replace it here and save the page: the files are uploaded to the new list. The first one that answers is used.",
    "Donde se guardan los archivos de esta página. Si uno cambia de dirección o cierra, sustitúyelo aquí y guarda la página: los archivos se suben a la nueva lista. Se usa el primero que responda.",
    "Kde sú uložené súbory tejto stránky. Ak niektorý zmení adresu alebo zanikne, nahraďte ho tu a stránku uložte: súbory sa nahrajú na nový zoznam. Použije sa prvý, ktorý odpovie.",
    "Kde jsou uloženy soubory této stránky. Pokud některý změní adresu nebo zanikne, nahraďte ho tady a stránku uložte: soubory se nahrají na nový seznam. Použije se první, který odpoví."],
  serversBad: ["is not a web address. Use something like https://blossom.example.com",
    "no es una dirección web. Usa algo como https://blossom.example.com",
    "nie je webová adresa. Použite napríklad https://blossom.example.com",
    "není webová adresa. Použijte například https://blossom.example.com"],
  serversNone: ["Keep at least one Blossom server, or the page has nowhere to be stored.",
    "Deja al menos un servidor Blossom, o la página no tendrá dónde guardarse.",
    "Ponechajte aspoň jeden server Blossom, inak sa stránka nemá kde uložiť.",
    "Ponechte alespoň jeden server Blossom, jinak se stránka nemá kam uložit."],
};

// One address per line (commas and spaces also work). Returns the cleaned
// list, or throws a message naming the entry that is not a web address.
export function parseServers(text, say = (k) => k) {
  const out = [];
  for (const raw of String(text || "").split(/[\s,]+/).filter(Boolean)) {
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw); } catch { u = null; }
    const local = u && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (!u || !(u.protocol === "https:" || (u.protocol === "http:" && local)) || !u.hostname) {
      throw new Error(`${raw} ${say("serversBad")}`);
    }
    const url = u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, ""));
    if (!out.includes(url)) out.push(url);
  }
  if (!out.length) throw new Error(say("serversNone"));
  return out;
}

export class Settings {
  constructor(nc) {
    this.nc = nc;
    this.doc = nc.doc;
  }

  get root() { return this.doc.documentElement; }

  say(key) {
    const lang = ["en", "es", "sk", "cs"].indexOf((this.root.lang || "en").slice(0, 2).toLowerCase());
    return WORDS[key]?.[Math.max(lang, 0)] || key;
  }

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

  // The Blossom servers the page's files live on. A server can change its
  // domain or close, and a page that cannot be saved to any of its servers is
  // stuck, so the owner can replace them without touching the markup.
  get servers() { return this.nc.cfg.servers.slice(); }
  set servers(list) {
    this.root.setAttribute("nc:servers", list.join(","));
    this.nc.cfg.servers = list.slice();
    this.nc.dirty = true;
    this.nc._emit("nsiteclay:settings", { servers: list.slice() });
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
    let autosave, gate, remember, servers;
    // A sealed page keeps its servers in its shell, which a save does not
    // rewrite from here, so the field is only offered on an ordinary page.
    const editServers = !this.nc.sealed?.active;
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
        // Only means anything behind the gate, so it is only offered there.
        if (this.editGate === "hash" && this.nc.cfg.owner && typeof this.nc.rememberEditor === "function") {
          remember = checkbox(body, { label: this.say("remember"), checked: this.nc.editorRemembered,
            note: this.say("rememberNote") });
        }
        if (editServers) {
          servers = field(body, { label: this.say("servers"), rows: 3, value: this.servers.join("\n") });
          servers.spellcheck = false;
          const note = this.doc.createElement("p");
          note.className = "nc-hint";
          note.textContent = this.say("serversNote");
          body.append(note);
        }
        this.runtimeRow(body);
        const ai = this.doc.createElement("button"); ai.type = "button";
        ai.textContent = this.nc.ai.say("settings"); ai.onclick = () => this.nc.ai.settings();
        body.append(ai);
        // Beside the AI settings: the other way to have a machine edit the page,
        // with the owner's own agent instead of ours.
        agentRow(this.nc, body);
      },
      onSubmit: () => ({ autosave: autosave.checked, editGate: gate.checked ? "hash" : "always",
        remember: remember ? remember.checked : undefined,
        servers: servers ? parseServers(servers.value, (k) => this.say(k)) : undefined }),
    });
    if (!out) return null;
    // A browser preference, not a page attribute: it takes effect now and there
    // is nothing to save.
    if (out.remember !== undefined && out.remember !== this.nc.editorRemembered) this.nc.rememberEditor(out.remember);
    if (out.autosave !== before.autosave) this.autosave = out.autosave;
    if (out.editGate !== before.editGate) this.editGate = out.editGate;
    const serversChanged = !!out.servers && out.servers.join(",") !== this.servers.join(",");
    if (serversChanged) this.servers = out.servers;
    if (out.autosave !== before.autosave || out.editGate !== before.editGate || serversChanged) {
      toast("Settings changed. Save the page to keep them.", { doc: this.doc });
    }
    return out;
  }
}
