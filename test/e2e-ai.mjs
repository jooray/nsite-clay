// The whole path somebody actually walks: publish an AI-built page through the
// wizard, open the published page at its own address, and edit the whole page
// with AI there. Nothing here touches a public relay or real money.
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { localPorts } from "./local-ports.mjs";
import { mockAiAccount } from "./ai-account-fixture.mjs";

const NSEC = "nsec1064etpv2gs3ttywm7w5enrqdssdg6dawz9fxz0vs34ac545l6jfqk3987y";
const PAGE = '<!DOCTYPE html><html><head><title>Bike workshop</title><style>body{background:#fff;color:#111;font-family:system-ui;margin:2rem}h1{color:#345}</style></head><body><main nc:blocks><section><h1>A bike workshop</h1><p>Bring your bike on Saturday morning.</p></section></main></body></html>';
const NIGHT = '<!DOCTYPE html><html><head><title>Bike workshop by lamplight</title><style>body{background:#101014;color:#eee;font-family:system-ui;margin:2rem}h1{color:#9cf}</style></head><body><main nc:blocks><section><h1>A bike workshop</h1><p>Bring your bike on Saturday morning.</p></section><section><h2>Lamplight repairs</h2><p>We stay open after dark on the first Friday.</p></section></main></body></html>';
const DARK = '<!DOCTYPE html><html><head><title>Bike workshop at night</title><style>body{background:#101014;color:#eee;font-family:system-ui;margin:2rem}h1{color:#9cf}</style></head><body><main nc:blocks><section><h1>A bike workshop</h1><p>Bring your bike on Saturday morning.</p></section><section><h2>Where to find us</h2><p>Behind the old station, through the blue door.</p></section></main></body></html>';

const out = [];
const t = (name, pass, detail = "") => out.push([name, pass, detail]);

const [publisherPort, relayPort, blossomPort, gatewayPort] = await localPorts(4);
const stack = spawn("node", ["tools/publish-local.mjs"], { stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PUBLISH_LOCAL_PORT: publisherPort, DEVNET_RELAY_PORT: relayPort,
    DEVNET_BLOSSOM_PORT: blossomPort, DEVNET_GATEWAY_PORT: gatewayPort } });
