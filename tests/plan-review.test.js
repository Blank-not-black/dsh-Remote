'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const plan = require('../public/plan-review.js')

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/plan-review.js'), 'utf8')

const question = (over = {}) => ({
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: '# Ship the plan\n\n- first step\n- second step',
  options: [
    { label: 'Approve', description: 'Leave plan mode and start implementing.' },
    { label: 'Keep planning', description: 'Send feedback back to the model.' },
  ],
  intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-1' },
  ...over,
})
const frame = (rpcId = 'rpc-1', over = {}) => ({
  rpcId,
  payload: { type: 'question/requested', sessionId: 's1', questions: [question(over)] },
})

function host(options = {}) {
  let current = {
    plan: options.plan ?? { active: false, pending: false },
    questions: options.questions ?? [],
    connected: options.connected ?? true,
    readOnly: options.readOnly ?? false,
    capability: options.capability === undefined ? { plan: true } : options.capability,
  }
  let commandResult = options.commandResult === undefined ? { executed: true } : options.commandResult
  let respondResult = options.respondResult === undefined ? true : options.respondResult
  const calls = { command: [], respond: [] }
  const adapter = {
    state: {
      sessionId: () => 's1',
      snapshot: () => current,
      entries: () => options.entries || [],
    },
    command: async (line, opts) => { calls.command.push({ line, opts }); return commandResult },
    respond: async (rpcId, value) => { calls.respond.push({ rpcId, value }); return respondResult },
  }
  return {
    adapter, calls,
    set(next) { current = { ...current, ...next } },
    setCommandResult(next) { commandResult = next },
    setRespondResult(next) { respondResult = next },
  }
}

test('plan 投影是唯一来源：非法值视为不支持，pending 表示目标状态', () => {
  assert.deepEqual(plan.normalizePlan(undefined), { supported: false, active: false, pending: false, target: null })
  assert.deepEqual(plan.normalizePlan({ active: true }), { supported: true, active: true, pending: false, target: true })
  assert.deepEqual(plan.normalizePlan({ active: false, pending: true }), { supported: true, active: false, pending: true, target: true })
  assert.deepEqual(plan.normalizePlan({ active: true, pending: true }), { supported: true, active: true, pending: true, target: false })
})

test('Plan 状态机：开启/退出中、能力缺失、只读和断线各自明确', () => {
  const supported = { capability: { plan: true } }
  const inactive = plan.describePlan({ ...supported, plan: { active: false, pending: false } })
  assert.equal(inactive.status, 'inactive')
  assert.deepEqual(inactive.action, { kind: 'enter', label: '进入计划模式', disabled: false })
  const active = plan.describePlan({ ...supported, plan: { active: true, pending: false } })
  assert.equal(active.status, 'active')
  assert.equal(active.action.kind, 'exit')
  const entering = plan.describePlan({ ...supported, plan: { active: false, pending: true } })
  assert.equal(entering.status, 'entering')
  assert.equal(entering.action.disabled, true)
  const leaving = plan.describePlan({ ...supported, plan: { active: true, pending: true } })
  assert.equal(leaving.status, 'leaving')
  assert.equal(leaving.action.disabled, true)
  const unsupported = plan.describePlan({ capability: false })
  assert.equal(unsupported.status, 'unsupported')
  assert.equal(unsupported.action, null)
  assert.match(unsupported.hint, /旧版主机|plan-mode/)
  const missingProjection = plan.describePlan({ capability: true })
  assert.equal(missingProjection.status, 'unavailable')
  assert.equal(missingProjection.action, null)
  const readOnly = plan.describePlan({ ...supported, readOnly: true, plan: { active: false, pending: false } })
  assert.equal(readOnly.status, 'readonly')
  assert.equal(readOnly.action, null)
  const disconnected = plan.describePlan({ ...supported, connected: false, plan: { active: true, pending: false } })
  assert.equal(disconnected.status, 'disconnected')
  assert.match(disconnected.hint, /连接|Reconnect/)
})

test('断线且没有 Plan 时不显示 Plan 卡片', () => {
  const supported = { capability: { plan: true } }
  const idle = plan.describePlan({ ...supported, connected: false, plan: { active: false, pending: false } })
  assert.equal(idle.status, 'disconnected')
  assert.equal(idle.exists, false)
  assert.equal(plan.statusHtml({ plan: idle, review: null }), '')
  assert.equal(plan.hasContent({ plan: idle, review: null, plans: [] }), false)
  assert.equal(plan.hasContent({ plan: idle, review: null, plans: [{ title: '旧计划' }] }), true)
  assert.equal(plan.hasContent({ plan: idle, review: { rpcId: 'rpc-1' }, plans: [] }), true)
  const known = plan.describePlan({ ...supported, connected: false, plan: { active: true, pending: false } })
  assert.equal(known.exists, true)
  assert.equal(plan.hasContent({ plan: known, review: null, plans: [] }), true)
  assert.match(plan.statusHtml({ plan: known, review: null }), /dr-plan-status--disconnected/)
  const connected = plan.describePlan({ ...supported, plan: { active: false, pending: false } })
  assert.equal(connected.exists, false)
  assert.equal(plan.hasContent({ plan: connected, review: null, plans: [] }), true)
  assert.equal(plan.hasContent({ plan: plan.describePlan({ capability: false }), review: null, plans: [] }), true)
  assert.equal(plan.hasContent({}), false)
})

