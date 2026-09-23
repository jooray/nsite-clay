import DOMPurify from "dompurify";
import { AI_WRITING, unfence } from "./ai-edit.js";

const MARKERS = ["editable", "nc:blocks", "nc:block-type", "nc:block", "nc:label", "nc:icon", "nc:group", "nc:hint", "nc:slot", "nc:on-add", "nc:crop"];
const CHROME = `<div class="nc-bar nc-ui-chrome"><span class="nc-dot"></span><span class="nc-who" data-nc-who>read-only</span><button data-nc-signin>Sign in</button><button class="nc-owner-only" data-nc-write>Write</button><button class="nc-owner-only" data-nc-cms>Edit content</button><button class="nc-owner-only" data-nc-settings>Settings</button><button class="nc-owner-only" data-nc-history>History</button><button class="nc-primary nc-owner-only" data-nc-save>Save</button></div><p class="nc-edit-hint">add #edit to the URL to edit this page</p>`;

export function preparePage(html, { owner, path = "/index.html", lang = "en", relays = [], servers = [], previous = "" } = {}) {
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
  // Kept across the wipe below, because this runs twice: once on what the model
  // returned, and again in the publisher on the page it already prepared. The
  // second pass has no business forgetting where the first one said to publish.
  const had = {
    relays: doc.documentElement.getAttribute("nc:relays"),
    servers: doc.documentElement.getAttribute("nc:servers"),
  };
  for (const a of [...doc.documentElement.attributes]) if (!["class", "dir"].includes(a.name)) doc.documentElement.removeAttribute(a.name);
  doc.documentElement.lang = lang;
  doc.documentElement.setAttribute("nc:owner", owner || "");
  doc.documentElement.setAttribute("nc:path", path);
  doc.documentElement.setAttribute("nc:edit-gate", "hash");
  // The same relays and Blossom servers the publisher is using. A template
  // carries these because they are in its file; a page built from nothing has
  // no file to carry them, and inheriting the runtime defaults instead means a
  // page published to one set of relays looks for itself on another.
  const keepRelays = relays.length ? relays.join(",") : had.relays;
  const keepServers = servers.length ? servers.join(",") : had.servers;
  if (keepRelays) doc.documentElement.setAttribute("nc:relays", keepRelays);
  if (keepServers) doc.documentElement.setAttribute("nc:servers", keepServers);
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
  // Photographs the owner already uploaded, before ids are handed out, so the
  // ones that come back keep the id they went in with.
  if (previous) keepPictures(previous, doc);

  // Pictures, which are content too. The content form draws a picker for an
  // img@src rule, with upload, cropping and the files already on this site, so
  // an image that is in the rules is an image its owner can change. One that is
  // not is a hole in the page they cannot fill: the model is asked for pictures
  // it has no files for, writes <img> with a description and no source, and
  // without this the only way to supply one was to know HTML.
  for (const el of doc.body.querySelectorAll("img")) {
    if (el.closest("template")) continue;
    if (!el.id || doc.querySelectorAll(`#${CSS.escape(el.id)}`).length !== 1) {
      let id; do { id = `nc-picture-${++index}`; } while (doc.getElementById(id));
      el.id = id;
    }
    const label = (el.getAttribute("alt") || "").trim().slice(0, 45);
    fields[`${Object.keys(fields).length + 1}. ${label ? "Picture: " + label : "Picture"}`] = `#${CSS.escape(el.id)}@src`;
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

/**
 * Room for the model to write in.
 *
 * Generating a page has nothing to size this from: the request is two sentences
 * and the answer is a whole document, so it asks for the ceiling and the client
 * comes down if an endpoint says that is more than it allows. Rewriting does
 * have something to go on, since the answer has to hold the page it was given,
 * and the floor is still generous because reasoning counts against the same
 * budget on most models and is often longer than the page.
 *
 * Asking high is free. Only what is written is billed, and the node releases
 * the rest of its reservation.
 */
const ROOM_MAX = 96000;
function room(chars, floor = 32000) {
  return Math.min(ROOM_MAX, Math.max(floor, Math.ceil(chars / 2) + 24000));
}

/** A reply cut off by the cap, whatever the endpoint called it. */
export const ranOut = (e) => e?.reason === "length";

export async function buildPage(ai, description, { template = "", lang = "en", signal, onProgress } = {}) {
  if (!description.trim()) throw new Error("Describe the page you want to build.");
  if (description.length > 20000 || template.length > 300000) throw new Error("Use a shorter description or a smaller template.");
  const reply = await ai.client.complete([
    { role: "system", content: `Build a complete static HTML page for nsite-clay. Return <!DOCTYPE html> through </html> only. Put CSS in <style>, use system fonts, responsive layouts, accessible labels and visible focus styles. Use no scripts, forms, external CSS, CSS imports or CSS URLs. Use actual supplied content; do not invent businesses, prices or contact details. Mark headings editable="single-line", prose editable, and do the same for table cells and list items that hold real content. Put sections in <main nc:blocks> and include inert <template nc:block="text" nc:label="Text"> block shapes. Where a photograph belongs, write an <img> with a description of the wanted picture in alt, an nc:crop giving the shape that suits the layout (\"16:9\", \"4:3\" or \"1:1\"), and no src: the owner supplies the file afterwards through the content form, and the page must lay out correctly before they do. Do not invent image URLs and do not use placeholder image services. The publisher adds ownership, runtime scripts, toolbar and CMS rules itself. Keep the page useful as plain static HTML. Language: ${lang}. ${AI_WRITING}` },
    { role: "user", content: `${description}${template ? "\n\nStarting page (adapt its design and content):\n" + template : "\n\nStart from scratch."}` },
  ], { signal, onProgress, maxTokens: ROOM_MAX }).catch((e) => {
    // Nothing here predicts the size of the answer, so there is no cap to
    // raise: what is left is a smaller page. Saying "change one part of it"
    // would be advice about a page that does not exist yet.
    if (ranOut(e)) throw new Error(`${e.message} Ask for a simpler page, or one with fewer sections.`);
    throw e;
  });
  return preparePage(reply, { owner: ai.nc.npub, lang, relays: ai.nc.cfg?.relays || [], servers: ai.nc.cfg?.servers || [] });
}

const BUILD_RULES = `Return <!DOCTYPE html> through </html> only. Put CSS in <style>, use system fonts, responsive layouts, accessible labels and visible focus styles. Use no scripts, forms, external CSS, CSS imports or CSS URLs. Use actual supplied content; do not invent businesses, prices or contact details. Mark headings editable="single-line", prose editable, and do the same for table cells and list items that hold real content. Put sections in <main nc:blocks> and include inert <template nc:block="text" nc:label="Text"> block shapes. Where a photograph belongs, write an <img> with a description of the wanted picture in alt, an nc:crop giving the shape that suits the layout (\"16:9\", \"4:3\" or \"1:1\"), and no src: the owner supplies the file afterwards through the content form, and the page must lay out correctly before they do. Do not invent image URLs and do not use placeholder image services. The publisher adds ownership, runtime scripts, toolbar and CMS rules itself. Keep the page useful as plain static HTML.`;

/**
 * Give a rewritten page back the photographs its owner had already uploaded.
 *
 * The model is asked for pages with their pictures missing, because it has no
 * files and inventing URLs produces links to somebody else's server. That is
 * right for a new page and destructive on a rewrite: a page whose owner has
 * uploaded three photographs comes back with three empty frames, and the
 * pictures are gone from a document they were the most expensive part of.
 *
 * So the sources are carried across here rather than being trusted to survive a
 * round trip through a language model. Matched by id first, then by the words
 * describing the picture, then by position, because a rewrite that changes a
 * page from coffee to yerba maté changes the descriptions with everything else
 * and position is all that is left. Nothing is ever guessed onto an image the
 * model gave a source of its own.
 */
function keepPictures(previous, doc) {
  const had = [...new DOMParser().parseFromString(previous, "text/html").body.querySelectorAll("img")]
    .filter((el) => (el.getAttribute("src") || "").trim());
  if (!had.length) return;
  const fresh = [...doc.body.querySelectorAll("img")].filter((el) => !el.closest("template"));
  const used = new Set();
  const give = (el, from) => {
    if (!from || used.has(from)) return false;
    used.add(from);
    el.setAttribute("src", from.getAttribute("src"));
    return true;
  };
  const empty = () => fresh.filter((el) => !(el.getAttribute("src") || "").trim());
  for (const el of empty()) give(el, el.id && had.find((o) => o.id === el.id && !used.has(o)));
  for (const el of empty()) {
    const alt = (el.getAttribute("alt") || "").trim();
    if (alt) give(el, had.find((o) => !used.has(o) && (o.getAttribute("alt") || "").trim() === alt));
  }
  const spare = had.filter((o) => !used.has(o));
  for (const el of empty()) { if (spare.length) give(el, spare.shift()); }
}

/**
 * Change a page that was just built, without starting again from the description.
 *
 * The answer to "I like it, but the photos should go" used to be to rewrite the
 * description and generate a page with nothing in common with the one on screen.
 * This keeps the page and changes the one thing asked for, which is both what
 * somebody means and the cheaper of the two.
 */
export async function refinePage(ai, page, instruction, { lang = "en", signal, onProgress } = {}) {
  if (!instruction.trim()) throw new Error("Say what should be different.");
  if (instruction.length > 20000 || page.length > 300000) throw new Error("Use a shorter instruction or a smaller page.");
  const reply = await ai.client.complete([
    { role: "system", content: `Rewrite one page of static HTML for nsite-clay so that it satisfies the change the user asks for. Make that change and keep everything else as it is: the same wording, the same structure, the same design, wherever the change does not require otherwise. An <img> that already has a src is a photograph its owner uploaded: keep that src and that id exactly as they are, even when you rewrite the alt text around them. Only an image the page does not have yet is written without a src. ${BUILD_RULES} Language: ${lang}. ${AI_WRITING}` },
    { role: "user", content: `Change to make:\n${instruction}\n\nThe page as it is now:\n${page}` },
    // The answer has to hold the whole page again, so the page is what sizes it.
  ], { signal, onProgress, maxTokens: room(page.length + instruction.length) });
  return preparePage(reply, { owner: ai.nc.npub, lang, previous: page,
    relays: ai.nc.cfg?.relays || [], servers: ai.nc.cfg?.servers || [] });
}

/**
 * Put a rewritten page into the live document, without a reload and without
 * publishing anything.
 *
 * A whole-page edit has to survive in the same document that is running the
 * runtime, so the swap is by ownership rather than wholesale: what the document
 * says is replaced, and what the runtime put there stays where it is. That means
 * the toolbar keeps working, the undo engine records one step, and nothing is on
 * anybody's relays until the owner presses Save, exactly like every other edit.
 */
export function applyPage(ai, html) {
  const nc = ai.nc, doc = nc.doc;
  const fresh = new DOMParser().parseFromString(html, "text/html");
  if (!fresh.body?.children.length) throw new Error("The rewritten page came back empty.");
  // The running scripts, the published toolbar, and whatever chrome the runtime
  // drew, including the dialog this is being pressed in.
  const KEEP = 'script[src], [nc\\:chrome], .nc-ui-chrome, .nc-edit-hint';
  return nc.undo.commit("AI page edit", () => {
    const kept = [...doc.body.children].filter((el) => el.matches(KEEP));
    const incoming = [...fresh.body.children].filter((el) => !el.matches(KEEP))
      .map((el) => doc.importNode(el, true));
    doc.body.replaceChildren(...incoming, ...kept);
    // Authored styles go with the authored markup: a new design whose CSS was
    // left behind is a page of unstyled text.
    for (const el of [...doc.head.querySelectorAll("style:not([nc\\:chrome])")]) el.remove();
    for (const el of fresh.head.querySelectorAll("style")) doc.head.append(doc.importNode(el, true));
    const title = fresh.title.trim();
    if (title) doc.title = title;
    nc.editable.refresh(); nc.blocks.refresh(); nc.dirty = true;
    return true;
  });
}
