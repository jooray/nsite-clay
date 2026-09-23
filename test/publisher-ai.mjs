import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";

// What a model actually sends: a sentence about itself, a fence, then the page.
const preamble = 'Here is a complete static HTML page for the workshop. It covers opening hours and contact details.\n```html\n';
const html = '<!DOCTYPE html><html nc:owner="wrong" nc:path="/wrong" nc:ai-key="secret"><head><title>Bike workshop</title><style>body{font-family:system-ui;margin:2rem}main{max-width:60rem}h1{color:#345}</style></head><body><main><section><h1>A bike workshop</h1><p>Bring your bike on Saturday.</p><table><caption>Opening hours</caption><tr><th>Saturday</th><td>10 to 16</td></tr></table><img nc:crop="16:9" alt="The workshop bench on a Saturday"><ul><li>Bring your own spare parts</li></ul><a href="javascript:alert(1)">Bad link</a></section></main><script>window.bad=true</script></body></html>';
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
  // The second English pass exercises the refine path: a preview that is almost
  // right, changed by saying what is wrong with it rather than describing the
  // whole page again.
  for (const [lang, refine] of [["en", false], ["en", true], ["es", false], ["sk", false], ["cs", false]]) {
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
    // Describing the page is a route of its own now, not something to unfold, so
    // it has to be on screen the moment this step is.
    assert(await page.isVisible("#ai-builder"), "the AI builder is not visible without being opened");
    assert.equal(await page.textContent("#ai-builder h3"), { en: "Describe it, and AI builds it", es: "Descríbela y la IA la construye", sk: "Opíš ju a AI ju postaví", cs: "Popiš ji a AI ji postaví" }[lang]);
    // Two routes, each with its own heading, so neither explanation can be read
    // as the other's. The templates are the second one and say so above the grid.
    assert.equal(await page.locator("#step-2 .route h3, .step[data-step=\"2\"] .route h3").count(), 2);
    // And the box says what a good description looks like, in the reader's language.
    const placeholder = await page.getAttribute("#ai-description", "placeholder");
    assert(placeholder && placeholder.length > 80, `placeholder is ${JSON.stringify(placeholder)}`);
    assert.equal(/coffee shop|cafeter|kaviare|kav\u00e1rnu/.test(placeholder), true,
      `placeholder not translated for ${lang}: ${placeholder.slice(0, 60)}`);
    await page.fill("#ai-description", "A page for a community bike workshop. Use the supplied Saturday information.");
    await page.click("#ai-generate");
    await page.waitForSelector("#ai-result:not([hidden])");
    assert.equal(await page.evaluate(() => window.published), undefined);
    assert.equal(requests.at(-1).model, "deepseek-v4-1-flash");
    // Nothing about a description predicts how long the page will be, so
    // generating asks for the ceiling; the client comes down if an endpoint
    // says that is more than it allows.
    assert.equal(requests.at(-1).max_tokens, 96000, `max_tokens is ${requests.at(-1).max_tokens}`);
    assert.equal(requests.at(-1).messages[1].content.includes("Starting page"), false);
    assert(!JSON.stringify(requests.at(-1)).includes("sk-browser-test"));
    // Nobody needs to know who is publishing in order to adapt a design, and the
    // footer only promises the description and the template.
    const identities = await page.evaluate(() => [nc.npub, nc.pubkey].filter(Boolean));
    for (const id of identities) assert(!JSON.stringify(requests.at(-1)).includes(id), `the prompt carried ${id}`);
    assert.equal(await page.getAttribute("#ai-preview", "sandbox"), "");
    // What to do with a preview you do not like. Both answers are on screen:
    // change the description, or say what is wrong with the page itself.
    assert(await page.isVisible("#ai-again"), "there is no way back to the description");
    assert(await page.isVisible("#ai-refine"), "there is no way to ask for a change");
    if (refine) {
      const asked = requests.length;
      await page.fill("#ai-change", "Put the opening hours at the top.");
      await page.click("#ai-refine");
      await page.waitForFunction(() => document.querySelector("#ai-change").value === "");
      assert.equal(requests.length, asked + 1, "the change was not sent");
      const sent = requests.at(-1).messages[1].content;
      assert(sent.includes("Put the opening hours at the top."), "the instruction was not sent");
      assert(sent.includes("A bike workshop"), "the page being changed was not sent with it");
      // The page it is rewriting is what sizes the answer it is allowed to give.
      assert(requests.at(-1).max_tokens >= 32000, `max_tokens is ${requests.at(-1).max_tokens}`);
      assert(!/sk-browser-test/.test(JSON.stringify(requests.at(-1))));
    }
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
        pictures: [...doc.querySelectorAll("img")].map((el) => [el.id, el.getAttribute("alt"), el.hasAttribute("src")]),
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
    // A picture the model asked for and has no file for. It has to be changeable
    // from the content form, or the owner has a hole in their page and no way to
    // fill it; and it must not be pointed at somebody else's server.
    const shown = result.pictures.filter(([, , src]) => !src);
    assert(shown.length >= 1, "the generated page lost its picture");
    for (const [id, alt] of shown) {
      assert(id, "a picture has no id, so no rule can name it");
      assert(alt, "a picture has no description of what belongs there");
      assert(result.rules.some((r) => r === `#${id}@src`), `${id} has no picture field in the content form`);
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
  // A stylesheet is the whole of a page's design, so what happens to it has to be
  // deliberate. A curly quote written as an escape is not an attempt to fetch
  // anything and has to survive; a stylesheet that reaches off the page must
  // not; and a page that arrives with no design at all must not reach a relay
  // quietly, whether the model never wrote one or the scrub took it away.
  {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.routeWebSocket("**", (ws) => ws.close());
    await page.goto(`http://127.0.0.1:${server.address().port}/deploy.html`);
    const styling = await page.evaluate(async () => {
      await nc.ready;
      const document_ = (head) => `<!DOCTYPE html><html><head><title>A bike workshop</title>${head}</head><body><main nc:blocks><section><h1>A bike workshop</h1><p>Bring your bike on Saturday.</p></section></main></body></html>`;
      const prepare = (head) => {
        try {
          const out = nc.ai.preparePage(document_(head), { owner: "npub1test", path: "/index.html" });
          const doc = new DOMParser().parseFromString(out, "text/html");
          return { kept: [...doc.querySelectorAll("style")].some((el) => el.textContent.trim()) };
        } catch (e) { return { threw: e.message }; }
      };
      return {
        glyph: prepare('<style>body{margin:2rem}blockquote::before{content:"\\201C"}</style>'),
        selector: prepare('<style>body{margin:2rem}html[nc\\:editing] .x{display:none}</style>'),
        reaches: prepare('<style>body{margin:2rem;background:url("https://example.invalid/x.png")}</style>'),
        none: prepare(""),
      };
    });
    // The bug this is here for: one escaped character used to take the whole
    // stylesheet with it, and the page published as unstyled text.
    assert.equal(styling.glyph.kept, true, `an escaped glyph cost the page its stylesheet: ${JSON.stringify(styling.glyph)}`);
    assert.equal(styling.selector.kept, true, `an escaped selector cost the page its stylesheet: ${JSON.stringify(styling.selector)}`);
    // Still local. A page that fetches from somebody else's server is not a page
    // you own, so the stylesheet goes and the page is refused rather than served
    // with a hole in it.
    assert(styling.reaches.threw, `a stylesheet reaching off the page was allowed: ${JSON.stringify(styling.reaches)}`);
    assert(styling.none.threw, "a page with no stylesheet was prepared as if it were finished");
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("Publisher AI: describing and refining preview before publishing, preserve ownership/path, and ship all editable runtime assets.");
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
