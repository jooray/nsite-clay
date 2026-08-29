// The smallest dialog and toast the runtime can get away with.
//
// Everything built here is marked `nc:chrome`, so it is stripped from any
// snapshot: a document must never save the editor that was used to write it.
// Styling stays deliberately plain and inherits the page's own font, because a
// malleable document's chrome should not fight the document.

const CSS = `
.nc-ui, .nc-ui * { box-sizing: border-box; }
.nc-ui {
  position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center;
  background: rgba(6,4,12,.62); padding: 1rem;
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.nc-ui-card {
  width: min(38rem, 100%); max-height: min(90vh, 46rem); overflow: auto;
  background: #14121a; color: #ece9f2; border: 1px solid #322c40; border-radius: 14px;
  padding: 1.25rem; box-shadow: 0 30px 80px -30px rgba(0,0,0,.8);
}
.nc-ui-card h3 { margin: 0 0 .3rem; font-size: 1.05rem; }
.nc-ui-card p.nc-hint { margin: 0 0 1rem; color: #9a92ad; font-size: .86rem; }
.nc-ui label { display: block; font-size: .78rem; color: #9a92ad; margin: .85rem 0 .3rem; }
.nc-ui input[type=text], .nc-ui input[type=number], .nc-ui textarea, .nc-ui select {
  width: 100%; font: inherit; font-size: .9rem; padding: .55rem .65rem; border-radius: 8px;
  border: 1px solid #322c40; background: #0e0c14; color: inherit;
}
.nc-ui textarea { min-height: 9rem; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
.nc-ui input:focus, .nc-ui textarea:focus, .nc-ui select:focus { outline: 2px solid #6f5ad1; outline-offset: 1px; }
.nc-ui .nc-row { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; }
.nc-ui .nc-row > * { flex: 1 1 8rem; }
.nc-ui .nc-actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1.2rem; flex-wrap: wrap; }
.nc-ui button {
  font: inherit; font-size: .88rem; padding: .5rem .95rem; border-radius: 8px; cursor: pointer;
  border: 1px solid #322c40; background: #1c1926; color: inherit;
}
.nc-ui button:hover { border-color: #6f5ad1; }
.nc-ui button.nc-primary { background: #6f5ad1; border-color: transparent; color: #fff; font-weight: 600; }
.nc-ui button.nc-primary:hover { filter: brightness(1.1); }
.nc-ui button[disabled] { opacity: .5; cursor: not-allowed; }
.nc-ui .nc-status { font-size: .82rem; color: #9a92ad; margin-right: auto; align-self: center; }
.nc-ui .nc-status.nc-bad { color: #e79191; }
.nc-ui .nc-tabs { display: flex; gap: .3rem; margin: 0 0 .9rem; }
.nc-ui .nc-tabs button { flex: 0 0 auto; font-size: .84rem; padding: .38rem .8rem; }
.nc-ui .nc-tabs button[aria-selected=true] { background: #6f5ad1; border-color: transparent; color: #fff; }
.nc-ui .nc-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .45rem; max-height: 17rem; overflow: auto; }
.nc-ui .nc-list li { display: flex; gap: .6rem; align-items: center; padding: .5rem .6rem;
  border: 1px solid #322c40; border-radius: 9px; background: #0e0c14; font-size: .86rem; }
.nc-ui .nc-list li b { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nc-ui .nc-list li time { color: #7e768f; font-size: .78rem; }
.nc-toast {
  position: fixed; left: 50%; bottom: 1.2rem; transform: translateX(-50%); z-index: 2147483647;
  background: #14121a; color: #ece9f2; border: 1px solid #322c40; border-radius: 10px;
  padding: .6rem .9rem; font: 14px ui-sans-serif, system-ui, sans-serif;
  box-shadow: 0 12px 34px -14px rgba(0,0,0,.8);
}
`;

let injected = false;
function styles(doc) {
  if (injected) return;
  injected = true;
  const el = doc.createElement("style");
  el.setAttribute("nc:chrome", "");
  el.textContent = CSS;
  doc.head.appendChild(el);
}

export function toast(message, { doc = document, ms = 2600 } = {}) {
  styles(doc);
  const el = doc.createElement("div");
  el.className = "nc-toast";
  el.setAttribute("nc:chrome", "");
  el.setAttribute("role", "status");
  el.textContent = message;
  doc.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// A modal that resolves to whatever `onSubmit` returns, or null if dismissed.
// `build(body, helpers)` fills in the fields; helpers.submit() triggers the
// primary action, so a form can resolve on Enter.
export function modal({ title, hint, submitLabel = "Insert", build, onSubmit, doc = document, wide = false, noCancel = false }) {
  styles(doc);
  return new Promise((resolve) => {
    const root = doc.createElement("div");
    root.className = "nc-ui";
    root.setAttribute("nc:chrome", "");
    const card = doc.createElement("form");
    card.className = "nc-ui-card";
    if (wide) card.style.width = "min(52rem, 100%)";
    card.innerHTML =
      `<h3></h3>${hint ? '<p class="nc-hint"></p>' : ""}<div class="nc-body"></div>` +
      `<div class="nc-actions"><span class="nc-status"></span>` +
      `<button type="button" class="nc-cancel">Cancel</button>` +
      `<button type="submit" class="nc-primary"></button></div>`;
    card.querySelector("h3").textContent = title;
    if (hint) card.querySelector(".nc-hint").textContent = hint;
    card.querySelector(".nc-primary").textContent = submitLabel;
    if (noCancel) card.querySelector(".nc-cancel").remove();

    const status = card.querySelector(".nc-status");
    const primary = card.querySelector(".nc-primary");
    const helpers = {
      status(msg, bad = false) { status.textContent = msg || ""; status.classList.toggle("nc-bad", !!bad); },
      busy(on) { primary.disabled = !!on; },
      close(value) { root.remove(); doc.removeEventListener("keydown", esc, true); resolve(value ?? null); },
    };
    const esc = (e) => { if (e.key === "Escape") { e.preventDefault(); helpers.close(null); } };

    build?.(card.querySelector(".nc-body"), helpers);
    const cancel = card.querySelector(".nc-cancel");
    if (cancel) cancel.onclick = () => helpers.close(null);
    root.onclick = (e) => { if (e.target === root) helpers.close(null); };
    card.onsubmit = async (e) => {
      e.preventDefault();
      helpers.busy(true);
      try {
        const out = await onSubmit(helpers);
        if (out !== undefined) helpers.close(out);
      } catch (err) {
        helpers.status(err.message || String(err), true);
      } finally { helpers.busy(false); }
    };

    root.appendChild(card);
    doc.body.appendChild(root);
    doc.addEventListener("keydown", esc, true);
    card.querySelector("input, textarea, select")?.focus();
  });
}

export function field(body, { label, type = "text", value = "", placeholder = "", rows, options }) {
  const id = "nc-f-" + Math.random().toString(36).slice(2, 8);
  const l = body.ownerDocument.createElement("label");
  l.textContent = label; l.htmlFor = id;
  let input;
  if (options) {
    input = body.ownerDocument.createElement("select");
    for (const o of options) {
      const opt = body.ownerDocument.createElement("option");
      opt.value = typeof o === "string" ? o : o.value;
      opt.textContent = typeof o === "string" ? o : o.label;
      input.appendChild(opt);
    }
  } else if (rows) {
    input = body.ownerDocument.createElement("textarea");
    input.rows = rows;
  } else {
    input = body.ownerDocument.createElement("input");
    input.type = type;
  }
  input.id = id;
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  body.append(l, input);
  return input;
}
