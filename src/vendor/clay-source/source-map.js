/**
 * source-map.js — save the file, not a serialization of it.
 *
 * Every program that edits a malleable HTML file rewrites the whole file, because
 * each one parses to a tree and serializes the tree back out, and a serializer does
 * not reproduce its input. A no-edit save through `clone.outerHTML` rewrites about
 * 88% of an authored document's lines: attributes reorder, quoting normalises, `&`
 * becomes `&amp;`, every tag reprints canonically. Nothing is lost, and the file is
 * no longer the file anybody wrote.
 *
 * This module keeps the bytes the document was loaded from, pairs each live node to
 * a byte range in them, and on save copies source bytes for everything unchanged and
 * prints only what changed.
 *
 * FIVE OPERATIONS
 *
 *   model(src)            parse5 tree of byte locations; implied tags get a content range
 *   pair(root, m)         live node -> byte range, by tiered signature alignment
 *   render(clone, ...)    the save clone, emitted exactly: every child, whitespace
 *                         included, no gaps invented and none dropped
 *   verify(out, today)    reparse and compare trees before anything is sent
 *   adopt(bytes)          re-model and re-pair against what the host accepted
 *
 * THE FLOOR IS TODAY'S BEHAVIOUR. Anything that does not verify is sent as the full
 * serialization instead, and counted. A fetch that does not return this document, a
 * source whose shape outside <html> disagrees with the live document, a render that
 * throws: each one means this module does nothing at all and the save is exactly the
 * save it would have been.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 *   No ids in the file. Identity is the live node object, held in a WeakMap.
 *   No sidecar, no server change, no second format on disk.
 *   No tolerance in the verifier. A reprint is fixed in the renderer or in the page,
 *   never by widening what counts as equal — a verifier that shares a predicate with
 *   the renderer cannot see the renderer's mistakes, which is how an earlier version
 *   of this code wrote `by <a>Ana</a> <a>Bo</a>` back as `AnaBo` with a green check.
 */

import { parse } from 'parse5';

const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'noscript']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const XHTML = 'http://www.w3.org/1999/xhtml';

const escText = (s) => s.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/"/g, '&quot;');

// =============================================================================
// MODEL
// =============================================================================

export function model(src) {
  // The error counts come out of the SAME parse, so they cost nothing here. They are
  // the only evidence of input a parser throws away, which a tree comparison cannot
  // see by construction: a duplicate attribute is discarded during parsing, so a render
  // that wrote one twice reparsed to exactly the right tree. That is how the same
  // `xmlns:xlink` was added to a file on every save with the verifier green each time.
  const parseErrors = new Map();
  const doc = parse(src, {
    sourceCodeLocationInfo: true,
    onParseError: (e) => parseErrors.set(e.code, (parseErrors.get(e.code) || 0) + 1),
  });
  const html = doc.childNodes.find((n) => n.nodeName === 'html');
  const outside = doc.childNodes.filter((n) => n !== html).map((n) => n.nodeName === '#documentType'
    ? { kind: 'doctype', name: n.name || '', publicId: n.publicId || '', systemId: n.systemId || '' }
    : { kind: n.nodeName === '#comment' ? 'comment' : n.nodeName, value: n.data });
  const root = html ? locOf(html, null, src) : null;
  return { src, doc, outside, root, parseErrors, relocated: root ? firstOutOfOrder(root) : null };
}

