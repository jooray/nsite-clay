// Routstr is the payment service as well as the inference endpoint. There is no
// discovery or automatic failover here: the owner chooses who receives a request.
export const AI_DEFAULTS = Object.freeze({ mode: "routstr", base: "https://routstr.cypherpunk.today/v1", model: "deepseek-v4-1-flash" });
const STORAGE = "nsite-clay.ai";

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

export class AiClient {
  constructor(storage = null) {
    this.storage = storage;
    try { this.data = JSON.parse(storage?.getItem(STORAGE) || "{}"); } catch { this.data = {}; }
    if (!this.data || typeof this.data !== "object" || Array.isArray(this.data)) this.data = {};
    if (!this.data.nodes || typeof this.data.nodes !== "object" || Array.isArray(this.data.nodes)) this.data.nodes = {};
    try {
      const c = { ...AI_DEFAULTS, ...this.data.config };
      this.config = { mode: c.mode === "byok" ? "byok" : "routstr", base: aiEndpoint(c.base, c.mode), model: String(c.model) };
    } catch { this.config = { ...AI_DEFAULTS }; }
  }

  persist() {
    if (!this.storage) throw new Error("Browser storage is unavailable. Enable it before adding AI credit.");
    this.storage.setItem(STORAGE, JSON.stringify(this.data));
  }
  record(base = this.config.base) { return this.data.nodes[base] ||= {}; }
  session() { return { ...this.config, key: this.record().key || "" }; }
  configure({ mode, base, model, key } = {}) {
    const next = { mode: mode === "byok" ? "byok" : "routstr", base: aiEndpoint(base || AI_DEFAULTS.base, mode), model: String(model || "").trim() };
    if (!next.model) throw new Error("Choose a model or enter its model ID.");
    this.config = next; this.data.config = next;
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
        if (!session.key) message = "There is no key for this node yet. Add credit below and the node issues one.";
        throw new Error(message);
      }
      return raw ? response : await response.json();
    } finally {
      // For a stream this fires once the headers are in, which is the point: the
      // clock must not outlive the wait it was measuring and kill the body.
      clearTimeout(timer);
    }
  }

  async models(session = this.session()) {
    const data = await this.request("/models", { session, publicRequest: session.mode === "routstr" });
    if (!Array.isArray(data.data)) throw new Error("The endpoint did not return a model list. Enter the model ID manually.");
    return data.data.filter((m) => m.id && m.enabled !== false && (!m.architecture?.output_modalities || m.architecture.output_modalities.includes("text")));
  }
  routstr(session) { if (session.mode !== "routstr") throw new Error("Credit controls are available for Routstr nodes."); }
  balance(session = this.session()) { this.routstr(session); return this.request("/balance/info", { session }); }
  info(session = this.session()) { this.routstr(session); return this.request("/info", { session, publicRequest: true }); }

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
      delete this.record(session.base).invoice; this.persist();
    }
    return out;
  }
  async refund(session = this.session()) {
    this.routstr(session);
    const result = await this.request("/balance/refund", { session, body: {}, timeout: 120000 });
    this.record(session.base).refund = result; this.persist();
    return result;
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
      return await this._stream(messages, { session, maxTokens, onProgress, signal, watched, firstReply, alive });
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
    if (finish !== "stop" || !text.trim()) throw new Error("The model did not finish its reply. Your page has not changed. Try a smaller change.");
    return text.trim();
  }
}
