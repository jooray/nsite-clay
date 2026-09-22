import DOMPurify from "dompurify";
import { AI_WRITING, unfence } from "./ai-edit.js";

const MARKERS = ["editable", "nc:blocks", "nc:block-type", "nc:block", "nc:label", "nc:icon", "nc:group", "nc:hint", "nc:slot", "nc:on-add", "nc:crop"];
const CHROME = `<div class="nc-bar nc-ui-chrome"><span class="nc-dot"></span><span class="nc-who" data-nc-who>read-only</span><button data-nc-signin>Sign in</button><button class="nc-owner-only" data-nc-write>Write</button><button class="nc-owner-only" data-nc-cms>Edit content</button><button class="nc-owner-only" data-nc-settings>Settings</button><button class="nc-owner-only" data-nc-history>History</button><button class="nc-primary nc-owner-only" data-nc-save>Save</button></div><p class="nc-edit-hint">add #edit to the URL to edit this page</p>`;

export function preparePage(html, { owner, path = "/index.html", lang = "en" } = {}) {
  // Models introduce themselves. A reply can open with a sentence about the page
  // and a ```html fence before the document begins, and parsing the whole reply
  // as a document puts all of that in the body: the chatter becomes the page's
  // first words, and <title> and <style> are pushed out of the head behind it.
  // So cut the document out of the reply rather than trusting the whole reply.
  const raw = unfence(html);
  const from = raw.search(/<!DOCTYPE\s+html|<html[\s>]/i);
  const to = raw.toLowerCase().lastIndexOf("</html>");
  const page = from >= 0 && to > from ? raw.slice(from, to + "</html>".length) : "";
  if (!page || !/<body[\s>]/i.test(page)) {
    throw new Error("The model did not return a complete HTML page. Try a shorter description.");
  }
  const clean = DOMPurify.sanitize(page, { WHOLE_DOCUMENT: true, ADD_TAGS: ["style", "template"], ADD_ATTR: MARKERS,
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
  // Fetched only when somebody edits, so it costs a reader nothing, but the
  // publisher stamps this path like any other and ships the file with the page.
  doc.documentElement.setAttribute("nc:source", "/nsite-clay-source.js");
  if (!doc.title.trim()) doc.title = doc.querySelector("h1")?.textContent || "My page";
  const charset = doc.createElement("meta"); charset.setAttribute("charset", "utf-8"); doc.head.prepend(charset);
  const viewport = doc.createElement("meta"); viewport.name = "viewport"; viewport.content = "width=device-width, initial-scale=1"; doc.head.append(viewport);
  const css = doc.createElement("link"); css.rel = "stylesheet"; css.href = "/nsite-clay-base.css"; doc.head.append(css);
  // Mark what carries words, then let the content form follow the marks. A model
  // asked for a page about opening hours writes a table, and a list of what to
  // bring as list items: left to headings and paragraphs, the page's most useful
  // facts were the ones its owner could never change. Deriving the rules from
  // whatever ends up editable also keeps the two in step, since the model marks
  // some of this itself and used to end up editable on the page but missing from
  // the form.
  const ONE_LINE = /^(H[1-6]|TD|TH|DT|CAPTION)$/;
  for (const el of doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,figcaption,li,td,th,dt,dd,caption")) {
    // Document order, so an outer mark is already in place when its children are
    // tested. Editable inside editable would arm the same words twice.
    if (!el.textContent.trim() || el.parentElement?.closest("[editable]")) continue;
    if (!el.hasAttribute("editable")) el.setAttribute("editable", ONE_LINE.test(el.tagName) ? "single-line" : "");
  }
  const fields = {};
  let index = 0;
  for (const el of doc.body.querySelectorAll("[editable]")) {
    if (!el.textContent.trim() || el.parentElement?.closest("[editable]")) continue;
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
    { role: "system", content: `Build a complete static HTML page for nsite-clay. Return <!DOCTYPE html> through </html> only. Put CSS in <style>, use system fonts, responsive layouts, accessible labels and visible focus styles. Use no scripts, forms, external CSS, CSS imports or CSS URLs. Use actual supplied content; do not invent businesses, prices or contact details. Mark headings editable="single-line", prose editable, and do the same for table cells and list items that hold real content. Put sections in <main nc:blocks> and include inert <template nc:block="text" nc:label="Text"> block shapes. The publisher adds ownership, runtime scripts, toolbar and CMS rules itself. Keep the page useful as plain static HTML. Language: ${lang}. ${AI_WRITING}` },
    { role: "user", content: `${description}${template ? "\n\nStarting page (adapt its design and content):\n" + template : "\n\nStart from scratch."}` },
  ], { signal, onProgress, maxTokens: 16000 });
  return preparePage(reply, { owner: ai.nc.npub, lang });
}
