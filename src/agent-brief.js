// Instructions for somebody's own coding agent: how to download this site, edit
// it and publish it again without turning it into something the browser editor
// can no longer open.
//
// Filled in from the page's own facts by the page itself, from a template, with
// no model involved: the owner presses a button in Settings and gets text to
// paste into Claude Code, Codex or whatever they use. The same template with no
// facts is the general version on the project site, staged by
// tools/stage-agent.mjs, so the two cannot drift apart.
//
// It lives in the runtime rather than in the toolbar markup because an upgrade
// carries the runtime and nothing else: a page published before this existed
// gets the button the day its owner takes the upgrade.
//
// The text itself is English. Agents read it, and an agent is better served by
// one precise text than by four translations of it. The button and the dialog
// around it speak the page's language.
import { nip19 } from "nostr-tools";
import { manifestPaths } from "./manifest.js";
import { modal, toast } from "./ui.js";

export const PROJECT = "https://nsite-clay.cypherpunk.today";
export const GENERAL_PATH = "/llms-edit.txt";
const REPO = "https://github.com/jooray/nsite-clay/blob/main";
const CLI = "npx -y nsite-clay@latest";
const CLI_SINCE = "0.3.25";
// The relays a phone signer should use: each one checked to carry NIP-46
// frames, which relay.nsite.lol refuses. Same list as config.js uses for the
// sign-in QR.
const SIGNER_RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom"];

const base36 = (hex) => BigInt("0x" + hex).toString(36).padStart(50, "0");

/** The address a gateway serves a site at. */
export function siteAddress(pubkey, site = "") {
  return site ? `https://${base36(pubkey)}${site}.nsite.lol/` : `https://${nip19.npubEncode(pubkey)}.nsite.lol/`;
}

// What the page knows about itself. The page list comes from the live manifest
// the page already read on load when it has one, and from a fresh read with a
// short deadline when it has not: a clipboard write has to follow the click
// within a few seconds, or the browser no longer counts it as the person's.
export async function siteFacts(nc, { wait = 2500 } = {}) {
  const cfg = nc.cfg;
  if (!cfg.owner) return null;
  let ev = nc._manifest || nc._bootManifest || null;
  if (!ev) {
    ev = await Promise.race([
      nc.currentManifest().catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), wait)),
    ]);
  }
  const paths = ev ? manifestPaths(ev) : {};
  const all = Object.keys(paths);
  const pages = all.filter((p) => /\.html?$/i.test(p));
  if (!pages.includes(cfg.path)) pages.push(cfg.path);
  const loc = nc.doc.defaultView?.location;
  return {
    pubkey: cfg.owner,
    npub: nip19.npubEncode(cfg.owner),
    site: cfg.site || "",
    origin: loc && /^https?:$/.test(loc.protocol) ? loc.origin : "",
    path: cfg.path,
    relays: cfg.relays,
    servers: cfg.servers,
    pages: pages.sort(),
    others: all.filter((p) => !/\.html?$/i.test(p)).length,
    fromManifest: !!ev,
    published: ev?.created_at || null,
    engine: nc.version,
    today: new Date().toISOString().slice(0, 10),
  };
}

/**
 * The instructions, filled in from `facts` (what siteFacts returns), or the
 * general version with placeholders when `facts` is null.
 */
