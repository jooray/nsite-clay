// Routstr is the payment service as well as the inference endpoint. There is no
// discovery or automatic failover here: the owner chooses who receives a request.
export const AI_DEFAULTS = Object.freeze({ mode: "routstr", base: "https://routstr.cypherpunk.today/v1", model: "deepseek-v4-1-flash-1017",
  imageModel: "qwen-image-2-1-turbo", pictures: 4 });
const STORAGE = "nsite-clay.ai";
export const MAX_PICTURES = 8;

// Pictures are settings of their own, and a profile saved before they existed
// has neither. A Routstr node is ours to know the default of; somebody else's
// OpenAI-compatible endpoint is not, so pictures there stay off until a model
// is named for them.
function pictureSettings(c, mode) {
  const imageModel = c.imageModel === undefined || c.imageModel === null
    ? (mode === "routstr" ? AI_DEFAULTS.imageModel : "") : String(c.imageModel).trim();
  const n = c.pictures === undefined || c.pictures === null || c.pictures === "" ? AI_DEFAULTS.pictures : Number(c.pictures);
  return { imageModel, pictures: Number.isFinite(n) ? Math.max(0, Math.min(MAX_PICTURES, Math.floor(n))) : AI_DEFAULTS.pictures };
}

/**
 * Sats for one picture at the tier a request that names none is billed at.
 *
 * `sats_pricing.image_output` is the dearest tier the model has. The node
 * prices a request at the model's default tier, so the price book scales the
 * ceiling down by that tier's share of it, exactly as the node does.
 */
export function imagePrice(model) {
  const ceiling = Number(model?.sats_pricing?.image_output);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
  const book = model.image_pricing, max = Number(book?.max_usd);
  if (!book || !(max > 0)) return ceiling;
  const tiers = Array.isArray(book.tiers) ? book.tiers : [];
  const r = book.default_resolution ?? null, q = book.default_quality ?? null;
  const tier = tiers.find((t) => (t.resolution ?? null) === r && (t.quality ?? null) === q)
    || tiers.find((t) => (t.resolution ?? null) === r && (t.quality ?? null) === null);
  const usd = Number(tier?.usd ?? max);
  return Number.isFinite(usd) && usd > 0 ? ceiling * usd / max : ceiling;
}

// The shapes image models commonly accept. A frame of any other shape asks for
// the nearest of these and is cropped to its own shape afterwards.
const ASPECTS = ["1:1", "3:2", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5"];
export function aspectFor(crop) {
  const parts = String(crop || "").split(":").map(Number);
  const ratio = parts.length === 2 && parts.every((n) => Number.isFinite(n) && n > 0) ? parts[0] / parts[1] : 1;
  let best = "1:1", gap = Infinity;
  for (const a of ASPECTS) {
    const [w, h] = a.split(":").map(Number), d = Math.abs(Math.log(ratio / (w / h)));
    if (d < gap) { gap = d; best = a; }
  }
  return best;
}

function sniff(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  return "application/octet-stream";
}
function fromBase64(b64) {
  const text = String(b64).replace(/^data:[^,]*,/, "");
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (!bytes.length) throw new Error("The AI endpoint returned an empty picture.");
  return new Blob([bytes], { type: sniff(bytes) });
}
// A refusal of the request's shape, as opposed to of the key, the credit, or
// the connection. Only these are worth asking again in another dialect.
const shapeRefused = (e) => e?.status >= 400 && e.status < 500 && ![401, 402, 403, 429].includes(e.status);

// Estimates include room for reasoning. They are a planning range, not a quote
// or the provider's reservation, and never a reason to refuse a paid request.
export function estimateAiCost(pricing, chars = 0, kind = "page") {
  if (pricing?.prompt == null || pricing?.completion == null || pricing.prompt === "" || pricing.completion === "") return null;
  const input = Number(pricing?.prompt), output = Number(pricing?.completion);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  const inputTokens = 1000 + Math.ceil(Math.max(0, chars) / 3);
  const [low, high] = kind === "element" ? [500, 4000] : [8000, 32000];
  return { low: inputTokens * input + low * output, high: inputTokens * input + high * output,
    inputPerK: input * 1000, outputPerK: output * 1000 };
}

export function aiEndpoint(value, mode = "routstr") {
  const url = new URL(String(value).trim());
  if (url.username || url.password || url.search || url.hash) throw new Error("Use an API URL without credentials, query parameters or a fragment.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Use an HTTPS API URL.");
  }
  let base = url.href.replace(/\/+$/, "");
  if (mode === "routstr" && !base.endsWith("/v1")) base += "/v1";
  return base;
}

