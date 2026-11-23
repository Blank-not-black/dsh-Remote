'use strict'

/* B6 组合输入模块的零依赖测试：用最小 DOM 桩驱动真实模块，不引入 jsdom。 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const toolsModule = require('../public/composer-tools.js')

/* ------------------------------ 最小 DOM 桩 ------------------------------ */

class FakeClassList {
  constructor() { this.set = new Set() }
  add(...names) { names.forEach(name => this.set.add(name)) }
  remove(...names) { names.forEach(name => this.set.delete(name)) }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force
    if (on) this.set.add(name)
    else this.set.delete(name)
    return on
  }
  contains(name) { return this.set.has(name) }
}

class FakeElement {
  constructor(tag, ownerDocument) {
    this.tagName = String(tag).toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this.parentElement = null
    this._text = ''
    this.className = ''
    this.classList = new FakeClassList()
    this.attributes = new Map()
    this.dataset = {}
    this.listeners = new Map()
    this.dispatched = []
    this.hidden = false
    this.disabled = false
    this.type = ''
    this.id = ''
    this.title = ''
    this.value = ''
    this.selectionStart = 0
    this.selectionEnd = 0
    this.focused = false
  }
  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('')
    return this._text
  }
  set textContent(value) {
    this._text = value == null ? '' : String(value)
    this.children = []
  }
  append(...nodes) {
    if (this._text !== '') {
      const text = new FakeElement('#text', this.ownerDocument)
      text._text = this._text
      this._text = ''
      this.children.push(text)
    }
    for (const item of nodes) {
      if (item == null) continue
      if (typeof item === 'string') {
        const text = new FakeElement('#text', this.ownerDocument)
        text._text = item
        this.children.push(text)
        continue
      }
      item.parentElement = this
      this.children.push(item)
    }
  }
  appendChild(node) { this.append(node); return node }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes) }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === 'id') this.id = String(value)
    if (name === 'class') this.className = String(value)
    if (name === 'role') this.role = String(value)
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || []
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }
  emit(type, event) {
    const payload = event || {}
    if (!payload.target) payload.target = this
    if (!payload.preventDefault) payload.preventDefault = () => {}
    if (!payload.stopPropagation) payload.stopPropagation = () => {}
    for (const handler of (this.listeners.get(type) || []).slice()) handler(payload)
    return payload
  }
  dispatchEvent(event) {
    this.dispatched.push(event)
    for (const handler of (this.listeners.get(event.type) || []).slice()) {
      handler({ type: event.type, target: this, preventDefault() {}, stopPropagation() {} })
    }
    return true
  }
  focus() {
    this.focused = true
    if (this.ownerDocument) this.ownerDocument.activeElement = this
  }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end }
  scrollIntoView() {}
}

class FakeDocument {
  constructor() {
    this.listeners = new Map()
    this.activeElement = null
  }
  createElement(tag) { return new FakeElement(tag, this) }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || []
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }
  emit(type, event) {
    const payload = event || {}
    if (!payload.target) payload.target = this.activeElement || this
    if (!payload.preventDefault) payload.preventDefault = () => {}
    for (const handler of (this.listeners.get(type) || []).slice()) handler(payload)
    return payload
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))
const findAll = (element, predicate, found = []) => {
  for (const child of element.children || []) {
    if (predicate(child)) found.push(child)
    findAll(child, predicate, found)
  }
  return found
}
const byClass = (element, className) => findAll(element, node =>
  String(node.className || '').split(/\s+/).includes(className) || node.classList.contains(className))

