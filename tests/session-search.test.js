'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const search = require('../public/session-search.js')
const ROOT = path.join(__dirname, '..')
const SEARCH_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'session-search.js'), 'utf8')
const SEARCH_CSS = fs.readFileSync(path.join(ROOT, 'public', 'session-search.css'), 'utf8')

function fixture() {
  const sessions = [
    { sessionId: 's-loaded', cwd: '/work/alpha', projections: { values: { title: '已加载会话' } } },
    { sessionId: 's-remote', cwd: '/work/alpha', projections: { values: { title: '未加载历史' } } },
    { sessionId: 's-beta', cwd: '/work/beta', projections: { values: { title: 'Beta 记录' } } },
    { sessionId: 's-archived', cwd: '/work/alpha', projections: { values: { title: '归档会话' } } },
    { sessionId: 's-pinned', cwd: '/work/alpha', projections: { values: { title: '置顶会话' } } },
    { sessionId: 's-child', cwd: '/work/alpha', origin: 'subagent', projections: { values: { title: '子代理' } } },
    { sessionId: 's-blank', cwd: '/work/alpha', blank: true, projections: { values: { title: '空会话' } } },
  ]
  const workspaces = [
    { workspaceId: 'ws-alpha', path: '/work/alpha', title: 'Alpha 项目', sessionIds: ['s-loaded', 's-remote'] },
    { workspaceId: 'ws-beta', path: '/work/beta', title: 'Beta 项目', sessionIds: [] },
  ]
  return { sessions, workspaces, archived: ['s-archived'], pinned: ['s-pinned'] }
}

function makeAdapter(options = {}) {
  const data = fixture()
  const calls = []
  const opens = []
  const notices = []
  const adapter = {
    sessions: () => options.sessions || data.sessions,
    workspaces: () => options.workspaces || data.workspaces,
    archivedSessionIds: () => options.archived || data.archived,
    pinnedSessionIds: () => options.pinned || data.pinned,
    openSession: async (sessionId, extra) => { opens.push({ sessionId, ...extra }) },
    notice: message => notices.push(message),
    rpc: async (method, payload, rpcOptions) => {
      calls.push({ method, payload, options: rpcOptions })
      if (typeof options.rpc === 'function') return options.rpc(method, payload, rpcOptions)
      return { items: [], hasMore: false }
    },
  }
  if (options.searchSupported !== undefined) adapter.searchSupported = () => options.searchSupported
  if (options.locateSnippet) adapter.locateSnippet = options.locateSnippet
  if (options.historyRoot) adapter.historyRoot = options.historyRoot
  return { adapter, calls, opens, notices, data }
}

test('搜索调用主机 session.search，且能返回本机历史未加载的会话', async () => {
  const ctx = makeAdapter({
    rpc: () => ({ items: [{ sessionId: 's-remote', snippet: '历史正文里的 remote 命中' }], hasMore: false }),
  })
  const controller = search.createController(ctx.adapter)
  const state = await controller.search({ query: '  remote  ' })
  assert.equal(state.status, search.statuses.RESULTS)
  assert.equal(state.query, 'remote')
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].method, 'session.search')
  assert.deepEqual(ctx.calls[0].payload, { query: 'remote' })
  assert.equal(state.items.length, 1)
  const item = state.items[0]
  assert.equal(item.sessionId, 's-remote')
  assert.equal(item.title, '未加载历史', '标题/工作区来自主机会话清单，不依赖本机已加载历史')
  assert.equal(item.workspace.workspaceId, 'ws-alpha')
  assert.equal(item.snippet, '历史正文里的 remote 命中')
  assert.ok(item.matchKinds.includes('content'))
  assert.equal(state.stats.contentHits, 1)
})