test('计划审阅只认主机 intent；正文、批准与继续选项都来自主机', () => {
  const review = plan.planReviewOf(question())
  assert.equal(review.title, 'Ship the plan')
  assert.equal(review.planText, '# Ship the plan\n\n- first step\n- second step')
  assert.equal(review.approveLabel, 'Approve')
  assert.equal(review.keepLabel, 'Keep planning')
  assert.equal(review.questionId, 'plan-review')
  assert.equal(review.callId, 'call-1')
  assert.equal(plan.planReviewOf({ id: 'q', question: 'plain' }), null)
  assert.equal(plan.planReviewOf({ id: 'q', intent: { kind: 'approval', approve: 'Yes' }, options: [] }), null)
  const noLabels = plan.planReviewOf(question({ options: [], intent: { kind: 'plan-review' }, detail: '' }))
  assert.equal(noLabels.approveLabel, '')
  assert.equal(noLabels.keepLabel, '')
  assert.equal(noLabels.hasPlan, false)
})

test('从 question/requested 帧提取待审阅请求，普通提问不误判', () => {
  const extracted = plan.reviewFromFrame(frame('rpc-9'))
  assert.equal(extracted.rpcId, 'rpc-9')
  assert.equal(extracted.sessionId, 's1')
  assert.equal(extracted.approveLabel, 'Approve')
  assert.equal(plan.reviewFromFrame({ rpcId: 'r', payload: { type: 'question/requested', sessionId: 's1', questions: [{ id: 'q', question: 'x', options: [{ label: 'A' }] }] } }), null)
  assert.equal(plan.reviewFromFrame({ rpcId: 'r', payload: { type: 'approval/requested' } }), null)
})

test('兼容既有接线：planReviewOf 接受 questions 数组或帧对象', () => {
  assert.equal(plan.planReviewOf([{ id: 'q', question: 'plain', options: [] }]), null)
  const fromArray = plan.planReviewOf([{ id: 'q', question: 'plain', options: [] }, question()])
  assert.equal(fromArray.approveLabel, 'Approve')
  const fromFrame = plan.planReviewOf({ rpcId: 'rpc-1', type: 'question/requested', questions: [question()] })
  assert.equal(fromFrame.title, 'Ship the plan')
  // 客户端用 isPlanReviewQuestion(frame) 过滤普通提问：普通提问必须返回 null。
  assert.equal(plan.planReviewOf({ questions: [{ id: 'q', question: 'plain', options: [{ label: 'A' }] }] }), null)
})

