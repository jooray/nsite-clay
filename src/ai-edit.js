import { sanitizeAs } from "./sanitize.js";
import { modal, field } from "./ui.js";

export const AI_WRITING = "Use concrete, natural wording. Do not invent facts, testimonials or statistics. Avoid hype, filler, slogans, em dashes and en dashes. Match the user's language.";
export function unfence(text) { return String(text).trim().replace(/^```(?:html)?\s*\n/i, "").replace(/\n```\s*$/, "").trim(); }

function cleanElement(nc, element) {
  const copy = element.cloneNode(true);
  nc._cleanClone(copy);
  for (const el of [copy, ...copy.querySelectorAll("*")]) {
    for (const a of ["contenteditable", "nc:armed", "nc:keep-editable", "nc:highlight", "nc:spellcheck"]) el.removeAttribute(a);
    if (el.matches('input[type="password"], input[type="file"]')) el.removeAttribute("value");
  }
  copy.querySelectorAll('[no-save], [clay~="no-save"], [no-snapshot], [clay~="no-snapshot"]').forEach((el) => el.remove());
  return copy.outerHTML;
}

export function previewHTML(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, iframe, object, embed, base, meta[http-equiv], form").forEach((el) => el.remove());
  const policy = doc.createElement("meta"); policy.httpEquiv = "Content-Security-Policy";
  policy.content = "default-src 'none'; style-src 'unsafe-inline' https: http:; img-src https: http: data:; font-src https: http:; form-action 'none'; base-uri 'none'";
  doc.head.prepend(policy);
  return "<!DOCTYPE html>" + doc.documentElement.outerHTML;
}

