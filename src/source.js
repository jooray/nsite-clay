import { model, checkSource, pair, render, verify, locate } from "./vendor/clay-source/source-map.js";

// A source map never overrides live state. Every candidate must parse to the
// prepared save clone, or we keep the existing full serializer's result.
export class Source {
  constructor(nc) { this.nc = nc; this.ready = null; this.reprints = 0; }

  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const url = this.nc.doc.location?.href;
      if (!/^https?:/.test(url || "")) return false;
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
    try {
      const next = model(text);
      if (checkSource(next, this.nc.doc)) return false;
      const capture = this.nc._capture();
      const { map } = pair(capture.clone, next, capture.original);
      this.model = next; this.mapping = map;
      return true;
    } catch { return false; }
  }

  text() { return this.model?.src ?? null; }
  locate(element) { return this.model ? locate(element, this.mapping, this.model) : null; }

  render(capture) {
    if (!this.model) return capture.html;
    try {
      const out = render(capture.clone, this.mapping, this.model, capture.original);
      const result = verify(out.text, capture.html, this.nc.doc, capture.clone, this.model.parseErrors);
      if (result.ok) return out.text;
      this.lastReprint = result.diff;
    } catch (e) { this.lastReprint = e.message; }
    this.reprints++;
    this.nc._emit("nsiteclay:save-reprinted", { reason: this.lastReprint });
    return capture.html;
  }
}
