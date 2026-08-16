/* DSH Remote 皮肤系统 · 零依赖
 * html[data-theme] = default(默认深空) | dark(落日) | light(易北爱乐厅) | neutral(草原孤塔)
 * 优先级: localStorage dshTheme > prefers-color-scheme(浅→light, 深→default)
 * set() 写入用户显式选择; applyCurrent() 只应用不写, 用于跟随系统变化。 */
'use strict'
;(function () {
  const KEY = 'dshTheme'
  const VALID = ['default', 'dark', 'light', 'neutral']
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch {} }
  }

  function system() {
    return mq.matches ? 'light' : 'default'
  }

  function get() {
    const saved = store.get(KEY)
    return VALID.includes(saved) ? saved : system()
  }

  function syncMeta() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--dsr-bg').trim()
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta && bg) meta.setAttribute('content', bg)
  }

  function applyAttr(t) {
    document.documentElement.setAttribute('data-theme', t)
    syncMeta()
  }

  function applyCurrent() {
    applyAttr(get())
    return get()
  }

  function set(t) {
    if (!VALID.includes(t)) t = get()
    document.documentElement.setAttribute('data-theme', t)
    store.set(KEY, t)
    syncMeta()
    return t
  }

  // 未手动选择时跟随系统变化
  if (mq.addEventListener) {
    mq.addEventListener('change', () => { if (!store.get(KEY)) applyCurrent() })
  } else if (mq.addListener) {
    mq.addListener(() => { if (!store.get(KEY)) applyCurrent() })
  }

  applyCurrent()
  window.DSHTheme = { KEY, VALID, system, get, set, applyCurrent }
})()