function createHarness(overrides = {}) {
  const document = new FakeDocument()
  const input = document.createElement('textarea')
  const menu = document.createElement('div')
  const hint = document.createElement('div')
  const quoteList = document.createElement('div')
  const events = { changes: [], quotes: [], notices: [] }
  let scope = overrides.scope || { key: 'session-1', sessionId: 'session-1' }
  const commandCalls = []
  const referenceCalls = []
  const commands = overrides.commands !== undefined ? overrides.commands : [
    { name: 'compact', description: '压缩对话历史' },
    { name: '/goal', description: '设置或查看任务目标', aliases: ['target'] },
    { name: 'export', description: '导出会话日志', source: 'builtin' },
  ]
  const references = overrides.references !== undefined ? overrides.references : [
    { label: 'app.js', insert: '@public/app.js', detail: '文件', allowed: true },
    { label: '密钥', insert: '@secret', detail: '文件', allowed: false },
  ]
  const host = Object.assign({
    scope: () => scope,
    listCommands: async value => { commandCalls.push(value); return { commands } },
    listReferences: async (value, query) => { referenceCalls.push({ scope: value, query }); return { references } },
    notice: (...args) => events.notices.push(args),
  }, overrides.host || {})
  const tools = toolsModule.create({
    document,
    input,
    menu,
    hint,
    quoteList,
    host,
    commands: overrides.enableCommands,
    i18n: 'zh',
    onChange: event => events.changes.push(event),
    onQuotesChange: quotes => events.quotes.push(quotes),
  })
  const type = (value, caret = value.length) => {
    input.value = value
    input.setSelectionRange(caret, caret)
    input.emit('input')
  }
  return {
    document, input, menu, hint, quoteList, tools, events, host, type,
    commandCalls, referenceCalls,
    setScope: value => { scope = value },
  }
}

/* ------------------------------ 纯函数 ------------------------------ */

test('触发识别只认行首命令与边界 @，并覆盖当前 token 用于精确替换', () => {
  const { detectTrigger } = toolsModule
  assert.deepEqual(detectTrigger('/com', 4), { kind: 'command', query: 'com', start: 0, end: 4, slashes: '/' })
  assert.deepEqual(detectTrigger('/', 1), { kind: 'command', query: '', start: 0, end: 1, slashes: '/' })
  assert.deepEqual(detectTrigger('/com pact', 4), { kind: 'command', query: 'com', start: 0, end: 4, slashes: '/' })
  assert.equal(detectTrigger('hello /com', 10), null)
  assert.equal(detectTrigger(' /com', 5), null)
  assert.equal(detectTrigger('/compact --flag', 10), null)
  assert.deepEqual(detectTrigger('@', 1), { kind: 'reference', query: '', start: 0, end: 1 })
  assert.deepEqual(detectTrigger('看看 @app', 8), { kind: 'reference', query: 'app', start: 3, end: 7 })
  assert.equal(detectTrigger('mail a@b', 8), null)
  assert.equal(detectTrigger('@foo bar', 8), null)
  assert.equal(detectTrigger('人工@', 3), null)
  assert.deepEqual(detectTrigger('( @', 3), { kind: 'reference', query: '', start: 2, end: 3 })
})

test('insertAt 只替换给定区间，保留前后草稿', () => {
  const { insertAt } = toolsModule
  assert.deepEqual(insertAt('abc', 1, 1, 'X'), { value: 'aXbc', caret: 2 })
  assert.deepEqual(insertAt('请检查 @app 后继续', 4, 8, '@public/app.js '), { value: '请检查 @public/app.js  后继续', caret: 19 })
  assert.deepEqual(insertAt('abc', 99, 99, '!'), { value: 'abc!', caret: 4 })
  assert.deepEqual(insertAt('abc', -1, 1, ''), { value: 'bc', caret: 0 })
})