test('状态/审阅/历史 HTML 转义不可信内容且不伪造批准选项', () => {
  const hostile = plan.describePlan({ capability: false })
  const status = plan.statusHtml({ plan: hostile, review: null })
  assert.match(status, /dr-plan-status--unsupported/)
  const dangerous = plan.planReviewOf(question({
    detail: '# <img src=x onerror=alert(1)>\n\nbody',
    header: '"><script>alert(1)</script>',
    options: [{ label: '<b>Approve</b>' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: '<b>Approve</b>' },
  }))
  const html = plan.reviewHtml({ review: dangerous, busy: '', plan: plan.describePlan({ capability: true, plan: { active: true, pending: false } }) })
  assert.doesNotMatch(html, /<img|<script|<b>/)
  assert.match(html, /&lt;img/)
  assert.match(html, /data-dr-plan-action="approve"/)
  // 主机没有命名批准选项时，绝不猜测一个“同意”。
  const noApprove = plan.planReviewOf(question({ options: [{ label: 'Keep planning' }], intent: { kind: 'plan-review' } }))
  const noApproveHtml = plan.reviewHtml({ review: noApprove, busy: '', plan: plan.describePlan({ capability: true, plan: { active: true, pending: false } }) })
  assert.doesNotMatch(noApproveHtml, /data-dr-plan-action="approve"/)
  assert.match(noApproveHtml, /不能猜测审批结果/)
  // 断线/只读时按钮禁用，但不隐藏主机选项。
  const disconnected = { ...dangerous, rpcId: 'rpc-1', sessionId: 's1' }
  const readOnlyHtml = plan.reviewHtml({ review: disconnected, busy: '', plan: plan.describePlan({ capability: true, readOnly: true, plan: { active: true, pending: false } }) })
  assert.match(readOnlyHtml, /data-dr-plan-action="approve"[^>]*disabled/)
  assert.match(readOnlyHtml, /只读会话不能提交审批/)
  assert.match(html, /主机选项/)
})

test('历史计划只读：结果可读、无审批按钮、绝不冒充当前待审阅', () => {
  const entries = [
    { seq: 1, event: { type: 'tool/call', data: { name: 'exit_plan_mode', callId: 'c1', turn: 1, arguments: JSON.stringify({ plan: '# First plan\n\nBody one' }) } } },
    { seq: 2, event: { type: 'tool/result', data: { callId: 'c1', result: { content: [{ type: 'text', text: 'Plan approved — plan mode exited' }] } } } },
    { seq: 3, event: { type: 'tool/call', data: { name: 'exit_plan_mode', callId: 'c2', turn: 2, arguments: JSON.stringify({ plan: '# Second plan\n\nBody two' }) } } },
    { seq: 4, event: { type: 'tool/result', data: { callId: 'c2', error: true, result: 'Error: The user chose to keep planning; revise the plan' } } },
    { seq: 5, event: { type: 'tool/call', data: { name: 'write', callId: 'c3', arguments: '{"plan":"no"}' } } },
  ]
  const plans = plan.historyPlans(entries)
  assert.equal(plans.length, 2)
  assert.equal(plans[0].title, 'Second plan')
  assert.equal(plans[0].outcome, 'failed')
  assert.equal(plans[1].outcome, 'approved')
  assert.equal(plans.every(row => row.readOnly === true), true)
  const html = plan.historyHtml(plans)
  assert.match(html, /历史计划（只读）/)
  assert.match(html, /已批准/)
  assert.doesNotMatch(html, /data-dr-plan-action="approve"/)
  assert.doesNotMatch(html, /data-dr-plan-action="keep"/)
})

test('进入/退出只走主机 /plan 命令，主机状态不被客户端乐观改写', async () => {
  const fake = host()
  const controller = plan.create(fake.adapter)
  assert.equal(controller.view().plan.status, 'inactive')
  const entered = await controller.enter()
  assert.deepEqual(entered, { ok: true })
  assert.deepEqual(fake.calls.command, [{ line: '/plan', opts: { sessionId: 's1' } }])
  assert.equal(fake.calls.respond.length, 0)
  // Host still reports inactive: the client must not pretend it entered.
  assert.equal(controller.view().plan.status, 'inactive')
  await controller.exit()
  assert.deepEqual(fake.calls.command[1], { line: '/plan off', opts: { sessionId: 's1' } })
  // Host projection settles later.
  fake.set({ plan: { active: true, pending: false } })
  controller.handleFrame({ payload: { type: 'session/projection', sessionId: 's1', key: 'plan', value: { active: true, pending: false } } })
  assert.equal(controller.view().plan.status, 'active')
})

test('主机拒绝命令时明确报错，不显示成功也不改本地状态', async () => {
  const fake = host({ commandResult: { executed: false, message: 'command-not-executed' } })
  const controller = plan.create(fake.adapter)
  const result = await controller.enter()
  assert.equal(result.ok, false)
  assert.match(result.error, /command-not-executed/)
  assert.match(controller.view().notice.text, /command-not-executed/)
  assert.equal(controller.view().plan.status, 'inactive')
  fake.setCommandResult({ executed: true })
  fake.adapter.command = async () => { throw new Error('bridge down') }
  const failed = await controller.exit()
  assert.equal(failed.ok, false)
  assert.match(failed.error, /bridge down/)
})

test('批准使用主机 rpcId 与主机批准标签，成功后同一请求不会被再次审批', async () => {
  const fake = host({ questions: [{ rpcId: 'rpc-7', sessionId: 's1', questions: [question()] }] })
  const controller = plan.create(fake.adapter)
  const result = await controller.approve()
  assert.equal(result.ok, true)
  assert.equal(fake.calls.respond.length, 1)
  assert.deepEqual(fake.calls.respond[0], {
    rpcId: 'rpc-7',
    value: { sessionId: 's1', answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] } },
  })
  assert.equal(controller.view().review, null)
  const again = await controller.approve()
  assert.equal(again.ok, false)
  assert.equal(fake.calls.respond.length, 1, '同一待审阅请求不能重复提交')
  assert.doesNotMatch(JSON.stringify(fake.calls), /session\.prompt|steer/)
})

