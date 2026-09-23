import { sanitizeAs } from "./sanitize.js";
import { modal, field } from "./ui.js";

export const AI_WRITING = "Use concrete, natural wording. Do not invent facts, testimonials or statistics. Avoid hype, filler, slogans, em dashes and en dashes. Match the user's language.";
export function unfence(text) { return String(text).trim().replace(/^```(?:html)?\s*\n/i, "").replace(/\n```\s*$/, "").trim(); }

function cleanElement(nc, element) {
  const copy = element.cloneNode(true);
  nc._cleanClone(copy);
  for (const el of [copy, ...copy.querySelectorAll("*")]) {
    // _cleanClone pairs these off for every descendant but cannot reach the root
    // it was handed. The spellcheck the runtime switched on leaves with the marker
    // that claims it, exactly as a save does; an authored spellcheck has no marker
    // and stays. Left in, the model echoes it back, the element is accepted
    // without the marker, and the attribute is published from then on.
    if (el.hasAttribute("nc:spellcheck")) el.removeAttribute("spellcheck");
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
  ], options).catch((e) => {
    // Here it really is the size of the change, because the element is small
    // and what makes the answer long is what was asked of it.
    if (e?.reason === "length") throw new Error(`${e.message} Ask for a smaller change to this part of the page.`);
    throw e;
  });
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

/**
 * Ask the model for a whole new version of this page.
 *
 * The button on the toolbar says "Edit with AI" and people who press it mean
 * the page: change the colours, add a section, move the photos. It used to mean
 * whichever paragraph had last been clicked, which is both a surprise and the
 * least useful of the two, so the page is what it means now and one element is
 * something you choose.
 *
 * `before` is the document as it would be saved, not as it is running, so the
 * model never sees the toolbar, the dialogs or the editing attributes and never
 * writes them back.
 */
export async function proposePage(ai, prompt, options = {}) {
  const { nc } = ai;
  if (!nc.isOwner) throw new Error("Only the owner can edit this page.");
  if (!prompt.trim()) throw new Error("Describe the change you want.");
  await nc.source.ready?.catch(() => {});
  const before = nc.getHTML();
  let page;
  try {
    page = await ai.refinePage(before, prompt, {
      lang: nc.doc.documentElement.lang.slice(0, 2) || "en", ...options,
    });
  } catch (e) {
    // "Ask for less" is not advice unless it says how. A whole-page rewrite has
    // exactly one smaller version of itself, and it is reachable from this same
    // button once something on the page has been clicked.
    if (e?.reason === "length") throw new Error(`${e.message} ${ai.say("tooBig")}`);
    throw e;
  }
  return { page, before };
}