test('主机命令目录归一化：去斜杠、过滤非法/重复、限长，null 表示不支持', () => {
  const { normalizeCommandRows, MAX_COMMANDS } = toolsModule
  const rows = normalizeCommandRows({
    commands: [
      { name: 'compact' },
      { name: '/goal', description: '目标', aliases: ['target', 'target'] },
      { name: 'bad name' },
      { name: '' },
      { name: 'compact' },
      { name: 'x'.repeat(65) },
      { name: 'export', source: 'builtin', argumentHint: '[dir]' },
    ],
  })
  assert.deepEqual(rows.map(row => row.name), ['compact', 'goal', 'export'])
  assert.deepEqual(rows[1].aliases, ['target'])
  assert.equal(rows[2].argumentHint, '[dir]')
  assert.equal(normalizeCommandRows(null), null)
  assert.equal(normalizeCommandRows({ supported: false }), null)
  assert.equal(normalizeCommandRows({ commands: 'nope' }), null)
  assert.deepEqual(normalizeCommandRows({ commands: [] }), [])
  const many = Array.from({ length: 55 }, (_, index) => ({ name: 'cmd' + index }))
  assert.equal(normalizeCommandRows(many).length, MAX_COMMANDS)
})

test('主机 @ 目录归一化：权限拒绝项不进入候选，token 必须是主机给出的原生 @ 文本', () => {
  const { normalizeReferenceRows, MAX_REFERENCES } = toolsModule
  const rows = normalizeReferenceRows({
    references: [
      { label: 'app.js', insert: '@public/app.js', detail: '文件' },
      { label: '拒绝', insert: '@secret', allowed: false },
      { label: '拒绝2', insert: '@secret2', denied: true },
      { label: '无 token', label: 'x' },
      { label: '换行', insert: '@a\nb' },
      { label: 'app.js 重复', insert: '@public/app.js' },
      { label: '次要', insert: '@public/app.js', label: '重复' },
    ],
  })
  assert.deepEqual(rows.map(row => row.insert), ['@public/app.js'])
  assert.equal(rows[0].detail, '文件')
  assert.equal(normalizeReferenceRows({ supported: false }), null)
  const many = Array.from({ length: 40 }, (_, index) => ({ insert: '@f' + index }))
  assert.equal(normalizeReferenceRows({ references: many }).length, MAX_REFERENCES)
})

test('命令本地过滤前缀优先、别名可命中，引用过滤只做展示层匹配', () => {
  const { normalizeCommandRows, normalizeReferenceRows, filterCommandRows, filterReferenceRows } = toolsModule
  const commands = normalizeCommandRows({ commands: [
    { name: 'goal' }, { name: 'compact' }, { name: 'copy' }, { name: 'target', aliases: ['goal'] },
  ] })
  assert.deepEqual(filterCommandRows(commands, 'co').map(row => row.name), ['compact', 'copy'])
  assert.deepEqual(filterCommandRows(commands, 'GO').map(row => row.name), ['goal', 'target'])
  assert.deepEqual(filterCommandRows(commands, 'omp').map(row => row.name), ['compact'])
  assert.equal(filterCommandRows(commands, '').length, 4)
  assert.equal(filterCommandRows(commands, 'zzz').length, 0)
  const references = normalizeReferenceRows({ references: [
    { label: 'app.js', insert: '@public/app.js', detail: '文件' },
    { label: 'readme', insert: '@docs/readme.md', detail: '文件' },
  ] })
  assert.deepEqual(filterReferenceRows(references, 'app').map(row => row.insert), ['@public/app.js'])
  assert.deepEqual(filterReferenceRows(references, 'README').map(row => row.insert), ['@docs/readme.md'])
  assert.equal(filterReferenceRows(references, '').length, 2)
})

test('消息选段引用：保留主机来源与正文、限长标记、Markdown 块引用格式', () => {
  const { sanitizeQuote, quotePreview, formatQuotes } = toolsModule
  const quote = sanitizeQuote({ text: '第一行\r\n第二行', messageId: 7, role: 'Assistant' })
  assert.equal(quote.text, '第一行\n第二行')
  assert.equal(quote.role, 'assistant')
  assert.equal(quote.messageId, '7')
  assert.equal(quote.truncated, false)
  assert.equal(sanitizeQuote({ text: '   ' }), null)
  assert.equal(sanitizeQuote(null), null)
  assert.equal(sanitizeQuote({ text: 'a\u0007b' }).text, 'ab')
  const long = sanitizeQuote({ text: 'x'.repeat(5000) })
  assert.equal(long.text.length, 4000)
  assert.equal(long.truncated, true)
  assert.equal(quotePreview('  第一行  很长\n第二行'), '第一行 很长')
  assert.equal(quotePreview('a'.repeat(120), 10), 'a'.repeat(9) + '…')
  assert.equal(formatQuotes([{ text: 'a\nb' }, { text: 'c' }]), '> a\n> b\n\n> c')
  assert.equal(formatQuotes([{ text: 'a\n\nb' }]), '> a\n> \n> b')
  assert.equal(formatQuotes([]), '')
})

