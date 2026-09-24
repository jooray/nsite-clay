import { modal, field, notice } from "./ui.js";

export async function creditDialog(ai) {
  await ai.adopt().catch(() => {});
  const client = ai.client, s = client.session(), say = (key) => ai.say(key);
  if (s.mode !== "routstr") return ai.settings();
  let amount, method, token, ready = false, backup, status, form;
  return modal({ doc: ai.doc, title: say("addCredit"), hint: say("creditHint"), submitLabel: say("lightning"),
    build: (body, h) => {
      const provider = ai.doc.createElement("p"); provider.className = "nc-hint";
      provider.textContent = new URL(s.base).host; body.append(provider);
      status = ai.readiness(body, { showCost: false }); status.refresh();
      form = ai.doc.createElement("div"); body.append(form);
      method = field(form, { label: say("paymentMethod"), value: "lightning", options: [
        { value: "lightning", label: "Lightning" }, { value: "cashu", label: "Cashu" }] });
      amount = field(form, { label: say("amount"), type: "number", value: "100" });
      amount.min = "1"; amount.max = "1000000"; amount.step = "1";
      token = field(form, { label: say("cashu"), type: "password", value: client.record(s.base).deposit || "" });
      const change = () => {
        const lightning = method.value === "lightning";
        amount.closest(".nc-field").hidden = !lightning;
        token.closest(".nc-field").hidden = lightning;
        h.label(say(lightning ? (client.record(s.base).invoice ? "resumeInvoice" : "lightning") : "deposit"));
      };
      method.onchange = change; change();
      backup = ai.doc.createElement("div"); backup.hidden = true; body.append(backup);
      for (const name of ["backup", "download"]) {
        const b = ai.doc.createElement("button"); b.type = "button"; b.textContent = say(name); backup.append(b);
        b.onclick = async () => {
          if (name === "download") return ai.downloadKey();
          b.disabled = true;
          const ok = await ai.keepOnRelays(s.base); b.disabled = false; backup.hidden = ok;
          h.status(say(ok ? "saved" : "backupFailed"), !ok);
        };
      }
    },
    onSubmit: async (h) => {
      if (ready) return true;
      form.inert = true;
      try {
        if (method.value === "lightning") {
          const invoice = client.record(s.base).invoice || await client.invoice(Number(amount.value), { ...s, key: client.record(s.base).key || "" });
          if (!await ai.showInvoice(invoice, s)) return;
        } else {
          await client.cashu(token.value, { ...s, key: client.record(s.base).key || "" }); token.value = "";
        }
        ready = true; form.hidden = true; h.label(say("returnToWork"));
        const ok = await ai.keepOnRelays(s.base);
        backup.hidden = ok;
        h.status(`${say("paid")}. ${say(ok ? "saved" : "backupFailed")}`, !ok);
        await status.refresh();
      } finally { form.inert = false; }
    },
  });
}

export async function withdrawalDialog(ai) {
  const s = ai.client.session();
  let address;
  return modal({ doc: ai.doc, title: ai.say("refund"), hint: ai.say("payToHint"), submitLabel: ai.say("refund"),
    build: (body, h) => {
      address = field(body, { label: ai.say("payTo"), placeholder: "name@example.com" });
      h.busy(!s.key);
    },
    onSubmit: async () => {
      const result = await ai.client.refund(s, address.value);
      // Display after the parent has closed, so the withdrawal token remains
      // available until explicitly dismissed.
      setTimeout(() => notice(result?.token ? ai.say("refundHint") : result?.status || "", {
        doc: ai.doc, title: ai.say("refund"), detail: result?.token || JSON.stringify(result),
        labels: { copy: ai.say("copy"), copied: ai.say("copied"), close: ai.say("close") },
      }), 0);
      return true;
    },
  });
}
