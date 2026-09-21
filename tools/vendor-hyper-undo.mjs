// Reproduce the pinned library plus one host hook. The npm lockfile fixes the
// source; this adapter avoids teaching upstream about nsite-clay's attributes.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const source = "node_modules/hyper-undo";
const target = "src/vendor/hyper-undo";
async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const a = join(from, entry.name), b = join(to, entry.name);
    if (entry.isDirectory()) { await copyTree(a, b); continue; }
    let text = await readFile(a, "utf8");
    if (entry.name === "scope.js") {
      const old = "const kept = records.filter((r) => !shouldIgnore(r.target, config.ignoreAttribute, r))\n    return recordsToPrimitives(kept, (node) => shouldIgnore(node, config.ignoreAttribute))";
      if (!text.includes(old)) throw new Error("Upstream undo filter changed; review the adapter before updating.");
      text = text.replace(old, "const ignored = (node, record) => config.ignoreNode?.(node) || shouldIgnore(node, config.ignoreAttribute, record)\n    const kept = records.filter((r) => !ignored(r.target, r))\n    return recordsToPrimitives(kept, (node) => ignored(node))");
    }
    await writeFile(b, text);
  }
}
await copyTree(join(source, "src"), target);
await writeFile(join(target, "LICENSE"), await readFile(join(source, "LICENSE")));
console.log("Vendored hyper-undo with the ignoreNode host hook.");
