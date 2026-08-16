/* dsh-remote 插件 client half
 * 注册进 DSH 原生左侧边栏 footer(与 OpenBiliClaw 上下并列) + 右侧 shell.overlay 抽屉。
 * 抽屉内 iframe 懒加载 /remote/admin/ —— 即本地网关管理控制台的桌面 UI。
 * 产物入库, 无构建步骤; 参考 @openbiliclaw/dsh-plugin 的官方 slot 注册模式。
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var runtime = require('@deepseek-ai/dsh-client-runtime/client')

    var DRAWER_STYLE = {
      position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 2147483000,
      width: 'min(460px, 96vw)', background: '#0b0e1a',
      boxShadow: '-10px 0 32px rgba(0,0,0,.5)',
      transform: 'translateX(102%)', transition: 'transform .22s ease',
      display: 'flex', flexDirection: 'column',
    }
    // DSH 原生 footerActions 容器默认 flex-row(官方类名已编译定型);
    // 动态注入列布局, 让各 footer action 上下堆叠。
    var FOOTER_FIX_ID = 'dsh-remote-footer-stack'
    var FOOTER_FIX_CSS = '.kIs9zW_footerActions{flex-direction:column!important;align-items:stretch!important}'

    function useFooterStack() {
      React.useEffect(function () {
        if (document.getElementById(FOOTER_FIX_ID)) return
        var style = document.createElement('style')
        style.id = FOOTER_FIX_ID
        style.textContent = FOOTER_FIX_CSS
        document.head.appendChild(style)
      }, [])
    }

    function SidebarButton(props) {
      useFooterStack()
      var open = props.useStore(function (s) { return s.open })
      var hoverState = React.useState(false)
      var hover = hoverState[0]
      var setHover = hoverState[1]
      return React.createElement('button', {
        type: 'button',
        title: 'DSH Remote',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        onClick: function () { props.actions.toggle() },
        onMouseEnter: function () { setHover(true) },
        onMouseLeave: function () { setHover(false) },
        style: {
          display: 'flex', alignItems: 'center', gap: 7, width: '100%',
          padding: '6px 10px', border: 'none', borderRadius: 8,
          background: hover ? 'rgba(125, 207, 255, .14)' : 'transparent',
          transition: 'background .15s ease',
          cursor: 'pointer', color: open ? '#5df2d6' : 'inherit',
          font: '500 13px/1.3 system-ui, sans-serif', textAlign: 'left',
        },
      },
        React.createElement('img', {
          src: '/remote/icon.svg', alt: '', 'aria-hidden': true,
          style: { width: 16, height: 16, flexShrink: 0 },
        }),
        props.wide ? React.createElement('span', null, 'DSH Remote') : null)
    }

    function Drawer(props) {
      var open = props.useStore(function (s) { return s.open })
      var loaded = React.useRef(false)
      if (open) loaded.current = true
      // 管理页里的「收起面板」通过 postMessage 请求父窗口关闭抽屉
      React.useEffect(function () {
        function onMsg(e) {
          if (e.origin !== location.origin) return
          var d = e.data
          if (d && d.source === 'dsh-remote-admin' && d.type === 'close') props.actions.close()
        }
        window.addEventListener('message', onMsg)
        return function () { window.removeEventListener('message', onMsg) }
      }, [])
      return React.createElement('div', {
        'aria-hidden': !open,
        style: Object.assign({}, DRAWER_STYLE, { transform: open ? 'translateX(0)' : 'translateX(102%)' }),
      },
        loaded.current ? React.createElement('iframe', {
          src: '/remote/admin/?embedded=1',
          title: 'DSH Remote',
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups',
          style: { flex: 1, width: '100%', border: 'none', background: '#0b0e1a' },
        }) : null)
    }

    var inject = ['slots']
    function apply(ctx) {
      var store = runtime.defineStore({
        init: function () { return { open: false } },
        actions: {
          toggle: function (d) { d.open = !d.open },
          open: function (d) { d.open = true },
          close: function (d) { d.open = false },
        },
      })
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-remote',
            order: 1,
            store,
          }, SidebarButton)
        })
      }, 'dsh-remote: sidebar footer entry')
      ctx.effect(function () {
        return ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-remote-drawer',
            store,
          }, Drawer)
        })
      }, 'dsh-remote: overlay drawer')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
