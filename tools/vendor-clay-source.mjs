// Pull a reviewed, immutable upstream revision. Runtime builds use the committed
// copy, so building or opening a page never needs GitHub.
import { mkdir, writeFile } from "node:fs/promises";
const revision = "7b50315e8f732e92643ab2e953648994cb37a442";
const root = `https://raw.githubusercontent.com/panphora/clayjs/${revision}/`;
for (const [from, to] of [
  ["src/core/source-map.js", "src/vendor/clay-source/source-map.js"],
  ["LICENSE", "src/vendor/clay-source/LICENSE"],
]) {
  const res = await fetch(root + from);
  if (!res.ok) throw new Error(`${from}: ${res.status}`);
  let text = await res.text();
  if (from.endsWith("source-map.js")) {
    const dependency = "from '../vendor/parse5.vendor.js'";
    if (!text.includes(dependency)) throw new Error("The upstream parser import changed.");
    text = text.replace(dependency, "from 'parse5'");
  }
  await mkdir("src/vendor/clay-source", { recursive: true });
  await writeFile(to, text);
}
console.log(`Vendored ClayJS source serializer at ${revision}.`);