// Caps to try, largest first, and never larger than what was asked for. The
// rungs are the common ceilings: 32k, 16k, and 4k for the smallest models.
function ladder(maxTokens) {
  const rungs = [maxTokens, 32000, 16000, 8000, 4096].filter((n) => n <= maxTokens);
  return [...new Set(rungs)];
}

// An endpoint refusing the size of the answer, rather than anything else.
// Matched on the message because there is no status code that means this: a
// 400 covers every malformed request there is.
function overLimit(error) {
  return /max_tokens|max_completion_tokens|maximum.{0,20}tokens|output.{0,20}too (large|long)/i.test(error?.message || "");
}

const textModels = (list) => list.filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text"));
const imageModels = (list) => list.filter((m) => m.architecture?.output_modalities?.includes("image"));

export class AiClient {
  constructor(storage = null) {
    this.storage = storage;
    try { this.data = JSON.parse(storage?.getItem(STORAGE) || "{}"); } catch { this.data = {}; }
    if (!this.data || typeof this.data !== "object" || Array.isArray(this.data)) this.data = {};
    if (!this.data.nodes || typeof this.data.nodes !== "object" || Array.isArray(this.data.nodes)) this.data.nodes = {};
    try {
      const c = { ...AI_DEFAULTS, ...this.data.config };
      const mode = c.mode === "byok" ? "byok" : "routstr";
      this.config = { mode, base: aiEndpoint(c.base, c.mode), model: String(c.model), ...pictureSettings(this.data.config || {}, mode) };
    } catch { this.config = { ...AI_DEFAULTS }; }
    this.native = new Set();
  }

  persist() {
    if (!this.storage) throw new Error("Browser storage is unavailable. Enable it before adding AI credit.");
    this.storage.setItem(STORAGE, JSON.stringify(this.data));
  }
  record(base = this.config.base) { return this.data.nodes[base] ||= {}; }
  session() { return { ...this.config, key: this.record().key || "" }; }
  profile(base = this.config.base) {
    return { ...(base === this.config.base ? this.config : this.record(base).profile), base };
  }
  configure({ mode, base, model, key, imageModel, pictures } = {}) {
    const kind = mode === "byok" ? "byok" : "routstr";
    const next = { mode: kind, base: aiEndpoint(base || AI_DEFAULTS.base, mode), model: String(model || "").trim(),
      ...pictureSettings({ imageModel, pictures }, kind) };
    if (!next.model) throw new Error("Choose a model or enter its model ID.");
    this.config = next; this.data.config = next;
    this.record(next.base).profile = { ...next };
    if (key !== undefined) this.record(next.base).key = String(key).trim();
    this.persist();
    return this.session();
  }
  setKey(key, base = this.config.base) {
    if (typeof key !== "string" || !key.trim()) throw new Error("The node did not return an API key.");
    this.record(base).key = key.trim(); this.persist();
  }

