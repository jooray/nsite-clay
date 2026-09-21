// Installs a single window-level keydown listener in capture phase.
// Returns a cleanup function.

export function installKeys(scope, onDetached) {
  const handler = (event) => {
    // If the scope root was removed from the document, release the global
    // binding and let native Cmd+Z through instead of undoing a detached tree.
    const scopeEl = scope.scope
    if (scopeEl && scopeEl.nodeType === 1 && scopeEl.isConnected === false) {
      if (onDetached) onDetached()
      return
    }

    // Bypass for in-page editors (CodeMirror, Monaco, etc.)
    const target = event.target
    const shadow = scope._config.shadowKeydownIn
    if (target && target.closest && Array.isArray(shadow)) {
      for (const selector of shadow) {
        try { if (target.closest(selector)) return }
        catch (_) { /* invalid selector, skip */ }
      }
    }

    const mod = event.metaKey || event.ctrlKey
    if (!mod) return

    const key = (event.key || '').toLowerCase()

    if (key === 'z' && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation()
      scope.undo()
      return
    }
    if (key === 'z' && event.shiftKey) {
      event.preventDefault(); event.stopPropagation()
      scope.redo()
      return
    }
    if (key === 'y' && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation()
      scope.redo()
      return
    }
  }

  window.addEventListener('keydown', handler, true)
  return () => window.removeEventListener('keydown', handler, true)
}