/* ------------------------------ 交互：命令 ------------------------------ */

test('输入 / 动态读取当前会话命令，方向键+回车接受并保留已有参数草稿', async () => {
  const harness = createHarness()
  harness.input.value = '/com 写一份说明'
  harness.input.setSelectionRange(4, 4)
  harness.input.emit('input')
  await flush()
  assert.equal(harness.commandCalls.length, 1)
  assert.equal(harness.commandCalls[0].key, 'session-1')
  const snapshot = harness.tools.menuSnapshot()
  assert.equal(snapshot.open, true)
  assert.deepEqual(snapshot.items.map(item => item.label), ['/compact'])
  const down = { key: 'ArrowDown', prevented: false, preventDefault() { this.prevented = true } }
  assert.equal(harness.tools.keydown(down), true)
  assert.equal(down.prevented, true)
  const enter = { key: 'Enter', prevented: false, preventDefault() { this.prevented = true } }
  assert.equal(harness.tools.keydown(enter), true)
  assert.equal(enter.prevented, true)
  assert.equal(harness.document.activeElement, harness.input, '接受候选后焦点留在输入框')
  assert.equal(harness.input.value, '/compact 写一份说明')
  assert.equal(harness.input.selectionStart, 9)
  assert.equal(harness.menu.hidden, true)
  assert.equal(harness.events.changes.length, 1)
  assert.equal(harness.events.changes[0].kind, 'command')
  assert.equal(harness.events.changes[0].item.name, 'compact')
})

test('触控点按候选即可接受，不依赖 hover；列表项是 44px 可点按钮', async () => {
  const harness = createHarness()
  harness.type('/')
  await flush()
  const items = harness.menu.children
  assert.equal(items.length, 3)
  assert.equal(items[0].tagName, 'BUTTON')
  assert.equal(items[0].type, 'button')
  assert.ok(items[0].listeners.has('mousedown'), '按下时阻止焦点转移')
  assert.ok(items[0].listeners.has('click'), '触控 click 直接接受')
  items[1].emit('click')
  assert.equal(harness.input.value, '/goal ')
  assert.equal(harness.events.changes.length, 1)
})

test('无匹配时关闭候选，不吞发送键；Escape 只关菜单不清草稿', async () => {
  const harness = createHarness()
  harness.type('/zzz')
  await flush()
  assert.equal(harness.menu.hidden, true)
  assert.equal(harness.tools.menuSnapshot().open, false)
  assert.equal(harness.tools.keydown({ key: 'Enter' }), false, '菜单关闭时 Enter 交给发送路径')
  harness.type('/')
  await flush()
  assert.equal(harness.tools.menuSnapshot().open, true)
  assert.equal(harness.tools.keydown({ key: 'Escape', preventDefault() {} }), true)
  assert.equal(harness.menu.hidden, true)
  assert.equal(harness.input.value, '/', 'Escape 不覆盖草稿')
})

test('输入法组合中的回车不当作候选接受', async () => {
  const harness = createHarness()
  harness.type('/')
  await flush()
  const before = harness.input.value
  assert.equal(harness.tools.keydown({ key: 'Enter', isComposing: true }), false)
  assert.equal(harness.input.value, before)
  assert.equal(harness.tools.menuSnapshot().open, true, '菜单保持打开等待组合结束')
})

