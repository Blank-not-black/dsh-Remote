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
  const BUILTIN = {
    zh: {
      'wb.unbound': 'DSH Remote（未绑定）', 'wb.bind': '绑定工作台', 'wb.bound': 'DSH Remote（绑定 {title}）',
      'wb.viewPath': '已绑定 workspace', 'wb.unbind': '解绑', 'wb.unbindConfirm': '确定解绑当前工作台？解绑后这些会话将回到扁平会话列表。',
      'wb.modalTitle': '绑定工作台', 'wb.modalDesc': '选择工作台根目录，其下每个子文件夹会自动成为项目工作区。',
      'wb.up': '上级', 'wb.home': '根目录', 'wb.selectDir': '选择此目录', 'wb.pathPlaceholder': '或手动输入绝对路径…',
      'wb.pathEmpty': '请输入要绑定的路径', 'wb.empty': '此目录没有子文件夹', 'wb.boundOk': '工作台已绑定：{path}',
      'wb.bindFailed': '绑定失败：{msg}', 'wb.unboundOk': '已解绑工作台', 'wb.unbindFailed': '解绑失败：{msg}',
      'wb.boundPath': '绑定路径：{path}', 'wb.projects': '项目', 'wb.noProjects': '暂无项目（根目录下新建文件夹后会自动出现）',
      'wb.newSession': '新会话', 'wb.noSessions': '暂无会话', 'wb.flatHidden': '工作台会话已收起（{n} 个在工作台面板）',
      'wb.apiMissing': '工作台接口不可用（需更新网关）', 'wb.loadFailed': '工作台加载失败：{msg}',
      'wb.archivedHidden': '------隐藏已归档会话------', 'wb.archivedShown': '------显示已归档会话------'
    },
    en: {
      'wb.unbound': 'DSH Remote (unbound)', 'wb.bind': 'Bind workbench', 'wb.bound': 'DSH Remote (bound {title})',
      'wb.viewPath': 'Bound workspace', 'wb.unbind': 'Unbind', 'wb.unbindConfirm': 'Unbind the current workbench? These sessions will return to the flat list.',
      'wb.modalTitle': 'Bind workbench', 'wb.modalDesc': 'Choose the workbench root; each subfolder becomes a project workspace automatically.',
      'wb.up': 'Up', 'wb.home': 'Root', 'wb.selectDir': 'Select this folder', 'wb.pathPlaceholder': 'Or type an absolute path…',
      'wb.pathEmpty': 'Enter a path to bind', 'wb.empty': 'No subfolders in this folder', 'wb.boundOk': 'Workbench bound: {path}',
      'wb.bindFailed': 'Bind failed: {msg}', 'wb.unboundOk': 'Workbench unbound', 'wb.unbindFailed': 'Unbind failed: {msg}',
      'wb.boundPath': 'Bound path: {path}', 'wb.projects': 'Projects', 'wb.noProjects': 'No projects yet',
      'wb.newSession': 'New session', 'wb.noSessions': 'No sessions', 'wb.flatHidden': 'Workbench sessions folded ({n} in the workbench panel)',
      'wb.apiMissing': 'Workbench API unavailable (update gateway)', 'wb.loadFailed': 'Workbench load failed: {msg}',
      'wb.archivedHidden': '------ Hide archived ------', 'wb.archivedShown': '------ Show archived ------'
    }
  }
  function mergeDicts(strings) {
    return {
      zh: Object.assign({}, BUILTIN.zh, strings?.zh || {}),
      en: Object.assign({}, BUILTIN.en, strings?.en || {})
    }
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
    init(strings) { dict = mergeDicts(strings || dict || {}); return apply(document) },
    t, setLang, apply,
    get lang() { return lang }
  }
})()
