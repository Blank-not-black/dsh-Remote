/* DSH Remote 桌面端轻量 i18n · 零依赖（与 public/i18n.js 同构） */
'use strict'
;(function () {
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch {} }
  }
  function detect() {
    const saved = store.get('dshLang')
    if (saved === 'zh' || saved === 'en') return saved
    return (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  }
  let dict = null
  let lang = detect()

  function t(key, vars) {
    const table = (dict && (dict[lang] || dict.zh)) || {}
    let s = table[key]
    if (s == null) s = (dict && dict.zh && dict.zh[key]) != null ? dict.zh[key] : key
    s = String(s)
    if (vars) {
      const keys = new Set(Object.keys(vars))
      s = s.replace(/\{([A-Za-z0-9_]+)\}/g, (m, k) => keys.has(k) ? String(vars[k] ?? '') : '')
    } else {
      s = s.replace(/\{[A-Za-z0-9_]+\}/g, '')
    }
    return s
  }

  function apply(root) {
    root = root || document
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')) })
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')) })
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')) })
    root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))) })
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    return lang
  }

  function setLang(l) {
    if (l !== 'zh' && l !== 'en') return lang
    lang = l
    store.set('dshLang', l)
    apply(document)
    return lang
  }

  window.I18N = {
    init(strings) { dict = strings || dict; return apply(document) },
    t, setLang, apply,
    get lang() { return lang }
  }
})()
