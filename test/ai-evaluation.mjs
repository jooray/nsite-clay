import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const out = mkdtempSync(join(tmpdir(), "nsite-ai-evaluation-test-"));
let calls = 0;
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  let raw = ""; for await (const chunk of req) raw += chunk;
  if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); return res.end(); }
  calls++;
  assert.equal(JSON.parse(raw).model, "fixture-model");
  const html = '<!DOCTYPE html><html><head><title>Saturday Coffee</title><style>body{font:18px system-ui;margin:2rem}</style></head><body><main><h1>Saturday Coffee</h1><p>123 Satoshi Way</p><p>18000 PYG and 14000 PYG</p><a href="mailto:hello@saturday.example">hello@saturday.example</a></main></body></html>';
  res.setHeader("Content-Type", "text/event-stream");
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: html }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
try {
  await promisify(execFile)(process.execPath, ["tools/ai-evaluate.mjs", "--live", "--case=cafe-en", "--model=fixture-model", "--mode=byok",
    `--base=http://127.0.0.1:${server.address().port}/v1`, `--out=${out}`], { env: { ...process.env, NSITE_AI_KEY: "fixture-key-do-not-write" }, timeout: 90000 });
  const raw = readFileSync(join(out, "results.json"), "utf8"), result = JSON.parse(raw);
  assert.equal(calls, 1); assert(!raw.includes("fixture-key-do-not-write"));
  assert.deepEqual(result.records[0].missingTerms, []);
  assert.equal(result.records[0].observedDebitSats, null);
  assert.equal(result.records[0].overflow390, false);
  assert.equal(result.records[0].humanScores.design, null, "the runner must not invent a human quality score");
  for (const file of ["version-1.html", "version-1-1440.png", "version-1-390.png"]) assert(existsSync(join(out, file)));
  console.log("AI evaluation runner: one fixture request, HTML, mobile/desktop screenshots and secret-free unscored report passed.");
} finally { await new Promise((r) => server.close(r)); rmSync(out, { recursive: true, force: true }); }
