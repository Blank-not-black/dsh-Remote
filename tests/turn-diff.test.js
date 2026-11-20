'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const diff = require('../public/turn-diff.js')

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/turn-diff.js'), 'utf8')

const summary = {
  turn: 1,
  files: [
    { path: 'C:/w/a.md', display: 'a.md', added: 2, deleted: 1 },
    { path: 'C:/w/b.png', display: 'b.png', added: 0, deleted: 0, binary: true },
    { path: 'C:/w/c.bin', display: 'c.bin', added: 0, deleted: 0, oversized: true },
  ],
  total: 3,
  added: 2,
  deleted: 1,
}
const textDiff = {
  kind: 'text', path: 'C:/w/a.md', display: 'a.md', before: true, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old line', '+new line', '+extra line'] }],
}
const entries = [
  { seq: 10, event: { type: 'deliverables/presented', data: { turn: 1, callId: 'call-1', files: [{ path: 'C:/w/report.md', description: 'Final report' }] } } },
  { seq: 11, event: { type: 'workspace/changes', data: { turn: 1 } } },
]

function host(options = {}) {
  let resolve = options.resolve || (async (requestPath, query) => {
    if (requestPath === diff.SUMMARY_PATH) return { ok: true, status: 200, data: options.summary || summary }
    if (requestPath === diff.DIFF_PATH) return { ok: true, status: 200, data: (options.diffs && options.diffs[query.index]) || textDiff }
    return { ok: false, status: 404 }
  })
  const calls = []
  const opened = []
  const root = options.root === false ? null : { innerHTML: '', dataset: {}, addEventListener() {}, removeEventListener() {} }
  const adapter = {
    enabled: options.enabled === undefined ? false : options.enabled,
    layout: options.layout || 'mobile',
    state: { sessionId: () => 's1', entries: () => options.entries || entries },
    fetchJson: async (requestPath, query) => { calls.push({ path: requestPath, query: { ...query } }); return resolve(requestPath, query) },
    onOpenFile: payload => opened.push(payload),
  }
  if (root) adapter.dom = { root }
  return {
    adapter, calls, opened, root,
    setResolve(next) { resolve = next },
  }
}

test('本地开关默认关闭：只有显式 true 才开启', () => {
  assert.equal(diff.normalizeEnabled(undefined), false)
  assert.equal(diff.normalizeEnabled(null), false)
  assert.equal(diff.normalizeEnabled(false), false)
  assert.equal(diff.normalizeEnabled('false'), false)
  assert.equal(diff.normalizeEnabled(0), false)
  assert.equal(diff.normalizeEnabled(true), true)
  assert.equal(diff.normalizeEnabled('true'), true)
})

test('默认关闭时不请求任何主机接口、不生成卡片、也不消费事件', async () => {
  const h = host({ entries })
  const controller = diff.create(h.adapter)
  assert.equal(controller.isEnabled(), false)
  const view = await controller.refresh()
  assert.equal(view.enabled, false)
  assert.equal(diff.viewHtml(view), '')
  assert.equal(h.root.innerHTML, '')
  assert.equal(controller.handleEvent('s1', { seq: 20, event: { type: 'workspace/changes', data: { turn: 2 } } }), false)
  controller.render()
  assert.equal(h.calls.length, 0, '关闭状态不得请求 summary 或 diff')
  assert.equal(h.root.innerHTML, '')
})

