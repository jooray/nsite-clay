import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { mockAiAccount } from "./ai-account-fixture.mjs";
import { AiClient, estimateAiCost } from "../src/ai-client.js";
import { AiDrafts } from "../src/ai-drafts.js";

const client = new AiClient({ getItem: () => null, setItem() {} });
client.configure({ ...client.config, key: "test" });
client.models = async () => [{ id: client.config.model, sats_pricing: { prompt: .001, completion: .002 } }];
client.balance = async () => ({ balance: 5000, reserved: 2000 });
assert.equal((await client.check()).available, 3);
client.balance = async () => ({ balance: 0 });
assert.equal((await client.check()).state, "insufficient");
client.balance = async () => { throw Object.assign(new Error("rejected"), { status: 401 }); };
assert.equal((await client.check()).state, "invalidKey");
client.balance = async () => { throw new Error("offline"); };
assert.equal((await client.check()).state, "unavailable");
assert.equal((await client.check({ ...client.session(), mode: "byok" })).state, "configured");
assert.equal((await client.check({ ...client.session(), key: "" })).canGenerate, false);
assert(estimateAiCost({ prompt: .001, completion: .002 }, 600, "page").high > 50);
assert.equal(estimateAiCost(null), null);

const storage = new Map();
const store = { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
const owner = { pubkey: "alice", cfg: { path: "/one.html" } };
const drafts = new AiDrafts(owner, store);
drafts.write("edit", { prompt: "Keep this", versions: [] });
assert.equal(new AiDrafts(owner, store).read("edit").prompt, "Keep this");
owner.pubkey = "bob"; assert.equal(drafts.read("edit"), null);
owner.pubkey = "alice"; owner.cfg.path = "/two.html"; assert.equal(drafts.read("edit"), null);
owner.cfg.path = "/one.html";
assert.equal(drafts.import("edit", '{"schema":1,"prompt":"x","versions":[{}]}'), false);
const full = new AiDrafts(owner, { getItem() {}, setItem() { throw new Error("full"); } });
assert.equal(full.write("edit", { prompt: "survives in memory", versions: [] }), false);
assert.equal(full.read("edit").prompt, "survives in memory");

const NSEC = "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y";
const NPUB = "npub16kwfcualkq4kz6vgs8tze0j4jkpgs53h48ghmpnj80s7cvfjspwsh4uk9u";
const documentHTML = `<!doctype html><html lang="en" nc:owner="${NPUB}" nc:path="/index.html" nc:source="/nsite-clay-source.js" nc:upgrade="off"><head><title>Workshop</title><style>body{font-family:system-ui;margin:2rem}</style></head><body><main><h1 editable="single-line">Original workshop</h1><p editable>Saturday at 10.</p></main><script src="/nsite-clay.js"></script></body></html>`;
const output = (text) => `<!DOCTYPE html><html><head><title>Workshop</title><style>body{font-family:system-ui;margin:2rem}</style></head><body><main><h1>${text}</h1><p>Saturday at 10.</p></main></body></html>`;
const server = createServer((req, res) => {
  if (req.url === "/" || req.url.startsWith("/index.html")) { res.setHeader("Content-Type", "text/html"); return res.end(documentHTML); }
  const file = { "/nsite-clay.js": "dist/nsite-clay.js", "/nsite-clay-source.js": "dist/nsite-clay-source.js", "/nsite-clay-base.css": "templates/_shared/nsite-clay-base.css" }[req.url];
  if (!file) { res.writeHead(404); return res.end(); }
  res.setHeader("Content-Type", file.endsWith("css") ? "text/css" : "text/javascript"); res.end(readFileSync(file));
}).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.routeWebSocket("**", (ws) => ws.close());
  const account = { balance: 0 }; await mockAiAccount(page, account);
  await page.goto(`http://127.0.0.1:${server.address().port}/#edit`);
  const setup = async () => page.evaluate(async (nsec) => {
    await nc.ready;
    nc.vault = { usable: true, load: async () => ({}), save: async () => false };
    await nc.login("nsec", { key: nsec });
    nc.ai.client.configure({ mode: "routstr", base: "https://routstr.cypherpunk.today/v1", model: "deepseek-v4-1-flash", key: "fixture" });
  }, NSEC);
  await setup();

  // Complete profile restoration, including a BYOK endpoint that has no /v1.
  const restored = await page.evaluate(async () => {
    let data = {};
    nc.vault = { usable: true, load: async () => data, save: async (patch) => { data = { ...data, ...patch }; return true; } };
    const custom = { mode: "byok", base: "https://provider.example/api", model: "custom-model", key: "custom-key" };
    nc.ai.client.configure(custom); await nc.ai.keepOnRelays();
    nc.ai.client.configure({ mode: "routstr", base: "https://routstr.cypherpunk.today/v1", model: "deepseek-v4-1-flash", key: "" });
    const found = await nc.ai.adopt({ force: true });
    return { found, config: nc.ai.client.session(), data };
  });
  assert.equal(restored.found, true);
  assert.deepEqual(restored.config, { mode: "byok", base: "https://provider.example/api", model: "custom-model", key: "custom-key" });
  assert.equal(restored.data.aiProfiles[restored.config.base].mode, "byok");
  assert.equal(restored.data.ai[restored.config.base], "custom-key", "legacy readers retain their endpoint-bound key");
  const fresh = await browser.newPage(); await fresh.routeWebSocket("**", (ws) => ws.close());
  await fresh.goto(`http://127.0.0.1:${server.address().port}/#edit`);
  const automatic = await fresh.evaluate(async ({ data, nsec }) => {
    await nc.ready;
    nc.vault = { usable: true, load: async () => data };
    await nc.login("nsec", { key: nsec }); await nc.ai.adopt();
    return nc.ai.client.session();
  }, { data: restored.data, nsec: NSEC });
  assert.deepEqual(automatic, restored.config, "a fresh browser restores provider mode, endpoint and model automatically");
  await fresh.close();
  await setup();

  // Buying credit is amount + payment method, not a provider configuration form.
  await page.evaluate(() => { nc.ai.addCredit(); });
  await page.getByRole("heading", { name: "Add AI credit", exact: true }).waitFor();
  assert.equal(await page.getByLabel("API base URL").count(), 0);
  assert.equal(await page.getByLabel("Model ID").count(), 0);
  await page.getByLabel("Payment method").selectOption("cashu");
  await page.getByLabel("Cashu token", { exact: true }).fill("cashuA-test");
  await page.route("https://routstr.cypherpunk.today/v1/balance/topup", (route) => {
    account.balance = 100000;
    return route.fulfill({ contentType: "application/json", body: '{"msats":100000}' });
  });
  await page.getByRole("button", { name: "Add Cashu credit", exact: true }).click();
  await page.getByRole("button", { name: "Done, return to my page" }).waitFor();
  assert.match(await page.locator(".nc-status").innerText(), /Credit added.*relay backup failed/);
  assert(await page.getByRole("button", { name: "Download a copy instead" }).isVisible());
  await page.getByRole("button", { name: "Done, return to my page" }).click();

  // Zero credit blocks generation before inference; refilling enables it.
  account.balance = 0;
  await page.evaluate(() => { nc.ai.edit(null); });
  await page.getByText("No spendable AI credit. Add credit before generating.").waitFor();
  assert(await page.getByRole("button", { name: "Generate preview" }).isDisabled());
  account.balance = 100000;
  await page.getByRole("button", { name: "Check balance" }).click();
  await page.getByRole("button", { name: "Generate preview" }).waitFor();
  await page.route("https://routstr.cypherpunk.today/v1/chat/completions", (route) => route.fulfill({ contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output("First proposal") }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` }));
  await page.getByLabel("What should change?").fill("Shorten the headline");
  await page.getByRole("button", { name: "Generate preview" }).click();
  await page.locator(".nc-ui iframe").waitFor();
  await page.getByRole("button", { name: "Show current page" }).click();
  assert.match(await page.locator(".nc-ui iframe").getAttribute("srcdoc"), /Original workshop/);
  assert(await page.getByRole("button", { name: "Keep this change" }).isDisabled());
  await page.getByRole("button", { name: "Show proposed version" }).click();
  let sent;
  await page.route("https://routstr.cypherpunk.today/v1/chat/completions", (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output("Refined proposal") }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
  });
  await page.getByLabel("What should change in this preview?").fill("Make this proposal warmer");
  await page.getByRole("button", { name: "Refine this version" }).click();
  await page.waitForFunction(() => document.querySelector(".nc-ui iframe")?.srcdoc.includes("Refined proposal"));
  assert(sent.messages[1].content.includes("First proposal"), "refinement must start from the proposed page");
  assert.equal(await page.locator(".nc-ui select option").count(), 2);
  await page.getByLabel("Proposed version").selectOption("1");
  assert.match(await page.locator(".nc-ui iframe").getAttribute("srcdoc"), /First proposal/);
  await page.getByLabel("Proposed version").selectOption("2");
  await page.reload(); await setup();
  await page.evaluate(() => { nc.ai.edit(null); });
  await page.locator(".nc-ui iframe").waitFor();
  assert.match(await page.locator(".nc-ui iframe").getAttribute("srcdoc"), /Refined proposal/);
  await page.getByRole("button", { name: "Keep this change" }).click();
  await page.getByRole("heading", { name: "Refined proposal", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => nc.ai.drafts.read("edit")), null);
  assert.deepEqual(errors, []);
  console.log("AI workflows: complete provider restore, focused credit, backup warning, readiness, preview refinement/history, and reload recovery passed.");
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
