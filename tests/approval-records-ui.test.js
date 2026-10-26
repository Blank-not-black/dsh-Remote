'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/approval-records.js'), 'utf8')
const t = key => key

function load() {
  const context = vm.createContext({ window: {}, Date, JSON })
  vm.runInContext(SOURCE, context)
  return context.window.DshApprovalRecords
}

const asked = (id, extra = {}) => ({
  type: 'approval/asked', seq: 100, time: 1_790_000_000_000,
  data: { id, toolName: 'pwsh', callId: 'call-1', reason: 'escalate sandbox to danger-full-access: 需要在 dist 目录内渲染成片', ...extra },
})
const decided = (id, outcome, seq = 101, time = 1_790_000_001_000) => ({ type: 'approval/decided', seq, time, data: { id, outcome } })

test('审计事件合成一条记录：审批内容、结果与升权目标都可读', () => {
  const api = load()
  const records = api.create()
  assert.equal(api.fromEvent(records, 'session-1', asked('a1')), true)
  let record = records.get('a1')
  assert.equal(record.kind, 'escalation')
  assert.equal(record.toolName, 'pwsh')
  assert.equal(record.outcome, 'pending')
  assert.equal(api.isPending(record), true)
  const summary = api.summary(record)
  assert.equal(summary.kind, 'escalation')
  assert.equal(summary.target, 'danger-full-access')
  assert.equal(summary.text, '需要在 dist 目录内渲染成片')
  assert.equal(api.fromEvent(records, 'session-1', decided('a1', 'allowed-once')), true)
  record = records.get('a1')
  assert.equal(record.outcome, 'allowed-once')
  assert.equal(api.isPending(record), false)
  assert.equal(api.outcomeKey('allowed-once'), 'approval.outcomeAllowed')
  const html = api.recordHtml(record, t, { session: '会话一' })
  assert.ok(html.includes('approval.outcomeAllowed'))
  assert.ok(html.includes('approval.kindEscalation'))
  assert.ok(html.includes('需要在 dist 目录内渲染成片'))
  assert.ok(html.includes('approval.whyAllowed'))
  assert.ok(html.includes('会话一'))
  assert.equal(api.fromEvent(records, 'session-1', decided('missing', 'rejected')), true)
  assert.equal(api.list(records).some(record => record.id === 'missing'), false, 'decisions without details wait for the application')
})

test('Auto review 拒绝后转人工的审批可识别出来并保留审查理由', () => {
  const api = load()
  const records = api.create()
  api.fromEvent(records, 'session-1', asked('a2', {
    reason: 'Auto review denied tool "pwsh": 该命令会删除工作区外文件',
  }))
  const record = records.get('a2')
  assert.equal(record.kind, 'auto')
  assert.equal(api.summary(record).kind, 'auto')
  assert.equal(api.summary(record).text, '该命令会删除工作区外文件')
  const line = api.lineHtml(record, t)
  assert.ok(line.includes('approval.kindAuto'))
  assert.ok(line.includes('approval.outcomePending'))
  assert.ok(line.includes('approval.whyPending'))
  api.fromEvent(records, 'session-1', decided('a2', 'rejected'))
  assert.ok(api.lineHtml(records.get('a2'), t).includes('approval.whyRejected'))
})

test('中文机械翻译只改变展示，保留英文记录、命令、路径和 URL', () => {
  const api = load(), records = api.create()
  const raw = 'Auto review denied tool "pwsh": This command would delete files outside the workspace. The user has not authorized this action. `Remove-Item C:\\Delete\\files` https://example.com/delete/files'
  api.fromEvent(records, 's', asked('translate', { reason: raw }))
  const record = records.get('translate'), html = api.recordHtml(record, t)
  assert.ok(html.includes('此操作将删除工作区之外的文件'))
  assert.ok(html.includes('用户尚未明确授权此操作'))
  assert.ok(html.includes('查看原文'))
  assert.ok(html.includes('Remove-Item C:\\Delete\\files'))
  assert.ok(html.includes('https://example.com/delete/files'))
  assert.equal(record.reason, raw)
  assert.equal(api.restore(api.serialize(records)).get('translate').reason, raw)
  assert.match(api.displayReason(raw), /自动审查未通过，等待人工决定/)
  assert.ok(api.displayReason(raw).includes('原文：' + raw))
  assert.equal(api.chineseReference("The user hasn't authorized this action."), '用户尚未明确授权此操作.')
  assert.equal(api.chineseReference('Unexpected reviewer response: XYZ_12'), 'Unexpected reviewer response: XYZ_12')
})