test('回合折叠：交付物与主机改动事件按回合归组，重复事件去重且保留最新改动记录', () => {
  const rows = diff.turnsFromEntries([
    ...entries,
    { seq: 12, event: { type: 'deliverables/presented', data: { turn: 1, callId: 'call-1', files: [{ path: 'C:/w/report.md', description: 'Final report' }] } } },
    { seq: 15, event: { type: 'workspace/changes', data: { turn: 1 } } },
    { seq: 16, event: { type: 'workspace/changes', data: { turn: 2 } } },
    { seq: 17, event: { type: 'deliverables/presented', data: { turn: 2, callId: 'call-2', files: [{ path: '' }] } } },
    { seq: 18, event: { type: 'tool/call', data: { name: 'write' } } },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].turn, 1)
  assert.equal(rows[0].deliveries.length, 1)
  assert.equal(rows[0].deliveries[0].path, 'C:/w/report.md')
  assert.deepEqual(rows[0].changes, { seq: 15 })
  assert.equal(rows[1].turn, 2)
  assert.equal(rows[1].deliveries.length, 0)
  assert.equal(rows[1].changes.seq, 16)
  assert.deepEqual(diff.presentedFiles({ turn: 1, callId: 'c', files: [{ path: 7 }] }).files, [])
  assert.equal(diff.presentedFiles({ turn: 0, callId: 'c', files: [] }), null)
})

test('主机 summary 归一化：逐文件计数、二进制与超大标记，状态不猜测', () => {
  const model = diff.summaryModel(summary)
  assert.equal(model.turn, 1)
  assert.equal(model.files.length, 3)
  assert.equal(model.total, 3)
  assert.equal(model.added, 2)
  assert.equal(model.deleted, 1)
  assert.equal(model.files[1].status, 'binary')
  assert.equal(model.files[2].status, 'oversized')
  assert.equal(diff.summaryModel({ files: 'no' }), null)
})

test('文件状态区分新增/修改/删除/二进制/超大，且只依据主机对比', () => {
  const file = { index: 0, path: 'C:/w/a.md', display: 'a.md', added: 1, deleted: 0 }
  assert.equal(diff.fileKind(file, null), 'changed')
  assert.equal(diff.fileKind(file, { status: 'ready', data: { kind: 'text', before: true, after: true } }), 'modified')
  assert.equal(diff.fileKind(file, { status: 'ready', data: { kind: 'text', before: false, after: true } }), 'added')
  assert.equal(diff.fileKind(file, { status: 'ready', data: { kind: 'text', before: true, after: false } }), 'deleted')
  assert.equal(diff.fileKind({ ...file, binary: true }, { status: 'ready', data: { kind: 'text' } }), 'binary')
  assert.equal(diff.fileKind({ ...file, oversized: true }, null), 'oversized')
  assert.equal(diff.kindLabel('added'), '新增')
  assert.equal(diff.kindLabel('deleted'), '删除')
})

test('hunk 拆分为统一视图与桌面并排视图', () => {
  const unified = diff.splitHunks(textDiff)
  assert.deepEqual(unified.map(row => row.kind), ['hunk', 'remove', 'add', 'add'])
  assert.equal(unified[1].oldNo, 1)
  assert.equal(unified[2].newNo, 1)
  assert.equal(unified[3].newNo, 2)
  const pairs = diff.sideBySideRows(textDiff)
  assert.deepEqual(pairs.map(row => row.kind), ['hunk', 'pair', 'pair'])
  assert.equal(pairs[1].old.text, 'old line')
  assert.equal(pairs[1].new.text, 'new line')
  assert.equal(pairs[2].old, null)
  assert.equal(pairs[2].new.text, 'extra line')
  assert.equal(diff.splitHunks({ hunks: 'bad' }).length, 0)
})