function locOf(n, parent, src) {
  const l = n.sourceCodeLocation || null;
  const kind = n.nodeName === '#text' ? 'text' : n.nodeName === '#comment' ? 'comment' : 'element';
  const loc = { node: n, parent, live: null, kind, children: [], from: l ? l.startOffset : -1, to: l ? l.endOffset : -1 };
  if (kind === 'text') { loc.value = n.value; return loc; }
  if (kind === 'comment') { loc.value = n.data; return loc; }
  loc.tag = n.tagName;
  loc.located = !!(l && l.startTag);
  loc.openFrom = loc.located ? l.startTag.startOffset : -1;
  loc.openTo = loc.located ? l.startTag.endOffset : -1;
  loc.closeFrom = l && l.endTag ? l.endTag.startOffset : (loc.located ? loc.to : -1);
  loc.closeTo = l && l.endTag ? l.endTag.endOffset : (loc.located ? loc.to : -1);
  // Nothing can end before its own start tag does, but parse5 reports exactly that for
  // an element the parser inserts and immediately pops. A <form> written directly
  // inside a <table> is the case that ships: the form is inserted, the form pointer is
  // set, and the element is popped off the stack at once, so nothing ever closes it and
  // its endOffset stays at the `<` of its start tag. The parent then rewound its copy
  // cursor to that offset after emitting the tag and copied the whole `<form ...>`
  // again, so every save added one more copy and the tree never changed, which is why
  // verify passed each time. Both ends move up to the end of the start tag, which is
  // the least this element can be said to occupy.
  if (loc.located) {
    if (loc.to < loc.openTo) loc.to = loc.openTo;
    if (loc.closeFrom < loc.openTo) loc.closeFrom = loc.closeTo = loc.openTo;
  }
  loc.attrs = [];
  const attrLocs = (loc.located && l.startTag.attrs) || (l && l.attrs) || {};
  // Keyed by the name as WRITTEN, which is the only name both sides agree on. parse5
  // adjusts a foreign-content attribute in the tree, so `xmlns:xlink` arrives as
  // `{ name: 'xlink', prefix: 'xmlns' }`, while it keys the location map and the live
  // DOM's `attr.name` by `xmlns:xlink`. Keyed by the adjusted name the lookup missed,
  // the attribute got no source range, its bytes rode along inside a copied run, and
  // the live copy was appended as a new attribute: every save added another
  // `xmlns:xlink="..."` and the tree stayed identical, so verify passed each time.
  for (const a of n.attrs) {
    const written = a.prefix ? a.prefix + ':' + a.name : a.name;
    const al = attrLocs[written.toLowerCase()];
    loc.attrs.push({ name: written, key: written.toLowerCase(), value: a.value, from: al ? al.startOffset : -1, to: al ? al.endOffset : -1 });
  }
  const kids = n.nodeName === 'template' && n.content ? n.content.childNodes : n.childNodes;
  for (const c of kids) {
    if (c.nodeName === '#documentType') continue;
    loc.children.push(locOf(c, loc, src));
  }
  // An implied tag (<html>, <head>, <body> the author never wrote) has no tag bytes. Its
  // content range is its children's span, and its open and close tags are empty ranges at
  // either end, so emitting it copies the children and writes no tag.
  if (!loc.located) {
    const located = loc.children.filter((c) => c.from >= 0);
    const first = located.length ? Math.min(...located.map((c) => c.from)) : -1;
    const last = located.length ? Math.max(...located.map((c) => c.to)) : -1;
    loc.openFrom = loc.openTo = first;
    loc.closeFrom = loc.closeTo = last;
    loc.from = first; loc.to = last;
  }
  for (const cl of loc.children) {
    // Clamp every child into its parent's content range, at BOTH ends.
    //
    // The spec (and parse5, and every browser) appends whitespace that follows an end
    // tag to the last text node before it, so such a node's range runs past the tag,
    // and when nothing precedes the tag the range starts past it as well. Left alone,
    // the first case emits the same bytes twice and the second inverts the range:
    // `</script></body>\n</html>` gave body a last text node beginning AFTER `</body>`,
    // and the copy of the gap before it wrote `</body>` a second time. Chromium found
    // that one; jsdom did not, only because every hand-written fixture happened to have
    // a newline before `</body>`.
    if (cl.from >= 0 && loc.located) {
      // Both ends land inside [openTo, closeFrom], and `from` never passes `to`: a
      // range that begins after the end tag collapses to an empty one AT the end tag,
      // not after it. Putting it after is what wrote `</body>` twice, because the copy
      // of the gap up to that range then spanned the tag.
      const to = Math.max(loc.openTo, Math.min(cl.to, loc.closeFrom));
      const from = Math.min(Math.max(cl.from, loc.openTo), to);
      if (from !== cl.from || to !== cl.to) {
        // What the bytes inside the parent account for stays with this node; the rest
        // was relocated from outside, belongs to an ancestor, and is emitted there. A
        // node that gets PRINTED rather than copied has to leave it out or it appears
        // twice, which is a tree difference and a fallback on the next save.
        //
        // Neither end of the span can be measured directly. Counting back by the
        // overhang's byte length is wrong because the span covers the end tag too, and
        // slicing the source after the end tag is wrong because the relocation can
        // cross two of them: `</p>\n</body>\n</html>\n` puts three newlines from three
        // different places into one text node.
        //
        // Whitespace only, which is all a parser relocates.
        if (cl.kind === 'text') {
          // Normalized, because the node's value is. The parser rewrites every CRLF and
          // every lone CR in the input stream to LF before a text node ever sees them,
          // so on a CRLF file the raw bytes and the value can never match and this
          // comparison silently found no overhang at all. The tail then printed on top
          // of the bytes it had been relocated from and the file grew a blank line per
          // save. Only the LENGTH taken from here is normalized; the copy path still
          // uses the raw bytes, which is why an unedited CRLF file round trips exactly.
          const inside = src.slice(from, to).replace(/\r\n?/g, '\n');
          if (cl.value.startsWith(inside)) {
            const outside = cl.value.slice(inside.length);
            if (outside && !/\S/.test(outside)) cl.outsideTail = outside;
          }
        }
        cl.clamped = true;
        cl.from = from;
        cl.to = to;
      }
    }
  }
  // Every copy below walks the source forward, so the children have to be in source
  // order. Foster parenting is where they are not: content written inside a <table>
  // that does not belong there is moved OUT, to just before the table, so the tree
  // order and the byte order disagree and a forward walk emits those bytes at the new
  // position and again inside the table. The bytes belong to one element and the node
  // to another, which this model has no way to say, so the document is refused instead
  // and saves it with today's serializer. That is what such a page already got: the
  // render was wrong, verify caught it, and every save fell back.
  let floor = loc.located ? loc.openTo : -1;
  for (const cl of loc.children) {
    if (cl.from < 0) continue;
    if (cl.from < floor) { loc.outOfOrder = true; break; }
    floor = cl.to;
  }
  return loc;
}

function firstOutOfOrder(loc) {
  if (loc.outOfOrder) return loc.tag;
  for (const c of loc.children) {
    if (c.kind !== 'element') continue;
    const found = firstOutOfOrder(c);
    if (found) return found;
  }
  return null;
}