let ready = false;
stack.stdout.on("data", (d) => { if (/publisher|gateway|http:\/\//i.test(String(d))) ready = true; });
stack.stderr.on("data", (d) => process.stderr.write(String(d).slice(0, 300)));
for (let i = 0; i < 80 && !ready; i++) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 2000));

const browser = await chromium.launch({ channel: "chrome" });
let published;
try {
  // ---- the wizard --------------------------------------------------------
  const wiz = await browser.newPage();
  await mockAiAccount(wiz);
  wiz.on("pageerror", (e) => t("pageerror(wizard)", false, e.message));
  let turn = 0;
  const reply = (route) => {
    const body = [PAGE, DARK, NIGHT][Math.min(turn++, 2)];
    route.fulfill({ contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: body }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
  };
  await wiz.route("https://routstr.cypherpunk.today/v1/chat/completions", reply);
  await wiz.goto(`http://127.0.0.1:${publisherPort}/deploy.html`);
  await wiz.evaluate(async () => {
    await nc.ready;
    nc.ai.client.configure({ ...nc.ai.client.config, key: "sk-local-e2e" });
  });
  await wiz.click("#way-key");
  await wiz.fill("#key", NSEC);
  await wiz.click("#key-go");
  await wiz.waitForSelector("#tpls .tpl");
  // What Simple setup does with the key it is given: it goes on the owner's own
  // relays, encrypted, because that is the only place the published page can
  // look for it later.
  await wiz.evaluate(async () => {
    await nc.vault.save({ ai: { [nc.ai.client.session().base]: "sk-local-e2e" } });
  });
  await wiz.fill("#ai-description", "A page for a community bike workshop, open on Saturday mornings.");
  await wiz.click("#ai-generate");
  await wiz.waitForSelector("#ai-result:not([hidden])", { timeout: 20000 });
  t("the wizard previews a page it was asked to build", await wiz.isVisible("#ai-preview"));
  t("and offers a way back to the description", await wiz.isVisible("#ai-again"));

  await wiz.fill("#ai-change", "Make it dark, and add a section saying where to find us.");
  await wiz.click("#ai-refine");
  await wiz.waitForFunction(() => document.querySelector("#ai-change").value === "", null, { timeout: 20000 });
  const refined = await wiz.evaluate(() => document.querySelector("#ai-preview").srcdoc);
  t("a change asked for on the preview lands in the preview",
    refined.includes("Where to find us") && refined.includes("#101014"));

  await wiz.click("#ai-use");
  await wiz.fill("#path", "/workshop/");
  await wiz.click("#where-go");
  await wiz.waitForSelector("#done-card:not([hidden])", { timeout: 60000 });
  // The wizard links to the public gateway; this stack has its own, serving the
  // same npub as a hostname exactly as a real one does.
  published = await wiz.evaluate(() => ({ npub: nc.npub }));
  published.link = `http://${published.npub}.localhost:${gatewayPort}/workshop/`;
  t("the page is published", !!published.npub, published.link);

  // A new key has no relay list, and most gateways find a site through one.
  // On a devnet the local relay is the whole world, so the list lands there.
  const relayList = await wiz.evaluate(async (relay) => {
    const ev = await nc.pool.get([relay], { kinds: [10002], authors: [nc.pubkey] });
    return { tags: ev?.tags || null, said: [...document.querySelectorAll("#log li")].map((li) => li.textContent).join(" | ") };
  }, `ws://127.0.0.1:${relayPort}`);
  t("a new key gets a relay list naming the relay it published to",
    JSON.stringify(relayList.tags) === JSON.stringify([["r", `ws://127.0.0.1:${relayPort}`]]), JSON.stringify(relayList.tags));
  t("and the log says so", /Published a relay list/.test(relayList.said), relayList.said.slice(-200));

  // ---- the published page ------------------------------------------------
  const live = await browser.newPage();
  await mockAiAccount(live);
  live.on("pageerror", (e) => t("pageerror(page)", false, e.message));
  const asked = [];
  await live.route("https://routstr.cypherpunk.today/v1/chat/completions", (route) => { asked.push(route.request().postDataJSON()); reply(route); });
  const url = published.link + "#edit";
  await live.goto(url);
  await live.evaluate(async () => { await nc.ready; });
  // A page built from nothing has no file to inherit these from, so the
  // publisher stamps them. Without them the page looks for its own manifest,
  // and for its owner's vault, on relays nobody published it to.
  const attrs = await live.evaluate(() => Object.fromEntries([...document.documentElement.attributes].map((a) => [a.name, a.value])));
  t("the published page names the relays it was published to", attrs["nc:relays"] === `ws://127.0.0.1:${relayPort}`,
    JSON.stringify(attrs).slice(0, 220));
  t("and the Blossom servers holding its bytes", attrs["nc:servers"] === `http://127.0.0.1:${blossomPort}`);
  const fresh = await live.evaluate(() => ({
    key: nc.ai.client.session().key,
    stored: window.localStorage.getItem("nsite-clay.ai"),
  }));
  t("the published page is a different origin with no key in it", !fresh.key && !fresh.stored,
    `key=${fresh.key} stored=${fresh.stored}`);

  await live.evaluate((n) => nc.login("nsec", { key: n }), NSEC);
  await live.waitForTimeout(600);
  await live.waitForSelector("[data-nc-ai]", { timeout: 10000 });
  t("the owner gets an Edit with AI button on the toolbar", await live.isVisible("[data-nc-ai]"));

  await live.click("[data-nc-ai]");
  await live.waitForSelector(".nc-ui textarea", { timeout: 10000 });
  // The credit is on the relays, not in this browser. The dialog has to find it
  // rather than telling somebody who has just paid that they have none.
  await live.waitForFunction(() => {
    const p = [...document.querySelectorAll(".nc-ui")].at(-1);
    return p && !p.querySelector("button[type=submit]").disabled;
  }, null, { timeout: 15000 });
  const dialog = await live.evaluate(() => {
    const p = [...document.querySelectorAll(".nc-ui")].at(-1);
    return { key: nc.ai.client.session().key, bad: p.querySelector(".nc-hint.nc-bad")?.textContent || "",
      scopes: [...(p.querySelector("select")?.options || [])].map((o) => o.value) };
  });
  t("the credit bought in the wizard is found from the page", dialog.key === "sk-local-e2e", dialog.key || "none");
  t("without it ever being in this browser's storage", !fresh.stored);
  t("so the dialog does not claim there is no credit", !/no ai credit|nem/i.test(dialog.bad), dialog.bad);
  t("and with nothing clicked, the whole page is what it edits", dialog.scopes.length === 0);

  turn = 2;   // the next reply adds a section this page has never had
  await live.evaluate(() => {
    const p = [...document.querySelectorAll(".nc-ui")].at(-1);
    p.querySelector("textarea").value = "Add a section about staying open after dark.";
    p.querySelector("form, .nc-ui-card").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await live.waitForSelector(".nc-ui iframe", { timeout: 30000 });
  const preview = await live.evaluate(() => {
    const p = [...document.querySelectorAll(".nc-ui")].at(-1);
    const card = p.querySelector(".nc-ui-card"), actions = p.querySelector(".nc-actions");
    return { frames: p.querySelectorAll("iframe").length,
      shows: (p.querySelector("iframe")?.srcdoc || "").includes("Lamplight repairs"),
      keepVisible: actions.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom + 1 };
  });
  t("the rewritten page is previewed on its own", preview.frames === 1 && preview.shows);
  t("and the button that keeps it is on screen", preview.keepVisible);
  t("and nothing on the page has changed yet",
    !(await live.evaluate(() => document.body.textContent.includes("Lamplight repairs"))));

  await live.evaluate(() => {
    const p = [...document.querySelectorAll(".nc-ui")].at(-1);
    p.querySelector("form, .nc-ui-card").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await live.waitForFunction(() => document.body.textContent.includes("Lamplight repairs"), null, { timeout: 10000 });
  const applied = await live.evaluate(() => ({
    dark: getComputedStyle(document.body).backgroundColor,
    bar: !!document.querySelector(".nc-bar [data-nc-save]"),
    ai: !!document.querySelector("[data-nc-ai]"),
    dirty: nc.dirty,
    editable: document.querySelectorAll("[editable]").length,
    scripts: [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")),
  }));
  t("the new design is on the live page", /16, 16, 20|#101014/.test(applied.dark), applied.dark);
  t("the toolbar still works after a whole-page rewrite", applied.bar && applied.ai);
  t("the runtime is still loaded from the same files", applied.scripts.some((s) => /nsite-clay/.test(s)));
  t("the new text is editable", applied.editable >= 2);
  t("and the page is unsaved rather than published behind their back", applied.dirty === true);

  const saved = await live.evaluate(async () => { await nc.save(); return true; });
  t("a rewritten page saves", saved === true);

  const again = await browser.newPage();
  again.on("pageerror", (e) => t("pageerror(reload)", false, e.message));
  await again.goto(published.link + "?v=" + Date.now());
  await again.waitForTimeout(1200);
  const persisted = await again.evaluate(() => ({
    text: document.body.textContent.includes("Lamplight repairs"),
    bg: getComputedStyle(document.body).backgroundColor,
    toolbarOnce: document.querySelectorAll(".nc-bar").length,
    scriptsOnce: [...document.querySelectorAll("script[src]")].filter((el) => /nsite-clay(-[0-9a-f]+)?\.js$/.test(el.getAttribute("src"))).length,
  }));
  t("the rewrite is what a visitor is served", persisted.text, JSON.stringify(persisted));
  t("with its design", /16, 16, 20/.test(persisted.bg), persisted.bg);
  t("and exactly one toolbar and one runtime, not two", persisted.toolbarOnce === 1 && persisted.scriptsOnce === 1,
    JSON.stringify(persisted));
  t("a rewrite that is not about pictures asks exactly what it always did",
    asked.length > 0 && asked.every((b) => !/nc:prompt|nc:redraw/.test(b.messages[0].content)));

  // ---- pictures on the published page -------------------------------------
  // A fresh tab on the published page: the key is on the owner's relays, not in
  // this browser, which is where 0.3.22's picture dialog decided there was no
  // AI and left the option out.
  // A different picture each time it is asked, as a model would make.
  const squares = await again.evaluate(() => ["#d84", "#e52", "#fa3"].map((colour) => {
    const c = document.createElement("canvas"); c.width = 600; c.height = 600;
    const x = c.getContext("2d"); x.fillStyle = colour; x.fillRect(0, 0, 600, 600); x.fillStyle = "#246"; x.fillRect(0, 0, 300, 600);
    return c.toDataURL("image/png").split(",")[1];
  }));
  const pic = await browser.newPage();
  await mockAiAccount(pic, { balance: 1000000 });
  pic.on("pageerror", (e) => t("pageerror(pictures)", false, e.message));
  const QWEN = { id: "qwen-image-2-1-turbo", architecture: { output_modalities: ["image"] },
    sats_pricing: { image_output: 24.33 }, image_pricing: { max_usd: 0.02, tiers: [], default_resolution: "1K" } };
  await pic.route("https://routstr.cypherpunk.today/v1/models", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ data: [{ id: "deepseek-v4-1-flash-1017", sats_pricing: { prompt: .000439, completion: .001756 } }, QWEN] }) }));
  const drawn = [];
  await pic.route("https://routstr.cypherpunk.today/v1/image/generate", (route) => {
    drawn.push(route.request().postDataJSON());
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ images: [squares[(drawn.length - 1) % squares.length]] }) });
  });
  const chats = [];
  await pic.route("https://routstr.cypherpunk.today/v1/chat/completions", (route) => {
    const body = route.request().postDataJSON(); chats.push(body);
    // The model does what it is told: the picture asked about is marked to be
    // redrawn, with a new description, and nothing else changes.
    const page = body.messages[1].content.split("The page as it is now:\n")[1];
    const out = page.replace(/<img /, '<img nc:redraw="" nc:prompt="The same bench at sunset, warm light" ');
    route.fulfill({ contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: out }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
  });
  await pic.goto(published.link + "?p=" + Date.now() + "#edit");
  await pic.evaluate(async () => { await nc.ready; });
  await pic.evaluate((n) => nc.login("nsec", { key: n }), NSEC);
  await pic.waitForSelector("[data-nc-ai]", { timeout: 10000 });
  const first = await pic.evaluate(() => {
    const had = nc.ai.client.session().key;
    const img = document.createElement("img"); img.id = "bench"; img.setAttribute("nc:crop", "16:9");
    img.alt = "The bench"; img.setAttribute("nc:prompt", "A wooden workshop bench with tools");
    img.src = "https://example.invalid/old-bench.webp";
    document.querySelector("main section").append(img);
    window.picked = nc.media.promptImage({ target: img });
    return { had: !!had };
  });
  const box = pic.locator("dialog.nc-ui").last();
  await box.getByText(await pic.evaluate(() => nc.ai.say("pictureGenerate"))).waitFor({ timeout: 20000 });
  t("the picture dialog offers AI once the owner's credit is found", true, first.had ? "key was already here" : "key fetched from relays");
  t("prefilled from the frame's own description", await box.locator(".nc-ai-picture textarea").inputValue() === "A wooden workshop bench with tools");
  await pic.waitForFunction(() => /24\.33/.test(document.querySelector("dialog.nc-ui .nc-ai-picture")?.textContent || ""), null, { timeout: 10000 });
  t("with what a picture costs", true);
  await box.locator(".nc-ai-picture textarea").fill("A wooden workshop bench in morning light");
  await box.locator(".nc-ai-picture button").click();
  await pic.waitForFunction(() => /^https?:/.test([...document.querySelectorAll("dialog.nc-ui input")].find((i) => i.placeholder === "https://…")?.value || "")
    && !/old-bench/.test([...document.querySelectorAll("dialog.nc-ui input")].find((i) => i.placeholder === "https://…").value), null, { timeout: 30000 });
  await box.locator("button[type=submit]").click();
  await pic.evaluate(() => window.picked);
  const replaced = await pic.evaluate(() => ({ src: document.querySelector("#bench").getAttribute("src"),
    prompt: document.querySelector("#bench").getAttribute("nc:prompt") }));
  t("a picture that was there is replaced by one AI made, on the owner's Blossom server",
    /^http:\/\/127\.0\.0\.1:/.test(replaced.src) && drawn.at(-1)?.aspect_ratio === "16:9", JSON.stringify(replaced));
  t("and the frame remembers what it was made from", replaced.prompt === "A wooden workshop bench in morning light");

  // The whole page, asked to change a picture.
  await pic.click("[data-nc-ai]");
  await pic.waitForFunction(() => { const p = [...document.querySelectorAll(".nc-ui")].at(-1);
    return p && p.querySelector("textarea") && !p.querySelector("button[type=submit]").disabled; }, null, { timeout: 15000 });
  const made = drawn.length;
  await pic.evaluate(() => {
    const p = [...document.querySelectorAll(".nc-ui")].at(-1);
    p.querySelector("textarea").value = "Make the bench picture warmer, like a sunset.";
    p.querySelector("form, .nc-ui-card").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await pic.waitForSelector(".nc-ui iframe", { timeout: 30000 });
  t("a rewrite about pictures is told how to redraw them", /nc:redraw/.test(chats.at(-1).messages[0].content));
  t("and only the marked picture is redrawn", drawn.length === made + 1 && drawn.at(-1).prompt === "The same bench at sunset, warm light",
    `${drawn.length - made} pictures`);
  t("the preview shows it before anything is uploaded",
    (await pic.evaluate(() => [...document.querySelectorAll(".nc-ui iframe")].at(-1).srcdoc)).includes("data:image/webp"));
  await pic.evaluate(() => {
    const p = [...document.querySelectorAll(".nc-ui")].at(-1);
    p.querySelector("form, .nc-ui-card").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await pic.waitForFunction((old) => { const el = document.querySelector("#bench"); return el && el.getAttribute("src") !== old; },
    replaced.src, { timeout: 30000 });
  const redrawn = await pic.evaluate(() => { const el = document.querySelector("#bench");
    return { src: el.getAttribute("src"), prompt: el.getAttribute("nc:prompt"), marker: el.hasAttribute("nc:redraw") }; });
  t("keeping it uploads the new picture and puts it in the page",
    /^http:\/\/127\.0\.0\.1:/.test(redrawn.src) && !redrawn.marker, JSON.stringify(redrawn));
  t("with the description it was made from", redrawn.prompt === "The same bench at sunset, warm light");
} catch (e) {
  t("the run completed", false, e.message);
} finally {
  for (const [name, pass, detail] of out) console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? "   (" + detail + ")" : ""}`);
  console.log(`\n${out.filter((r) => r[1]).length}/${out.length} passed`);
  if (out.every((r) => r[1])) console.log("End to end: an AI page is published, its owner's credit follows it, and the whole page is rewritten, saved and served.");
  await browser.close();
  stack.kill("SIGTERM");
  await new Promise((resolve) => stack.exitCode !== null ? resolve() : stack.once("exit", resolve));
  process.exit(out.every((r) => r[1]) ? 0 : 1);
}
