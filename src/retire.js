// Retiring the version a save replaced, without breaking the page.
//
// A sealed page keeps no history, so the blob a save replaces is deleted. Not
// at once: a gateway can go on resolving the page through a manifest it read
// hours ago (nsite.lol was measured doing so for more than seven hours), and a
// relay that missed the newest manifest still names the older blob. Delete
// that blob the moment the new manifest is out and every one of those answers
// "Bad Gateway" instead of the page.
//
// So a replaced blob is first *retired*: named in the new manifest as
// ["retired", <sha256>, <unix time it was replaced>] and left where it is. It
// is deleted later, by whoever saves or sweeps next, once three things hold:
//
//   1. it was retired at least RETIRE_AFTER seconds ago,
//   2. every relay the page publishes to returns the manifest that replaced it,
//   3. the gateway serves that manifest's page (its ETag, or the bytes, hash to
//      the current /index.html). A gateway that cannot be asked counts as no.
//
// The list travels in the manifest so the browser runtime and the agent's tool
// share it: either can retire, and either can finish what the other started.
// Nothing here touches a network; callers do the checking.

/** Two days. The longest stale window measured on nsite.lol was under a day. */
export const RETIRE_AFTER = 48 * 3600;

/**
 * How many retired versions a manifest names at most. A page saved on every
 * tick for two days would otherwise grow a manifest past what relays accept.
 * Past this, the oldest are deleted as soon as the newest version is confirmed
 * everywhere (2 and 3 above), or, if it is not, left on their servers unnamed.
 */
export const MAX_RETIRED = 64;

const HEX64 = /^[0-9a-f]{64}$/;

// A site with many pages under one key (a workspace) shares one manifest, and
// so one list. There each entry also says which path it was retired from,
// ["retired", <sha256>, <time>, <path>], so a page only ever retires, and
// deletes, its own versions. Readers that know only three fields ignore it.

/** The retired versions a manifest names, as [{ hash, at, path? }]. */
export function retiredOf(event) {
  if (!event?.tags) return [];
  return event.tags
    .filter((t) => t[0] === "retired" && HEX64.test(t[1] || ""))
    .map((t) => ({ hash: t[1], at: Number(t[2]) || 0, ...(t[3] ? { path: t[3] } : {}) }));
}

/** The tags that name them. */
export function retiredTags(list) {
  return (list || []).map((r) => ["retired", r.hash, String(r.at), ...(r.path ? [r.path] : [])]);
}

/** Every blob any path of any of `manifests` names. Never to be deleted. */
export function namedHashes(manifests) {
  const out = new Set();
  for (const m of manifests || []) for (const t of m?.tags || []) if (t[0] === "path" && HEX64.test(t[2] || "")) out.add(t[2]);
  return out;
}

/** The entries of `list` that belong to `path`: its own, and for the root page, the ones with no path. */
export function retiredFor(list, path) {
  return (list || []).filter((r) => (r.path ? r.path === path : path === "/index.html"));
}

/**
 * One list out of several, each hash once with the earliest time it was
 * retired, oldest first, and without anything a current path still uses.
 */
export function mergeRetired(lists, inUse = []) {
  const keep = new Map();
  const used = new Set(inUse);
  for (const list of lists) {
    for (const r of list || []) {
      if (!r || !HEX64.test(r.hash || "") || used.has(r.hash)) continue;
      const at = Number(r.at) || 0;
      const had = keep.get(r.hash);
      const path = r.path || had?.path;
      if (!had || at < had.at) keep.set(r.hash, { hash: r.hash, at, ...(path ? { path } : {}) });
    }
  }
  return [...keep.values()].sort((a, b) => a.at - b.at);
}

/**
 * Split a list into what may be deleted now and what stays named.
 * `settled` is true when 2 and 3 above hold for the manifest that replaced them.
 * Returns { purge, keep, drop }: `drop` are past MAX_RETIRED and unconfirmed,
 * to be left on their servers and no longer named.
 */
export function planRetired(list, { now, after = RETIRE_AFTER, settled, max = MAX_RETIRED, exclude = [] }) {
  const skip = new Set(exclude);
  const purge = [], keep = [];
  for (const r of list) {
    if (skip.has(r.hash)) continue;
    if (settled && now - r.at >= after) purge.push(r); else keep.push(r);
  }
  const drop = [];
  while (keep.length > max) {
    const r = keep.shift();
    (settled ? purge : drop).push(r);
  }
  return { purge, keep, drop };
}

/** The sha256 a gateway's ETag carries, if it carries one (nsite.lol: W/"<hex>"). */
export function etagHash(etag) {
  const m = /([0-9a-f]{64})/i.exec(String(etag || ""));
  return m ? m[1].toLowerCase() : null;
}