test('无结果、权限错误、搜索失败、主机不支持四种状态严格区分', async () => {
  const empty = makeAdapter({ rpc: () => ({ items: [], hasMore: false }) })
  assert.equal((await search.createController(empty.adapter).search({ query: 'zzz-none' })).status, search.statuses.EMPTY)

  const denied = makeAdapter({ rpc: () => { throw Object.assign(new Error('unauthorized'), { code: 'AUTH' }) } })
  const deniedState = await search.createController(denied.adapter).search({ query: 'secret' })
  assert.equal(deniedState.status, search.statuses.DENIED)
  assert.equal(deniedState.error.kind, 'auth')

  const failed = makeAdapter({ rpc: () => { throw Object.assign(new Error('boom'), { code: 'gateway/internal' }) } })
  const failedState = await search.createController(failed.adapter).search({ query: 'secret' })
  assert.equal(failedState.status, search.statuses.ERROR)
  assert.equal(failedState.error.kind, 'failed')

  const oldHost = makeAdapter({ rpc: () => { throw Object.assign(new Error('method unavailable'), { code: 'method-unavailable', status: 404 }) } })
  const oldState = await search.createController(oldHost.adapter).search({ query: '会话' })
  assert.equal(oldState.status, search.statuses.UNSUPPORTED)
  assert.equal(oldState.error.kind, 'unsupported')
  assert.equal(oldState.items.length, 0, '不支持全文搜索时不得把本地筛选当作正文结果')
  assert.ok(oldState.localMatches.length >= 1)
  assert.ok(oldState.localMatches.every(item => item.localOnly === true))
  assert.ok(oldState.localMatches.every(item => !item.matchKinds.includes('content')))
})

test('主机关闭全文索引时仅返回明确标注的本地匹配', async () => {
  const disabled = makeAdapter({ rpc: () => {
    throw Object.assign(new Error('session search failed: SessionQueryError: session search is disabled: openAt never'), { code: 'gateway/internal' })
  } })
  const state = await search.createController(disabled.adapter).search({ query: '会话' })
  assert.equal(state.status, search.statuses.UNSUPPORTED)
  assert.equal(state.error.kind, 'disabled')
  assert.equal(state.items.length, 0)
  assert.ok(state.localMatches.length >= 1 && state.localMatches.every(item => item.localOnly))
})

test('能力标记为不支持时不发起 RPC，只展示明确标注的本地标题/ID 匹配', async () => {
  const ctx = makeAdapter({ searchSupported: false, rpc: () => ({ items: [{ sessionId: 's-loaded', snippet: 'x' }], hasMore: false }) })
  const state = await search.createController(ctx.adapter).search({ query: '会话' })
  assert.equal(state.status, search.statuses.UNSUPPORTED)
  assert.equal(ctx.calls.length, 0, '不支持时不能伪造主机请求成功')
  assert.ok(state.localMatches.length >= 1)
  const html = search.renderSearchHtml(state)
  assert.match(html, /不支持全文会话搜索/)
  assert.match(html, /本地标题\/会话 ID 匹配/)
  assert.match(html, /未搜索历史正文/)
  assert.doesNotMatch(html, /正文命中/)
})

test('正文无命中但本地标题命中时明确标为 metadataOnly，不冒充全文搜索', async () => {
  const ctx = makeAdapter({ rpc: () => ({ items: [], hasMore: false }) })
  const state = await search.createController(ctx.adapter).search({ query: '已加载' })
  assert.equal(state.status, search.statuses.RESULTS)
  assert.equal(state.metadataOnly, true)
  assert.equal(state.stats.contentHits, 0)
  assert.equal(state.stats.metadataHits, 1)
  assert.equal(state.items[0].snippet, '')
  assert.deepEqual(state.items[0].matchKinds, ['title'])
  const html = search.renderSearchHtml(state)
  assert.match(html, /正文搜索没有命中/)
  assert.match(html, /未搜索历史正文/)
  assert.doesNotMatch(html, /正文命中<\/span>/)
})

test('可过滤工作区并选择是否包含归档，命中片段与标题会被安全高亮', async () => {
  const ctx = makeAdapter({
    rpc: () => ({
      items: [
        { sessionId: 's-loaded', snippet: 'alpha <img src=x onerror=alert(1)> secret' },
        { sessionId: 's-beta', snippet: 'beta secret 命中' },
        { sessionId: 's-archived', snippet: 'archived secret 命中' },
      ],
      hasMore: false,
    }),
  })
  const controller = search.createController(ctx.adapter)
  const all = await controller.search({ query: 'secret' })
  assert.deepEqual(all.items.map(item => item.sessionId), ['s-loaded', 's-beta'])
  assert.equal(all.stats.filteredArchived, 1)

  const beta = await controller.search({ query: 'secret', workspaceId: 'ws-beta' })
  assert.deepEqual(beta.items.map(item => item.sessionId), ['s-beta'])
  assert.ok(beta.stats.filteredWorkspace >= 1)

  const withArchived = await controller.search({ query: 'secret', workspaceId: '', includeArchived: true })
  assert.deepEqual(withArchived.items.map(item => item.sessionId).sort(), ['s-archived', 's-beta', 's-loaded'])

  const html = search.renderSearchHtml(all)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, '片段中的 HTML 必须转义')
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /<mark>secret<\/mark>/)
  assert.match(html, /Alpha 项目/)
})

