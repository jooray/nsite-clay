// Decides whether a mutation should be ignored for undo. Mirrors hyperclayjs's
// region capability model: a mutation is ignored when its node sits in a region
// the resolver marks NOT undoable (no-undo / no-watch / the legacy markers /
// browser-extension content), when the record is an extension marker attribute,
// or when the caller's ignoreAttributePredicate rejects it.
//
// When paired with a platform client we delegate the region decision to the SAME
// resolver it ships (clay.region.resolveRegionPolicy under clayjs,
// hyperclay.region.resolveRegionPolicy under hyperclayjs), so undo and the platform
// can never drift. Standalone (neither on window) we fall back to a local marker
// walk that mirrors the resolver's `undoable` axis.

import { EXTENSION_NODE_SELECTOR, EXTENSION_ATTR_PATTERN } from './extension-noise.js'
import { expandsTo, hasPolicyToken, isPolicyAttribute } from './lib/region-capabilities.js'

// Local fallback: attributes whose region is NOT undoable. The new no-save /
// no-trigger-autosave / freeze are deliberately ABSENT — those regions ARE
// undoable in the capability model; only no-undo / no-watch (and the legacy
// markers, which all imply no-undo) suppress recording.
const IGNORE_ATTRS = ['mutations-ignore', 'save-remove', 'save-ignore', 'save-freeze', 'no-undo', 'no-watch']

function sharedResolver() {
  if (typeof window === 'undefined') return null
  const region = window.clay?.region || window.hyperclay?.region
  return region && typeof region.resolveRegionPolicy === 'function'
    ? region.resolveRegionPolicy
    : null
}

// Is the node in a region that should not be recorded by undo?
function regionNotUndoable(node) {
  const resolve = sharedResolver()
  if (resolve) {
    try { if (!resolve(node).undoable) return true }
    catch (_) { /* fall through to the local walk */ }
  }
  let el = (node && node.nodeType !== 1) ? node.parentElement : node
  // Browser-extension injected elements (and their descendants) are not page content.
  if (el && el.closest && el.closest(EXTENSION_NODE_SELECTOR)) return true
  while (el && el.nodeType === 1) {
    if (expandsTo(el, 'no-undo') || expandsTo(el, 'no-watch')) return true
    for (const attr of IGNORE_ATTRS) if (hasPolicyToken(el, attr)) return true
    el = el.parentElement
  }
  return false
}

function regionWasNotUndoable(record) {
  let source = record.target
  let clone = source.cloneNode(false)
  const leaf = clone
  while (source.parentElement) {
    source = source.parentElement
    const parent = source.cloneNode(false)
    parent.appendChild(clone)
    clone = parent
  }
  if (record.oldValue == null) leaf.removeAttribute(record.attributeName)
  else leaf.setAttribute(record.attributeName, record.oldValue)
  return regionNotUndoable(leaf)
}

export function shouldIgnore(node, ignoreAttributePredicate, record) {
  const policyTransition = record?.type === 'attributes' && isPolicyAttribute(record.attributeName)
  if (policyTransition) {
    if (regionNotUndoable(node) && regionWasNotUndoable(record)) return true
  } else if (regionNotUndoable(node)) return true

  if (record && record.type === 'attributes') {
    // Extension marker attributes on a real element (password-manager field tags) are noise.
    if (record.attributeName && EXTENSION_ATTR_PATTERN.test(record.attributeName.toLowerCase())) return true
    if (ignoreAttributePredicate) {
      try {
        if (ignoreAttributePredicate(record.attributeName, record.target)) return true
      } catch (_) {}
    }
  }
  return false
}
