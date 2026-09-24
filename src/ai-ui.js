import { AiClient, aiEndpoint } from "./ai-client.js";
import { modal, field, notice } from "./ui.js";
import { qrElement } from "./qr.js";
import { installEditing, editDialog, propose, proposePage, accept } from "./ai-edit.js";
import { buildPage, refinePage, applyPage, preparePage } from "./ai-builder.js";
import { previewHTML } from "./ai-edit.js";
import { FLOW_WORDS } from "./ai-flow-words.js";
import { creditDialog, withdrawalDialog } from "./ai-credit.js";
import { readinessPanel } from "./ai-status.js";
import { AiDrafts } from "./ai-drafts.js";

const WORDS = {
  ...FLOW_WORDS,
  settings: ["AI settings", "Ajustes de IA", "Nastavenia AI", "Nastavení AI"],
  hint: ["AI uses our Cypherpunk Routstr node by default. Fees support nsite-clay. You can choose another node or use your own API key.", "La IA usa nuestro nodo Routstr Cypherpunk por defecto. Las tarifas ayudan a mantener nsite-clay. Puedes elegir otro nodo o usar tu propia clave API.", "AI predvolene používa náš Routstr node Cypherpunk. Poplatky podporujú nsite-clay. Môžeš si vybrať iný node alebo vlastný API kľúč.", "AI ve výchozím nastavení používá náš Routstr node Cypherpunk. Poplatky podporují nsite-clay. Můžeš si vybrat jiný node nebo vlastní API klíč."],
  apply: ["Save AI settings", "Guardar ajustes de IA", "Uložiť nastavenia AI", "Uložit nastavení AI"],
  provider: ["Provider", "Proveedor", "Poskytovateľ", "Poskytovatel"],
  byok: ["My own API key", "Mi propia clave API", "Vlastný API kľúč", "Vlastní API klíč"],
  endpoint: ["API base URL", "URL base de la API", "Základná URL API", "Základní URL API"],
  key: ["API key for this endpoint", "Clave API de este servidor", "API kľúč pre tento server", "API klíč pro tento server"],
  keyRoutstr: ["Node key (you get one by adding credit)", "Clave del nodo (la obtienes al añadir saldo)", "Kľúč nodu (dostaneš ho, keď pridáš kredit)", "Klíč nodu (dostaneš ho, když přidáš kredit)"],
  keyHintRoutstr: ["Adding credit creates a key automatically. Paste an existing node key here only to reuse credit you already bought.", "Añadir saldo crea una clave automáticamente. Pega una clave existente solo para reutilizar saldo que ya compraste.", "Pridanie kreditu automaticky vytvorí kľúč. Existujúci kľúč vlož len na použitie už kúpeného kreditu.", "Přidání kreditu automaticky vytvoří klíč. Existující klíč vlož jen pro použití už koupeného kreditu."],
  model: ["Model ID", "ID del modelo", "ID modelu", "ID modelu"],
  models: ["Load models", "Cargar modelos", "Načítať modely", "Načíst modely"],
  local: ["Your AI key is kept out of the page. Save it to your own Nostr relays, encrypted to your key, and any device you can sign with gets it back.", "Tu clave de IA se guarda fuera de la página. Guárdala en tus propios relays de Nostr, cifrada con tu clave, y la recuperas en cualquier dispositivo con el que puedas firmar.", "AI kľúč sa neukladá do stránky. Ulož si ho na vlastné Nostr relaye, zašifrovaný tvojím kľúčom, a dostaneš ho späť na každom zariadení, ktorým vieš podpisovať.", "AI klíč se neukládá do stránky. Ulož si ho na vlastní Nostr relaye, zašifrovaný tvým klíčem, a dostaneš ho zpět na každém zařízení, kterým umíš podepisovat."],
  backup: ["Save to my Nostr relays", "Guardar en mis relays de Nostr", "Uložiť na moje Nostr relaye", "Uložit na moje Nostr relaye"],
  download: ["Download a copy instead", "Descargar una copia", "Stiahnuť kópiu", "Stáhnout kopii"],
  restore: ["Restore from my relays", "Restaurar desde mis relays", "Obnoviť z mojich relayov", "Obnovit z mých relayů"],
  saved: ["Saved to your relays, encrypted to your key.", "Guardado en tus relays, cifrado con tu clave.", "Uložené na tvoje relaye, zašifrované tvojím kľúčom.", "Uloženo na tvoje relaye, zašifrované tvým klíčem."],
  restored: ["Restored from your relays.", "Restaurado desde tus relays.", "Obnovené z tvojich relayov.", "Obnoveno z tvých relayů."],
  nothingStored: ["Nothing is stored on your relays yet.", "Todavía no hay nada en tus relays.", "Na tvojich relayoch zatiaľ nič nie je.", "Na tvých relayích zatím nic není."],
  noVault: ["This signer cannot encrypt, so the key stays in this browser. Download a copy to keep it.", "Este firmante no puede cifrar, así que la clave se queda en este navegador. Descarga una copia para conservarla.", "Tento signer nevie šifrovať, takže kľúč zostáva v tomto prehliadači. Stiahni si kópiu, ak si ho chceš nechať.", "Tenhle signer neumí šifrovat, takže klíč zůstává v tomhle prohlížeči. Stáhni si kopii, pokud si ho chceš nechat."],
  payTo: ["Lightning address (optional)", "Dirección Lightning (opcional)", "Lightning adresa (nepovinné)", "Lightning adresa (nepovinné)"],
  payToHint: ["Give one and the node pays your credit there. Leave it empty and you get a Cashu token to paste into a wallet.", "Si la indicas, el nodo te envía ahí el saldo. Si la dejas vacía, recibes un token Cashu para pegar en una cartera.", "Ak ju zadáš, node ti kredit pošle tam. Ak ju necháš prázdnu, dostaneš Cashu token na vloženie do peňaženky.", "Když ji zadáš, node ti kredit pošle tam. Když ji necháš prázdnou, dostaneš Cashu token na vložení do peněženky."],
  forget: ["Forget this key", "Olvidar esta clave", "Zabudnúť tento kľúč", "Zapomenout tento klíč"],
  balance: ["Check balance", "Consultar saldo", "Zistiť zostatok", "Zjistit zůstatek"],
  amount: ["Credit to add (sats)", "Saldo que añadir (sats)", "Pridať kredit (sats)", "Přidat kredit (sats)"],
  lightning: ["Pay with Lightning", "Pagar con Lightning", "Zaplatiť cez Lightning", "Zaplatit přes Lightning"],
  cashu: ["Cashu token", "Token Cashu", "Cashu token", "Cashu token"],
  deposit: ["Add Cashu credit", "Añadir saldo Cashu", "Pridať Cashu kredit", "Přidat Cashu kredit"],
  refund: ["Withdraw remaining credit", "Retirar el saldo restante", "Vybrať zvyšný kredit", "Vybrat zbývající kredit"],
  lastRefund: ["Show last withdrawal", "Ver el último retiro", "Zobraziť posledný výber", "Zobrazit poslední výběr"],
  refundHint: ["Copy this token into your Cashu wallet. The browser keeps a copy in AI settings until you collect it.", "Copia este token en tu cartera Cashu. El navegador guarda una copia en los ajustes de IA para que puedas recogerlo.", "Vlož tento token do Cashu peňaženky. Prehliadač ponechá kópiu v nastaveniach AI, aby si si ho mohol vyzdvihnúť.", "Vlož tento token do Cashu peněženky. Prohlížeč ponechá kopii v nastavení AI, aby sis ho mohl vyzvednout."],
  paid: ["Credit added", "Saldo añadido", "Kredit pridaný", "Kredit přidán"],
  wait: ["Waiting for payment…", "Esperando el pago…", "Čaká sa na platbu…", "Čeká se na platbu…"],
  check: ["Check payment", "Comprobar pago", "Skontrolovať platbu", "Zkontrolovat platbu"],
  invoice: ["Lightning invoice", "Factura Lightning", "Lightning faktúra", "Lightning faktura"],
  openWallet: ["Open Lightning wallet", "Abrir cartera Lightning", "Otvoriť Lightning peňaženku", "Otevřít Lightning peněženku"],
  close: ["Close", "Cerrar", "Zavrieť", "Zavřít"],
  copy: ["Copy", "Copiar", "Skopírovať", "Zkopírovat"],
  copied: ["Copied", "Copiado", "Skopírované", "Zkopírováno"],
  needKey: ["Add credit or enter a key first.", "Añade saldo o introduce una clave primero.", "Najprv pridaj kredit alebo vlož kľúč.", "Nejdřív přidej kredit nebo vlož klíč."],
  expired: ["This invoice has expired. Close it and create a new one.", "Esta factura ha caducado. Ciérrala y crea una nueva.", "Faktúra vypršala. Zavri ju a vytvor novú.", "Faktura vypršela. Zavři ji a vytvoř novou."],
  working: ["Working…", "Procesando…", "Pracuje sa…", "Pracuje se…"],
  rates: ["sats per 1,000 tokens: input / output", "sats por 1.000 tokens: entrada / salida", "sats za 1 000 tokenov: vstup / výstup", "sats za 1 000 tokenů: vstup / výstup"],
  generate: ["Generate preview", "Generar vista previa", "Vytvoriť náhľad", "Vytvořit náhled"],
  edit: ["Edit with AI", "Editar con IA", "Upraviť s AI", "Upravit s AI"],
  editHint: ["Say what should change. By default this rewrites the whole page, so you can change the design, add a section, or reword everything at once.", "Di qué quieres cambiar. Por defecto esto reescribe la página entera, así que puedes cambiar el diseño, añadir una sección o reescribirlo todo de una vez.", "Povedz, čo sa má zmeniť. Predvolene sa prepíše celá stránka, takže vieš zmeniť dizajn, pridať sekciu alebo preformulovať všetko naraz.", "Řekni, co se má změnit. Ve výchozím nastavení se přepíše celá stránka, takže umíš změnit design, přidat sekci nebo přeformulovat všechno naráz."],
  scope: ["What should AI change?", "¿Qué debe cambiar la IA?", "Čo má AI zmeniť?", "Co má AI změnit?"],
  scopePage: ["The whole page", "La página entera", "Celú stránku", "Celou stránku"],
  staticSelection: ["AI will change only the selected text or block. Your live feeds, forms and scripts stay in place.", "La IA cambiará solo el texto o bloque seleccionado. Tus feeds, formularios y scripts se conservan.", "AI zmení len vybraný text alebo blok. Živé kanály, formuláre a skripty zostanú zachované.", "AI změní jen vybraný text nebo blok. Živé kanály, formuláře a skripty zůstanou zachovány."],
  staticOnly: ["This page has a form or custom script that a whole-page rewrite would remove. You can edit selected text with AI. Close this dialog, click the text, then open Edit with AI again.", "Esta página tiene un formulario o script propio que una reescritura completa eliminaría. Puedes editar texto seleccionado con IA. Cierra este cuadro, pulsa el texto y vuelve a abrir Editar con IA.", "Táto stránka má formulár alebo vlastný skript, ktorý by prepis celej stránky odstránil. S AI môžeš upraviť vybraný text. Zavri toto okno, klikni na text a znova otvor Upraviť s AI.", "Tahle stránka má formulář nebo vlastní skript, který by přepis celé stránky odstranil. S AI můžeš upravit vybraný text. Zavři toto okno, klikni na text a znovu otevři Upravit s AI."],
  feedLost: ["The new version left out one of the page's live feeds, so it was not used. Try again, or say where the feed should go.", "La nueva versión dejó fuera uno de los feeds de la página, así que no se ha usado. Inténtalo de nuevo o di dónde debe ir el feed.", "Nová verzia vynechala jeden zo živých kanálov stránky, preto sa nepoužila. Skús to znova alebo povedz, kam má kanál patriť.", "Nová verze vynechala jeden z živých kanálů stránky, proto se nepoužila. Zkus to znovu nebo řekni, kam má kanál patřit."],
  scopeElement: ["Only what I clicked", "Solo lo que he pulsado", "Len to, na čo som klikol", "Jen to, na co jsem klikl"],
  editPlaceholder: ["Make it darker and warmer, add a section about our roasting, and move the photos above the opening hours", "Ponla más oscura y cálida, añade una sección sobre nuestro tueste y mueve las fotos encima del horario", "Sprav to tmavšie a teplejšie, pridaj sekciu o našom pražení a fotky daj nad otváracie hodiny", "Udělej to tmavší a teplejší, přidej sekci o našem pražení a fotky dej nad otevírací dobu"],
  tooBig: ["This page may be too long to rewrite in one go. Click the part you want changed, then press Edit with AI again and choose it in the box.", "Puede que esta página sea demasiado larga para reescribirla de una vez. Pulsa la parte que quieres cambiar, vuelve a pulsar Editar con IA y elígela en el cuadro.", "Táto stránka je možno pridlhá na to, aby sa prepísala naraz. Klikni na časť, ktorú chceš zmeniť, znova stlač Upraviť s AI a vyber ju v okne.", "Tahle stránka je možná moc dlouhá na to, aby se přepsala najednou. Klikni na část, kterou chceš změnit, znovu stiskni Upravit s AI a vyber ji v okně."],
  reviewPage: ["This replaces the whole page. Nothing is published until you press Save, and undo brings the old page back.", "Esto sustituye la página entera. No se publica nada hasta que pulses Guardar, y deshacer recupera la página anterior.", "Toto nahradí celú stránku. Kým nestlačíš Uložiť, nič sa nezverejní, a späť vráti starú stránku.", "Tohle nahradí celou stránku. Dokud nestiskneš Uložit, nic se nezveřejní, a zpět vrátí starou stránku."],
  describe: ["What should change?", "¿Qué quieres cambiar?", "Čo sa má zmeniť?", "Co se má změnit?"],
  keep: ["Keep this change", "Aceptar este cambio", "Prijať zmenu", "Přijmout změnu"],
  backInstruction: ["Back to my instruction", "Volver a mi instrucción", "Späť k môjmu zadaniu", "Zpět k mému zadání"],
  kept: ["Change kept. Press Save to publish it, or Undo to go back.", "Cambio aceptado. Pulsa Guardar para publicarlo o Deshacer para volver atrás.", "Zmena prijatá. Zverejni ju tlačidlom Uložiť, alebo ju vráť tlačidlom Späť.", "Změna přijata. Zveřejni ji tlačítkem Uložit, nebo ji vrať tlačítkem Zpět."],
  preview: ["Preview", "Vista previa", "Náhľad", "Náhled"],
  generating: ["Generating…", "Generando…", "Generuje sa…", "Generuje se…"],
  thinking: ["Thinking…", "Pensando…", "Rozmýšľa…", "Rozmýšlí…"],
  noCredit: ["You have no AI credit here yet. Add some, or use an API key of your own.", "Todavía no tienes saldo de IA aquí. Añade saldo o usa una clave API propia.", "Zatiaľ tu nemáš AI kredit. Pridaj si ho, alebo použi vlastný API kľúč.", "Zatím tu nemáš AI kredit. Přidej si ho, nebo použij vlastní API klíč."],
  addCredit: ["Add AI credit", "Añadir saldo de IA", "Pridať AI kredit", "Přidat AI kredit"],
  looking: ["Looking for your credit on your relays…", "Buscando tu saldo en tus relays…", "Hľadám tvoj kredit na tvojich relayoch…", "Hledám tvůj kredit na tvých relayích…"],
  adopted: ["Found the credit you bought. It is ready here.", "Encontramos el saldo que compraste. Ya está listo aquí.", "Našiel sa kredit, ktorý si kúpil. Je pripravený aj tu.", "Našel se kredit, který sis koupil. Je připravený i tady."],
  before: ["Now", "Ahora", "Teraz", "Teď"],
  after: ["After this change", "Después del cambio", "Po zmene", "Po změně"],
  review: ["Review the result before keeping it. Save the page when you are ready to publish.", "Revisa el resultado antes de aceptarlo. Guarda la página cuando quieras publicarlo.", "Pred prijatím si výsledok skontroluj. Keď ho chceš zverejniť, ulož stránku.", "Před přijetím si výsledek zkontroluj. Až ho chceš zveřejnit, ulož stránku."],
};

