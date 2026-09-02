/* The standard toolbar, wired.
 *
 * Every template ships the same markup and none of them writes sign-in, save
 * or history code. Buttons are found by data attribute, so a template can move
 * them, restyle them, or leave any of them out.
 *
 *   data-nc-signin    sign in, or sign out when already in
 *   data-nc-save      save the page
 *   data-nc-write     the Nostr post composer
 *   data-nc-blocks    the "add a block" palette
 *   data-nc-cms       the form generated from the page's nc:cms rules, hidden
 *                     by the shared stylesheet on a page that has no rules
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
      keepOpen: "Deja esta página abierta mientras lo apruebas.",
      stillWaiting: "No llegó respuesta. Muestra un código nuevo e inténtalo otra vez.",
      retry: "Mostrar un código nuevo",
      pasteKey: "…o pega una clave",
      keyPlaceholder: "nsec1…, ncryptsec1… o 64 caracteres hex",
      ncryptsecPass: "Contraseña de ese ncryptsec",
      needKey: "Pega una clave o usa la app de firma de arriba",
      checking: "comprobando…",
      unchanged: "No ha cambiado nada", saved: (n) => `Guardado, ${n} bytes`,
      saveFailed: "No se pudo guardar",
      brokenTitle: "Guardado. Algunas direcciones de la página no llevan a ninguna parte.",
      brokenBody: "La página está publicada y el resto funciona. Corrige estos enlaces, o sube los archivos que faltan, y guarda otra vez.",
      brokenLinks: "Enlaces a páginas que no están en este sitio:",
      brokenAssets: "Archivos que la página carga y no encuentra:",
      copy: "Copiar", copied: "Copiado",
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
      keepOpen: "Túto stránku nechaj otvorenú, kým to schváliš.",
      stillWaiting: "Odpoveď neprišla. Zobraz nový kód a skús to znova.",
      retry: "Zobraziť nový kód",
      pasteKey: "…alebo vlož kľúč",
      keyPlaceholder: "nsec1…, ncryptsec1… alebo 64 hex znakov",
      ncryptsecPass: "Heslo k tomu ncryptsecu",
      needKey: "Vlož kľúč alebo použi podpisovú aplikáciu vyššie",
      checking: "kontroluje sa…",
      unchanged: "Nič sa nezmenilo", saved: (n) => `Uložené, ${n} bajtov`,
      saveFailed: "Nepodarilo sa uložiť",
      brokenTitle: "Uložené. Niektoré adresy na stránke nikam nevedú.",
      brokenBody: "Stránka je zverejnená a zvyšok funguje. Oprav tieto odkazy alebo nahraj chýbajúce súbory a ulož znova.",
      brokenLinks: "Odkazy na stránky, ktoré na tomto webe nie sú:",
      brokenAssets: "Súbory, ktoré stránka načítava a nenašla:",
      copy: "Kopírovať", copied: "Skopírované",
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
      keepOpen: "Tuhle stránku nech otevřenou, dokud to neschválíš.",
      stillWaiting: "Odpověď nedorazila. Zobraz nový kód a zkus to znovu.",
      retry: "Zobrazit nový kód",
      pasteKey: "…nebo vlož klíč",
      keyPlaceholder: "nsec1…, ncryptsec1… nebo 64 hex znaků",
      ncryptsecPass: "Heslo k tomu ncryptsecu",
      needKey: "Vlož klíč nebo použij podpisovou aplikaci výše",
      checking: "kontroluje se…",
      unchanged: "Nic se nezměnilo", saved: (n) => `Uloženo, ${n} bajtů`,
      saveFailed: "Nepodařilo se uložit",
      brokenTitle: "Uloženo. Některé adresy na stránce nikam nevedou.",
      brokenBody: "Stránka je zveřejněná a zbytek funguje. Oprav tyhle odkazy nebo nahraj chybějící soubory a ulož znovu.",
      brokenLinks: "Odkazy na stránky, které na tomhle webu nejsou:",
      brokenAssets: "Soubory, které stránka načítá a nenašla:",
      copy: "Kopírovat", copied: "Zkopírováno",
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
    keepOpen: "Keep this page open while you approve it.",
    stillWaiting: "No answer came through. Show a new code and try again.",
    retry: "Show a new code",
    pasteKey: "…or paste a key",
    keyPlaceholder: "nsec1…, ncryptsec1…, or 64 hex characters",
    ncryptsecPass: "Password for that ncryptsec",
    needKey: "Paste a key, or use a signer app above",
    checking: "checking…",
    unchanged: "Nothing has changed", saved: (n) => `Saved ${n} bytes`,
    saveFailed: "Could not save",
    brokenTitle: "Saved. Some addresses on this page lead nowhere.",
    brokenBody: "The page is published and the rest of it works. Fix these, or deploy the files that are missing, and save again.",
    brokenLinks: "Links to pages that are not in this site:",
    brokenAssets: "Files the page loads and cannot find:",
    copy: "Copy", copied: "Copied",
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
    // Held out here so that however the dialog closes, including Escape and a
    // click on the backdrop, the relay subscription behind the code is dropped.
    let attempt = null;
    let onVisible = null;

    const how = await nc.modal({
      title: T.signInTitle,
      hint: T.signInHint,
      submitLabel: T.useKey,
      build: (body, h) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = T.scan;
        b.style.cssText = "width:100%;margin-bottom:.4rem";

        const box = document.createElement("div");
        const link = document.createElement("p");
        link.style.cssText = "text-align:center;margin:.2rem 0 0";
        const a = document.createElement("a");
        link.appendChild(a);
        const note = document.createElement("p");
        note.style.cssText = "text-align:center;margin:.5rem 0 0;font-size:.8rem;opacity:.7";
        const again = document.createElement("button");
        again.type = "button";
        again.textContent = T.retry;
        again.style.cssText = "display:block;margin:.5rem auto 0";
        again.hidden = true;

        // Each press mints a fresh client key and a fresh one-time secret. The
        // old one cannot be reused: the secret is spent whether or not we saw
        // the answer, so "try again" has to mean a new code, not the same one.
        const start = () => {
          attempt?.cancel?.();
          const { uri, ready, cancel } = nc.connectRemote();
          attempt = { cancel, done: false };
          const mine = attempt;
          // Drawn in the page. A QR service would be handed the connection
          // secret, and whoever rendered the image could answer the connection.
          box.replaceChildren(nc.qrElement(uri, { size: 300 }));
          a.href = uri; a.textContent = T.openSigner;
          note.textContent = T.keepOpen;
          again.hidden = true;
          h.status(T.waiting);
          ready.then(
            () => { mine.done = true; h.close("done"); },
            (e) => {
              if (mine !== attempt) return;      // superseded by a later press
              mine.done = true;
              h.status(e?.message || String(e), true);
              again.hidden = false;
            },
          );
        };

        b.onclick = () => { b.replaceWith(box, link, note, again); start(); };
        again.onclick = start;

        // Tapping the link opens the signer app, which puts this page in the
        // background, and a backgrounded tab may have its WebSocket suspended.
        // Kind 24133 is ephemeral, so a frame that arrived while we were not
        // listening is gone and cannot be fetched back. All that is left is to
        // say so plainly and offer a fresh code.
        onVisible = () => {
          if (document.visibilityState !== "visible") return;
          if (!attempt || attempt.done) return;
          h.status(T.stillWaiting, true);
          again.hidden = false;
        };
        document.addEventListener("visibilitychange", onVisible);

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

    if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    if (!attempt?.done) attempt?.cancel?.();
    if (how) who();
  });

  // A save that failed, and a save that went through with a dead link in it,
  // both leave the person something to do about it. A toast is gone before a
  // list of fourteen paths has been read and cannot be copied into a message to
  // whoever can fix them, so those get a panel that stays until it is dismissed.
  // Listening on the status event rather than on the button means Ctrl+S and
  // autosave report the same way.
  let standing = null;
  // A site whose three shared files were assembled by hand can have this script
  // sitting on an engine older than nc.notice. A toast says less, and says it.
  const draw = nc.notice || ((message, o) => nc.toast([o?.title, message].filter(Boolean).join(" ")));
  const post = (message, opts) => {
    standing?.remove();
    standing = draw(message, {
      labels: { copy: T.copy, copied: T.copied, close: T.close },
      ...opts,
    });
  };

  nc.addEventListener("nsiteclay:status", (e) => {
    const d = e.detail || {};
    if (d.status === "error" && d.error) {
      post(String(d.error).replace(/^Error:\s*/, ""), { title: T.saveFailed, bad: true });
      return;
    }
    // A skipped save reports nothing new, so whatever is on screen stays.
    if (d.status !== "saved" || !d.missing) return;
    const groups = [[T.brokenLinks, d.missing.links], [T.brokenAssets, d.missing.assets]]
      .filter(([, list]) => list && list.length);
    if (!groups.length) { standing?.remove(); standing = null; return; }
    post(T.brokenBody, {
      title: T.brokenTitle,
      detail: groups.map(([label, list]) => [label, ...list.map((p) => "  " + p)].join("\n")).join("\n\n"),
    });
  });

  on("[data-nc-save]", async () => {
    try {
      const r = await nc.save();
      nc.toast(r.skipped ? T.unchanged : T.saved(r.bytes.toLocaleString(LOC)));
    } catch { /* the listener above has already put the reason on the screen */ }
  });

  on("[data-nc-write]", () => nc.compose.open().catch((e) => nc.toast(e.message)));
  on("[data-nc-blocks]", () => nc.blocks.open().catch((e) => nc.toast(e.message)));
  on("[data-nc-cms]", () => nc.cms.toggle());
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
