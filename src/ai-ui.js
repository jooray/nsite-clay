import { AiClient, aiEndpoint } from "./ai-client.js";
import { modal, field, notice } from "./ui.js";
import { qrElement } from "./qr.js";
import { installEditing, editDialog, propose, accept } from "./ai-edit.js";

const WORDS = {
  settings: ["AI settings", "Ajustes de IA", "Nastavenia AI", "Nastavení AI"],
  hint: ["AI uses our Cypherpunk Routstr node by default. Fees support nsite-clay. You can choose another node or use your own API key.", "La IA usa nuestro nodo Routstr Cypherpunk por defecto. Las tarifas ayudan a mantener nsite-clay. Puedes elegir otro nodo o usar tu propia clave API.", "AI predvolene používa náš Routstr node Cypherpunk. Poplatky podporujú nsite-clay. Môžeš si vybrať iný node alebo vlastný API kľúč.", "AI ve výchozím nastavení používá náš Routstr node Cypherpunk. Poplatky podporují nsite-clay. Můžeš si vybrat jiný node nebo vlastní API klíč."],
  apply: ["Save AI settings", "Guardar ajustes de IA", "Uložiť nastavenia AI", "Uložit nastavení AI"],
  provider: ["Provider", "Proveedor", "Poskytovateľ", "Poskytovatel"],
  byok: ["My own API key", "Mi propia clave API", "Vlastný API kľúč", "Vlastní API klíč"],
  endpoint: ["API base URL", "URL base de la API", "Základná URL API", "Základní URL API"],
  key: ["API key for this endpoint", "Clave API de este servidor", "API kľúč pre tento server", "API klíč pro tento server"],
  model: ["Model ID", "ID del modelo", "ID modelu", "ID modelu"],
  models: ["Load models", "Cargar modelos", "Načítať modely", "Načíst modely"],
  local: ["This browser stores your AI key separately from the page. Download a copy to reuse your credit on another site or device.", "Este navegador guarda tu clave de IA fuera de la página. Descarga una copia para usar tu saldo en otro sitio o dispositivo.", "Prehliadač ukladá AI kľúč oddelene od stránky. Stiahni si kópiu, ak chceš kredit použiť na inom webe alebo zariadení.", "Prohlížeč ukládá AI klíč odděleně od stránky. Stáhni si kopii, pokud chceš kredit použít na jiném webu nebo zařízení."],
  backup: ["Download AI key", "Descargar clave de IA", "Stiahnuť AI kľúč", "Stáhnout AI klíč"],
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
  working: ["Working…", "Procesando…", "Pracuje sa…", "Pracuje se…"],
  rates: ["sats per 1,000 tokens: input / output", "sats por 1.000 tokens: entrada / salida", "sats za 1 000 tokenov: vstup / výstup", "sats za 1 000 tokenů: vstup / výstup"],
  generate: ["Generate preview", "Generar vista previa", "Vytvoriť náhľad", "Vytvořit náhled"],
  edit: ["Edit with AI", "Editar con IA", "Upraviť s AI", "Upravit s AI"],
  describe: ["What should change?", "¿Qué quieres cambiar?", "Čo sa má zmeniť?", "Co se má změnit?"],
  keep: ["Keep this change", "Aceptar este cambio", "Prijať zmenu", "Přijmout změnu"],
  preview: ["Preview", "Vista previa", "Náhľad", "Náhled"],
  generating: ["Generating…", "Generando…", "Generuje sa…", "Generuje se…"],
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
        model = field(body, { label: say("model"), value: current.model });
        const options = this.doc.createElement("datalist"); options.id = model.id + "-models";
        model.setAttribute("list", options.id); body.append(options);
        const rates = this.doc.createElement("p"); rates.className = "nc-hint"; body.append(rates);
        let models = [], working = false;
        const session = () => ({ mode: mode.value, base: aiEndpoint(base.value, mode.value), key: key.value.trim(), model: model.value.trim() });
        const apply = () => client.configure(session());
        const button = (parent, name, fn) => {
          const b = this.doc.createElement("button"); b.type = "button"; b.textContent = say(name); parent.append(b);
          b.onclick = async () => {
            if (working) return;
            working = true;
            const controls = [...body.querySelectorAll("input, select, button")].map((el) => [el, el.disabled]);
            controls.forEach(([el]) => { el.disabled = true; });
            h.busy(true); h.status(say("working"));
            try { await fn(); h.status(""); } catch (e) { h.status(e.message, true); }
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
        button(body, "backup", () => {
          const s = apply(); if (!s.key) throw new Error("Add credit or enter a key first.");
          const url = URL.createObjectURL(new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }));
          const a = this.doc.createElement("a"); a.href = url; a.download = "nsite-clay-ai-key.json"; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        button(body, "forget", () => { key.value = ""; apply(); });
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
          await this.showInvoice(invoice, s); key.value = client.record(s.base).key || "";
          if (key.value) await showBalance();
        });
        const token = field(payments, { label: say("cashu"), type: "password", value: client.record().deposit || "" });
        button(payments, "deposit", async () => {
          const s = apply(); await client.cashu(token.value, s); token.value = "";
          key.value = client.record(s.base).key || ""; await showBalance();
        });
        const refundDisplay = (result) => notice(result?.token ? say("refundHint") : result?.status || "", {
          doc: this.doc, title: say("refund"), detail: result?.token || JSON.stringify(result),
        });
        button(payments, "refund", async () => refundDisplay(await client.refund(apply())));
        button(payments, "lastRefund", () => { const result = client.record(session().base).refund; if (result) refundDisplay(result); });
        const changed = () => {
          try { key.value = client.record(aiEndpoint(base.value, mode.value)).key || ""; } catch { key.value = ""; }
          models = []; options.replaceChildren(); rates.textContent = ""; balance.textContent = ""; token.value = "";
          payments.hidden = mode.value !== "routstr";
        };
        base.addEventListener("input", changed); mode.addEventListener("change", changed);
        payments.hidden = mode.value !== "routstr";
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
          helpers.status("This invoice has expired. Close it and create a new one.", true); return;
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