export class Ai {
  constructor(nc) {
    this.nc = nc; this.doc = nc.doc;
    let storage; try { storage = this.doc.defaultView.localStorage; } catch {}
    this.client = new AiClient(storage);
    this.drafts = new AiDrafts(nc, storage);
  }
  say(key) {
    const lang = ["en", "es", "sk", "cs"].indexOf(this.doc.documentElement.lang.slice(0, 2));
    return WORDS[key]?.[Math.max(lang, 0)] || key;
  }

  start() { installEditing(this); }
  edit(target) {
    if (!this._editing) this._editing = editDialog(this, target).finally(() => { this._editing = null; });
    return this._editing;
  }
  addCredit() {
    if (!this._funding) this._funding = creditDialog(this).finally(() => { this._funding = null; });
    return this._funding;
  }
  withdraw() { return withdrawalDialog(this); }
  readiness(parent, options) { return readinessPanel(this, parent, options); }
  propose(target, prompt, options) { return propose(this, target, prompt, options); }
  proposePage(prompt, options) { return proposePage(this, prompt, options); }
  applyPage(html, options) { return applyPage(this, html, options); }
  accept(proposal) { return accept(this, proposal); }
  buildPage(description, options) { return buildPage(this, description, options); }
  refinePage(page, instruction, options) { return refinePage(this, page, instruction, options); }