test('命令目录按会话缓存；切换会话后重新读取，旧会话迟到结果不串台', async () => {
  let resolveCommands
  const harness = createHarness({
    host: {
      listCommands: () => new Promise(resolve => { resolveCommands = resolve }),
    },
  })
  harness.type('/')
  await flush()
  assert.equal(harness.commandCalls.length, 0, '异步期间只发一次请求')
  // 切会话后旧请求才返回：不得渲染旧会话的命令。
  harness.setScope({ key: 'session-2', sessionId: 'session-2' })
  harness.tools.setScope({ key: 'session-2' })
  await flush()
  resolveCommands({ commands: [{ name: 'compact' }] })
  await flush()
  assert.equal(harness.menu.hidden, true)
  assert.equal(harness.tools.status().scope, 'session-2')
})

/* ------------------------------ 交互：@ 引用 ------------------------------ */

test('由另一个菜单处理斜杠候选时，Composer 保留引用和该菜单的键盘状态', async () => {
  const harness = createHarness({ enableCommands: false })
  harness.input.setAttribute('aria-controls', 'slash-menu')
  harness.input.setAttribute('aria-activedescendant', 'slash-plan')
  harness.type('/pl')
  await flush()
  assert.equal(harness.commandCalls.length, 0)
  assert.equal(harness.input.getAttribute('aria-activedescendant'), 'slash-plan')

  harness.type('@app')
  await flush()
  assert.equal(harness.tools.keydown({ key: 'Enter', defaultPrevented: true }), false)
  assert.equal(harness.input.value, '@app')
  assert.equal(harness.tools.keydown({ key: 'Enter', preventDefault() {} }), true)
  assert.equal(harness.input.value, '@public/app.js ')
  assert.equal(toolsModule.fileReferenceMention({ path: 'docs/with spaces', kind: 'directory' }), '@"docs/with spaces/"')
})

test('确认发送时仅移除已发送的选段，保留等待回执期间添加的选段', () => {
  const harness = createHarness()
  const sent = harness.tools.addQuote({ messageId: 'sent', text: 'Already submitted' })
  const next = harness.tools.addQuote({ messageId: 'next', text: 'Next message' })
  harness.tools.clearQuotes([sent.id])
  assert.deepEqual(harness.tools.quotes().map(quote => quote.id), [next.id])
})

test('@ 引用只显示主机允许的条目，插入主机原生 token 且保留前后草稿', async () => {
  const harness = createHarness()
  const draft = '请检查 @app'
  harness.type(draft, draft.length)
  await flush()
  assert.equal(harness.referenceCalls.length, 1)
  assert.deepEqual(harness.referenceCalls[0].query, 'app')
  const labels = harness.tools.menuSnapshot().items.map(item => item.label)
  assert.deepEqual(labels, ['app.js'], '权限拒绝项不会出现')
  harness.menu.children[0].emit('click')
  assert.equal(harness.input.value, '请检查 @public/app.js ')
  assert.equal(harness.input.selectionStart, '请检查 @public/app.js '.length)
  assert.equal(harness.events.changes[0].item.insert, '@public/app.js')
  assert.equal(harness.events.notices.length, 0, '接受引用不发送消息')
})

test('旧主机没有命令/引用目录时静默降级：提示一次、原文本保留、不拦截发送', async () => {
  const harness = createHarness({
    host: { listCommands: undefined, listReferences: undefined },
  })
  harness.type('/compact')
  await flush()
  assert.equal(harness.menu.hidden, true)
  assert.equal(harness.hint.hidden, false)
  assert.match(harness.hint.textContent, /手输/)
  assert.equal(harness.input.value, '/compact', '降级不修改草稿')
  assert.equal(harness.tools.keydown({ key: 'Enter' }), false)
  harness.type('看看 @app')
  await flush()
  assert.match(harness.hint.textContent, /@/)
  assert.equal(harness.input.value, '看看 @app')
  const hintText = harness.hint.textContent
  harness.type('看看 @ap')
  await flush()
  assert.equal(harness.hint.textContent, hintText, '同一会话只提示一次')
})

