import { chromium } from "playwright";
const [url, key, outDir] = process.argv.slice(2);
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1180, height: 800 }, deviceScaleFactor: 2 });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto(url, { waitUntil: "networkidle" });
const shot = (n) => p.screenshot({ path: `${outDir}/${n}.png` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (js) => p.evaluate(js);

await ev(`nc.ready.then(() => true)`);
await sleep(3000);
await shot("g1-your-page");

// signing in, as a reader would see it
await ev(`document.querySelector('#login').click()`);
await sleep(400);
await shot("g2-sign-in");
await ev(`(() => { const i = document.querySelector('#nsec-input'); i.value = '${key}';
  document.querySelector('#nsec-form').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true})); })()`);
await sleep(800);
await shot("g3-signed-in");

// editing text
await ev(`(() => {
  const el = document.querySelector('.prose p');
  el.scrollIntoView({ block: 'center' });
  const t = [...el.childNodes].find(n => n.nodeType === 3 && n.textContent.trim().length > 20);
  const r = document.createRange(); r.setStart(t, 4); r.setEnd(t, 36);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
})()`);
await sleep(500);
await shot("g4-toolbar");

// the image picker, with its gallery
await ev(`void nc.media.promptImage()`);
await sleep(2200);
await shot("g5-add-picture");
await ev(`document.querySelector('.nc-ui .nc-cancel').click()`);
await sleep(200);

// the video dialog
await ev(`void nc.media.promptVideo()`);
await sleep(400);
await ev(`(() => { const i = document.querySelector('.nc-ui input[type=text]');
  i.value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; i.dispatchEvent(new Event('input')); })()`);
await sleep(200);
await shot("g6-add-video");
await ev(`document.querySelector('.nc-ui form').requestSubmit()`);
await sleep(900);
await ev(`document.querySelector('[nc\\\\:video]')?.scrollIntoView({ block: 'center' })`);
await sleep(400);
await shot("g7-video-in-page");

// the post picker
await ev(`void nc.feed.promptInsert()`);
await sleep(3000);
await ev(`(() => { const b = document.querySelectorAll('.nc-pick button'); b[0]?.click(); })()`);
await sleep(300);
await shot("g8-pick-posts");
await ev(`document.querySelector('.nc-ui .nc-cancel').click()`);
await sleep(200);
await ev(`document.querySelector('[nc\\\\:feed]')?.scrollIntoView({ block: 'center' })`);
await sleep(700);
await shot("g9-posts-in-page");

// writing
await ev(`void nc.compose.open()`);
await sleep(2500);
await shot("g10-your-posts");
await ev(`document.querySelector('.nc-ui .nc-primary').click()`);
await sleep(300);
await ev(`void nc.compose.openArticle()`);
await sleep(600);
await shot("g11-write-article");
await ev(`document.querySelector('.nc-ui .nc-cancel').click()`);
await sleep(200);

// version history
await ev(`document.querySelector('#versions').click()`);
await sleep(2500);
await shot("g12-history");

console.log("page errors:", errs.length ? errs : "none");
await b.close();
