// A widget that pulls public Nostr content into the page: short notes (kind 1),
// long-form articles (kind 30023) and picture posts (kind 20).
//
// The vocabulary follows oracolo's blocks, because it got the shape right: a
// type, how many, a style, and an optional minimum length. Two differences.
// Authors are a list rather than one npub, so a page can show a group. And
// pinning an article is by its `d` slug rather than its event id, because
// kind 30023 is replaceable: the id changes on every edit, so an id-pin breaks
// the moment the author fixes a typo.
//
// Everything rendered here is somebody else's markup, so it is sanitised, and
// it is marked `nc:transient` so a save never freezes a feed into the file.
import { verifyEvent, nip19 } from "nostr-tools";
import { sanitize } from "./sanitize.js";
import { toHex } from "./config.js";
import { modal, field } from "./ui.js";

const KINDS = { notes: 1, articles: 30023, images: 20 };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const tag = (ev, name) => ev.tags.find((t) => t[0] === name)?.[1];
const tagsAll = (ev, name) => ev.tags.filter((t) => t[0] === name).map((t) => t[1]);

// Turn bare URLs and nostr: references into links, escaping everything else.
// Deliberately conservative: a note is plain text, not markup.
function linkify(text) {
  const out = [];
  const re = /(https?:\/\/[^\s<>"']+)|((?:nostr:)?n(?:pub|profile|event|addr)1[023456789acdefghjklmnpqrstuvwxyz]{20,})/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    out.push(esc(text.slice(last, m.index)));
    if (m[1]) {
      const url = m[1].replace(/[.,;:)]+$/, "");
      out.push(`<a href="${esc(url)}" rel="noopener nofollow" target="_blank">${esc(url)}</a>`);
      re.lastIndex = m.index + url.length;
    } else {
      const id = m[2].replace(/^nostr:/i, "");
      out.push(`<a href="https://njump.me/${esc(id)}" rel="noopener" target="_blank">${esc(id.slice(0, 12))}…</a>`);
    }
    last = re.lastIndex;
  }
  out.push(esc(text.slice(last)));
  return out.join("").replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");
}

// Long-form content is Markdown. Rendering it properly means shipping a parser;
// a widget does not need one. Strip the syntax for a readable excerpt and link
// out for the full article.
function excerpt(md, max = 260) {
  const flat = String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\-*+\s]+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? flat.slice(0, max).replace(/\s\S*$/, "") + "…" : flat;
}

const when = (ts) => new Date(ts * 1000).toLocaleDateString(undefined,
  { year: "numeric", month: "short", day: "numeric" });

