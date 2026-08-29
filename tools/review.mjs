#!/usr/bin/env node
// Serve everything that would be published, exactly as a gateway serves it, and
// print a list to walk through.
//
// The site root has to be the server root: templates link /nsite-clay.js and
// /nsite-clay-base.css from the root, so opening a file directly or serving the
// repo root gives a page with no styling and no runtime, which looks like a bug
// and is not one.
import { createServer } from "node:http";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = Number(process.env.PORT || 4780);
const ROOT = "site";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
};

if (!existsSync(ROOT)) {
  console.error("Nothing to review yet. Run `npm run site:build` first.");
  process.exit(1);
}

const server = createServer((req, res) => {
  let p = join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  try { if (statSync(p).isDirectory()) p = join(p, "index.html"); } catch {}
  let body;
  try { body = readFileSync(p); } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end(`not found: ${req.url}\n`);
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(p)] || "application/octet-stream",
    // Never cache while reviewing: the point is seeing the change you just made.
    "Cache-Control": "no-store",
  });
  res.end(body);
});

// A leftover server on the port is the commonest way this fails, and the raw
// EADDRINUSE stack says nothing useful about what to do next.
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`Port ${PORT} is already in use. Stop whatever is on it, or run:\n` +
                `  PORT=${PORT + 1} npm run review`);
  process.exit(1);
});

server.listen(PORT, () => {
  const at = (path) => `http://127.0.0.1:${PORT}${path}`;
  const line = (path, what) => console.log(`  ${at(path).padEnd(46)} ${what}`);

  console.log(`\nEverything that would be published, served from ${ROOT}/ on port ${PORT}.\n`);
  console.log("The site");
  line("/", "homepage");
  line("/docs.html", "the walkthrough, with screenshots");
  line("/templates.html", "the template gallery");
  line("/llms.txt", "the brief handed to agents");

  // Translations live in a directory named after the language, so finding them
  // is a matter of looking rather than keeping a list here in step with site/.
  const LANGS = { es: "Spanish", sk: "Slovak", cs: "Czech" };
  for (const [code, name] of Object.entries(LANGS)) {
    if (!existsSync(join(ROOT, code, "index.html"))) continue;
    console.log(`\nThe site in ${name}`);
    line(`/${code}/`, "homepage");
    if (existsSync(join(ROOT, code, "docs.html"))) line(`/${code}/docs.html`, "the walkthrough");
    if (existsSync(join(ROOT, code, "templates.html"))) line(`/${code}/templates.html`, "the template gallery");
  }

  const templates = existsSync(join(ROOT, "t")) ? readdirSync(join(ROOT, "t")).sort() : [];
  if (templates.length) {
    console.log(`\nTemplates (${templates.length})`);
    for (const name of templates) line(`/t/${name}/`, name);
  }

  console.log(`\nTo see the editing side of any page, add #edit to its URL. Nothing here can`);
  console.log(`publish: these copies point at the real relays, so signing in and pressing`);
  console.log(`Save would go out for real. Read rather than save, or sign in on a template`);
  console.log(`whose nc:owner is a throwaway key.\n`);
  console.log(`Ctrl+C to stop.\n`);
});
