# Libraries adopted from Hyperclay

| Library | Version | License | Source |
|---|---|---|---|
| quickcrop | 1.2.0 | MIT-0 | https://github.com/panphora/quickcrop |
| hyper-undo | 0.6.0 | MIT-0 | https://github.com/panphora/hyper-undo |
| ClayJS source serializer | 7b50315e8f732e92643ab2e953648994cb37a442 | MIT-0 | https://github.com/panphora/clayjs |
| parse5 and entities | See package-lock.json | MIT and BSD-2-Clause | https://github.com/inikulin/parse5 |

These are bundled into the runtime. A published page fetches no library from a CDN.
Exact package versions and integrity hashes live in `package-lock.json`.

`tools/vendor-hyper-undo.mjs` copies the pinned package into `src/vendor/` and
adds one `ignoreNode` option to its record filter. The adapter supplies the
runtime chrome and transient-region exclusions; the upstream replay engine is
unchanged. The script refuses an unfamiliar filter when updating the package.

`tools/vendor-clay-source.mjs` retrieves the serializer at its exact commit and
replaces its vendored parser import with the pinned npm parser. Its matching,
rendering and verification algorithms are unchanged. Dependency license texts
are shipped in `dist/THIRD-PARTY-LICENSES.txt`.
