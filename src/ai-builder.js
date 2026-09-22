import DOMPurify from "dompurify";
import { AI_WRITING, unfence } from "./ai-edit.js";

const MARKERS = ["editable", "nc:blocks", "nc:block-type", "nc:block", "nc:label", "nc:icon", "nc:group", "nc:hint", "nc:slot", "nc:on-add", "nc:crop"];
const CHROME = `<div class="nc-bar nc-ui-chrome"><span class="nc-dot"></span><span class="nc-who" data-nc-who>read-only</span><button data-nc-signin>Sign in</button><button class="nc-owner-only" data-nc-write>Write</button><button class="nc-owner-only" data-nc-cms>Edit content</button><button class="nc-owner-only" data-nc-settings>Settings</button><button class="nc-owner-only" data-nc-history>History</button><button class="nc-primary nc-owner-only" data-nc-save>Save</button></div><p class="nc-edit-hint">add #edit to the URL to edit this page</p>`;

export function preparePage(html, { owner, path = "/index.html", lang = "en" } = {}) {
  const raw = unfence(html);
  if (!/<html[\s>]/i.test(raw) || !/<\/html>\s*$/i.test(raw) || !/<body[\s>]/i.test(raw)) {
    throw new Error("The model did not return a complete HTML page. Try a shorter description.");
  }
  const clean = DOMPurify.sanitize(raw, { WHOLE_DOCUMENT: true, ADD_TAGS: ["style", "template"], ADD_ATTR: MARKERS,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "input", "button", "textarea", "select", "link", "meta"],
    FORBID_ATTR: ["srcdoc", "srcset", "ping", "formaction"], ALLOW_DATA_ATTR: false });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  for (const el of doc.querySelectorAll(".nc-ui-chrome, .nc-edit-hint")) el.remove();
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      for (const a of [...el.attributes]) {
        if (a.name.startsWith("nc:") && !MARKERS.includes(a.name)) el.removeAttribute(a.name);
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      }
      // Generated CSS is local to the page. External assets belong in explicit
      // image tags, rather than hidden CSS requests or imports.
      if (el.localName === "style" && /@import|url\s*\(|expression\s*\(|\\/i.test(el.textContent)) el.remove();
      if (/@import|url\s*\(|expression\s*\(|\\/i.test(el.getAttribute("style") || "")) el.removeAttribute("style");
      if (el.localName === "template") walk(el.content);
    }
  };
  walk(doc);
  for (const a of [...doc.documentElement.attributes]) if (!["class", "dir"].includes(a.name)) doc.documentElement.removeAttribute(a.name);
  doc.documentElement.lang = lang;
  doc.documentElement.setAttribute("nc:owner", owner || "");
  doc.documentElement.setAttribute("nc:path", path);
  doc.documentElement.setAttribute("nc:edit-gate", "hash");
  if (!doc.title.trim()) doc.title = doc.querySelector("h1")?.textContent || "My page";
  const charset = doc.createElement("meta"); charset.setAttribute("charset", "utf-8"); doc.head.prepend(charset);
  const viewport = doc.createElement("meta"); viewport.name = "viewport"; viewport.content = "width=device-width, initial-scale=1"; doc.head.append(viewport);
  const css = doc.createElement("link"); css.rel = "stylesheet"; css.href = "/nsite-clay-base.css"; doc.head.append(css);
  const fields = {};
  let index = 0;
  for (const el of doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,figcaption")) {
    if (!el.textContent.trim()) continue;
    if (!el.hasAttribute("editable")) el.setAttribute("editable", /^H\d$/.test(el.tagName) ? "single-line" : "");
    if (!el.id || doc.querySelectorAll(`#${CSS.escape(el.id)}`).length !== 1) {
      let id; do { id = `nc-content-${++index}`; } while (doc.getElementById(id));
      el.id = id;
    }
    const label = el.textContent.trim().slice(0, 45);
    fields[`${Object.keys(fields).length + 1}. ${label}`] = `#${CSS.escape(el.id)}${el.children.length ? "@innerHTML" : ""}`;
  }
  if (!Object.keys(fields).length) throw new Error("The generated page has no text to edit. Describe the content you want on it.");
  if (!doc.querySelector("[nc\\:blocks]")) {
    let main = doc.querySelector("main");
    if (!main) {
      main = doc.createElement("main");
      for (const child of [...doc.body.childNodes]) if (child.nodeName !== "TEMPLATE") main.append(child);
      doc.body.prepend(main);
    }
    main.setAttribute("nc:blocks", "");
  }
  if (!doc.querySelector("template[nc\\:block]")) {
    const words = { es: ["Texto", "Título", "Escribe aquí."], sk: ["Text", "Nadpis", "Píš sem."], cs: ["Text", "Nadpis", "Piš sem."] }[lang] || ["Text", "Heading", "Write here."];
    const template = doc.createElement("template"); template.setAttribute("nc:block", "text"); template.setAttribute("nc:label", words[0]);
    template.innerHTML = `<section><h2 editable="single-line">${words[1]}</h2><div editable><p>${words[2]}</p></div></section>`;
    doc.body.append(template);
  }
  const rules = doc.createElement("script"); rules.type = "application/json"; rules.setAttribute("nc:cms", "");
  rules.textContent = JSON.stringify(fields).replace(/</g, "\\u003c"); doc.body.append(rules);
  doc.body.insertAdjacentHTML("beforeend", CHROME);
  for (const src of ["/nsite-clay.js", "/nsite-clay-chrome.js"]) { const s = doc.createElement("script"); s.src = src; doc.body.append(s); }
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

export async function buildPage(ai, description, { template = "", lang = "en", signal, onProgress } = {}) {
  if (!description.trim()) throw new Error("Describe the page you want to build.");
  if (description.length > 20000 || template.length > 300000) throw new Error("Use a shorter description or a smaller template.");
  const reply = await ai.client.complete([
    { role: "system", content: `Build a complete static HTML page for nsite-clay. Return <!DOCTYPE html> through </html> only. Put CSS in <style>, use system fonts, responsive layouts, accessible labels and visible focus styles. Use no scripts, forms, external CSS, CSS imports or CSS URLs. Use actual supplied content; do not invent businesses, prices or contact details. Mark headings editable="single-line" and prose editable. Put sections in <main nc:blocks> and include inert <template nc:block="text" nc:label="Text"> block shapes. The publisher adds ownership, runtime scripts, toolbar and CMS rules itself. Keep the page useful as plain static HTML. Language: ${lang}. ${AI_WRITING}` },
    { role: "user", content: `${description}${template ? "\n\nStarting page (adapt its design and content):\n" + template : "\n\nStart from scratch."}` },
  ], { signal, onProgress, maxTokens: 16000 });
  return preparePage(reply, { owner: ai.nc.npub, lang });
}
