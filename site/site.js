/* Theme for the presentation site. Loaded synchronously at the top of every
 * page, so the right scene is on screen before first paint.
 *
 * The choice is the visitor's own and lives in their browser. A page saved by
 * its owner may carry whichever data-theme the owner happened to be viewing, so
 * this always sets or removes the attribute from the visitor's own choice. */
(function () {
  var root = document.documentElement, KEY = "nsite-clay-theme";
  function stored() { try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : null; } catch (e) { return null; } }
  function apply(v) { if (v) root.setAttribute("data-theme", v); else root.removeAttribute("data-theme"); }
  function effective() {
    return stored() || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  apply(stored());
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!b) return;
    var next = effective() === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (err) { /* private window: the choice lasts this view */ }
    apply(next);
    b.setAttribute("aria-pressed", String(next === "dark"));
  });
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(effective() === "dark"));
    });
  });
})();