test('结果状态渲染区分无结果/失败/不支持，并阻止并发旧结果覆盖新结果', async () => {
  assert.match(search.renderSearchHtml({ status: search.statuses.EMPTY, items: [] }), /没有匹配的会话/)
  assert.match(search.renderSearchHtml({ status: search.statuses.ERROR, error: { message: '搜索失败' } }), /data-dr-search-retry/)
  assert.match(search.renderSearchHtml({ status: search.statuses.DENIED, error: { message: '无权限' } }), /无权限/)

  let resolveFirst
  const first = new Promise(resolve => { resolveFirst = resolve })
  let calls = 0
  const ctx = makeAdapter({
    rpc: async () => {
      calls++
      if (calls === 1) return first
      return { items: [{ sessionId: 's-beta', snippet: 'new' }], hasMore: false }
    },
  })
  const controller = search.createController(ctx.adapter)
  const slow = controller.search({ query: 'old' })
  const fast = await controller.search({ query: 'new' })
  resolveFirst({ items: [{ sessionId: 's-loaded', snippet: 'old' }], hasMore: false })
  const slowState = await slow
  assert.deepEqual(fast.items.map(item => item.sessionId), ['s-beta'])
  assert.deepEqual(slowState.items.map(item => item.sessionId), ['s-beta'], '旧请求结果必须丢弃')
})

test('定位命中片段并可取到回合 data-seq；历史异步渲染时轮询等待', async () => {
  const classes = []
  const msg = {
    tagName: 'DIV',
    textContent: '这里是 secret 命中所在回合的消息',
    classList: { add: value => classes.push(value) },
    dataset: {},
    scrollIntoView() { this.scrolled = true },
    closest(selector) { return selector === '[data-seq]' ? { dataset: { seq: '42' } } : null },
  }
  const root = {
    tagName: 'DIV',
    textContent: '外层',
    matches: () => false,
    querySelectorAll: () => [msg],
  }
  const located = search.locateSnippet(root, 'secret')
  assert.equal(located.found, true)
  assert.equal(located.turnSeq, 42)
  assert.equal(msg.scrolled, true)
  assert.ok(classes.includes('dr-search-located'))

  let rootValue = null
  setTimeout(() => { rootValue = root }, 25)
  const waited = await search.waitForSnippet(() => rootValue, 'secret', { timeoutMs: 500, intervalMs: 20 })
  assert.equal(waited.found, true)
  assert.equal(waited.turnSeq, 42)
})

test('打开结果调用导航与定位回调，未定位时如实返回原因', async () => {
  const ctx = makeAdapter({ locateSnippet: async () => ({ found: true, turnSeq: 7 }) })
  const controller = search.createController(ctx.adapter)
  const result = await controller.openResult({ sessionId: 's-remote', snippet: 'remote 命中' })
  assert.equal(result.opened, true)
  assert.equal(result.located, true)
  assert.equal(result.turnSeq, 7)
  assert.deepEqual(ctx.opens, [{ sessionId: 's-remote', snippet: 'remote 命中', query: '' }])

  const missCtx = makeAdapter()
  const miss = await search.createController(missCtx.adapter).openResult({ sessionId: 's-remote', snippet: '' })
  assert.equal(miss.opened, true)
  assert.equal(miss.located, false)
  assert.equal(miss.reason, 'no-snippet')
})

