// Deliberately not imported: the serialiser and parse5 behind it are a third of
// the bundle, and a reader never saves. The page names the file in nc:source and
// it is fetched when editing starts. Absent, unreachable or stale, every path
// below falls through to the full serialiser, which is what this ran on before
// source preservation existed.

// A source map never overrides live state. Every candidate must parse to the
// prepared save clone, or we keep the existing full serializer's result.
export class Source {
  constructor(nc) { this.nc = nc; this.ready = null; this.reprints = 0; this.lib = null; }

  // The file the document says holds the serialiser, stamped by whoever published
  // it. No attribute means a page from before this was split out, and a full
  // serialisation is the honest answer rather than a guess at a URL.
  url() {
    const declared = this.nc.doc.documentElement.getAttribute("nc:source");
    return declared && declared.startsWith("/") && !declared.startsWith("//") ? declared : null;
  }

  // Loaded once, on demand, as a plain script: the runtime is an IIFE bundle and
  // cannot carry a dynamic import that survives being renamed by a publisher.
  load() {
    if (this.lib) return this.lib;
    this.lib = (async () => {
      const src = this.url();
      if (!src) return null;
      const win = this.nc.doc.defaultView;
      if (win?.NsiteClaySource) return win.NsiteClaySource;
      try {
        await new Promise((resolve, reject) => {
          const el = this.nc.doc.createElement("script");
          el.src = src; el.async = true; el.setAttribute("nc:chrome", "");
          el.onload = resolve; el.onerror = () => reject(new Error(src));
          this.nc.doc.head.appendChild(el);
        });
      } catch { return null; }
      return win?.NsiteClaySource || null;
    })();
    return this.lib;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const url = this.nc.doc.location?.href;
      if (!/^https?:/.test(url || "")) return false;
      if (!await this.load()) return false;
      try {
        const response = await fetch(url, { cache: "no-store", redirect: "error", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
        if (!response.ok || !/^text\/html\b/i.test(response.headers.get("content-type") || "")) return false;
        // A successful local save while the initial fetch was in flight wins.
        const text = await response.text();
        if (!this.model) this.adopt(text);
        return !!this.model;
      } catch { return false; }
    })();
    return this.ready;
  }

  adopt(text) {
    const lib = this.nc.doc.defaultView?.NsiteClaySource;
    if (!lib) return false;
    try {
      const next = lib.model(text);
      if (lib.checkSource(next, this.nc.doc)) return false;
      const capture = this.nc._capture();
      const { map } = lib.pair(capture.clone, next, capture.original);
      this.model = next; this.mapping = map;
      return true;
    } catch { return false; }
  }

  text() { return this.model?.src ?? null; }
  locate(element) {
    const lib = this.nc.doc.defaultView?.NsiteClaySource;
    return this.model && lib ? lib.locate(element, this.mapping, this.model) : null;
  }

  render(capture) {
    const lib = this.nc.doc.defaultView?.NsiteClaySource;
    if (!this.model || !lib) return capture.html;
    try {
      const out = lib.render(capture.clone, this.mapping, this.model, capture.original);
      const result = lib.verify(out.text, capture.html, this.nc.doc, capture.clone, this.model.parseErrors);
      if (result.ok) return out.text;
      this.lastReprint = result.diff;
    } catch (e) { this.lastReprint = e.message; }
    this.reprints++;
    this.nc._emit("nsiteclay:save-reprinted", { reason: this.lastReprint });
    return capture.html;
  }
}
