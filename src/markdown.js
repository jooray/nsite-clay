// The little Markdown a Nostr post actually uses.
//
// Long-form content is Markdown and has to be readable without JavaScript once
// it is written into a page, so it is rendered to markup rather than parsed at
// view time. This handles the parts a post uses. A page that needs full
// Markdown should bake the HTML it wants instead of asking this to grow.
//
// It lives on its own because two places need it: the composer, which bakes a
// published post into the document, and the feed's reader, which shows one
// without leaving the page.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export { esc };

export function markdownish(md) {
  const blocks = String(md || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // Images before links, and with the alt text allowed to be empty: a post
    // that opens with ![](https://…) is the common shape, and the link rule
    // would not match it, so the whole thing came out as literal text.
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
             '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  return blocks.map((b) => {
    const line = b.trim();
    if (!line) return "";
    const h = line.match(/^(#{1,4})\s+(.*)$/s);
    if (h) { const n = Math.min(h[1].length + 1, 5); return `<h${n}>${inline(h[2])}</h${n}>`; }
    if (/^```/.test(line)) return `<pre><code>${esc(line.replace(/^```\w*\n?|```$/g, ""))}</code></pre>`;
    if (/^>\s/.test(line)) return `<blockquote><p>${inline(line.replace(/^>\s?/gm, ""))}</p></blockquote>`;
    if (/^[-*]\s/.test(line)) {
      return "<ul>" + line.split("\n").map((li) => `<li>${inline(li.replace(/^[-*]\s+/, ""))}</li>`).join("") + "</ul>";
    }
    if (/^\d+\.\s/.test(line)) {
      return "<ol>" + line.split("\n").map((li) => `<li>${inline(li.replace(/^\d+\.\s+/, ""))}</li>`).join("") + "</ol>";
    }
    return `<p>${inline(line).replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
}
