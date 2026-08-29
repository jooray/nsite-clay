// Images and video.
//
// Two ways in for each: a URL you already have, or a file uploaded to the same
// Blossom servers the document itself is stored on. An uploaded file is
// content-addressed, so it is immutable and the URL never has to change.
//
// Video from YouTube or Vimeo is inserted as a **facade**, not an iframe: a
// thumbnail and a real link, upgraded to the embed only when a reader clicks it.
// The saved file therefore contains no third-party frame, works with JavaScript
// off (the link goes to the video), and costs a reader nothing until they ask.
import { modal, field, toast } from "./ui.js";
import { uploadAll, list } from "./blossom.js";

const EXT = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
  "image/avif": ".avif", "image/svg+xml": ".svg",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
};

export function parseVideoUrl(url) {
  const s = String(url || "").trim();
  let m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,20})/i);
  if (m) return { provider: "youtube", id: m[1] };
  m = s.match(/vimeo\.com\/(?:video\/)?(\d{6,12})/i);
  if (m) return { provider: "vimeo", id: m[1] };
  return null;
}

const EMBED = {
  youtube: (id) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`,
  vimeo: (id) => `https://player.vimeo.com/video/${id}?autoplay=1`,
};
const WATCH = {
  youtube: (id) => `https://www.youtube.com/watch?v=${id}`,
  vimeo: (id) => `https://vimeo.com/${id}`,
};
const POSTER = {
  youtube: (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  vimeo: () => "",
};

export class Media {
  constructor(nc) { this.nc = nc; this.doc = nc.doc; }

  get servers() { return this.nc.cfg.servers; }

  // Upload any file to every configured Blossom server. Succeeds if one takes
  // it; the URL comes from the server's descriptor rather than being guessed,
  // because a server is entitled to serve blobs from another host.
  async upload(file) {
    if (!this.nc.signer) throw new Error("Sign in before uploading");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = file.type || "application/octet-stream";
    const { hash, ok } = await uploadAll(this.servers, bytes, { signer: this.nc.signer, type });
    const ext = EXT[type] || "";
    const url = ok[0]?.url || `${ok[0].server}/${hash}${ext}`;
    return { url, hash, type, size: bytes.length };
  }

  // ---- inserting ----------------------------------------------------------

  insert(node) {
    const host = this.nc.editable.activeHost?.();
    if (host) {
      // Put it where the caret is, then leave a paragraph after it so there is
      // somewhere to keep typing.
      const sel = this.doc.getSelection();
      if (sel?.rangeCount) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(node);
        const after = this.doc.createElement("p");
        after.appendChild(this.doc.createElement("br"));
        node.after(after);
        const nr = this.doc.createRange();
        nr.setStart(after, 0); nr.collapse(true);
        sel.removeAllRanges(); sel.addRange(nr);
      } else host.appendChild(node);
    } else {
      (this.doc.querySelector("[editable]") || this.doc.body).appendChild(node);
    }
    this.nc.dirty = true;
    return node;
  }

  image({ url, alt = "", caption = "" }) {
    const fig = this.doc.createElement("figure");
    fig.className = "nc-figure";
    const img = this.doc.createElement("img");
    img.src = url; img.alt = alt; img.loading = "lazy";
    fig.appendChild(img);
    if (caption) {
      const cap = this.doc.createElement("figcaption");
      cap.textContent = caption;
      fig.appendChild(cap);
    }
    return this.insert(fig);
  }

  videoFile({ url, type }) {
    const v = this.doc.createElement("video");
    v.setAttribute("controls", "");
    v.setAttribute("preload", "metadata");
    v.setAttribute("playsinline", "");
    const src = this.doc.createElement("source");
    src.src = url; src.type = type || "video/mp4";
    v.appendChild(src);
    const fig = this.doc.createElement("figure");
    fig.className = "nc-figure";
    fig.appendChild(v);
    return this.insert(fig);
  }

  // The facade. Everything a reader needs without JavaScript is right here: a
  // link to the video and a poster image.
  videoEmbed({ provider, id, title = "" }) {
    const fig = this.doc.createElement("figure");
    fig.className = "nc-figure nc-embed";
    fig.setAttribute("nc:video", `${provider}:${id}`);
    const a = this.doc.createElement("a");
    a.href = WATCH[provider](id);
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    a.className = "nc-embed-link";
    const poster = POSTER[provider](id);
    if (poster) {
      const img = this.doc.createElement("img");
      img.src = poster; img.alt = title || "Video thumbnail"; img.loading = "lazy";
      a.appendChild(img);
    } else {
      a.textContent = title || `Watch on ${provider}`;
    }
    const play = this.doc.createElement("span");
    play.className = "nc-embed-play";
    play.setAttribute("aria-hidden", "true");
    play.textContent = "▶";
    a.appendChild(play);
    fig.appendChild(a);
    if (title) {
      const cap = this.doc.createElement("figcaption");
      cap.textContent = title;
      fig.appendChild(cap);
    }
    return this.insert(fig);
  }

  // ---- reader side --------------------------------------------------------

  // Swap a facade for the real player, but only once a reader has clicked it.
  // Runs in view mode too, which is the whole point.
  armEmbeds() {
    if (this._armed) return;
    this._armed = true;
    this.doc.addEventListener("click", (e) => {
      const fig = e.target.closest?.("[nc\\:video]");
      if (!fig || fig.querySelector("iframe")) return;
      const [provider, id] = (fig.getAttribute("nc:video") || "").split(":");
      if (!EMBED[provider] || !id) return;
      e.preventDefault();
      const frame = this.doc.createElement("iframe");
      frame.src = EMBED[provider](id);
      frame.setAttribute("allow", "accelerometer; autoplay; encrypted-media; picture-in-picture");
      frame.setAttribute("allowfullscreen", "");
      frame.setAttribute("loading", "lazy");
      frame.setAttribute("title", fig.querySelector("figcaption")?.textContent || "Embedded video");
      frame.setAttribute("nc:transient", "");   // never written back to the file
      frame.style.cssText = "width:100%;aspect-ratio:16/9;border:0;border-radius:inherit";
      fig.querySelector(".nc-embed-link").replaceWith(frame);
    });
  }

  // ---- the dialogs --------------------------------------------------------

  async promptImage() {
    let url, alt, cap;
    const out = await modal({
      doc: this.doc,
      title: "Insert an image",
      hint: "Drop a file, pick one you have already uploaded, or paste a URL.",
      submitLabel: "Insert",
      build: (body, h) => {
        const doc = body.ownerDocument;

        // Drop target first, because dragging a file in is what people try.
        const drop = doc.createElement("div");
        drop.className = "nc-drop";
        drop.textContent = "Drop an image here, or click to choose a file";
        const file = doc.createElement("input");
        file.type = "file"; file.accept = "image/*"; file.hidden = true;
        body.append(drop, file);

        const take = async (f) => {
          if (!f) return;
          h.status(`uploading ${(f.size / 1024).toFixed(0)} KB…`); h.busy(true);
          try {
            const r = await this.upload(f);
            url.value = r.url;
            preview(r.url);
            h.status("uploaded");
          } catch (e) { h.status(e.message, true); }
          finally { h.busy(false); }
        };
        drop.onclick = () => file.click();
        file.onchange = () => take(file.files?.[0]);
        for (const ev of ["dragenter", "dragover"]) {
          drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("nc-over"); });
        }
        for (const ev of ["dragleave", "drop"]) {
          drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("nc-over"); });
        }
        drop.addEventListener("drop", (e) => take(e.dataTransfer?.files?.[0]));

        // Everything this key has uploaded before, as a grid to click.
        const galleryLabel = doc.createElement("label");
        galleryLabel.textContent = "Already uploaded";
        const gallery = doc.createElement("div");
        gallery.className = "nc-grid";
        gallery.innerHTML = "<p style='grid-column:1/-1;color:#7e768f;font-size:.82rem;margin:0'>looking…</p>";
        body.append(galleryLabel, gallery);

        const chosen = (btn) => {
          for (const b of gallery.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
        };
        list(this.servers, this.nc.pubkey, { signer: this.nc.signer })
          .then((blobs) => {
            const images = blobs.filter((b) => (b.type || "").startsWith("image/")).slice(0, 40);
            gallery.innerHTML = "";
            if (!images.length) {
              galleryLabel.remove(); gallery.remove();
              return;
            }
            for (const b of images) {
              const btn = doc.createElement("button");
              btn.type = "button"; btn.setAttribute("aria-pressed", "false");
              btn.title = `${(b.size / 1024).toFixed(0)} KB`;
              const img = doc.createElement("img");
              img.src = b.url; img.alt = ""; img.loading = "lazy";
              btn.appendChild(img);
              btn.onclick = () => { url.value = b.url; chosen(btn); preview(b.url); };
              gallery.appendChild(btn);
            }
          })
          .catch(() => { galleryLabel.remove(); gallery.remove(); });

        url = field(body, { label: "…or an image URL", placeholder: "https://…" });
        alt = field(body, { label: "Alt text: what the image shows, for anyone who cannot see it" });
        cap = field(body, { label: "Caption (optional)" });

        // A live look at what will be inserted.
        const shown = doc.createElement("img");
        shown.style.cssText = "display:none;max-height:9rem;border-radius:9px;margin-top:.7rem";
        body.appendChild(shown);
        const preview = (src) => {
          shown.src = src;
          shown.style.display = src ? "block" : "none";
        };
        url.addEventListener("input", () => preview(url.value.trim()));
      },
      onSubmit: () => {
        const src = url.value.trim();
        if (!src) throw new Error("Drop a file, pick one, or paste a URL");
        if (!/^https?:\/\//i.test(src)) throw new Error("Only http(s) URLs can be used");
        return { url: src, alt: alt.value.trim(), caption: cap.value.trim() };
      },
    });
    return out ? this.image(out) : null;
  }

  async promptVideo() {
    let url, title, uploaded = null;
    const out = await modal({
      doc: this.doc,
      title: "Insert a video",
      hint: "A YouTube or Vimeo link becomes a click-to-play thumbnail, so no third-party frame " +
            "loads until a reader asks for it. An uploaded file is served from Blossom.",
      submitLabel: "Insert",
      build: (body, h) => {
        url = field(body, { label: "YouTube or Vimeo URL", placeholder: "https://youtube.com/watch?v=…" });
        const l = body.ownerDocument.createElement("label");
        l.textContent = "…or upload a video file";
        const file = body.ownerDocument.createElement("input");
        file.type = "file"; file.accept = "video/*";
        body.append(l, file);
        title = field(body, { label: "Caption (optional)" });
        file.onchange = async () => {
          const f = file.files?.[0];
          if (!f) return;
          h.status(`uploading ${(f.size / 1048576).toFixed(1)} MB…`); h.busy(true);
          try {
            uploaded = await this.upload(f);
            url.value = uploaded.url;
            h.status("uploaded");
          } catch (e) { h.status(e.message, true); }
          finally { h.busy(false); }
        };
      },
      onSubmit: () => {
        const raw = url.value.trim();
        if (!raw) throw new Error("Give a video URL or upload a file");
        const parsed = parseVideoUrl(raw);
        if (parsed) return { kind: "embed", ...parsed, title: title.value.trim() };
        if (!/^https?:\/\//i.test(raw)) throw new Error("Only http(s) URLs can be used");
        return { kind: "file", url: raw, type: uploaded?.type, title: title.value.trim() };
      },
    });
    if (!out) return null;
    return out.kind === "embed" ? this.videoEmbed(out) : this.videoFile(out);
  }
}
