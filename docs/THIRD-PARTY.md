# Libraries adopted from Hyperclay

| Library | Version | License | Source |
|---|---|---|---|
| quickcrop | 1.2.0 | MIT-0 | https://github.com/panphora/quickcrop |
| hyper-undo | 0.6.0 | MIT-0 | https://github.com/panphora/hyper-undo |

These are bundled into the runtime. A published page fetches no library from a CDN.
Exact package versions and integrity hashes live in `package-lock.json`.

`tools/vendor-hyper-undo.mjs` copies the pinned package into `src/vendor/` and
adds one `ignoreNode` option to its record filter. The adapter supplies the
runtime chrome and transient-region exclusions; the upstream replay engine is
unchanged. The script refuses an unfamiliar filter when updating the package.