function imetaUrls(ev) {
  const urls = [];
  for (const t of ev.tags) {
    if (t[0] === "imeta") {
      const u = t.slice(1).find((p) => p.startsWith("url "));
      if (u) urls.push(u.slice(4));
    } else if (t[0] === "url") urls.push(t[1]);
  }
  return urls.filter((u) => /^https?:\/\//i.test(u));
}

export function readFeedConfig(el) {
  const a = (n, d = "") => el.getAttribute(n) ?? d;
  const list = (v) => String(v || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return {
    type: (a("nc:feed") || "notes").toLowerCase(),
    authors: list(a("nc:authors")).map(toHex).filter(Boolean),
    limit: Math.min(parseInt(a("nc:limit") || "5", 10) || 5, 50),
    style: (a("nc:style") || "list").toLowerCase(),
    minLength: parseInt(a("nc:min-length") || "0", 10) || 0,
    topic: a("nc:topic") || "",
    pinned: list(a("nc:pinned")),
    relays: list(a("nc:feed-relays")),
  };
}

export class Feed {
  constructor(nc) {
    this.nc = nc;
    this.doc = nc.doc;
    this.profiles = new Map();
  }

  readFeedConfig(el) { return readFeedConfig(el); }

  widgets() { return [...this.doc.querySelectorAll("[nc\\:feed]")]; }

  relaysFor(cfg) { return cfg.relays.length ? cfg.relays : this.nc.cfg.relays; }

  async load(el) {
    const cfg = readFeedConfig(el);
    const kind = KINDS[cfg.type];
    if (!kind || !cfg.authors.length) return this.render(el, cfg, [], "Nothing configured");
    const relays = this.relaysFor(cfg);
    this.paint(el, cfg, "Loading…");

    try {
      const filters = [];
      // A pin is fetched by its own filter so it arrives whatever its date, and
      // for articles it is a slug, so it survives the author editing the piece.
      if (cfg.pinned.length && kind === 30023) {
        filters.push({ kinds: [kind], authors: cfg.authors, "#d": cfg.pinned });
      } else if (cfg.pinned.length) {
        filters.push({ ids: cfg.pinned.filter((p) => /^[0-9a-f]{64}$/i.test(p)) });
      }
      const base = { kinds: [kind], authors: cfg.authors, limit: cfg.limit + cfg.pinned.length + 10 };
      if (cfg.topic) base["#t"] = [cfg.topic];
      filters.push(base);

      const events = (await this.nc.pool.querySync(relays, filters[filters.length - 1]))
        .concat(filters.length > 1 ? await this.nc.pool.querySync(relays, filters[0]) : []);

      // Relays are untrusted transports. Nothing is displayed unsigned.
      const good = events.filter((ev) => verifyEvent(ev) && cfg.authors.includes(ev.pubkey));
      const byKey = new Map();
      for (const ev of good) {
        // Replaceable: one entry per (author, d), newest wins.
        const key = kind >= 30000 ? `${ev.pubkey}:${tag(ev, "d") || ""}` : ev.id;
        const prev = byKey.get(key);
        if (!prev || prev.created_at < ev.created_at) byKey.set(key, ev);
      }
      let items = [...byKey.values()]
        .filter((ev) => (ev.content || "").length >= cfg.minLength)
        .sort((a, b) => b.created_at - a.created_at);

      if (cfg.pinned.length) {
        const isPinned = (ev) => cfg.pinned.includes(kind === 30023 ? tag(ev, "d") : ev.id);
        items = [...items.filter(isPinned), ...items.filter((ev) => !isPinned(ev))];
      }
      items = items.slice(0, cfg.limit);

      await this.loadProfiles(items.map((e) => e.pubkey), relays);
      this.render(el, cfg, items);
    } catch (err) {
      this.render(el, cfg, [], `Could not reach the relays: ${err.message}`);
    }
  }

  async loadProfiles(pubkeys, relays) {
    const missing = [...new Set(pubkeys)].filter((p) => !this.profiles.has(p));
    if (!missing.length) return;
    try {
      const metas = await this.nc.pool.querySync(relays, { kinds: [0], authors: missing });
      for (const ev of metas) {
        if (!verifyEvent(ev)) continue;
        const prev = this.profiles.get(ev.pubkey);
        if (prev && prev.created_at > ev.created_at) continue;
        try {
          const p = JSON.parse(ev.content);
          this.profiles.set(ev.pubkey, { created_at: ev.created_at, name: p.display_name || p.displayName || p.name, picture: p.picture });
        } catch { /* a malformed profile is not an error worth surfacing */ }
      }
    } catch { /* profiles are decoration; the feed still works without them */ }
    for (const p of missing) if (!this.profiles.has(p)) this.profiles.set(p, {});
  }

  paint(el, cfg, message) {
    this.clear(el);
    // Classes first: a status paragraph appears before any item does, and a
    // selector written against .nc-feed should match it.
    el.classList.add("nc-feed", `nc-feed-${cfg.type}`, `nc-feed-${cfg.style}`);
    const p = this.doc.createElement("p");
    p.className = "nc-feed-status";
    p.setAttribute("nc:transient", "");
    p.textContent = message;
    el.appendChild(p);
  }

  clear(el) { for (const n of [...el.querySelectorAll("[nc\\:transient]")]) n.remove(); }

  render(el, cfg, items, empty = "Nothing to show yet") {
    this.clear(el);
    el.classList.add("nc-feed", `nc-feed-${cfg.type}`, `nc-feed-${cfg.style}`);
    // Set even for none, and even after a failure, because the attribute is how
    // a document tells "this feed has finished" from "this feed is still
    // loading". Without that a page combining two feeds has to guess.
    el.setAttribute("nc:feed-count", String(items.length));
    if (!items.length) return this.paint(el, cfg, empty);
    const frag = this.doc.createDocumentFragment();
    for (const ev of items) frag.appendChild(this.card(ev, cfg));
    el.appendChild(frag);
  }

  card(ev, cfg) {
    const art = this.doc.createElement("article");
    art.className = "nc-item";
    art.setAttribute("nc:transient", "");
    const who = this.profiles.get(ev.pubkey) || {};
    const npub = nip19.npubEncode(ev.pubkey);
    const name = who.name || npub.slice(0, 12) + "…";
    const avatar = who.picture && /^https?:\/\//i.test(who.picture)
      ? `<img class="nc-avatar" src="${esc(who.picture)}" alt="" loading="lazy">` : "";

    let body = "", href, title = "";
    if (cfg.type === "articles") {
      title = tag(ev, "title") || tag(ev, "d") || "Untitled";
      const summary = tag(ev, "summary") || excerpt(ev.content);
      const image = tag(ev, "image");
      href = `https://njump.me/${nip19.naddrEncode({ kind: 30023, pubkey: ev.pubkey, identifier: tag(ev, "d") || "" })}`;
      body =
        (image && /^https?:\/\//i.test(image) ? `<img class="nc-cover" src="${esc(image)}" alt="" loading="lazy">` : "") +
        `<h3 class="nc-title"><a href="${esc(href)}" rel="noopener" target="_blank">${esc(title)}</a></h3>` +
        `<p class="nc-summary">${esc(summary)}</p>`;
    } else if (cfg.type === "images") {
      href = `https://njump.me/${nip19.neventEncode({ id: ev.id, author: ev.pubkey })}`;
      const pics = imetaUrls(ev).slice(0, 4)
        .map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join("");
      body = `<div class="nc-pics">${pics}</div>` +
        (ev.content ? `<p class="nc-text">${linkify(ev.content)}</p>` : "");
    } else {
      href = `https://njump.me/${nip19.neventEncode({ id: ev.id, author: ev.pubkey })}`;
      body = `<div class="nc-text"><p>${linkify(ev.content)}</p></div>`;
    }

    const tags = cfg.type === "articles"
      ? tagsAll(ev, "t").slice(0, 4).map((t) => `<span class="nc-tag">#${esc(t)}</span>`).join("")
      : "";

    art.innerHTML = sanitize(
      `<header class="nc-by">${avatar}<a class="nc-name" href="https://njump.me/${esc(npub)}" rel="noopener" target="_blank">${esc(name)}</a>` +
      `<a class="nc-when" href="${esc(href)}" rel="noopener" target="_blank">${esc(when(ev.created_at))}</a></header>` +
      body + (tags ? `<footer class="nc-tags">${tags}</footer>` : ""),
    );
    art.setAttribute("nc:by", ev.pubkey);
    // When it was posted, so a page merging two feeds can interleave them
    // without parsing the formatted date back out of the byline.
    art.setAttribute("nc:at", String(ev.created_at));
    return art;
  }

  start() {
    const all = this.widgets();
    if (!all.length) return;
    this.injectStyles();
    for (const el of all) this.load(el).catch(() => {});
  }

  refresh() { for (const el of this.widgets()) this.load(el).catch(() => {}); }

  // Enough styling that an unstyled page still looks deliberate; a document is
  // free to override every one of these class names.
  injectStyles() {
    if (this._styled) return;
    this._styled = true;
    // The base stylesheet already carries these rules, written against the
    // template's variables. Injecting a second copy at runtime would land after
    // the linked one and beat it at equal specificity, so a template that
    // restyled .nc-item would silently lose. Probe for a variable only the base
    // stylesheet defines, and stay out of the way when it is there.
    const styled = getComputedStyle(this.doc.documentElement)
      .getPropertyValue("--nc-radius").trim();
    if (styled) return;
    const s = this.doc.createElement("style");
    s.setAttribute("nc:chrome", "");
    s.setAttribute("data-nc-fallback", "");
    s.textContent = `
.nc-feed { display: grid; gap: 1rem; }
.nc-feed-grid { grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr)); }
.nc-item { border: 1px solid currentColor; border-color: color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 12px; padding: .9rem 1rem; overflow: hidden; }
.nc-by { display: flex; align-items: center; gap: .55rem; font-size: .82rem; margin-bottom: .5rem; opacity: .75; }
.nc-by a { text-decoration: none; }
.nc-by a:hover { text-decoration: underline; }
.nc-name { font-weight: 500; }
.nc-avatar { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; }
.nc-by .nc-when { margin-left: auto; }
.nc-item a { color: inherit; }
.nc-title { font-size: 1.05rem; margin: .2rem 0 .35rem; }
.nc-title a { text-decoration: none; }
.nc-summary, .nc-text { margin: 0; font-size: .92rem; opacity: .85; overflow-wrap: anywhere; }
.nc-text p { margin: 0 0 .5rem; }
.nc-cover { width: 100%; height: 9rem; object-fit: cover; border-radius: 8px; margin-bottom: .5rem; }
.nc-pics { display: grid; gap: .35rem; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); margin-bottom: .5rem; }
.nc-pics img { width: 100%; border-radius: 8px; object-fit: cover; }
.nc-tags { margin-top: .6rem; display: flex; gap: .4rem; flex-wrap: wrap; font-size: .75rem; opacity: .65; }
.nc-feed-status { opacity: .6; font-size: .9rem; }
.nc-figure { margin: 1.2rem 0; }
.nc-figure img, .nc-figure video { width: 100%; height: auto; border-radius: 10px; display: block; }
.nc-figure figcaption { font-size: .85rem; opacity: .7; margin-top: .45rem; }
.nc-embed .nc-embed-link { position: relative; display: block; }
.nc-embed-play { position: absolute; inset: 0; display: grid; place-items: center; font-size: 3rem;
  color: #fff; text-shadow: 0 2px 20px rgba(0,0,0,.7); }
`;
    // First child, not last: this is a fallback so an unstyled page still looks
    // deliberate, and a linked stylesheet must be able to override it at equal
    // specificity rather than losing to whatever was injected later.
    this.doc.head.insertBefore(s, this.doc.head.firstChild);
  }

  // ---- the insert dialog --------------------------------------------------

  async promptInsert() {
    let type, authors, limit, style, minLength, topic;
    const picked = new Set();          // slugs for articles, ids for notes

    const out = await modal({
      doc: this.doc,
      wide: true,
      title: "Insert a Nostr feed",
      hint: "Pick who to show, then click any post to pin it to the top. Signatures are checked in " +
            "the browser; the posts are fetched when the page loads rather than stored in it.",
      submitLabel: "Insert",
      build: (body, h) => {
        const doc = this.doc;
        type = field(body, { label: "What to show", options: [
          { value: "notes", label: "Short notes (kind 1)" },
          { value: "articles", label: "Long-form articles (kind 30023)" },
          { value: "images", label: "Picture posts (kind 20)" },
        ] });
        authors = field(body, {
          label: "Authors: one or more npubs, comma separated",
          value: this.nc.npub || "",
          placeholder: "npub1…, npub1…",
        });
        const row = doc.createElement("div"); row.className = "nc-row"; body.appendChild(row);
        limit = field(row, { label: "How many", type: "number", value: "5" });
        style = field(row, { label: "Style", options: ["list", "grid"] });
        minLength = field(row, { label: "Minimum length", type: "number", value: "0" });
        topic = field(body, { label: "Only events tagged (optional)", placeholder: "nostr" });

        const pickLabel = doc.createElement("label");
        pickLabel.textContent = "Their posts. Click to pin one to the top.";
        const pick = doc.createElement("ul");
        pick.className = "nc-pick";
        body.append(pickLabel, pick);

        // Show the real posts rather than asking for ids nobody has memorised.
        const browse = async () => {
          const list = authors.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).map(toHex).filter(Boolean);
          if (!list.length) { pick.innerHTML = ""; return; }
          pick.innerHTML = "<li style='color:#7e768f;font-size:.82rem'>looking…</li>";
          const kind = KINDS[type.value];
          try {
            const evs = await this.nc.pool.querySync(this.relaysFor({ relays: [] }), {
              kinds: [kind], authors: list, limit: 30,
            });
            const good = evs.filter((ev) => verifyEvent(ev) && list.includes(ev.pubkey))
              .sort((a, b) => b.created_at - a.created_at);
            pick.innerHTML = "";
            if (!good.length) {
              pick.innerHTML = "<li style='color:#7e768f;font-size:.82rem'>nothing found on these relays</li>";
              return;
            }
            for (const ev of good.slice(0, 20)) {
              const key = kind === 30023 ? (tag(ev, "d") || "") : ev.id;
              if (!key) continue;
              const li = doc.createElement("li");
              const btn = doc.createElement("button");
              btn.type = "button";
              btn.setAttribute("aria-pressed", String(picked.has(key)));
              const mark = doc.createElement("span");
              mark.className = "nc-mark";
              mark.textContent = picked.has(key) ? "\u2713" : "";
              const text = doc.createElement("span");
              text.className = "nc-body-text";
              const label = kind === 30023
                ? (tag(ev, "title") || key)
                : (ev.content.slice(0, 110) + (ev.content.length > 110 ? "…" : ""));
              const b = doc.createElement("b");
              b.textContent = label;
              const meta = doc.createElement("small");
              meta.textContent = when(ev.created_at) + (kind === 30023 ? ` · ${key}` : "");
              text.append(b, meta);
              btn.append(mark, text);
              btn.onclick = () => {
                picked.has(key) ? picked.delete(key) : picked.add(key);
                btn.setAttribute("aria-pressed", String(picked.has(key)));
                mark.textContent = picked.has(key) ? "\u2713" : "";
                h.status(picked.size ? `${picked.size} pinned` : "");
              };
              li.appendChild(btn);
              pick.appendChild(li);
            }
          } catch (e) {
            pick.innerHTML = `<li style='color:#e79191;font-size:.82rem'>could not reach the relays: ${e.message}</li>`;
          }
        };

        let debounce;
        authors.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(browse, 500); });
        type.addEventListener("change", () => { picked.clear(); browse(); });
        browse();
      },
      onSubmit: () => {
        const list = authors.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
        if (!list.length) throw new Error("Give at least one npub");
        const bad = list.find((a) => !toHex(a));
        if (bad) throw new Error(`Not a valid npub: ${bad}`);
        return {
          type: type.value, authors: list, limit: limit.value, style: style.value,
          minLength: minLength.value, topic: topic.value.trim(), pinned: [...picked],
        };
      },
    });
    if (!out) return null;

    const el = this.doc.createElement("div");
    el.setAttribute("nc:feed", out.type);
    el.setAttribute("nc:authors", out.authors.join(","));
    el.setAttribute("nc:limit", String(out.limit));
    el.setAttribute("nc:style", out.style);
    if (Number(out.minLength) > 0) el.setAttribute("nc:min-length", String(out.minLength));
    if (out.topic) el.setAttribute("nc:topic", out.topic);
    if (out.pinned.length) el.setAttribute("nc:pinned", out.pinned.join(","));

    this.nc.media.insert(el);
    this.injectStyles();
    await this.load(el);
    return el;
  }
}
