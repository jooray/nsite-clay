#!/usr/bin/env node
// Settings for decision-board. One JSON file per level, merged key by key.
//
//   node config.mjs [board.json]     prints the settings that apply, and where each came from
//
// Lookup, earlier wins:
//   1. $DECISION_BOARD_CONFIG (a path). If set, it is the only file read, and it counts as the user's file.
//   2. decision-board.config.json next to board.json, then in each parent folder up to the repository root.
//   3. the user's file: $XDG_CONFIG_HOME/decision-board/config.json (default ~/.config/...),
//      on Windows %APPDATA%\decision-board\config.json.
//   4. built-in defaults.
//
// A project file is somebody else's text that arrives with a repository. It may set only the keys in
// PROJECT_KEYS. Everything that runs a command, names a person or tells the agent what to do is read
// from the user's file or the environment only.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const DEFAULTS = {
  language: "en",
  timeZone: null,
  expires: "30d",
  access: "link",
  ownerNpub: null,
  watch: { ask: true, default: "24h", choices: ["4h", "24h", "7d", "until-decided"], everySeconds: 600, settleSeconds: 45 },
  notify: { command: null, includeEditLink: true },
  artifactTool: null,
  workspace: null,
  writingCheck: null,
  confirmInChat: ["delete", "deploy", "publish", "spend", "send"],
};

export const PROJECT_KEYS = new Set(["language", "expires", "watch"]);

export function userConfigPath(env = process.env) {
  if (env.DECISION_BOARD_CONFIG) return resolve(env.DECISION_BOARD_CONFIG);
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "decision-board", "config.json");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "decision-board", "config.json");
}

function readJson(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`); }
}

function projectFiles(boardDir) {
  if (!boardDir) return [];
  const out = [];
  let dir = resolve(boardDir);
  for (;;) {
    const f = join(dir, "decision-board.config.json");
    if (existsSync(f)) out.push(f);
    if (existsSync(join(dir, ".git"))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

// The notify command may be written as an argv array or as one string. A string is split on white
// space. Nothing goes through a shell either way.
export function argvOf(cmd) {
  if (cmd == null || cmd === "") return null;
  if (Array.isArray(cmd)) return cmd.length && cmd.every((x) => typeof x === "string") ? cmd : null;
  if (typeof cmd === "string") return cmd.trim().split(/\s+/);
  return null;
}

function layer(target, src, from, origin, allowed) {
  for (const [k, v] of Object.entries(src || {})) {
    if (!(k in DEFAULTS)) continue;
    if (allowed && !allowed.has(k)) { origin.ignored.push(`${k} (from ${from}: a project file may not set it)`); continue; }
    if (DEFAULTS[k] && typeof DEFAULTS[k] === "object" && !Array.isArray(DEFAULTS[k])) {
      if (!v || typeof v !== "object") continue;
      for (const [k2, v2] of Object.entries(v)) {
        if (!(k2 in DEFAULTS[k]) || target[k][k2] !== undefined) continue;
        target[k][k2] = v2; origin.from[`${k}.${k2}`] = from;
      }
    } else if (target[k] === undefined) { target[k] = v; origin.from[k] = from; }
  }
}

export function loadConfig({ boardPath = null, env = process.env } = {}) {
  const cfg = { watch: {}, notify: {} };
  const origin = { from: {}, ignored: [], files: [] };
  // The environment counts as the user.
  const envLayer = {};
  if (env.DECISION_BOARD_ARTIFACT_TOOL) envLayer.artifactTool = env.DECISION_BOARD_ARTIFACT_TOOL;
  if (env.DECISION_BOARD_NOTIFY_COMMAND) {
    let c = env.DECISION_BOARD_NOTIFY_COMMAND;
    try { const j = JSON.parse(c); if (Array.isArray(j)) c = j; } catch {}
    envLayer.notify = { command: c };
  }
  layer(cfg, envLayer, "environment", origin, null);
  const userFile = userConfigPath(env);
  const explicit = !!env.DECISION_BOARD_CONFIG;
  if (!explicit) {
    for (const f of projectFiles(boardPath ? dirname(resolve(boardPath)) : null)) {
      layer(cfg, readJson(f), f, origin, PROJECT_KEYS); origin.files.push(f);
    }
  }
  const u = readJson(userFile);
  if (u) { layer(cfg, u, userFile, origin, null); origin.files.push(userFile); }
  else if (explicit) throw new Error(`DECISION_BOARD_CONFIG names ${userFile}, which cannot be read`);
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) if (cfg[k][k2] === undefined) cfg[k][k2] = v2;
    } else if (cfg[k] === undefined) cfg[k] = v;
  }
  const problems = [];
  if (!["link", "members"].includes(cfg.access)) problems.push(`access is "link" or "members", not ${JSON.stringify(cfg.access)}`);
  if (cfg.ownerNpub != null && !/^npub1[02-9ac-hj-np-z]{58}$/.test(cfg.ownerNpub)) problems.push("ownerNpub is not an npub");
  if (cfg.access === "members" && !cfg.ownerNpub) problems.push('access "members" needs ownerNpub');
  if (cfg.notify.command != null && !argvOf(cfg.notify.command)) problems.push("notify.command is a program name or an array of strings");
  if (cfg.workspace != null && cfg.workspace !== true && !(typeof cfg.workspace === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(cfg.workspace))) problems.push("workspace is the name of an nsite-artifacts workspace, or true for its default one");
  if (cfg.timeZone) { try { new Intl.DateTimeFormat("en", { timeZone: cfg.timeZone }); } catch { problems.push(`timeZone ${JSON.stringify(cfg.timeZone)} is not a time zone`); cfg.timeZone = null; } }
  return { config: cfg, origin, problems, userFile };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { config, origin, problems, userFile } = loadConfig({ boardPath: process.argv[2] || null });
    // Print what applies, not the private values: the agent needs to know a notify command and an
    // owner npub exist, not what they are.
    const shown = JSON.parse(JSON.stringify(config));
    if (shown.ownerNpub) shown.ownerNpub = "(set)";
    if (shown.notify.command) shown.notify.command = "(set)";
    console.log(JSON.stringify({ config: shown, userFile, files: origin.files, ignored: origin.ignored, problems }, null, 2));
    process.exit(problems.length ? 1 : 0);
  } catch (e) { console.error(`config: ${e.message}`); process.exit(1); }
}