test('读取目录失败时降级为手输，不抛错、不阻塞纯文本', async () => {
  const harness = createHarness({
    host: {
      listCommands: async () => { throw new Error('offline') },
      listReferences: async () => { throw new Error('offline') },
    },
  })
  harness.type('/')
  await flush()
  assert.equal(harness.menu.hidden, true)
  assert.match(harness.hint.textContent, /暂时无法读取命令目录/)
  assert.equal(harness.tools.keydown({ key: 'Enter' }), false)
  harness.type('纯文本')
  await flush()
  assert.equal(harness.input.value, '纯文本')
  assert.equal(harness.menu.hidden, true)
})

test('引用查询过期：用户已改成普通文本时，迟到的候选不得打开或改草稿', async () => {
  let resolveReferences
  const harness = createHarness({
    host: {
      listReferences: () => new Promise(resolve => { resolveReferences = resolve }),
    },
  })
  harness.type('@app')
  await flush()
  harness.type('普通文本')
  await flush()
  resolveReferences({ references: [{ label: 'app.js', insert: '@public/app.js' }] })
  await flush()
  assert.equal(harness.menu.hidden, true)
  assert.equal(harness.input.value, '普通文本')
  assert.equal(harness.tools.menuSnapshot().open, false)
})

/* ------------------------------ 消息选段引用 ------------------------------ */

test('消息选段引用可新增/去重/展开检查/移除，且绝不自动发送或覆盖草稿', () => {
  const harness = createHarness()
  harness.input.value = '还没发出去的草稿'
  const first = harness.tools.addQuote({ messageId: 'm1', role: 'assistant', text: '第一行\n第二行' })
  assert.ok(first)
  assert.equal(harness.input.value, '还没发出去的草稿', '加引用不碰输入框')
  assert.equal(harness.events.notices.length, 0, '加引用不触发发送')
  assert.equal(harness.tools.quotes().length, 1)
  assert.equal(harness.quoteList.hidden, false)
  assert.equal(JSON.stringify(harness.tools.quotes()), JSON.stringify([{
    id: first.id, messageId: 'm1', role: 'assistant', text: '第一行\n第二行', truncated: false, preview: '第一行',
  }]))
  const duplicate = harness.tools.addQuote({ messageId: 'm1', role: 'assistant', text: '第一行\n第二行' })
  assert.equal(duplicate.id, first.id)
  assert.equal(harness.tools.quotes().length, 1)
  assert.equal(harness.tools.formatQuotes(), '> 第一行\n> 第二行')

  const card = harness.quoteList.children[0]
  const inspect = byClass(card, 'ct-quote-inspect')[0]
  assert.equal(card.children[2].hidden, true)
  inspect.emit('click')
  const expandedCard = harness.quoteList.children[0]
  assert.equal(expandedCard.children[2].hidden, false, '展开后显示完整原文')
  assert.equal(byClass(expandedCard, 'ct-quote-inspect')[0].textContent, '收起')
  byClass(expandedCard, 'ct-quote-inspect')[0].emit('click')
  assert.equal(harness.quoteList.children[0].children[2].hidden, true)

  byClass(harness.quoteList.children[0], 'ct-quote-remove')[0].emit('click')
  assert.equal(harness.tools.quotes().length, 0)
  assert.equal(harness.quoteList.hidden, true)
  assert.equal(harness.input.value, '还没发出去的草稿')
  assert.equal(harness.events.notices.length, 0)
})

