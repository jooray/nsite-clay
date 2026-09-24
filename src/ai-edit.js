import { sanitizeAs } from "./sanitize.js";
import { modal, field } from "./ui.js";

export const AI_WRITING = "Use concrete, natural wording. Do not invent facts, testimonials or statistics. Avoid hype, filler, slogans, em dashes and en dashes. Match the user's language.";
export function unfence(text) { return String(text).trim().replace(/^```(?:html)?\s*\n/i, "").replace(/\n```\s*$/, "").trim(); }

// The builder deliberately produces static HTML. Do not sell a whole-page
// rewrite that would remove an existing form or custom behaviour. Feeds are
// carried through a rewrite by keepFeeds below.
function hasLiveFeatures(doc) {
  return [...doc.querySelectorAll("form, script")].some((el) => {
    if (el.closest('[nc\\:chrome], .nc-ui-chrome, [no-save], [clay~="no-save"]')) return false;
    if (el.localName !== "script") return true;
    if (el.type && !/^(module|(?:text|application)\/javascript)$/i.test(el.type)) return false;
    return !/\/nsite-clay(?:-(?:chrome|source|wallet))?(?:-[a-f0-9]{8})?\.js(?:[?#]|$)/i.test(el.src || "");
  });
}

// A feed is filled in when the page loads, so to a model it is an empty div with
// no reason to survive, and its nc: attributes are what the sanitizer removes.
// It goes out as a numbered place and comes back as exactly the markup it was,
// or the rewrite is refused rather than quietly losing it.
function hollowFeeds(doc) {
  const live = [];
  for (const el of [...doc.querySelectorAll("[nc\\:feed]")]) {
    live.push(el.outerHTML);
    const place = doc.createElement("div"); place.setAttribute("nc:keep", String(live.length - 1));
    el.replaceWith(place);
  }
  return live;
}

function fillFeeds(ai, page, live) {
  const doc = new DOMParser().parseFromString(page, "text/html");
  const found = new Set();
  for (const place of [...doc.querySelectorAll("[nc\\:keep]")]) {
    const i = Number(place.getAttribute("nc:keep"));
    if (!Number.isInteger(i) || live[i] === undefined || found.has(i)) { place.remove(); continue; }
    found.add(i);
    const t = doc.createElement("template"); t.innerHTML = live[i];
    place.replaceWith(t.content);
  }
  if (found.size !== live.length) throw new Error(ai.say("feedLost"));
  return live.length ? "<!DOCTYPE html>" + doc.documentElement.outerHTML : page;
}

/** Rewrite, or re-prepare, a whole page without losing its feeds. */
async function keepFeeds(ai, html, run) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const live = hollowFeeds(doc);
  return fillFeeds(ai, await run("<!DOCTYPE html>" + doc.documentElement.outerHTML, live.length > 0), live);
}

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

export function previewHTML(html, { base = "" } = {}) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, iframe, object, embed, base, meta[http-equiv], form").forEach((el) => el.remove());
  // The toolbar is not part of the page being previewed. Unstyled, which it is
  // here because its stylesheet is a root-relative link that resolves to
  // nothing inside a srcdoc, it renders as a row of words at the bottom of the
  // preview: "read-only Sign in Write Edit content Settings History Save".
  doc.querySelectorAll('[nc\\:chrome], .nc-ui-chrome, .nc-edit-hint').forEach((el) => el.remove());
  // And the rest of the page's own links are root-relative for the same reason,
  // so they are resolved against wherever this document actually lives. Without
  // it the preview is missing the stylesheet the real page will have.
  if (base) {
    for (const el of doc.querySelectorAll("link[href], img[src], source[src], source[srcset]")) {
      for (const name of ["href", "src", "srcset"]) {
        const value = el.getAttribute(name);
        if (!value || /^(https?:|data:|blob:|#)/i.test(value)) continue;
        try { el.setAttribute(name, new URL(value, base).href); } catch { /* leave it be */ }
      }
    }
  }
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
    { role: "user", content: `${prompt}\n\nElement to edit:\n${options.previous || before}` },
  ], options).catch((e) => {
    // Here it really is the size of the change, because the element is small
    // and what makes the answer long is what was asked of it.
    if (e?.reason === "length") throw new Error(`${e.message} Ask for a smaller change to this part of the page.`);
    throw e;
  });
  return { target, before, element: prepareElement(ai, target, reply) };
}

