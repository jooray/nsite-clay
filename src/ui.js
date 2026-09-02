// The smallest dialog and toast the runtime can get away with.
//
// Everything built here is marked `nc:chrome`, so it is stripped from any
// snapshot: a document must never save the editor that was used to write it.
// Styling stays deliberately plain and inherits the page's own font, because a
// malleable document's chrome should not fight the document.

const CSS = `
.nc-ui, .nc-ui * { box-sizing: border-box; }

/* A page's stylesheet loads after this one and its element selectors reach
 * anything with the same tag name, the dialogs drawn over the page included.
 * A card is a <form>, so one page with \`form { display: flex }\` in it turned
 * the update offer into four columns with its buttons pushed off the side of
 * the screen, and the sign-in box with it. The chrome takes its type and its
 * colours from the page deliberately. It must not take layout, so everything
 * inside a chrome surface goes back to the browser's own default here and the
 * rules below put back the layout that is wanted. They come after on purpose:
 * a rule of equal weight has to win, so nothing may be added above this. */
.nc-ui *, .nc-toast *, .nc-notice * {
  display: revert; position: static; float: none;
  margin: revert; padding: revert;
  width: revert; height: revert; max-width: none; max-height: none;
}
.nc-ui {
  position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center;
  background: var(--nc-scrim, rgba(6,4,12,.62)); padding: 1rem;
  font: 15px/1.55 var(--nc-chrome-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
}
.nc-ui-card {
  display: block; width: min(38rem, 100%); max-height: min(90vh, 46rem); overflow: auto;
  background: var(--nc-panel, #14121a); color: var(--nc-ink, #ece9f2);
  border: 1px solid var(--nc-edge, #322c40); border-radius: var(--nc-radius, 14px);
  padding: 1.25rem; box-shadow: var(--nc-shadow, 0 30px 80px -30px rgba(0,0,0,.8));
}
.nc-ui-card h3 { margin: 0 0 .3rem; font-size: 1.05rem; }
.nc-ui-card p.nc-hint { margin: 0 0 1rem; color: var(--nc-ink-dim, #9a92ad); font-size: .86rem; }
.nc-ui label { display: block; font-size: .78rem; color: var(--nc-ink-dim, #9a92ad); margin: .85rem 0 .3rem; }
.nc-ui .nc-field { margin-top: .85rem; }
.nc-ui .nc-field label { margin: 0 0 .3rem; }
.nc-ui input[type=text], .nc-ui input[type=number], .nc-ui input[type=password],
.nc-ui textarea, .nc-ui select {
  width: 100%; font: inherit; font-size: .9rem; padding: .55rem .65rem;
  border-radius: var(--nc-radius-sm, 8px);
  border: 1px solid var(--nc-edge, #322c40); background: var(--nc-bg, #0e0c14); color: inherit;
}
.nc-ui textarea { min-height: 9rem; resize: vertical; font-family: var(--nc-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: .85rem; }
.nc-ui input:focus, .nc-ui textarea:focus, .nc-ui select:focus { outline: 2px solid var(--nc-accent, #6f5ad1); outline-offset: 1px; }
.nc-ui .nc-row { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; }
.nc-ui .nc-row > .nc-field { flex: 1 1 8rem; }
.nc-ui .nc-field label { margin-top: 0; }
.nc-ui .nc-actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1.2rem; flex-wrap: wrap; }
.nc-ui button {
  font: inherit; font-size: .88rem; padding: .5rem .95rem; cursor: pointer;
  border-radius: var(--nc-radius-sm, 8px);
  border: 1px solid var(--nc-edge, #322c40); background: var(--nc-panel, #1c1926); color: inherit;
}
.nc-ui button:hover { border-color: var(--nc-accent, #6f5ad1); }
.nc-ui button.nc-primary { background: var(--nc-accent, #6f5ad1); border-color: transparent; color: var(--nc-accent-ink, #fff); font-weight: 600; }
.nc-ui button.nc-primary:hover { filter: brightness(1.1); }
.nc-ui button[disabled] { opacity: .5; cursor: not-allowed; }
.nc-ui .nc-status { font-size: .82rem; color: var(--nc-ink-dim, #9a92ad); margin-right: auto; align-self: center; }
.nc-ui .nc-status.nc-bad { color: var(--nc-bad, #e79191); }
.nc-ui .nc-tabs { display: flex; gap: .3rem; margin: 0 0 .9rem; }
.nc-ui .nc-tabs button { flex: 0 0 auto; font-size: .84rem; padding: .38rem .8rem; }
.nc-ui .nc-tabs button[aria-selected=true] { background: var(--nc-accent, #6f5ad1); border-color: transparent; color: var(--nc-accent-ink, #fff); }
.nc-ui .nc-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .45rem; max-height: 17rem; overflow: auto; }
.nc-ui .nc-list li { display: flex; gap: .6rem; align-items: center; padding: .5rem .6rem;
  border: 1px solid var(--nc-edge, #322c40); border-radius: var(--nc-radius-sm, 9px);
  background: var(--nc-bg, #0e0c14); font-size: .86rem; }
.nc-ui .nc-list li b { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nc-ui .nc-list li time { color: var(--nc-ink-dim, #7e768f); font-size: .78rem; }
.nc-ui .nc-grid { display: grid; gap: .5rem; grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
  max-height: 15rem; overflow: auto; padding: .2rem; }
.nc-ui .nc-grid button { padding: 0; border-radius: var(--nc-radius-sm, 9px); overflow: hidden; aspect-ratio: 1; background: var(--nc-bg, #0e0c14); }
.nc-ui .nc-grid img { width: 100%; height: 100%; object-fit: cover; display: block; }
.nc-ui .nc-grid button[aria-pressed=true] { outline: 3px solid var(--nc-accent, #6f5ad1); outline-offset: -3px; }
.nc-ui .nc-drop { border: 1px dashed var(--nc-edge, #453b5c); border-radius: var(--nc-radius, 10px);
  padding: 1rem; text-align: center; color: var(--nc-ink-dim, #9a92ad); font-size: .85rem; }
.nc-ui .nc-drop.nc-over { border-color: var(--nc-accent, #6f5ad1); background: color-mix(in srgb, var(--nc-accent, #6f5ad1) 14%, transparent); color: var(--nc-ink, #ece9f2); }
.nc-ui .nc-pick { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem;
  max-height: 17rem; overflow: auto; }
.nc-ui .nc-pick button { display: flex; gap: .6rem; align-items: flex-start; width: 100%; text-align: left;
  padding: .55rem .7rem; border-radius: var(--nc-radius-sm, 9px); background: var(--nc-bg, #0e0c14);
  font-size: .85rem; line-height: 1.45; }
.nc-ui .nc-pick button[aria-pressed=true] { border-color: var(--nc-accent, #6f5ad1); background: color-mix(in srgb, var(--nc-accent, #6f5ad1) 18%, transparent); }
.nc-ui .nc-pick .nc-mark { flex: 0 0 auto; width: 1.1rem; color: var(--nc-accent, #6f5ad1); font-weight: 700; }
.nc-ui .nc-pick .nc-body-text { flex: 1; min-width: 0; }
.nc-ui .nc-pick b { display: block; font-weight: 600; }
.nc-ui .nc-pick small { color: var(--nc-ink-dim, #7e768f); }
.nc-toast {
  display: block; position: fixed; left: 50%; bottom: 1.2rem; transform: translateX(-50%); z-index: 2147483647;
  background: var(--nc-panel, #14121a); color: var(--nc-ink, #ece9f2);
  border: 1px solid var(--nc-edge, #322c40); border-radius: var(--nc-radius, 10px);
  padding: .6rem .9rem; font: 14px var(--nc-chrome-font, ui-sans-serif, system-ui, sans-serif);
  box-shadow: var(--nc-shadow, 0 12px 34px -14px rgba(0,0,0,.8));
}
.nc-notice {
  position: fixed; left: 1rem; bottom: 1rem; z-index: 2147483647;
  width: min(32rem, calc(100vw - 2rem)); max-height: min(60vh, 30rem);
  display: flex; flex-direction: column; gap: .5rem;
  background: var(--nc-panel, #14121a); color: var(--nc-ink, #ece9f2);
  border: 1px solid var(--nc-edge, #322c40);
  border-left: 3px solid var(--nc-ink-dim, #9a92ad);
  border-radius: var(--nc-radius, 10px); padding: .8rem .9rem;
  font: 14px/1.5 var(--nc-chrome-font, ui-sans-serif, system-ui, sans-serif);
  box-shadow: var(--nc-shadow, 0 12px 34px -14px rgba(0,0,0,.8));
}
.nc-notice.nc-bad { border-left-color: var(--nc-bad, #e79191); }
.nc-notice b { font-size: .95rem; font-weight: 600; }
.nc-notice p { margin: 0; font-size: .86rem; color: var(--nc-ink-dim, #9a92ad); }
.nc-notice b, .nc-notice p, .nc-notice pre { user-select: text; -webkit-user-select: text; }
.nc-notice pre {
  margin: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  padding: .5rem .6rem; border-radius: var(--nc-radius-sm, 8px);
  border: 1px solid var(--nc-edge, #322c40); background: var(--nc-bg, #0e0c14);
  font: .8rem/1.5 var(--nc-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.nc-notice .nc-actions { display: flex; gap: .4rem; justify-content: flex-end; margin: 0; }
.nc-notice button {
  font: inherit; font-size: .82rem; padding: .3rem .7rem; cursor: pointer;
  border-radius: var(--nc-radius-sm, 8px);
  border: 1px solid var(--nc-edge, #322c40); background: var(--nc-bg, #0e0c14); color: inherit;
}
.nc-notice button:hover { border-color: var(--nc-accent, #6f5ad1); }
@media (max-width: 720px) {
  .nc-notice { left: .5rem; right: .5rem; width: auto; bottom: 4.4rem; max-height: 50vh; }
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

// A toast is right for "saved". It is wrong for anything the reader has to act
// on: three seconds is not long enough to read a list of fourteen paths, and a
// message that has already gone cannot be copied into a message to whoever can
// fix it. So this one stays until it is dismissed, its text selects like text,
// and a button puts the whole thing on the clipboard.
export function notice(message, { doc = document, title = "", detail = "", bad = false, labels = {} } = {}) {
  styles(doc);
  const L = { copy: "Copy", copied: "Copied", close: "Close", ...labels };
  const el = doc.createElement("div");
  el.className = "nc-notice" + (bad ? " nc-bad" : "");
  el.setAttribute("nc:chrome", "");
  el.setAttribute("role", "alert");

  if (title) {
    const h = doc.createElement("b");
    h.textContent = title;
    el.appendChild(h);
  }
  if (message) {
    const p = doc.createElement("p");
    p.textContent = message;
    el.appendChild(p);
  }
  if (detail) {
    const pre = doc.createElement("pre");
    pre.textContent = detail;
    el.appendChild(pre);
  }

  const actions = doc.createElement("div");
  actions.className = "nc-actions";
  const copy = doc.createElement("button");
  copy.type = "button";
  copy.textContent = L.copy;
  copy.onclick = async () => {
    const text = [title, message, detail].filter(Boolean).join("\n\n");
    // A page served over plain HTTP, which a gateway on a custom domain is,
    // has no navigator.clipboard at all. The old way still works there.
    try { await doc.defaultView.navigator.clipboard.writeText(text); }
    catch {
      const ta = doc.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      doc.body.appendChild(ta);
      ta.select();
      try { doc.execCommand("copy"); } catch { /* nothing left to try */ }
      ta.remove();
    }
    copy.textContent = L.copied;
    setTimeout(() => (copy.textContent = L.copy), 1600);
  };
  const close = doc.createElement("button");
  close.type = "button";
  close.textContent = L.close;
  close.onclick = () => el.remove();
  actions.append(copy, close);
  el.appendChild(actions);

  doc.body.appendChild(el);
  return el;
}

// The one word every modal shows whether or not its caller passed any labels.
// Taken from <html lang> so a translated page does not end up with a lone
// English button; an unknown language falls back to English.
const CANCEL = { es: "Cancelar", sk: "Zrušiť", cs: "Zrušit", de: "Abbrechen",
                 fr: "Annuler", it: "Annulla", pt: "Cancelar", nl: "Annuleren" };
function cancelLabel(doc) {
  const lang = (doc.documentElement.lang || "en").slice(0, 2).toLowerCase();
  return CANCEL[lang] || "Cancel";
}

// A modal that resolves to whatever `onSubmit` returns, or null if dismissed.
// `build(body, helpers)` fills in the fields; helpers.submit() triggers the
// primary action, so a form can resolve on Enter.
// Dialogs stack -- an update offer opened from Settings, a picker opened from a
// block -- and every one of them listens for Escape on the document. Without a
// stack the outer one hears the key too and a single press closes the lot,
// including the dialog the person was actually looking at.
const openModals = [];

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
      `<button type="button" class="nc-cancel"></button>` +
      `<button type="submit" class="nc-primary"></button></div>`;
    card.querySelector("h3").textContent = title;
    if (hint) card.querySelector(".nc-hint").textContent = hint;
    card.querySelector(".nc-primary").textContent = submitLabel;
    card.querySelector(".nc-cancel").textContent = cancelLabel(doc);
    if (noCancel) card.querySelector(".nc-cancel").remove();

    const status = card.querySelector(".nc-status");
    const primary = card.querySelector(".nc-primary");
    const helpers = {
      status(msg, bad = false) { status.textContent = msg || ""; status.classList.toggle("nc-bad", !!bad); },
      busy(on) { primary.disabled = !!on; },
      close(value) {
        root.remove();
        doc.removeEventListener("keydown", esc, true);
        const i = openModals.indexOf(helpers);
        if (i >= 0) openModals.splice(i, 1);
        resolve(value ?? null);
      },
    };
    const esc = (e) => {
      if (e.key !== "Escape" || openModals[openModals.length - 1] !== helpers) return;
      e.preventDefault();
      helpers.close(null);
    };

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
    openModals.push(helpers);
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
    // The only password field here holds a Nostr secret key. Offering to
    // remember it, or to autofill a website password into it, is wrong in both
    // directions, so the browser is told to stay out of it.
    if (type === "password") {
      input.autocomplete = "off";
      input.setAttribute("autocorrect", "off");
      input.setAttribute("autocapitalize", "off");
      input.spellcheck = false;
    }
  }
  input.id = id;
  // Assigning "" to a <select> clears the selection, so a dropdown with no
  // explicit value would silently submit an empty string rather than its first
  // option. Only assign when there is something to assign.
  if (value !== "" && value != null) input.value = value;
  if (placeholder) input.placeholder = placeholder;
  // Label and input travel together, so a row lays them out as columns rather
  // than interleaving every label with somebody else's field.
  const wrap = body.ownerDocument.createElement("div");
  wrap.className = "nc-field";
  wrap.append(l, input);
  body.appendChild(wrap);
  return input;
}

// A labelled checkbox with a note under it. Same shape as field(), so a dialog
// can mix the two without special-casing either.
export function checkbox(body, { label, checked = false, note = "" }) {
  const doc = body.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.className = "nc-field";
  const l = doc.createElement("label");
  l.style.cssText = "display:flex;gap:.55rem;align-items:flex-start;cursor:pointer;color:inherit";
  const input = doc.createElement("input");
  input.type = "checkbox";
  input.checked = !!checked;
  input.style.cssText = "width:auto;margin-top:.25rem;flex:0 0 auto";
  const text = doc.createElement("span");
  const strong = doc.createElement("b");
  strong.style.fontWeight = "600";
  strong.textContent = label;
  text.appendChild(strong);
  if (note) {
    const small = doc.createElement("span");
    small.style.cssText = "display:block;color:var(--nc-ink-dim,#9a92ad);font-size:.85em;margin-top:.15rem";
    small.textContent = note;
    text.appendChild(small);
  }
  l.append(input, text);
  wrap.appendChild(l);
  body.appendChild(wrap);
  return input;
}