test('移动端统一视图、桌面并排视图；纯新增/删除保持单列', () => {
  const file = { display: 'a.md', added: 2, deleted: 1 }
  const state = { status: 'ready', data: textDiff }
  const mobile = diff.diffHtml(state, file, 'mobile')
  assert.match(mobile, /dr-diff-code--unified/)
  assert.match(mobile, /dr-diff-line--remove/)
  assert.match(mobile, /dr-diff-line--add/)
  assert.doesNotMatch(mobile, /dr-diff-code--split/)
  const desktop = diff.diffHtml(state, file, 'desktop')
  assert.match(desktop, /dr-diff-code--split/)
  assert.match(desktop, /dr-diff-cell--old/)
  assert.match(desktop, /dr-diff-cell--new/)
  const onlyAdd = { status: 'ready', data: { kind: 'text', before: false, after: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+only'] }] } }
  assert.match(diff.diffHtml(onlyAdd, file, 'desktop'), /dr-diff-code--unified/)
  assert.doesNotMatch(diff.diffHtml(onlyAdd, file, 'desktop'), /dr-diff-code--split/)
})

test('二进制/超大/主机无对比/不一致都有明确提示，绝不回退到当前文件', () => {
  const file = { display: 'a.md' }
  assert.match(diff.diffHtml({ status: 'binary' }, file, 'mobile'), /二进制文件，主机不提供逐行对比/)
  assert.match(diff.diffHtml({ status: 'oversized' }, file, 'mobile'), /超过主机单文件上限/)
  assert.match(diff.diffHtml({ status: 'missing' }, file, 'mobile'), /主机已不再提供该文件的对比/)
  assert.match(diff.diffHtml({ status: 'missing' }, file, 'mobile'), /当前文件冒充/)
  assert.match(diff.diffHtml({ status: 'mismatch' }, file, 'mobile'), /已拒绝显示/)
  assert.match(diff.diffHtml({ status: 'error' }, file, 'mobile'), /读取主机对比失败/)
  assert.doesNotMatch(diff.diffHtml({ status: 'missing' }, file, 'mobile'), /dr-diff-code/)
})

test('HTML 字段全部转义，恶意路径/描述不会注入', () => {
  const view = {
    enabled: true, layout: 'mobile',
    turns: [{
      turn: 1,
      deliveries: [{ index: 0, path: 'C:/w/"><img src=x>.md', name: '"><img src=x>.md', description: '<script>alert(1)</script>' }],
      changes: { seq: 1 },
      summary: { status: 'ready', model: diff.summaryModel({ turn: 1, files: [{ path: 'C:/w/<b>.md', display: '"><svg onload=1>', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 }) },
      expanded: true, selected: 0, diffs: {},
    }],
  }
  const html = diff.viewHtml(view)
  assert.doesNotMatch(html, /<img|<script|<svg|<b>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&lt;svg onload=1&gt;/)
})

test('开启后按回合读取主机 summary；关闭期间零请求，重复刷新走缓存', async () => {
  const h = host({ entries, enabled: true })
  const controller = diff.create(h.adapter)
  const view = await controller.refresh()
  assert.equal(view.enabled, true)
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0], { path: '/api/changes.summary', query: { sessionId: 's1', seq: 11 } })
  assert.equal(h.calls.filter(call => call.path === '/api/changes.diff').length, 0, '未展开时不请求 Diff')
  await controller.refresh()
  assert.equal(h.calls.length, 1, '同一回合的 summary 只请求一次')
  const html = h.root.innerHTML
  assert.match(html, /回合 1/)
  assert.match(html, /report\.md/)
  assert.match(html, /改动 3 个文件/)
  assert.match(html, /a\.md/)
  assert.match(html, /二进制|Binary/)
  assert.match(html, /超大|Too large/)
})

test('展开回合才请求 Diff，切换文件按 index 请求且同一文件复用缓存', async () => {
  const h = host({ entries, enabled: true })
  const controller = diff.create(h.adapter)
  await controller.refresh()
  await controller.toggleTurn(1)
  const diffs = () => h.calls.filter(call => call.path === '/api/changes.diff')
  assert.equal(diffs().length, 1)
  assert.deepEqual(diffs()[0].query, { sessionId: 's1', seq: 11, index: 0 })
  assert.match(h.root.innerHTML, /dr-diff-code--unified/)
  assert.match(h.root.innerHTML, /new line/)
  await controller.selectFile(1, 2)
  assert.equal(diffs().length, 1, '超大文件不应请求 Diff')
  assert.match(h.root.innerHTML, /超过主机单文件上限/)
  await controller.selectFile(1, 1)
  assert.equal(diffs().length, 1, '二进制文件不应请求 Diff')
  await controller.selectFile(1, 0)
  assert.equal(diffs().length, 1, '已缓存的文件不重复请求')
  const view = controller.view()
  assert.equal(view.turns[0].expanded, true)
  assert.equal(view.turns[0].selected, 0)
})

test('桌面布局渲染并排对比，手机布局保持统一视图', async () => {
  const desktopHost = host({ entries, enabled: true, layout: 'desktop' })
  const desktop = diff.create(desktopHost.adapter)
  await desktop.refresh()
  await desktop.toggleTurn(1)
  assert.match(desktopHost.root.innerHTML, /dr-diff-layout-desktop/)
  assert.match(desktopHost.root.innerHTML, /dr-diff-code--split/)
  const mobileHost = host({ entries, enabled: true, layout: 'mobile' })
  const mobile = diff.create(mobileHost.adapter)
  await mobile.refresh()
  await mobile.toggleTurn(1)
  assert.match(mobileHost.root.innerHTML, /dr-diff-layout-mobile/)
  assert.match(mobileHost.root.innerHTML, /dr-diff-code--unified/)
  mobile.setLayout('desktop')
  assert.match(mobileHost.root.innerHTML, /dr-diff-code--split/)
})

test('Host 重启后 summary/diff 不可用都有明确提示与重试，不显示伪造内容', async () => {
  const h = host({
    entries, enabled: true,
    resolve: async () => ({ ok: false, status: 404 }),
  })
  const controller = diff.create(h.adapter)
  const view = await controller.refresh()
  assert.equal(view.turns[0].summary.status, 'missing')
  assert.match(h.root.innerHTML, /主机已不再提供该回合改动/)
  assert.match(h.root.innerHTML, /重启后不保证存在/)
  assert.equal(h.calls.filter(call => call.path === '/api/changes.diff').length, 0)
  // 切换到可用主机后重试成功
  h.setResolve(async (requestPath, query) => requestPath === diff.SUMMARY_PATH ? { ok: true, status: 200, data: summary } : { ok: true, status: 200, data: textDiff })
  await controller.retrySummary(1)
  assert.equal(controller.view().turns[0].summary.status, 'ready')
  await controller.selectFile(1, 0)
  assert.match(h.root.innerHTML, /dr-diff-code/)
})

test('diff 404 提示主机不再提供且绝不使用当前文件内容冒充', async () => {
  const withCurrentContent = [
    ...entries,
    { seq: 12, event: { type: 'tool/result', data: { callId: 'x', result: { content: [{ type: 'text', text: 'CURRENT FILE CONTENT' }] } } } },
  ]
  const h = host({
    entries: withCurrentContent, enabled: true,
    resolve: async (requestPath) => requestPath === diff.SUMMARY_PATH
      ? { ok: true, status: 200, data: summary }
      : { ok: false, status: 404 },
  })
  const controller = diff.create(h.adapter)
  await controller.refresh()
  await controller.toggleTurn(1)
  assert.match(h.root.innerHTML, /主机已不再提供该文件的对比/)
  assert.doesNotMatch(h.root.innerHTML, /CURRENT FILE CONTENT/)
  assert.doesNotMatch(h.root.innerHTML, /dr-diff-code/)
})

test('主机返回的对比坐标与所选文件不一致时拒绝渲染', async () => {
  const h = host({
    entries, enabled: true,
    resolve: async (requestPath) => requestPath === diff.SUMMARY_PATH
      ? { ok: true, status: 200, data: summary }
      : { ok: true, status: 200, data: { ...textDiff, path: 'C:/w/other.md' } },
  })
  const controller = diff.create(h.adapter)
  await controller.refresh()
  await controller.toggleTurn(1)
  assert.match(h.root.innerHTML, /主机返回的对比与所选文件不一致/)
  assert.doesNotMatch(h.root.innerHTML, /new line/)
})

test('summary 读取失败提供重试，失败不被当成成功', async () => {
  let fail = true
  const h = host({
    entries, enabled: true,
    resolve: async (requestPath) => fail
      ? { ok: false, status: 500 }
      : (requestPath === diff.SUMMARY_PATH ? { ok: true, status: 200, data: summary } : { ok: true, status: 200, data: textDiff }),
  })
  const controller = diff.create(h.adapter)
  const first = await controller.refresh()
  assert.equal(first.turns[0].summary.status, 'error')
  assert.equal(first.turns[0].summary.model, undefined)
  assert.match(h.root.innerHTML, /读取主机改动失败/)
  assert.match(h.root.innerHTML, /data-dr-diff-action="retry-summary"/)
  fail = false
  await controller.retrySummary(1)
  assert.equal(controller.view().turns[0].summary.status, 'ready')
})

test('关闭开关后清空卡片并停止请求；交付物打开回调不影响原附件下载', async () => {
  const h = host({ entries, enabled: true })
  const controller = diff.create(h.adapter)
  await controller.refresh()
  await controller.toggleTurn(1)
  const before = h.calls.length
  controller.setEnabled(false)
  assert.equal(h.calls.length, before, '关闭后不得再发请求')
  assert.equal(h.root.innerHTML, '')
  assert.equal(diff.viewHtml(controller.view()), '')
  assert.equal(controller.handleEvent('s1', { seq: 30, event: { type: 'workspace/changes', data: { turn: 3 } } }), false)
  assert.equal(await controller.toggleTurn(1).then(result => result.ok), false)
  // 交付物卡片只调用显式回调，不自行下载或读取当前文件
  const callsBefore = h.calls.length
  assert.equal(controller.openDelivery(1, 0), true)
  assert.equal(h.opened.length, 1)
  assert.equal(h.opened[0].path, 'C:/w/report.md')
  assert.equal(h.calls.length, callsBefore)
})

test('绑定点击回合展开/文件切换都会经控制器请求主机对比', async () => {
  const h = host({ entries, enabled: true })
  const handlers = {}
  h.root.addEventListener = (name, fn) => { handlers[name] = fn }
  const controller = diff.create(h.adapter)
  // 开关开启时创建即渲染卡片（不自动请求，等 lead 调 refresh）。
  assert.match(h.root.innerHTML, /回合 1/)
  assert.equal(h.calls.length, 0)
  await controller.refresh()
  const click = action => handlers.click({
    target: { closest: selector => selector === '[data-dr-diff-action]' ? { dataset: action, disabled: false } : null },
  })
  click({ drDiffAction: 'toggle', drDiffTurn: '1' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.calls.filter(call => call.path === '/api/changes.diff').length, 1)
  click({ drDiffAction: 'file', drDiffTurn: '1', drDiffFile: '1' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.calls.filter(call => call.path === '/api/changes.diff').length, 1, '二进制文件不请求对比')
  assert.match(h.root.innerHTML, /二进制文件，主机不提供逐行对比/)
  click({ drDiffAction: 'delivery', drDiffTurn: '1', drDiffDelivery: '0' })
  assert.equal(h.opened.length, 1)
})

test('接线：setSession 首次同步读取主机 summary，同一会话重复渲染不重复请求', async () => {
  const h = host({ entries, enabled: true })
  const controller = diff.create(h.adapter)
  controller.setSession('s1')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.calls.length, 1, '历史就绪后第一次同步应读取主机改动')
  assert.equal(h.calls[0].path, '/api/changes.summary')
  controller.setSession('s1')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.calls.length, 1, '同一会话重复渲染不重复请求')
  controller.setEnabled(false)
  controller.setEnabled(true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.calls.length, 1, '重新开启复用已缓存的主机改动，不重复请求')
})

test('所有请求只走 changes.summary / changes.diff，模块不读取当前文件', async () => {
  const h = host({ entries, enabled: true })
  const controller = diff.create(h.adapter)
  await controller.refresh()
  await controller.toggleTurn(1)
  await controller.selectFile(1, 1)
  await controller.selectFile(1, 2)
  assert.ok(h.calls.length >= 2)
  for (const call of h.calls) assert.match(call.path, /^\/api\/changes\.(summary|diff)$/)
  assert.doesNotMatch(SOURCE, /\/api\/(files?|attachments?|fs)\b/)
  assert.doesNotMatch(SOURCE, /localStorage|sessionStorage|indexedDB/)
})
