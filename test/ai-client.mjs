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
    if (body.messages[0].content === "payment-error") { res.statusCode = 402; return res.end("{}"); }
    if (body.messages[0].content === "slow") { req.on("close", () => res.end()); return; }
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
  finish = "length";
  await assert.rejects(client.complete([{ role: "user", content: "hello" }]), /did not finish/);
  const count = calls.length;
  await assert.rejects(client.complete([{ role: "user", content: "payment-error" }]), /credit is too low/);
  assert.equal(calls.length, count + 1, "paid requests must not retry automatically");
  await assert.rejects(client.complete([{ role: "user", content: "slow" }], { signal: AbortSignal.timeout(50) }));
  const refund = await client.refund();
  assert.equal(refund.token, "cashuA-refund");
  assert.equal(new AiClient(storage).record().refund.token, refund.token);
  assert.throws(() => client.configure({ mode: "routstr", base: "http://public.example", model: "x" }), /HTTPS/);
  assert.throws(() => client.configure({ mode: "byok", base: "https://user:secret@example.com/v1", model: "x" }), /credentials/);
  console.log("AI client: defaults, endpoint-bound keys, Cashu, Lightning, refunds, streaming, cancellation and payment errors passed.");
} finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