test('工具结果中的自动审查失败可显示中文，但不变成拒绝记录；英文界面保留原始输出', () => {
  const context = vm.createContext({ window: { I18N: { lang: 'zh' } }, Date, JSON })
  vm.runInContext(SOURCE, context)
  const api = context.window.DshApprovalRecords, records = api.create()
  const raw = 'Auto review of tool "bash" failed; its body was not executed: Review timed out'
  const result = { content: [{ type: 'text', text: raw }] }
  const html = api.feedbackHtml(result)
  assert.match(html, /自动审查失败，工具未执行/)
  assert.match(html, /审查请求超时/)
  assert.equal(api.fromEvent(records, 's', { type: 'tool/result', data: { message: result } }), false)
  assert.equal(records.size, 0)
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/activity.js'), 'utf8'), context)
  assert.match(context.window.DshActivity.tool({ name: 'bash', result, error: true }), /自动审查失败，工具未执行/)
  context.window.I18N.lang = 'en'
  assert.equal(api.feedbackHtml(result), '')
  assert.equal(api.displayReason(raw), raw)
  context.window.I18N.lang = 'zh'
  const malicious = 'Auto review denied tool "<img src=x>": This command would delete files <script>evil()</script>'
  assert.ok(!api.feedbackHtml(malicious).includes('<script>'))
  assert.ok(!api.feedbackHtml(malicious).includes('<img'))
  assert.equal(api.feedbackHtml('Ordinary tool output'), '')
})

test('自动审查最终拒绝单独成记录，并从工具结果错误里取理由', () => {
  const api = load()
  const records = api.create()
  const result = {
    type: 'tool/result', seq: 200, time: 1_790_000_002_000,
    data: {
      callId: 'call-9',
      message: {
        role: 'tool', toolCallId: 'call-9',
        content: [{ type: 'text', text: 'Auto review rejected tool "pwsh"; its body was not executed: 不可逆删除既有对象' }],
      },
    },
  }
  assert.equal(api.fromEvent(records, 'session-2', result), true)
  const record = [...records.values()][0]
  assert.equal(record.kind, 'auto-deny')
  assert.equal(record.toolName, 'pwsh')
  assert.equal(record.outcome, 'rejected')
  assert.equal(record.reason, '不可逆删除既有对象')
  assert.equal(api.fromEvent(records, 'session-2', result), false, '同一工具结果只记一次')
  const html = api.recordHtml(record, t)
  assert.ok(html.includes('approval.kindAutoDenied'))
  assert.ok(html.includes('approval.whyAutoDenied'))
})

test('ordinary tool results and reviewer failures never manufacture denial records or evict real approvals', () => {
  const api = load(), records = api.create()
  api.fromEvent(records, 's', asked('real'))
  for (const body of ['Build succeeded', '', 'failed to read file', 'Auto review of tool "bash" failed; its body was not executed: timeout']) {
    for (let i = 0; i < 50; i++) assert.equal(api.fromEvent(records, 's', {
      type: 'tool/result', seq: 200 + i, data: { callId: String(i), message: { content: [{ type: 'text', text: body }] } },
    }), false)
  }
  assert.equal(records.size, 1); assert.equal(records.get('real').outcome, 'pending')
})