  /**
   * Bring the credit somebody already paid for into whatever browser they are in.
   *
   * The credit is bought in the publisher and spent in the published page, and
   * those are two different origins: nothing one of them puts in localStorage is
   * visible to the other. The key itself is on the owner's own relays, encrypted
   * to the owner's own key, and the owner is signed in or this would not be
   * running. So fetch it rather than telling them they have no credit when they
   * plainly do, which is what used to happen the first time anybody opened the
   * page they had just paid to have built.
   *
   * Once found it is written to this browser's storage like any other key, so
   * this costs one relay round trip per browser rather than one per edit.
   *
   * Returns true when a key is now in hand. Every failure is quiet and leaves
   * things exactly as they were: this runs before somebody asked for anything.
   */
  adopt({ force = false, base } = {}) {
    if (!force && this.client.session().key) return Promise.resolve(true);
    // Signing in, opening the toolbar and opening the dialog can all ask within
    // a second of each other. One lookup answers all three, and a different key
    // signing in is a different question.
    const who = this.nc.pubkey || "";
    if (force || this._adoptedFor !== who) { this._adoptedFor = who; this._adopting = this._adopt(base, force); }
    return this._adopting;
  }

  async _adopt(requestedBase, preferSaved = false) {
    const vault = this.nc.vault;
    if (!vault?.usable) return false;
    const who = this.nc.pubkey;
    let data;
    try { data = await vault.load({ force: true }); } catch { return false; }
    if (who !== this.nc.pubkey) return false;
    const stored = data?.ai;
    if (!stored || typeof stored !== "object") return false;
    const here = requestedBase || ((preferSaved || !this.client.data.config) && data.aiSelected) || this.client.session().base;
    if (typeof stored[here] === "string" && stored[here].trim()) return this.restoreProfile(here, stored[here], data.aiProfiles?.[here]);
    if (requestedBase) return false;
    // The credit may sit on a node this browser is not pointed at, because the
    // node is chosen per browser and the credit is not. One stored node is not
    // ambiguous, so follow it; several would be a guess, and guessing which node
    // to spend somebody's money at is not this function's business.
    const others = Object.entries(stored).filter(([, k]) => typeof k === "string" && k.trim());
    if (others.length !== 1) return false;
    const [base, key] = others[0];
    return this.restoreProfile(base, key, data.aiProfiles?.[base]);
  }

