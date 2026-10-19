// Pictures made by AI for a page built in the publisher, and for one frame from
// the picture dialog. The node is mocked: nothing here spends anything.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const NSEC = "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y";
const NODE = "https://routstr.cypherpunk.today/v1";
const QWEN = { id: "qwen-image-2-1-turbo", enabled: true, architecture: { output_modalities: ["image"] },
  sats_pricing: { image_output: 24.33 }, image_pricing: { max_usd: 0.02, tiers: [{ resolution: "1K", usd: 0.02 }], default_resolution: "1K" } };
const TEXT = { id: "deepseek-v4-1-flash-1017", sats_pricing: { prompt: .000439, completion: .001756 } };
const PAGE = '<!DOCTYPE html><html><head><title>Bike workshop</title><style>body{font-family:system-ui;margin:2rem}img{width:100%}</style></head><body><main><section><h1>A bike workshop</h1><p>Bring your bike on Saturday.</p><img nc:crop="16:9" alt="The workshop bench" nc:prompt="A wooden workshop bench with bicycle tools, warm morning light"><img nc:crop="1:1" alt="A pump"></section></main></body></html>';

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = path === "/nsite-clay.js" ? "dist/nsite-clay.js" : path === "/nsite-clay-base.css" ? "templates/_shared/nsite-clay-base.css" : join("site", path);
  try { const data = readFileSync(file); res.writeHead(200, { "Content-Type": { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream" }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "chrome" });
const errors = [];

// A square PNG of a couple of hundred kilobytes, as the OpenAI route answers.
const scratch = await browser.newPage();
const PNG = await scratch.evaluate(() => {
  const c = document.createElement("canvas"); c.width = 900; c.height = 900;
  const x = c.getContext("2d");
  for (let i = 0; i < 900; i += 30) { x.fillStyle = `hsl(${i % 360},60%,50%)`; x.fillRect(i, 0, 30, 900); }
  return c.toDataURL("image/png").split(",")[1];
});
await scratch.close();

async function open({ balance = 1000000, models = [TEXT, QWEN], native = "ok" } = {}) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.routeWebSocket("**", (ws) => ws.close());
  const seen = { chat: [], native: [], openai: [] };
  await page.route(`${NODE}/models`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ data: models }) }));
  await page.route(`${NODE}/balance/info`, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ balance, reserved: 0 }) }));
  await page.route(`${NODE}/chat/completions`, (r) => {
    seen.chat.push(r.request().postDataJSON());
    r.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: PAGE }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
  });
  await page.route(`${NODE}/image/generate`, (r) => {
    seen.native.push(r.request().postDataJSON());
    if (native === "refuse") return r.fulfill({ status: 400, contentType: "application/json", body: '{"error":{"message":"aspect_ratio is not supported"}}' });
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ images: [PNG] }) });
  });
  await page.route(`${NODE}/images/generations`, (r) => {
    seen.openai.push(r.request().postDataJSON());
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }) });
  });
  await page.goto(`${origin}/deploy.html`);
  await page.evaluate(async () => {
    await nc.ready;
    nc.manifestOf = async () => null;
    nc.ai.client.configure({ ...nc.ai.client.config, key: "sk-browser-test" });
    nc.publishFiles = async (files) => {
      window.published = files.map((f) => ({ path: f.path, type: f.type, size: f.bytes.length,
        text: f.type === "text/html" ? new TextDecoder().decode(f.bytes) : "" }));
      return {};
    };
  });
  await page.click("#way-key");
  await page.fill("#key", NSEC);
  await page.click("#key-go");
  await page.waitForSelector("#tpls .tpl");
  return { page, seen };
}

const ready = (page, text) => page.waitForFunction((t) => document.querySelector("#ai-status").textContent === t &&
  document.querySelector("#ai-cancel").hidden, text, { timeout: 20000 });
const generate = async (page) => {
  await page.waitForFunction(() => !document.querySelector("#ai-generate").disabled, null, { timeout: 15000 });
  await page.fill("#ai-description", "A page for a community bike workshop, with a photo of the bench.");
  await page.click("#ai-generate");
  await ready(page, "The preview is ready.");
};

