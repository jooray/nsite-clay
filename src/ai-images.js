// Pictures made by AI for a page that is being built.
//
// A picture is kept out of the document. The page names it by a relative path,
// `images/<sha256>.<ext>`, which is the path it is published at next to the
// page, and the bytes wait in this browser until then: in memory, and in
// IndexedDB so that a reload does not throw away something that was paid for.
// Inlined as a data URI it would be uploaded again with every save of the page
// and would not fit in a draft at all.
import { hashBytes } from "./blossom.js";
import { aspectFor } from "./ai-client.js";

export const PICTURE_PATH = /^(?:\.\/)?(images\/[0-9a-f]{64}\.(?:webp|jpg))$/;
export const pictureName = (src) => PICTURE_PATH.exec(String(src || "").trim())?.[1] || null;

const MAX_WIDTH = 1200;

function ratioOf(crop) {
  const parts = String(crop || "").split(":").map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return parts[0] / parts[1];
}

/**
 * Cut a picture to the frame it is going into and make it small enough to
 * publish.
 *
 * Models answer in whatever shape and format they like, a square PNG of a few
 * megabytes being common, and a page does not need more than this.
 */
export async function reencode(blob, crop, { doc = globalThis.document } = {}) {
  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new Error("The AI endpoint returned something that is not a picture."); }
  const { width: w, height: h } = bitmap;
  const ratio = ratioOf(crop);
  let sx = 0, sy = 0, sw = w, sh = h;
  if (ratio) {
    if (w / h > ratio) { sw = Math.max(1, Math.round(h * ratio)); sx = Math.round((w - sw) / 2); }
    else { sh = Math.max(1, Math.round(w / ratio)); sy = Math.round((h - sh) / 2); }
  }
  const outW = Math.min(MAX_WIDTH, sw), outH = Math.max(1, Math.round(outW * sh / sw));
  const canvas = doc.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);
  bitmap.close?.();
  const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  let out = await encode("image/webp", 0.75);
  // A browser that cannot write WebP hands back a PNG instead, which is the
  // largest choice there is, so ask for a JPEG rather than keep it.
  if (!out || out.type !== "image/webp") out = await encode("image/jpeg", 0.8);
  if (!out) throw new Error("This browser could not prepare the picture.");
  return out;
}

const DB = "nsite-clay-images", STORE = "pictures", KEEP_DAYS = 90;

export class ImageStore {
  constructor(win = globalThis) { this.win = win; this.memory = new Map(); }

  db() {
    if (this._db) return this._db;
    this._db = new Promise((resolve) => {
      try {
        const open = this.win.indexedDB.open(DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => resolve(null);
        open.onblocked = () => resolve(null);
      } catch { resolve(null); }
    }).then((db) => { if (db) this.prune(db); return db; });
    return this._db;
  }

  async tx(mode, run) {
    const db = await this.db();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const t = db.transaction(STORE, mode), request = run(t.objectStore(STORE));
        t.oncomplete = () => resolve(request?.result ?? true);
        t.onerror = t.onabort = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  // Old pictures from abandoned drafts would otherwise stay forever.
  prune(db) {
    try {
      const cutoff = Date.now() - KEEP_DAYS * 86400000;
      const cursor = db.transaction(STORE, "readwrite").objectStore(STORE).openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result; if (!c) return;
        if (!(c.value?.saved > cutoff)) c.delete();
        c.continue();
      };
    } catch { /* storage is a convenience here */ }
  }

  async put(name, blob) {
    const url = await dataURL(blob);
    this.memory.set(name, { blob, url });
    const bytes = await blob.arrayBuffer();
    await this.tx("readwrite", (s) => s.put({ bytes, type: blob.type, saved: Date.now() }, name));
    return url;
  }

  async get(name) {
    if (this.memory.has(name)) return this.memory.get(name).blob;
    const row = await this.tx("readonly", (s) => s.get(name));
    if (!row?.bytes) return null;
    const blob = new Blob([row.bytes], { type: row.type || "image/webp" });
    // The name is the hash of the bytes. Anything else is not this picture.
    if (`images/${hashBytes(new Uint8Array(row.bytes))}` !== name.replace(/\.(webp|jpg)$/, "")) return null;
    this.memory.set(name, { blob, url: await dataURL(blob) });
    return blob;
  }

  url(name) { return this.memory.get(name)?.url || null; }

  /** Bring every picture a page names into memory, so a preview can show it. */
  async load(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    const names = [...doc.querySelectorAll("img[src]")].map((el) => pictureName(el.getAttribute("src"))).filter(Boolean);
    await Promise.all([...new Set(names)].map((n) => this.get(n).catch(() => null)));
  }
}

function dataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Make one picture for a frame, ready to publish, and keep it. */
export async function makePicture(ai, prompt, crop, { signal } = {}) {
  const raw = await ai.client.generateImage(prompt, { aspect: aspectFor(crop), signal });
  const blob = await reencode(raw, crop, { doc: ai.doc });
  const ext = blob.type === "image/webp" ? "webp" : "jpg";
  const name = `images/${hashBytes(new Uint8Array(await blob.arrayBuffer()))}.${ext}`;
  await ai.images.put(name, blob);
  return { name, blob };
}

/**
 * Fill the empty frames of a generated page with pictures.
 *
 * Each frame the model left without a source and with a description gets one,
 * two at a time, up to `limit`. A picture that fails leaves its frame empty,
 * which is a page that already works: the owner fills it later from the
 * content form. Credit running out, or a key the endpoint refuses, stops the
 * rest, since every further request would fail the same way.
 */
export async function fillPictures(ai, html, { limit = 0, signal, onProgress = () => {}, concurrency = 2 } = {}) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const prompt = (el) => (el.getAttribute("nc:prompt") || el.getAttribute("alt") || "").trim();
  const frames = [...doc.body.querySelectorAll("img")]
    .filter((el) => !el.closest("template") && !(el.getAttribute("src") || "").trim() && prompt(el))
    .slice(0, Math.max(0, limit));
  if (!frames.length) return { html, made: 0, failed: 0, error: null };
  let done = 0, made = 0, error = null, stop = false;
  const queue = [...frames];
  onProgress(0, frames.length);
  const worker = async () => {
    while (queue.length && !stop && !signal?.aborted) {
      const el = queue.shift();
      try {
        const { name } = await makePicture(ai, prompt(el), el.getAttribute("nc:crop") || "16:9", { signal });
        el.setAttribute("src", name);
        made++;
      } catch (e) {
        if (signal?.aborted) return;
        error = e;
        if ([401, 402].includes(e?.status)) stop = true;
      }
      onProgress(++done, frames.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, frames.length) }, worker));
  return { html: made ? "<!DOCTYPE html>\n" + doc.documentElement.outerHTML : html, made, failed: frames.length - made, error };
}

/**
 * The pictures a page names, as files to publish next to it.
 *
 * One the browser no longer has is taken out of the page rather than published
 * as a broken link: its frame is empty again and the content form can fill it.
 */
export async function pictureFiles(ai, html, dir = "/") {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const files = new Map();
  let missing = 0;
  for (const el of doc.querySelectorAll("img[src]")) {
    const name = pictureName(el.getAttribute("src"));
    if (!name) continue;
    const blob = await ai.images.get(name).catch(() => null);
    if (!blob) { el.removeAttribute("src"); missing++; continue; }
    if (!files.has(name)) files.set(name, { path: dir + name, bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type });
  }
  return { html: missing ? "<!DOCTYPE html>\n" + doc.documentElement.outerHTML : html, files: [...files.values()], missing };
}
