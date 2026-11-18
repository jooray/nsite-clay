#!/usr/bin/env node
// Tells the owner something about a board, on the channel in their settings, with the page's edit
// link appended here, so the link never passes through the agent.
//
//   node notify.mjs [--id=<artifact id> | --board=board.json] "text"     (or the text on stdin)
//
// Prints {"notified":true,"withLink":true} or {"notified":false,"reason":"..."}. The link is never
// printed. Exit 0 when sent or when nothing is configured (then tell the owner in the chat), 1 when
// the command failed.
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, argvOf } from "./config.mjs";
import { findTool, runTool } from "./lib/tool.mjs";

export async function notify({ text, id = null, boardPath = null, config = null }) {
  const cfg = config || loadConfig({ boardPath }).config;
  const argv = argvOf(cfg.notify.command);
  if (!argv) return { notified: false, reason: "no notify command configured; tell the owner in the chat" };
  if (!text || !String(text).trim()) return { notified: false, reason: "no text to send" };
  let body = String(text).trim();
  let withLink = false;
  if (cfg.notify.includeEditLink && id) {
    let tool;
    try { tool = findTool(cfg); } catch (e) { return { notified: false, reason: e.message }; }
    const r = await runTool(tool, ["links", String(id)], { timeoutMs: 60000 });
    const link = r.json && (r.json.editLink || r.json.link);
    if (r.code !== 0 || !link) return { notified: false, reason: `could not get the link of ${id}: ${r.stderr || "no link in the answer"}` };
    body += `\n\n${link}`;
    withLink = true;
  }
  return new Promise((res) => {
    let child;
    try { child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "ignore", "pipe"] }); } catch (e) { return res({ notified: false, reason: e.message, failed: true }); }
    let err = "";
    const timer = setTimeout(() => child.kill(), 120000);
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); res({ notified: false, reason: `${argv[0]}: ${e.code || e.message}`, failed: true }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      res(code === 0 ? { notified: true, withLink } : { notified: false, reason: `${argv[0]} exited with ${code}: ${err.trim().slice(0, 300)}`, failed: true });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(body + "\n");
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  let text = args.filter((a) => !a.startsWith("--")).join(" ");
  if (!text && !process.stdin.isTTY) { for await (const c of process.stdin) text += c; }
  const boardPath = opt("board");
  let id = opt("id");
  try {
    if (!id && boardPath) {
      const { loadBoard } = await import("./lib/schema.mjs");
      id = (loadBoard(boardPath).artifact || {}).id || null;
    }
    const r = await notify({ text, id, boardPath });
    console.log(JSON.stringify(r));
    process.exit(r.failed ? 1 : 0);
  } catch (e) { console.error(`notify: ${e.message}`); process.exit(1); }
}
