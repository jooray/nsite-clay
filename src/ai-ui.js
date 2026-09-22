import { AiClient, aiEndpoint } from "./ai-client.js";
import { modal, field, notice } from "./ui.js";
import { qrElement } from "./qr.js";
import { installEditing, editDialog, propose, accept } from "./ai-edit.js";
import { buildPage, preparePage } from "./ai-builder.js";
import { previewHTML } from "./ai-edit.js";

const WORDS = {
  settings: ["AI settings", "Ajustes de IA", "Nastavenia AI", "Nastavení AI"],
  hint: ["AI uses our Cypherpunk Routstr node by default. Fees support nsite-clay. You can choose another node or use your own API key.", "La IA usa nuestro nodo Routstr Cypherpunk por defecto. Las tarifas ayudan a mantener nsite-clay. Puedes elegir otro nodo o usar tu propia clave API.", "AI predvolene používa náš Routstr node Cypherpunk. Poplatky podporujú nsite-clay. Môžeš si vybrať iný node alebo vlastný API kľúč.", "AI ve výchozím nastavení používá náš Routstr node Cypherpunk. Poplatky podporují nsite-clay. Můžeš si vybrat jiný node nebo vlastní API klíč."],
  apply: ["Save AI settings", "Guardar ajustes de IA", "Uložiť nastavenia AI", "Uložit nastavení AI"],
  provider: ["Provider", "Proveedor", "Poskytovateľ", "Poskytovatel"],
  byok: ["My own API key", "Mi propia clave API", "Vlastný API kľúč", "Vlastní API klíč"],
  endpoint: ["API base URL", "URL base de la API", "Základná URL API", "Základní URL API"],
  key: ["API key for this endpoint", "Clave API de este servidor", "API kľúč pre tento server", "API klíč pro tento server"],
  keyRoutstr: ["Node key (you get one by adding credit)", "Clave del nodo (la obtienes al añadir saldo)", "Kľúč nodu (dostaneš ho, keď pridáš kredit)", "Klíč nodu (dostaneš ho, když přidáš kredit)"],
  keyHintRoutstr: ["Leave this empty. A Routstr node issues the key when you pay, below. Paste one only to reuse credit you already bought on another device.", "Déjalo vacío. El nodo Routstr emite la clave cuando pagas, más abajo. Pega una solo para reutilizar saldo que ya compraste en otro dispositivo.", "Nechaj prázdne. Routstr node kľúč vydá, keď nižšie zaplatíš. Vlož ho sem len vtedy, ak chceš použiť kredit, ktorý si už kúpil na inom zariadení.", "Nech prázdné. Routstr node klíč vydá, až níže zaplatíš. Vlož ho sem jen tehdy, pokud chceš použít kredit, který sis už koupil na jiném zařízení."],
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
  describe: ["What should change?", "¿Qué quieres cambiar?", "Čo sa má zmeniť?", "Co se má změnit?"],
  keep: ["Keep this change", "Aceptar este cambio", "Prijať zmenu", "Přijmout změnu"],
  preview: ["Preview", "Vista previa", "Náhľad", "Náhled"],
  generating: ["Generating…", "Generando…", "Generuje sa…", "Generuje se…"],
  thinking: ["Thinking…", "Pensando…", "Rozmýšľa…", "Rozmýšlí…"],
  noCredit: ["No AI credit on this endpoint yet. Open AI settings to add some, or to use your own API key.", "Todavía no hay saldo de IA en este servidor. Abre los ajustes de IA para añadirlo o para usar tu propia clave API.", "Na tomto serveri zatiaľ nemáš AI kredit. Otvor nastavenia AI a pridaj si ho, alebo použi vlastný API kľúč.", "Na tomhle serveru zatím nemáš AI kredit. Otevři nastavení AI a přidej si ho, nebo použij vlastní API klíč."],
  before: ["Now", "Ahora", "Teraz", "Teď"],
  after: ["After this change", "Después del cambio", "Po zmene", "Po změně"],
  review: ["Review the result before keeping it. Save the page when you are ready to publish.", "Revisa el resultado antes de aceptarlo. Guarda la página cuando quieras publicarlo.", "Pred prijatím si výsledok skontroluj. Keď ho chceš zverejniť, ulož stránku.", "Před přijetím si výsledek zkontroluj. Až ho chceš zveřejnit, ulož stránku."],
};

export class Ai {
  constructor(nc) {
    this.nc = nc; this.doc = nc.doc;
    let storage; try { storage = this.doc.defaultView.localStorage; } catch {}
    this.client = new AiClient(storage);
  }
  say(key) {
    const lang = ["en", "es", "sk", "cs"].indexOf(this.doc.documentElement.lang.slice(0, 2));
    return WORDS[key]?.[Math.max(lang, 0)] || key;
  }

  start() { installEditing(this); }
  edit(target) { return editDialog(this, target); }
  propose(target, prompt, options) { return propose(this, target, prompt, options); }
  accept(proposal) { return accept(this, proposal); }
  buildPage(description, options) { return buildPage(this, description, options); }
  preparePage(html, options) { return preparePage(html, options); }
  previewHTML(html) { return previewHTML(html); }

