'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/permission-presets.js'), 'utf8')
const DICT = {
  'perm.autoLabel': '自动审查', 'perm.autoBadge': 'EXP', 'perm.autoDesc': '每次调用前由同一模型审查',
  'perm.autoConfirmTitle': '确认启用自动审查（实验）？', 'perm.autoConfirmDesc': '自动审查不使用沙箱。',
  'perm.autoConfirmAck': '我已了解这些风险，并愿意继续', 'perm.autoConfirmEnable': '启用自动审查',
  'perm.confirmTitle': '确认切换权限模式？', 'perm.confirmDesc': '该预设不使用文件沙箱。',
  'perm.confirmAck': '我已了解这些风险，并愿意继续', 'perm.confirmEnable': '启用该模式', 'perm.confirmCancel': '取消',
  'perm.loading': '正在读取主机权限模式…', 'perm.hostUnavailable': '主机未提供权限模式目录', 'perm.current': '当前',
  'perm.changeFailed': '切换权限模式失败',
}

class Node {
  constructor(tag) {
    this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.children = []; this.textContent = ''
    this.dataset = {}; this.attributes = {}; this.listeners = {}; this.className = ''; this.disabled = false
    this.title = ''; this.type = ''
  }
  append(...nodes) { for (const node of nodes) this.children.push(node) }
  replaceChildren(...nodes) { this.children = []; this.textContent = ''; if (nodes.length) this.append(...nodes) }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  click() { if (this.disabled) return false; for (const fn of this.listeners.click || []) fn({ target: this }); return true }
  get classes() { return this.className.split(/\s+/).filter(Boolean) }
  all() { return this.children.flatMap(node => node.nodeType === 3 ? [] : [node, ...node.all()]) }
}
const textOf = node => node.nodeType === 3 ? node.textContent : node.textContent + node.children.map(textOf).join('')

function fixture(rpcImpl) {
  const calls = [], toasts = [], closings = []
  const context = vm.createContext({
    Date, console, window: {},
    document: { createElement: tag => new Node(tag), createTextNode: value => ({ nodeType: 3, textContent: String(value) }) },
  })
  vm.runInContext(SOURCE, context)
  let valid = true
  const connection = { server: 'http://host:8787', token: 'test-only', valid: () => valid }
  const rpc = (method, payload, timeout) => {
    calls.push({ method, payload, timeout })
    return rpcImpl ? rpcImpl(method, payload, calls.length) : Promise.resolve({ options: [] })
  }
  return {
    api: context.window.DshPermissionPresets, calls, toasts, closings,
    connection, rpc,
    setValid: value => { valid = value },
    options: extra => ({
      container: new Node('div'), current: '', connection, rpc,
      t: key => DICT[key] ?? key, toast: (message, kind) => toasts.push({ message, kind }),
      request: async value => { calls.push({ request: value }); return true },
      close: () => closings.push('close'),
      ...extra,
    }),
  }
}

const chipOf = (container, value) => container.all().find(node => node.dataset?.perm === value)
const row = (value, extra = {}) => ({ value, name: value, ...extra })

test('权限请求晚到时不能关闭新会话菜单，旧按钮也不能向新会话提交', async () => {
  const h = fixture(async () => ({ options: [row('workspace-write')] }))
  let finish, current = true
  const options = h.options({ currentValid: () => current, request: () => new Promise(resolve => { finish = resolve }) })
  await h.api.open(options)
  const oldChip = chipOf(options.container, 'workspace-write')
  oldChip.click()
  assert.equal(options.container.dataset.pending, 'workspace-write')
  current = false
  await h.api.open(h.options({ container: options.container }))
  finish(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.closings, [])
  assert.deepEqual(h.toasts, [])
  oldChip.click()
  assert.equal(options.container.dataset.pending, undefined)
})

test('主机目录决定可选权限模式，并以主机名称与说明渲染当前项', async () => {
  const h = fixture(async () => ({
    options: [row('read-only'), row('workspace-write', { name: '工作区写入', description: '写入工作区内' }), row('danger-full-access')],
    defaultPreset: 'workspace-write',
  }))
  const options = h.options({ current: 'workspace-write' })
  await h.api.open(options)
  assert.equal(h.calls[0].method, 'permissionPresets.catalog')
  assert.deepEqual({ ...h.calls[0].payload }, {})
  assert.equal(h.calls[0].timeout, 10000)
  const chips = options.container.all().filter(node => node.tagName === 'BUTTON')
  assert.deepEqual(chips.map(node => node.dataset.perm), ['read-only', 'workspace-write', 'danger-full-access'])
  assert.equal(textOf(chips[1]), '工作区写入')
  assert.equal(chips[1].title, '写入工作区内')
  assert.deepEqual(chips[1].classes.filter(name => name === 'current').length, 1)
  assert.equal(chips[1].attributes['aria-pressed'], 'true')
  assert.equal(chips[0].attributes['aria-pressed'], 'false')
  assert.deepEqual(chips[2].classes.filter(name => name === 'danger').length, 1)
  assert.deepEqual(chips[1].classes.filter(name => name === 'danger').length, 0)
})

