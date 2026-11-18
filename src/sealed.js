// Sealed pages in the browser: opening one, and saving it sealed again.
//
// The gateway serves a shell (see seal.js). The runtime in the shell finds a
// key, decrypts the page, and writes it into the document with
// document.open/write/close, so the page starts the way any page starts:
// its scripts run in order, DOMContentLoaded and load fire, and the runtime it
// links boots a second time on the real document. What the first run learnt
// (the keys, and the shell's own settings) is handed over on the window, which
// document.open() keeps.
//
// The rule this file exists for: a page that arrived sealed leaves sealed. The
// decision is made once, from the shell, before any of the page's own code has
// run, and nothing the page does later is consulted.
import { nip19 } from "nostr-tools";
import {
  assertShell, b64u, buildShell, fragmentOf, keysFrom, openText, parseFragment, parseShell, sealText, unwrap, wrapFor,
} from "./seal.js";
import { buildManifest, manifestPaths } from "./manifest.js";
import { mergeRetired, namedHashes, retiredOf } from "./retire.js";
import { LocalSigner } from "./signer.js";
import { hashText, removeAll } from "./blossom.js";
import { field, modal, toast } from "./ui.js";
import { qrElement } from "./qr.js";

// English, Spanish, Slovak, Czech, in that order, as everywhere in the runtime.
const WORDS = {
  title: ["This page is encrypted", "Esta página está cifrada", "Táto stránka je zašifrovaná", "Tato stránka je zašifrovaná"],
  "no-key": ["Open it from the link it was shared with. The link has to be whole, with everything after the # sign.",
    "Ábrela desde el enlace con el que se compartió. El enlace tiene que estar completo, con todo lo que sigue al signo #.",
    "Otvorte ju z odkazu, ktorým vám ju niekto poslal. Odkaz musí byť celý, aj so všetkým za znakom #.",
    "Otevřete ji z odkazu, kterým vám ji někdo poslal. Odkaz musí být celý, i se vším za znakem #."],
  "wrong-key": ["This link does not open this page. It may have been cut short when it was copied or sent.",
    "Este enlace no abre esta página. Puede que se haya cortado al copiarlo o enviarlo.",
    "Tento odkaz túto stránku neotvorí. Možno sa pri kopírovaní alebo posielaní skrátil.",
    "Tento odkaz tuto stránku neotevře. Možná se při kopírování nebo posílání zkrátil."],
  members: ["It was shared with specific people. Sign in with your Nostr key to open it.",
    "Se compartió con personas concretas. Inicie sesión con su clave de Nostr para abrirla.",
    "Niekto ju sprístupnil konkrétnym ľuďom. Otvoríte ju prihlásením svojím Nostr kľúčom.",
    "Někdo ji zpřístupnil konkrétním lidem. Otevřete ji přihlášením svým Nostr klíčem."],
  "not-a-member": ["This page was not shared with the key you signed in with.",
    "Esta página no se compartió con la clave con la que ha iniciado sesión.",
    "Táto stránka nebola sprístupnená kľúču, ktorým ste sa prihlásili.",
    "Tato stránka nebyla zpřístupněna klíči, kterým jste se přihlásili."],
  damaged: ["Its content is missing, so there is nothing to open.",
    "Falta su contenido, así que no hay nada que abrir.",
    "Jej obsah chýba, takže nie je čo otvoriť.",
    "Její obsah chybí, takže není co otevřít."],
  expired: ["It was set to be deleted and its time has passed. It may stop opening at any moment.",
    "Estaba previsto borrarla y ese momento ya pasó. Puede dejar de abrirse en cualquier momento.",
    "Mala byť zmazaná a ten čas už uplynul. Môže sa kedykoľvek prestať dať otvoriť.",
    "Měla být smazána a ten čas už uplynul. Může se kdykoli přestat dát otevřít."],
  signIn: ["Sign in", "Iniciar sesión", "Prihlásiť sa", "Přihlásit se"],
  otherKey: ["Sign in with another key", "Iniciar sesión con otra clave", "Prihlásiť sa iným kľúčom", "Přihlásit se jiným klíčem"],
  paste: ["Or paste the whole link here", "O pegue aquí el enlace completo", "Alebo sem vložte celý odkaz", "Nebo sem vložte celý odkaz"],
  open: ["Open", "Abrir", "Otvoriť", "Otevřít"],
  notALink: ["That is not a whole link to an encrypted page.", "Eso no es un enlace completo a una página cifrada.",
    "To nie je celý odkaz na zašifrovanú stránku.", "To není celý odkaz na zašifrovanou stránku."],
  signInTitle: ["Sign in to open this page", "Inicie sesión para abrir esta página", "Prihláste sa a stránka sa otvorí", "Přihlaste se a stránka se otevře"],
  signInHint: ["Your key opens the page in this browser. It is not sent anywhere.",
    "Su clave abre la página en este navegador. No se envía a ningún sitio.",
    "Váš kľúč otvorí stránku v tomto prehliadači. Nikam sa neposiela.",
    "Váš klíč otevře stránku v tomto prohlížeči. Nikam se neposílá."],
  scan: ["Show a code for a signer app", "Mostrar un código para una app firmante", "Zobraziť kód pre podpisovaciu aplikáciu", "Zobrazit kód pro podepisovací aplikaci"],
  openSignerBtn: ["Open your signer app", "Abrir su app firmante", "Otvoriť podpisovaciu aplikáciu", "Otevřít podepisovací aplikaci"],
  showQr: ["Show QR code", "Mostrar código QR", "Zobraziť QR kód", "Zobrazit QR kód"],
  hideQr: ["Hide QR code", "Ocultar código QR", "Skryť QR kód", "Skrýt QR kód"],
  qrHint: ["Scan this with a signer app on another device.", "Escanéelo con una app firmante en otro dispositivo.",
    "Naskenujte ho podpisovacou aplikáciou na inom zariadení.", "Naskenujte ho podepisovací aplikací na jiném zařízení."],
  backFromApp: ["Approved, but nothing happened? Try again.", "¿Aprobó y no ocurre nada? Inténtelo de nuevo.",
    "Schválili ste a nič sa nedeje? Skúste znova.", "Schválili jste a nic se neděje? Zkuste to znovu."],
  openSigner: ["Open in a signer app on this device", "Abrir en una app firmante en este dispositivo", "Otvoriť v podpisovacej aplikácii na tomto zariadení", "Otevřít v podepisovací aplikaci na tomto zařízení"],
  waiting: ["Waiting for the signer…", "Esperando al firmante…", "Čaká sa na podpisovaciu aplikáciu…", "Čeká se na podepisovací aplikaci…"],
  retry: ["Show a new code", "Mostrar un código nuevo", "Zobraziť nový kód", "Zobrazit nový kód"],
  pasteKey: ["Or paste a key", "O pegue una clave", "Alebo vložiť kľúč", "Nebo vložit klíč"],
  password: ["Password for the encrypted key", "Contraseña de la clave cifrada", "Heslo k zašifrovanému kľúču", "Heslo k zašifrovanému klíči"],
  useKey: ["Open the page", "Abrir la página", "Otvoriť stránku", "Otevřít stránku"],
  needKey: ["Enter a key, or use a signer app", "Introduzca una clave o use una app firmante", "Zadajte kľúč alebo použite podpisovaciu aplikáciu", "Zadejte klíč nebo použijte podepisovací aplikaci"],
  // The panel an opened page offers: its links, who has it, and deleting it.
  menu: ["Sharing and deleting", "Compartir y borrar", "Zdieľanie a zmazanie", "Sdílení a smazání"],
  panelTitle: ["This encrypted page", "Esta página cifrada", "Táto zašifrovaná stránka", "Tato zašifrovaná stránka"],
  panelHint: ["Anyone who has one of these links can open the page. Nobody else can, not even the servers it is stored on.",
    "Cualquiera que tenga uno de estos enlaces puede abrir la página. Nadie más puede, ni siquiera los servidores donde está guardada.",
    "Stránku otvorí každý, kto má jeden z týchto odkazov. Nikto iný, ani servery, na ktorých je uložená.",
    "Stránku otevře každý, kdo má jeden z těchto odkazů. Nikdo jiný, ani servery, na kterých je uložená."],
  memberHint: ["You opened this page with your Nostr key. Nobody else can open it, not even the servers it is stored on, unless it was shared with them.",
    "Ha abierto esta página con su clave de Nostr. Nadie más puede abrirla, ni siquiera los servidores donde está guardada, salvo con quien se haya compartido.",
    "Túto stránku ste otvorili svojím Nostr kľúčom. Nikto iný ju neotvorí, ani servery, na ktorých je uložená, iba tí, s ktorými bola zdieľaná.",
    "Tuto stránku jste otevřeli svým Nostr klíčem. Nikdo jiný ji neotevře, ani servery, na kterých je uložená, jen ti, se kterými byla sdílena."],
  readLink: ["Link to read it", "Enlace para leerla", "Odkaz na čítanie", "Odkaz pro čtení"],
  editLink: ["Link to change it", "Enlace para modificarla", "Odkaz na úpravy", "Odkaz pro úpravy"],
  editNote: ["Whoever has this link can change the page and delete it.", "Quien tenga este enlace puede modificar la página y borrarla.",
    "Kto má tento odkaz, môže stránku meniť aj zmazať.", "Kdo má tento odkaz, může stránku měnit i smazat."],
  copy: ["Copy", "Copiar", "Kopírovať", "Kopírovat"],
  copied: ["Copied", "Copiado", "Skopírované", "Zkopírováno"],
  expiresOn: ["Deleted automatically on {date}.", "Se borra automáticamente el {date}.", "Automaticky sa zmaže {date}.", "Automaticky se smaže {date}."],
  noExpiry: ["It stays until somebody deletes it.", "Se queda hasta que alguien la borre.", "Zostane, kým ju niekto nezmaže.", "Zůstane, dokud ji někdo nesmaže."],
  people: ["People who open it with their Nostr key", "Personas que la abren con su clave de Nostr", "Ľudia, ktorí ju otvárajú svojím Nostr kľúčom", "Lidé, kteří ji otevírají svým Nostr klíčem"],
  canRead: ["can read", "puede leer", "môže čítať", "může číst"],
  canEdit: ["can change", "puede modificar", "môže upravovať", "může upravovat"],
  addPerson: ["Add a person by their npub", "Añadir a una persona por su npub", "Pridať človeka podľa jeho npub", "Přidat člověka podle jeho npub"],
  roleRead: ["Can read", "Puede leer", "Môže čítať", "Může číst"],
  roleEdit: ["Can change", "Puede modificar", "Môže upravovať", "Může upravovat"],
  add: ["Add", "Añadir", "Pridať", "Přidat"],
  added: ["Added and saved.", "Añadido y guardado.", "Pridané a uložené.", "Přidáno a uloženo."],
  badNpub: ["That is not an npub.", "Eso no es un npub.", "To nie je npub.", "To není npub."],
  removeNote: ["Somebody who already has a link or was added keeps access while the page has this key. Taking someone off means publishing it again under a new key, with new links; whoever made the page can do that.",
    "Quien ya tenga un enlace o haya sido añadido conserva el acceso mientras la página tenga esta clave. Quitar a alguien significa volver a publicarla con una clave nueva y enlaces nuevos; puede hacerlo quien creó la página.",
    "Kto už má odkaz alebo bol pridaný, má prístup, kým má stránka tento kľúč. Vziať niekomu prístup znamená zverejniť ju znova s novým kľúčom a novými odkazmi; to môže urobiť ten, kto stránku vytvoril.",
    "Kdo už má odkaz nebo byl přidán, má přístup, dokud má stránka tento klíč. Vzít někomu přístup znamená zveřejnit ji znovu s novým klíčem a novými odkazy; to může udělat ten, kdo stránku vytvořil."],
  deleteNow: ["Delete this page now", "Borrar esta página ahora", "Zmazať túto stránku teraz", "Smazat tuto stránku teď"],
  deleteTitle: ["Delete this page?", "¿Borrar esta página?", "Zmazať túto stránku?", "Smazat tuto stránku?"],
  deleteHint: ["It is removed from the servers it is stored on, for everyone, and its links stop working. This cannot be undone.",
    "Se quita de los servidores donde está guardada, para todos, y sus enlaces dejan de funcionar. No se puede deshacer.",
    "Odstráni sa zo serverov, na ktorých je uložená, pre všetkých, a jej odkazy prestanú fungovať. Nedá sa to vrátiť.",
    "Odstraní se ze serverů, na kterých je uložená, pro všechny, a její odkazy přestanou fungovat. Nedá se to vrátit."],
  delete: ["Delete", "Borrar", "Zmazať", "Smazat"],
  deleting: ["Deleting…", "Borrando…", "Maže sa…", "Maže se…"],
  deleted: ["This page was deleted.", "Esta página se borró.", "Táto stránka bola zmazaná.", "Tato stránka byla smazána."],
  deletedNote: ["A copy a gateway kept may still answer for a few minutes. Without the link nobody can read it.",
    "Una copia que haya guardado una pasarela puede responder unos minutos más. Sin el enlace nadie puede leerla.",
    "Kópia, ktorú si uložila brána, môže ešte pár minút odpovedať. Bez odkazu ju nikto neprečíta.",
    "Kopie, kterou si uložila brána, může ještě pár minut odpovídat. Bez odkazu ji nikdo nepřečte."],
  close: ["Close", "Cerrar", "Zavrieť", "Zavřít"],
};

