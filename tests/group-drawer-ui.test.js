'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')

test('应用名可打开可访问的组快捷切换抽屉，手机和桌面共用现有切换逻辑', () => {
  const mobileHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  const mobileJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  const mobileCss = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8')
  const desktopHtml = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.html'), 'utf8')
  const desktopJs = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')
  const desktopCss = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.css'), 'utf8')

  assert.match(mobileHtml, /id="group-drawer-trigger"[^>]+aria-controls="group-drawer"[^>]+aria-expanded="false"/)
  assert.match(mobileHtml, /id="group-drawer"[^>]+role="dialog"[^>]+aria-modal="true"/)
  assert.match(mobileHtml, /id="group-drawer-manage"/)
  assert.match(mobileJs, /function renderGroupDrawer\(\)/)
  assert.match(mobileJs, /data-quick-group=/)
  assert.match(mobileJs, /function keepGroupDrawerFocus\(event\)/)
  assert.match(mobileJs, /if \(group !== state\.activeGroup\) switchGroup\(group\)/)
  assert.match(mobileJs, /showSettingsPage\('servers'\)/)
  assert.match(mobileCss, /\.group-drawer \{[^}]*position: fixed/)
  assert.match(mobileCss, /@media \(prefers-reduced-motion: reduce\)/)

  assert.match(desktopHtml, /id="ds-group-drawer-trigger"[^>]+aria-controls="ds-group-drawer"[^>]+aria-expanded="false"/)
  assert.match(desktopHtml, /id="ds-group-drawer"[^>]+role="dialog"[^>]+aria-modal="true"/)
  assert.match(desktopHtml, /id="ds-group-drawer-manage"/)
  assert.match(desktopJs, /function renderDesktopGroupDrawer\(\)/)
  assert.match(desktopJs, /data-ds-quick-group=/)
  assert.match(desktopJs, /function keepDesktopGroupDrawerFocus\(event\)/)
  assert.match(desktopJs, /if \(group !== state\.activeGroup\) switchGroup\(group\)/)
  assert.match(desktopCss, /\.ds-group-drawer \{[^}]*position: fixed/)
  assert.match(desktopCss, /@media \(prefers-reduced-motion: reduce\)/)
})

test('快捷侧栏与底栏的待处理数量一起更新和清空', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  const start = source.indexOf('function updatePendingBadge()')
  const end = source.indexOf('\n/*', start)
  const badges = new Map()
  for (const id of ['nav-pending', 'group-drawer-pending']) {
    const badge = { hidden: true, textContent: '' }
    badge.classList = { toggle(name, hidden) { assert.equal(name, 'hidden'); badge.hidden = hidden } }
    badges.set(id, badge)
  }
  const state = { approvals: [{}], questions: [{}, {}] }
  const context = vm.createContext({ state, $: id => badges.get(id) })
  vm.runInContext(source.slice(start, end), context)

  context.updatePendingBadge()
  for (const badge of badges.values()) {
    assert.equal(badge.hidden, false)
    assert.equal(badge.textContent, 3)
  }
  state.approvals = []
  state.questions = []
  context.updatePendingBadge()
  for (const badge of badges.values()) {
    assert.equal(badge.hidden, true)
    assert.equal(badge.textContent, '')
  }
})

test('快捷侧栏按活动时间显示最近五条会话并跳过归档、空白和子代理会话', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  const start = source.indexOf('function renderGroupDrawerSessions()')
  const list = { innerHTML: '', contains: () => false }
  let hidden = true
  const nodes = {
    'group-drawer-sessions': list,
    'group-drawer-recent': { classList: { toggle: (_, value) => { hidden = value } } },
    'view-session': { classList: { contains: () => false } },
  }
  const state = {
    current: 'session-5',
    wbArchived: ['archived'],
    sessions: [
      ...Array.from({ length: 7 }, (_, time) => ({ sessionId: 'session-' + time, time })),
      { sessionId: 'archived', time: 99 },
      { sessionId: 'blank', blank: true, time: 99 },
      { sessionId: 'child', origin: 'subagent', time: 99 },
    ],
  }
  const context = vm.createContext({
    state, $: id => nodes[id], groupDrawerOpen: () => true, document: {},
    isVisibleSession: session => !session.blank && session.origin !== 'subagent',
    sessionSortTime: session => session.time,
    sessionLabelOf: session => session.sessionId,
    sessionWorkspaceName: () => 'workspace',
    esc: value => value,
  })
  vm.runInContext(source.slice(start, source.indexOf('function openGroupDrawer()', start)), context)
  context.renderGroupDrawerSessions()
  assert.equal(hidden, false)
  assert.deepEqual([...list.innerHTML.matchAll(/data-drawer-session="([^"]+)"/g)].map(match => match[1]),
    ['session-6', 'session-5', 'session-4', 'session-3', 'session-2'])
  assert.match(list.innerHTML, /data-drawer-session="session-5" aria-current="true"/)
  state.sessions = []
  context.renderGroupDrawerSessions()
  assert.equal(hidden, true)
  assert.equal(list.innerHTML, '')
})

test('快捷侧栏忽略切换连接前发出的中转状态请求', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  const start = source.indexOf('let groupDrawerRoute = null')
  const end = source.indexOf('function renderGroupDrawer', start)
  const status = { textContent: '' }
  const reads = []
  let active = 'http://lan.test'
  const elements = {
    'group-drawer': { classList: { contains: () => false } },
    'group-drawer-connection': status,
  }
  const context = vm.createContext({
    $: id => elements[id],
    captureConnection() {
      const host = active
      return { token: 'fixture-token', valid: () => active === host }
    },
    updateBase: () => active,
    adminApiUrl: path => active + path,
    t: key => key,
    window: { DshRelaySettings: { connectionCategory: data => data.category } },
    AbortSignal,
    fetch: url => new Promise(resolve => { reads.push({ url, resolve }) }),
  })
  vm.runInContext(source.slice(start, end), context)

  const oldRead = context.updateGroupDrawerRoute()
  active = 'https://relay.test'
  const newRead = context.updateGroupDrawerRoute()
  assert.deepEqual(reads.map(read => read.url), [
    'http://lan.test/admin/api/relay', 'https://relay.test/admin/api/relay',
  ])
  reads[1].resolve({ ok: true, json: async () => ({ category: 'basic' }) })
  await newRead
  reads[0].resolve({ ok: true, json: async () => ({ category: 'direct' }) })
  await oldRead
  assert.equal(status.textContent, 'groups.drawerRoute.basic')
})