try {
  // ---- hosted, default settings: it just works --------------------------
  {
    const { page, seen } = await open();
    await page.waitForFunction(() => /about 24\.33 sats each/.test(document.querySelector("#ai-readiness").textContent), null, { timeout: 15000 });
    await generate(page);
    const system = seen.chat.at(-1).messages[0].content;
    assert(system.includes("nc:prompt") && system.includes("at most 4"), "the model was not asked to describe its pictures");
    assert.equal(seen.native.length, 2, `asked for ${seen.native.length} pictures`);
    assert.deepEqual(seen.native.map((b) => b.aspect_ratio).sort(), ["16:9", "1:1"]);
    for (const b of seen.native) assert.equal(b.model, "qwen-image-2-1-turbo"), assert.equal(b.format, "webp");
    assert(seen.native.some((b) => b.prompt.startsWith("A wooden workshop bench")), "nc:prompt was not the picture's prompt");
    assert(seen.native.some((b) => b.prompt === "A pump"), "alt was not the fallback prompt");
    assert.equal(seen.openai.length, 0);
    const preview = await page.getAttribute("#ai-preview", "srcdoc");
    assert.equal((preview.match(/src="data:image\/webp/g) || []).length, 2, "the preview does not show the pictures");
    // The draft names the pictures; it does not carry them.
    const draft = await page.evaluate(() => nc.ai.drafts.read("builder").versions.at(-1).html);
    const names = [...draft.matchAll(/src="(images\/[0-9a-f]{64}\.webp)"/g)].map((m) => m[1]);
    assert.equal(names.length, 2, "the draft does not name both pictures");
    assert(draft.length < 20000, `the draft carries the pictures: ${draft.length}`);
    // Cut to the frame, re-encoded, and small.
    const shapes = await page.evaluate(async (names) => Promise.all(names.map(async (n) => {
      const blob = await nc.ai.images.get(n); const b = await createImageBitmap(blob);
      return { ratio: b.width / b.height, width: b.width, size: blob.size, type: blob.type };
    })), names);
    for (const s of shapes) {
      assert.equal(s.type, "image/webp");
      assert(s.width <= 1200, `width ${s.width}`);
      assert(s.size < 200000, `size ${s.size}`);
    }
    assert(shapes.some((s) => Math.abs(s.ratio - 16 / 9) < 0.02), JSON.stringify(shapes));
    assert(shapes.some((s) => Math.abs(s.ratio - 1) < 0.02), JSON.stringify(shapes));

    // A reload loses nothing that was paid for.
    await page.reload();
    await page.evaluate(async () => {
      await nc.ready; nc.manifestOf = async () => null;
      nc.ai.client.configure({ ...nc.ai.client.config, key: "sk-browser-test" });
      nc.publishFiles = async (files) => {
        window.published = files.map((f) => ({ path: f.path, type: f.type, size: f.bytes.length,
          text: f.type === "text/html" ? new TextDecoder().decode(f.bytes) : "" }));
        return {};
      };
    });
    await page.click("#way-key"); await page.fill("#key", NSEC); await page.click("#key-go");
    await page.waitForFunction(() => (document.querySelector("#ai-preview").getAttribute("srcdoc") || "").split('src="data:image/webp').length === 3,
      null, { timeout: 15000 });

    // Published next to the page, under the names the page uses.
    await page.click("#ai-use");
    await page.fill("#path", "/workshop/");
    await page.click("#where-go");
    await page.waitForSelector("#done-card:not([hidden])");
    const files = await page.evaluate(() => window.published);
    const html = files.find((f) => f.path === "/workshop/index.html").text;
    for (const n of names) {
      assert(html.includes(`src="${n}"`), `the page does not name ${n}`);
      const f = files.find((x) => x.path === "/workshop/" + n);
      assert(f && f.type === "image/webp" && f.size > 0, `${n} was not published`);
    }
    assert(!/data:image/.test(html), "a picture was inlined into the published page");
    await page.close();
  }

  // ---- a model the native route refuses: the OpenAI route, cropped -------
  {
    const { page, seen } = await open({ native: "refuse" });
    await generate(page);
    // Two pictures go out at once, so both may meet the refusal; none after it.
    assert(seen.native.length <= 2, "the native route was asked again after refusing");
    assert.equal(seen.openai.length, 2);
    assert.equal(seen.openai[0].response_format, "b64_json");
    const ratios = await page.evaluate(async () => {
      const html = nc.ai.drafts.read("builder").versions.at(-1).html;
      const names = [...html.matchAll(/src="(images\/[0-9a-f]{64}\.(?:webp|jpg))"/g)].map((m) => m[1]);
      return Promise.all(names.map(async (n) => { const b = await createImageBitmap(await nc.ai.images.get(n)); return b.width / b.height; }));
    });
    assert(ratios.some((r) => Math.abs(r - 16 / 9) < 0.02), `a square was not cut to its frame: ${ratios}`);
    await page.close();
  }

  // ---- off, or not on offer, or not affordable: the page as it always was --
  for (const [name, options, setup] of [
    ["switched off", {}, (nc) => nc.ai.client.configure({ ...nc.ai.client.config, pictures: 0 })],
    ["not sold by the node", { models: [TEXT] }, null],
    ["not affordable", { balance: 200000 }, null],
  ]) {
    const { page, seen } = await open(options);
    if (setup) await page.evaluate(`(${setup})(nc)`);
    await generate(page);
    const system = seen.chat.at(-1).messages[0].content;
    assert(!system.includes("nc:prompt"), `${name}: the prompt changed`);
    assert.equal(seen.native.length + seen.openai.length, 0, `${name}: a picture was asked for`);
    await page.close();
  }

  // ---- one frame, from the picture dialog --------------------------------
  {
    const { page, seen } = await open();
    const uploaded = await page.evaluate(async () => {
      const img = document.createElement("img");
      img.setAttribute("nc:crop", "16:9"); img.setAttribute("alt", "A bench");
      img.setAttribute("nc:prompt", "A bench in the sun"); document.body.append(img);
      window.uploads = [];
      nc.media.upload = async (file) => {
        const b = await createImageBitmap(file);
        window.uploads.push({ type: file.type, ratio: b.width / b.height });
        return { url: "https://blossom.example/abc.webp", hash: "abc", type: file.type, size: file.size };
      };
      window.picked = nc.media.promptImage({ target: img });
      return true;
    });
    assert(uploaded);
    const dialog = page.locator("dialog.nc-ui").last();
    await dialog.getByText("Make it with AI").waitFor();
    assert.equal(await dialog.locator("textarea").first().inputValue(), "A bench in the sun");
    await dialog.getByText("Make it with AI").click();
    await page.waitForFunction(() => /Picture made and uploaded/.test([...document.querySelectorAll(".nc-status")].map((e) => e.textContent).join(" ")), null, { timeout: 15000 });
    const up = await page.evaluate(() => window.uploads);
    assert.equal(up.length, 1); assert.equal(up[0].type, "image/webp");
    assert(Math.abs(up[0].ratio - 16 / 9) < 0.02, `ratio ${up[0].ratio}`);
    assert.equal(seen.native.at(-1).aspect_ratio, "16:9");
    assert.equal(await dialog.locator('input[placeholder="https://…"]').inputValue(), "https://blossom.example/abc.webp");
    await page.close();
  }

  // ---- the settings: a picture model, its price, and how many ------------
  {
    const { page } = await open();
    await page.evaluate(() => { window.saved = nc.ai.settings(); });
    const dialog = page.locator("dialog.nc-ui").last();
    await dialog.locator("summary").first().click();
    const model = dialog.getByLabel("Picture model ID");
    assert.equal(await model.inputValue(), "qwen-image-2-1-turbo");
    assert.equal(await dialog.getByLabel("Pictures to make for a new page (0 turns them off)").inputValue(), "4");
    await dialog.locator('[data-nc-ai-btn="models"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll("dialog.nc-ui")].at(-1).querySelectorAll("datalist option").length === 2);
    assert.equal(await dialog.locator(".nc-ai-provider .nc-hint").filter({ hasText: "about 24.33 sats each" }).count(), 1, "the picture price is not shown");
    const listed = await dialog.evaluate((d) => [...d.querySelectorAll("datalist")].map((l) => [...l.options].map((o) => o.value)));
    assert.deepEqual(listed, [["deepseek-v4-1-flash-1017"], ["qwen-image-2-1-turbo"]], JSON.stringify(listed));
    // Our node's model means nothing to somebody else's endpoint.
    await dialog.locator("select").first().selectOption("byok");
    assert.equal(await model.inputValue(), "");
    await dialog.locator("select").first().selectOption("routstr");
    assert.equal(await model.inputValue(), "qwen-image-2-1-turbo");
    await dialog.getByLabel("Pictures to make for a new page (0 turns them off)").fill("2");
    await dialog.locator("button[type=submit]").click();
    await page.evaluate(() => window.saved);
    const config = await page.evaluate(() => nc.ai.client.config);
    assert.equal(config.pictures, 2); assert.equal(config.imageModel, "qwen-image-2-1-turbo");
    await page.close();
  }

  assert.deepEqual(errors, []);
  console.log("AI pictures: made for a new page on the native route or the OpenAI one, cut to their frames, kept across a reload, published as site files, and left alone when off, unsold or unaffordable; one frame from the picture dialog.");
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