const HANDOVER = "__ncSealed";
const IDENTITY = ["nc:owner", "nc:site", "nc:path", "nc:relays", "nc:servers"];
const ENGINE = /^\/nsite-clay(-[0-9a-f]{8})?\.js$/;
// The files every page of a site shares, at its root.
const RUNTIME_PATH = /^\/nsite-clay[-a-z0-9]*\.(js|css)$/;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export class Sealed {
  // What a tool asks of a runtime before it puts a page with its own read key
  // under a shared signing key (a workspace page) on it: an older runtime
  // would not open such a page, and its delete button would take down the
  // whole site instead of the one page. Searched for as text in the bundle.
  static FEATURES = "nc-split-keys-1 nc-workspace-delete-1";

  constructor(nc) {
    this.nc = nc;
    const win = nc.doc.defaultView;
    // Second boot: the page is on screen and this is what the first boot found.
    this.state = win?.[HANDOVER] || null;
    // First boot: the document is the shell.
    this.locked = !this.state && nc.doc.documentElement.hasAttribute("nc:sealed");
  }

  /** True for the life of the tab once a shell was served. Never cleared. */
  get active() { return !!this.state || this.locked; }
  get canEdit() { return !!this.state?.keys.sk; }
  get plain() { return this.state?.plain ?? null; }
  get expires() { return this.state?.shell.attrs["nc:expires"] ? Number(this.state.shell.attrs["nc:expires"]) : null; }

  where(attrs) {
    const owner = attrs["nc:owner"];
    return {
      owner: /^[0-9a-f]{64}$/.test(owner) ? owner : nip19.decode(owner).data,
      site: attrs["nc:site"] || "", path: attrs["nc:path"] || "/index.html",
    };
  }

  _store() { try { return this.nc.doc.defaultView.sessionStorage; } catch { return null; } }
  // One remembered key per page. The root page keeps the slot it always had.
  _slot(attrs) {
    const path = attrs["nc:path"] || "/index.html";
    return `nsite-clay.sealed:${attrs["nc:owner"]}:${attrs["nc:site"] || ""}${path === "/index.html" ? "" : ":" + path}`;
  }

  // ---- first boot: the shell --------------------------------------------

  // Resolves to false when there is nothing to open (the page is not sealed, or
  // is already open). Otherwise it does not resolve: either the document is
  // replaced, or the lock screen is up and stays up until a key arrives.
  async open() {
    if (!this.locked) return false;
    const doc = this.nc.doc;
    const text = "<!doctype html>" + doc.documentElement.outerHTML;
    // The DOM serialises the shell slightly differently from the file, so read
    // the parts off the elements rather than back out of that text.
    const attrs = Object.fromEntries([...doc.documentElement.attributes].map((a) => [a.name, a.value]));
    const sealed = doc.querySelector('script[type="application/nc-sealed"]')?.textContent.trim();
    let wraps = [];
    try { wraps = JSON.parse(doc.querySelector('script[type="application/nc-keys"]')?.textContent || "{}").wraps || []; } catch {}
    const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") || "";
    if (!sealed) { this._lock("damaged"); return new Promise(() => {}); }
    const served = { attrs, sealed, wraps, policy, title: doc.title, text };
    // A newer shell this tab fetched from Blossom because the gateway is still
    // serving this one (see reopen). Tried first; this one is the fallback.
    const newer = this._newer(served);

    const given = parseFragment(doc.location.hash);
    let kept = null;
    try { kept = JSON.parse(this._store()?.getItem(this._slot(attrs)) || "null"); } catch {}
    for (const shell of newer ? [newer.shell, served] : [served]) {
      this.shell = shell;
      this._served = shell === served ? null : newer.hash;
      for (const secret of [given, kept]) {
        if (!secret || (!secret.edit && !secret.read)) continue;
        if (await this._tryOpen(secret, "link")) return new Promise(() => {});
      }
    }
    this._lock(given.edit || given.read ? "wrong-key" : wraps.length ? "members" : "no-key");
    return new Promise(() => {});
  }

  async _tryOpen(secret, via) {
    const where = this.where(this.shell.attrs);
    let keys;
    try {
      keys = await keysFrom(secret);
      // An edit secret for some other artifact reads nothing here, and must not
      // be taken for the right to save this one.
      if (keys.sk && keys.pubkey !== where.owner) return false;
    } catch { return false; }
    let plain;
    try { plain = await openText(this.shell.sealed, keys.K, where); } catch { return false; }
    try { this._store()?.setItem(this._slot(this.shell.attrs), JSON.stringify(secret)); } catch {}
    this._write(plain, keys, via, { served: this._served || null });
    return true;
  }

  // Where reopen leaves a newer shell for the next boot of this tab: one per page.
  _newerSlot(attrs) { return "nsite-clay.newer:" + this._slot(attrs).slice("nsite-clay.sealed:".length); }

  // The shell reopen left, when the address this tab is at asks for it (its
  // ?v= is that shell's hash), it still hashes to that, it is this page's, and
  // it is not what the gateway served anyway.
  _newer(served) {
    let got = null;
    try {
      const v = new URL(this.nc.doc.location.href).searchParams.get("v");
      if (!v) return null;
      got = JSON.parse(this._store()?.getItem(this._newerSlot(served.attrs)) || "null");
      if (!got?.hash || got.hash.slice(0, 12) !== v || hashText(got.text) !== got.hash) return null;
    } catch { return null; }
    const next = parseShell(got.text);
    if (!next || next.sealed === served.sealed) return null;
    for (const a of ["nc:owner", "nc:site", "nc:path"]) if ((next.attrs[a] || "") !== (served.attrs[a] || "")) return null;
    return { hash: got.hash, shell: { attrs: next.attrs, sealed: next.sealed, wraps: next.wraps,
      policy: next.policy || served.policy, title: next.title, text: got.text } };
  }

  // A member with no link: their signer opens the key that was wrapped to them.
  async unlockWith(signer) {
    if (!this.locked || !this.shell) return false;
    const where = this.where(this.shell.attrs);
    const secret = await unwrap(this.shell.wraps, signer.pubkey, where.owner, (pk, c) => signer.nip44Decrypt(pk, c));
    if (!secret) { this._lock("not-a-member"); return false; }
    this._lock("members");     // while it decrypts; replaced by the page a moment later
    this._member = signer.pubkey;      // who is looking, for the page's own comments
    return this._tryOpen(secret, "member");
  }

  // `via` is how it was opened. A page shared with keys and not by link must
  // not grow links because somebody opened its panel.
  _write(plain, keys, via = "link", { served = null } = {}) {
    const doc = this.nc.doc;
    const win = doc.defaultView;
    win[HANDOVER] = { keys, shell: this.shell, plain, via, member: via === "member" ? this._member || null : null, served };
    try { this.nc.destroy(); } catch {}
    // The policy goes in first, so it governs everything the page brings. It is
    // the shell's policy, not anything from inside the ciphertext.
    const meta = `<meta http-equiv="Content-Security-Policy" content="${this.shell.policy.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" nc:shell>`;
    const html = this.shell.policy
      ? (/<head\b[^>]*>/i.test(plain) ? plain.replace(/<head\b[^>]*>/i, (m) => m + meta) : meta + plain)
      : plain;
    doc.open();
    doc.write(html);
    doc.close();
  }

  say(key) {
    const lang = ["en", "es", "sk", "cs"].indexOf((this.nc.doc.documentElement.lang || "en").slice(0, 2).toLowerCase());
    return WORDS[key]?.[Math.max(lang, 0)] || WORDS[key]?.[0] || key;
  }

  // The page a person sees when the shell could not be opened. Drawn here and
  // not by the chrome script, because a shell links nothing but the runtime.
  _lock(why) {
    const doc = this.nc.doc;
    const win = doc.defaultView;
    doc.documentElement.setAttribute("nc:locked", why);
    this.nc._emit("nsiteclay:locked", { why, members: this.shell?.wraps.map((w) => w.p) || [] });
    // A key pasted onto the address of a tab that is already locked changes only
    // the fragment, which loads nothing. Start again with it.
    if (!this._retry) {
      this._retry = true;
      win.addEventListener("hashchange", () => doc.location.reload(), { once: true });
    }
    doc.getElementById("nc-locked")?.remove();
    const box = doc.createElement("main");
    box.id = "nc-locked";
    box.setAttribute("nc:chrome", "");
    box.style.cssText = "max-width:26rem;margin:16vh auto 0;padding:1.5rem 1.25rem;" +
      "font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;color-scheme:light dark";
    const add = (tag, text, css = "") => {
      const el = doc.createElement(tag);
      el.textContent = text; el.style.cssText = css;
      box.append(el);
      return el;
    };
    add("h1", this.say("title"), "font-size:1.35rem;line-height:1.25;margin:0 0 .5rem");
    add("p", this.say(why), "margin:0 0 1.1rem");
    const button = "font:inherit;cursor:pointer;padding:.6rem 1rem;border-radius:9px;border:1px solid;" +
      "background:CanvasText;color:Canvas";

    const expires = Number(this.shell?.attrs["nc:expires"] || 0);
    if (expires && expires * 1000 < Date.now()) add("p", this.say("expired"), "margin:0 0 1.1rem;opacity:.75");

    if (why === "members" || why === "not-a-member") {
      const b = add("button", this.say(why === "members" ? "signIn" : "otherKey"), button);
      b.type = "button";
      b.addEventListener("click", () => this.signIn().catch((e) => toast(e?.message || String(e), { doc })));
    }
    if (why === "no-key" || why === "wrong-key") {
      // A link cut short by a chat app, or opened without its second half. The
      // whole link pasted here is the same as opening it.
      const label = add("label", this.say("paste"), "display:block;font-size:.9rem;opacity:.8;margin:0 0 .3rem");
      const input = doc.createElement("input");
      input.type = "text"; input.autocomplete = "off"; input.spellcheck = false;
      input.id = "nc-locked-link"; label.htmlFor = input.id;
      input.style.cssText = "font:inherit;width:100%;box-sizing:border-box;padding:.55rem .7rem;border-radius:9px;border:1px solid;margin:0 0 .6rem";
      box.append(input);
      const b = add("button", this.say("open"), button);
      b.type = "button";
      const go = () => {
        // Out of whatever was pasted: a sentence around it, a space after it.
        const found = [...input.value.matchAll(/[#&]([ke])=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g)].map((m) => `${m[1]}=${m[2]}`);
        const given = parseFragment(found.join("&"));
        if (!given.edit && !given.read) { toast(this.say("notALink"), { doc }); return; }
        // A page in a workspace needs both halves of its edit link.
        doc.location.hash = given.edit ? "e=" + given.edit + (given.read ? "&k=" + given.read : "") : "k=" + given.read;
      };
      b.addEventListener("click", go);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      if (this.shell?.wraps.length) {
        const alt = add("button", this.say("signIn"), button + ";background:none;color:inherit;margin-left:.5rem");
        alt.type = "button";
        alt.addEventListener("click", () => this.signIn().catch((e) => toast(e?.message || String(e), { doc })));
      }
    }
    doc.body.append(box);
  }

  // Sign in to open a page that was shared with a key rather than a link. An
  // extension first, because it needs no typing; then a signer app, because
  // the key stays on the phone; a pasted key last. Whichever answers, the
  // runtime's login hands the signer to unlockWith.
  async signIn() {
    const nc = this.nc, doc = nc.doc;
    if (doc.defaultView.nostr) {
      try { await nc.login("nip07"); return; } catch { /* the dialog below */ }
    }
    let attempt = null;
    await modal({
      doc, title: this.say("signInTitle"), hint: this.say("signInHint"), submitLabel: this.say("useKey"),
      build: (body, h) => {
        const coarse = !!doc.defaultView.matchMedia?.("(pointer: coarse)").matches;
        // The signer app is the way in for nearly everybody, so it is the first thing
        // on the dialog and it is already waiting: the code behind the button is made
        // when the dialog opens, which is what lets one tap open the app.
        const open = doc.createElement("a");
        open.setAttribute("role", "button");
        open.textContent = this.say("openSignerBtn");
        open.style.cssText = "display:flex;align-items:center;justify-content:center;min-height:3rem;width:100%;margin:.2rem 0 .6rem;" +
          "border-radius:var(--nc-radius-sm,8px);background:var(--nc-accent,#6f5ad1);color:var(--nc-accent-ink,#fff);font-weight:700;" +
          "text-decoration:none;font-size:1.05rem;box-sizing:border-box";
        const toggle = doc.createElement("button");
        toggle.type = "button"; toggle.style.cssText = "width:100%;margin:0 0 .4rem";
        const box = doc.createElement("div");
        box.style.display = coarse ? "none" : "block";
        const qrNote = doc.createElement("p");
        qrNote.className = "nc-hint"; qrNote.style.cssText = "text-align:center;margin:0 0 .4rem"; qrNote.textContent = this.say("qrHint");
        const qrHold = doc.createElement("div");
        box.append(qrHold, qrNote);
        const again = doc.createElement("button");
        again.type = "button"; again.textContent = this.say("retry");
        again.style.cssText = "display:none;margin:.5rem auto 0";
        // Back from the app, the tab may have been put to sleep while the answer came
        // and went. This asks for a new code and a new wait without leaving the dialog.
        const back = doc.createElement("button");
        back.type = "button"; back.textContent = this.say("backFromApp");
        back.style.cssText = "display:none;width:100%;margin:.2rem 0 .4rem";
        const showQr = (on) => { box.style.display = on ? "block" : "none"; toggle.textContent = this.say(on ? "hideQr" : "showQr"); };
        toggle.onclick = () => showQr(box.style.display === "none");
        showQr(!coarse);
        // Each try is a new one-time code: the last one is spent whether or not
        // its answer was seen.
        const start = () => {
          attempt?.cancel?.();
          const { uri, ready, cancel } = nc.connectRemote();
          attempt = { cancel, done: false, at: Date.now() };
          const mine = attempt;
          qrHold.replaceChildren(qrElement(uri, { size: 300 }));
          open.href = uri;
          again.style.display = "none"; back.style.display = "none";
          h.status(this.say("waiting"));
          ready.then(() => { mine.done = true; h.close("done"); }, (e) => {
            if (mine !== attempt) return;
            mine.done = true; h.status(e?.message || String(e), true); again.style.display = "block";
          });
        };
        again.onclick = start;
        back.onclick = start;
        // Leaving for the signer and coming back: offer the way out only then.
        doc.addEventListener("visibilitychange", () => {
          if (doc.visibilityState === "visible" && attempt && !attempt.done && Date.now() - attempt.at > 1500) back.style.display = "block";
        });
        body.append(open, toggle, box, back, again);
        start();
        const more = doc.createElement("details");
        more.style.cssText = "margin-top:.8rem";
        const sum = doc.createElement("summary");
        sum.textContent = this.say("pasteKey"); sum.style.cssText = "cursor:pointer;padding:.4rem 0";
        more.append(sum);
        body.append(more);
        body._key = field(more, { label: this.say("pasteKey"), type: "password", placeholder: "nsec1… / ncryptsec1…" });
        body._pass = field(more, { label: this.say("password"), type: "password" });
        body._pass.parentElement.hidden = true;
        body._key.addEventListener("input", () => {
          body._pass.parentElement.hidden = !body._key.value.trim().startsWith("ncryptsec");
        });
      },
      onSubmit: async (h) => {
        const body = doc.querySelector(".nc-ui .nc-body");
        const key = body._key.value.trim();
        if (!key) throw new Error(this.say("needKey"));
        await nc.login("nsec", { key, password: body._pass.value });
        return "done";
      },
    });
    if (!attempt?.done) attempt?.cancel?.();
  }

  // ---- second boot: the page --------------------------------------------

  // What the shell said about where this page lives wins over whatever the
  // decrypted page says, so a page cannot point its own saves somewhere else.
  pin(cfg, readConfigFrom) {
    if (!this.state) return cfg;
    const root = this.nc.doc.documentElement;
    for (const a of IDENTITY) {
      const v = this.state.shell.attrs[a];
      if (v == null) root.removeAttribute(a); else root.setAttribute(a, v);
    }
    return readConfigFrom(this.nc.doc);
  }

  /** The signer an edit link is. Null for a read link. */
  signer() {
    return this.canEdit ? new LocalSigner(this.state.keys.sk) : null;
  }

  links() {
    const base = this.nc.doc.location.href.split("#")[0];
    const k = this.state?.keys;
    return k ? { read: `${base}#${fragmentOf(k, { edit: false })}`, edit: k.sk ? `${base}#${fragmentOf(k)}` : null } : null;
  }

  /**
   * Show a newer version of this page without asking the gateway for it.
   *
   * `text` is the shell the owner's manifest names for this path, fetched from
   * Blossom by `hash` and checked against it by the caller. A gateway can go on
   * serving the manifest it read hours ago, and with it the shell being
   * replaced, so a reload there opens the old page again. So the newer shell
   * is left in this tab's session storage and the tab reloads at the address
   * that names its hash (?v=); the first boot there opens it in place of the
   * shell the gateway sent (see open and _newer), and tells the page which
   * bytes it shows. A reload and not a rewrite of this document: the page's own
   * scripts have already run in this window, and running them again in it
   * fails on every top-level `let` and `const` they declare.
   *
   * False, and nothing changed, when the shell is not this page's, does not
   * open with this tab's key, links a runtime file this gateway does not serve
   * yet (an upgrade the gateway has not caught up with: the page would come up
   * without its engine), or cannot be kept for the reload.
   */
  async reopen(text, hash, url) {
    if (!this.state) return false;
    const next = parseShell(text);
    if (!next) return false;
    const now = this.state.shell.attrs;
    for (const a of ["nc:owner", "nc:site", "nc:path"]) if ((next.attrs[a] || "") !== (now[a] || "")) return false;
    let plain;
    try { plain = await openText(next.sealed, this.state.keys.K, this.where(next.attrs)); } catch { return false; }
    const doc = this.nc.doc;
    const runtime = [...plain.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']?(\/[^"'\s>]+)/gi)]
      .map((m) => m[1].split(/[?#]/)[0]).filter((p) => RUNTIME_PATH.test(p));
    for (const p of new Set(runtime)) {
      try {
        const res = await fetch(new URL(p, doc.location.origin), { method: "HEAD", credentials: "same-origin" });
        if (!res.ok) return false;
      } catch { return false; }
    }
    const slot = this._newerSlot(now);
    const kept = JSON.stringify({ hash, text });
    try {
      const store = this._store();
      store.setItem(slot, kept);
      if (store.getItem(slot) !== kept) return false;
    } catch { return false; }
    doc.location.replace(url);
    return true;
  }

  /** The hash of the shell this document was opened from, when it is not what this address serves. */
  get served() { return this.state?.served || null; }

  // ---- saving ------------------------------------------------------------

  /**
   * The only thing a sealed page ever uploads. `html` is the page as it would
   * have been published; what comes back is a shell around its ciphertext,
   * checked to be nothing else.
   */
  async seal(html) {
    if (!this.state) throw new Error("Refusing to publish: this page is sealed and has not been opened.");
    const { keys, shell } = this.state;
    const where = this.where(shell.attrs);
    const engine = [...html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']?(\/[^"'\s>]+)/gi)]
      .map((m) => m[1]).find((p) => ENGINE.test(p.split(/[?#]/)[0]));
    if (!engine) throw new Error("Refusing to publish: a sealed page that loads no /nsite-clay.js could never be opened again.");
    const lang = /<html\b[^>]*\blang="([^"]*)"/i.exec(html)?.[1] || shell.attrs.lang || "en";
    const sealed = await sealText(html, keys.K, where);
    const out = buildShell({
      owner: shell.attrs["nc:owner"], site: where.site, path: where.path,
      relays: (shell.attrs["nc:relays"] || "").split(/[,\s]+/).filter(Boolean),
      servers: (shell.attrs["nc:servers"] || "").split(/[,\s]+/).filter(Boolean),
      lang, title: shell.title, policy: shell.policy,
      head: `<script src="${engine}" nc:shell></script>`,
      sealed, wraps: this.state.wraps || shell.wraps, expires: shell.attrs["nc:expires"] || null,
    });
    assertShell(out);
    // And it opens, with the key every reader has. A save that nobody could
    // read back is worse than no save.
    if (await openText(parseShell(out).sealed, keys.K, where) !== html) throw new Error("Refusing to publish: the sealed page did not read back.");
    return out;
  }

  /** Called after a save went through, with the page that is now published. */
  adopt(html) { if (this.state) { this.state.plain = html; this.state.shellChanged = false; } }

  /** True when the next save has to go out even if the page itself is unchanged. */
  get shellChanged() { return !!this.state?.shellChanged; }

  get members() { return this.state ? (this.state.wraps || this.state.shell.wraps) : []; }

  /** Share with one more key. Takes effect on the next save. */
  addMember(pubkey, role = "read") {
    if (!this.canEdit) throw new Error("Only someone who can edit this page can share it");
    const { keys } = this.state;
    const rest = this.members.filter((w) => w.p !== pubkey);
    this.state.wraps = [...rest, wrapFor(keys.sk, pubkey, role, keys.K, { split: !!keys.split })];
    this.state.shellChanged = true;
  }

  // ---- cleaning up -------------------------------------------------------

  // A version a save replaced, once it is safe to delete (see retire.js).
  // Asked of every server and not waited for: the save is done either way, and
  // a server that keeps the old blob costs only its own disk.
  retire(hash, servers, signer) {
    const by = this.signer() || signer;
    if (!by || !hash) return null;
    return removeAll(servers, hash, { signer: by }).catch(() => null);
  }

  /**
   * Delete the page for everyone: an empty manifest first, because a relay
   * that ignores deletion requests (relay.nsite.lol does) still replaces it,
   * then a deletion request for every event, then every version's bytes. The
   * same steps as `artifact delete`, so either can undo what the other made.
   */
  async removePage() {
    if (!this.canEdit) throw new Error("Only someone who can edit this page can delete it");
    const nc = this.nc, cfg = nc.cfg, signer = this.signer();
    const owner = this.where(this.state.shell.attrs).owner;
    const now = Math.floor(Date.now() / 1000);
    const events = (await nc.pool.querySync(cfg.relays, { kinds: [15128, 5128, 10002], authors: [owner] }).catch(() => []))
      .filter((e) => e.pubkey === owner);
    // A page that shares its site with other pages takes only itself out.
    const newest = events.filter((e) => e.kind === 15128).sort((a, b) => b.created_at - a.created_at)[0];
    const others = newest ? Object.keys(manifestPaths(newest)).filter((p) => p !== cfg.path && !RUNTIME_PATH.test(p)) : [];
    if (this.state.keys.split || cfg.path !== "/index.html" || others.length) return this._removeOwnPath(newest, events);
    const pages = new Set([nc._ownHash, nc._servedHash].filter(Boolean));
    for (const ev of events) {
      for (const t of ev.tags) {
        if (t[0] === "path" && t[1] === cfg.path) pages.add(t[2]);
        // Versions a save replaced and kept for a while; see retire.js.
        if (t[0] === "retired" && /^[0-9a-f]{64}$/.test(t[1] || "")) pages.add(t[1]);
      }
    }
    const at = Math.max(now, ...events.map((e) => e.created_at + 1));
    const day = String(now + 86400);
    const send = async (ev) => {
      const out = await Promise.allSettled(nc.pool.publish(cfg.relays, ev));
      return out.filter((r) => r.status === "fulfilled").length;
    };
    const tomb = await signer.sign({ kind: 15128, created_at: at, content: "",
      tags: [["x", hashText(""), "aggregate"], ["expiration", day]] });
    const took = await send(tomb);
    if (!took) throw new Error("No relay answered, so nothing was deleted. Try again in a moment.");
    await send(await signer.sign({ kind: 10002, created_at: at, content: "", tags: [["expiration", day]] }));
    await send(await signer.sign({ kind: 5, created_at: at + 1, content: "deleted from the page",
      tags: [["a", `15128:${owner}:`], ["a", `10002:${owner}:`], ...events.map((e) => ["e", e.id]), ["e", tomb.id],
        ["k", "15128"], ["k", "5128"], ["k", "10002"]] }));
    const servers = [...new Set([...cfg.servers, ...(this.state.shell.attrs["nc:servers"] || "").split(/[,\s]+/).filter(Boolean)])];
    const rows = [];
    for (const hash of pages) rows.push(...await removeAll(servers, hash, { signer }));
    try { this._store()?.removeItem(this._slot(this.state.shell.attrs)); } catch {}
    return { relays: took, blobs: rows };
  }

  // One page of a workspace: a manifest without this path, everything else in
  // it kept as it is, and then this path's own versions deleted, never a blob
  // that a path of the new manifest still names.
  async _removeOwnPath(newest, events) {
    const nc = this.nc, cfg = nc.cfg, signer = this.signer();
    const paths = newest ? manifestPaths(newest) : {};
    delete paths[cfg.path];
    const pages = new Set([nc._ownHash, nc._servedHash].filter(Boolean));
    for (const ev of events.filter((e) => e.kind === 15128)) {
      for (const t of ev.tags) if (t[0] === "path" && t[1] === cfg.path) pages.add(t[2]);
      for (const r of retiredOf(ev)) if (r.path === cfg.path) pages.add(r.hash);
    }
    const keep = mergeRetired([retiredOf(newest)], Object.values(paths)).filter((r) => r.path !== cfg.path);
    const draft = buildManifest(cfg, paths, { sealed: true, retired: keep });
    // What the manifest carried that this runtime does not write itself (other
    // pages' servers, say) stays.
    const own = new Set(draft.tags.map((t) => t[0]));
    for (const t of newest?.tags || []) if (!own.has(t[0]) && !["expiration", "d"].includes(t[0])) draft.tags.push(t);
    for (const t of newest?.tags || []) if (t[0] === "server" && !draft.tags.some((x) => x[0] === "server" && x[1] === t[1])) draft.tags.push(t);
    if (newest && draft.created_at <= newest.created_at) draft.created_at = newest.created_at + 1;
    const manifest = await signer.sign(draft);
    const out = await Promise.allSettled(nc.pool.publish(cfg.relays, manifest));
    const took = out.filter((r) => r.status === "fulfilled").length;
    if (!took) throw new Error("No relay answered, so nothing was deleted. Try again in a moment.");
    const named = namedHashes([manifest]);
    const servers = [...new Set([...cfg.servers, ...(this.state.shell.attrs["nc:servers"] || "").split(/[,\s]+/).filter(Boolean)])];
    const rows = [];
    for (const hash of pages) if (!named.has(hash)) rows.push(...await removeAll(servers, hash, { signer }));
    try { this._store()?.removeItem(this._slot(this.state.shell.attrs)); } catch {}
    return { relays: took, blobs: rows };
  }

  // What is left on screen afterwards: nothing of the page, and nothing that
  // could save it again.
  _gone() {
    const doc = this.nc.doc;
    const lang = doc.documentElement.lang || "en";
    const words = [this.say("deleted"), this.say("deletedNote")];
    this.nc.dirty = false;
    try { this.nc.destroy(); } catch {}
    doc.open();
    doc.write(`<!doctype html><html lang="${lang.replace(/[^A-Za-z-]/g, "")}" nc:deleted><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head><body></body></html>`);
    doc.close();
    doc.title = words[0];
    const box = doc.createElement("main");
    box.style.cssText = "max-width:26rem;margin:16vh auto 0;padding:1.5rem 1.25rem;" +
      "font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;color-scheme:light dark";
    const h = doc.createElement("h1"); h.textContent = words[0]; h.style.cssText = "font-size:1.35rem;margin:0 0 .5rem";
    const p = doc.createElement("p"); p.textContent = words[1]; p.style.margin = "0";
    box.append(h, p);
    doc.body.append(box);
  }

  // ---- the panel ---------------------------------------------------------

  /** The small button an opened sealed page gets, in a corner, for the panel. */
  drawButton() {
    if (!this.state) return null;
    const doc = this.nc.doc;
    doc.getElementById("nc-sealed-menu")?.remove();
    const b = doc.createElement("button");
    b.type = "button";
    b.id = "nc-sealed-menu";
    b.setAttribute("nc:chrome", "");
    b.setAttribute("aria-label", this.say("menu"));
    b.title = this.say("menu");
    // A padlock: what the page is, and where its links are.
    b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/>' +
      '<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';
    b.style.cssText = "position:fixed;z-index:2147483600;right:max(12px,env(safe-area-inset-right));" +
      "bottom:max(12px,env(safe-area-inset-bottom));width:40px;height:40px;margin:0;padding:0;display:grid;" +
      "place-items:center;border-radius:50%;border:1px solid color-mix(in srgb,CanvasText 22%,transparent);" +
      "background:Canvas;color:CanvasText;opacity:.78;cursor:pointer;box-shadow:0 4px 14px -6px rgba(0,0,0,.45);" +
      "color-scheme:light dark";
    b.addEventListener("click", () => this.panel().catch((e) => toast(e?.message || String(e), { doc })));
    doc.body.append(b);
    return b;
  }

  async panel() {
    const nc = this.nc, doc = nc.doc;
    const lang = doc.documentElement.lang || "en";
    const byLink = this.state.via !== "member";
    const links = byLink ? this.links() : null;
    const copy = async (text, button) => {
      try { await doc.defaultView.navigator.clipboard.writeText(text); }
      catch {
        const ta = doc.createElement("textarea");
        ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
        doc.body.append(ta); ta.select();
        try { doc.execCommand("copy"); } catch {}
        ta.remove();
      }
      button.textContent = this.say("copied");
      setTimeout(() => (button.textContent = this.say("copy")), 1600);
    };
    const para = (body, text, css = "") => {
      const p = doc.createElement("p");
      p.textContent = text;
      p.style.cssText = "margin:.6rem 0 0;font-size:.88rem;" + css;
      body.append(p);
      return p;
    };
    const linkRow = (body, label, url, note) => {
      const input = field(body, { label: this.say(label), value: url });
      input.readOnly = true;
      input.setAttribute("data-link", label);
      // Selected on a tap, not on focus: the dialog focuses its first field when
      // it opens, and a selected field scrolls to its end, which is the key.
      input.addEventListener("click", () => input.select());
      const b = doc.createElement("button");
      b.type = "button"; b.textContent = this.say("copy");
      b.setAttribute("data-copy", label);
      b.style.marginTop = ".4rem";
      b.onclick = () => copy(url, b);
      body.append(b);
      if (note) para(body, note, "opacity:.8");
    };
    let open = true;
    const out = await modal({
      doc, title: this.say("panelTitle"), hint: this.say(byLink ? "panelHint" : "memberHint"),
      submitLabel: this.say("close"), noCancel: true,
      build: (body, h) => {
        if (links) {
          linkRow(body, "readLink", links.read);
          if (links.edit) linkRow(body, "editLink", links.edit, this.say("editNote"));
        }
        const exp = this.expires;
        para(body, exp
          ? this.say("expiresOn").replace("{date}", new Date(exp * 1000).toLocaleDateString(lang, { dateStyle: "long" }))
          : this.say("noExpiry"), "margin-top:1rem");

        const members = this.members;
        if (this.canEdit || members.length) {
          const label = doc.createElement("label");
          label.textContent = this.say("people");
          label.style.marginTop = "1.1rem";
          body.append(label);
          const ul = doc.createElement("ul");
          ul.style.cssText = "margin:.2rem 0 0;padding-left:1.1rem;font-size:.88rem";
          ul.setAttribute("data-members", "");
          const draw = () => {
            ul.replaceChildren(...this.members.map((w) => {
              const li = doc.createElement("li");
              const npub = nip19.npubEncode(w.p);
              li.textContent = `${npub.slice(0, 14)}…${npub.slice(-6)} ${this.say(w.r === "edit" ? "canEdit" : "canRead")}`;
              li.title = npub;
              return li;
            }));
            ul.hidden = !this.members.length;
          };
          draw();
          body.append(ul);
          if (this.canEdit) {
            const row = doc.createElement("div");
            row.className = "nc-row";
            row.style.alignItems = "flex-end";
            body.append(row);
            const who = field(row, { label: this.say("addPerson"), placeholder: "npub1…" });
            who.setAttribute("data-add-member", "");
            const role = field(row, { label: " ", options: [
              { value: "read", label: this.say("roleRead") }, { value: "edit", label: this.say("roleEdit") }] });
            role.setAttribute("data-add-role", "");
            role.parentElement.style.flex = "0 0 auto";
            const add = doc.createElement("button");
            add.type = "button"; add.textContent = this.say("add");
            add.setAttribute("data-add", "");
            add.style.marginTop = ".4rem";
            add.onclick = async () => {
              let hex;
              try {
                const d = nip19.decode(who.value.trim());
                hex = d.type === "npub" ? d.data : d.type === "nprofile" ? d.data.pubkey : null;
              } catch { hex = /^[0-9a-f]{64}$/.test(who.value.trim()) ? who.value.trim() : null; }
              if (!hex) { h.status(this.say("badNpub"), true); return; }
              add.disabled = true;
              h.status("");
              try {
                this.addMember(hex, role.value);
                await nc.save();
                who.value = "";
                draw();
                h.status(this.say("added"));
              } catch (e) { h.status(e?.message || String(e), true); }
              finally { add.disabled = false; }
            };
            body.append(add);
            para(body, this.say("removeNote"), "opacity:.8");
          }
        }

        if (this.canEdit) {
          const del = doc.createElement("button");
          del.type = "button"; del.textContent = this.say("deleteNow");
          del.setAttribute("data-delete", "");
          del.style.cssText = "margin-top:1.3rem;color:#c0392b";
          del.onclick = async () => {
            const sure = await modal({ doc, title: this.say("deleteTitle"), hint: this.say("deleteHint"),
              submitLabel: this.say("delete"),
              onSubmit: async (h2) => {
                h2.status(this.say("deleting"));
                await this.removePage();
                return "deleted";
              } });
            if (sure !== "deleted") return;
            open = false;
            h.close("deleted");
          };
          body.append(del);
        }
      },
      onSubmit: () => "closed",
    });
    if (out === "deleted" || !open) this._gone();
    return out;
  }
}

export { hex };
