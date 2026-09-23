import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AiClient, AI_DEFAULTS } from "../src/ai-client.js";

const calls = [];
let finish = "stop", payment = "pending", split = false;
const server = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  calls.push({ url: req.url, auth: req.headers.authorization, body });
  res.setHeader("Content-Type", "application/json");
  if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: AI_DEFAULTS.model, enabled: true }] }));
  if (req.url.endsWith("/balance/create")) return res.end(JSON.stringify({ api_key: "sk-created", balance: 100000 }));
  if (req.url.endsWith("/balance/topup")) return res.end(JSON.stringify({ msats: 10000 }));
  if (req.url.endsWith("/balance/info")) return res.end(JSON.stringify({ balance: 100000, reserved: 0 }));
  if (req.url.endsWith("/balance/refund")) return res.end(JSON.stringify({ token: "cashuA-refund", sats: "100" }));
  if (req.url.endsWith("/lightning/invoice")) return res.end(JSON.stringify({ invoice_id: "invoice-1", bolt11: "lnbc1-test", amount_sats: body.amount_sats }));
  if (req.url.endsWith("/status")) return res.end(JSON.stringify({ status: payment, api_key: payment === "paid" ? "sk-paid" : null }));
  if (req.url.endsWith("/chat/completions")) {
    const ask = body.messages[0].content;
    if (ask === "payment-error") { res.statusCode = 402; return res.end("{}"); }
    // An endpoint that refuses anything above 16k, the way a small model does:
    // the request is rejected outright rather than trimmed to what it allows.
    if (ask === "small-model" && body.max_tokens > 16000) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: `max_tokens must be at most 16000, got ${body.max_tokens}` } }));
    }
    if (ask === "slow") { req.on("close", () => res.end()); return; }
    const chunk = (t, stop = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: t === null ? {} : { content: t }, finish_reason: stop }] })}\r\n\r\n`;
    // Headers and a first token, then the endpoint goes quiet for good.
    if (ask === "stall") {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(chunk("<p>half a"));
      req.on("close", () => res.end());
      return;
    }
    // Slow but never silent: longer in total than any one deadline would allow.
    // A reasoning model: a long silence on `content`, and reasoning all the while.
    if (ask === "thinky") {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "hmm ".repeat(25) }, finish_reason: null }] })}\r\n\r\n`);
      res.write(chunk("<p>done</p>"));
      res.write(chunk(null, "stop"));
      res.write("data: [DONE]\r\n\r\n");
      return res.end();
    }
    if (ask === "trickle") {
      res.setHeader("Content-Type", "text/event-stream");
      let n = 0;
      const tick = setInterval(() => {
        if (++n > 6) { clearInterval(tick); res.write(chunk(null, "stop")); res.write("data: [DONE]\r\n\r\n"); return res.end(); }
        res.write(chunk("tick "));
      }, 40);
      req.on("close", () => clearInterval(tick));
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    const content = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "<p>café</p>" }, finish_reason: null }] })}\r\n\r\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    if (split) { for (const byte of Buffer.from(content)) res.write(Buffer.from([byte])); }
    else res.write(content);
    return res.end();
  }
  res.statusCode = 404; res.end("{}");
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const stored = new Map();
const storage = { getItem: (k) => stored.get(k), setItem: (k, v) => stored.set(k, v) };
const client = new AiClient(storage);
try {
  assert.equal(client.config.base, AI_DEFAULTS.base);
  assert.equal(client.config.model, "deepseek-v4-1-flash");
  client.configure({ ...AI_DEFAULTS, base });
  assert.equal((await client.models())[0].id, AI_DEFAULTS.model);
  await client.cashu("cashuA-test-token");
  assert.equal(client.session().key, "sk-created");
  assert.deepEqual(calls.at(-1).body, { initial_balance_token: "cashuA-test-token" });
  assert(!calls.at(-1).url.includes("cashu"));
  await client.cashu("cashuB-topup-token");
  assert.equal(calls.at(-1).auth, "Bearer sk-created");
  assert.deepEqual(calls.at(-1).body, { cashu_token: "cashuB-topup-token" });
  const invoice = await client.invoice(100);
  assert.equal(calls.at(-1).body.purpose, "topup");
  assert.equal(new AiClient(storage).record().invoice.invoice_id, invoice.invoice_id);
  payment = "paid"; await client.invoiceStatus(invoice);
  assert.equal(client.session().key, "sk-paid");
  assert.equal(client.record().invoice, undefined);
  const session = client.session();
  client.configure({ mode: "routstr", base: "https://another.example", model: "other" });
  assert.equal(client.session().key, "");
  client.setKey("sk-other");
  await client.balance(session);
  assert.equal(calls.at(-1).auth, "Bearer sk-paid");
  assert.equal(client.session().key, "sk-other");
  client.configure({ ...AI_DEFAULTS, base });
  assert.equal(client.session().key, "sk-paid");
  split = true;
  assert.equal(await client.complete([{ role: "user", content: "hello" }]), "<p>café</p>");
  assert.equal(calls.at(-1).body.model, AI_DEFAULTS.model);
  // Each way a reply can end badly says which one it was. One sentence for all
  // of them told somebody whose page was cut off by the token cap to ask for
  // less, which gets them the same cap, and told somebody whose provider
  // blocked the reply the same thing, which is simply wrong.
  finish = "length";
  await assert.rejects(client.complete([{ role: "user", content: "hello" }]), /ran out of room/);
  // The fact, and no advice: what to do depends on what was being asked for,
  // and only the caller knows that. They match on `reason`, not on the words.
  await assert.rejects(client.complete([{ role: "user", content: "hello" }]), (e) => e.reason === "length");
  await assert.rejects(client.complete([{ role: "user", content: "hello" }]), (e) => !/smaller|fewer|simpler|one part/i.test(e.message));
  finish = "content_filter";
  await assert.rejects(client.complete([{ role: "user", content: "hello" }]), (e) => /blocked this reply/.test(e.message) && e.reason === "filtered");
  finish = "tool_calls";
  await assert.rejects(client.complete([{ role: "user", content: "hello" }]), /stopped early \(tool_calls\)/);
  finish = null;
  await assert.rejects(client.complete([{ role: "user", content: "hello" }]), /ended without finishing/);
  finish = "stop";
  // Models differ by two orders of magnitude in how much they will write, and a
  // request above the limit is refused rather than trimmed. So ask high and
  // come down, rather than asking low and cutting every long answer off.
  {
    const before = calls.length;
    assert.equal(await client.complete([{ role: "user", content: "small-model" }], { maxTokens: 96000 }), "<p>café</p>");
    const tried = calls.slice(before).map((c) => c.body.max_tokens);
    assert.deepEqual(tried, [96000, 32000, 16000], `tried ${tried}`);
  }
  const count = calls.length;
  await assert.rejects(client.complete([{ role: "user", content: "payment-error" }]), /credit is too low/);
  assert.equal(calls.length, count + 1, "paid requests must not retry automatically");
  await assert.rejects(client.complete([{ role: "user", content: "slow" }], { signal: AbortSignal.timeout(50) }));
  // A reply that never starts is late; one that starts and stops is stalled; one
  // that keeps coming is working, however long it takes in total.
  await assert.rejects(client.complete([{ role: "user", content: "slow" }], { firstReply: 60 }),
    /did not answer in time/);
  await assert.rejects(client.complete([{ role: "user", content: "stall" }], { firstReply: 500, stall: 120 }),
    /stopped sending part-way through/);
  const began = Date.now();
  const trickled = await client.complete([{ role: "user", content: "trickle" }], { firstReply: 500, stall: 120 });
  assert.equal(trickled, "tick tick tick tick tick tick", "a stream slower than one deadline must still finish");
  assert(Date.now() - began > 120, "the watchdog must measure the gaps, not the whole answer");
  // Cancelling mid-stream is the owner's doing and keeps its own name.
  const mine = new AbortController();
  setTimeout(() => mine.abort(), 80);
  await assert.rejects(client.complete([{ role: "user", content: "stall" }], { signal: mine.signal, firstReply: 500, stall: 5000 }),
    (e) => e.name === "AbortError" || /abort/i.test(e.message));
  // A counter frozen at zero while a reasoning model thinks looks like a broken one.
  const seen = [];
  assert.equal(await client.complete([{ role: "user", content: "thinky" }],
    { onProgress: (t, info) => seen.push([t.length, info?.thinking || 0]) }), "<p>done</p>");
  assert(seen.some(([text, thinking]) => text === 0 && thinking > 0),
    "reasoning must show progress before any page text exists");
  assert.equal(seen.at(-1)[0], "<p>done</p>".length, "and the text is still what is returned");

  const refund = await client.refund();
  assert.equal(refund.token, "cashuA-refund");
  assert.equal(new AiClient(storage).record().refund.token, refund.token);
  assert.throws(() => client.configure({ mode: "routstr", base: "http://public.example", model: "x" }), /HTTPS/);
  assert.throws(() => client.configure({ mode: "byok", base: "https://user:secret@example.com/v1", model: "x" }), /credentials/);
  console.log("AI client: defaults, endpoint-bound keys, Cashu, Lightning, refunds, streaming, start and stall watchdogs, cancellation and payment errors passed.");
} finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
