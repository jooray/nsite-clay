// Pasted markup is untrusted: it comes from whatever application the person
// copied from, and in a format where the file is the database, one stray
// <script> or inline style is in the document forever. Text and structure only.
import DOMPurify from "dompurify";

const SANITIZE = {
  ALLOWED_TAGS: [
    "a", "abbr", "article", "b", "blockquote", "br", "code", "del", "div", "em",
    "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hr", "i", "img", "ins", "li", "mark", "ol", "p", "pre", "s", "section",
    "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
    "th", "thead", "time", "tr", "u", "ul",
  ],
  ALLOWED_ATTR: ["href", "title", "alt", "src", "colspan", "rowspan", "class", "lang", "dir",
                 "datetime", "loading", "rel", "width", "height"],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "base", "svg", "math"],
  FORBID_ATTR: ["style", "srcset", "formaction", "ping", "target"],
  ALLOW_DATA_ATTR: false,
  KEEP_CONTENT: true,
};

export function sanitize(html) { return DOMPurify.sanitize(html, SANITIZE); }

// DOMPurify parses its input inside a <body>, where the HTML parser silently
// throws table-section tags away: sanitize("<td>a</td>") is "a". Region items
// are commonly <tr> -- the documented one-row-per-contributor shape -- so a row
// has to be sanitised inside a matching table context and its children lifted
// back out, or every cell in a contributed row disappears. A fragment that
// closes its own row early can only produce siblings we never lift, so it still
// cannot escape the element it was given.
const TABLE_CONTEXT = {
  table: ["<table>", "</table>"],
  thead: ["<table><thead>", "</thead></table>"],
  tbody: ["<table><tbody>", "</tbody></table>"],
  tfoot: ["<table><tfoot>", "</tfoot></table>"],
  tr: ["<table><tbody><tr>", "</tr></tbody></table>"],
  td: ["<table><tbody><tr><td>", "</td></tr></tbody></table>"],
  th: ["<table><tbody><tr><th>", "</th></tr></tbody></table>"],
};

// String counterpart of sanitizeInto: sanitise `html` as it would be parsed
// inside a `context` element. Used on the way out, so what gets signed is what
// the reader will actually be able to render.
export function sanitizeAs(context, html, doc = document) {
  const name = String(context || "").toLowerCase();
  if (!TABLE_CONTEXT[name]) return sanitize(html);
  const holder = doc.createElement("div");
  holder.innerHTML = sanitize(TABLE_CONTEXT[name][0] + html + TABLE_CONTEXT[name][1]);
  const src = holder.querySelector(name);
  return src ? src.innerHTML : "";
}

// Replace el's children with a sanitised parse of `html`, in el's own context.
export function sanitizeInto(el, html) {
  const name = el.tagName.toLowerCase();
  const ctx = TABLE_CONTEXT[name];
  if (!ctx) { el.innerHTML = sanitize(html); return el; }
  const holder = el.ownerDocument.createElement("div");
  holder.innerHTML = sanitize(ctx[0] + html + ctx[1]);
  const src = holder.querySelector(name);
  el.innerHTML = "";
  if (src) while (src.firstChild) el.appendChild(src.firstChild);
  return el;
}