export async function editDialog(ai, target) {
  let prompt, controller, scope;
  // One element is worth offering only when there is one, and only when it is a
  // part of the page rather than the page itself.
  const part = target?.isConnected && !["HTML", "HEAD", "BODY"].includes(target.tagName) &&
    !target.closest('[nc\\:chrome], .nc-ui-chrome') ? target : null;
  const excerpt = part ? part.textContent.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  const proposal = await modal({ doc: ai.doc, title: ai.say("edit"), submitLabel: ai.say("generate"),
    hint: ai.say("editHint"),
    build: (body, h) => {
      if (part) {
        scope = field(body, { label: ai.say("scope"), value: "page", options: [
          { value: "page", label: ai.say("scopePage") },
          { value: "element", label: `${ai.say("scopeElement")}: ${excerpt}` },
        ] });
      }
      prompt = field(body, { label: ai.say("describe"), rows: 4, placeholder: ai.say("editPlaceholder") });
      const provider = ai.doc.createElement("p"); provider.className = "nc-hint";
      const settings = ai.doc.createElement("button"); settings.type = "button";
      // Say it before the work, not after. Without this the first time anybody
      // presses the button they write a prompt, wait, and are then told they needed
      // credit all along.
      const show = () => {
        const session = ai.client.session();
        provider.textContent = session.key
          ? `${session.model} · ${new URL(session.base).host}`
          : ai.say("noCredit");
        provider.classList.toggle("nc-bad", !session.key);
        settings.textContent = ai.say(session.key ? "settings" : "addCredit");
        settings.classList.toggle("nc-primary", !session.key);
        // Generate is not an option yet, and leaving it pressable only buys a round
        // trip that ends in the sentence already on screen.
        h.busy(!session.key);
      };
      show(); body.append(provider);
      settings.onclick = async () => { await ai.settings(); show(); }; body.append(settings);
      // Usually already answered, because signing in started it. When it has
      // not, say what is being waited for rather than announcing they have no
      // credit and correcting it a second later.
      if (!ai.client.session().key) {
        provider.textContent = ai.say("looking");
        provider.classList.remove("nc-bad");
        h.busy(true);
        ai.adopt().then((found) => {
          show();
          if (found) provider.textContent = `${ai.say("adopted")} ${provider.textContent}`;
        }).catch(() => show());
      }
    },
    onSubmit: async (h) => {
      controller = new AbortController();
      const options = { signal: controller.signal,
        onProgress: (text, info) => h.status(text.length
          ? `${ai.say("generating")} ${text.length}`
          : `${ai.say("thinking")} ${info?.thinking || 0}`) };
      return part && scope?.value === "element"
        ? propose(ai, part, prompt.value, options)
        : proposePage(ai, prompt.value, options);
    },
  }).finally(() => controller?.abort());
  if (!proposal) return null;
  const whole = !!proposal.page;
  return modal({ doc: ai.doc, title: ai.say("preview"), hint: ai.say(whole ? "reviewPage" : "review"),
    submitLabel: ai.say("keep"), wide: true,
    build: (body) => {
      const styles = [...ai.doc.querySelectorAll('style:not([nc\\:chrome]), link[rel="stylesheet"]')].map((el) => el.outerHTML).join("");
      // One element, two frames: deciding whether a rewritten paragraph is better
      // than the one there is a comparison, and the old wording is gone from the
      // screen the moment the dialog opens over it.
      //
      // A whole page, one frame: the page as it is fills the screen behind this
      // dialog, so showing it again buys nothing and costs the room the new one
      // needs.
      const pairs = whole
        ? [["", proposal.page]]
        : [[ai.say("before"), `<html><head>${styles}</head><body>${proposal.before}</body></html>`],
           [ai.say("after"), `<html><head>${styles}</head><body>${proposal.element.outerHTML}</body></html>`]];
      for (const [label, html] of pairs) {
        if (label) {
          const caption = ai.doc.createElement("p"); caption.className = "nc-hint";
          caption.style.cssText = "margin:.6rem 0 .3rem"; caption.textContent = label; body.append(caption);
        }
        const frame = ai.doc.createElement("iframe"); frame.setAttribute("sandbox", ""); frame.title = label || ai.say("after");
        frame.style.cssText = `display:block;width:100%;height:${whole ? "60vh" : "11rem"};border:1px solid var(--nc-edge);background:white`;
        frame.srcdoc = previewHTML(html);
        body.append(frame);
      }
    },
    onSubmit: () => whole ? ai.applyPage(proposal.page) : accept(ai, proposal),
  });
}

export function installEditing(ai) {
  ai.doc.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.('[nc\\:chrome], .nc-ui-chrome')) return;
    ai.target = e.target.closest?.('[editable], [nc\\:block-type]') || null;
  });
  const sync = () => {
    if (!ai.nc.isOwner || !ai.nc.editRequested) { ai.button?.remove(); ai.button = null; ai.target = null; return; }
    // The moment somebody who owns this page asks to edit it, go and find the
    // credit they paid for. Doing it when the dialog opens meant the first thing
    // they saw was a sentence saying they had none, corrected a second later,
    // which is how a page that has their money reads as a page that does not.
    ai.adopt().catch(() => {});
    const bar = ai.doc.querySelector(".nc-bar");
    if (!bar || ai.button?.isConnected) return;
    const b = ai.doc.createElement("button"); b.type = "button"; b.setAttribute("nc:chrome", "");
    b.textContent = ai.say("edit"); b.dataset.ncAi = "";
    b.onclick = () => {
      // Whatever was last clicked is offered as a choice inside the dialog. The
      // button itself is about the page, because that is what it says.
      ai.edit(ai.target?.isConnected ? ai.target : null).catch((e) => ai.nc.toast(e.message));
    };
    bar.querySelector("[data-nc-save]")?.before(b); if (!b.isConnected) bar.append(b);
    ai.button = b;
  };
  for (const event of ["nsiteclay:login", "nsiteclay:logout", "nsiteclay:edit-gate"]) ai.nc.addEventListener(event, sync);
  sync();
}
