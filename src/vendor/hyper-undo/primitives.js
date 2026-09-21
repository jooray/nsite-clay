// One MutationRecord becomes one or more primitives. A childList record
// with both addedNodes and removedNodes produces two primitives (one add,
// one remove). Attribute and characterData each produce one.
//
// Each primitive carries everything needed to replay it in either direction
// without re-reading the live DOM.

export function recordToPrimitives(record, ignoreNode = null) {
  const out = []

  if (record.type === 'attributes') {
    const target = record.target
    const name = record.attributeName
    const oldValue = record.oldValue
    const newValue = target.getAttribute(name)

    if (oldValue == null && newValue != null) {
      out.push({ kind: 'attr-add', target, name, newValue })
    } else if (oldValue != null && newValue == null) {
      out.push({ kind: 'attr-remove', target, name, oldValue })
    } else if (oldValue !== newValue) {
      out.push({ kind: 'attr-set', target, name, oldValue, newValue })
    }
    return out
  }

  if (record.type === 'characterData') {
    out.push({
      kind: 'text',
      target: record.target,
      oldValue: record.oldValue,
      newValue: record.target.data,
    })
    return out
  }

  if (record.type === 'childList') {
    const parent = record.target
    const before = record.nextSibling   // the slot to re-insert before
    let afterAuthored = record.nextSibling
    while (afterAuthored && ignoreNode?.(afterAuthored)) afterAuthored = afterAuthored.nextSibling
    let beforeAuthored = record.previousSibling
    while (beforeAuthored && ignoreNode?.(beforeAuthored)) beforeAuthored = beforeAuthored.previousSibling
    // The parent target already passed the caller's ignore filter, but an
    // individual added/removed node can itself be an ignored subtree (e.g. a
    // save-ignore CMS shell appended directly under <body>). Drop those nodes
    // so undo never records or reverses them; emit no primitive if a side ends
    // up empty.
    const added = ignoreNode
      ? Array.from(record.addedNodes).filter((n) => !ignoreNode(n))
      : Array.from(record.addedNodes)
    const removed = ignoreNode
      ? Array.from(record.removedNodes).filter((n) => !ignoreNode(n))
      : Array.from(record.removedNodes)
    if (added.length > 0) {
      out.push({ kind: 'add', parent, nodes: added, before, afterAuthored, beforeAuthored })
    }
    if (removed.length > 0) {
      out.push({ kind: 'remove', parent, nodes: removed, before, afterAuthored, beforeAuthored })
    }
    return out
  }

  return out
}

// Convert a whole batch of records (one observer delivery, or one
// takeRecords() drain) into primitives, coalescing repeated mutations of the
// SAME (target, attributeName) within the batch.
//
// Why batch-level: MutationObserver does not expose a per-record NEW attribute
// value, and by the time we run, the DOM already reflects every mutation in the
// batch. So recordToPrimitives' `getAttribute(name)` can only read the FINAL
// value. When an attribute is touched twice in one batch (e.g. add-then-remove,
// or remove-then-readd-same), classifying each record off that final value
// misclassifies or drops records and corrupts undo. We instead keep the FIRST
// record's oldValue and the FINAL live value, emitting one primitive per
// (target, name) — or none when they're equal (a net no-op within the batch).
// Records arrive already filtered by the caller; order is preserved, with each
// coalesced attribute primitive landing at its first occurrence.
export function recordsToPrimitives(records, ignoreNode = null) {
  const out = []
  const seen = new Map()   // target → Map(name → { idx, oldValue })

  for (const record of records) {
    if (record.type === 'attributes') {
      const target = record.target
      const name = record.attributeName
      let byName = seen.get(target)
      if (!byName) { byName = new Map(); seen.set(target, byName) }
      if (!byName.has(name)) {
        byName.set(name, { idx: out.length, oldValue: record.oldValue })
        out.push(null)   // placeholder, finalized below
      }
      // Repeat occurrences in this batch are folded into the first.
      continue
    }
    for (const p of recordToPrimitives(record, ignoreNode)) out.push(p)
  }

  for (const [target, byName] of seen) {
    for (const [name, info] of byName) {
      const oldValue = info.oldValue
      const newValue = target.getAttribute(name)
      let prim = null
      if (oldValue === newValue) {
        prim = null                                              // net no-op
      } else if (oldValue == null) {
        prim = { kind: 'attr-add', target, name, newValue }
      } else if (newValue == null) {
        prim = { kind: 'attr-remove', target, name, oldValue }
      } else {
        prim = { kind: 'attr-set', target, name, oldValue, newValue }
      }
      out[info.idx] = prim
    }
  }

  return out.filter((p) => p != null)
}

// Forward replay. Used by redo().
export function replayForward(p) {
  switch (p.kind) {
    case 'attr-set':
    case 'attr-add':
      p.target.setAttribute(p.name, p.newValue)
      return
    case 'attr-remove':
      p.target.removeAttribute(p.name)
      return
    case 'text':
      p.target.data = p.newValue
      return
    case 'value':
      // An element PROPERTY write (e.g. input.value / checkbox.checked). These
      // fire no MutationRecord, so they never arrive via the observer — a caller
      // records them explicitly through scope.recordValue().
      if (p.write) p.write(p.target, p.newValue)
      else p.target[p.prop] = p.newValue
      return
    case 'add':
      insertAtRecordedContentSlot(p)
      return
    case 'remove':
      for (const node of p.nodes) {
        if (node.parentNode === p.parent) {
          p.parent.removeChild(node)
        }
      }
      return
  }
}

// Reverse replay. Used by undo().
export function replayReverse(p) {
  // A step only replays while the change it describes is still standing. With
  // live sync the value can have moved on since it was recorded, and writing the
  // old one back would not undo the person's own edit, it would overwrite
  // somebody else's newer one. Skipping is the lesser surprise: an undo press
  // that appears to do nothing costs a moment, an overwrite costs their work.
  switch (p.kind) {
    case 'attr-set':
      if (p.target.getAttribute(p.name) !== p.newValue) return
      p.target.setAttribute(p.name, p.oldValue)
      return
    case 'attr-add':
      if (p.target.getAttribute(p.name) !== p.newValue) return
      p.target.removeAttribute(p.name)
      return
    case 'attr-remove':
      if (p.target.hasAttribute(p.name)) return
      p.target.setAttribute(p.name, p.oldValue)
      return
    case 'text':
      if (p.target.data !== p.newValue) return
      p.target.data = p.oldValue
      return
    case 'value':
      if ((p.read ? p.read(p.target) : p.target[p.prop]) !== p.newValue) return
      if (p.write) p.write(p.target, p.oldValue)
      else p.target[p.prop] = p.oldValue
      return
    case 'add':
      // forward was add → reverse is remove
      for (const node of p.nodes) {
        if (node.parentNode === p.parent) {
          p.parent.removeChild(node)
        }
      }
      return
    case 'remove':
      // forward was remove → reverse is add. Re-insert at the same slot.
      insertAtRecordedContentSlot(p)
      return
  }
}

function insertAtRecordedContentSlot(p) {
  if (p.afterAuthored?.parentNode === p.parent) {
    for (const node of p.nodes) p.parent.insertBefore(node, p.afterAuthored)
    return
  }
  if (p.beforeAuthored?.parentNode === p.parent) {
    let anchor = p.beforeAuthored
    for (const node of p.nodes) {
      anchor.after(node)
      anchor = node
    }
    return
  }
  for (const node of p.nodes) {
    if (p.before?.parentNode === p.parent) p.parent.insertBefore(node, p.before)
    else p.parent.appendChild(node)
  }
}
