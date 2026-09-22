import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

// What a model actually sends: a sentence about itself, a fence, then the page.
const preamble = 'Here is a complete static HTML page for the workshop. It covers opening hours and contact details.\n```html\n';
const html = '<!DOCTYPE html><html nc:owner="wrong" nc:path="/wrong" nc:ai-key="secret"><head><title>Bike workshop</title><style>body{font-family:system-ui;margin:2rem}main{max-width:60rem}h1{color:#345}</style></head><body><main><section><h1>A bike workshop</h1><p>Bring your bike on Saturday.</p><table><caption>Opening hours</caption><tr><th>Saturday</th><td>10 to 16</td></tr></table><ul><li>Bring your own spare parts</li></ul><a href="javascript:alert(1)">Bad link</a></section></main><script>window.bad=true</script></body></html>';
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
      const reply = preamble + html + "\n```";
      return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
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
    // Nobody needs to know who is publishing in order to adapt a design, and the
    // footer only promises the description and the template.
    const identities = await page.evaluate(() => [nc.npub, nc.pubkey].filter(Boolean));
    for (const id of identities) assert(!JSON.stringify(requests.at(-1)).includes(id), `the prompt carried ${id}`);
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
        source: doc.documentElement.getAttribute("nc:source"),
        cells: [...doc.querySelectorAll("td,th,li,caption")].map((el) => [el.id, el.hasAttribute("editable")]),
        rules: Object.values(JSON.parse(doc.querySelector("script[nc\\:cms]")?.textContent || "{}")),
        runtime: [...doc.querySelectorAll("script[src],link[href]")].map((el) => el.getAttribute("src") || el.getAttribute("href")),
        headTitle: !!doc.querySelector("head > title"),
        bodyText: doc.body.textContent,
        paths: files.map((f) => f.path) };
    });
    assert.equal(result.path, "/workshop/index.html");
    assert.match(result.owner, /^npub1/);
    assert(result.editable && result.cms && result.blocks && result.toolbar);
    // A table of opening hours that the owner cannot change is worse than no
    // table, and the content form has to know about every word the page lets
    // them edit.
    assert(result.cells.length >= 4, "the generated page lost its table and list");
    for (const [id, editable] of result.cells) {
      assert(editable, "a table cell or list item with words in it is not editable");
      assert(result.rules.some((r) => r.startsWith(`#${id}`)), `${id} is editable but missing from the content form`);
    }
    assert(result.runtime.every((p) => result.paths.includes(p)));
    // The serialiser is fetched only when the page is edited, so it is named in an
    // attribute rather than loaded by a tag. It still has to be published with the
    // page, and it still has to be the stamped path, or the first save finds nothing.
    assert(result.source && result.paths.includes(result.source),
      `nc:source is ${result.source}, which was not published`);
    assert(/^\/nsite-clay-source-[0-9a-f]{8}\.js$/.test(result.source),
      `nc:source is not a stamped path: ${result.source}`);
    assert(!/window.bad|javascript:|nc:ai-key|sk-browser-test|nc:owner="wrong"/.test(result.html));
    // The model's own commentary is not the page's first paragraph, and the
    // document it wrapped in a fence still has its head.
    assert(!/Here is a complete|```/.test(result.html), "the model's preamble reached the page");
    assert(!result.bodyText.includes("Here is a complete"), "the preamble became page content");
    assert(result.headTitle, "<title> was pushed out of <head>");
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("Publisher AI: scratch and template flows preview before publishing, preserve ownership/path, and ship all editable runtime assets.");
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
