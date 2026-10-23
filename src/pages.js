// The other pages of this site, seen from this one.
//
// A site is one manifest and many documents, and each document only knows
// itself. That is the right shape for publishing and the wrong one for working
// on a site with more than one page: nothing in a page says what its siblings
// are, so moving between them, linking to one and making a new one all used to
// mean leaving the page and knowing the addresses by heart.
//
// Everything here is drawn by the runtime and marked `nc:chrome`, so it reaches
// every page through an upgrade and none of it is ever saved. Four things:
//
//   - a Pages button on the toolbar, listing the HTML paths of the live
//     manifest, with titles fetched once per hash and kept in this browser;
//   - the link dialog the text toolbar opens, listing those pages, the
//     headings on them and on this page, and taking a web address too;
//   - links that lead nowhere marked while editing, not only after a save;
//   - a new page in this page's design, empty or written by AI, published
//     together with this page in one manifest.
import { fetchVerified, hashText, uploadAll } from "./blossom.js";
import { manifestPaths, manifestServers, pathKnown } from "./manifest.js";
import { toHex } from "./config.js";
import { modal, field, checkbox, toast } from "./ui.js";

// Order: en, es, sk, cs, as in settings.js and ai-ui.js.
const WORDS = {
  pages: ["Pages", "Páginas", "Stránky", "Stránky"],
  pagesTitle: ["Pages on this site", "Páginas de este sitio", "Stránky tohto webu", "Stránky tohoto webu"],
  pagesHint: ["Every page this site publishes. Open one to edit it there; the editing controls come with you.",
    "Todas las páginas que publica este sitio. Abre una para editarla allí; los controles de edición van contigo.",
    "Všetky stránky, ktoré tento web zverejňuje. Otvor niektorú a uprav ju tam; ovládanie úprav ide s tebou.",
    "Všechny stránky, které tento web zveřejňuje. Otevři některou a uprav ji tam; ovládání úprav jde s tebou."],
  loading: ["Reading the site's pages from the relays…", "Leyendo las páginas del sitio desde los relays…",
    "Načítavam stránky webu z relayov…", "Načítám stránky webu z relayů…"],
  noTable: ["The list of this site's pages could not be read from the relays. Try again in a moment.",
    "No se pudo leer la lista de páginas del sitio desde los relays. Inténtalo de nuevo en un momento.",
    "Zoznam stránok webu sa nepodarilo načítať z relayov. Skús to o chvíľu znova.",
    "Seznam stránek webu se nepodařilo načíst z relayů. Zkus to za chvíli znovu."],
  thisPage: ["this page", "esta página", "táto stránka", "tato stránka"],
  open: ["Open", "Abrir", "Otvoriť", "Otevřít"],
  notEditable: ["not editable here", "no se edita aquí", "tu sa nedá upraviť", "tady se nedá upravit"],
  close: ["Close", "Cerrar", "Zavrieť", "Zavřít"],
  newPage: ["New page", "Página nueva", "Nová stránka", "Nová stránka"],
  newPageAi: ["New page with AI", "Página nueva con IA", "Nová stránka s AI", "Nová stránka s AI"],
  deadLinks: ["Links on this page that lead nowhere:", "Enlaces de esta página que no llevan a ninguna parte:",
    "Odkazy na tejto stránke, ktoré nikam nevedú:", "Odkazy na této stránce, které nikam nevedou:"],
  leaveTitle: ["Open {page}?", "¿Abrir {page}?", "Otvoriť {page}?", "Otevřít {page}?"],
  leaveHint: ["This page has changes that are not saved yet.", "Esta página tiene cambios que aún no se han guardado.",
    "Táto stránka má zmeny, ktoré ešte nie sú uložené.", "Tahle stránka má změny, které ještě nejsou uložené."],
  saveOpen: ["Save and open", "Guardar y abrir", "Uložiť a otvoriť", "Uložit a otevřít"],
  openAnyway: ["Open without saving", "Abrir sin guardar", "Otvoriť bez uloženia", "Otevřít bez uložení"],
  saving: ["Saving…", "Guardando…", "Ukladá sa…", "Ukládá se…"],

  linkTitle: ["Link", "Enlace", "Odkaz", "Odkaz"],
  linkHint: ["Choose a page of this site or a place on a page, or type a web address, an email address or a phone number.",
    "Elige una página de este sitio o un lugar de una página, o escribe una dirección web, un correo o un teléfono.",
    "Vyber stránku tohto webu alebo miesto na stránke, alebo napíš webovú adresu, e-mail či telefónne číslo.",
    "Vyber stránku tohoto webu nebo místo na stránce, nebo napiš webovou adresu, e-mail či telefonní číslo."],
  linkTo: ["Link to", "Enlazar a", "Odkaz na", "Odkaz na"],
  linkPlaceholder: ["/about/, https://example.com or name@example.com", "/contacto/, https://example.com o nombre@example.com",
    "/kontakt/, https://example.com alebo meno@example.com", "/kontakt/, https://example.com nebo jmeno@example.com"],
  linkApply: ["Link", "Enlazar", "Prepojiť", "Propojit"],
  removeLink: ["Remove link", "Quitar enlace", "Odstrániť odkaz", "Odstranit odkaz"],
  groupHere: ["On this page", "En esta página", "Na tejto stránke", "Na této stránce"],
  groupOn: ["On {page}", "En {page}", "Na stránke {page}", "Na stránce {page}"],
  toWeb: ["Opens {to}", "Abre {to}", "Otvorí {to}", "Otevře {to}"],
  toMail: ["Writes an email to {to}", "Escribe un correo a {to}", "Napíše e-mail na {to}", "Napíše e-mail na {to}"],
  toPhone: ["Calls {to}", "Llama a {to}", "Zavolá na {to}", "Zavolá na {to}"],
  toPage: ["A page on this site", "Una página de este sitio", "Stránka tohto webu", "Stránka tohoto webu"],
  toHere: ["A place on this page", "Un lugar de esta página", "Miesto na tejto stránke", "Místo na této stránce"],
  missingPage: ["There is no page at {path} on this site yet. The link is marked on the page until there is one.",
    "Todavía no hay ninguna página en {path}. El enlace queda marcado en la página hasta que la haya.",
    "Na adrese {path} zatiaľ nie je žiadna stránka. Odkaz zostane na stránke označený, kým tam nejaká nebude.",
    "Na adrese {path} zatím není žádná stránka. Odkaz zůstane na stránce označený, dokud tam nějaká nebude."],
  fixSlash: ["This links to {path}, with the slash at the end, which is the address every gateway serves.",
    "Esto enlaza a {path}, con la barra al final, que es la dirección que sirven todas las pasarelas.",
    "Toto odkáže na {path}, s lomkou na konci, pretože takú adresu poskytuje každá brána.",
    "Tohle odkáže na {path}, s lomítkem na konci, protože takovou adresu poskytuje každá brána."],
  missingAnchor: ["Nothing on that page is called {id}.", "Nada en esa página se llama {id}.",
    "Nič na tej stránke sa nevolá {id}.", "Nic na té stránce se nejmenuje {id}."],
  errEmpty: ["Choose a page or type an address.", "Elige una página o escribe una dirección.",
    "Vyber stránku alebo napíš adresu.", "Vyber stránku nebo napiš adresu."],
  errBad: ["That does not look like an address. Type a web address such as https://example.com or an email address, or choose a page.",
    "Eso no parece una dirección. Escribe una dirección web como https://example.com o un correo, o elige una página.",
    "Toto nevyzerá ako adresa. Napíš webovú adresu, napríklad https://example.com, alebo e-mail, prípadne vyber stránku.",
    "Tohle nevypadá jako adresa. Napiš webovou adresu, třeba https://example.com, nebo e-mail, případně vyber stránku."],
  errScheme: ["Only web addresses, email addresses and phone numbers can be linked here.",
    "Aquí solo se pueden enlazar direcciones web, correos y teléfonos.",
    "Prepojiť sa tu dajú len webové adresy, e-maily a telefónne čísla.",
    "Propojit se tu dají jen webové adresy, e-maily a telefonní čísla."],
  errMail: ["That email address is not complete.", "Esa dirección de correo no está completa.",
    "Táto e-mailová adresa nie je úplná.", "Tahle e-mailová adresa není úplná."],
  errPhone: ["That phone number is not complete.", "Ese número de teléfono no está completo.",
    "Toto telefónne číslo nie je úplné.", "Tohle telefonní číslo není úplné."],

  newTitle: ["New page in this design", "Página nueva con este diseño", "Nová stránka v tomto dizajne", "Nová stránka v tomto designu"],
  newHint: ["The new page gets this page's design, header, footer and blocks, with an empty area for its own content. It is published together with this page.",
    "La página nueva recibe el diseño, la cabecera, el pie y los bloques de esta página, con un espacio vacío para su propio contenido. Se publica junto con esta página.",
    "Nová stránka dostane dizajn, hlavičku, pätičku a bloky tejto stránky a prázdne miesto pre vlastný obsah. Zverejní sa spolu s touto stránkou.",
    "Nová stránka dostane design, záhlaví, zápatí a bloky této stránky a prázdné místo pro vlastní obsah. Zveřejní se spolu s touto stránkou."],
  newAiHint: ["AI writes the content of the new page in this page's design. The header, footer and stylesheet are copied from this page as they are. You see a preview before anything is published.",
    "La IA escribe el contenido de la página nueva con el diseño de esta. La cabecera, el pie y la hoja de estilos se copian de esta página tal como están. Verás una vista previa antes de publicar nada.",
    "AI napíše obsah novej stránky v dizajne tejto stránky. Hlavička, pätička a štýly sa skopírujú z tejto stránky bez zmeny. Pred zverejnením uvidíš náhľad.",
    "AI napíše obsah nové stránky v designu této stránky. Záhlaví, zápatí a styly se zkopírují z této stránky beze změny. Před zveřejněním uvidíš náhled."],
  pageTitle: ["Title", "Título", "Názov", "Název"],
  titlePlaceholder: ["Catering", "Catering", "Catering", "Catering"],
  address: ["Address", "Dirección", "Adresa", "Adresa"],
  addressFree: ["The page will be at {path}", "La página estará en {path}", "Stránka bude na adrese {path}", "Stránka bude na adrese {path}"],
  addressTaken: ["There is already a page at {path}. Choose another address.", "Ya hay una página en {path}. Elige otra dirección.",
    "Na adrese {path} už stránka je. Vyber inú adresu.", "Na adrese {path} už stránka je. Vyber jinou adresu."],
  addressBad: ["Use lowercase letters, digits and hyphens, like /catering/.", "Usa minúsculas, cifras y guiones, como /catering/.",
    "Použi malé písmená, číslice a spojovníky, napríklad /catering/.", "Použij malá písmena, číslice a spojovníky, třeba /catering/."],
  needTitle: ["Give the page a title.", "Ponle un título a la página.", "Daj stránke názov.", "Dej stránce název."],
  addToMenu: ["Add it to this page's menu", "Añadirla al menú de esta página", "Pridať ju do menu tejto stránky", "Přidat ji do menu této stránky"],
  menuNote: ["Only this page's menu changes now. Your other pages keep their menus until you add the link there too.",
    "Ahora solo cambia el menú de esta página. Las demás páginas conservan su menú hasta que añadas el enlace también allí.",
    "Teraz sa zmení len menu tejto stránky. Ostatné stránky majú pôvodné menu, kým do nich odkaz nepridáš.",
    "Teď se změní jen menu této stránky. Ostatní stránky mají původní menu, dokud do nich odkaz nepřidáš."],
  noMenu: ["This page has no menu to add the new page to. Link to it from any text with the link button.",
    "Esta página no tiene un menú al que añadir la página nueva. Enlázala desde cualquier texto con el botón de enlace.",
    "Táto stránka nemá menu, do ktorého by sa nová stránka dala pridať. Prepoj ju z ľubovoľného textu tlačidlom odkazu.",
    "Tahle stránka nemá menu, do kterého by šla nová stránka přidat. Propoj ji z libovolného textu tlačítkem odkazu."],
  dirtyNote: ["This page has unsaved changes. They are published together with the new page.",
    "Esta página tiene cambios sin guardar. Se publican junto con la página nueva.",
    "Táto stránka má neuložené zmeny. Zverejnia sa spolu s novou stránkou.",
    "Tahle stránka má neuložené změny. Zveřejní se spolu s novou stránkou."],
  create: ["Create and publish", "Crear y publicar", "Vytvoriť a zverejniť", "Vytvořit a zveřejnit"],
  noArea: ["This page has no block area and no <main>, so there is no place to leave empty for the new page's content.",
    "Esta página no tiene área de bloques ni <main>, así que no hay un lugar que dejar vacío para el contenido de la página nueva.",
    "Táto stránka nemá oblasť blokov ani <main>, takže nie je kde nechať prázdne miesto pre obsah novej stránky.",
    "Tahle stránka nemá oblast bloků ani <main>, takže není kde nechat prázdné místo pro obsah nové stránky."],
  writeHere: ["Write here.", "Escribe aquí.", "Píš sem.", "Piš sem."],
  publishing: ["Publishing the new page…", "Publicando la página nueva…", "Zverejňujem novú stránku…", "Zveřejňuji novou stránku…"],
  publishedTitle: ["The new page is published", "La página nueva está publicada", "Nová stránka je zverejnená", "Nová stránka je zveřejněná"],
  publishedHint: ["It opens here, with the editing controls, as soon as the gateway serves it.",
    "Se abrirá aquí, con los controles de edición, en cuanto la pasarela la sirva.",
    "Otvorí sa tu aj s ovládaním úprav, hneď ako ju brána začne poskytovať.",
    "Otevře se tady i s ovládáním úprav, hned jak ji brána začne poskytovat."],
  catchingUp: ["Waiting for the gateway…", "Esperando a la pasarela…", "Čakám na bránu…", "Čekám na bránu…"],
  slowGateway: ["The gateway has not caught up yet. The page is published; open it in a minute.",
    "La pasarela aún no se ha puesto al día. La página está publicada; ábrela dentro de un minuto.",
    "Brána to ešte nestihla. Stránka je zverejnená, otvor ju o minútu.",
    "Brána to ještě nestihla. Stránka je zveřejněná, otevři ji za minutu."],
  openNow: ["Open it now", "Abrirla ahora", "Otvoriť teraz", "Otevřít teď"],
  describePage: ["What should be on the new page?", "¿Qué debe haber en la página nueva?", "Čo má byť na novej stránke?", "Co má být na nové stránce?"],
  describePlaceholder: ["Catering for weddings and offices, a short menu, prices on request, and how to get in touch",
    "Catering para bodas y oficinas, un menú corto, precios a consultar y cómo contactarnos",
    "Catering na svadby a do kancelárií, krátke menu, ceny na požiadanie a ako nás kontaktovať",
    "Catering na svatby a do kanceláří, krátké menu, ceny na vyžádání a jak nás kontaktovat"],
  needDescription: ["Describe what the page should say.", "Describe lo que debe decir la página.", "Opíš, čo má stránka hovoriť.", "Popiš, co má stránka říkat."],
  previewHint: ["The new page with this site's header, footer and design. Nothing is published until you press Publish this page.",
    "La página nueva con la cabecera, el pie y el diseño de este sitio. No se publica nada hasta que pulses Publicar esta página.",
    "Nová stránka s hlavičkou, pätičkou a dizajnom tohto webu. Kým nestlačíš Zverejniť túto stránku, nič sa nezverejní.",
    "Nová stránka se záhlavím, zápatím a designem tohoto webu. Dokud nestiskneš Zveřejnit tuto stránku, nic se nezveřejní."],
  publishPage: ["Publish this page", "Publicar esta página", "Zverejniť túto stránku", "Zveřejnit tuto stránku"],
  backDescription: ["Back to my description", "Volver a mi descripción", "Späť k môjmu popisu", "Zpět k mému popisu"],
  lastPreview: ["Show my last preview", "Ver mi última vista previa", "Zobraziť môj posledný náhľad", "Zobrazit můj poslední náhled"],
};

