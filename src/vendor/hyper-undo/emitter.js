export function createEmitter() {
  const listeners = new Map()  // name → Set of fns

  function on(name, fn) {
    let set = listeners.get(name)
    if (!set) { set = new Set(); listeners.set(name, set) }
    set.add(fn)
    return () => off(name, fn)
  }
  function off(name, fn) {
    const set = listeners.get(name)
    if (set) set.delete(fn)
  }
  function emit(name, payload) {
    const set = listeners.get(name)
    if (!set) return
    for (const fn of Array.from(set)) {
      try { fn(payload) } catch (e) { console.error('[hyper-undo] listener threw', e) }
    }
  }
  return { on, off, emit }
}
