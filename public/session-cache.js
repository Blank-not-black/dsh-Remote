/* Shared session-list cache keys and migration. No dependencies. */
'use strict';
;(function(root) {
  const CANONICAL = 'sessionsCacheV2:'
  const HISTORY = 'historyCacheV2:'
  const LEGACY_SUFFIX = ':sessions'

  function scopeSuffix(scope) {
    const value = String(scope || '')
    return value.startsWith(HISTORY) ? value.slice(HISTORY.length) : value
  }
  function keys(scope) {
    return { canonical: CANONICAL + scopeSuffix(scope), legacy: String(scope || '') + LEGACY_SUFFIX }
  }
  function parse(raw) {
    if (typeof raw !== 'string' || !raw) return null
    try {
      const value = JSON.parse(raw)
      return Array.isArray(value) ? value : null
    } catch { return null }
  }
  function readRaw(key) {
    try { return root.localStorage.getItem(key) } catch { return null }
  }
  function writeRaw(key, value) {
    try { root.localStorage.setItem(key, JSON.stringify(value)); return true } catch { return false }
  }
  function read(scope) {
    const { canonical, legacy } = keys(scope)
    const current = parse(readRaw(canonical))
    // A valid [] is authoritative: do not fall back to a stale legacy copy.
    if (current) return current
    const previous = parse(readRaw(legacy))
    if (!previous) return null
    // Keep the legacy copy for the rollback window; only fill the canonical key.
    writeRaw(canonical, previous)
    return previous
  }
  function write(scope, list) {
    const value = Array.isArray(list) ? list.slice(0, 80) : []
    const { canonical, legacy } = keys(scope)
    if (!writeRaw(canonical, value)) return false
    // Mirror only when a legacy copy already exists, so fresh installs do not create it.
    if (readRaw(legacy) !== null) writeRaw(legacy, value)
    return true
  }
  function clear(scope) {
    const { canonical, legacy } = keys(scope)
    let ok = true
    try { root.localStorage.removeItem(canonical) } catch { ok = false }
    try { root.localStorage.removeItem(legacy) } catch { ok = false }
    return ok
  }
  function clearAll() {
    let ok = true
    try {
      const doomed = []
      for (let index = 0; index < root.localStorage.length; index++) {
        const key = root.localStorage.key(index)
        if (key && (key.startsWith(CANONICAL) || (key.startsWith(HISTORY) && key.endsWith(LEGACY_SUFFIX)))) doomed.push(key)
      }
      for (const key of doomed) root.localStorage.removeItem(key)
    } catch { ok = false }
    return ok
  }

  const api = { keys, read, write, clear, clearAll }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshSessionCache = api
})(typeof window === 'undefined' ? globalThis : window)