test('继续完善计划使用主机“保留”选项并携带反馈，而不是普通聊天消息', async () => {
  const fake = host({ questions: [{ rpcId: 'rpc-8', sessionId: 's1', questions: [question()] }] })
  const controller = plan.create(fake.adapter)
  const result = await controller.keep('please add rollback steps')
  assert.equal(result.ok, true)
  assert.equal(fake.calls.respond.length, 1)
  const value = fake.calls.respond[0].value
  assert.deepEqual(value.answer.answers[0], { id: 'plan-review', selected: ['Keep planning'], custom: 'please add rollback steps' })
})

test('另一端已处理时不再重复审批：resolved 帧关闭请求并给出反馈', async () => {
  const fake = host()
  const controller = plan.create(fake.adapter)
  assert.equal(controller.handleFrame(frame('rpc-5')), true)
  assert.ok(controller.view().review)
  assert.equal(controller.handleFrame({ rpcId: 'rpc-5', payload: { type: 'question/resolved', sessionId: 's1', questionRpcId: 'rpc-5' } }), true)
  assert.equal(controller.view().review, null)
  assert.match(controller.view().notice.text, /其他终端/)
  const result = await controller.approve()
  assert.equal(result.ok, false)
  assert.equal(fake.calls.respond.length, 0, '已由其他终端处理，不能再提交')
})

test('刷新后只有主机投影里的待审阅请求才有按钮；已结束时返回明确错误', async () => {
  const fake = host({ questions: [{ rpcId: 'rpc-6', sessionId: 's1', questions: [question()] }] })
  const controller = plan.create(fake.adapter)
  assert.ok(controller.view().review)
  fake.set({ questions: [] })
  controller.handleFrame({ rpcId: 'rpc-6', payload: { type: 'question/resolved', sessionId: 's1', questionRpcId: 'rpc-6' } })
  assert.equal(controller.view().review, null)
  assert.equal((await controller.approve()).ok, false)
  assert.equal(fake.calls.respond.length, 0)
})

test('不支持/只读/断线时 Plan 操作全部拒绝且不调用主机接口', async () => {
  for (const snapshot of [
    { capability: false },
    { capability: { plan: true }, readOnly: true, plan: { active: false, pending: false } },
    { capability: { plan: true }, connected: false, plan: { active: true, pending: false } },
  ]) {
    const fake = host(snapshot)
    const controller = plan.create(fake.adapter)
    const enter = await controller.enter()
    assert.equal(enter.ok, false)
    const approved = await controller.approve()
    assert.equal(approved.ok, false)
    assert.equal(fake.calls.command.length, 0)
    assert.equal(fake.calls.respond.length, 0)
  }
})

test('控制器把历史计划渲染为只读，且没有待审阅请求时批准不会发请求', async () => {
  const entries = [{ seq: 1, event: { type: 'tool/call', data: { name: 'exit_plan_mode', callId: 'c1', arguments: '{"plan":"# Historical plan"}' } } }]
  const fake = host({ entries })
  const controller = plan.create(fake.adapter)
  const view = controller.view()
  assert.equal(view.plans.length, 1)
  assert.equal(view.review, null)
  assert.match(plan.viewHtml(view), /历史计划（只读）/)
  assert.doesNotMatch(plan.viewHtml(view), /data-dr-plan-action="approve"/)
  const result = await controller.approve()
  assert.equal(result.ok, false)
  assert.equal(fake.calls.respond.length, 0)
})

test('事件订阅只消费计划相关帧，绑定按钮触发主机命令', async () => {
  const fake = host()
  const root = {
    innerHTML: '',
    dataset: {},
    addEventListener(name, fn) { this.handler = fn },
    removeEventListener() {},
  }
  fake.adapter.dom = { root }
  const controller = plan.create(fake.adapter)
  assert.match(root.innerHTML, /data-dr-plan-action="enter"/)
  assert.equal(controller.handleFrame({ payload: { type: 'session/projection', sessionId: 's1', key: 'title', value: 'x' } }), false)
  assert.equal(controller.handleEvent('s1', { type: 'approval/asked', seq: 3, data: {} }), false)
  const button = { dataset: { drPlanAction: 'enter' }, disabled: false, closest: () => null }
  root.handler({ target: { closest: () => button } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(fake.calls.command.length, 1)
  assert.equal(fake.calls.command[0].line, '/plan')
})

test('静态约束：模块不包含聊天消息兜底或本地第二套 Plan 状态', () => {
  assert.doesNotMatch(SOURCE, /session\.prompt/)
  assert.doesNotMatch(SOURCE, /agent\.steer|session\.steer|submitPrompt/)
  assert.doesNotMatch(SOURCE, /localStorage|sessionStorage|indexedDB/)
  assert.match(SOURCE, /api\/respond|respond\(/)
})
