/* The standard toolbar, wired.
 *
 * Every template ships the same markup and none of them writes sign-in, save
 * or history code. Buttons are found by data attribute, so a template can move
 * them, restyle them, or leave any of them out.
 *
 *   data-nc-signin    sign in, or sign out when already in
 *   data-nc-save      save the page
 *   data-nc-write     the Nostr post composer
 *   data-nc-settings  autosave and the edit gate
 *   data-nc-history   versions, with restore
 *   data-nc-who       filled in with who you are
 *
 * Loaded after nsite-clay.js. */
(async () => {
  await nc.ready;
  const $ = (s) => document.querySelector(s);
  const all = (s) => [...document.querySelectorAll(s)];
  const on = (sel, fn) => all(sel).forEach((el) => (el.onclick = fn));

  // This script writes labels over whatever the markup said, so a translated
  // page would end up with English in the corner however carefully it was
  // translated. The strings live here instead, picked by <html lang>, and an
  // unknown language falls back to English rather than showing a blank button.
  const STRINGS = {
    en: {},
    es: {
      readOnly: "solo lectura", owner: "propietario · ",
      notOwner: "con sesión iniciada, no propietario",
      signIn: "Iniciar sesión", signOut: "Cerrar sesión",
      signInTitle: "Inicia sesión para editar",
      signInHint: "Solo la clave del propietario puede cambiar esta página. Los demás la ven tal como está.",
      useKey: "Usar esta clave",
      scan: "Escanea con Amber u otra app de firma",
      openSigner: "Abrir en tu app de firma",
      waiting: "esperando a la app de firma…",
      pasteKey: "…o pega una clave",
      keyPlaceholder: "nsec1…, ncryptsec1… o 64 caracteres hex",
      ncryptsecPass: "Contraseña de ese ncryptsec",
      needKey: "Pega una clave o usa la app de firma de arriba",
      checking: "comprobando…",
      unchanged: "No ha cambiado nada", saved: (n) => `Guardado, ${n} bytes`,
      saveFailed: "No se pudo guardar: ",
      history: "Historial de versiones",
      historyHint: "Se guarda cada versión. Al leer una se abre en una pestaña nueva; al restaurarla se archiva otra versión, así que no se pierde nada.",
      historyEmpty: "Todavía no hay nada guardado, o los relays no han respondido.",
      close: "Cerrar", read: "Leer", restore: "Restaurar",
      restoring: "restaurando…", failed: "falló",
    },
    sk: {
      readOnly: "len na čítanie", owner: "vlastník · ",
      notOwner: "prihlásený, nie vlastník",
      signIn: "Prihlásiť sa", signOut: "Odhlásiť sa",
      signInTitle: "Prihlás sa a uprav stránku",
      signInHint: "Stránku môže zmeniť iba kľúč vlastníka. Ostatní ju vidia takú, aká je.",
      useKey: "Použiť tento kľúč",
      scan: "Naskenuj v Amberi alebo inej podpisovej aplikácii",
      openSigner: "Otvoriť v podpisovej aplikácii",
      waiting: "čaká sa na podpisovú aplikáciu…",
      pasteKey: "…alebo vlož kľúč",
      keyPlaceholder: "nsec1…, ncryptsec1… alebo 64 hex znakov",
      ncryptsecPass: "Heslo k tomu ncryptsecu",
      needKey: "Vlož kľúč alebo použi podpisovú aplikáciu vyššie",
      checking: "kontroluje sa…",
      unchanged: "Nič sa nezmenilo", saved: (n) => `Uložené, ${n} bajtov`,
      saveFailed: "Nepodarilo sa uložiť: ",
      history: "História verzií",
      historyHint: "Každé uloženie zostáva. Čítanie otvorí verziu na novej karte, obnovenie založí ďalšiu verziu, takže sa nič nestratí.",
      historyEmpty: "Zatiaľ nie je nič uložené, alebo relaye neodpovedali.",
      close: "Zavrieť", read: "Čítať", restore: "Obnoviť",
      restoring: "obnovuje sa…", failed: "zlyhalo",
    },
    cs: {
      readOnly: "jen ke čtení", owner: "vlastník · ",
      notOwner: "přihlášený, ne vlastník",
      signIn: "Přihlásit se", signOut: "Odhlásit se",
      signInTitle: "Přihlas se a uprav stránku",
      signInHint: "Stránku může změnit jen klíč vlastníka. Ostatní ji vidí takovou, jaká je.",
      useKey: "Použít tento klíč",
      scan: "Naskenuj v Amberu nebo jiné podpisové aplikaci",
      openSigner: "Otevřít v podpisové aplikaci",
      waiting: "čeká se na podpisovou aplikaci…",
      pasteKey: "…nebo vlož klíč",
      keyPlaceholder: "nsec1…, ncryptsec1… nebo 64 hex znaků",
      ncryptsecPass: "Heslo k tomu ncryptsecu",
      needKey: "Vlož klíč nebo použij podpisovou aplikaci výše",
      checking: "kontroluje se…",
      unchanged: "Nic se nezměnilo", saved: (n) => `Uloženo, ${n} bajtů`,
      saveFailed: "Nepodařilo se uložit: ",
      history: "Historie verzí",
      historyHint: "Každé uložení zůstává. Čtení otevře verzi na nové kartě, obnovení založí další verzi, takže se nic neztratí.",
      historyEmpty: "Zatím není nic uloženo, nebo relaye neodpověděly.",
      close: "Zavřít", read: "Číst", restore: "Obnovit",
      restoring: "obnovuje se…", failed: "selhalo",
    },
  };
  const EN = {
    readOnly: "read-only", owner: "owner · ", notOwner: "signed in, not the owner",
    signIn: "Sign in", signOut: "Sign out",
    signInTitle: "Sign in to edit",
    signInHint: "Only the owner's key can change this page. Everyone else sees it as it is.",
    useKey: "Use this key",
    scan: "Scan with Amber or another signer app",
    openSigner: "Open in your signer app",
    waiting: "waiting for the signer…",
    pasteKey: "…or paste a key",
    keyPlaceholder: "nsec1…, ncryptsec1…, or 64 hex characters",
    ncryptsecPass: "Password for that ncryptsec",
    needKey: "Paste a key, or use a signer app above",
    checking: "checking…",
    unchanged: "Nothing has changed", saved: (n) => `Saved ${n} bytes`,
    saveFailed: "Could not save: ",
    history: "Version history",
    historyHint: "Every save is kept. Reading one opens it in a new tab; restoring it files another version, so nothing is lost.",
    historyEmpty: "Nothing saved yet, or the relays have not answered.",
    close: "Close", read: "Read", restore: "Restore",
    restoring: "restoring…", failed: "failed",
  };
  const LANG = (document.documentElement.lang || "en").slice(0, 2).toLowerCase();
  const T = { ...EN, ...(STRINGS[LANG] || {}) };
  // Dates and byte counts follow the page's language too, so a Czech page does
  // not print an American date under a Czech heading.
  const LOC = LANG === "en" ? undefined : LANG;

  const who = () => {
    const label = nc.pubkey
      ? (nc.isOwner ? T.owner + nc.npub.slice(0, 12) + "…" : T.notOwner)
      : T.readOnly;
    all("[data-nc-who]").forEach((el) => (el.textContent = label));
    all("[data-nc-signin]").forEach((el) => (el.textContent = nc.pubkey ? T.signOut : T.signIn));
  };
  nc.addEventListener("nsiteclay:login", who);
  nc.addEventListener("nsiteclay:logout", who);
  who();

  // An extension first, because it needs no typing. A signer app is offered
  // next, because the key stays on the phone. Pasting a key is the fallback.
  on("[data-nc-signin]", async () => {
    if (nc.pubkey) return nc.logout();
    if (window.nostr) {
      try { return await nc.login("nip07"); } catch { /* fall through to the rest */ }
    }
    const how = await nc.modal({
      title: T.signInTitle,
      hint: T.signInHint,
      submitLabel: T.useKey,
      build: (body, h) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = T.scan;
        b.style.cssText = "width:100%;margin-bottom:.4rem";
        b.onclick = () => {
          const { uri, ready } = nc.connectRemote();
          // Drawn in the page. A QR service would be handed the connection
          // secret, and whoever rendered the image could answer the connection.
          const img = nc.qrElement(uri, { size: 220 });
          const link = document.createElement("p");
          link.style.textAlign = "center";
          const a = document.createElement("a");
          a.href = uri; a.textContent = T.openSigner;
          link.appendChild(a);
          b.replaceWith(img, link);
          h.status(T.waiting);
          ready.then(() => h.close("done")).catch((e) => h.status(e.message, true));
        };
        body.appendChild(b);
        const key = nc.field(body, {
          label: T.pasteKey,
          type: "password",
          placeholder: T.keyPlaceholder,
        });
        const pass = nc.field(body, { label: T.ncryptsecPass, type: "password" });
        pass.parentElement.hidden = true;
        key.addEventListener("input", () => {
          pass.parentElement.hidden = !key.value.trim().startsWith("ncryptsec");
        });
        body._key = key; body._pass = pass;
      },
      onSubmit: async (h) => {
        const body = document.querySelector(".nc-ui .nc-body");
        const key = body._key.value.trim();
        if (!key) throw new Error(T.needKey);
        h.status(T.checking);
        await nc.login("nsec", { key, password: body._pass.value });
        return "done";
      },
    });
    if (how) who();
  });

  on("[data-nc-save]", async () => {
    try {
      const r = await nc.save();
      nc.toast(r.skipped ? T.unchanged : T.saved(r.bytes.toLocaleString(LOC)));
    } catch (e) { nc.toast(T.saveFailed + e.message); }
  });

  on("[data-nc-write]", () => nc.compose.open().catch((e) => nc.toast(e.message)));
  on("[data-nc-settings]", () => nc.settings.open());

  on("[data-nc-history]", async () => {
    const versions = await nc.versions();
    await nc.modal({
      title: T.history,
      hint: versions.length ? T.historyHint : T.historyEmpty,
      submitLabel: T.close,
      noCancel: true,
      build: (body) => {
        const list = document.createElement("ul");
        list.className = "nc-list";
        for (const v of versions) {
          const li = document.createElement("li");
          const b = document.createElement("b");
          b.textContent = new Date(v.created_at * 1000).toLocaleString(LOC);
          const read = document.createElement("button");
          read.type = "button"; read.textContent = T.read;
          read.onclick = async () => {
            try {
              const html = await nc.readVersion(v);
              const w = window.open("", "_blank");
              w.document.write(html); w.document.close();
            } catch (e) { nc.toast(e.message); }
          };
          const back = document.createElement("button");
          back.type = "button"; back.textContent = T.restore;
          back.onclick = async () => {
            back.disabled = true; back.textContent = T.restoring;
            try { await nc.restore(v); nc.reloadToLatest(); }
            catch (e) { back.textContent = T.failed; nc.toast(e.message); }
          };
          li.append(b, read, back);
          list.appendChild(li);
        }
        body.appendChild(list);
      },
      onSubmit: () => null,
    });
  });
})();
