// Finding and running the nsite-artifacts script, and reading times and durations.
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REL = join("..", "..", "nsite-artifacts", "scripts", "artifact.mjs");

// Where the artifact tool may be, in order: the environment or the user's settings, then next to
// this skill as the agent reached it (through a symlink, the link's folder), then next to the real
// file. A skills folder full of symlinks finds the tool either way.
export function toolCandidates(config) {
  const out = [];
  if (config && config.artifactTool) out.push(resolve(config.artifactTool));
  const scripts = [];
  if (process.argv[1]) scripts.push(dirname(resolve(process.argv[1])));
  scripts.push(dirname(fileURLToPath(new URL("../board.mjs", import.meta.url))));
  for (const s of scripts) out.push(resolve(s, REL));
  return [...new Set(out)];
}

export function findTool(config) {
  // A path somebody configured is what they meant. If it is wrong, say so instead of quietly
  // using another copy.
  if (config && config.artifactTool && !existsSync(resolve(config.artifactTool))) {
    const e = new Error(`the nsite-artifacts script was not found at ${resolve(config.artifactTool)}, which the settings (artifactTool or DECISION_BOARD_ARTIFACT_TOOL) name.`);
    e.code = "NO_TOOL";
    throw e;
  }
  const c = toolCandidates(config);
  const hit = c.find((p) => existsSync(p));
  if (!hit) {
    const e = new Error(`the nsite-artifacts script was not found. Looked at: ${c.join(", ")}. ` +
      `Install the nsite-artifacts skill next to this one, or set "artifactTool" in the user settings file ` +
      `or DECISION_BOARD_ARTIFACT_TOOL.`);
    e.code = "NO_TOOL";
    throw e;
  }
  return hit;
}

// Runs one artifact command. stdout and stderr are kept apart: a Node warning on stderr does not
// spoil the JSON on stdout.
export function runTool(tool, args, { timeoutMs = 180000 } = {}) {
  return new Promise((res) => {
    execFile(process.execPath, [tool, ...args], { timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      let json = null;
      const s = String(stdout).trim();
      if (s) {
        try { json = JSON.parse(s); } catch {
          const last = s.split("\n").filter((l) => l.trim().startsWith("{")).pop();
          try { json = last ? JSON.parse(last) : null; } catch { json = null; }
        }
      }
      res({ code, json, stdout: String(stdout), stderr: String(stderr).trim(), timedOut: !!(err && err.killed) });
    });
  });
}

const UNIT = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

// "90", "90s", "10m", "1.5h", "7d" -> seconds. Anything else -> null.
export function parseDuration(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhdw]?)\s*$/i.exec(String(v ?? ""));
  if (!m) return null;
  const n = parseFloat(m[1]) * UNIT[(m[2] || "s").toLowerCase()];
  return n > 0 ? n : null;
}

// A deadline: an ISO time, unix seconds, or a duration from now. Returns epoch ms, or null.
export function parseUntil(v, now = Date.now()) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^\d{9,11}$/.test(s)) return parseInt(s, 10) * 1000;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  const d = parseDuration(s);
  return d == null ? null : now + d * 1000;
}