  // `timeout` is a clock on the whole exchange for a small JSON reply, which is
  // right: the answer is one short object and a slow one is a broken one. For a
  // stream it measures only how long the reply takes to start, because an answer
  // still arriving is working, however long it runs. The caller watches for
  // silence after that.
  async request(path, { session = this.session(), body, publicRequest = false, signal, timeout = 30000, raw = false } = {}) {
    const url = path.startsWith("/v2/") ? session.base.replace(/\/v1$/, "") + path : session.base + path;
    const headers = { Accept: raw ? "text/event-stream" : "application/json" };
    if (!publicRequest && session.key) headers.Authorization = `Bearer ${session.key}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const clock = new AbortController();
    let late = false;
    const timer = setTimeout(() => { late = true; clock.abort(); }, timeout);
    const watched = signal ? AbortSignal.any([signal, clock.signal]) : clock.signal;
    try {
      let response;
      try {
        response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers,
          body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit", redirect: "error", signal: watched });
      } catch (e) {
        if (late && !signal?.aborted) throw new Error("The AI endpoint did not answer in time. Check its address, or try again.");
        if (signal?.aborted || e.name === "AbortError" || e.name === "TimeoutError") throw e;
        throw new Error("Could not reach the AI endpoint. Check its address and browser CORS support.");
      }
      if (!response.ok) {
        let error;
        try { error = await response.json(); } catch {}
        const detail = error?.error?.message || error?.detail?.error?.message || error?.detail;
        let message = typeof detail === "string" ? detail.slice(0, 500) : `AI endpoint returned HTTP ${response.status}.`;
        if (session.key) message = message.replaceAll(session.key, "[key]");
        if (response.status === 402) message = "Your AI credit is too low for this request. Add credit or choose a cheaper model.";
        if (response.status === 401) message = "The AI endpoint did not accept this key. Check the key for this node.";
        // A Routstr node answers 422 to a balance question asked with no key. The
        // node is right and the question was wrong: there is nothing to ask about
        // until credit has been added, and "HTTP 422" says none of that.
        if (!session.key && path === "/balance/info") message = "There is no key for this node yet. Add credit below and the node issues one.";
        throw Object.assign(new Error(message), { status: response.status });
      }
      return raw ? response : await response.json();
    } finally {
      // For a stream this fires once the headers are in, which is the point: the
      // clock must not outlive the wait it was measuring and kill the body.
      clearTimeout(timer);
    }
  }

  async catalogue(session = this.session(), options = {}) {
    const data = await this.request("/models", { ...options, session, publicRequest: session.mode === "routstr" });
    if (!Array.isArray(data.data)) throw new Error("The endpoint did not return a model list. Enter the model ID manually.");
    return data.data.filter((m) => m.id && m.enabled !== false);
  }
  async models(session = this.session(), options = {}) {
    return textModels(await this.catalogue(session, options));
  }
  async imageModels(session = this.session(), options = {}) {
    return imageModels(await this.catalogue(session, options));
  }
  routstr(session) { if (session.mode !== "routstr") throw new Error("Credit controls are available for Routstr nodes."); }
  balance(session = this.session(), options = {}) { this.routstr(session); return this.request("/balance/info", { ...options, session }); }
  info(session = this.session()) { this.routstr(session); return this.request("/info", { session, publicRequest: true }); }

  async check(session = this.session()) {
    // OpenAI-compatible APIs have no standard balance endpoint. A configured key
    // is not proof of either its validity or available funds.
    if (session.mode !== "routstr") return { state: session.key ? "configured" : "noKey", session, canGenerate: !!session.key,
      image: session.imageModel ? { model: session.imageModel, price: null } : null };
    const [funds, listed] = await Promise.allSettled([
      session.key ? this.balance(session, { timeout: 8000 }) : Promise.resolve(null),
      this.catalogue(session, { timeout: 8000 }),
    ]);
    const models = listed.status === "fulfilled" ? { status: "fulfilled", value: textModels(listed.value) } : listed;
    const model = models.status === "fulfilled" ? models.value.find((m) => m.id === session.model) : null;
    // Pictures are on offer only when the node sells the model asked for. A
    // node that does not is a node without pictures, never one without pages.
    const drawn = listed.status === "fulfilled" && session.imageModel
      ? imageModels(listed.value).find((m) => m.id === session.imageModel) : null;
    const image = drawn ? { model: drawn.id, price: imagePrice(drawn) } : null;
    const result = { session, pricing: model?.sats_pricing || null, image, checkedAt: Date.now(), canGenerate: false };
    if (!session.key) return { ...result, state: "noKey" };
    if (funds.status === "rejected") return { ...result,
      state: funds.reason.status === 401 ? "invalidKey" : "unavailable", canGenerate: funds.reason.status !== 401 };
    const balance = funds.value?.balance, reserved = funds.value?.reserved ?? 0;
    if (balance === null || balance === undefined || !Number.isFinite(Number(balance)) || !Number.isFinite(Number(reserved))) {
      return { ...result, state: "unavailable", canGenerate: true };
    }
    const available = Math.max(0, Number(balance) - Number(reserved)) / 1000;
    if (available === 0) return { ...result, state: "insufficient", available };
    if (models.status === "fulfilled" && !model) return { ...result, state: "modelMissing", available };
    return { ...result, state: "ready", available, canGenerate: true };
  }

  async cashu(token, session = this.session()) {
    this.routstr(session);
    if (!/^cashu[AB]/.test(token.trim())) throw new Error("Paste a Cashu token from your wallet.");
    // Keep a recovery copy before redemption. If the connection drops after the
    // node receives it, the same token identifies the same balance on Routstr.
    const record = this.record(session.base); record.deposit = token.trim(); this.persist();
    const out = await this.request(session.key ? "/balance/topup" : "/balance/create", {
      session, body: session.key ? { cashu_token: token.trim() } : { initial_balance_token: token.trim() }, timeout: 120000,
    });
    if (!session.key) this.setKey(out.api_key, session.base);
    delete record.deposit; this.persist();
    return out;
  }

  async invoice(amount, session = this.session()) {
    this.routstr(session);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000) throw new Error("Enter a whole number of sats between 1 and 1,000,000.");
    this.persist();
    const out = await this.request("/v2/lightning/invoice", { session, body: { amount_sats: amount, purpose: session.key ? "topup" : "create" } });
    if (!out.invoice_id || !out.bolt11) throw new Error("The node did not return a Lightning invoice.");
    this.record(session.base).invoice = out; this.persist();
    return out;
  }
  async invoiceStatus(invoice, session = this.session()) {
    this.routstr(session);
    const out = await this.request(`/v2/lightning/invoice/${encodeURIComponent(invoice.invoice_id)}/status`, { session, publicRequest: true });
    if (out.status === "paid") {
      if (out.api_key) this.setKey(out.api_key, session.base);
      if (!this.record(session.base).key) throw new Error("Payment received, but the node has not returned your AI key yet. Check this payment again; do not pay twice.");
      delete this.record(session.base).invoice; this.persist();
    }
    return out;
  }
  /**
   * Take the unspent credit back.
   *
   * With a Lightning address the node pays it there and the whole thing is over.
   * Without one it hands back a Cashu token, which is correct and is also a long
   * string somebody has to know what to do with, so the address is offered first.
   */
  async refund(session = this.session(), lightningAddress = "") {
    this.routstr(session);
    const to = String(lightningAddress || "").trim();
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new Error("That does not look like a Lightning address. It looks like name@example.com.");
    }
    const result = await this.request("/balance/refund", {
      session, body: to ? { lightning_address: to } : {}, timeout: 120000,
    });
    this.record(session.base).refund = result; this.persist();
    return result;
  }

  /**
   * One picture, as the bytes the endpoint sent.
   *
   * A Routstr node is asked on its native image route first, because that is
   * the one that honours the frame's shape: the OpenAI route answers a square
   * whatever it is asked for, at several times the size. A node or model that
   * refuses the native request is asked again on the OpenAI route, which every
   * OpenAI-compatible endpoint has, and that one is all that is used with
   * somebody's own key. Only a refusal of the request's shape is retried: a
   * timeout may still have been billed, and asking again would pay twice.
   */
  async generateImage(prompt, { aspect = "1:1", signal, session = this.session(), timeout = 180000 } = {}) {
    if (!session.key) throw new Error("Add AI credit or enter your API key in AI settings first.");
    if (!session.imageModel) throw new Error("Choose a picture model in AI settings first.");
    const text = String(prompt || "").trim().slice(0, 1500);
    if (!text) throw new Error("Describe the picture first.");
    const id = session.base + " " + session.imageModel;
    if (session.mode === "routstr" && !this.native.has(id)) {
      try {
        const out = await this.request("/image/generate", { session, signal, timeout,
          body: { model: session.imageModel, prompt: text, aspect_ratio: aspect, format: "webp" } });
        const b64 = Array.isArray(out?.images) ? out.images[0] : null;
        if (typeof b64 === "string" && b64) return fromBase64(b64);
        this.native.add(id);
      } catch (e) {
        if (signal?.aborted || !shapeRefused(e)) throw e;
        this.native.add(id);
      }
    }
    const body = { model: session.imageModel, prompt: text, n: 1, response_format: "b64_json" };
    let out;
    try { out = await this.request("/images/generations", { session, signal, timeout, body }); }
    catch (e) {
      // Some endpoints always answer in base64 and refuse to be asked for it.
      if (signal?.aborted || !shapeRefused(e) || !/response_format/i.test(e.message)) throw e;
      delete body.response_format;
      out = await this.request("/images/generations", { session, signal, timeout, body });
    }
    const item = Array.isArray(out?.data) ? out.data[0] : null;
    if (typeof item?.b64_json === "string" && item.b64_json) return fromBase64(item.b64_json);
    if (typeof item?.url === "string" && /^(https:|data:)/i.test(item.url)) {
      if (item.url.startsWith("data:")) return fromBase64(item.url);
      let response;
      try { response = await fetch(item.url, { credentials: "omit", signal }); }
      catch { throw new Error("The picture was made, but this browser could not download it from the address the endpoint gave."); }
      if (!response.ok) throw new Error(`The picture could not be downloaded (HTTP ${response.status}).`);
      return await response.blob();
    }
    throw new Error("The AI endpoint returned no picture.");
  }

  // Two watchdogs rather than one clock on the answer. A page built from a whole
  // template can legitimately take minutes, and a reasoning model spends the
  // first of them saying nothing the page will ever show; neither is a fault, and
  // a single deadline kills both. What is broken is silence, so `firstReply`
  // waits for the stream to start and `stall` waits for it to keep coming.
  async complete(messages, { signal, onProgress = () => {}, maxTokens = 12000, session = this.session(),
                             firstReply = 45000, stall = 90000 } = {}) {
    if (!session.key) throw new Error("Add AI credit or enter your API key in AI settings first.");
    const quiet = new AbortController();
    let timer, stalled = false;
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; quiet.abort(); }, stall);
    };
    const watched = signal ? AbortSignal.any([signal, quiet.signal]) : quiet.signal;
    try {
      // Ask for plenty of room and come down if the endpoint says that is more
      // than it allows. Models differ by two orders of magnitude in how much
      // they will write, a request that asks for more than the limit is refused
      // outright rather than trimmed, and there is no way to know a stranger's
      // limit without asking. Nothing is spent on a refusal, and only what is
      // written is ever billed, so the cost of starting high is zero.
      let last;
      for (const cap of ladder(maxTokens)) {
        try {
          return await this._stream(messages, { session, maxTokens: cap, onProgress, signal, watched, firstReply, alive });
        } catch (e) {
          if (signal?.aborted || stalled || !overLimit(e)) throw e;
          last = e;
        }
      }
      throw last;
    } catch (e) {
      if (stalled && !signal?.aborted) {
        throw new Error("The AI endpoint stopped sending part-way through. Your page has not changed. Try again.");
      }
      throw e;
    } finally { clearTimeout(timer); }
  }

  async _stream(messages, { session, maxTokens, onProgress, signal, watched, firstReply, alive }) {
    const response = await this.request("/chat/completions", { session, signal: watched, raw: true, timeout: firstReply,
      body: { model: session.model, messages, max_tokens: maxTokens, stream: true } });
    let text = "", thinking = 0, finish = null;
    const consume = (part) => {
      if (part.error) throw new Error(part.error.message || "The AI request failed.");
      const choice = part.choices?.find((c) => c.index === 0) || part.choices?.[0];
      if (!choice) return;
      if (choice.delta?.refusal || choice.message?.refusal) throw new Error("The model declined this request.");
      const fragment = choice.delta?.content ?? choice.message?.content ?? "";
      if (typeof fragment === "string") text += fragment;
      // A reasoning model spends its first minute here, writing nothing the page will
      // ever show. The words are none of the page's business and are dropped, but
      // their arrival is the only sign of life there is, and a counter frozen at 0
      // for a minute looks exactly like a counter that is broken.
      const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning
        ?? choice.message?.reasoning_content ?? "";
      if (typeof reasoning === "string") thinking += reasoning.length;
      if (text.length > 1000000) throw new Error("The generated page is too large. Ask for a smaller page.");
      if (choice.finish_reason) finish = choice.finish_reason;
      onProgress(text, { thinking });
    };
    alive();
    if ((response.headers.get("content-type") || "").includes("application/json")) consume(await response.json());
    else {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", ended = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          alive();
          buffer += decoder.decode(value, { stream: !done });
          if (buffer.length > 2000000) throw new Error("The AI endpoint returned an oversized stream event.");
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const event = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (data === "[DONE]") { ended = true; break; }
            if (data) consume(JSON.parse(data));
          }
          if (done || ended) break;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    // Say which of these happened. They used to share one sentence, and its
    // advice, "try a smaller change", is right for exactly one of them: a
    // filtered reply is not too long, and a cut-off stream is not the person's
    // fault at all. Somebody told to ask for less when the cap is the problem
    // asks for less and hits the same cap.
    // The fact, and no advice. What to do about a reply that ran out of room
    // depends entirely on what was being asked for, and only the caller knows:
    // "change one part instead of all of it" is good counsel for a rewrite and
    // nonsense for a page that does not exist yet. `reason` is what they match
    // on, since a message is for reading.
    if (finish === "length") {
      throw Object.assign(
        new Error(`The model ran out of room ${(text.length / 1000).toFixed(1)}k characters in, before it finished. Nothing has changed.`),
        { reason: "length" });
    }
    if (finish === "content_filter") {
      throw Object.assign(new Error("The model's provider blocked this reply. Nothing has changed."), { reason: "filtered" });
    }
    if (finish && finish !== "stop") {
      throw Object.assign(new Error(`The model stopped early (${finish}). Nothing has changed.`), { reason: finish });
    }
    if (!text.trim()) {
      throw Object.assign(new Error("The model sent nothing back. Nothing has changed. Try again."), { reason: "empty" });
    }
    if (finish !== "stop") {
      throw Object.assign(new Error("The reply ended without finishing. Nothing has changed. Try again."), { reason: "cut" });
    }
    return text.trim();
  }
}
