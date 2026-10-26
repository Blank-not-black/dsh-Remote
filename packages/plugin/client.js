/* dsh-remote 插件 client half
 * 更多菜单中的手机连接入口；首次使用显示可关闭的路径提示。
 * 产物入库, 无构建步骤; 参考 @openbiliclaw/dsh-plugin 的官方 slot 注册模式。
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    // DSH 0.1.2-alpha.1 将 defineStore 从已删除的 client-runtime 迁入
    // client-store 平台种子；0.1.1-rc.2 及更早版本仍只提供旧模块。
    var storeRuntime
    try {
      storeRuntime = require('@deepseek-ai/dsh-client-store')
    } catch (_) {
      storeRuntime = require('@deepseek-ai/dsh-client-runtime/client')
    }

    var PLUGIN_THEMES = ['default', 'dark', 'light', 'neutral', 'mono', 'fish']
    var ICON_PALETTES = {
      default: { bg: '#F6F9FF', upper: '#4F7FEF', lower: '#8A64D8' },
      dark: { bg: '#FFF4E3', upper: '#C66A00', lower: '#8A5A24' },
      light: { bg: '#FFF9EF', upper: '#9B6A20', lower: '#66517F' },
      neutral: { bg: '#F4F0DF', upper: '#585818', lower: '#832D15' },
      mono: { bg: '#F5F5F5', upper: '#222222', lower: '#555555' },
      fish: { bg: '#EAF6FF', upper: '#2F52D0', lower: '#537CC4' },
    }

    function currentPluginTheme() {
      var saved = null
      try { saved = localStorage.getItem('dshTheme') } catch (_) {}
      if (PLUGIN_THEMES.indexOf(saved) >= 0) return saved
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'default'
    }

    function usePluginTheme() {
      var themeState = React.useState(currentPluginTheme)
      var theme = themeState[0]
      var setTheme = themeState[1]
      React.useEffect(function () {
        var mq = window.matchMedia('(prefers-color-scheme: light)')
        function sync() { setTheme(currentPluginTheme()) }
        function onStorage(e) { if (!e || e.key === 'dshTheme') sync() }
        function onMessage(e) {
          var d = e.data
          if (e.origin !== location.origin || !d || d.source !== 'dsh-remote-theme' || d.type !== 'change') return
          if (PLUGIN_THEMES.indexOf(d.theme) >= 0) setTheme(d.theme)
        }
        window.addEventListener('storage', onStorage)
        window.addEventListener('message', onMessage)
        if (mq.addEventListener) mq.addEventListener('change', sync)
        else if (mq.addListener) mq.addListener(sync)
        return function () {
          window.removeEventListener('storage', onStorage)
          window.removeEventListener('message', onMessage)
          if (mq.removeEventListener) mq.removeEventListener('change', sync)
          else if (mq.removeListener) mq.removeListener(sync)
        }
      }, [])
      return theme
    }

    function PluginIcon() {
      var palette = ICON_PALETTES[usePluginTheme()] || ICON_PALETTES.default
      var common = {
        fill: 'none', strokeWidth: 2.8, strokeLinecap: 'square', strokeLinejoin: 'miter',
      }
      return React.createElement('svg', {
        viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false,
        style: { width: 16, height: 16, flexShrink: 0, display: 'block' },
      },
        React.createElement('rect', { x: .75, y: .75, width: 22.5, height: 22.5, rx: 5, fill: palette.bg, stroke: 'rgba(15, 23, 42, .14)', strokeWidth: 1 }),
        React.createElement('path', Object.assign({ d: 'M10 6l4 4 4-4m-4 4 4 4', stroke: palette.upper }, common)),
        React.createElement('path', Object.assign({ d: 'M6 10l4 4-4 4m4-4 4 4', stroke: palette.lower }, common)))
    }

    var SEEN_KEY = 'dshRemoteConnectionEntrySeenV1'
    var ENTRY_HASH = '#dsh-remote-connect'
    var MenuItemButton
    try { MenuItemButton = require('@deepseek-ai/dsh-client-ui-primitives').MenuItemButton } catch (_) {}
    function seen() { try { return localStorage.getItem(SEEN_KEY) === '1' } catch (_) { return false } }
    function remember() { try { localStorage.setItem(SEEN_KEY, '1') } catch (_) {} }

    function MoreEntry(props) {
      var opening = props.useStore(function (s) { return s.opening })
      var select = function () { props.onDismiss?.(); void props.openConsole(props.actions) }
      if (MenuItemButton) return React.createElement(MenuItemButton, { icon: React.createElement(PluginIcon), disabled: opening, onSelect: select }, '手机连接（DSH Remote）')
      return React.createElement('button', { type: 'button', role: 'menuitem', disabled: opening, onClick: select,
        style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' } },
        React.createElement(PluginIcon), '手机连接（DSH Remote）')
    }

    function LegacyEntry(props) {
      if (props.useMore()) return null
      return React.createElement('button', { type: 'button', title: '手机连接（DSH Remote）', onClick: function () { void props.openConsole(props.actions) },
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: 8, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' } },
        React.createElement(PluginIcon), props.wide ? '手机连接' : null)
    }

    function EntryNotice(props) {
      var state = props.useStore(function (s) { return s })
      var more = props.useMore()
      if (!state.notice) return null
      var button = { minHeight: 36, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', font: 'inherit', border: '1px solid var(--dsw-alias-border-l3, #ccd2da)' }
      return React.createElement('aside', { 'data-dsh-remote-entry-notice': true, role: 'region', 'aria-label': '手机连接提示',
        style: { position: 'fixed', right: 16, bottom: 16, width: 'min(352px, calc(100vw - 32px))', boxSizing: 'border-box', padding: 16, zIndex: 100,
          border: '1px solid var(--dsw-alias-border-l3, #ccd2da)', borderRadius: 12, background: 'var(--dsw-alias-button-elevated-fill, #fff)', color: 'var(--dsw-alias-label-primary, #17212f)',
          boxShadow: '0 6px 24px rgba(0,0,0,.14)', font: '13px/1.6 system-ui, sans-serif', WebkitAppRegion: 'no-drag' } },
        React.createElement('strong', { style: { fontSize: 15 } }, '用手机连接这台电脑'),
        React.createElement('p', { style: { margin: '8px 0' } }, more ? '以后在左侧「更多 → 手机连接（DSH Remote）」打开配对和连接管理。' : '以后点击左侧底部的「手机连接」打开配对和连接管理。'),
        React.createElement('p', { style: { margin: '8px 0' } }, '点击后在浏览器打开，按步骤安装 App、扫码连接。'),
        state.error ? React.createElement('p', { role: 'alert' }, '浏览器打开失败。请重试；也可在 DSH 的插件管理中检查 Remote 是否正常运行。') : null,
        React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } },
          React.createElement('button', { type: 'button', disabled: state.opening, style: Object.assign({}, button, { background: 'var(--dsw-alias-state-business-primary, #2665cf)', color: '#fff' }),
            onClick: function () { void props.openConsole(props.actions) } }, state.opening ? '正在打开…' : state.error ? '重试打开' : '开始连接'),
          React.createElement('button', { type: 'button', style: Object.assign({}, button, { background: 'transparent', color: 'inherit' }),
            onClick: function () { remember(); props.actions.dismiss() } }, '稍后')))
    }

    var inject = ['slots']
    function apply(ctx) {
      // The authenticated browser landing is fixed; no caller-controlled redirect.
      if (location.protocol !== 'dsh-app:' && location.hash === ENTRY_HASH) {
        remember()
        location.replace('/remote/admin/#remote/devices')
        return
      }
      var moreAvailable = false, listeners = new Set(), active = true, pending = null
      function notifyMore() { listeners.forEach(function (fn) { fn(moreAvailable) }) }
      function useMore() {
        var value = React.useState(function () { return moreAvailable })
        React.useEffect(function () { listeners.add(value[1]); value[1](moreAvailable); return function () { listeners.delete(value[1]) } }, [])
        return value[0]
      }
      var store = storeRuntime.defineStore({
        init: function () { return { notice: !seen(), opening: false, error: false } },
        actions: {
          start: function (d) { d.opening = true; d.error = false },
          opened: function (d) { d.opening = false; d.notice = false; d.error = false },
          failed: function (d) { d.opening = false; d.notice = true; d.error = true },
          dismiss: function (d) { d.notice = false },
        },
      })
      async function openConsole(actions) {
        if (pending || !active) return
        var request = new AbortController()
        pending = request
        actions.start()
        var timer = setTimeout(function () { request.abort() }, 8000)
        try {
          var target = '/remote/admin/#remote/devices'
          if (location.protocol === 'dsh-app:') {
            var response = await fetch('/remote/admin/api/browser-launch', { method: 'POST', credentials: 'same-origin',
              headers: { 'x-dsh-remote-client': 'entry' }, signal: request.signal })
            if (!response.ok) throw new Error('launch-unavailable')
            var result = await response.json(), url = new URL(result.url)
            if (result.ok !== true || !['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
              || url.username || url.password || url.pathname !== '/' || url.hash !== ENTRY_HASH) throw new Error('invalid-launch')
            target = url.href
          }
          if (!active) return
          if (request.signal.aborted) throw new Error('launch-cancelled')
          // Desktop handles HTTP(S) window.open with its external browser handler.
          // noopener browsers and Electron can return null on successful handoff.
          window.open(target, '_blank', 'noopener,noreferrer')
          remember()
          actions.opened()
        } catch (_) { if (active) actions.failed() }
        finally { clearTimeout(timer); if (pending === request) pending = null }
      }
      var injected = function () { return { openConsole: openConsole, useMore: useMore } }
      ctx.effect(function () { return function () { active = false; pending?.abort(); listeners.clear() } }, 'dsh-remote: entry lifetime')
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.panellist.actions', function () {
          var dispose = ctx.slots.register({ name: 'sidebar.panellist.actions', id: 'dsh-remote', order: 100, store, inject: injected }, MoreEntry)
          moreAvailable = true; notifyMore()
          return function () { moreAvailable = false; notifyMore(); dispose() }
        })
      }, 'dsh-remote: More menu entry')
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-remote', store, inject: injected }, LegacyEntry)
        })
      }, 'dsh-remote: old host entry fallback')
      ctx.effect(function () {
        return ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'dsh-remote-entry-notice', store, inject: injected }, EntryNotice)
        })
      }, 'dsh-remote: first-use entry notice')
    }
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