test('decisions arriving before applications survive pagination, reload and live replay', () => {
  const api = load(), records = api.create()
  api.fromEvent(records, 's', decided('paged', 'allowed-once', 200))
  assert.equal(api.list(records).length, 0)
  const restored = api.restore(api.serialize(records))
  api.fromEvent(restored, 's', asked('paged'))
  assert.equal(restored.get('paged').outcome, 'allowed-once')
  api.fromEvent(restored, 's', decided('paged', 'rejected', 150))
  assert.equal(restored.get('paged').outcome, 'allowed-once')
  api.fromFrame(restored, { type: 'approval/resolved', approvalId: 'live', sessionId: 's', outcome: 'rejected' })
  api.fromFrame(restored, { type: 'approval/requested', approvalId: 'live', sessionId: 's', toolName: 'bash' })
  assert.equal(restored.get('live').outcome, 'rejected')
  assert.equal(api.list(restored).length, 2)
  const when = restored.get('live').askedAt
  api.fromFrame(restored, { type: 'approval/requested', approvalId: 'live', sessionId: 's', toolName: 'bash' })
  assert.equal(restored.get('live').askedAt, when)
})

test('实时审批帧先记待处理，再按结果结算；未知帧不产生记录', () => {
  const api = load()
  const records = api.create()
  assert.equal(api.fromFrame(records, { type: 'approval/requested', approvalId: 'live-1', sessionId: 's', toolName: 'bash', reason: '需要写入工作区外目录' }), true)
  assert.equal(records.get('live-1').outcome, 'pending')
  assert.equal(records.get('live-1').kind, 'request')
  assert.equal(api.fromFrame(records, { type: 'approval/resolved', approvalId: 'other', outcome: 'allowed-once' }), true)
  assert.equal(api.fromFrame(records, { type: 'approval/resolved', approvalId: 'live-1', outcome: 'allowed-once' }), true)
  assert.equal(records.get('live-1').outcome, 'allowed-once')
  assert.equal(api.fromFrame(records, { type: 'unrelated' }), false)
  assert.equal(api.fromFrame(records, null), false)
})

test('记录有界、按时间倒序，可持久化往返且容忍损坏数据', () => {
  const api = load()
  const records = api.create()
  for (let i = 0; i < api.MAX + 5; i += 1) {
    const event = { ...asked('id-' + i, { reason: '普通审批 ' + i }), time: 1_790_000_000_000 + i }
    api.fromEvent(records, 's', event)
  }
  assert.equal(records.size, api.MAX)
  const rows = api.list(records, 3)
  assert.equal(rows.length, 3)
  assert.deepEqual([...rows.map(row => row.id)], ['id-44', 'id-43', 'id-42'])
  const payload = api.serialize(records)
  const restored = api.restore(payload)
  assert.equal(restored.size, api.MAX)
  assert.equal(restored.get('id-44').reason, '普通审批 44')
  assert.equal(api.restore('{not json').size, 0)
  assert.equal(api.restore('[null,5,{"id":""},{"id":42}]').size, 0)
  assert.equal(api.restore('[{"id":"kept","outcome":5}]').size, 1)
  assert.equal(api.restore(api.serialize(api.create())).size, 0)
})

test('渲染转义主机文本，相对时间不依赖客户端格式', () => {
  const api = load()
  const records = api.create()
  api.fromEvent(records, 's', asked('x1', { toolName: '<img src=x onerror=alert(1)>' }))
  const record = records.get('x1')
  const html = api.recordHtml(record, t)
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img'))
  assert.equal(api.relTime(Date.now(), t, Date.now()), 'approval.justNow')
  assert.equal(api.relTime(Date.now() - 120_000, t, Date.now()), 'approval.minutesAgo')
  assert.equal(api.relTime(Date.now() - 7_200_000, t, Date.now()), 'approval.hoursAgo')
  assert.match(api.relTime(Date.parse('2026-01-02T03:04:05'), t, Date.now()), /^2026-01-02 03:04$/)
})

test('两个会话重复 callId 的自动拒绝不互相覆盖，长 ID 持久化仍能回读', () => {
  const api = load(), records = api.create()
  for (const sessionId of ['s'.repeat(120), 'other-session']) api.fromEvent(records, sessionId, {
    type: 'tool/result', seq: 100, time: Date.now(), data: { callId: 'c'.repeat(120), message: { content: [{ type: 'text', text: 'Auto review rejected tool "bash"; its body was not executed' }] } },
  })
  assert.equal(records.size, 2)
  const restored = api.restore(api.serialize(records))
  assert.deepEqual([...restored.keys()], [...records.keys()])
})

