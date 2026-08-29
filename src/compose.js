// Writing Nostr posts from inside the document.
//
// Short notes are kind 1 and are append-only: once published, a note is out.
// Long-form articles are kind 30023 and are addressable, so publishing one with
// a `d` slug you have used before *is* the edit. That is why the slug is the
// field that matters here, and why editing an article means loading the newest
// event for a slug and republishing under the same one.
//
// A post goes to relays and the page is saved separately: two publishing acts,
// deliberately not conflated, so fixing a typo in a note does not republish the
// whole site.
//
// They can still meet. `bake()` writes a rendered copy of a published post into
// the document and stamps it with the event's address, so the page is
// self-contained and readable without JavaScript while the post stays a
// first-class Nostr object that every other client can see. The event is the
// original; the markup is a cached rendering that knows where it came from.
// See docs/state.md for which of the two anything belongs in.
import { verifyEvent, nip19 } from "nostr-tools";
import { modal, field, checkbox, toast } from "./ui.js";

const slugify = (s) => String(s || "").toLowerCase().trim()
  .replace(/['"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

const tag = (ev, name) => ev.tags.find((t) => t[0] === name)?.[1];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Long-form content is Markdown, and a baked copy has to be readable without
// JavaScript, so it is rendered once at bake time. This handles the parts a
// post actually uses. A page that needs full Markdown should bake the HTML it
// wants instead of asking this to grow.
function markdownish(md) {
  const blocks = String(md || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>")
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

export class Compose {
  constructor(nc) { this.nc = nc; this.doc = nc.doc; }

  get relays() { return this.nc.cfg.relays; }

  requireSigner() {
    if (!this.nc.signer) throw new Error("Sign in before publishing");
    return this.nc.signer;
  }

  // ---- publishing ---------------------------------------------------------

  async publishNote(content, { tags = [] } = {}) {
    const signer = this.requireSigner();
    const text = String(content || "").trim();
    if (!text) throw new Error("A note needs some text");
    const ev = await signer.sign({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [...tags.map((t) => ["t", t])],
      content: text,
    });
    await this.publish(ev);
    return ev;
  }

  async publishArticle({ slug, title, summary, image, tags = [], content, publishedAt }) {
    const signer = this.requireSigner();
    const d = slugify(slug || title);
    if (!d) throw new Error("An article needs a title or a slug");
    if (!String(content || "").trim()) throw new Error("An article needs some content");
    const now = Math.floor(Date.now() / 1000);
    const ev = await signer.sign({
      kind: 30023,
      created_at: now,
      tags: [
        ["d", d],
        ...(title ? [["title", title]] : []),
        ...(summary ? [["summary", summary]] : []),
        ...(image ? [["image", image]] : []),
        // published_at keeps the original date across edits; created_at moves.
        ["published_at", String(publishedAt || now)],
        ...tags.map((t) => ["t", t]),
      ],
      content,
    });
    await this.publish(ev);
    return ev;
  }

  // A publish succeeds when one relay takes it. Report which refused, because
  // "it did not appear" is the least useful thing a client can say.
  async publish(ev) {
    const results = await Promise.allSettled(this.nc.pool.publish(this.relays, ev));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    if (!ok) {
      throw new Error("No relay accepted it: " +
        results.map((r, i) => `${this.relays[i]}: ${r.reason?.message || r.reason}`).join("; "));
    }
    return { accepted: ok, of: this.relays.length };
  }

  // ---- reading your own back ----------------------------------------------

  async mine(kind = 30023, limit = 50) {
    const pubkey = this.nc.pubkey || this.nc.cfg.owner;
    if (!pubkey) return [];
    const evs = await this.nc.pool.querySync(this.relays, { kinds: [kind], authors: [pubkey], limit });
    const good = evs.filter((ev) => verifyEvent(ev) && ev.pubkey === pubkey);
    if (kind < 30000) return good.sort((a, b) => b.created_at - a.created_at);
    // Addressable: one entry per slug, newest wins.
    const byD = new Map();
    for (const ev of good) {
      const d = tag(ev, "d") || "";
      const prev = byD.get(d);
      if (!prev || prev.created_at < ev.created_at) byD.set(d, ev);
    }
    return [...byD.values()].sort((a, b) => b.created_at - a.created_at);
  }

  // ---- baking a published post into the page ------------------------------

  // The address a baked copy remembers. For an article that is the naddr, which
  // survives the author editing it; for a note there is only the event id.
  addressOf(ev) {
    return ev.kind === 30023
      ? nip19.naddrEncode({ kind: 30023, pubkey: ev.pubkey, identifier: tag(ev, "d") || "" })
      : nip19.neventEncode({ id: ev.id, author: ev.pubkey });
  }

  // Render a published event as ordinary markup. Deliberately plain: a template
  // styles it, and anything cleverer would be a second renderer to keep in step
  // with the feed one.
  render(ev) {
    const el = this.doc.createElement("article");
    el.className = ev.kind === 30023 ? "nc-baked nc-baked-article" : "nc-baked nc-baked-note";
    el.setAttribute("nc:from", this.addressOf(ev));
    el.setAttribute("nc:at", String(ev.created_at));
    const when = new Date((Number(tag(ev, "published_at")) || ev.created_at) * 1000)
      .toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

    if (ev.kind === 30023) {
      const title = tag(ev, "title") || tag(ev, "d") || "Untitled";
      const summary = tag(ev, "summary") || "";
      el.innerHTML =
        `<h2 editable="single-line">${esc(title)}</h2>` +
        `<p class="nc-baked-when"><time datetime="${new Date(ev.created_at * 1000).toISOString()}">${esc(when)}</time></p>` +
        (summary ? `<p class="nc-baked-summary" editable="single-line">${esc(summary)}</p>` : "") +
        `<div class="nc-baked-body" editable>${markdownish(ev.content)}</div>` +
        `<p class="nc-baked-link"><a href="https://njump.me/${esc(this.addressOf(ev))}" rel="noopener">Read it on Nostr</a></p>`;
    } else {
      el.innerHTML =
        `<div class="nc-baked-body" editable>${markdownish(ev.content)}</div>` +
        `<p class="nc-baked-when"><a href="https://njump.me/${esc(this.addressOf(ev))}" rel="noopener">` +
        `<time datetime="${new Date(ev.created_at * 1000).toISOString()}">${esc(when)}</time></a></p>`;
    }
    return el;
  }

  // Put it in the page. Re-baking the same address replaces the old copy rather
  // than stacking a second one, which is what makes this repeatable.
  bake(ev, container = null) {
    const address = this.addressOf(ev);
    const existing = this.doc.querySelector(`[nc\\:from="${CSS.escape(address)}"]`);
    const el = this.render(ev);
    if (existing) existing.replaceWith(el);
    else {
      const host = (typeof container === "string" ? this.doc.querySelector(container) : container)
        || this.doc.querySelector("[nc\\:baked]")
        || this.doc.querySelector("[editable]")?.parentElement
        || this.doc.body;
      host.appendChild(el);
    }
    this.nc.editable.refresh();
    this.nc.dirty = true;
    this.nc._emit("nsiteclay:baked", { address, event: ev });
    return el;
  }

  // Bring every baked copy back in line with what the relays now hold. An
  // author who fixed a typo in a Nostr client gets the fix here too.
  async refreshBaked() {
    const nodes = [...this.doc.querySelectorAll("[nc\\:from]")];
    let updated = 0;
    for (const node of nodes) {
      const from = node.getAttribute("nc:from");
      let filter;
      try {
        const d = nip19.decode(from);
        filter = d.type === "naddr"
          ? { kinds: [d.data.kind], authors: [d.data.pubkey], "#d": [d.data.identifier], limit: 1 }
          : { ids: [d.data.id ?? d.data], limit: 1 };
      } catch { continue; }
      const ev = await this.nc.pool.get(this.relays, filter);
      if (!ev || !verifyEvent(ev)) continue;
      if (Number(node.getAttribute("nc:at")) >= ev.created_at) continue;
      node.replaceWith(this.render(ev));
      updated++;
    }
    if (updated) { this.nc.editable.refresh(); this.nc.dirty = true; }
    return updated;
  }

  // ---- the editor ---------------------------------------------------------

  // `existing` is a kind-30023 event to edit; omit it to start a new article.
  async openArticle(existing = null) {
    let slug, title, summary, image, tags, content, bake;
    const startedAt = existing ? Number(tag(existing, "published_at")) || existing.created_at : null;
    const out = await modal({
      doc: this.doc,
      wide: true,
      title: existing ? "Edit article" : "New article",
      hint: existing
        ? "Publishing replaces the article at this slug. Every long-form client will show the new text."
        : "A long-form post, kind 30023. The slug is its permanent address, so keep it stable and " +
          "publishing again under the same one is the edit.",
      submitLabel: existing ? "Publish the edit" : "Publish",
      build: (body) => {
        title = field(body, { label: "Title", value: existing ? tag(existing, "title") || "" : "" });
        slug = field(body, {
          label: "Slug: the permanent address. Leave blank to take it from the title",
          value: existing ? tag(existing, "d") || "" : "",
        });
        if (existing) slug.readOnly = true;
        summary = field(body, { label: "Summary", value: existing ? tag(existing, "summary") || "" : "" });
        const row = this.doc.createElement("div"); row.className = "nc-row"; body.appendChild(row);
        image = field(row, { label: "Header image URL", value: existing ? tag(existing, "image") || "" : "" });
        tags = field(row, {
          label: "Topics, comma separated",
          value: existing ? existing.tags.filter((t) => t[0] === "t").map((t) => t[1]).join(", ") : "",
        });
        content = field(body, { label: "Content, in Markdown", rows: 16, value: existing ? existing.content : "" });
        bake = checkbox(body, {
          label: "Also put a copy in this page",
          checked: !!this.doc.querySelector("[nc\\:baked]"),
          note: "The post goes to relays either way, so every Nostr client sees it. A copy in " +
                "the page makes it readable without JavaScript and keeps working if the relays " +
                "do not answer. Save the page afterwards to keep it.",
        });
      },
      onSubmit: async (h) => {
        h.status("signing…");
        const ev = await this.publishArticle({
          slug: slug.value || title.value,
          title: title.value.trim(),
          summary: summary.value.trim(),
          image: image.value.trim(),
          tags: tags.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
          content: content.value,
          publishedAt: startedAt,
        });
        return ev;
      },
    });
    if (out) {
      toast(`Published “${tag(out, "title") || tag(out, "d")}”`, { doc: this.doc });
      if (bake?.checked) this.bake(out);
      this.nc.feed?.refresh();
    }
    return out;
  }

  async openNote() {
    let content, tags;
    const out = await modal({
      doc: this.doc,
      title: "New note",
      hint: "A short note, kind 1. Notes are not replaceable, so this one cannot be edited afterwards.",
      submitLabel: "Publish",
      build: (body) => {
        content = field(body, { label: "Note", rows: 6 });
        tags = field(body, { label: "Topics, comma separated" });
      },
      onSubmit: async (h) => {
        h.status("signing…");
        return this.publishNote(content.value, {
          tags: tags.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
        });
      },
    });
    if (out) {
      toast("Note published", { doc: this.doc });
      this.nc.feed?.refresh();
    }
    return out;
  }

  // The way in: what you have written, and a way to write more.
  async open() {
    this.requireSigner();
    let listEl, which = "articles";
    const render = async () => {
      listEl.innerHTML = "<li>loading…</li>";
      const kind = which === "articles" ? 30023 : 1;
      const items = await this.mine(kind, 40);
      listEl.innerHTML = "";
      if (!items.length) {
        listEl.innerHTML = `<li>Nothing published yet under ${this.nc.npub?.slice(0, 12)}…</li>`;
        return;
      }
      for (const ev of items) {
        const li = this.doc.createElement("li");
        const label = kind === 30023
          ? (tag(ev, "title") || tag(ev, "d") || "Untitled")
          : (ev.content.slice(0, 70) + (ev.content.length > 70 ? "…" : ""));
        const b = this.doc.createElement("b"); b.textContent = label;
        const t = this.doc.createElement("time");
        t.textContent = new Date(ev.created_at * 1000).toLocaleDateString(undefined,
          { year: "numeric", month: "short", day: "numeric" });
        li.append(b, t);
        if (kind === 30023) {
          const edit = this.doc.createElement("button");
          edit.type = "button"; edit.textContent = "Edit";
          edit.onclick = async () => { close(null); await this.openArticle(ev); this.open(); };
          li.appendChild(edit);
        }
        const view = this.doc.createElement("button");
        view.type = "button"; view.textContent = "View";
        view.onclick = () => {
          const ref = kind === 30023
            ? nip19.naddrEncode({ kind: 30023, pubkey: ev.pubkey, identifier: tag(ev, "d") || "" })
            : nip19.neventEncode({ id: ev.id, author: ev.pubkey });
          this.doc.defaultView.open(`https://njump.me/${ref}`, "_blank", "noopener");
        };
        li.appendChild(view);
        listEl.appendChild(li);
      }
    };
    let close;
    await modal({
      doc: this.doc,
      title: "Your Nostr posts",
      hint: "Published to the relays in nc:relays, signed by the key you are signed in with.",
      submitLabel: "Close",
      noCancel: true,
      build: (body, h) => {
        close = h.close;
        const tabs = this.doc.createElement("div");
        tabs.className = "nc-tabs";
        for (const [key, label] of [["articles", "Articles"], ["notes", "Notes"]]) {
          const b = this.doc.createElement("button");
          b.type = "button"; b.textContent = label;
          b.setAttribute("aria-selected", String(key === which));
          b.onclick = () => {
            which = key;
            for (const o of tabs.children) o.setAttribute("aria-selected", String(o === b));
            render();
          };
          tabs.appendChild(b);
        }
        const write = this.doc.createElement("button");
        write.type = "button"; write.textContent = "Write";
        write.style.marginLeft = "auto";
        write.onclick = async () => {
          h.close(null);
          which === "articles" ? await this.openArticle() : await this.openNote();
          this.open();
        };
        tabs.appendChild(write);
        body.appendChild(tabs);
        listEl = this.doc.createElement("ul");
        listEl.className = "nc-list";
        body.appendChild(listEl);
        render();
      },
      onSubmit: () => null,
    });
  }
}