/**
 * Refuse a model that is not this document.
 *
 * The live document parsed the bytes that were actually served, so its doctype and
 * its document-level comments are an oracle for everything render copies from
 * outside <html> — the one region no tree comparison can check, because a tree
 * comparison starts at documentElement. A boot fetch that returned a login page or
 * an error page disagrees here, and that is the difference between doing nothing and
 * writing that page's doctype into somebody's file.
 *
 * @returns {?string} the disagreement, or null when the source is this document
 */
export function checkSource(m, liveDocument) {
  if (!m.root) return 'source has no <html> element';
  // Nothing inside <html> carries a byte range, which is what a document with no
  // elements, text or comments at all looks like. render brackets the whole output
  // with the root's range, so there is nothing here to preserve and nothing to
  // bracket with.
  if (m.root.openFrom < 0) return 'source has no content inside <html>';
  if (m.relocated) return 'the parser moved content out of <' + m.relocated + '>, so source order and tree order disagree';
  const want = outsideOf(liveDocument);
  const got = m.outside.map(outsideKey);
  if (want.length !== got.length) return 'outside <html>: ' + JSON.stringify(got) + ' vs live ' + JSON.stringify(want);
  for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) return 'outside <html>: ' + got[i] + ' vs live ' + want[i];
  return null;
}
function outsideKey(o) { return o.kind === 'doctype' ? 'doctype:' + o.name + '|' + o.publicId + '|' + o.systemId : o.kind + ':' + o.value; }
function outsideOf(doc) {
  const out = [];
  for (const n of doc.childNodes) {
    if (n.nodeType === 10) out.push('doctype:' + n.name + '|' + n.publicId + '|' + n.systemId);
    else if (n.nodeType === 8) out.push('comment:' + n.data);
    else if (n.nodeType !== 1) out.push('#' + n.nodeType + ':' + (n.data || ''));
  }
  return out;
}

// =============================================================================
// SIGNATURES
// =============================================================================
// Four keys per node, computed once, bottom-up. `deep` is the whole subtree (tag,
// attributes, text), `content` ignores attributes at every level, `shallow` is this
// node's tag and attributes only, `tag` is the tag. Alignment tries them strongest
// first, so a runtime attribute change deep inside a card still lets the card pair by
// its text, and two genuinely identical rows pair by position.

const UNIT_SEP = '\u0000';