export async function propose(ai, target, prompt, options = {}) {
  const { nc } = ai;
  if (!nc.isOwner) throw new Error("Only the owner can edit this page.");
  if (!target?.isConnected || target.ownerDocument !== nc.doc || target.closest('[nc\\:chrome], .nc-ui-chrome') ||
      ["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "TEMPLATE"].includes(target.tagName) || target.matches('[nc\\:feed]') || target.querySelector('script, template, [nc\\:feed]')) {
    throw new Error("Choose a text element or a block without a live feed.");
  }
  if (!prompt.trim()) throw new Error("Describe the change you want.");
  const before = cleanElement(nc, target);
  const reply = await ai.client.complete([
    { role: "system", content: `Edit one static HTML element. Return exactly one complete ${target.localName} element, with no Markdown fences or explanation. Preserve its classes and meaning unless the user asks to change them. Use static semantic markup. Do not add scripts, forms, event handlers or styles. ${AI_WRITING}` },
    { role: "user", content: `${prompt}\n\nElement to edit:\n${before}` },
  ], options);
  const raw = unfence(reply);
  if (!["IMG", "HR", "BR"].includes(target.tagName) && !new RegExp(`</${target.localName}>\\s*$`, "i").test(raw)) {
    throw new Error("The model returned an unfinished element. Try a smaller change.");
  }
  const safe = sanitizeAs(target.parentElement.localName, raw, nc.doc);
  const range = nc.doc.createRange(); range.selectNode(target);
  const fragment = range.createContextualFragment(safe);
  const content = [...fragment.childNodes].filter((n) => n.nodeType === 1 || n.textContent.trim());
  if (content.length !== 1 || content[0].nodeType !== 1 || content[0].localName !== target.localName) {
    throw new Error(`The model must return one complete ${target.localName} element. Try describing a smaller change.`);
  }
  const element = content[0];
  const original = nc.doc.createElement("template"); original.innerHTML = before;
  for (const attribute of original.content.firstElementChild?.attributes || []) {
    if (!element.hasAttribute(attribute.name)) element.setAttribute(attribute.name, attribute.value);
  }
  for (const name of ["id", "editable", "nc:block-type", "nc:slot", "nc:crop"]) {
    if (target.hasAttribute(name)) element.setAttribute(name, target.getAttribute(name));
  }
  // New prose remains editable after the AI leaves.
  for (const el of element.querySelectorAll("h1,h2,h3,h4,h5,h6,p,figcaption")) {
    el.setAttribute("editable", /^H\d$/.test(el.tagName) ? "single-line" : "");
  }
  return { target, before, element };
}

export function accept(ai, proposal) {
  if (!ai.nc.isOwner) throw new Error("Only the owner can edit this page.");
  if (!proposal.target.isConnected || cleanElement(ai.nc, proposal.target) !== proposal.before) {
    throw new Error("This part of the page changed while AI was working. Generate a fresh preview.");
  }
  ai.nc.undo.commit("AI edit", () => proposal.target.replaceWith(proposal.element));
  ai.nc.editable.refresh(); ai.nc.blocks.refresh(); ai.nc.dirty = true;
  return proposal.element;
}

export async function editDialog(ai, target) {
  let prompt, controller;
  const proposal = await modal({ doc: ai.doc, title: ai.say("edit"), submitLabel: ai.say("generate"),
    hint: `${target.localName}: ${target.textContent.trim().slice(0, 100)}`,
    build: (body) => {
      prompt = field(body, { label: ai.say("describe"), rows: 4 });
      const provider = ai.doc.createElement("p"); provider.className = "nc-hint";
      const show = () => provider.textContent = `${ai.client.config.model} · ${new URL(ai.client.config.base).host}`;
      show(); body.append(provider);
      const settings = ai.doc.createElement("button"); settings.type = "button"; settings.textContent = ai.say("settings");
      settings.onclick = async () => { await ai.settings(); show(); }; body.append(settings);
    },
    onSubmit: async (h) => {
      controller = new AbortController();
      return propose(ai, target, prompt.value, { signal: controller.signal, onProgress: (text) => h.status(`${ai.say("generating")} ${text.length}`) });
    },
  }).finally(() => controller?.abort());
  if (!proposal) return null;
  return modal({ doc: ai.doc, title: ai.say("preview"), hint: ai.say("review"), submitLabel: ai.say("keep"), wide: true,
    build: (body) => {
      const frame = ai.doc.createElement("iframe"); frame.setAttribute("sandbox", ""); frame.title = ai.say("preview");
      frame.style.cssText = "display:block;width:100%;height:22rem;border:1px solid var(--nc-edge);background:white";
      const styles = [...ai.doc.querySelectorAll('style:not([nc\\:chrome]), link[rel="stylesheet"]')].map((el) => el.outerHTML).join("");
      frame.srcdoc = previewHTML(`<html><head>${styles}</head><body>${proposal.element.outerHTML}</body></html>`); body.append(frame);
    },
    onSubmit: () => accept(ai, proposal),
  });
}

export function installEditing(ai) {
  ai.doc.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.('[nc\\:chrome], .nc-ui-chrome')) return;
    ai.target = e.target.closest?.('[editable], [nc\\:block-type]') || null;
  });
  const sync = () => {
    if (!ai.nc.isOwner || !ai.nc.editRequested) { ai.button?.remove(); ai.button = null; ai.target = null; return; }
    const bar = ai.doc.querySelector(".nc-bar");
    if (!bar || ai.button?.isConnected) return;
    const b = ai.doc.createElement("button"); b.type = "button"; b.setAttribute("nc:chrome", "");
    b.textContent = ai.say("edit"); b.dataset.ncAi = "";
    b.onclick = () => {
      const target = ai.target?.isConnected ? ai.target : ai.doc.querySelector("[editable]");
      if (target) ai.edit(target).catch((e) => ai.nc.toast(e.message));
    };
    bar.querySelector("[data-nc-save]")?.before(b); if (!b.isConnected) bar.append(b);
    ai.button = b;
  };
  for (const event of ["nsiteclay:login", "nsiteclay:logout", "nsiteclay:edit-gate"]) ai.nc.addEventListener(event, sync);
  sync();
}
