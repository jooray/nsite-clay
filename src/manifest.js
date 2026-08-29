// NIP-5A nsite manifests: build, hash, publish.
import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { siteKind } from "./config.js";

// NIP-5A aggregate hash: sha256 over sorted "<hash> <path>\n" lines,
// path tags only, order-independent. Identifies a site *version*.
export function aggregateHash(paths) {
  const lines = Object.entries(paths)
    .map(([path, hash]) => `${hash} ${path}\n`)
    .sort();
  return bytesToHex(sha256(new TextEncoder().encode(lines.join(""))));
}

export function buildManifest(cfg, paths, { title, description, source } = {}) {
  const tags = [
    ...(cfg.site ? [["d", cfg.site]] : []),
    ...Object.entries(paths).map(([path, hash]) => ["path", path, hash]),
    ["x", aggregateHash(paths), "aggregate"],
    ...cfg.servers.map((s) => ["server", s]),
    ...(title ? [["title", title]] : []),
    ...(description ? [["description", description]] : []),
    ...(source ? [["source", source]] : []),
  ];
  return { kind: siteKind(cfg), created_at: Math.floor(Date.now() / 1000), tags, content: "" };
}

// A kind-5128 snapshot pins one version forever, addressable by its own event
// id. This is nsite's answer to HyperClay's version history, and it is free:
// the blobs are already immutable, the snapshot just names a set of them.
export function buildSnapshot(cfg, manifest) {
  const keep = manifest.tags.filter((t) => ["path", "x", "server", "title", "description", "source", "A"].includes(t[0]));
  return {
    kind: 5128,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["a", `${siteKind(cfg)}:${cfg.owner}:${cfg.site}`], ...keep],
    content: "",
  };
}

// Read the path table out of a manifest event.
export function manifestPaths(event) {
  const paths = {};
  for (const t of event.tags) if (t[0] === "path" && t[1] && t[2]) paths[t[1]] = t[2];
  return paths;
}

export function manifestServers(event) {
  return event.tags.filter((t) => t[0] === "server" && t[1]).map((t) => t[1]);
}