function mix(h, s) {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function hashKey(parts) {
  let a = 2166136261, b = 5381;
  for (const p of parts) { a = mix(a, p); b = (Math.imul(b, 33) ^ mix(a ^ 0x9e3779b9, p)) >>> 0; }
  return a.toString(36) + '.' + b.toString(36);
}
function liveKids(el) {
  const list = el.nodeType === 1 && el.tagName === 'TEMPLATE' && el.content ? el.content.childNodes : el.childNodes;
  const out = [];
  for (const n of list) if (n.nodeType === 1 || n.nodeType === 3 || n.nodeType === 8) out.push(n);
  return out;
}
const liveAttrsKey = (el) => Array.from(el.attributes, (a) => a.name.toLowerCase() + '=' + a.value).sort().join(UNIT_SEP);
const srcAttrsKey = (loc) => loc.attrs.map((a) => a.key + '=' + a.value).sort().join(UNIT_SEP);
function keysOfLive(n, keyMap) {
  let k;
  if (n.nodeType === 3) k = { tag: '#text', shallow: 't:' + n.data, content: 't:' + n.data, deep: 't:' + n.data };
  else if (n.nodeType === 8) k = { tag: '#comment', shallow: 'c:' + n.data, content: 'c:' + n.data, deep: 'c:' + n.data };
  else {
    const kids = liveKids(n).map((c) => keysOfLive(c, keyMap));
    const shallow = 'e:' + n.localName + '|' + liveAttrsKey(n);
    k = { tag: n.localName, shallow, content: 'e:' + n.localName + '|' + hashKey(kids.map((c) => c.content)), deep: shallow + '|' + hashKey(kids.map((c) => c.deep)) };
  }
  keyMap.set(n, k);
  return k;
}
function keysOfLoc(loc) {
  if (loc.kind === 'text') return (loc.keys = { tag: '#text', shallow: 't:' + loc.value, content: 't:' + loc.value, deep: 't:' + loc.value });
  if (loc.kind === 'comment') return (loc.keys = { tag: '#comment', shallow: 'c:' + loc.value, content: 'c:' + loc.value, deep: 'c:' + loc.value });
  const kids = loc.children.map(keysOfLoc);
  const shallow = 'e:' + loc.tag + '|' + srcAttrsKey(loc);
  return (loc.keys = { tag: loc.tag, shallow, content: 'e:' + loc.tag + '|' + hashKey(kids.map((c) => c.content)), deep: shallow + '|' + hashKey(kids.map((c) => c.deep)) });
}

// =============================================================================
// ALIGNMENT
// =============================================================================

const TIERS = ['deep', 'content', 'shallow', 'tag'];
const DP_CELLS = 4096;

/**
 * Order-preserving matching of two child lists.
 *
 * Per tier: trim the common prefix and suffix, anchor on keys unique to both sides
 * (patience), recurse into the gaps at the same tier, and when a gap has no anchors
 * run an exact LCS only if it is small, otherwise hand the gap to the next weaker
 * tier. Every step is linear in the gap except the LIS (a log a) and the bounded DP,
 * so this is O(n log n) per parent and the DP table never exceeds DP_CELLS cells.
 *
 * The prefix and suffix trim is what makes it linear in practice, not the anchors:
 * half of every child list in a formatted document is indentation text nodes, which
 * are never unique and so never anchor anything. An earlier exact-DP version took 84
 * seconds on 4,000 identical siblings and allocated a 256 MB table; this one takes
 * 4.7 ms, and 32,000 siblings in 15.5 ms.
 */
export function align(LK, SK) {
  const pairs = [];
  const LI = LK.map((_, i) => i), SI = SK.map((_, j) => j);
  stage(LI, SI, 0);
  // An anchor a boot script moved across a run of identical siblings strands that run
  // on opposite sides of it. One more pass over what is still unpaired lets the run
  // pair, crossing the anchor; render treats a crossing pair as a move, which is still
  // a byte copy rather than a reprint.
  const usedL = new Set(pairs.map((p) => p[0])), usedS = new Set(pairs.map((p) => p[1]));
  const restL = LI.filter((i) => !usedL.has(i)), restS = SI.filter((j) => !usedS.has(j));
  if (restL.length && restS.length) stage(restL, restS, 0);
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;

  function stage(li, si, t) {
    let l0 = 0, l1 = li.length, s0 = 0, s1 = si.length;
    if (l0 >= l1 || s0 >= s1) return;
    if (t >= TIERS.length) return positional(li, si);
    const k = TIERS[t];
    while (l0 < l1 && s0 < s1 && LK[li[l0]][k] === SK[si[s0]][k]) { pairs.push([li[l0], si[s0]]); l0++; s0++; }
    while (l0 < l1 && s0 < s1 && LK[li[l1 - 1]][k] === SK[si[s1 - 1]][k]) { l1--; s1--; pairs.push([li[l1], si[s1]]); }
    if (l0 >= l1 || s0 >= s1) return;
    const seenL = new Map(), seenS = new Map();
    for (let x = l0; x < l1; x++) { const key = LK[li[x]][k]; seenL.set(key, seenL.has(key) ? -1 : x); }
    for (let y = s0; y < s1; y++) { const key = SK[si[y]][k]; seenS.set(key, seenS.has(key) ? -1 : y); }
    const cands = [];
    for (let x = l0; x < l1; x++) { const key = LK[li[x]][k]; if (seenL.get(key) === x) { const y = seenS.get(key); if (y !== undefined && y >= 0) cands.push([x, y]); } }
    const anchors = lisPairs(cands);
    if (!anchors.length) {
      if ((l1 - l0) * (s1 - s0) <= DP_CELLS) {
        const got = lcs(LK, SK, li, si, l0, l1, s0, s1, k);
        if (got.length) { let px = l0, py = s0; for (const [x, y] of got) { pairs.push([li[x], si[y]]); stage(li.slice(px, x), si.slice(py, y), t + 1); px = x + 1; py = y + 1; } stage(li.slice(px, l1), si.slice(py, s1), t + 1); return; }
      }
      return stage(li.slice(l0, l1), si.slice(s0, s1), t + 1);
    }
    let px = l0, py = s0;
    for (const [x, y] of anchors) { pairs.push([li[x], si[y]]); stage(li.slice(px, x), si.slice(py, y), t); px = x + 1; py = y + 1; }
    stage(li.slice(px, l1), si.slice(py, s1), t);
  }
  // Last resort for a large gap nothing else resolved: same-tag runs of equal length
  // pair by position.
  function positional(li, si) {
    const byTagL = new Map(), byTagS = new Map();
    for (const i of li) { const tg = LK[i].tag; if (!byTagL.has(tg)) byTagL.set(tg, []); byTagL.get(tg).push(i); }
    for (const j of si) { const tg = SK[j].tag; if (!byTagS.has(tg)) byTagS.set(tg, []); byTagS.get(tg).push(j); }
    for (const [tg, l] of byTagL) { const s = byTagS.get(tg); if (s && s.length === l.length && tg !== '#text' && tg !== '#comment') l.forEach((i, x) => pairs.push([i, s[x]])); }
  }
}

function lisPairs(cands) {   // cands increasing in i; keep the longest subsequence increasing in j
  const tails = [], tailAt = [], prev = new Array(cands.length).fill(-1);
  for (let x = 0; x < cands.length; x++) {
    const v = cands[x][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v; tailAt[lo] = x; prev[x] = lo > 0 ? tailAt[lo - 1] : -1;
  }
  const out = []; let x = tailAt.length ? tailAt[tailAt.length - 1] : -1;
  while (x >= 0) { out.push(cands[x]); x = prev[x]; }
  return out.reverse();
}

function lcs(LK, SK, li, si, l0, l1, s0, s1, k) {
  const n = l1 - l0, m = s1 - s0;
  const eq = (i, j) => LK[li[l0 + i]][k] === SK[si[s0 + j]][k];
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = eq(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(i, j)) { out.push([l0 + i, s0 + j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return out;
}

// =============================================================================
// PAIRING
// =============================================================================

function describe(n) {
  if (n.nodeType === 3) return '#text ' + JSON.stringify(n.data.slice(0, 40));
  if (n.nodeType === 8) return '#comment';
  return '<' + n.localName + Array.from(n.attributes, (a) => ' ' + a.name + '="' + a.value.slice(0, 30) + '"').join('') + '>';
}
function describeLoc(l) {
  if (l.kind === 'text') return '#text ' + JSON.stringify(l.value.slice(0, 40));
  if (l.kind === 'comment') return '#comment';
  return '<' + l.tag + l.attrs.map((a) => ' ' + a.name + '="' + a.value.slice(0, 30) + '"').join('') + '>';
}

/**
 * Pair a tree against the model, and key the result by whatever `resolve` returns.
 *
 * The tree walked here is the SAVE CLONE, not the live DOM, because the clone is in
 * the same domain as the file: edit mode has been deactivated back to the inert
 * attribute forms, [no-save] regions are gone, and every document transform has run.
 * The live DOM is in the activated domain, where `contenteditable="true"` stands
 * where the file says `inert-contenteditable="true"`, and pairing there would fail
 * the two strongest signature tiers on every activated node and on every ancestor of
 * one.
 *
 * The MAP is keyed by the LIVE node (`resolve` is snapshot provenance), because the
 * clone is rebuilt from scratch on every save and its nodes are new objects each
 * time. A clone node a transform created has no live original and simply goes
 * unpaired, which means it is printed, the same thing that happens to it today.
 *
 * @param {Node} root - the tree to walk (the save clone's document element)
 * @param {Object} m - a model()
 * @param {Function} [resolve] - node -> the identity to key the map by (default: itself)
 */
export function pair(root, m, resolve = (n) => n) {
  const map = new WeakMap();
  const keyMap = new Map();
  keysOfLive(root, keyMap);
  keysOfLoc(m.root);
  const stats = { paired: 0, unmatchedLive: [], unmatchedSource: [], attrDiffs: [], textDiffs: 0, unresolved: 0 };
  // A token identifying THIS pairing pass, stamped on the model and on every loc that
  // binds. render trusts a loc only when the two still agree, which rules out a loc
  // left over from an earlier pass and a map paired against a different model. The
  // token is an object rather than the live node on purpose: a loc lives as long as the
  // model, so holding the node here would keep every node the page has since deleted.
  const gen = {};
  m.gen = gen;
  bind(root, m.root, map, keyMap, stats, 'html', resolve, gen);
  return { map, stats };
}

function bind(node, loc, map, keyMap, stats, path, resolve, gen) {
  const key = resolve(node);
  if (key) { map.set(key, loc); loc.gen = gen; stats.paired++; }
  else stats.unresolved++;
  if (loc.kind !== 'element') { if (node.data !== loc.value) stats.textDiffs++; return; }
  if (liveAttrsKey(node) !== srcAttrsKey(loc)) stats.attrDiffs.push({ path, live: describe(node), source: describeLoc(loc) });
  const L = liveKids(node), S = loc.children;
  const pairs = align(L.map((n) => keyMap.get(n)), S.map((l) => l.keys));
  const usedL = new Set(), usedS = new Set();
  for (const [i, j] of pairs) {
    usedL.add(i); usedS.add(j);
    bind(L[i], S[j], map, keyMap, stats, path + '>' + (L[i].nodeType === 1 ? L[i].localName : '#') + '[' + i + ']', resolve, gen);
  }
  for (let i = 0; i < L.length; i++) if (!usedL.has(i)) stats.unmatchedLive.push({ path, node: describe(L[i]) });
  for (let j = 0; j < S.length; j++) if (!usedS.has(j)) stats.unmatchedSource.push({ path, node: describeLoc(S[j]) });
}

// =============================================================================
// RENDER
// =============================================================================

/**
 * Emit the save clone as bytes, copying source for everything unchanged.
 *
 * EXACT. Every clone child is emitted, whitespace text nodes included, and nothing
 * here knows or cares whether a gap is indentation or a rendered space between two
 * inline elements. An earlier version had a "layout parent" rule that dropped
 * whitespace-only children of block elements, which is correct for indentation and
 * wrong for `by <a>Ana</a> <a>Bo</a>`, and it wrote that back as `AnaBo`. CSS
 * collapses a newline and a space identically between inline boxes, so there is no
 * predicate that separates the two cases and the rule had to go, not be refined.
 *
 * @param {HTMLElement} clone - the prepared save clone
 * @param {WeakMap} map - live node -> loc, from pair()
 * @param {Object} m - the model
 * @param {Function} provenance - clone node -> live node
 * @param {Object} [opts] - break switches, for tests that must exercise the fallback
 */
/**
 * Where in the file this live element is.
 *
 * The whole of what an agent editing loop needs beyond the save itself: point at an element in the
 * page, get its range in the bytes that will be written, and express the edit as a source range
 * rather than as a DOM mutation. No ids in the file, no map surviving a reload, no patch lists.
 *
 * OFFSETS ARE UTF-16 CODE UNITS into the same string `text()` returns, because that is the string
 * the model was built from. They are NOT byte offsets, and on a document with any non-ASCII content
 * the two differ: one line of `café 🎉 naïve` puts the same position at 51 code units and 55 UTF-8
 * bytes. Slice the text this module hands you and the answer is exact; feed these numbers to a
 * byte-oriented tool and it edits the wrong place, silently, and only on some documents. `column` is
 * in the same units for the same reason.
 *
 * `null` rather than a guess, and the three reasons are different: a node the page created after
 * boot is not in the file yet, an implied <html>, <head> or <body> the author never wrote has no
 * bytes to point at, and a stale generation means the model was replaced since this map was built.
 * A caller that treats all three as "not found" will mistake the third for the first.
 */
export function locate(node, map, m) {
  const loc = map.get(node);
  if (!loc) return null;                        // never paired, so not in the file
  if (loc.gen !== m.gen) return null;           // a map and a model that were not paired together
  if (loc.from < 0 || loc.to < 0) return null;  // an implied tag has no bytes
  // The bytes at this offset still have to BE this element. A map pointing into the wrong model
  // slices one file's offsets out of another file's bytes, which is silent and lands in whatever
  // the agent writes next, with no verifier between it and the file. Cheap, and it turns the one
  // failure this function can have into a null instead of a wrong answer.
  if (loc.kind === 'element' && loc.located) {
    const head = m.src.slice(loc.openFrom, loc.openFrom + loc.tag.length + 1);
    if (head.toLowerCase() !== '<' + loc.tag.toLowerCase()) return null;
  }
  const starts = lineStarts(m);
  const line = upperBound(starts, loc.from);
  return { from: loc.from, to: loc.to, line: line + 1, column: loc.from - starts[line] + 1 };
}

function lineStarts(m) {
  if (!m.lineStarts) {
    const starts = [0];
    for (let i = 0; i < m.src.length; i++) if (m.src.charCodeAt(i) === 10) starts.push(i + 1);
    m.lineStarts = starts;
  }
  return m.lineStarts;
}

/** The index of the last start at or before `at`. */
function upperBound(starts, at) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function render(clone, map, m, provenance, opts = {}) {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  const src = m.src;
  const pieces = [];
  // `from >= 0` is not defensive padding: `src.slice(-1, n)` is the LAST BYTE of the
  // source, so an unset offset reaching here does not produce nothing, it produces one
  // wrong byte and looks like a successful render.
  const keep = (from, to) => { if (from >= 0 && to > from) pieces.push({ from, to }); };
  const text = (t) => { if (t) pieces.push({ text: t }); };
  const locOfClone = (n) => { const live = provenance(n); const l = live ? map.get(live) : null; return l && l.gen === m.gen ? l : null; };
  const rootLoc = m.root;
  keep(0, rootLoc.openFrom);            // the authored doctype and anything before <html>, verbatim
  emitElement(clone, rootLoc);
  keep(rootLoc.closeTo, src.length);    // the trailing bytes, verbatim

  const out = pieces.map((p) => p.text !== undefined ? p.text : src.slice(p.from, p.to)).join('');
  return { text: out, ms: now() - t0 };

  function emitNode(n, parentTag) {
    if (n.nodeType === 3) return emitText(n, parentTag);
    if (n.nodeType === 8) return emitComment(n);
    if (n.nodeType === 1) return emitElement(n, locOfClone(n));
  }
  function emitComment(n) {
    const loc = locOfClone(n);
    if (loc && loc.kind === 'comment' && loc.value === n.data && loc.from >= 0 && !opts.breakText) keep(loc.from, loc.to);
    else text('<!--' + n.data + '-->');
  }
  function emitText(n, parentTag) {
    const loc = locOfClone(n);
    let data = n.data;
    if (opts.corrupt === 'drop-first-text' && !opts.corrupted && data.trim()) { opts.corrupted = true; data = data.slice(1); }
    if (loc && loc.kind === 'text' && loc.value === data && loc.from >= 0 && !opts.breakText) { keep(loc.from, loc.to); return; }
    if (loc && loc.kind === 'text' && loc.outsideTail && data.endsWith(loc.outsideTail)) {
      data = data.slice(0, data.length - loc.outsideTail.length);
    }
    text(RAW_TEXT.has(parentTag) ? data : escText(data));
  }
  function emitElement(n, loc) {
    const tag = n.localName;
    const isVoid = VOID.has(tag) && n.namespaceURI === XHTML;
    const paired = loc && loc.kind === 'element' && !opts.breakTags ? loc : null;
    if (paired && !paired.located) {
      // An implied tag stays implied when the clone element carries nothing a tag would
      // have to say. Otherwise it is printed, which is what the parser would have to
      // imply anyway plus the attributes.
      //
      // `openFrom < 0` means the source has no bytes here at all, which is what an
      // empty implied <head> looks like in a file that goes straight from <html> to
      // <body>. Printing `<head></head>` there would be this module's own addition to
      // a file nobody asked it to change, so an empty one emits nothing; one that has
      // gained children emits the children and still no tag, and the parser implies it
      // back on the next load.
      if (n.attributes.length === 0) {
        if (paired.openFrom >= 0) { emitChildren(n, paired, tag); return; }
        if (liveKids(n).length) emitChildren(n, null, tag);
        return;
      }
      text(printOpenTag(n));
      if (isVoid) return;
      emitChildren(n, paired.openFrom >= 0 ? paired : null, tag);
      text('</' + tag + '>');
      return;
    }
    if (!paired) {
      text(printOpenTag(n));
      if (isVoid) return;
      emitChildren(n, null, tag);
      text('</' + tag + '>');
      return;
    }
    emitOpenTag(n, paired);
    if (isVoid) return;
    emitChildren(n, paired, tag);
    keep(paired.closeFrom, paired.closeTo);
  }
  function printOpenTag(n) {
    let s = '<' + n.localName;
    for (const a of n.attributes) s += ' ' + a.name + (a.value === '' ? '' : '="' + escAttr(a.value) + '"');
    return s + '>';
  }
  // Attribute by attribute, in the source's own order and its own spelling. One the
  // clone still has with the same value copies its bytes; a changed one keeps the
  // author's quoting; a removed one takes its leading whitespace with it; a new one is
  // appended just before the `>`.
  function emitOpenTag(n, loc) {
    const live = new Map();
    for (const a of n.attributes) live.set(a.name.toLowerCase(), a);
    const seen = new Set();
    let cursor = loc.openFrom;
    for (const a of loc.attrs) {
      if (a.from < 0) continue;
      const cur = live.get(a.key);
      seen.add(a.key);
      if (!cur) { keep(cursor, gapStart(cursor, a.from)); cursor = a.to; continue; }
      if (cur.value === a.value) { keep(cursor, a.to); cursor = a.to; continue; }
      keep(cursor, a.from);
      text(respellAttr(src.slice(a.from, a.to), cur.value));
      cursor = a.to;
    }
    // The `/` before `>` is the tag's own self-closing slash only when it sits outside
    // every attribute. An unquoted value ends at whitespace or `>`, never at `/`, so
    // `<a href=x/>` has the value `x/` and that slash is the value's last byte. Taken
    // for the tag's, it was cut off the copied value and written again before `>`,
    // giving `<a href=x//>`.
    let closeAt = loc.openTo - 1;
    const attrsEnd = loc.attrs.reduce((max, a) => (a.to > max ? a.to : max), loc.openFrom);
    if (src[closeAt - 1] === '/' && closeAt - 1 >= attrsEnd) closeAt--;
    keep(cursor, closeAt);
    for (const a of n.attributes) {
      if (seen.has(a.name.toLowerCase())) continue;
      text(' ' + a.name + (a.value === '' ? '' : '="' + escAttr(a.value) + '"'));
    }
    keep(closeAt, loc.openTo);
  }
  function gapStart(cursor, attrFrom) {
    let i = attrFrom;
    while (i > cursor && /[ \t\n\r\f]/.test(src[i - 1])) i--;
    return i;
  }
  function respellAttr(raw, value) {
    const eq = raw.indexOf('=');
    const name = (eq < 0 ? raw : raw.slice(0, eq)).trimEnd();
    const rest = eq < 0 ? '' : raw.slice(eq + 1).trim();
    const q = rest[0] === "'" ? "'" : rest[0] === '"' ? '"' : '';
    const esc = value.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;');
    if (q === "'" && !value.includes("'")) return name + "='" + esc + "'";
    if (q === '' && rest !== '' && value !== '' && !/[\s"'=<>`]/.test(value)) return name + '=' + esc;
    return name + '="' + esc.replace(/"/g, '&quot;') + '"';
  }
  // Children, exact. Identity decides order: clone children whose source node belongs to
  // this parent and form the longest in-order run stay in place and copy their bytes;
  // every other clone child is emitted where the clone has it (printed, or copied out of
  // place as a move); every source child the clone no longer has is dropped.
  function emitChildren(el, loc, parentTag) {
    const C = liveKids(el);
    if (!loc) { for (const c of C) emitNode(c, parentTag); return; }
    const S = loc.children;
    const sIndex = new Map(S.map((s, j) => [s, j]));
    const owned = C.map((c) => { const l = locOfClone(c); return l && l.parent === loc && l.from >= 0 ? sIndex.get(l) : -1; });
    const inPlace = new Set(lis(owned));
    let cursor = loc.openTo;
    let lastS = -1;
    const dropTo = (j) => { for (let k = lastS + 1; k < j; k++) { const sk = S[k]; if (sk.from < 0) continue; keep(cursor, sk.from); cursor = Math.max(cursor, sk.to); } };
    for (let i = 0; i < C.length; i++) {
      const c = C[i];
      if (inPlace.has(i)) {
        const j = owned[i], s = S[j];
        dropTo(j);
        keep(cursor, s.from);
        emitNode(c, parentTag);
        cursor = Math.max(cursor, s.to); lastS = j;
        continue;
      }
      emitNode(c, parentTag);
    }
    dropTo(S.length);
    keep(cursor, loc.closeFrom);
  }
}

function lis(vals) {
  const tails = [], tailIdx = [], prev = new Array(vals.length).fill(-1);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]; if (v < 0) continue;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v; tailIdx[lo] = i; prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const out = []; let i = tailIdx.length ? tailIdx[tailIdx.length - 1] : -1;
  while (i >= 0) { out.push(i); i = prev[i]; }
  return out.reverse();
}

// =============================================================================
// VERIFY
// =============================================================================
// Independent of render on purpose: its own child enumeration, its own attribute key,
// no notion of layout or whitespace, no shared helper. A check built out of the thing
// it is checking cannot fail in the cases it exists to catch.
//
// Three checks, all exact:
//   1. the rendered document's nodes outside <html> are the live document's
//   2. the rendered <html> subtree equals today's serialization reparsed, node for node
//   3. or, failing that, equals the save clone itself
//
// Either oracle suffices, and they are not the same claim. "Equal to today's bytes" is
// the floor: no worse than the save that would otherwise have gone out. "Equal to the
// clone" is stronger, and is sometimes the only one available, because today's
// serializer is not itself exact: it drops the newline that starts a <pre>, so on a
// document with one, today's bytes reload as a different document and these reload as
// the right one.

export function verify(rendered, today, liveDocument, clone = null, sourceErrors = null) {
  const P = new DOMParser();
  const A = P.parseFromString(rendered, 'text/html');
  const B = P.parseFromString(today, 'text/html');
  const outsideA = vOutside(A), outsideLive = vOutside(liveDocument);
  if (outsideA.join('\n') !== outsideLive.join('\n')) return { ok: false, diff: 'document: outside <html> ' + JSON.stringify(outsideA) + ' vs live ' + JSON.stringify(outsideLive) };
  const diff = vDiff(A.documentElement, B.documentElement, 'html');
  const worse = diff ? null : vParseErrors(rendered, sourceErrors);
  if (!diff) return worse ? { ok: false, diff: worse } : { ok: true, diff: null, oracle: 'today' };
  if (clone && !vDiff(A.documentElement, clone, 'html')) {
    const w = vParseErrors(rendered, sourceErrors);
    return w ? { ok: false, diff: w } : { ok: true, diff: null, oracle: 'clone', todayDiff: diff };
  }
  return { ok: false, diff };
}

/**
 * The check the tree comparison cannot make.
 *
 * A parser DISCARDS some input rather than representing it, so the tree is the same
 * whether or not it was there. A second copy of an attribute is the case that bit:
 * the render wrote `xmlns:xlink` twice, the parser kept the first and dropped the
 * second, and the trees matched. Counting, not presence, because 4 of 198 real user
 * documents already parse with errors: only an INCREASE is the render's doing, and a
 * full serialization cannot produce one, because the DOM it comes from cannot hold a
 * duplicate attribute in the first place.
 *
 * This is narrower than it sounds and worth saying plainly: it catches the discarded
 * class only. Bytes the parser DOES represent, such as a duplicated element, change
 * the tree, and the comparison above is what catches those.
 */
function vParseErrors(rendered, sourceErrors) {
  if (!sourceErrors) return null;
  const seen = new Map();
  parse(rendered, { onParseError: (e) => seen.set(e.code, (seen.get(e.code) || 0) + 1) });
  for (const [code, n] of seen) {
    const was = sourceErrors.get(code) || 0;
    if (n > was) return `the render introduced parse errors the source does not have: ${code} ${was} -> ${n}`;
  }
  return null;
}
function vOutside(doc) {
  const out = [];
  for (const n of doc.childNodes) {
    if (n.nodeType === 10) out.push('doctype ' + n.name + '|' + n.publicId + '|' + n.systemId);
    else if (n.nodeType === 8) out.push('comment ' + n.data);
    else if (n.nodeType !== 1) out.push('node' + n.nodeType + ' ' + (n.data || ''));
  }
  return out;
}
/**
 * <noscript> is the one element whose children depend on a flag neither side of this
 * comparison controls. A page the browser loaded was parsed with scripting ENABLED, so
 * the live tree holds the block's markup as a single text node. DOMParser always parses
 * with scripting DISABLED, so re-reading the rendered bytes turns that same markup back
 * into elements. The two trees can never agree, and without this a document containing
 * one <noscript> would fail verification on every save, forever, which is worse than a
 * wrong answer: it is a permanent false alarm on the counter that stage 2 reads.
 *
 * So both sides hand their content to ONE parser and the resulting trees are compared.
 * That is exact rather than tolerant: anything the renderer corrupted inside the block
 * still changes the tree its markup parses to. Recursion terminates because each step
 * compares strictly less markup than the one above it.
 */
function vNoscript(a, b, path) {
  const P = new DOMParser();
  const inner = (el) => {
    const kids = Array.from(el.childNodes);
    return kids.length && kids.every((n) => n.nodeType === 3) ? kids.map((n) => n.data).join('') : el.innerHTML;
  };
  return vDiff(P.parseFromString(inner(a), 'text/html').body, P.parseFromString(inner(b), 'text/html').body, path + '>#noscript');
}
function vKids(el) {
  const list = el.localName === 'template' && el.content ? el.content.childNodes : el.childNodes;
  return Array.from(list).filter((n) => n.nodeType === 1 || n.nodeType === 3 || n.nodeType === 8);
}
const vAttrs = (el) => Array.from(el.attributes, (a) => (a.namespaceURI || '') + ' ' + a.name + '=' + JSON.stringify(a.value)).sort().join('; ');
function vDiff(a, b, path) {
  if (a.nodeType !== b.nodeType) return path + ': node type ' + a.nodeType + ' vs ' + b.nodeType;
  if (a.nodeType === 3 || a.nodeType === 8) return a.data === b.data ? null : path + ': text ' + JSON.stringify(a.data.slice(0, 60)) + ' vs ' + JSON.stringify(b.data.slice(0, 60));
  if (a.localName !== b.localName || a.namespaceURI !== b.namespaceURI) return path + ': tag ' + a.localName + ' vs ' + b.localName;
  if (vAttrs(a) !== vAttrs(b)) return path + ': attrs ' + vAttrs(a) + ' vs ' + vAttrs(b);
  if (a.localName === 'noscript' && a.namespaceURI === XHTML) return vNoscript(a, b, path);
  const ka = vKids(a), kb = vKids(b);
  if (ka.length !== kb.length) return path + ': ' + ka.length + ' vs ' + kb.length + ' children';
  for (let i = 0; i < ka.length; i++) { const d = vDiff(ka[i], kb[i], path + '>' + (ka[i].localName || '#') + '[' + i + ']'); if (d) return d; }
  return null;
}
