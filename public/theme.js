/* DSH Remote 皮肤系统 · 零依赖
 * 十二套皮肤: html[data-theme] = default(默认深空) | dark(落日) | light(易北爱乐厅) | neutral(草原孤塔) | mono(黑曜白) | fish(蓝色大肥鱼) | penguin(企鹅女管·白昼) | penguin-night(企鹅女管·极夜) | bocchi(波奇酱) | nijika(伊地知虹夏) | ryo(山田凉) | kita(喜多郁代)
 * 优先级: localStorage dshTheme > 蓝色大肥鱼（默认）
 * set() 写入用户显式选择; applyCurrent() 只应用，不覆盖已有选择。 */
'use strict'
;(function () {
  const KEY = 'dshTheme'
  const DEFAULT = 'fish'
  const VALID = ['default', 'dark', 'light', 'neutral', 'mono', 'fish', 'penguin', 'penguin-night', 'bocchi', 'nijika', 'ryo', 'kita']
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
    return VALID.includes(saved) ? saved : DEFAULT
  }

  function syncMeta() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--dsr-bg').trim()
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta && bg) meta.setAttribute('content', bg)
  }

  function announce(t) {
    window.dispatchEvent(new CustomEvent('dsh-theme-change', { detail: { theme: t } }))
    if (window.parent !== window) {
      window.parent.postMessage({ source: 'dsh-remote-theme', type: 'change', theme: t }, location.origin)
    }
  }

  function applyAttr(t) {
    document.documentElement.setAttribute('data-theme', t)
    syncMeta()
    announce(t)
  }

  function applyCurrent() {
    applyAttr(get())
    return get()
  }

  function set(t) {
    if (!VALID.includes(t)) t = get()
    store.set(KEY, t)
    applyAttr(t)
    return t
  }

  applyCurrent()
  window.DSHTheme = { KEY, DEFAULT, VALID, system, get, set, applyCurrent }
})()
