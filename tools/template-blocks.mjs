#!/usr/bin/env node
// Does a template's block area work, and does the design survive it?
//
// Run it after converting a template, or over all of them:
//
//   node tools/template-blocks.mjs personal blog
//   node tools/template-blocks.mjs                 (every staged template)
//
// It serves site/t/ the way a gateway does, loads the template, checks a reader
// sees no editing furniture, signs in as the owner, and then checks the rails,
// the insert points, the library, that adding a block really adds one, and that
// none of the runtime's own markup reaches a save. A template with no block
// area is reported as skipped rather than failed: not every design wants one.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, statSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";
import { getPublicKey, nip19 } from "nostr-tools";
const NSEC = "nsec1wsxl92ek0uznl6u3wpk7hl86cqnxdp8f8m9cvl93tr2tt0n4c5jqfjt3a8";
const PUB = getPublicKey(nip19.decode(NSEC).data);
const T={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".json":"application/json",".jpg":"image/jpeg"};
const s=createServer((q,r)=>{let p=join("site",decodeURIComponent(q.url.split("?")[0]));try{if(statSync(p).isDirectory())p=join(p,"index.html")}catch{}try{const b=readFileSync(p);r.writeHead(200,{"Content-Type":T[extname(p)]||"application/octet-stream"});r.end(b)}catch{r.writeHead(404);r.end()}}).listen(0);
const port=s.address().port;
// site/ holds copies of the shared runtime and stylesheet, staged by
// `npm run site:build`. Running this straight after editing either one would
// otherwise test the previous copy and report a pass, or a failure, that has
// nothing to do with the change in hand.
for (const [from, to] of [
  ["dist/nsite-clay.js", "site/nsite-clay.js"],
  ["templates/_shared/nsite-clay-base.css", "site/nsite-clay-base.css"],
  ["templates/_shared/nsite-clay-chrome.js", "site/nsite-clay-chrome.js"],
]) copyFileSync(from, to);

const b=await chromium.launch({channel:"chrome"});
import { readdirSync } from "node:fs";
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(join("site", "t")).filter((n) => !n.endsWith(".json")).sort();
let bad = 0;
for (const name of names) {
  const p=await b.newPage({viewport:{width:1200,height:900},deviceScaleFactor:1});
  const errs=[];p.on("pageerror",e=>errs.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/t/${name}/`,{waitUntil:"networkidle",timeout:30000});
  await p.waitForFunction(()=>window.nc&&document.documentElement.getAttribute("nc:ready")==="true",{timeout:20000});
  const reader = await p.evaluate(()=>({rails:document.querySelectorAll(".nc-blk-rail").length, wide:document.documentElement.scrollWidth>document.documentElement.clientWidth+2}));
  await p.evaluate(async ({pub,nsec})=>{nc.cfg.owner=pub;await nc.login("nsec",{key:nsec});location.hash="#edit";},{pub:PUB,nsec:NSEC});
  await p.waitForTimeout(700);
  const owner = await p.evaluate(()=>{
    const c=nc.blocks.containers()[0];
    return {containers:nc.blocks.containers().length, blocks:c?nc.blocks.blocksIn(c).length:0,
            lib:nc.blocks.library().size, rails:document.querySelectorAll(".nc-blk-rail").length,
            adders:document.querySelectorAll(".nc-blk-add").length,
            wide:document.documentElement.scrollWidth>document.documentElement.clientWidth+2};
  });
  const added = await p.evaluate(async ()=>{
    const before=nc.blocks.blocksIn(nc.blocks.containers()[0]).length;
    // Whatever this template's library actually offers, skipping the ones that
    // open a picker.
    const names=[...nc.blocks.library().values()].filter(k=>!k.onAdd).slice(0,2).map(k=>k.name);
    for (const n of names) await nc.blocks.add(n);
    window.__added=names.length;
    const after=nc.blocks.blocksIn(nc.blocks.containers()[0]).length;
    const html=nc.getHTML();
    return {grew:after-before, want:window.__added, clean:!html.includes("nc-blk-rail")&&!html.includes("nc-blk-add"), lib:html.includes('nc:block="picture"')};
  });
  if (owner.containers === 0) {
    console.log(`  skip  ${name.padEnd(9)} no nc:blocks area`);
    await p.close();
    continue;
  }
  const okAll = reader.rails===0 && !reader.wide && owner.containers===1 && owner.blocks>0
    && owner.lib>=5 && owner.rails===owner.blocks && owner.adders===owner.blocks+1
    && !owner.wide && added.grew===added.want && added.want>0 && added.clean && added.lib && errs.length===0;
  if (!okAll) bad++;
  console.log(`  ${okAll?"ok  ":"FAIL"}  ${name.padEnd(9)} blocks:${owner.blocks} lib:${owner.lib} rails:${owner.rails} adders:${owner.adders} added:+${added.grew}/${added.want} clean:${added.clean} noscroll:${!owner.wide} readerclean:${reader.rails===0}${errs.length?" ERR:"+errs[0].slice(0,50):""}`);
  await p.screenshot({path:`/tmp/tpl-${name}.png`});
  await p.close();
}
await b.close();s.close();
console.log(bad ? `\n${bad} template(s) failed` : "\nevery block area works");
process.exit(bad?1:0);