test('Auto review 使用客户端本地文案与 EXP 标记，并在切换前要求风险确认', async () => {
  const h = fixture(async () => ({ options: [row('workspace-write'), row('auto')] }))
  const options = h.options()
  await h.api.open(options)
  const auto = chipOf(options.container, 'auto')
  assert.equal(textOf(auto), '自动审查EXP')
  assert.equal(auto.title, '每次调用前由同一模型审查')
  assert.ok(auto.classes.includes('danger'))
  auto.click()
  const card = options.container.children[0]
  assert.equal(card.className, 'perm-confirm')
  assert.equal(textOf(card.all().find(node => node.className === 'perm-confirm-title')), '确认启用自动审查（实验）？')
  assert.equal(h.calls.filter(call => call.request).length, 0)
  const enable = card.all().find(node => node.className.includes('perm-confirm-enable'))
  assert.equal(enable.disabled, true)
  const box = card.all().find(node => node.className === 'perm-confirm-box')
  box.checked = true
  box.listeners.change.forEach(fn => fn())
  assert.equal(enable.disabled, false)
  enable.click()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.filter(call => call.request).map(call => call.request), ['auto'])
  assert.deepEqual(h.closings, ['close'])
})

test('取消风险确认会回到可选列表而不切换', async () => {
  const h = fixture(async () => ({ options: [row('auto')] }))
  const options = h.options()
  await h.api.open(options)
  chipOf(options.container, 'auto').click()
  options.container.all().find(node => node.className.includes('perm-confirm-cancel')).click()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.filter(call => call.request).length, 0)
  assert.ok(chipOf(options.container, 'auto'))
})

test('非沙箱预设立即切换；切换失败给出一次提示且不关闭菜单', async () => {
  const h = fixture(async () => ({ options: [row('read-only'), row('workspace-write')] }))
  const failing = h.options({ request: async value => { h.calls.push({ request: value }); return false } })
  await h.api.open(failing)
  chipOf(failing.container, 'workspace-write').click()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.filter(call => call.request).map(call => call.request), ['workspace-write'])
  assert.deepEqual(h.toasts, [{ message: '切换权限模式失败', kind: 'err' }])
  assert.deepEqual(h.closings, [])
  const working = h.options()
  await h.api.open(working)
  chipOf(working.container, 'read-only').click()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.closings, ['close'])
})

test('custom 等主机推导值只标记当前，不可作为切换目标', async () => {
  const h = fixture(async () => ({ options: [row('workspace-write')] }))
  const options = h.options({ current: 'custom' })
  await h.api.open(options)
  const buttons = options.container.all().filter(node => node.tagName === 'BUTTON')
  assert.deepEqual(buttons.map(node => node.dataset.perm), ['workspace-write', undefined])
  const current = buttons.find(node => node.disabled)
  assert.equal(textOf(current), 'custom · 当前')
  assert.equal(current.click(), false)
  assert.equal(h.calls.filter(call => call.request).length, 0)
})

test('主机不提供权限目录时保留三种沙箱模式并说明原因', async () => {
  const h = fixture(async () => { throw new Error('unsupported') })
  const options = h.options({ current: 'workspace-write' })
  await h.api.open(options)
  const chips = options.container.all().filter(node => node.tagName === 'BUTTON')
  assert.deepEqual(chips.map(node => node.dataset.perm), ['read-only', 'workspace-write', 'danger-full-access'])
  assert.equal(textOf(chips[0]), 'read-only')
  assert.ok(options.container.all().some(node => node.className === 'perm-hint' && textOf(node) === '主机未提供权限模式目录'))
  chips[2].click()
  assert.equal(options.container.children[0].className, 'perm-confirm')
})

