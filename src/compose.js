// Writing Nostr posts from inside the document.
//
// Short notes are kind 1 and are append-only: once published, a note is out.
// Long-form articles are kind 30023 and are addressable, so publishing one with
// a `d` slug you have used before *is* the edit. That is why the slug is the
// field that matters here, and why editing an article means loading the newest
// event for a slug and republishing under the same one.
//
// Nothing here touches the document itself. A post goes to relays; the page is
// saved separately. They are two different publishing acts and conflating them
// would make it impossible to fix a typo in a note without republishing a site.
import { verifyEvent, nip19 } from "nostr-tools";
import { modal, field, toast } from "./ui.js";

const slugify = (s) => String(s || "").toLowerCase().trim()
  .replace(/['"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

const tag = (ev, name) => ev.tags.find((t) => t[0] === name)?.[1];

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

  // ---- the editor ---------------------------------------------------------

  // `existing` is a kind-30023 event to edit; omit it to start a new article.
  async openArticle(existing = null) {
    let slug, title, summary, image, tags, content;
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