function prepareElement(ai, target, html) {
  const nc = ai.nc, before = cleanElement(nc, target), raw = unfence(html);
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
  return element;
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
  if (hasLiveFeatures(nc.doc)) throw new Error(ai.say("staticOnly"));
  await nc.source.ready?.catch(() => {});
  const before = nc.getHTML();
  const input = new DOMParser().parseFromString(before, "text/html");
  input.querySelectorAll('script, [nc\\:chrome], .nc-ui-chrome, .nc-edit-hint').forEach((el) => el.remove());
  for (const a of [...input.documentElement.attributes]) {
    if (!['lang', 'dir', 'class', 'style'].includes(a.name)) input.documentElement.removeAttribute(a.name);
  }
  let page;
  try {
    page = await keepFeeds(ai, "<!DOCTYPE html>" + input.documentElement.outerHTML, (html, keep) => ai.refinePage(html, prompt, {
      lang: nc.doc.documentElement.lang.slice(0, 2) || "en", ...options, keep,
    }));
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
  const initialTarget = target;
  let draft = ai.drafts.read("edit") || { prompt: "", scope: "page", versions: [] };
  let prompt, controller, scope, proposal, saved = true;
  const save = () => { saved = ai.drafts.write("edit", draft); return saved; };
  const locator = (el) => {
    if (!el) return "";
    if (el.id && ai.doc.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const path = [];
    while (el && el !== ai.doc.body) {
      path.unshift(`${el.localName}:nth-of-type(${[...el.parentElement.children].filter((s) => s.localName === el.localName).indexOf(el) + 1})`);
      el = el.parentElement;
    }
    return "body > " + path.join(" > ");
  };
  if ((draft.proposalScope || draft.scope) === "element" && draft.versions.length) {
    try { target = ai.doc.querySelector(draft.proposalSelector || draft.selector); } catch { target = null; }
  }
  const selected = () => draft.versions.find((v) => v.number === draft.selected) || draft.versions.at(-1);
  const hydrate = async () => {
    const version = selected();
    if (!version || typeof draft.before !== "string") return null;
    if ((draft.proposalScope || draft.scope) === "element") return target?.isConnected
      ? { target, before: draft.before, element: prepareElement(ai, target, version.html) } : null;
    return keepFeeds(ai, version.html, async (html, keep) => ai.preparePage(html, {
      owner: ai.nc.npub, path: ai.nc.cfg.path, lang: ai.doc.documentElement.lang.slice(0, 2) || "en",
      relays: ai.nc.cfg.relays, servers: ai.nc.cfg.servers, keep })).then((page) => ({ before: draft.before, page }));
  };
  if (draft.versions.length) {
    await ai.nc.source.ready?.catch(() => {});
    try { proposal = await hydrate(); } catch { /* keep the saved copy available to download */ }
  }
  const staticOnly = hasLiveFeatures(ai.doc);
  // One element is worth offering only when there is one, and only when it is a
  // part of the page rather than the page itself.
  const part = target?.isConnected && !["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "TEMPLATE"].includes(target.tagName) &&
    !target.closest('[nc\\:chrome], .nc-ui-chrome, [nc\\:feed]') &&
    !target.querySelector('script, template, [nc\\:feed], form') ? target : null;
  const excerpt = part ? part.textContent.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  const resume = Symbol("resume"), back = Symbol("back"), discard = Symbol("discard"), imported = Symbol("imported");
  while (true) {
  if (!proposal) {
  const asked = await modal({ doc: ai.doc, title: ai.say("edit"), submitLabel: ai.say("generate"),
    hint: ai.say(staticOnly ? (part ? "staticSelection" : "staticOnly") : "editHint"),
    build: (body, h) => {
      if (part) {
        scope = field(body, { label: ai.say("scope"), value: draft.scope, options: [
          { value: "page", label: ai.say("scopePage") },
          { value: "element", label: `${ai.say("scopeElement")}: ${excerpt}` },
        ] });
        if (staticOnly) { scope.options[0].disabled = true; scope.value = "element"; }
        scope.addEventListener("change", () => { draft.scope = scope.value; save(); readiness.update(); });
      }
      prompt = field(body, { label: ai.say("describe"), rows: 4, value: draft.prompt, placeholder: ai.say("editPlaceholder") });
      const stored = ai.doc.createElement("p"); stored.className = "nc-hint"; body.append(stored);
      prompt.addEventListener("input", () => {
        draft.prompt = prompt.value; save(); stored.textContent = ai.say(saved ? "draftSaved" : "draftFailed"); readiness.update();
      });
      const readiness = ai.readiness(body, { kind: () => scope?.value || "page",
        chars: () => prompt.value.length + (scope?.value === "element" ? part?.outerHTML.length || 0 : ai.nc.getHTML().length),
        onChange: (s) => h.busy(!s.canGenerate || (staticOnly && !part)) });
      h.busy(true);
      ai.adopt().catch(() => {}).then(() => readiness.refresh());
      for (const name of ["addCredit", "settings"]) {
        const b = ai.doc.createElement("button"); b.type = "button"; b.textContent = ai.say(name);
        if (name === "addCredit") b.className = "nc-primary";
        if (name === "addCredit") b.hidden = ai.client.session().mode !== "routstr";
        b.onclick = async () => { await (name === "addCredit" ? ai.addCredit() : ai.settings()); await readiness.refresh(); };
        body.append(b);
      }
      const file = field(body, { label: ai.say("importDraft"), type: "file" }); file.accept = ".json,application/json";
      file.onchange = async () => {
        const chosen = file.files[0]; if (!chosen) return;
        try {
          if (chosen.size > 2500000 || !ai.drafts.import("edit", await chosen.text())) throw new Error(ai.say("draftUnreadable"));
          h.close(imported);
        } catch (e) { h.status(e.message, true); }
      };
      if (draft.versions.length) {
        const b = ai.doc.createElement("button"); b.type = "button"; b.textContent = ai.say("preview");
        b.onclick = () => h.close(resume); body.append(b);
      }
    },
    onSubmit: async (h) => {
      draft.prompt = prompt.value; draft.scope = scope?.value || "page";
      draft.selector = locator(part); save();
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
  if (!asked) return null;
  if (asked === imported) return editDialog(ai, initialTarget);
  if (asked === resume) { proposal = await hydrate().catch(() => null); if (!proposal) return null; }
  else {
    proposal = asked;
    draft.before = proposal.before;
    draft.proposalScope = draft.scope; draft.proposalSelector = locator(part);
    draft.versions = [{ number: 1, prompt: draft.prompt, html: proposal.page || proposal.element.outerHTML }];
    draft.selected = 1; save();
  }
  }
  const whole = !!proposal.page;
  let refining = false, showingCurrent = false, canRefine = false, readiness;
  const stale = () => whole ? ai.nc.getHTML() !== draft.before : !target?.isConnected || cleanElement(ai.nc, target) !== draft.before;
  const kept = await modal({ doc: ai.doc, title: ai.say("preview"), hint: ai.say(whole ? "reviewPage" : "review"),
    submitLabel: ai.say("keep"), wide: true,
    build: (body, h) => {
      const actions = ai.doc.createElement("div"); actions.className = "nc-row"; body.append(actions);
      const jump = ai.doc.createElement("button"); jump.type = "button"; jump.textContent = ai.say("askChange");
      jump.onclick = () => { change.focus(); change.scrollIntoView({ block: "center" }); }; actions.append(jump);
      const draftOptions = ai.doc.createElement("details"), summary = ai.doc.createElement("summary");
      summary.textContent = ai.say("draftOptions"); draftOptions.append(summary); body.append(draftOptions);
      if (stale()) draftOptions.open = true;
      for (const [label, action] of [["backInstruction", () => h.close(back)], ["discardDraft", () => h.close(discard)],
        ["downloadDraft", () => ai.download({ ...draft, schema: 1 }, "nsite-clay-ai-draft.json")]]) {
        const b = ai.doc.createElement("button"); b.type = "button"; b.textContent = ai.say(label); b.onclick = action; draftOptions.append(b);
      }
      const storageNote = ai.doc.createElement("p"); storageNote.className = "nc-hint";
      storageNote.textContent = ai.say(saved ? "draftSaved" : "draftFailed"); body.append(storageNote);
      const versions = field(body, { label: ai.say("version"), options: [] });
      const fillVersions = () => {
        versions.replaceChildren(...draft.versions.map((v) => {
          const o = ai.doc.createElement("option"); o.value = v.number; o.textContent = `${v.number}. ${v.prompt.slice(0, 70)}`; return o;
        }));
        versions.value = selected().number;
      };
      fillVersions();
      const styles = [...ai.doc.querySelectorAll('style:not([nc\\:chrome]), link[rel="stylesheet"]')].map((el) => el.outerHTML).join("");
      // One element, two frames: deciding whether a rewritten paragraph is better
      // than the one there is a comparison, and the old wording is gone from the
      // screen the moment the dialog opens over it.
      //
      // A whole page, one frame: the page as it is fills the screen behind this
      // dialog, so showing it again buys nothing and costs the room the new one
      // needs.
      let toggle;
      if (whole) {
        toggle = ai.doc.createElement("button"); toggle.type = "button"; toggle.textContent = ai.say("showCurrent");
        toggle.setAttribute("aria-pressed", "false"); body.append(toggle);
      }
      const pairs = whole
        ? [["", proposal.page]]
        : [[ai.say("before"), `<html><head>${styles}</head><body>${proposal.before}</body></html>`],
           [ai.say("after"), `<html><head>${styles}</head><body>${proposal.element.outerHTML}</body></html>`]];
      const frames = [];
      for (const [label, html] of pairs) {
        if (label) {
          const caption = ai.doc.createElement("p"); caption.className = "nc-hint";
          caption.style.cssText = "margin:.6rem 0 .3rem"; caption.textContent = label; body.append(caption);
        }
        const frame = ai.doc.createElement("iframe"); frame.setAttribute("sandbox", ""); frame.title = label || ai.say("after");
        frame.style.cssText = `display:block;width:100%;height:${whole ? "42vh" : "11rem"};border:1px solid var(--nc-edge);background:white`;
        frame.srcdoc = previewHTML(html, { base: ai.doc.baseURI });
        body.append(frame); frames.push(frame);
      }
      const change = field(body, { label: ai.say("refineLabel"), rows: 2, value: draft.change || "" });
      jump.setAttribute("aria-controls", change.id);
      change.oninput = () => { draft.change = change.value; save(); readiness.update(); };
      const refine = ai.doc.createElement("button"); refine.type = "button"; refine.textContent = ai.say("refine"); body.append(refine);
      const gate = () => {
        h.busy(refining || showingCurrent || stale());
        refine.disabled = refining || !canRefine || stale();
        versions.disabled = refining; change.disabled = refining;
        account.disabled = refining;
        actions.inert = refining; draftOptions.inert = refining; if (toggle) toggle.disabled = refining;
      };
      const draw = () => {
        const html = whole ? (showingCurrent ? draft.before : proposal.page) : `<html><head>${styles}</head><body>${proposal.element.outerHTML}</body></html>`;
        frames.at(-1).srcdoc = ai.previewHTML(html); frames.at(-1).title = ai.say(showingCurrent ? "before" : "after");
        if (toggle) { toggle.textContent = ai.say(showingCurrent ? "showProposed" : "showCurrent"); toggle.setAttribute("aria-pressed", String(showingCurrent)); }
        gate();
      };
      versions.onchange = async () => {
        draft.selected = Number(versions.value); save();
        try { proposal = await hydrate(); showingCurrent = false; draw(); } catch (e) { h.status(e.message, true); }
      };
      if (toggle) toggle.onclick = () => { showingCurrent = !showingCurrent; draw(); };
      const account = ai.doc.createElement("button"); account.type = "button";
      let configure = false;
      readiness = ai.readiness(body, { kind: () => whole ? "page" : "element",
        chars: () => selected().html.length + change.value.length, onChange: (s) => {
          canRefine = s.canGenerate;
          configure = ai.client.session().mode !== "routstr" || ["invalidKey", "modelMissing"].includes(s.state);
          account.textContent = ai.say(configure ? "settings" : "addCredit"); gate();
        } });
      account.onclick = async () => { await (configure ? ai.settings() : ai.addCredit()); await readiness.refresh(); };
      body.append(account);
      readiness.refresh(); gate();
      if (stale()) h.status(ai.say("draftStale"), true);
      refine.onclick = async () => {
        if (refining || !canRefine || stale()) return;
        if (!change.value.trim()) { change.focus(); return; }
        const instruction = change.value.trim(); refining = true; gate();
        controller = new AbortController();
        const options = { signal: controller.signal, onProgress: (text) => h.status(`${ai.say("generating")} ${text.length}`) };
        try {
          const next = whole ? { before: draft.before, page: await keepFeeds(ai, proposal.page, (html, keep) => ai.refinePage(html, instruction, {
            ...options, lang: ai.doc.documentElement.lang.slice(0, 2) || "en", keep })) }
            : { ...await propose(ai, target, instruction, { ...options, previous: proposal.element.outerHTML }), before: draft.before };
          if (controller.signal.aborted) return;
          proposal = next;
          const number = draft.versions.at(-1).number + 1;
          draft.versions.push({ number, prompt: instruction, html: next.page || next.element.outerHTML });
          draft.versions = draft.versions.slice(-5); draft.selected = number; draft.change = "";
          change.value = ""; save(); storageNote.textContent = ai.say(saved ? "draftSaved" : "draftFailed");
          showingCurrent = false; fillVersions(); draw(); h.status("");
          await readiness.refresh();
        } catch (e) { if (!controller.signal.aborted) h.status(e.message, true); }
        finally { refining = false; gate(); }
      };
    },
    onSubmit: () => whole ? ai.applyPage(proposal.page, { before: proposal.before }) : accept(ai, proposal),
  }).finally(() => controller?.abort());
  if (kept === back) { proposal = null; continue; }
  if (kept === discard) { ai.drafts.clear("edit"); return editDialog(ai, initialTarget); }
  if (kept) { ai.drafts.clear("edit"); ai.nc.toast(ai.say("kept")); }
  return kept;
  }
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
