# The nsite-clay homepage

This directory is the project's own website, and it is an nsite-clay document: it runs the
runtime it documents and saves itself the same way any other one does.

```bash
npm run site:build                                   # copies dist/ and icons/ in
npx nsite-clay deploy site --bunker="bunker://…"     # or --sec=nsec1…
```

`nc:owner` on `<html>` names the key allowed to publish it. Everything except that key gets a
plain static page.