  restoreProfile(base, key, profile) {
    const config = profile || { ...this.client.config, base };
    try {
      if (config.base !== base || aiEndpoint(base, config.mode) !== base || !config.model?.trim()) return false;
      this.client.configure({ ...config, key });
    } catch {
      // configure can succeed in memory while localStorage is unavailable.
      return this.client.session().base === base && this.client.session().key === key;
    }
    return true;
  }

  relayData(current, base = this.client.config.base) {
    return { ai: { ...(current?.ai || {}), [base]: this.client.record(base).key },
      aiProfiles: { ...(current?.aiProfiles || {}), [base]: this.client.profile(base) }, aiSelected: base };
  }

  downloadKey() {
    this.download(this.client.session(), "nsite-clay-ai-key.json");
  }
  download(value, name, type = "application/json") {
    const url = URL.createObjectURL(new Blob([typeof value === "string" ? value : JSON.stringify(value, null, 2)], { type }));
    const a = this.doc.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Put the key for `base` on the owner's own relays, encrypted to them.
   *
   * Called after anything that hands one back, because a key that exists in one
   * browser and nowhere else is a key somebody loses by clearing their history.
   * Quiet on failure: they have the credit either way, and the button in the
   * settings box does the same thing with a message when it matters.
   */
  async keepOnRelays(base = this.client.config.base) {
    const vault = this.nc.vault;
    const key = this.client.record(base).key;
    if (!key || !vault?.usable) return false;
    try {
      const current = await vault.load();
      if (current === null) return false;
      const patch = this.relayData(current, base);
      if (current?.ai?.[base] === key && current.aiSelected === base &&
        JSON.stringify(current.aiProfiles?.[base]) === JSON.stringify(patch.aiProfiles[base])) return true;
      return await vault.save(patch);
    } catch { return false; }
  }

  /**
   * Hold a key, and keep it if this browser lets us.
   *
   * Storage can be switched off or full. That is a reason not to have it next
   * time, never a reason not to have it now: the key is in the session either
   * way and the edit somebody is in the middle of goes ahead.
   */
  take(key, base) {
    try { this.client.setKey(key, base); }
    catch { this.client.record(base).key = String(key).trim(); }
    return !!this.client.session().key;
  }
  preparePage(html, options) { return preparePage(html, options); }
  previewHTML(html, options) { return previewHTML(html, { base: this.doc.baseURI, ...options }); }

  async settings() {
    const client = this.client, say = (key) => this.say(key);
    // Before the box is drawn, so the key field holds the key they already own
    // rather than being empty next to a button called "Restore from my relays".
    // Bounded by the vault's own timeouts, and a failure just leaves it empty.
    if (this.nc.isOwner) await this.adopt().catch(() => false);
    let mode, base, key, model, backedUp = true;
    const result = await modal({ doc: this.doc, title: say("settings"), hint: say("hint"), submitLabel: say("apply"),
      build: (body, h) => {
        const current = client.session();
        const readiness = this.readiness(body); readiness.refresh();
        const payments = this.doc.createElement("div"); payments.className = "nc-row"; body.append(payments);
        const section = (name) => {
          const el = this.doc.createElement("details"), title = this.doc.createElement("summary");
          title.textContent = say(name); el.append(title); body.append(el); return el;
        };
        const advanced = section("advanced"); advanced.className = "nc-ai-provider";
        advanced.open = current.mode === "byok" && !current.key;
        mode = field(advanced, { label: say("provider"), value: current.mode, options: [
          { value: "routstr", label: "Routstr (Cashu / Lightning)" }, { value: "byok", label: say("byok") }] });
        base = field(advanced, { label: say("endpoint"), value: current.base });
        key = field(advanced, { label: say("key"), type: "password", value: current.key });
        // With Routstr this field is an output, not a question: the node issues the
        // key when you pay. Saying so is the difference between an empty box you are
        // expected to fill and an empty box that is empty on purpose.
        const keyHint = this.doc.createElement("p"); keyHint.className = "nc-hint";
        (key.closest(".nc-field") || key).after(keyHint);
        model = field(advanced, { label: say("model"), value: current.model });
        const options = this.doc.createElement("datalist"); options.id = model.id + "-models";
        model.setAttribute("list", options.id); advanced.append(options);
        const rates = this.doc.createElement("p"); rates.className = "nc-hint"; advanced.append(rates);
        let models = [], working = false;
        const session = () => ({ mode: mode.value, base: aiEndpoint(base.value, mode.value), key: key.value.trim(), model: model.value.trim() });
        const apply = () => client.configure(session());
        const button = (parent, name, fn) => {
          const b = this.doc.createElement("button"); b.type = "button"; b.textContent = say(name);
          b.dataset.ncAiBtn = name; parent.append(b);
          b.onclick = async () => {
            if (working) return;
            working = true;
            const controls = [...body.querySelectorAll("input, select, button")].map((el) => [el, el.disabled]);
            controls.forEach(([el]) => { el.disabled = true; });
            h.busy(true); h.status(say("working"));
            try { h.status((await fn()) || ""); } catch (e) { h.status(e.message, true); }
            finally { working = false; controls.forEach(([el, disabled]) => { el.disabled = disabled; }); gate(); h.busy(false); }
          };
          return b;
        };
        const price = () => {
          const p = models.find((m) => m.id === model.value)?.sats_pricing;
          rates.textContent = p ? `${(p.prompt * 1000).toFixed(3)} / ${(p.completion * 1000).toFixed(3)} ${say("rates")}` : "";
        };
        model.addEventListener("input", price);
        button(advanced, "models", async () => {
          const selected = session(); models = await client.models(selected); options.replaceChildren();
          for (const m of models) { const o = this.doc.createElement("option"); o.value = m.id; o.label = m.name || m.id; options.append(o); }
          price();
        });
        const backups = section("backups");
        const note = this.doc.createElement("p"); note.className = "nc-hint"; note.textContent = say("local"); backups.append(note);
        // The credit somebody paid for should not depend on one browser's storage,
        // and a downloaded file is a chore people do not do and cannot do on a
        // phone. It goes to their own relays, encrypted to their own key.
        const vault = this.nc.vault;
        button(backups, "backup", async () => {
          const s = apply(); if (!s.key) throw new Error(say("needKey"));
          if (!vault?.usable) throw new Error(say("noVault"));
          const ok = await this.keepOnRelays(s.base);
          if (!ok) throw new Error(say("backupFailed"));
          return say("saved");
        });
        button(backups, "restore", async () => {
          if (!vault?.usable) throw new Error(say("noVault"));
          if (!await this.adopt({ force: true })) throw new Error(say("restoreFailed"));
          const found = client.session();
          mode.value = found.mode; base.value = found.base; key.value = found.key; model.value = found.model;
          advanced.open = true; gate(); await readiness.refresh();
          return say("restored");
        });
        // Kept, demoted: relays can be unreachable and some signers cannot encrypt.
        button(backups, "download", () => {
          const s = apply(); if (!s.key) throw new Error(say("needKey"));
          this.downloadKey();
        });
        button(backups, "forget", async () => { key.value = ""; apply(); gate(); await readiness.refresh(); });
        button(payments, "addCredit", async () => {
          apply(); await this.addCredit(); key.value = client.session().key; gate(); await readiness.refresh();
        });
        const refundDisplay = (result) => notice(result?.token ? say("refundHint") : result?.status || "", {
          doc: this.doc, title: say("refund"), detail: result?.token || JSON.stringify(result),
          labels: { copy: say("copy"), copied: say("copied"), close: say("close") },
        });
        button(payments, "refund", async () => { apply(); await this.withdraw(); await readiness.refresh(); });
        button(backups, "lastRefund", () => { const result = client.record(session().base).refund; if (result) refundDisplay(result); });
        // Asking a node about a balance that does not exist yet is how you get a
        // raw 422 on screen. Until there is a key, the only thing on offer is
        // buying one.
        const gate = () => {
          const routstr = mode.value === "routstr";
          const has = !!key.value.trim();
          payments.hidden = !routstr;
          keyHint.textContent = routstr ? say("keyHintRoutstr") : "";
          const label = key.labels && key.labels[0];
          if (label) label.textContent = say(routstr ? "keyRoutstr" : "key");
          for (const name of ["balance", "refund", "lastRefund", "backup", "download", "forget"]) {
            const b = body.querySelector(`[data-nc-ai-btn="${name}"]`);
            if (b) b.disabled = !has;
          }
        };
        const changed = () => {
          try { key.value = client.record(aiEndpoint(base.value, mode.value)).key || ""; } catch { key.value = ""; }
          models = []; options.replaceChildren(); rates.textContent = "";
          gate();
        };
        base.addEventListener("input", changed); mode.addEventListener("change", changed);
        key.addEventListener("input", gate);
        gate();
      },
      onSubmit: async () => {
        const selected = client.configure({ mode: mode.value, base: base.value, key: key.value, model: model.value });
        if (selected.key) backedUp = await this.keepOnRelays();
        return selected;
      },
    });
    if (result && !backedUp) notice(say("backupFailed"), { doc: this.doc, title: say("backups"), bad: true });
    return result;
  }

  async showInvoice(invoice, session) {
    let closed = false, timer, helpers, checking = false;
    const check = async () => {
      if (closed || checking) return;
      checking = true;
      try {
        const out = await this.client.invoiceStatus(invoice, session);
        if (out.status === "paid" && closed && !await this.keepOnRelays(session.base)) {
          notice(this.say("backupFailed"), { doc: this.doc, title: this.say("backups"), bad: true });
        }
        if (closed) return;
        if (out.status === "paid") { helpers.close(true); return; }
        if (out.status === "expired") {
          delete this.client.record(session.base).invoice; this.client.persist();
          helpers.status(this.say("expired"), true); return;
        }
        helpers.status(this.say("wait"));
        timer = setTimeout(check, 3000);
      } catch (e) { if (!closed) helpers.status(e.message, true); }
      finally { checking = false; }
    };
    try {
      return await modal({ doc: this.doc, title: this.say("invoice"), hint: `${invoice.amount_sats} sats · ${new URL(session.base).host}`,
        submitLabel: this.say("check"),
        build: (body, h) => {
          helpers = h;
          const qr = qrElement(invoice.bolt11.toUpperCase(), { doc: this.doc });
          qr.style.cssText = "display:block;width:min(240px,100%);height:auto;margin:1rem auto;background:white"; body.append(qr);
          const input = field(body, { label: this.say("invoice"), value: invoice.bolt11, rows: 3 }); input.readOnly = true;
          const link = this.doc.createElement("a"); link.href = "lightning:" + invoice.bolt11; link.textContent = this.say("openWallet"); body.append(link);
          timer = setTimeout(check, 100);
        },
        onSubmit: async () => { clearTimeout(timer); await check(); },
      });
    } finally { closed = true; clearTimeout(timer); }
  }
}