  async settings() {
    const client = this.client, say = (key) => this.say(key);
    let mode, base, key, model;
    await modal({ doc: this.doc, title: say("settings"), hint: say("hint"), submitLabel: say("apply"),
      build: (body, h) => {
        const current = client.session();
        mode = field(body, { label: say("provider"), value: current.mode, options: [
          { value: "routstr", label: "Routstr (Cashu / Lightning)" }, { value: "byok", label: say("byok") }] });
        base = field(body, { label: say("endpoint"), value: current.base });
        key = field(body, { label: say("key"), type: "password", value: current.key });
        // With Routstr this field is an output, not a question: the node issues the
        // key when you pay. Saying so is the difference between an empty box you are
        // expected to fill and an empty box that is empty on purpose.
        const keyHint = this.doc.createElement("p"); keyHint.className = "nc-hint";
        (key.closest(".nc-field") || key).after(keyHint);
        model = field(body, { label: say("model"), value: current.model });
        const options = this.doc.createElement("datalist"); options.id = model.id + "-models";
        model.setAttribute("list", options.id); body.append(options);
        const rates = this.doc.createElement("p"); rates.className = "nc-hint"; body.append(rates);
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
            finally { working = false; controls.forEach(([el, disabled]) => { el.disabled = disabled; }); h.busy(false); }
          };
          return b;
        };
        const price = () => {
          const p = models.find((m) => m.id === model.value)?.sats_pricing;
          rates.textContent = p ? `${(p.prompt * 1000).toFixed(3)} / ${(p.completion * 1000).toFixed(3)} ${say("rates")}` : "";
        };
        model.addEventListener("input", price);
        button(body, "models", async () => {
          const selected = session(); models = await client.models(selected); options.replaceChildren();
          for (const m of models) { const o = this.doc.createElement("option"); o.value = m.id; o.label = m.name || m.id; options.append(o); }
          price();
        });
        const note = this.doc.createElement("p"); note.className = "nc-hint"; note.textContent = say("local"); body.append(note);
        // The credit somebody paid for should not depend on one browser's storage,
        // and a downloaded file is a chore people do not do and cannot do on a
        // phone. It goes to their own relays, encrypted to their own key.
        const vault = this.nc.vault;
        button(body, "backup", async () => {
          const s = apply(); if (!s.key) throw new Error(say("needKey"));
          if (!vault?.usable) throw new Error(say("noVault"));
          const ok = await vault.save({ ai: { ...(await vault.load())?.ai, [s.base]: s.key } });
          if (!ok) throw new Error("No relay accepted it. Your key is still in this browser.");
          return say("saved");
        });
        button(body, "restore", async () => {
          if (!vault?.usable) throw new Error(say("noVault"));
          const data = await vault.load({ force: true });
          if (data === null) throw new Error("The stored copy could not be read.");
          const found = data.ai?.[aiEndpoint(base.value, mode.value)];
          if (!found) throw new Error(say("nothingStored"));
          key.value = found; apply(); gate();
          return say("restored");
        });
        // Kept, demoted: relays can be unreachable and some signers cannot encrypt.
        button(body, "download", () => {
          const s = apply(); if (!s.key) throw new Error(say("needKey"));
          const url = URL.createObjectURL(new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }));
          const a = this.doc.createElement("a"); a.href = url; a.download = "nsite-clay-ai-key.json"; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        button(body, "forget", () => { key.value = ""; apply(); gate(); });
        const payments = this.doc.createElement("div"); body.append(payments);
        const showBalance = async () => {
          const result = await client.balance(apply());
          balance.textContent = `${(Number(result.balance) / 1000).toLocaleString()} sats`;
        };
        const balance = this.doc.createElement("p"); balance.className = "nc-hint"; payments.append(balance);
        button(payments, "balance", showBalance);
        const amount = field(payments, { label: say("amount"), type: "number", value: "100" }); amount.min = "1"; amount.max = "1000000"; amount.step = "1";
        button(payments, "lightning", async () => {
          const s = apply();
          const invoice = client.record(s.base).invoice || await client.invoice(Number(amount.value), s);
          const paid = await this.showInvoice(invoice, s); key.value = client.record(s.base).key || "";
          if (key.value) await showBalance();
          return paid ? say("paid") : "";
        });
        const token = field(payments, { label: say("cashu"), type: "password", value: client.record().deposit || "" });
        button(payments, "deposit", async () => {
          const s = apply(); await client.cashu(token.value, s); token.value = "";
          key.value = client.record(s.base).key || ""; await showBalance(); return say("paid");
        });
        const refundDisplay = (result) => notice(result?.token ? say("refundHint") : result?.status || "", {
          doc: this.doc, title: say("refund"), detail: result?.token || JSON.stringify(result),
          labels: { copy: say("copy"), copied: say("copied"), close: say("close") },
        });
        const payTo = field(payments, { label: say("payTo"), value: "", placeholder: "name@example.com" });
        const payToHint = this.doc.createElement("p"); payToHint.className = "nc-hint";
        payToHint.textContent = say("payToHint"); (payTo.closest(".nc-field") || payTo).after(payToHint);
        button(payments, "refund", async () => { refundDisplay(await client.refund(apply(), payTo.value)); });
        button(payments, "lastRefund", () => { const result = client.record(session().base).refund; if (result) refundDisplay(result); });
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
          models = []; options.replaceChildren(); rates.textContent = ""; balance.textContent = ""; token.value = "";
          gate();
        };
        base.addEventListener("input", changed); mode.addEventListener("change", changed);
        key.addEventListener("input", gate);
        gate();
      },
      onSubmit: () => client.configure({ mode: mode.value, base: base.value, key: key.value, model: model.value }),
    });
  }

  async showInvoice(invoice, session) {
    let closed = false, timer, helpers, checking = false;
    const check = async () => {
      if (closed || checking) return;
      checking = true;
      try {
        const out = await this.client.invoiceStatus(invoice, session);
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
