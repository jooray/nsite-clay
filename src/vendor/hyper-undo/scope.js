import { recordsToPrimitives, replayForward, replayReverse } from './primitives.js'
import { shouldIgnore } from './filter.js'
import { createEmitter } from './emitter.js'

const DEFAULTS = {
  maxHistory: 100,
  idleWindowMs: 500,
  idleLabel: 'Edit',
  ignoreAttribute: null,
  debug: false,
}

export function createScope(opts) {
  const config = { ...DEFAULTS, ...opts }
  if (!config.scope) throw new Error('hyper-undo: scope is required')

  const emitter = createEmitter()
  const undoStack = []        // [{ label, timestamp, primitives }]
  const redoStack = []        // same shape
  let pendingPrimitives = []  // primitives collected since last commit
  let idleTimer = null
  let observer = null
  let pauseDepth = 0       // reference-counted; recording is active only at 0
  let started = false

  function log(...args) { if (config.debug) console.log('[hyper-undo]', ...args) }

  // --- Lifecycle ---

  function start() {
    if (started) return
    started = true
    observer = createRecordSource(handleRecords)
    observer.observe(config.scope, {
      childList: true,
      attributes: true,
      characterData: true,
      subtree: true,
      attributeOldValue: true,
      characterDataOldValue: true,
    })
    log('started')
  }

  // Choose the record source ONCE. Paired with hyperclayjs AND watching the
  // document.body singleton, source records from the platform's single shared
  // observer (Mutation.createObserver) so the page runs ONE MutationObserver.
  // Otherwise — standalone, or a created shadow/CodeMirror scope — use a real
  // MutationObserver. The result is duck-typed: only observe / disconnect /
  // takeRecords are touched, and the shared hub observes with options identical
  // to the ones above, so nothing here needs to change between the two paths.
  function createRecordSource(handler) {
    const isBodySingleton = typeof document !== 'undefined' && config.scope === document.body
    const hub = (typeof window !== 'undefined' &&
      (window.clay?.Mutation || window.hyperclay?.Mutation)) || null
    if (isBodySingleton && hub && typeof hub.createObserver === 'function') {
      log('sourcing records from the platform Mutation hub (shared observer)')
      return hub.createObserver(handler)
    }
    return new MutationObserver(handler)
  }

  function stop() {
    if (!started) return
    started = false
    if (observer) { observer.disconnect(); observer = null }
    clearIdleTimer()
    undoStack.length = 0
    redoStack.length = 0
    pendingPrimitives = []
    pauseDepth = 0   // reset so a reused (created) scope doesn't restart paused
    log('stopped')
  }

  // The plan requires a scope whose root has been removed from the document to
  // stop itself with its stack cleared. Detected lazily at the next undo/redo
  // (and at the key handler in keys.js) rather than via a polling timer.
  function scopeDisconnected() {
    const el = config.scope
    return !!(el && el.nodeType === 1 && el.isConnected === false)
  }

  // --- Observer callback ---

  function handleRecords(records) {
    // While paused, these callback-delivered records are DROPPED — they have
    // already left the observer's buffer, so they're gone. resume()'s
    // takeRecords() separately purges only the remainder that was never
    // delivered. Those two halves together are the pause contract, and the
    // shimmed (paired) path reproduces both.
    if (pauseDepth > 0) return
    const prims = convertRecords(records)
    if (prims.length > 0) {
      for (const p of prims) pendingPrimitives.push(p)
      restartIdleTimer()
    }
  }

  // Filter ignored records, then coalesce same-attribute repeats within the batch.
  function convertRecords(records) {
    const ignored = (node, record) => config.ignoreNode?.(node) || shouldIgnore(node, config.ignoreAttribute, record)
    const kept = records.filter((r) => !ignored(r.target, r))
    return recordsToPrimitives(kept, (node) => ignored(node))
  }

  // --- Idle batching ---

  function restartIdleTimer() {
    clearIdleTimer()
    idleTimer = setTimeout(closeIdleBatch, config.idleWindowMs)
  }
  function clearIdleTimer() {
    if (idleTimer != null) { clearTimeout(idleTimer); idleTimer = null }
  }
  function closeIdleBatch() {
    idleTimer = null
    if (pendingPrimitives.length === 0) return
    const primitives = pendingPrimitives
    pendingPrimitives = []
    pushCommit(config.idleLabel, primitives)
  }

  // --- Commit machinery ---

  function pushCommit(label, primitives) {
    undoStack.push({ label, timestamp: Date.now(), primitives })
    redoStack.length = 0
    while (undoStack.length > config.maxHistory) undoStack.shift()
    log('commit', label, 'primitives:', primitives.length)
    emitter.emit('commit')
  }

  // Explicit commit: caller-driven, synchronous fn.
  function commit(label, fn) {
    if (!started) throw new Error('hyper-undo: scope not started')
    // Drain anything already buffered from this same synchronous tick (e.g.
    // typing whose observer callback hasn't fired yet) into pending, THEN close
    // it as its own batch — so the explicit commit starts clean and prior work
    // isn't swallowed under this label.
    handleRecords(observer.takeRecords())
    flush()
    const result = fn()
    if (result && typeof result.then === 'function') {
      throw new Error('hyper-undo: commit() fn must be synchronous; returned a Promise')
    }
    // Drain records the observer hasn't fired callback for yet.
    handleRecords(observer.takeRecords())
    if (pendingPrimitives.length === 0) {
      emitter.emit('commit')
      return
    }
    clearIdleTimer()
    const primitives = pendingPrimitives
    pendingPrimitives = []
    pushCommit(label, primitives)
  }

  // Pause-before / commit-on-success pattern used by hypercms.
  // Caller: pause() → run code → commitCaptured(label) on success / discardCaptured() on failure → resume().
  function commitCaptured(label) {
    if (!started) throw new Error('hyper-undo: scope not started')
    if (!observer) return
    // If an OUTER pause is still active (this capture frame is nested inside an
    // exclusion pause), honor the outer "exclude everything" contract: discard
    // the captured records instead of committing through the outer pause.
    if (pauseDepth > 1) { observer.takeRecords(); return }
    // Close any pending idle batch (e.g. in-progress typing captured BEFORE the
    // pause) as its own commit FIRST, so the structural commit we're about to
    // push lands AFTER it in history. Without this, type-then-immediately-add
    // would record the structural op before the typing, inverting undo order.
    flush()
    const primitives = convertRecords(observer.takeRecords())
    if (primitives.length === 0) return
    clearIdleTimer()
    pushCommit(label, primitives)
  }

  function discardCaptured() {
    if (observer) observer.takeRecords()
  }

  // --- Manual recording (for changes the observer can't see) ---

  // Record a primitive the MutationObserver never delivers — an element PROPERTY
  // write (input.value, checkbox.checked) fires no MutationRecord. The primitive
  // joins the same idle batch as observed edits, so rapid same-field property
  // writes coalesce into one commit exactly like text edits do. No-op while
  // stopped or paused (a paused caller is inside an undo/redo replay or an
  // exclusion frame, where injected primitives would be wrong).
  function record(primitive) {
    if (!started || pauseDepth > 0 || !primitive) return
    pendingPrimitives.push(primitive)
    restartIdleTimer()
  }

  // Convenience for the common case: a value/checked property write on an element.
  function recordValue(target, { prop = 'value', oldValue, newValue, read, write } = {}) {
    if (!target || oldValue === newValue) return
    record({ kind: 'value', target, prop, oldValue, newValue, read, write })
  }

  // Force-close current idle batch as its own commit. Used by undo()/redo() and
  // by the save seam (snapshot.js calls undo.flush() before cloning).
  function flush() {
    // Drain same-tick records the observer hasn't delivered yet so the batch
    // boundary is correct (e.g. a synchronous save right after a DOM edit).
    // Skip while paused — the paused caller (commitCaptured) drains the buffer
    // itself, and draining here would route those records through the
    // early-returning handleRecords and lose them.
    if (pauseDepth === 0 && observer) handleRecords(observer.takeRecords())
    if (pendingPrimitives.length === 0) return
    clearIdleTimer()
    closeIdleBatch()
  }

  // --- Pause/resume ---

  // Reference-counted so nested pauses (e.g. a hypercms commit wrapping a
  // live-sync morph that also pauses) only resume on the outermost release.
  function pause() {
    // On the outermost pause, drain anything already buffered from this same
    // synchronous tick into pending FIRST, while still unpaused, so a pre-pause
    // edit isn't swallowed into the captured/structural batch that follows.
    if (pauseDepth === 0 && observer) handleRecords(observer.takeRecords())
    pauseDepth++
    log('paused', pauseDepth)
  }
  function resume() {
    if (pauseDepth === 0) return  // underflow guard
    pauseDepth--
    // Discard records captured during the pause only on the outermost release.
    if (pauseDepth === 0 && observer) observer.takeRecords()
    log('resumed', pauseDepth)
  }

  // --- Undo/redo ---

  function undo() {
    if (scopeDisconnected()) { stop(); return }
    flush()  // close any pending typing first
    const c = undoStack.pop()
    if (!c) return
    pause()
    try {
      // Reverse order so a child restore happens before its parent restore.
      for (let i = c.primitives.length - 1; i >= 0; i--) {
        try { replayReverse(c.primitives[i]) }
        catch (err) { log('undo primitive failed (continuing)', err) }
      }
    } finally { resume() }
    redoStack.push(c)
    log('undo', c.label)
    emitter.emit('undo')
  }

  function redo() {
    if (scopeDisconnected()) { stop(); return }
    flush()
    const c = redoStack.pop()
    if (!c) return
    pause()
    try {
      for (const p of c.primitives) {
        try { replayForward(p) }
        catch (err) { log('redo primitive failed (continuing)', err) }
      }
    } finally { resume() }
    undoStack.push(c)
    log('redo', c.label)
    emitter.emit('redo')
  }

  function clear() {
    // Discard any same-tick buffered records too, so a bootstrap mutation
    // followed by clear() in the same turn doesn't resurface as a commit once
    // the observer callback fires.
    if (observer) observer.takeRecords()
    undoStack.length = 0
    redoStack.length = 0
    pendingPrimitives = []
    clearIdleTimer()
    log('cleared')
    emitter.emit('clear')
  }

  // --- Public surface for the singleton wrapper ---

  return {
    _config: config,  // private: used by keys.js to read shadowKeydownIn
    start, stop,
    commit, commitCaptured, discardCaptured, flush,
    record, recordValue,
    undo, redo, clear,
    pause, resume,
    on: emitter.on, off: emitter.off,
    get canUndo() { return undoStack.length > 0 },
    get canRedo() { return redoStack.length > 0 },
    get isPaused() { return pauseDepth > 0 },
    get history() {
      return undoStack.map(c => ({ label: c.label, timestamp: c.timestamp }))
    },
    get scope() { return config.scope },
  }
}