for (const file of ['public/app.js', 'public/desktop/desktop.js']) test(file + ': 换主机保存旧主机快照，清除全部数据取消延迟写回', () => {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const start = source.indexOf("const APPROVAL_RECORDS_KEY ="), end = source.indexOf('function collectApprovalEvent', start)
  const timers = new Map(), store = {}, api = load()
  let nextTimer = 0
  const state = { server: 'old-host', approvalRecords: new Map(), approvalRecordsServer: '' }
  const context = vm.createContext({ state, Map, window: { DshApprovalRecords: api }, LS: { get: (key, fallback) => store[key] || fallback, set: (key, value) => { store[key] = value } },
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id }, clearTimeout: id => timers.delete(id) })
  vm.runInContext(source.slice(start, end), context)
  context.ensureApprovalRecords()
  api.fromEvent(state.approvalRecords, 's', asked('old-record'))
  context.saveApprovalRecords()
  state.server = 'new-host'
  context.ensureApprovalRecords()
  assert.equal(api.restore(store['dshApprovalRecordsV1:old-host']).size, 1)
  assert.equal(state.approvalRecords.size, 0)
  api.fromEvent(state.approvalRecords, 's', asked('new-record'))
  context.saveApprovalRecords()
  const storage = Object.assign(store, { unrelated: 'keep', 'dshApprovalRecordsV1:another-host': '[]' })
  Object.defineProperty(storage, 'removeItem', { value: key => delete storage[key] })
  const workflow = { clearApprovalRecords: context.resetApprovalRecords }
  const root = { I18N: { lang: 'zh' } }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/workflow.js'), 'utf8').replace('root.DshWorkflow={', 'config=window.testConfig;root.DshWorkflow={'), {
    window: Object.assign(root, { testConfig: workflow }), localStorage: storage, sessionStorage: { removeItem() {} },
  })
  root.DshWorkflow.clearStorage()
  for (const fn of timers.values()) fn()
  assert.deepEqual(Object.keys(storage), ['unrelated'])
  assert.equal(timers.size, 0)
  assert.equal(state.approvalRecords.size, 0)
})

test('手机端与桌面端都把审批记录接入历史、实时帧与总览', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  const desktopHtml = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.html'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.js'), 'utf8')
  for (const [name, source] of [['app.js', app], ['desktop.js', desktop]]) {
    assert.ok(source.includes('window.DshApprovalRecords'), name)
    assert.ok(source.includes('collectApprovalEvent('), name)
    assert.ok(source.includes('collectApprovalFrame('), name)
    assert.ok(source.includes('lineHtml('), name)
    assert.ok(source.includes("APPROVAL_RECORDS_KEY = 'dshApprovalRecordsV1:'"), name)
    assert.ok(source.includes('approvalRecords: new Map()'), name)
  }
  assert.ok(html.indexOf('<script src="approval-records.js"></script>') < html.indexOf('<script src="app.js"></script>'))
  assert.ok(html.includes('id="approval-records-list"'))
  assert.ok(html.includes("'approval.recordsTitle'"))
  assert.ok(desktopHtml.indexOf('<script src="../approval-records.js"></script>') < desktopHtml.indexOf('<script src="desktop.js"></script>'))
  assert.ok(desktopHtml.includes('id="ds-approval-records-list"'))
  assert.ok(desktopHtml.includes("'approval.recordsTitle'"))
  assert.ok(app.includes('if(collectApprovalEvent(id,ev))approvalChanged=true'))
  assert.ok(app.includes('if (approvalChanged) renderApprovalRecords()'))
  assert.ok(desktop.includes('if(collectApprovalEvent(id,ev))approvalChanged=true'))
  assert.ok(desktop.includes('if (collectApprovalEvent(sessionId, event)) renderApprovalRecordsDesktop()'))
})