export function agentInstructions(facts = null) {
  const f = facts;
  const npub = f ? f.npub : "<the owner's npub>";
  const address = f ? siteAddress(f.pubkey, f.site) : "https://<npub>.nsite.lol/";
  const relays = f ? f.relays.join(",") : "<the site's relays, comma separated>";
  const servers = f ? f.servers.join(",") : "<the site's Blossom servers, comma separated>";
  const siteFlag = f?.site ? ` --site=${f.site}` : "";
  const page = f ? (f.pages.find((p) => p !== "/index.html") || f.pages[0]) : "/about.html";
  const viewed = f?.origin && !address.startsWith(f.origin) ? f.origin + "/" : "";
  const L = [];
  const p = (...lines) => L.push(...lines);

  p(f ? "# Edit this nsite-clay site, as an agent" : "# Edit an nsite-clay site, as an agent", "");
  p("You are a coding agent: Claude Code, Codex, opencode or something like them.",
    f ? "The person who pasted this owns the website described below. They want you"
      : "The person who sent you here owns an nsite-clay website. They want you",
    "to download it, change what they ask for, and publish it again. Do the whole",
    "job yourself, and leave the site working the way it works now: when you are",
    "done, every page can still be opened with #edit on the end of its address,",
    "edited in the browser and saved from there.", "",
    "Read all of this before you run anything. It is written so that you can",
    "finish without asking the owner for anything except the one link in step 1.", "");
  if (!f) {
    p("A filled-in copy of this text, with the site's own key, relays, servers and",
      "pages, comes from the site itself: the owner opens the site with #edit, signs",
      "in, and presses Settings, then \"Copy instructions for your own agent\". If",
      "you have only this general version, ask the owner for the site's address and",
      "read the rest out of the site as step 3 shows.", "");
  }

  p("## The site", "");
  p(`- Owner key: ${npub}`);
  p(`- Address: ${address}`);
  p(`- Editing in the browser: ${address}#edit`);
  if (viewed) p(`- The owner copied this from ${viewed}, which serves the same site. Check your work there as well.`);
  p(f ? `- Which site: ${f.site ? `the named site "${f.site}" of this key, a NIP-5A manifest of kind 35128 with the d tag "${f.site}"` : "the root site of this key, a NIP-5A manifest of kind 15128"}`
      : "- Which site: the root site of a key is a NIP-5A manifest of kind 15128; a named site is kind 35128 with its name in the d tag");
  p(`- Relays the pages save to: ${f ? f.relays.join(", ") : "the nc:relays attribute on each page's <html>"}`);
  p(`- Blossom servers the files are on: ${f ? f.servers.join(", ") : "the nc:servers attribute on each page's <html>"}`);
  if (f) {
    p(`- Pages${f.fromManifest ? ` in the published site${f.published ? ` (version of ${new Date(f.published * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}` : ", as far as this page knows (the site's manifest could not be read when this was copied)"}: ${f.pages.join(", ")}`);
    if (f.fromManifest) p(`- Other files in the site: ${f.others}, among them the nsite-clay runtime`);
    p(`- Copied from the page ${f.path}, running nsite-clay ${f.engine}, on ${f.today}`);
  }
  p(`- These instructions were filled in by the page itself from a template. The`,
    `  general version is ${PROJECT}${GENERAL_PATH}`, "");

  p("## What an nsite-clay site is", "",
    "The site is plain HTML files. Each file is a blob on Blossom servers, named by",
    "its sha256, and a signed Nostr event, the manifest, maps paths like /index.html",
    "to those hashes. A runtime script in every page lets the owner sign in, edit the",
    "page in place and save it, which uploads the new HTML and publishes a new",
    "manifest. So the published files are the source. There is no repository or",
    "build step behind them, and whatever the owner changed in the browser exists",
    "only in the published site.", "",
    `${PROJECT}/llms.txt is the brief for building a new nsite-clay site. It explains`,
    "every part in depth. Read it before you change a page's structure rather than",
    "its words.", "");

  p("## What you need", "",
    "Node.js 18 or newer, and network access to the relays and servers above. Nothing",
    "else has to be installed. Every command here runs the nsite-clay command line",
    "tool through npx:", "",
    `    ${CLI} <command>`, "",
    `It has to be version ${CLI_SINCE} or newer, the first with pull and with a saved`,
    `signer connection. \`${CLI} --version\` prints the version, and`,
    `\`${CLI} help\` lists every command and flag.`, "",
    "Without Node, the last section of this text describes the protocol, so the same",
    "steps can be done in another language.", "");

  p("## 1. Get a signer connection, never a key", "",
    "Publishing needs signatures from the owner's key. Do not ask for the private",
    "key (an nsec), do not accept one if it is offered, and do not make a new key:",
    "a new key is a different site. Ask for a bunker link instead. It is a NIP-46",
    "connection: you send signing requests over Nostr relays to an app the owner",
    "runs, usually on their phone, and the app signs with the key it keeps. The key",
    "never reaches you.", "",
    "Ask the owner for a bunker:// link, and tell them how to get one:", "",
    "- Amber, on Android: add a new application and choose \"Add a nsecbunker\". Give",
    "  it a name, for example \"my coding agent\", pick one or two relays, and copy",
    "  the bunker:// link Amber shows.",
    "- Clave, on iPhone: open the Connect tab and share the bunker code. It is a",
    "  bunker:// link to copy.",
    "- nsec.app in a browser, or any other NIP-46 signer, gives bunker:// links too.", "",
    `For the signer's relays, ${SIGNER_RELAYS.join(", ")} all work. Not`,
    "wss://relay.nsite.lol: it carries site manifests only and refuses signer messages.", "",
    "Tell the owner what the signer will be asked to sign, so they know what to",
    "approve: get_public_key; kind 24242, a permission to upload one file to a",
    "Blossom server, one for each new file; kind " + (f?.site ? "35128" : "15128") + ", the site manifest; kind",
    "5128, a version for the editor's History list; and kind 10002, a relay list,",
    "only if the key has none at all. None of them is a post, a payment or a message.", "");

  p("## 2. Connect once, and keep the connection", "",
    "A bunker link carries a secret that works once. The first connection spends it,",
    "and from then on the signer recognises the client key that connected, not the",
    "link. So connect once, before anything else:", "",
    `    NOSTR_BUNKER_URI='bunker://…' ${CLI} whoami`, "",
    `It prints the npub the signer holds. That has to be ${f ? npub : "the owner key of the site"}.`,
    "If it is not, stop and tell the owner that the signer holds a different key.", "",
    "The tool saves the connection: the client key it connected with, the bunker's",
    "pubkey and its relays, in ~/.config/nsite-clay/bunkers.json (or in",
    "$XDG_CONFIG_HOME/nsite-clay/ when that is set), readable by your user only.",
    "Every later command finds it by the site's owner key, so later runs need no",
    "link and no NOSTR_BUNKER_URI. Do not delete that file, do not pass --fresh, and",
    "do not ask for a new link on every run.", "",
    "Ask for a new link only when the saved connection cannot work, and tell the owner",
    "which of these is the reason:", "",
    "- you are on another machine or in a new container, where bunkers.json is not.",
    "  In a sandbox whose home directory is thrown away, set XDG_CONFIG_HOME to a",
    "  directory that is kept, before the first connection;",
    "- the signer answers that this client has no permission, because the owner",
    "  removed it in the app or never approved it;",
    "- the link they gave you was already used by another app.", "",
    "Keep the link out of command arguments, where other processes can read it, out",
    "of the site directory, where every file whose name does not start with a dot is",
    "published, and out of logs, commits and your messages.", "",
    "A signer that asks the owner to approve each request needs them at the phone",
    "while you publish. Tell them before you start. --timeout=180 makes the tool wait",
    "three minutes for each answer instead of one.", "");

  p("## 3. Download the site", "",
    `    ${CLI} pull ${f ? npub : "<npub or site address>"} site${f ? ` --relays=${relays} --servers=${servers}${siteFlag}` : ""}`, "");
  if (!f) {
    p("With only the address, leave the flags out and the tool looks on common relays",
      "and on the owner's relay list. When you know the site's relays and servers,",
      "pass them as --relays=… and --servers=…, comma separated, and for a named site",
      "add --site=<name>.", "");
  }
  p("This reads the newest manifest from the relays, downloads every file it names",
    "from the Blossom servers, checks each one against its sha256, and writes it into",
    "site/ at its path. It also writes site/.nsite-clay.json, which records the site,",
    "its relays and servers and the exact version you downloaded. Leave that file",
    "where it is: the deploy reads it.", "",
    "Pull into a new directory every time you start a new piece of work. The owner",
    "may have saved changes in the browser since you last looked, and the published",
    "site is the only copy of them.", "",
    "You will see files like nsite-clay-1a2b3c4d.js next to nsite-clay.js. The suffix",
    "is the start of the file's hash, which makes a new build a new URL that no cache",
    "can answer with an old copy. The pages point at the stamped names. Leave all of",
    "them as they are.", "");

  p("## 4. Make the change", "",
    "Edit the files in site/ to do what the owner asked. What keeps the site working:", "",
    "- Keep the runtime. Every page loads /nsite-clay.js and /nsite-clay-chrome.js",
    "  and links /nsite-clay-base.css, often under stamped names such as",
    "  /nsite-clay-1a2b3c4d.js. Keep those script and link tags exactly as they are.",
    "  Do not inline the files, copy them into a page, rename them, load them from a",
    "  CDN or correct a stamped name. They are linked from the site root so that one",
    "  upgrade in the browser updates every page.",
    "- Keep every attribute on <html> whose name starts with nc:, such as nc:owner,",
    "  nc:path, nc:site, nc:relays, nc:servers, nc:edit-gate and nc:source. They are",
    "  the page's configuration. Do not change nc:owner, nc:relays or nc:servers",
    "  unless the owner asked for exactly that, and do not add autosave.",
    "- Keep what the editor works on: editable attributes, nc:blocks containers and",
    "  their nc:block-type sections, <template nc:block> elements, which are the",
    "  page's block library, an nc:cms rules block, nc:feed widgets, and the toolbar",
    "  near the end of the body, the div with the class nc-bar and its data-nc-*",
    "  buttons. Change the words inside them as much as you like.",
    "- When you add something, copy the pattern next to it. A new card is a copy of",
    "  an existing card, with the same classes and editable attributes. A new section",
    "  on a page made of blocks is a copy of one of its <template nc:block> elements,",
    "  placed inside the nc:blocks container.",
    "- Do not add a build step, a framework, or a script that rewrites the page when",
    "  it loads. What is in the file is what readers get and what the editor edits.",
    "- Write in the page's language and in its voice, with that language's",
    "  punctuation.", "",
    "A new page:", "",
    "- Start from a copy of an existing page of the site, so it has the same head,",
    "  runtime tags, toolbar and nc: attributes.",
    "- Give it its own <title> and <meta name=\"description\">, and its own nc:path,",
    "  equal to where it lives: site/menu.html gets",
    "  nc:path=\"/menu.html\", and site/menu/index.html gets nc:path=\"/menu/index.html\".",
    "  A copy that keeps its source's nc:path overwrites that page the first time it",
    "  is saved in the browser, and keeps reloading itself. The deploy refuses it.",
    "- Link to it with a path from the root. A link to a directory needs its trailing",
    "  slash: /menu/ works and /menu does not. Put the link where the site already",
    "  links to things: its navigation if it has one, otherwise a button or a",
    "  sentence in an existing block, built from the page's own block library.",
    "- Only /index.html may leave nc:path out, because that is the default. Every",
    "  other page needs it.", "",
    "Pictures: put a new file in site/, for example site/images/oven.jpg, and use it",
    "as /images/oven.jpg. The deploy uploads it, puts its hash in its name and",
    "rewrites the references to it. A picture already on a Blossom server can be",
    "used by its full URL. Give every picture an alt text that says what is in it.", "",
    "To remove a page, delete its file. The deploy takes it out of the site.", "",
    `The rules every template follows are in ${REPO}/templates/_shared/CONTRACT.md`,
    `and every attribute is described in ${REPO}/docs/RUNTIME-API.md.`, "");

  p("## 5. Publish", "",
    `    ${CLI} deploy site --dry-run`,
    `    ${CLI} deploy site`, "",
    "The dry run lists what would be published and needs no signer. The deploy:", "",
    "- reads site/.nsite-clay.json and publishes to the same site, relays and",
    "  servers, so it needs no flags, and uses the saved signer connection for the",
    "  owner key, so it needs no link;",
    "- refuses a page whose nc:path, nc:site or nc:owner does not fit where it is",
    "  being published, and a page that would lose its runtime;",
    "- compares three versions of every file: as you pulled it, as it is in site/,",
    "  and as it is published now. A file only you changed is published. A file",
    "  changed only in the browser since your pull is kept as the browser saved it,",
    "  and written into site/. A page added in the browser since your pull is kept.",
    "  A file changed in both places stops the deploy before anything is published;",
    "- uploads only what the servers do not hold yet, then signs and publishes one",
    "  new manifest and one version for the History list.", "",
    "If it stops on a conflict, do not reach for --overwrite, which throws away what",
    "the owner saved in the browser. Pull again into a new directory, make your",
    "change there, and deploy that. If it stops for any other reason, the message",
    "says what to fix.", "",
    "Never run unpublish unless the owner asked you to take something down.", "");

  p("## 6. Check that it worked", "",
    `- Fetch each page you changed and look for your change, for example ${address}${page.replace(/^\//, "")}${viewed ? `\n  or ${viewed}${page.replace(/^\//, "")}` : ""}.`,
    "  A gateway can take a minute to see a new manifest.",
    "- For an exact check, pull the site again into a fresh directory and compare it",
    "  with site/ (diff -r, ignoring .nsite-clay.json). Every page you changed should",
    "  be identical, apart from asset names the deploy stamped with their hash.",
    "- Every page still loads its nsite-clay.js and nsite-clay-chrome.js, and the",
    "  gateway serves both as JavaScript, not as a 404.",
    `- If you can drive a browser, open ${viewed || address}#edit. The toolbar appears and`,
    "  Sign in offers the owner's signers. Do not save anything from there yourself.", "");

  p("## 7. Tell the owner", "",
    "- What you changed, page by page, and the address.",
    "- That they still edit the site in the browser the same way, at the address with",
    "  #edit on the end.",
    "- That a tab they had open for editing while you published should be reloaded",
    "  before they edit again, or saving it would replace your changes.",
    "- That this machine keeps the signer connection, so next time you need no new",
    "  link, and that they can end it whenever they like by removing the app in their",
    "  signer.", "");

  p("## When something goes wrong", "",
    "- \"no answer within 60s\": the signer app is not running, is not connected to",
    "  the bunker's relays, or is waiting for the owner to approve. Ask them to open",
    "  it, and run the command again.",
    "- \"single use\" or \"no permission\" on the first connection: the link was spent",
    "  by another app or another machine. Ask for a new link and say why.",
    "- \"unchanged\": nothing was published, because the site already is what site/",
    "  holds.",
    "- A refusal that lists pages the directory does not have: you are deploying a",
    "  directory that did not come from pull. Pull first. --keep-missing and --prune",
    "  exist, and are for people who know they want them.",
    "- Relays disagree for a while after a publish. The tool asks every relay of the",
    "  site and takes the newest manifest.",
    "- The deploy protects changes saved in the browser before it runs, not during",
    "  it. Ask the owner not to save in the browser while you work.", "");

  p("## nak, if it is installed", "",
    "nak (https://github.com/fiatjaf/nak) can do each step by hand: nak req -k 15128",
    "-a <hex pubkey> <relay> reads a manifest, nak blossom downloads and uploads",
    "blobs, and nak event signs and publishes events. Sign with --sec 'bunker://…' and",
    "give the same --connect-as <client secret key> (or NOSTR_CLIENT_KEY) on every",
    "call. With a new random client key on each call, the spent secret makes every",
    "call after the first fail. The nsite-clay tool is still the better route,",
    "because nak does none of the checks in step 5.", "");

  p("## Without Node: the protocol", "",
    "Everything the tool does is public protocol, so it can be done in any language.", "",
    "The manifest, NIP-5A. An event signed by the owner key, of kind 15128 for the",
    "root site, or of kind 35128 with the site's name in a d tag for a named site.",
    "Its tags:", "",
    "    [\"path\", \"/index.html\", \"<sha256 hex>\"]    one for each file",
    "    [\"server\", \"https://…\"]                   the Blossom servers holding them",
    "    [\"x\", \"<aggregate>\", \"aggregate\"]         sha256 over the sorted lines",
    "                                               \"<sha256> <path>\\n\", one per path tag",
    "    [\"title\", \"…\"]                             optional", "",
    "It is replaceable: the newest created_at wins. Ask every relay of the site for",
    "{\"kinds\":[15128],\"authors\":[\"<hex pubkey>\"]}, or {\"kinds\":[35128],",
    "\"authors\":[\"<hex pubkey>\"],\"#d\":[\"<name>\"]}, and take the newest event whose",
    "signature verifies. The manifest is the whole site: a path missing from a new",
    "manifest is a page taken down. Always publish the complete table, with new",
    "hashes for what you changed and the published hashes for everything else.", "",
    "Downloading, Blossom BUD-01. GET <server>/<sha256> returns the bytes. Try the",
    "servers named in the manifest, then the owner's kind 10063 server list. Hash what",
    "you receive and throw it away if it does not match.", "",
    "Uploading, BUD-02. Ask first with HEAD <server>/<sha256>. To upload, PUT",
    "<server>/upload with the file as the body, its Content-Type, and the header", "",
    "    Authorization: Nostr <base64 of the JSON of a signed kind 24242 event>", "",
    "whose tags are [\"t\",\"upload\"], [\"x\",\"<sha256>\"] and [\"expiration\",\"<unix time",
    "ten minutes ahead>\"]. Some servers want base64url without padding and some want",
    "standard base64, so try one and then the other. Upload to every server the site",
    "uses.", "",
    "Publishing. Sign the new manifest with a created_at later than the published",
    "one and send it to every relay of the site. Then send a kind 5128 event with the",
    "same path, server and x tags and [\"a\",\"<kind>:<hex pubkey>:<name, or empty>\"].",
    "That is the version the editor's History lists.", "",
    "Signing, NIP-46. Make a client keypair and keep it. Send kind 24133 events,",
    "tagged [\"p\",\"<bunker pubkey>\"], to the bunker's relays, with content encrypted",
    "with NIP-44 between your client key and the bunker pubkey:",
    "{\"id\":\"<random>\",\"method\":\"connect\",\"params\":[\"<bunker pubkey>\",\"<secret>\"]},",
    "then get_public_key, then sign_event with the unsigned event as a JSON string in",
    "params. The answers come back the same way, from the bunker pubkey and tagged",
    "with yours. The secret works once. Later sessions are recognised by your client",
    "key, which is why it has to be kept.", "",
    "Asset names. The tool renames every file that is not HTML to",
    "name-<first 8 hex of its sha256>.ext and rewrites the references in the pages'",
    "tags to match. By hand you can keep names as they are, as long as every path a",
    "page refers to is in the table.", "",
    "Checking. Fetch the page from a gateway, or the blob from a Blossom server by its",
    "hash, and compare its sha256 with the manifest.", "");

  p("## Links", "",
    `- This text, the general version: ${PROJECT}${GENERAL_PATH}`,
    `- Building a new nsite-clay site: ${PROJECT}/llms.txt`,
    `- What every page must do: ${REPO}/templates/_shared/CONTRACT.md`,
    `- Runtime reference: ${REPO}/docs/RUNTIME-API.md`,
    `- What belongs in the page and what on relays: ${REPO}/docs/state.md`,
    "- Source: https://github.com/jooray/nsite-clay");
  return L.join("\n") + "\n";
}

// ---- the button -------------------------------------------------------------

// Order: en, es, sk, cs.
const WORDS = {
  button: ["Copy instructions for your own agent", "Copiar instrucciones para tu propio agente",
    "Skopírovať pokyny pre vlastného agenta", "Zkopírovat pokyny pro vlastního agenta"],
  note: ["For Claude Code, Codex or another coding agent: how to download this site, change it and publish it again without breaking the editor. The text holds no key.",
    "Para Claude Code, Codex u otro agente de programación: cómo descargar este sitio, cambiarlo y volver a publicarlo sin romper el editor. El texto no contiene ninguna clave.",
    "Pre Claude Code, Codex alebo iného programovacieho agenta: ako túto stránku stiahnuť, upraviť a znova zverejniť tak, aby editor fungoval aj potom. Text neobsahuje žiadny kľúč.",
    "Pro Claude Code, Codex nebo jiného programovacího agenta: jak tuto stránku stáhnout, upravit a znovu zveřejnit tak, aby editor fungoval i potom. Text neobsahuje žádný klíč."],
  copied: ["Copied. Paste it into your agent. It will ask you for a bunker link from your signer app, never for your key.",
    "Copiado. Pégalo en tu agente. Te pedirá un enlace bunker de tu app de firma, nunca tu clave.",
    "Skopírované. Vlož to svojmu agentovi. Vypýta si od teba bunker odkaz z podpisovej aplikácie, nikdy nie tvoj kľúč.",
    "Zkopírováno. Vlož to svému agentovi. Vyžádá si od tebe bunker odkaz z podpisové aplikace, nikdy ne tvůj klíč."],
  title: ["Instructions for your own agent", "Instrucciones para tu propio agente",
    "Pokyny pre vlastného agenta", "Pokyny pro vlastního agenta"],
  manual: ["Your browser did not let the page copy this. Select all of the text and copy it, or press Copy.",
    "Tu navegador no dejó que la página lo copiara. Selecciona todo el texto y cópialo, o pulsa Copiar.",
    "Prehliadač nedovolil stránke text skopírovať. Označ celý text a skopíruj ho, alebo stlač Skopírovať.",
    "Prohlížeč nedovolil stránce text zkopírovat. Označ celý text a zkopíruj ho, nebo stiskni Zkopírovat."],
  copy: ["Copy", "Copiar", "Skopírovať", "Zkopírovat"],
  done: ["Copied", "Copiado", "Skopírované", "Zkopírováno"],
};

function say(doc, key) {
  const lang = ["en", "es", "sk", "cs"].indexOf((doc.documentElement.lang || "en").slice(0, 2).toLowerCase());
  return WORDS[key]?.[Math.max(lang, 0)] || key;
}

// The clipboard API first. A page served over plain HTTP, which a gateway on a
// custom domain is, has none, and the old way still works there, from inside
// whichever dialog is on top: a textarea outside the top layer cannot be
// selected while a modal is open.
async function toClipboard(doc, text) {
  try { await doc.defaultView.navigator.clipboard.writeText(text); return true; }
  catch { /* fall through */ }
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.setAttribute("nc:chrome", "");
  ta.style.cssText = "position:fixed;opacity:0;left:0;top:0";
  ([...doc.querySelectorAll("dialog.nc-ui[open]")].at(-1) || doc.body).appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = doc.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** What the Settings button does: copy the filled-in text, or show it. */
export async function copyAgentInstructions(nc) {
  const doc = nc.doc;
  const text = agentInstructions(await siteFacts(nc));
  if (await toClipboard(doc, text)) {
    toast(say(doc, "copied"), { doc, ms: 6000 });
    return { copied: true, text };
  }
  await modal({
    doc, wide: true, title: say(doc, "title"), hint: say(doc, "manual"), submitLabel: say(doc, "copy"),
    build: (body) => {
      const ta = doc.createElement("textarea");
      ta.readOnly = true;
      ta.rows = 16;
      ta.value = text;
      ta.setAttribute("data-nc-agent-text", "");
      ta.style.cssText = "width:100%;font:12px/1.4 ui-monospace,monospace;white-space:pre";
      body.append(ta);
      setTimeout(() => { ta.focus(); ta.select(); }, 0);
    },
    onSubmit: async (h) => {
      h.status(await toClipboard(doc, text) ? say(doc, "done") : say(doc, "manual"));
      return undefined;                     // stays open: they may still want to select it
    },
  });
  return { copied: false, text };
}

/** The button and its note, for the Settings dialog. */
export function agentRow(nc, body) {
  const doc = nc.doc;
  if (!nc.cfg.owner) return;
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.setAttribute("data-nc-agent", "");
  btn.style.marginLeft = ".5rem";
  btn.textContent = say(doc, "button");
  btn.onclick = () => { copyAgentInstructions(nc).catch((e) => toast(String(e?.message || e), { doc })); };
  const note = doc.createElement("p");
  note.className = "nc-hint";
  note.textContent = say(doc, "note");
  body.append(btn, note);
}
