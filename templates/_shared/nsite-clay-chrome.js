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

  const who = () => {
    const label = nc.pubkey
      ? (nc.isOwner ? "owner · " + nc.npub.slice(0, 12) + "…" : "signed in, not the owner")
      : "read-only";
    all("[data-nc-who]").forEach((el) => (el.textContent = label));
    all("[data-nc-signin]").forEach((el) => (el.textContent = nc.pubkey ? "Sign out" : "Sign in"));
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
      title: "Sign in to edit",
      hint: "Only the owner's key can change this page. Everyone else sees it as it is.",
      submitLabel: "Use this key",
      build: (body, h) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Scan with Amber or another signer app";
        b.style.cssText = "width:100%;margin-bottom:.4rem";
        b.onclick = () => {
          const { uri, ready } = nc.connectRemote();
          const img = document.createElement("img");
          img.alt = "Sign-in code";
          img.width = 220; img.height = 220;
          img.style.cssText = "display:block;margin:.8rem auto;background:#fff;padding:.6rem;border-radius:10px";
          img.src = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(uri);
          const link = document.createElement("p");
          link.style.textAlign = "center";
          link.innerHTML = `<a href="${uri}">Open in your signer app</a>`;
          b.replaceWith(img, link);
          h.status("waiting for the signer…");
          ready.then(() => h.close("done")).catch((e) => h.status(e.message, true));
        };
        body.appendChild(b);
        const key = nc.field(body, {
          label: "…or paste a key",
          type: "password",
          placeholder: "nsec1…, ncryptsec1…, or 64 hex characters",
        });
        const pass = nc.field(body, { label: "Password for that ncryptsec", type: "password" });
        pass.parentElement.hidden = true;
        key.addEventListener("input", () => {
          pass.parentElement.hidden = !key.value.trim().startsWith("ncryptsec");
        });
        body._key = key; body._pass = pass;
      },
      onSubmit: async (h) => {
        const body = document.querySelector(".nc-ui .nc-body");
        const key = body._key.value.trim();
        if (!key) throw new Error("Paste a key, or use a signer app above");
        h.status("checking…");
        await nc.login("nsec", { key, password: body._pass.value });
        return "done";
      },
    });
    if (how) who();
  });

  on("[data-nc-save]", async () => {
    try {
      const r = await nc.save();
      nc.toast(r.skipped ? "Nothing has changed" : `Saved ${r.bytes.toLocaleString()} bytes`);
    } catch (e) { nc.toast("Could not save: " + e.message); }
  });

  on("[data-nc-write]", () => nc.compose.open().catch((e) => nc.toast(e.message)));
  on("[data-nc-settings]", () => nc.settings.open());

  on("[data-nc-history]", async () => {
    const versions = await nc.versions();
    await nc.modal({
      title: "Version history",
      hint: versions.length
        ? "Every save is kept. Reading one opens it in a new tab; restoring it files another version, so nothing is lost."
        : "Nothing saved yet, or the relays have not answered.",
      submitLabel: "Close",
      noCancel: true,
      build: (body) => {
        const list = document.createElement("ul");
        list.className = "nc-list";
        for (const v of versions) {
          const li = document.createElement("li");
          const b = document.createElement("b");
          b.textContent = new Date(v.created_at * 1000).toLocaleString();
          const read = document.createElement("button");
          read.type = "button"; read.textContent = "Read";
          read.onclick = async () => {
            try {
              const html = await nc.readVersion(v);
              const w = window.open("", "_blank");
              w.document.write(html); w.document.close();
            } catch (e) { nc.toast(e.message); }
          };
          const back = document.createElement("button");
          back.type = "button"; back.textContent = "Restore";
          back.onclick = async () => {
            back.disabled = true; back.textContent = "restoring…";
            try { await nc.restore(v); nc.reloadToLatest(); }
            catch (e) { back.textContent = "failed"; nc.toast(e.message); }
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
