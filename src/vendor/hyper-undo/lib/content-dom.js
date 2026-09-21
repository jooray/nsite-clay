// GENERATED from clayjs/src/lib/content-dom.js. Edit ClayJS and run `npm run propagate:foundation`.

import { capabilitySelector, hasCapability } from './region-capabilities.js'

const UNSUPPORTED_SELECTOR = /:(?:focus(?:-within|-visible)?|hover|active|visited|defined)\b/i

function copyControlState(source, copy) {
  if (!/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(source.tagName || '')) return
  const type = (source.getAttribute?.('type') || '').toLowerCase()
  if ('value' in source && 'value' in copy && source.tagName !== 'OPTION' && type !== 'checkbox' && type !== 'radio') copy.value = source.value
  if ('checked' in source && 'checked' in copy) copy.checked = source.checked
  if ('selected' in source && 'selected' in copy) copy.selected = source.selected
  if (source.tagName === 'SELECT') {
    for (let i = 0; i < source.options.length; i++) copy.options[i].selected = source.options[i].selected
  }
  if ('indeterminate' in source && 'indeterminate' in copy) copy.indeterminate = source.indeterminate
}

function matchesWithin(node, selector, boundary, inherit) {
  if (inherit) return !!node.closest?.(selector)
  let current = node
  while (current?.nodeType === 1) {
    if (current.matches(selector)) return true
    if (current === boundary) break
    current = current.parentElement
  }
  return false
}

function importTree(source, targetDocument, capability, capabilityMatch, exclude, boundary, inherit, maps) {
  if (source.nodeType === 1 && (
    (inherit ? hasCapability(source, capability) : matchesWithin(source, capabilityMatch, boundary, false)) ||
    (exclude && matchesWithin(source, exclude, boundary, inherit))
  )) return null
  const copy = targetDocument.importNode(source, false)
  maps.cloneToLive.set(copy, source)
  maps.liveToClone.set(source, copy)
  const sourceChildren = source.nodeType === 1 && source.tagName === 'TEMPLATE' ? source.content : source
  const copyChildren = copy.nodeType === 1 && copy.tagName === 'TEMPLATE' ? copy.content : copy
  if (sourceChildren !== source) {
    maps.cloneToLive.set(copyChildren, sourceChildren)
    maps.liveToClone.set(sourceChildren, copyChildren)
  }
  for (const child of sourceChildren.childNodes || []) {
    const childCopy = importTree(child, targetDocument, capability, capabilityMatch, exclude, boundary, inherit, maps)
    if (childCopy) {
      copyChildren.appendChild(childCopy)
      if (child.nodeType === 1) copyControlState(child, childCopy)
    }
  }
  if (source.nodeType === 1) copyControlState(source, copy)
  return copy
}

export function createContentView(context, { capability = 'data', exclude = null, inherit = true } = {}) {
  if (!context) throw new TypeError('createContentView requires a DOM context')
  const sourceDocument = context.nodeType === 9 ? context : context.ownerDocument
  if (!sourceDocument?.implementation?.createHTMLDocument) {
    throw new TypeError('createContentView requires an HTML DOM implementation')
  }
  const inertDocument = sourceDocument.implementation.createHTMLDocument('')
  const cloneToLive = new WeakMap()
  const liveToClone = new WeakMap()
  const sourceRoot = context.nodeType === 9 ? context.documentElement : context
  if (exclude) inertDocument.documentElement.matches(exclude)
  const capabilityMatch = capabilitySelector(capability)
  const root = importTree(sourceRoot, inertDocument, capability, capabilityMatch, exclude, sourceRoot, inherit, { cloneToLive, liveToClone })
  if (context.nodeType === 9 && root) {
    inertDocument.replaceChild(root, inertDocument.documentElement)
    liveToClone.set(context, inertDocument)
    cloneToLive.set(inertDocument, context)
  }

  const assertSelector = selector => {
    if (UNSUPPORTED_SELECTOR.test(selector)) {
      throw new Error(`Filtered content queries do not support stateful selector: ${selector}`)
    }
  }

  return {
    root,
    document: inertDocument,
    capability,
    selector: capabilitySelector(capability),
    cloneToLive,
    liveToClone,
    original(node) { return cloneToLive.get(node) || null },
    cloneOf(node) { return liveToClone.get(node) || null },
    query(selector, queryRoot = root) {
      assertSelector(selector)
      return Array.from(queryRoot.querySelectorAll(selector), node => cloneToLive.get(node) || node)
    },
    text(node = root) {
      const projected = node === root ? root : liveToClone.get(node)
      return projected?.textContent || ''
    },
    html(node = root) {
      const projected = node === root ? root : liveToClone.get(node)
      return projected?.innerHTML ?? ''
    },
    clone(node = root) {
      const projected = node === root ? root : liveToClone.get(node)
      return projected ? inertDocument.importNode(projected, true) : null
    },
  }
}

export function cleanContentClone(node, options) {
  return createContentView(node, options).root
}