test('mount 可注入容器并渲染面板，不依赖 HTML 预置节点', async () => {
  const ctx = makeAdapter()
  const controller = search.createController(ctx.adapter)
  const element = {
    className: '',
    innerHTML: '',
    parentNode: null,
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn },
    removeEventListener() {},
  }
  const container = { appendChild(node) { node.parentNode = container; container.node = node }, removeChild(node) { node.parentNode = null; container.node = null } }
  const document = { createElement: () => element }
  const mounted = search.mount(container, controller, { document })
  assert.equal(container.node, element)
  assert.match(element.innerHTML, /data-dr-search-form/)
  assert.equal(typeof element.listeners.submit, 'function')
  mounted.destroy()
  assert.equal(element.parentNode, null)
})

test('DOM 绑定：提交搜索与点击结果走 controller', async () => {
  const ctx = makeAdapter({ rpc: () => ({ items: [{ sessionId: 's-loaded', snippet: 'snippet text' }], hasMore: false }) })
  const controller = search.createController(ctx.adapter)
  const listeners = {}
  const panel = {
    addEventListener: (type, fn) => { listeners[type] = fn },
    removeEventListener: () => {},
  }
  search.bindPanel(panel, controller)

  const query = { value: '会话' }
  const workspace = { value: '' }
  const archived = { checked: false }
  const form = {
    querySelector: selector => selector === '[data-dr-search-input]' ? query
      : selector === '[data-dr-search-workspace]' ? workspace
        : selector === '[data-dr-search-archived]' ? archived : null,
  }
  let prevented = false
  await listeners.submit({
    target: { closest: selector => selector === '[data-dr-search-form]' ? { querySelector: form.querySelector } : null },
    preventDefault: () => { prevented = true },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(prevented, true)
  assert.equal(ctx.calls.at(-1).method, 'session.search')
  assert.deepEqual(ctx.calls.at(-1).payload, { query: '会话' })

  const openTarget = {
    dataset: { drSearchOpen: 's-loaded', drSearchSnippet: 'snippet text' },
    closest(selector) {
      if (selector.includes('[data-dr-search-open]')) return this
      return null
    },
  }
  listeners.click({ target: openTarget })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ctx.opens.length, 1)
  assert.equal(ctx.opens[0].sessionId, 's-loaded')
})

test('纯函数校验与 CSS 前缀', () => {
  assert.equal(search.normalizeQuery('   ').ok, false)
  assert.equal(search.normalizeQuery('a'.repeat(501)).ok, false)
  const value = search.normalizeQuery('  正文 关键词 ')
  assert.deepEqual({ ok: value.ok, query: value.query }, { ok: true, query: '正文 关键词' })

  const catalog = search.normalizeCatalog({
    sessions: fixture().sessions,
    workspaces: fixture().workspaces,
    archivedSessionIds: fixture().archived,
    pinnedSessionIds: fixture().pinned,
  })
  assert.equal(catalog.byId.get('s-remote').workspaceId, 'ws-alpha')
  assert.equal(catalog.byId.get('s-beta').workspaceId, 'ws-beta')
  assert.equal(catalog.byId.get('s-archived').archived, true)
  assert.equal(catalog.byId.get('s-pinned').pinned, true)
  assert.equal(search.isVisibleCatalogSession(catalog.byId.get('s-child')), false)
  assert.equal(search.isVisibleCatalogSession(catalog.byId.get('s-blank')), false)

  assert.match(SEARCH_CSS, /\.dr-search-form/)
  assert.match(SEARCH_CSS, /\.dr-search-result/)
  assert.match(SEARCH_SOURCE, /class="dr-search-form/)
  assert.match(SEARCH_SOURCE, /dr-search-workspace/)
})

test('模块加载到浏览器全局与 CommonJS 双出口，且不依赖 app.js 词法变量', () => {
  const context = { I18N: { lang: 'zh' }, navigator: { platform: 'Linux' }, console }
  vm.createContext(context)
  vm.runInContext(SEARCH_SOURCE, context)
  assert.equal(typeof context.DshSessionSearch.init, 'function')
  assert.equal(typeof context.DshSessionSearch.renderSearchHtml, 'function')
  assert.doesNotMatch(SEARCH_SOURCE, /state\.sessions/)
  assert.doesNotMatch(SEARCH_SOURCE, /localStorage/)
  assert.doesNotMatch(SEARCH_SOURCE, /require\(/)
})
