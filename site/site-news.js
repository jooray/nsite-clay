/* Mounts the project's live Nostr posts into the "news" flyer.
 *
 * The widget (nostr-live.js, vendored next to this file) reads the project's
 * account straight from relays and checks every signature in the visitor's
 * browser. The host is created here and marked nc:transient, so what the widget
 * draws never reaches a save. The stylesheet it injects into <head> is taken off
 * the save clone for the same reason. */
(function () {
  var NPROFILE = "nprofile1qqs9vku0g4dqgpj82ph2z88jt60yaez3ney6urnw3pdgcchgh6qyfacpr3mhxue69uhkummnw3ezucmewp5x2unsw4hxktn5dajxz7gpzemhxue69uhhyetvv9ujuurjd9kkzmpwdejhgqg5waehxw309aex2mrp0yhxgctdw4eju6t0dmn32s";
  var RELAYS = ["wss://nostr.cypherpunk.today", "wss://relay.primal.net"];

  function start() {
    var slot = document.querySelector("[data-news]");
    if (!slot || !window.NostrLive) return;
    var host = document.createElement("div");
    host.className = "news-host";
    host.setAttribute("nc:transient", "");
    slot.appendChild(host);
    var lang = (document.documentElement.lang || "en").toLowerCase().slice(0, 2);
    window.NostrLive.mount(host, { nprofile: NPROFILE, relays: RELAYS, layout: "cards", limit: 6, lang: lang, loadOn: "visible" });

    var nc = window.nc;
    if (nc && nc.addDocumentTransform) {
      nc.addDocumentTransform(function (clone) {
        var s = clone.querySelector("#nostr-live-style");
        if (s) s.remove();
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