const CACHE = "nsite-clay.page-info";
const CACHE_MAX = 300;
const SKIP = "[nc\\:chrome], .nc-ui-chrome, template, [nc\\:transient]";
const HEADINGS = "h1, h2, h3, h4";
const ACTIVE = ["active", "current", "is-active", "is-current", "selected"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An HTML document in the path table, as opposed to a picture or the engine. */
export const isPage = (path) => /\.html?$/i.test(path);

/** The address a reader types for a path: `/about/index.html` is `/about/`. */
export const hrefOf = (path) => String(path).replace(/(^|\/)index\.html?$/i, "$1");

/** Words to an address segment: "Opening hours" is "opening-hours". */
export function slugify(text) {
  return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
}

/**
 * What somebody typed as the address of a new page, as a path in the table.
 * `catering`, `/catering` and `/catering/` are all `/catering/index.html`;
 * `/catering.html` stays a file. Null when it is not something to publish at.
 */
export function pathFor(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/[?#].*$/, "");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/{2,}/g, "/");
  if (!/\.html?$/.test(s)) s = s.replace(/\/?$/, "/") + "index.html";
  const segments = s.split("/").slice(1);
  if (!segments.every((x) => /^[a-z0-9][a-z0-9._-]*$/.test(x) && !/\.\./.test(x))) return null;
  return s;
}

/**
 * What somebody typed into the link box, as an href, or the reason it is not
 * one. A page of this site, a place on this page, a web address with or
 * without its https://, an email address and a phone number all work; any
 * other kind of address is refused, as the sanitiser would refuse it.
 */
export function normalizeLink(raw, { origin = "" } = {}) {
  const s = String(raw || "").trim();
  if (!s) return { error: "errEmpty" };
  if (s.startsWith("#")) return s.length > 1 && !/\s/.test(s) ? { href: s, kind: "here" } : { error: "errEmpty" };
  if (s.startsWith("/") && !s.startsWith("//")) return /\s/.test(s) ? { error: "errBad" } : { href: s, kind: "page" };
  if (/^mailto:/i.test(s)) return /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(s) ? { href: s, kind: "mail", to: s.slice(7) } : { error: "errMail" };
  if (/^tel:/i.test(s)) {
    const n = s.slice(4).replace(/[\s().-]/g, "");
    return /^\+?\d{3,}$/.test(n) ? { href: "tel:" + n, kind: "phone", to: n } : { error: "errPhone" };
  }
  if (/^[^\s@/:]+@[^\s@/]+\.[a-z]{2,}$/i.test(s)) return { href: "mailto:" + s, kind: "mail", to: s };
  if (/^\+?\d[\d\s().-]{5,}$/.test(s) && s.replace(/\D/g, "").length >= 6) {
    const n = s.replace(/[\s().-]/g, "");
    return { href: "tel:" + n, kind: "phone", to: n };
  }
  const web = /^https?:\/\//i.test(s);
  if (!web && /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d/.test(s)) return { error: "errScheme" };
  const candidate = web ? s : "https://" + s.replace(/^\/\//, "");
  let url;
  try { url = new URL(candidate); } catch { return { error: "errBad" }; }
  if (/\s/.test(s) || !(url.hostname.includes(".") || url.hostname === "localhost")) return { error: "errBad" };
  if (origin && url.origin === origin) return { href: (url.pathname || "/") + url.search + url.hash, kind: "page" };
  return { href: candidate, kind: "web", to: candidate };
}

/** Title, headings and every id of a document, which is all a link needs. */
export function readInfo(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const own = (el) => !el.closest(SKIP);
  return {
    t: (doc.title || "").trim().slice(0, 120),
    o: toHex(doc.documentElement.getAttribute("nc:owner") || "") || "",
    h: [...doc.querySelectorAll(HEADINGS)].filter((el) => own(el) && el.id && el.textContent.trim())
      .slice(0, 60).map((el) => [el.id, el.textContent.replace(/\s+/g, " ").trim().slice(0, 80)]),
    ids: [...doc.querySelectorAll("[id]")].filter(own).slice(0, 600).map((el) => el.id),
  };
}

export class Pages {
  constructor(nc) {
    this.nc = nc;
    this.doc = nc.doc;
    this._table = null;
    this._info = new Map();
  }

  say(key, vars = {}) {
    const lang = ["en", "es", "sk", "cs"].indexOf((this.doc.documentElement.lang || "en").slice(0, 2).toLowerCase());
    let text = WORDS[key]?.[Math.max(lang, 0)] || WORDS[key]?.[0] || key;
    for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(v);
    return text;
  }

  get active() { return this.nc.isOwner && this.nc.editRequested; }

  start() {
    const sync = () => { this.syncButton(); this.syncMarks(); };
    for (const e of ["nsiteclay:login", "nsiteclay:logout", "nsiteclay:edit-gate"]) this.nc.addEventListener(e, sync);
    // A save publishes the table it was built from, which is the freshest one
    // this tab can have.
    this.nc.addEventListener("nsiteclay:status", (e) => {
      if (e.detail?.status === "saved" && e.detail.manifest) {
        this._table = manifestPaths(e.detail.manifest);
        this.mark();
      }
    });
    sync();
  }

  // ---- the path table ------------------------------------------------------

  /** The union of every table this tab has seen, the way a save builds it. */
  async table({ fresh = false } = {}) {
    if (!this.nc.cfg.owner) return {};
    if (this._table && !fresh) return this._table;
    if (!this._loading || fresh) {
      this._loading = this.nc._currentPaths()
        .then((t) => { if (Object.keys(t).length) this._table = { ...(this._table || {}), ...t }; return this._table || {}; })
        .catch(() => this._table || {})
        .finally(() => { this._loading = null; });
    }
    return this._loading;
  }

  servers() {
    const from = this.nc._manifest ? manifestServers(this.nc._manifest) : [];
    return [...new Set([...from, ...this.nc.cfg.servers])];
  }

  /** The site's documents, this one first, then by address. */
  list(table = this._table || {}) {
    const here = this.nc.cfg.path;
    const paths = Object.keys(table).filter(isPage);
    if (!paths.includes(here)) paths.push(here);
    return paths.map((path) => ({ path, href: hrefOf(path), hash: table[path] || null, current: path === here }))
      .sort((a, b) => (b.current - a.current) || a.href.localeCompare(b.href));
  }

  readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE) || "{}") || {}; } catch { return {}; }
  }

  writeCache(hash, info) {
    try {
      const all = this.readCache();
      all[hash] = { ...info, at: Date.now() };
      const keys = Object.keys(all);
      if (keys.length > CACHE_MAX) {
        for (const k of keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - CACHE_MAX)) delete all[k];
      }
      localStorage.setItem(CACHE, JSON.stringify(all));
    } catch { /* a convenience: without it, titles are fetched again next time */ }
  }

  ownInfo() {
    return { t: (this.doc.title || "").trim(), o: this.nc.cfg.owner || "",
      h: [...this.doc.querySelectorAll(HEADINGS)].filter((el) => !el.closest(SKIP) && el.textContent.trim())
        .map((el) => [el.id || "", el.textContent.replace(/\s+/g, " ").trim().slice(0, 80), el]),
      ids: [...this.doc.querySelectorAll("[id]")].filter((el) => !el.closest(SKIP)).map((el) => el.id) };
  }

  /**
   * Title and headings of a page, by its hash. A hash never changes meaning,
   * so what is read once is kept for good and only a page changed since is
   * fetched again. The bytes come from Blossom and are checked against the
   * hash, so no server and no gateway is trusted for them.
   */
  info(page) {
    if (page.current) return Promise.resolve(this.ownInfo());
    if (!page.hash) return Promise.resolve(null);
    if (this._info.has(page.hash)) return this._info.get(page.hash);
    const cached = this.readCache()[page.hash];
    const p = cached ? Promise.resolve(cached)
      : fetchVerified(this.servers(), page.hash, { timeouts: { get: 15000 } })
        .then((html) => { const info = readInfo(html); this.writeCache(page.hash, info); return info; })
        .catch(() => { this._info.delete(page.hash); return null; });
    this._info.set(page.hash, p);
    return p;
  }

  /** Fill in titles a few at a time, calling `each(page, info)` as they land. */
  async infos(pages, each = () => {}) {
    const queue = pages.filter((p) => !p.current);
    const worker = async () => {
      while (queue.length) { const p = queue.shift(); const info = await this.info(p); if (info) each(p, info); }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  }

  cachedInfo(path) {
    const hash = this._table?.[path];
    if (!hash) return null;
    return this.readCache()[hash] || null;
  }

  // ---- the toolbar button --------------------------------------------------

  syncButton() {
    if (!this.active) { this.button?.remove(); this.button = null; return; }
    const bar = this.doc.querySelector(".nc-bar");
    if (!bar || this.button?.isConnected) return;
    const b = this.doc.createElement("button");
    b.type = "button";
    b.setAttribute("nc:chrome", "");
    b.dataset.ncPages = "";
    b.textContent = this.say("pages");
    b.onclick = () => this.open().catch((e) => toast(e.message, { doc: this.doc }));
    const before = bar.querySelector("[data-nc-ai]") || bar.querySelector("[data-nc-save]");
    if (before) before.before(b); else bar.append(b);
    this.button = b;
  }

  // ---- the Pages dialog ----------------------------------------------------

  open() {
    if (!this._opening) this._opening = this.dialog().finally(() => { this._opening = null; });
    return this._opening;
  }

  async dialog() {
    const say = (k, v) => this.say(k, v);
    const picked = await modal({
      doc: this.doc, title: say("pagesTitle"), hint: say("pagesHint"), submitLabel: say("close"), noCancel: true,
      build: (body, h) => {
        const tools = this.doc.createElement("div");
        tools.className = "nc-row";
        for (const [key, value] of [["newPage", "new"], ["newPageAi", "new-ai"]]) {
          const b = this.doc.createElement("button");
          b.type = "button"; b.textContent = say(key); b.dataset.ncPagesAction = value;
          b.onclick = () => h.close({ action: value });
          tools.append(b);
        }
        const list = this.doc.createElement("ul");
        list.className = "nc-list nc-pages";
        const dead = this.doc.createElement("p");
        dead.className = "nc-hint nc-bad"; dead.hidden = true;
        body.append(list, dead, tools);

        const rows = new Map();
        const draw = (pages) => {
          list.replaceChildren();
          for (const page of pages) {
            const li = this.doc.createElement("li");
            if (page.current) li.className = "nc-here";
            li.dataset.path = page.path;
            const text = this.doc.createElement("span");
            text.className = "nc-page-text";
            const name = this.doc.createElement("b");
            name.textContent = page.current ? (this.doc.title || page.href) : page.href;
            const where = this.doc.createElement("small");
            where.className = "nc-path"; where.textContent = page.href;
            text.append(name, where);
            li.append(text);
            if (page.current) {
              const tag = this.doc.createElement("span");
              tag.className = "nc-tag"; tag.textContent = say("thisPage");
              li.append(tag);
            } else {
              const go = this.doc.createElement("button");
              go.type = "button"; go.textContent = say("open");
              go.onclick = () => h.close({ open: page });
              li.append(go);
            }
            list.append(li);
            rows.set(page.path, { li, name, page });
          }
        };
        draw(this.list());
        h.status(say("loading"));
        this.table({ fresh: true }).then(async (table) => {
          if (!list.isConnected) return;
          h.status(Object.keys(table).length ? "" : say("noTable"), !Object.keys(table).length);
          const pages = this.list(table);
          draw(pages);
          const bad = this.deadLinks();
          if (bad.length) { dead.hidden = false; dead.textContent = `${say("deadLinks")} ${bad.join(", ")}`; }
          await this.infos(pages, (page, info) => {
            const row = rows.get(page.path);
            if (!row || !list.isConnected) return;
            if (info.t) row.name.textContent = info.t;
            page.title = info.t;
            if (info.o !== this.nc.cfg.owner) {
              page.foreign = true;
              const tag = this.doc.createElement("span");
              tag.className = "nc-tag"; tag.textContent = say("notEditable");
              row.li.querySelector("button")?.before(tag);
            }
          });
        });
      },
      onSubmit: () => null,
    });
    if (!picked) return null;
    if (picked.open) return this.openPage(picked.open);
    if (picked.action === "new") return this.newPage({ ai: false });
    if (picked.action === "new-ai") return this.newPage({ ai: true });
    return null;
  }

  /**
   * Go to another page of the site, with the editing controls open there.
   *
   * A normal page load. The browser's own "leave this page?" would do for
   * unsaved work, but it cannot offer to save it, so this asks first.
   */
  async openPage(page) {
    const href = page.href || hrefOf(page.path);
    const target = href + (page.foreign ? "" : "#edit");
    if (this.nc.dirty) {
      const how = await modal({
        doc: this.doc, title: this.say("leaveTitle", { page: page.title || href }), hint: this.say("leaveHint"),
        submitLabel: this.say("saveOpen"),
        build: (body, h) => {
          const anyway = this.doc.createElement("button");
          anyway.type = "button"; anyway.textContent = this.say("openAnyway");
          anyway.dataset.ncDiscard = "";
          anyway.onclick = () => h.close("discard");
          body.append(anyway);
        },
        onSubmit: async (h) => { h.status(this.say("saving")); await this.nc.save(); return "saved"; },
      });
      if (!how) return false;
      // The work is being left on purpose, so the browser's own question about
      // it would only ask again.
      if (how === "discard") this.nc.dirty = false;
    }
    this.go(target);
    return true;
  }

  go(href) { this.doc.defaultView.location.assign(href); }

  // ---- links that lead nowhere, while editing ------------------------------

  syncMarks() {
    if (!this.active) {
      this._observer?.disconnect(); this._observer = null;
      for (const a of this.doc.querySelectorAll("[nc\\:dead]")) a.removeAttribute("nc:dead");
      return;
    }
    if (this._observer) return;
    this.styles();
    let timer = null;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => this.mark(), 250); };
    this._observer = new MutationObserver(later);
    this._observer.observe(this.doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["href", "id"] });
    this.mark();
    this.table().then(() => this.mark());
  }

  styles() {
    if (this.doc.querySelector("style[nc\\:pages-style]")) return;
    const el = this.doc.createElement("style");
    el.setAttribute("nc:chrome", ""); el.setAttribute("nc:pages-style", "");
    // Dashed and red, the way a spelling mistake is marked: noticed while
    // writing, never seen by a reader, because the attribute is not saved.
    el.textContent = `html[nc\\:editing="true"] a[nc\\:dead] { outline: 2px dashed var(--nc-bad, #e0565b); outline-offset: 2px; text-decoration-style: wavy; text-decoration-color: var(--nc-bad, #e0565b); }`;
    this.doc.head.append(el);
  }

  /**
   * Why a link leads nowhere, or null when it leads somewhere or this page
   * cannot tell. "page": nothing at that address. "slash": a directory named
   * without its trailing slash. "anchor": no such place on the page.
   */
  reason(href, table = this._table) {
    const value = String(href || "").trim();
    if (!value || /^(mailto|tel|https?|javascript|data|lightning|nostr):/i.test(value) && !this.sameOrigin(value)) return null;
    if (value === "#" || /^#(top|edit)\b/i.test(value)) return null;
    if (value.startsWith("#")) {
      let id = value.slice(1);
      try { id = decodeURIComponent(id); } catch { /* as written */ }
      return this.doc.getElementById(id) ? null : "anchor";
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !this.sameOrigin(value)) return null;
    if (!table || !Object.keys(table).length) return null;
    let url;
    try { url = new URL(value, new URL(this.nc.cfg.path, this.doc.location.origin === "null" ? "http://x" : this.doc.location.origin)); }
    catch { return null; }
    let path = url.pathname;
    try { path = decodeURI(path); } catch { /* as written */ }
    const have = new Set(Object.keys(table));
    have.add(this.nc.cfg.path);
    if (!pathKnown(have, path)) {
      const last = path.slice(path.lastIndexOf("/") + 1);
      if (!path.endsWith("/") && !/\.[a-z0-9]+$/i.test(last) && have.has(path + "/index.html")) return "slash";
      return "page";
    }
    const id = url.hash.slice(1);
    if (!id || /^(top|edit)\b/i.test(id)) return null;
    const target = path.endsWith("/") ? path + "index.html" : path;
    let name = id;
    try { name = decodeURIComponent(id); } catch { /* as written */ }
    if (target === this.nc.cfg.path) return this.doc.getElementById(name) ? null : "anchor";
    const info = this.cachedInfo(target);
    return info && !info.ids?.includes(name) ? "anchor" : null;
  }

  sameOrigin(value) {
    try { return new URL(value).origin === this.doc.location.origin && this.doc.location.origin !== "null"; } catch { return false; }
  }

  links() {
    return [...this.doc.querySelectorAll("a[href]")].filter((a) => !a.closest(SKIP));
  }

  mark() {
    if (!this.active) return;
    for (const a of this.links()) {
      const why = this.reason(a.getAttribute("href"));
      if (why) { if (a.getAttribute("nc:dead") !== why) a.setAttribute("nc:dead", why); }
      else if (a.hasAttribute("nc:dead")) a.removeAttribute("nc:dead");
    }
  }

  deadLinks() {
    return [...new Set(this.links().filter((a) => this.reason(a.getAttribute("href"))).map((a) => a.getAttribute("href")))];
  }

  // ---- the link dialog -----------------------------------------------------

  /**
   * Ask where a link should go. Resolves to { href }, to { remove: true } when
   * the owner chose to take an existing link away, or null.
   */
  async pickLink({ href = "", remove = false } = {}) {
    const say = (k, v) => this.say(k, v);
    const original = href;
    let input, note, chosen = null, table = this._table || {};
    const pages = () => this.list(table);
    const titles = new Map();
    const explain = () => {
      const value = input.value.trim();
      if (!value || value === original) { note.textContent = ""; note.classList.remove("nc-bad"); return; }
      if (chosen?.el && !chosen.el.id) { note.textContent = say("toHere"); note.classList.remove("nc-bad"); return; }
      const r = normalizeLink(value, { origin: this.doc.location.origin });
      let text = "", bad = false;
      if (r.error) text = "";
      else if (r.kind === "web") text = say("toWeb", { to: r.to });
      else if (r.kind === "mail") text = say("toMail", { to: r.to });
      else if (r.kind === "phone") text = say("toPhone", { to: r.to });
      else {
        const why = this.reason(r.href, table);
        const fixed = this.fixSlash(r.href, table);
        if (fixed !== r.href) text = say("fixSlash", { path: fixed });
        else if (why === "page") { text = say("missingPage", { path: r.href.split("#")[0] }); bad = true; }
        else if (why === "anchor") { text = say("missingAnchor", { id: decodeURIComponent(r.href.split("#")[1] || "") }); bad = true; }
        else text = say(r.kind === "here" ? "toHere" : "toPage");
      }
      note.textContent = text; note.classList.toggle("nc-bad", bad);
    };

    return modal({
      doc: this.doc, title: say("linkTitle"), hint: say("linkHint"), submitLabel: say("linkApply"),
      build: (body, h) => {
        input = field(body, { label: say("linkTo"), value: href, placeholder: say("linkPlaceholder") });
        input.autocomplete = "off"; input.spellcheck = false;
        input.dataset.ncLink = "";
        note = this.doc.createElement("p");
        note.className = "nc-hint nc-link-note"; note.setAttribute("aria-live", "polite");
        note.style.margin = ".4rem 0 .6rem";
        const list = this.doc.createElement("ul");
        list.className = "nc-pick nc-link-pick";
        body.append(note, list);
        if (remove) {
          const row = this.doc.createElement("div"); row.className = "nc-row"; row.style.marginTop = ".7rem";
          const b = this.doc.createElement("button");
          b.type = "button"; b.textContent = say("removeLink"); b.dataset.ncUnlink = "";
          b.onclick = () => h.close({ remove: true });
          row.append(b); body.append(row);
        }
        const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
        const options = () => {
          const out = [];
          const here = this.ownInfo();
          for (const p of pages()) {
            out.push({ group: say("pagesTitle"), label: p.current ? here.t || p.href : titles.get(p.path)?.t || p.href, href: p.href, mark: "/" });
          }
          for (const [id, text, el] of here.h) out.push({ group: say("groupHere"), label: text, href: id ? "#" + id : "", el, mark: "#" });
          for (const p of pages()) {
            const info = titles.get(p.path);
            if (p.current || !info?.h?.length) continue;
            for (const [id, text] of info.h) out.push({ group: say("groupOn", { page: info.t || p.href }), label: text, href: `${p.href}#${id}`, mark: "#" });
          }
          return out;
        };
        const render = (filter = "") => {
          const f = fold(filter);
          list.replaceChildren();
          let group = null;
          for (const o of options()) {
            if (f && !fold(o.label).includes(f) && !fold(o.href).includes(f)) continue;
            if (o.group !== group) {
              group = o.group;
              const g = this.doc.createElement("li");
              g.className = "nc-pick-group"; g.textContent = group;
              list.append(g);
            }
            const li = this.doc.createElement("li");
            const b = this.doc.createElement("button");
            b.type = "button";
            const mark = this.doc.createElement("span"); mark.className = "nc-mark"; mark.textContent = o.mark;
            const text = this.doc.createElement("span"); text.className = "nc-body-text";
            const name = this.doc.createElement("b"); name.textContent = o.label;
            // A heading with no id yet shows the one it would be given.
            const where = this.doc.createElement("small"); where.textContent = o.href || "#" + this.anchorFor(o.el, { dry: true });
            text.append(name, where);
            b.append(mark, text);
            const on = chosen ? (chosen.el ? chosen.el === o.el : chosen.href === o.href) : (!!o.href && o.href === input.value.trim());
            b.setAttribute("aria-pressed", String(!!on));
            b.onclick = () => {
              chosen = o;
              input.value = o.href || "#" + this.anchorFor(o.el, { dry: true });
              for (const x of list.querySelectorAll("button")) x.setAttribute("aria-pressed", "false");
              b.setAttribute("aria-pressed", "true");
              explain();
            };
            b.ondblclick = () => list.closest("form")?.requestSubmit();
            li.append(b); list.append(li);
          }
        };
        input.addEventListener("input", () => { chosen = null; render(input.value === original ? "" : input.value); explain(); });
        render();
        explain();
        this.table().then(async (t) => {
          table = t;
          if (!list.isConnected) return;
          render(input.value === original || chosen ? "" : input.value); explain();
          await this.infos(pages(), (p, info) => {
            titles.set(p.path, info);
            if (list.isConnected) render(input.value === original || chosen ? "" : input.value);
          });
        });
      },
      onSubmit: () => {
        const value = input.value.trim();
        if (value && value === original) return { href: original };
        // A heading picked from this page that has no id gets one now, made from
        // its words. That is an edit to the page, so the page becomes unsaved.
        if (chosen?.el && !chosen.el.id) return { href: "#" + this.anchorFor(chosen.el) };
        const r = normalizeLink(value, { origin: this.doc.location.origin });
        if (r.error) throw new Error(say(r.error));
        return { href: r.kind === "page" ? this.fixSlash(r.href, table) : r.href };
      },
    });
  }

  /** `/about` becomes `/about/` when that is the page there. */
  fixSlash(href, table = this._table) {
    if (!table) return href;
    const [path, ...rest] = href.split("#");
    const hash = rest.length ? "#" + rest.join("#") : "";
    const last = path.slice(path.lastIndexOf("/") + 1);
    if (path.endsWith("/") || /\.[a-z0-9]+$/i.test(last)) return href;
    if (table[path + "/index.html"]) return path + "/" + hash;
    if (table[path + ".html"] && !table[path]) return path + ".html" + hash;
    return href;
  }

  /** An id for a heading, from its words, unique on the page. */
  anchorFor(el, { dry = false } = {}) {
    if (!el) return "";
    if (el.id) return el.id;
    const base = slugify(el.textContent) || "section";
    let id = base, n = 1;
    while (this.doc.getElementById(id)) id = `${base}-${++n}`;
    if (!dry) { this.nc.undo.commit("Anchor", () => el.setAttribute("id", id)); this.nc.dirty = true; }
    return id;
  }

  // ---- a new page in this design -------------------------------------------

  /** The menu a new page is added to: an nc:nav, a <nav> in a header, any <nav>. */
  findMenu(doc = this.doc) {
    const blocks = [...doc.querySelectorAll("[nc\\:blocks]")];
    const navs = [...doc.querySelectorAll("[nc\\:nav], nav")].filter((n) =>
      !n.closest(SKIP) && !blocks.some((b) => b.contains(n)) && n.querySelector("a[href]"));
    return navs.find((n) => n.hasAttribute("nc:nav")) || navs.find((n) => n.closest("header")) || navs[0] || null;
  }

  /**
   * Add a link to a menu, shaped like the menu's last item so it takes the
   * menu's styling: a list item if the links are in a list, the separator the
   * links are spaced with if they are not. `current` marks it as the page the
   * menu is on, taking the mark off whichever item had it.
   */
  addMenuItem(nav, href, title, { current = false } = {}) {
    const doc = nav.ownerDocument;
    const last = [...nav.querySelectorAll("a[href]")].at(-1);
    const li = last.closest("li");
    const item = li && nav.contains(li) ? li : last;
    const clone = item.cloneNode(true);
    const a = clone.matches("a") ? clone : clone.querySelector("a");
    for (const extra of [...clone.querySelectorAll("a")]) if (extra !== a) extra.remove();
    for (const el of [clone, ...clone.querySelectorAll("*")]) {
      el.removeAttribute("aria-current"); el.removeAttribute("id"); el.removeAttribute("nc:dead");
      for (const c of ACTIVE) el.classList.remove(c);
      if (el.getAttribute("class") === "") el.removeAttribute("class");
    }
    a.setAttribute("href", href);
    a.textContent = title;
    if (current) {
      const marked = nav.querySelector('[aria-current], .active, .current, .is-active, .is-current, .selected');
      if (marked) {
        const classes = ACTIVE.filter((c) => marked.classList.contains(c));
        const target = marked.matches("li") && clone.matches("li") ? clone : a;
        for (const c of classes) { marked.classList.remove(c); target.classList.add(c); }
        if (marked.getAttribute("class") === "") marked.removeAttribute("class");
        if (marked.hasAttribute("aria-current")) { marked.removeAttribute("aria-current"); a.setAttribute("aria-current", "page"); }
      }
      for (const el of nav.querySelectorAll("[aria-current]")) if (el !== a) el.removeAttribute("aria-current");
      a.setAttribute("aria-current", "page");
    }
    const gap = item.previousSibling?.nodeType === 3 ? item.previousSibling.textContent : "";
    item.after(clone);
    if (gap) item.after(doc.createTextNode(gap));
    return clone;
  }

  /** The first block of a new page: the library's first shape with a heading, titled. */
  starter(doc, title) {
    const shapes = [...doc.querySelectorAll("template[nc\\:block]")];
    const shape = shapes.find((t) => !t.getAttribute("nc:on-add") && t.content.querySelector("h1, h2, h3"));
    let node = shape?.content.firstElementChild ? doc.importNode(shape.content.firstElementChild, true) : null;
    if (node) {
      node.setAttribute("nc:block-type", shape.getAttribute("nc:block"));
      node.querySelector("h1, h2, h3").textContent = title;
      return node;
    }
    node = doc.createElement("section");
    const h = doc.createElement("h1"); h.setAttribute("editable", "single-line"); h.textContent = title;
    const words = doc.createElement("div"); words.setAttribute("editable", "");
    const p = doc.createElement("p"); p.textContent = this.say("writeHere"); words.append(p);
    node.append(h, words);
    return node;
  }

  /**
   * A new document from this one: its head and stylesheet, header, menu,
   * footer, block library and toolbar, with the block area emptied and
   * `content` (or a titled first block) in it. Nothing of the live page is
   * touched.
   */
  shell({ title, path, menu = false, content = null }) {
    const doc = new DOMParser().parseFromString(this.nc.getHTML(), "text/html");
    const root = doc.documentElement;
    root.setAttribute("nc:path", path);
    let t = doc.querySelector("title");
    if (!t) { t = doc.createElement("title"); doc.head.append(t); }
    t.textContent = title;
    // What described the old page would describe the new one wrongly.
    for (const el of doc.head.querySelectorAll('meta[name="description"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"]')) el.remove();
    this.absolutize(doc, this.nc.cfg.path);
    const area = doc.querySelector("[nc\\:blocks]") || doc.querySelector("main");
    if (!area) throw new Error(this.say("noArea"));
    area.replaceChildren();
    if (content != null) {
      const holder = doc.createElement("template");
      holder.innerHTML = content;
      area.append(doc.importNode(holder.content, true));
    } else area.append(this.starter(doc, title));
    this.pruneRules(doc);
    if (menu) {
      const nav = this.findMenu(doc);
      if (nav) this.addMenuItem(nav, hrefOf(path), title, { current: true });
    }
    return "<!DOCTYPE html>\n" + root.outerHTML;
  }

  // A picture published next to a page is named relatively, and a page in
  // another directory would look for it in the wrong place.
  absolutize(doc, from) {
    const base = new URL(from, "http://nsite.invalid");
    const fix = (value) => {
      if (!value || /^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(value.trim())) return value;
      try { const u = new URL(value.trim(), base); return u.pathname + u.search + u.hash; } catch { return value; }
    };
    const walk = (scope) => {
      for (const el of scope.querySelectorAll("[src], [href], [poster], [srcset], object[data]")) {
        for (const name of ["src", "href", "poster", "data"]) if (el.hasAttribute(name)) el.setAttribute(name, fix(el.getAttribute(name)));
        if (el.hasAttribute("srcset")) {
          el.setAttribute("srcset", el.getAttribute("srcset").split(",").map((c) => {
            const [url, ...d] = c.trim().split(/\s+/); return [fix(url), ...d].join(" ");
          }).join(", "));
        }
      }
      for (const tpl of scope.querySelectorAll("template")) walk(tpl.content);
    };
    walk(doc);
  }

  // Content-form rules for parts of the old page that the new one does not
  // have would draw fields that edit nothing.
  pruneRules(doc) {
    const selectorOf = (spec) => {
      const s = String(spec);
      const at = s.lastIndexOf("@");
      const sel = at > 0 && /^[a-zA-Z_:][\w:.-]*$/.test(s.slice(at + 1)) ? s.slice(0, at) : s;
      return sel.trim().replace(/\[\]$/, "");
    };
    const alive = (spec) => {
      if (typeof spec === "string") { try { return !!doc.querySelector(selectorOf(spec)); } catch { return false; } }
      if (Array.isArray(spec)) return alive(spec[0]);
      if (spec && typeof spec === "object") return Object.values(spec).some(alive);
      return false;
    };
    for (const script of doc.querySelectorAll("script[nc\\:cms]")) {
      let rules;
      try { rules = JSON.parse(script.textContent); } catch { continue; }
      if (!rules || typeof rules !== "object" || Array.isArray(rules)) continue;
      const kept = Object.fromEntries(Object.entries(rules).filter(([, v]) => alive(v)));
      if (!Object.keys(kept).length) script.remove();
      else script.textContent = JSON.stringify(kept, null, 2).replace(/</g, "\\u003c");
    }
  }

  /**
   * Publish a new document and this page together, in one manifest: upload
   * the new bytes, add the menu item here if asked, then save this page with
   * the new path in the table. One version, so History shows them as one
   * change, and the menu never names a page the table does not have.
   */
  async publishNew({ html, path, title, menu }, h) {
    const nc = this.nc;
    h?.status(this.say("publishing"));
    const bytes = new TextEncoder().encode(html);
    const { hash } = await uploadAll(nc.cfg.servers, bytes, { signer: nc.signer, type: "text/html" });
    const nav = menu ? this.findMenu() : null;
    const added = nav ? nc.undo.commit("Add to the menu", () => this.addMenuItem(nav, hrefOf(path), title)) : null;
    try {
      await nc.save({ extraPaths: { [path]: hash } });
    } catch (e) {
      added?.previousSibling?.nodeType === 3 && added.previousSibling.remove();
      added?.remove();
      throw e;
    }
    return { hash, href: hrefOf(path) };
  }

  /** Wait for the gateway to serve the new page, then open it for editing. */
  async waitAndOpen(href, hash) {
    let stopped = false;
    const go = await modal({
      doc: this.doc, title: this.say("publishedTitle"), hint: this.say("publishedHint"), submitLabel: this.say("openNow"),
      build: (body, h) => {
        h.status(this.say("catchingUp"));
        this.served(href, hash, () => stopped).then((ok) => {
          if (stopped) return;
          if (ok) h.close("go"); else h.status(this.say("slowGateway"), true);
        });
      },
      onSubmit: () => "go",
    });
    stopped = true;
    if (go) this.go(href + "#edit");
    return !!go;
  }

  async served(href, hash, stopped = () => false, waitMs = 120000) {
    const until = Date.now() + waitMs;
    for (let i = 0; Date.now() < until && !stopped(); i++) {
      try {
        const url = new URL(href, this.doc.location.href);
        url.searchParams.set("v", String(Date.now()));
        const res = await fetch(url.toString(), { cache: "reload" });
        if (res.ok && hashText(await res.text()) === hash) return true;
      } catch { /* not yet */ }
      await sleep(Math.min(800 * Math.pow(1.4, i), 8000));
    }
    return false;
  }

  /** The stylesheet and the block shapes, which is the design the model is shown. */
  design() {
    const css = [...this.doc.querySelectorAll("style:not([nc\\:chrome])")].map((el) => el.textContent.trim()).join("\n");
    const blocks = [...this.doc.querySelectorAll("template[nc\\:block]")].map((t) => t.innerHTML.trim()).join("\n");
    return { css, blocks };
  }

  async newPage({ ai: withAi = false } = {}) {
    const nc = this.nc, say = (k, v) => this.say(k, v), ai = nc.ai;
    if (!nc.isOwner) throw new Error("Only the owner can add a page to this site.");
    const table = await this.table({ fresh: true });
    if (!Object.keys(table).length) { toast(say("noTable"), { doc: this.doc }); return null; }
    const menu = this.findMenu();
    let draft = withAi ? ai.drafts.read("newpage") : null;
    const state = { title: draft?.title || "", address: draft?.address || "", touched: !!draft?.address,
      menu: draft?.menu ?? !!menu, description: draft?.prompt || "" };
    const back = "back", resume = "resume";
    let result = null;
    while (true) {
      let title, address, where, menuBox, describe, controller, ready = !withAi, path = null;
      const asked = await modal({
        doc: this.doc, title: say(withAi ? "newPageAi" : "newTitle"), hint: say(withAi ? "newAiHint" : "newHint"),
        submitLabel: withAi ? ai.say("generate") : say("create"),
        build: (body, h) => {
          title = field(body, { label: say("pageTitle"), value: state.title, placeholder: say("titlePlaceholder") });
          title.dataset.ncNewTitle = "";
          address = field(body, { label: say("address"), value: state.address, placeholder: "/catering/" });
          address.dataset.ncNewAddress = ""; address.spellcheck = false; address.autocomplete = "off";
          where = this.doc.createElement("p"); where.className = "nc-hint"; where.style.margin = ".35rem 0 0";
          address.closest(".nc-field").append(where);
          const check = () => {
            path = address.value.trim() ? pathFor(address.value) : null;
            let bad = false;
            if (!address.value.trim()) where.textContent = "";
            else if (!path) { where.textContent = say("addressBad"); bad = true; }
            else if (table[path] || path === nc.cfg.path) { where.textContent = say("addressTaken", { path: hrefOf(path) }); bad = true; }
            else where.textContent = say("addressFree", { path: hrefOf(path) });
            where.classList.toggle("nc-bad", bad);
            h.busy(bad || !ready);
            return !bad;
          };
          title.addEventListener("input", () => {
            if (!state.touched) { const s = slugify(title.value); address.value = s ? `/${s}/` : ""; }
            check();
          });
          address.addEventListener("input", () => { state.touched = !!address.value.trim(); check(); });
          if (menu) menuBox = checkbox(body, { label: say("addToMenu"), checked: state.menu, note: say("menuNote") });
          else { const p = this.doc.createElement("p"); p.className = "nc-hint"; p.style.marginTop = ".85rem"; p.textContent = say("noMenu"); body.append(p); }
          if (nc.dirty) { const p = this.doc.createElement("p"); p.className = "nc-hint"; p.textContent = say("dirtyNote"); body.append(p); }
          if (withAi) {
            describe = field(body, { label: say("describePage"), rows: 4, value: state.description, placeholder: say("describePlaceholder") });
            const { css, blocks } = this.design();
            const readiness = ai.readiness(body, { kind: () => "page", chars: () => css.length + blocks.length + describe.value.length,
              onChange: (s) => { ready = !!s.canGenerate; check(); } });
            describe.addEventListener("input", () => readiness.update());
            ai.adopt().catch(() => {}).then(() => readiness.refresh());
            for (const name of ["addCredit", "settings"]) {
              const b = this.doc.createElement("button"); b.type = "button"; b.textContent = ai.say(name);
              if (name === "addCredit") b.hidden = ai.client.session().mode !== "routstr";
              b.onclick = async () => { await (name === "addCredit" ? ai.addCredit() : ai.settings()); await readiness.refresh(); };
              body.append(b);
            }
            if (draft?.versions?.length) {
              const b = this.doc.createElement("button"); b.type = "button"; b.textContent = say("lastPreview");
              b.onclick = () => h.close(resume); body.append(b);
            }
          }
          check();
        },
        onSubmit: async (h) => {
          state.title = title.value.trim(); state.address = address.value.trim();
          state.menu = !!menuBox?.checked; state.description = describe?.value.trim() || "";
          if (!state.title) { title.focus(); throw new Error(say("needTitle")); }
          if (!path) throw new Error(say("addressBad"));
          if (!withAi) {
            const html = this.shell({ title: state.title, path, menu: state.menu });
            return { ...(await this.publishNew({ html, path, title: state.title, menu: state.menu }, h)), path };
          }
          if (!state.description) { describe.focus(); throw new Error(say("needDescription")); }
          controller = new AbortController();
          const content = await this.writeContent({ ...state, path }, { signal: controller.signal,
            onProgress: (text, info) => h.status(info?.picture || (text.length ? `${ai.say("generating")} ${text.length}` : `${ai.say("thinking")} ${info?.thinking || 0}`)) });
          return { content, path };
        },
      }).finally(() => controller?.abort());
      if (!asked) return null;
      if (!withAi) return this.waitAndOpen(asked.href, asked.hash);
      if (asked === resume) {
        const v = draft.versions.at(-1);
        await ai.images.load(v.html).catch(() => {});
        result = { content: v.html, path: pathFor(state.address) };
        if (!result.path || table[result.path]) { result = null; continue; }
      } else if (asked) {
        result = asked;
        draft = { prompt: state.description, title: state.title, address: state.address, menu: state.menu,
          versions: [{ number: 1, prompt: state.description, html: asked.content }] };
        ai.drafts.write("newpage", draft);
      }
      const kept = await this.previewNew(result, state, draft);
      if (kept === back) { result = null; continue; }
      if (!kept) return null;
      ai.drafts.clear("newpage");
      return this.waitAndOpen(kept.href, kept.hash);
    }
  }

  /** Ask AI for the inside of the new page's <main>, pictures made too. */
  async writeContent({ title, description, path }, { signal, onProgress, previous = "", instruction = "" } = {}) {
    const ai = this.nc.ai;
    const { css, blocks } = this.design();
    const status = await ai.client.check().catch(() => null);
    const pictures = previous
      ? (ai.mentionsPictures(instruction) ? ai.pictureAllowance(status, { chars: css.length + previous.length }) : 0)
      : ai.pictureAllowance(status, { chars: css.length + blocks.length + description.length });
    const others = this.list().filter((p) => !p.current).map((p) => ({ href: p.href, title: this.cachedInfo(p.path)?.t || p.href }));
    others.unshift({ href: hrefOf(this.nc.cfg.path), title: this.doc.title || hrefOf(this.nc.cfg.path) });
    let content = await ai.buildContent({ title, description, href: hrefOf(path), css, blocks, pages: others,
      lang: (this.doc.documentElement.lang || "en").slice(0, 2), pictures, previous, instruction, signal, onProgress });
    if (pictures > 0) {
      const page = `<!DOCTYPE html><html><body>${content}</body></html>`;
      const out = await ai.fillPictures(page, { limit: pictures, signal,
        onProgress: (done, total) => onProgress?.("", { picture: `${ai.say("pictureMaking")} ${done}/${total}` }) });
      if (out.error && !signal?.aborted) toast(out.error.message, { doc: this.doc });
      content = new DOMParser().parseFromString(out.html, "text/html").body.innerHTML.trim();
    }
    return content;
  }

  /** The preview of an AI page in its shell: refine it, go back, or publish it. */
  async previewNew(result, state, draft) {
    const nc = this.nc, ai = nc.ai, say = (k, v) => this.say(k, v);
    const back = "back";
    let controller = null, refining = false;
    const kept = await modal({
      doc: this.doc, title: ai.say("preview"), hint: say("previewHint"), submitLabel: say("publishPage"), wide: true,
      build: (body, h) => {
        const row = this.doc.createElement("div"); row.className = "nc-row";
        const b = this.doc.createElement("button"); b.type = "button"; b.textContent = say("backDescription");
        b.onclick = () => h.close(back); row.append(b); body.append(row);
        const frame = this.doc.createElement("iframe"); frame.setAttribute("sandbox", ""); frame.title = ai.say("preview");
        frame.style.cssText = "display:block;width:100%;height:46vh;margin-top:.7rem;border:1px solid var(--nc-edge);background:white";
        const draw = () => { frame.srcdoc = ai.previewHTML(this.shell({ title: state.title, path: result.path, menu: state.menu, content: result.content })); };
        draw(); body.append(frame);
        const change = field(body, { label: ai.say("refineLabel"), rows: 2 });
        const refine = this.doc.createElement("button"); refine.type = "button"; refine.textContent = ai.say("refine");
        body.append(refine);
        refine.onclick = async () => {
          if (refining || !change.value.trim()) { change.focus(); return; }
          refining = true; refine.disabled = true; h.busy(true);
          controller = new AbortController();
          try {
            result.content = await this.writeContent({ ...state, path: result.path }, { signal: controller.signal,
              previous: result.content, instruction: change.value.trim(),
              onProgress: (text, info) => h.status(info?.picture || `${ai.say("generating")} ${text.length}`) });
            draft.versions = [...draft.versions, { number: draft.versions.at(-1).number + 1, prompt: change.value.trim(), html: result.content }].slice(-5);
            ai.drafts.write("newpage", draft);
            change.value = ""; draw(); h.status("");
          } catch (e) { if (!controller.signal.aborted) h.status(e.message, true); }
          finally { refining = false; refine.disabled = false; h.busy(false); }
        };
      },
      onSubmit: async (h) => {
        if (refining) return undefined;
        const html = await ai.uploadPictures(this.shell({ title: state.title, path: result.path, menu: state.menu, content: result.content }));
        return this.publishNew({ html, path: result.path, title: state.title, menu: state.menu }, h);
      },
    }).finally(() => controller?.abort());
    return kept === back ? back : kept;
  }
}
