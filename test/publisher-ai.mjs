import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const html = '<!DOCTYPE html><html nc:owner="wrong" nc:path="/wrong" nc:ai-key="secret"><head><title>Bike workshop</title><style>body{font-family:system-ui;margin:2rem}main{max-width:60rem}h1{color:#345}</style></head><body><main><section><h1>A bike workshop</h1><p>Bring your bike on Saturday.</p><a href="javascript:alert(1)">Bad link</a></section></main><script>window.bad=true</script></body></html>';
const requests = [], errors = [];
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = path === "/nsite-clay.js" ? "dist/nsite-clay.js" : path === "/nsite-clay-base.css" ? "templates/_shared/nsite-clay-base.css" : join("site", path);
  try { const data = readFileSync(file); res.writeHead(200, { "Content-Type": { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream" }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const [lang, template] of [["en", ""], ["en", "cms"], ["es", ""], ["sk", ""], ["cs", ""]]) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.routeWebSocket("**", (ws) => ws.close());
    await page.route("https://routstr.cypherpunk.today/v1/chat/completions", (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: html }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/${lang === "en" ? "" : lang + "/"}deploy.html`);
    await page.evaluate(async () => {
      await nc.ready;
      nc.manifestOf = async () => null;
      nc.ai.client.configure({ ...nc.ai.client.config, key: "sk-browser-test" });
      nc.publishFiles = async (files) => {
        window.published = files.map((f) => ({ path: f.path, text: new TextDecoder().decode(f.bytes) }));
        return {};
      };
    });
    await page.click("#way-key");
    await page.fill("#key", "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y");
    await page.click("#key-go");
    await page.waitForSelector("#tpls .tpl");
    await page.click("#ai-builder summary");
    assert.equal(await page.textContent("#ai-builder summary"), { en: "Create a page from a description with AI", es: "Crea una página a partir de una descripción con IA", sk: "Vytvor stránku na základe opisu s pomocou AI", cs: "Vytvoř stránku podle popisu s pomocí AI" }[lang]);
    await page.selectOption("#ai-template", template);
    await page.fill("#ai-description", "A page for a community bike workshop. Use the supplied Saturday information.");
    await page.click("#ai-generate");
    await page.waitForSelector("#ai-result:not([hidden])");
    assert.equal(await page.evaluate(() => window.published), undefined);
    assert.equal(requests.at(-1).model, "deepseek-v4-1-flash");
    assert.equal(requests.at(-1).messages[1].content.includes("Starting page"), !!template);
    assert(!JSON.stringify(requests.at(-1)).includes("sk-browser-test"));
    assert.equal(await page.getAttribute("#ai-preview", "sandbox"), "");
    await page.click("#ai-use");
    await page.fill("#path", "/workshop/");
    await page.click("#where-go");
    await page.waitForSelector("#done-card:not([hidden])");
    const result = await page.evaluate(() => {
      const files = window.published;
      const html = files.find((f) => f.path === "/workshop/index.html").text;
      const doc = new DOMParser().parseFromString(html, "text/html");
      return { html, owner: doc.documentElement.getAttribute("nc:owner"), path: doc.documentElement.getAttribute("nc:path"),
        editable: doc.querySelector("h1").hasAttribute("editable"),
        cms: !!doc.querySelector("script[nc\\:cms]"), blocks: !!doc.querySelector("template[nc\\:block]"),
        toolbar: !!doc.querySelector("[data-nc-save]"),
        runtime: [...doc.querySelectorAll("script[src],link[href]")].map((el) => el.getAttribute("src") || el.getAttribute("href")),
        paths: files.map((f) => f.path) };
    });
    assert.equal(result.path, "/workshop/index.html");
    assert.match(result.owner, /^npub1/);
    assert(result.editable && result.cms && result.blocks && result.toolbar);
    assert(result.runtime.every((p) => result.paths.includes(p)));
    assert(!/window.bad|javascript:|nc:ai-key|sk-browser-test|nc:owner="wrong"/.test(result.html));
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("Publisher AI: scratch and template flows preview before publishing, preserve ownership/path, and ship all editable runtime assets.");
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
