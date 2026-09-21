import { createScope } from './scope.js'
import { installKeys } from './keys.js'

const DEFAULT_SHADOW_LIST = [
  '.CodeMirror',
  '.cm-editor',
  '.monaco-editor',
  '.ace_editor',
  '.ql-editor',
  '.tiptap',
  '.ProseMirror',
  // richclay marks its live region with this and stamps no-undo on it, so the
  // page-level stack holds no record of what was typed there. Without the
  // bypass, Cmd+Z inside a richclay editor never reached Squire: it either did
  // nothing or reverted an unrelated earlier edit elsewhere on the page.
  // richclay has always intended this; see the comment on setupEditorAttributes
  // in richclay/src/richclay.js, which says it marks the region so hyper-undo
  // "defers to Squire instead of fighting it".
  '[data-richclay-active]',
]

let singleton = null         // the Scope instance returned by createScope
let singletonScope = null    // the DOM element it's bound to (for diff-scope detection)
let singletonKeys = null     // cleanup fn from installKeys, if bound
let keyOwner = null          // { inst, cleanup } — the one scope owning global Cmd+Z

// Only ONE scope may own the global Cmd+Z binding at a time (locked plan
// decision). Idempotent for the same owner (so a repeated start() doesn't
// double-bind); throws for a different live owner until it's stopped.
function claimKeys(inst, onDetached) {
  if (keyOwner) {
    if (keyOwner.inst === inst) return keyOwner.cleanup
    throw new Error(
      'hyper-undo: another scope already owns the global Cmd+Z binding (bindKeys: true). ' +
      'Stop it first, or use bindKeys: false for additional scopes.'
    )
  }
  const cleanup = installKeys(inst, onDetached)
  keyOwner = { inst, cleanup }
  return cleanup
}
function releaseKeys(inst) {
  if (keyOwner && keyOwner.inst === inst) {
    keyOwner.cleanup()
    keyOwner = null
  }
}

const undo = {
  defaults: { shadowKeydownIn: DEFAULT_SHADOW_LIST },

  start(opts = {}) {
    const scopeEl = opts.scope || (typeof document !== 'undefined' ? document.body : null)
    if (!scopeEl) throw new Error('hyper-undo: no scope (need document.body or explicit { scope })')

    if (singleton) {
      if (singletonScope === scopeEl) {
        console.warn('[hyper-undo] start() called again on existing singleton; ignoring new options')
        return singleton
      }
      throw new Error(
        'hyper-undo: start() called with a different scope while the singleton is already started. ' +
        'Use undo.create({ scope }) for additional scopes, or call undo.stop() first.'
      )
    }

    const config = {
      ...opts,
      scope: scopeEl,
      shadowKeydownIn: opts.shadowKeydownIn || DEFAULT_SHADOW_LIST,
    }
    singleton = createScope(config)
    singleton.start()
    singletonScope = scopeEl
    if (opts.bindKeys !== false) {
      singletonKeys = claimKeys(singleton, () => undo.stop())
    }
    return singleton
  },

  stop() {
    if (!singleton) return
    releaseKeys(singleton)
    singletonKeys = null
    singleton.stop()
    singleton = null
    singletonScope = null
  },

  create(opts = {}) {
    const scopeEl = opts.scope || (typeof document !== 'undefined' ? document.body : null)
    if (!scopeEl) throw new Error('hyper-undo: no scope (need document.body or explicit { scope })')
    const config = {
      ...opts,
      scope: scopeEl,
      shadowKeydownIn: opts.shadowKeydownIn || DEFAULT_SHADOW_LIST,
    }
    const inst = createScope(config)
    let keysCleanup = null
    // Delegate explicitly (NOT object-spread) so the canUndo/canRedo/history/
    // isPaused getters stay live — spreading would snapshot them at create time.
    const wrapper = {
      _config: inst._config,
      commit: inst.commit,
      commitCaptured: inst.commitCaptured,
      discardCaptured: inst.discardCaptured,
      flush: inst.flush,
      record: inst.record,
      recordValue: inst.recordValue,
      undo: inst.undo,
      redo: inst.redo,
      clear: inst.clear,
      pause: inst.pause,
      resume: inst.resume,
      on: inst.on,
      off: inst.off,
      get canUndo() { return inst.canUndo },
      get canRedo() { return inst.canRedo },
      get isPaused() { return inst.isPaused },
      get history() { return inst.history },
      get scope() { return inst.scope },
      start() {
        // Claim the global key binding first so a conflict throws before the
        // observer starts (no partial start). claimKeys is idempotent for this
        // same inst, so a repeated start() never double-binds.
        if (opts.bindKeys) keysCleanup = claimKeys(inst, () => wrapper.stop())
        inst.start()
      },
      stop() {
        releaseKeys(inst)
        keysCleanup = null
        inst.stop()
      },
    }
    return wrapper
  },

  // Singleton delegators
  commit(label, fn)       { return singleton ? singleton.commit(label, fn) : undefined },
  commitCaptured(label)   { return singleton ? singleton.commitCaptured(label) : undefined },
  discardCaptured()       { return singleton ? singleton.discardCaptured() : undefined },
  record(p)               { return singleton ? singleton.record(p) : undefined },
  recordValue(t, o)       { return singleton ? singleton.recordValue(t, o) : undefined },
  undo()                  { return singleton ? singleton.undo() : undefined },
  redo()                  { return singleton ? singleton.redo() : undefined },
  clear()                 { return singleton ? singleton.clear() : undefined },
  pause()                 { return singleton ? singleton.pause() : undefined },
  resume()                { return singleton ? singleton.resume() : undefined },
  flush()                 { return singleton ? singleton.flush() : undefined },
  on(name, fn)            { return singleton ? singleton.on(name, fn) : undefined },
  off(name, fn)           { return singleton ? singleton.off(name, fn) : undefined },
  get canUndo()           { return singleton ? singleton.canUndo : false },
  get canRedo()           { return singleton ? singleton.canRedo : false },
  get history()           { return singleton ? singleton.history : [] },
  get isPaused()          { return singleton ? singleton.isPaused : false },
}

export { undo }
export default undo
