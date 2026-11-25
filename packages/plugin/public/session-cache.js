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
  function keysFromCanonical(canonical) {
    const value = String(canonical || '')
    const suffix = value.startsWith(CANONICAL) ? value.slice(CANONICAL.length) : scopeSuffix(value)
    return { canonical: CANONICAL + suffix, legacy: HISTORY + suffix + LEGACY_SUFFIX }
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
  function readPair(pair) {
    const current = parse(readRaw(pair.canonical))
    // A valid [] is authoritative: do not fall back to a stale legacy copy.
    if (current) return current
    const previous = parse(readRaw(pair.legacy))
    if (!previous) return null
    // Keep the legacy copy for the rollback window; only fill the canonical key.
    writeRaw(pair.canonical, previous)
    return previous
  }
  function read(scope) {
    return readPair(keys(scope))
  }
  function readKey(canonical) {
    return readPair(keysFromCanonical(canonical))
  }
  function writePair(pair, list) {
    const value = Array.isArray(list) ? list.slice(0, 80) : []
    if (!writeRaw(pair.canonical, value)) return false
    // Mirror only when a legacy copy already exists, so fresh installs do not create it.
    if (readRaw(pair.legacy) !== null) writeRaw(pair.legacy, value)
    return true
  }
  function write(scope, list) {
    return writePair(keys(scope), list)
  }
  function writeKey(canonical, list) {
    return writePair(keysFromCanonical(canonical), list)
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

  const api = { keys, keysFromCanonical, read, readKey, write, writeKey, clear, clearAll }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshSessionCache = api
})(typeof window === 'undefined' ? globalThis : window)
