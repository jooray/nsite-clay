// The snapshot algorithm, per malleablehtmlfile.com section 2, trimmed to what
// this runtime needs. Take a clone, never the live DOM; write live form state
// into markup; strip the parts that must not reach disk.
const EXTENSION_DEBRIS_ATTRS = [
  "data-lastpass-icon-root", "data-lt-installed", "data-gramm",
  "data-gramm_editor", "data-enable-grammarly", "bis_skin_checked",
  "data-new-gr-c-s-check-loaded", "data-gr-ext-installed",
];
const EXTENSION_DEBRIS_SELECTOR =
  "grammarly-extension, [data-lastpass-root], [data-lastpass-icon-root], .lastpass-icon-root";

function syncFormState(root) {
  for (const el of root.querySelectorAll("input, textarea, select")) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password" || type === "file") { el.removeAttribute("value"); continue; }
    if (type === "checkbox" || type === "radio") {
      el.checked ? el.setAttribute("checked", "") : el.removeAttribute("checked");
    } else if (el.tagName === "TEXTAREA") {
      el.textContent = el.value;
    } else if (el.tagName === "SELECT") {
      for (const opt of el.options) {
        opt.selected ? opt.setAttribute("selected", "") : opt.removeAttribute("selected");
      }
    } else {
      el.setAttribute("value", el.value);
    }
  }
}

function stripDebris(root) {
  for (const el of root.querySelectorAll(EXTENSION_DEBRIS_SELECTOR)) el.remove();
  for (const el of root.querySelectorAll("*")) {
    for (const a of EXTENSION_DEBRIS_ATTRS) el.removeAttribute(a);
  }
}

function stripMarked(root, tokens) {
  for (const el of [...root.querySelectorAll("[clay], [no-save], [no-snapshot]")]) {
    const set = new Set((el.getAttribute("clay") || "").split(/\s+/).filter(Boolean));
    if (el.hasAttribute("no-save")) set.add("no-save");
    if (el.hasAttribute("no-snapshot")) set.add("no-snapshot");
    if (tokens.some((t) => set.has(t))) el.remove();
  }
}

// `transforms` run on the clone before stripping, so a document can reshape
// what gets written before it is captured.
export function snapshot(doc = document, { forSave = true, transforms = [] } = {}) {
  const clone = doc.documentElement.cloneNode(true);
  syncFormState(clone);
  for (const fn of transforms) fn(clone, doc);
  stripDebris(clone);
  stripMarked(clone, forSave ? ["no-snapshot", "no-save"] : ["no-snapshot"]);
  return "<!DOCTYPE html>" + clone.outerHTML;
}
