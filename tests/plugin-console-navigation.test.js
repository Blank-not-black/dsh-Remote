'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const panel = fs.readFileSync(path.join(root, 'public/plugin.js'), 'utf8')
const admin = fs.readFileSync(path.join(root, 'public/admin.js'), 'utf8')

function createElements() {
  const elements = new Map()
  return id => {
    if (!elements.has(id)) {
      const classes = new Set(['hidden'])
      elements.set(id, {
        dataset: {}, textContent: '', listeners: {},
        style: { setProperty() {} }, setAttribute() {},
        classList: {
          add(...names) { names.forEach(name => classes.add(name)) },
          remove(...names) { names.forEach(name => classes.delete(name)) },
          contains(name) { return classes.has(name) }, toggle() {},
        },
        addEventListener(type, handler) { this.listeners[type] = handler },
      })
    }
    return elements.get(id)
  }
}

function loadPanel(protocol) {
  const getElement = createElements()
  const navigations = []
  const popups = []
  const context = {
    document: { getElementById: getElement },
    location: { protocol, assign(url) { navigations.push(url) } },
    // Desktop silently denies popups. The click must still navigate its iframe.
    window: { open(...args) { popups.push(args); return null } },
    fetch: async () => ({ ok: true, json: async () => ({ mode: 'gateway', days: [] }) }),
    setInterval() {}, setTimeout() {}, Date,
  }
  vm.createContext(context)
  vm.runInContext(panel, context)
  vm.runInContext("render({ mode: 'gateway' })", context)
  return { getElement, navigations, popups }
}

test('Desktop 的两个控制台按钮及关于链接在原 iframe 打开管理页', () => {
  const { getElement, navigations, popups } = loadPanel('dsh-app:')
  for (const id of ['plugin-primary', 'plugin-console', 'plugin-about']) {
    let prevented = false
    getElement(id).listeners.click({ preventDefault() { prevented = true } })
    assert.equal(navigations.at(-1), '/remote/admin/', id)
    if (id !== 'plugin-primary') assert.equal(prevented, true, id)
  }
  assert.equal(navigations.length, 3)
  assert.equal(popups.length, 0)
})

test('HTTP/HTTPS 插件控制台保留浏览器新标签页行为', () => {
  for (const protocol of ['http:', 'https:']) {
    const { getElement, navigations, popups } = loadPanel(protocol)
    for (const id of ['plugin-primary', 'plugin-console']) getElement(id).listeners.click({ preventDefault() {} })
    assert.deepEqual(popups, [
      ['/remote/admin/', '_blank', 'noopener'],
      ['/remote/admin/', '_blank', 'noopener'],
    ])
    assert.equal(navigations.length, 0)
    assert.equal(getElement('plugin-about').listeners.click, undefined)
  }
})

test('Desktop 内嵌管理页提供回到状态面板的同框链接', () => {
  const boot = admin.slice(admin.lastIndexOf('if (pluginMode) {'), admin.indexOf('renderLangBtn()', admin.lastIndexOf('if (pluginMode) {')))
  for (const [protocol, framed, pluginMode, visible] of [
    ['dsh-app:', true, true, true],
    ['dsh-app:', false, true, false],
    ['https:', true, true, false],
    ['http:', false, false, false],
  ]) {
    const $ = createElements()
    const window = {}
    window.parent = framed ? {} : window
    vm.runInNewContext(boot, { $, location: { protocol }, window, pluginMode, token: '', start() {} })
    assert.equal(!$('btn-plugin-panel').classList.contains('hidden'), visible)
  }
  const html = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8')
  const link = html.match(/<a id="btn-plugin-panel"[^>]*>/)?.[0]
  assert.ok(link)
  assert.match(link, /href="\.\.\/plugin\.html"/)
  assert.doesNotMatch(link, /target=/)
})