test('引用上限 8 条并提示，超长正文截断且以文本渲染（无 HTML 注入）', () => {
  const harness = createHarness()
  const injected = harness.tools.addQuote({ messageId: '<img src=x>', role: 'user', text: '<script>alert(1)</script>' })
  assert.equal(harness.quoteList.children[0].children[1].textContent, '<script>alert(1)</script>')
  assert.equal(injected.truncated, false)
  for (let index = 0; index < 8; index += 1) harness.tools.addQuote({ messageId: 'm' + index, text: '引用 ' + index })
  assert.equal(harness.tools.quotes().length, 8)
  assert.equal(harness.tools.addQuote({ messageId: 'overflow', text: '最后一条' }), null)
  assert.equal(harness.events.notices.length, 2, '循环中的第一条溢出与显式溢出各提示一次')
  assert.match(harness.events.notices[0][0], /8/)
  assert.match(harness.events.notices[1][0], /8/)
  const long = harness.tools.addQuote({ messageId: 'long', text: 'x'.repeat(5000) })
  assert.equal(long, null, '已达上限时不再追加')
  const fresh = createHarness()
  const longQuote = fresh.tools.addQuote({ messageId: 'long', text: 'x'.repeat(5000) })
  assert.equal(longQuote.truncated, true)
  assert.equal(fresh.quoteList.children[0].children[2].textContent.length > 4000, true)
})

test('引用跟随会话草稿隔离：切换会话不把选段带进另一条消息', () => {
  const harness = createHarness()
  harness.tools.addQuote({ messageId: 'm1', text: 'A 会话引用' })
  harness.tools.setScope({ key: 'session-2' })
  assert.equal(harness.tools.quotes().length, 0)
  assert.equal(harness.quoteList.hidden, true)
  harness.tools.addQuote({ messageId: 'm2', text: 'B 会话引用' })
  assert.equal(harness.tools.quotes()[0].text, 'B 会话引用')
  harness.tools.setScope({ key: 'session-1' })
  assert.equal(harness.tools.quotes()[0].text, 'A 会话引用')
  harness.tools.clearQuotes()
  assert.equal(harness.tools.quotes().length, 0)
  assert.equal(harness.quoteList.hidden, true)
})

/* ------------------------------ 程序化插入入口 ------------------------------ */

test('旧静态指令入口改为草稿内插入：不覆盖原文，命令落到整条草稿开头', () => {
  const harness = createHarness()
  harness.input.value = '先写一半的句子'
  harness.input.setSelectionRange(5, 5)
  assert.equal(harness.tools.insertCommand('compact'), true)
  assert.equal(harness.input.value, '/compact 先写一半的句子')
  assert.equal(harness.input.selectionStart, 9)
  assert.equal(harness.events.changes.at(-1).item.name, 'compact')
  assert.equal(harness.tools.insertCommand('bad name'), false)
  assert.equal(harness.tools.insertCommand(''), false)

  harness.input.value = 'hello'
  harness.input.setSelectionRange(5, 5)
  assert.equal(harness.tools.insertReference('@public/app.js'), true)
  assert.equal(harness.input.value, 'hello @public/app.js ')
  assert.equal(harness.tools.insertReference('not-a-token'), false)
})

/* ------------------------------ 静态约束与接线检查 ------------------------------ */

test('模块保持零依赖组合语义：不 fetch、不写 innerHTML、不自动提交', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'composer-tools.js'), 'utf8')
  assert.doesNotMatch(source, /\bfetch\s*\(/)
  assert.doesNotMatch(source, /innerHTML/)
  assert.doesNotMatch(source, /XMLHttpRequest/)
  assert.doesNotMatch(source, /\.submit\s*\(/)
  assert.match(source, /root\.DshComposerTools\s*=\s*api/)
  assert.match(source, /module\.exports\s*=\s*api/)
})

test('样式覆盖浮层、44px 触控项、键盘焦点、横向引用卡片与降级提示', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'composer-tools.css'), 'utf8')
  assert.match(css, /\.ct-menu\s*\{/)
  assert.match(css, /max-height:\s*min\(52dvh/)
  assert.match(css, /overflow-y:\s*auto/)
  assert.match(css, /\.ct-item\s*\{[^}]*min-height:\s*44px/s)
  assert.match(css, /@media\s*\(hover:\s*hover\)/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /\.ct-quotes\s*\{[^}]*overflow-x:\s*auto/s)
  assert.match(css, /\.ct-quote-full\[hidden\]/)
  assert.match(css, /\.ct-hint/)
  assert.match(css, /prefers-reduced-motion/)
})