test('空目录同样回退，目录行去重、截断并拒绝不可切换的值', async () => {
  const h = fixture(async () => ({ options: [] }))
  const options = h.options()
  await h.api.open(options)
  assert.deepEqual(options.container.all().filter(node => node.tagName === 'BUTTON').map(node => node.dataset.perm),
    ['read-only', 'workspace-write', 'danger-full-access'])
  const rows = h.api.rowsOf({ options: [
    row('auto'), { value: 'auto', name: '重复' }, { value: 'custom', name: 'Custom' }, { value: 'Bad Value' },
    { value: '' }, { value: 'ok-value', name: 'x'.repeat(200), description: 'y'.repeat(900) }, null, 'text',
  ] })
  assert.deepEqual([...rows.map(item => item.value)], ['auto', 'ok-value'])
  assert.equal(rows[1].name.length, 80)
  assert.equal(rows[1].description.length, 400)
  assert.equal(h.api.rowsOf({ items: [] }), null)
  assert.equal(h.api.rowsOf({ options: Array.from({ length: 30 }, (_, index) => row('p' + index)) }).length, 20)
  assert.equal(h.api.gated('auto'), true)
  assert.equal(h.api.gated('workspace-write'), false)
})

test('目录按连接缓存，换主机重新读取，迟到响应不能覆盖新渲染', async () => {
  const pending = []
  const h = fixture((method, payload, attempt) => new Promise(resolve => pending.push({ attempt, resolve })))
  const first = h.options()
  const opening = h.api.open(first)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.length, 1)
  const second = h.options()
  const reopening = h.api.open(second)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.length, 2)
  pending[1].resolve({ options: [row('workspace-write')] })
  await reopening
  assert.deepEqual(second.container.all().filter(node => node.tagName === 'BUTTON').map(node => node.dataset.perm), ['workspace-write'])
  pending[0].resolve({ options: [row('read-only')] })
  await opening
  assert.deepEqual(second.container.all().filter(node => node.tagName === 'BUTTON').map(node => node.dataset.perm), ['workspace-write'])
  assert.deepEqual(first.container.all().filter(node => node.tagName === 'BUTTON').map(node => node.dataset.perm), ['read-only'])
  const cached = h.options()
  await h.api.open(cached)
  assert.equal(h.calls.length, 2)
  const other = h.options({ connection: { server: 'http://other:8787', token: 'test-only', valid: () => true } })
  const moved = h.api.open(other)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[2].method, 'permissionPresets.catalog')
  pending[2].resolve({ options: [row('auto')] })
  await moved
  assert.deepEqual(other.container.all().filter(node => node.tagName === 'BUTTON').map(node => node.dataset.perm), ['auto'])
  h.setValid(false)
  const stale = h.options()
  h.api.invalidate()
  const dropped = h.api.open(stale)
  await new Promise(resolve => setImmediate(resolve))
  pending[3].resolve({ options: [row('read-only')] })
  await dropped
  assert.deepEqual(stale.container.all().filter(node => node.tagName === 'BUTTON'), [])
})

test('手机端与桌面端权限入口改用主机目录，不再内置固定预设', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.js'), 'utf8')
  const desktopHtml = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.html'), 'utf8')
  const gateway = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  assert.ok(html.indexOf('<script src="permission-presets.js"></script>') < html.indexOf('<script src="app.js"></script>'))
  assert.ok(html.includes('id="permission-submenu"'))
  assert.ok(!html.includes('data-perm="read-only"'))
  assert.ok(app.includes('window.DshPermissionPresets.open('))
  assert.ok(app.includes("runSlashCommand('/permission ' + value, true)"))
  assert.ok(app.includes('function refreshPermissionPresets()'))
  assert.ok(app.includes('if (show) refreshPermissionPresets()'))
  assert.ok(!app.includes("e.target.closest('[data-perm]')"))
  assert.ok(!html.includes('data-cmd="/permission"'))
  assert.ok(html.indexOf('id="permission-menu-group"') > 0 && html.indexOf('id="permission-menu-group"') < html.indexOf('id="preset-menu-group"'))
  assert.ok(desktopHtml.indexOf('<script src="../permission-presets.js"></script>') < desktopHtml.indexOf('<script src="desktop.js"></script>'))
  assert.ok(desktop.includes('function refreshPermissionPresetsDesktop()'))
  assert.ok(desktop.includes("$('cmd-perm-inline')"))
  assert.ok(desktopHtml.includes('id="cmd-perm-inline"'))
  assert.ok(!desktopHtml.includes('data-ds-cmd="/permission"'))
  assert.ok(desktop.includes('window.DshPermissionPresets.open('))
  assert.ok(gateway.includes("'permissionPresets.catalog'"))
  assert.ok(gateway.includes("endpoint = 'permissionPresets/catalog'"))
})
