'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createRealisticStack, TEST_PNG_BASE64 } = require('./fixtures/realistic-stack.cjs')

function auth(token, extra = {}) {
  return { authorization: `Bearer ${token}`, 'x-dsh-remote-client': 'app', ...extra }
}

async function rpc(stack, method, payload = {}) {
  const res = await fetch(`${stack.base}/api/${method}`, {
    method: 'POST',
    headers: auth(stack.token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  assert.equal(res.status, 200, `${method} HTTP ${res.status}`)
  const body = await res.json()
  assert.equal(body.result?.ok, true, `${method}: ${JSON.stringify(body)}`)
  return body.result.value
}

async function waitFor(check, timeoutMs, failure) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (err) { last = err }
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`${failure}${last ? `: ${last.message}` : ''}`)
}

async function connectClient(stack, kind = 'mux') {
  const ticketRes = await fetch(`${stack.base}/api/ws-ticket`, { method: 'POST', headers: auth(stack.token) })
  assert.equal(ticketRes.status, 200)
  const { ticket } = await ticketRes.json()
  const ws = new WebSocket(`${stack.base.replace(/^http/, 'ws')}/api/events.${kind}?ticket=${encodeURIComponent(ticket)}&client=app&clientId=user-flow-phone`)
  const frames = []
  ws.addEventListener('message', event => {
    try { frames.push(JSON.parse(String(event.data))) } catch {}
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 3000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket open failed')) }, { once: true })
  })
  return {
    ws,
    frames,
    wait(predicate, label) {
      return waitFor(() => frames.find(predicate), 4000, label)
    },
    close() { try { ws.close() } catch {} },
  }
}

test('用户消息全链路：文本、图片附件、历史、实时回复、审批和提问响应', async (t) => {
  const stack = await createRealisticStack()
  const client = await connectClient(stack)
  t.after(async () => { client.close(); await stack.stop() })

  const listed = await rpc(stack, 'session.list')
  assert.equal(listed.items[0].sessionId, 'session-1')
  assert.equal(listed.items[0].projections.values.title, '真实功能测试会话')

  const history = await rpc(stack, 'session.history', { sessionId: 'session-1', maxMessages: 60 })
  assert.equal(history.events[0].event.data.content[0].text, '历史用户文本')
  assert.equal(history.events[1].event.data.content[0].text, '历史回复文本')
  assert.equal(history.events[1].event.data.content[1].type, 'image')
  assert.equal(history.events[1].event.data.content[1].data, TEST_PNG_BASE64)

  const textPayload = {
    sessionId: 'session-1', mode: 'queue',
    content: [{ type: 'text', text: '手机端发送文本：你好 DSH' }],
  }
  assert.equal((await rpc(stack, 'session.prompt', textPayload)).accepted, true)
  assert.deepEqual(stack.records.prompts.at(-1), textPayload)
  await client.wait(frame => frame.payload?.event?.data?.content?.[0]?.text === '已收到第 1 条消息', '未收到文本回复事件')

  const imagePayload = {
    sessionId: 'session-1', mode: 'queue',
    content: [
      { type: 'image', mediaType: 'image/png', data: TEST_PNG_BASE64, name: '测试图片.png' },
      { type: 'text', text: '请识别这张图片' },
    ],
  }
  assert.equal((await rpc(stack, 'session.prompt', imagePayload)).accepted, true)
  assert.deepEqual(stack.records.prompts.at(-1), imagePayload)
  assert.equal(Buffer.from(stack.records.prompts.at(-1).content[0].data, 'base64').subarray(1, 4).toString(), 'PNG')
  await client.wait(frame => frame.payload?.event?.data?.content?.[0]?.text === '已收到第 2 条消息', '未收到图片消息回复事件')

  stack.dsh.pushAssistant('DSH 主动推送的公网回传消息')
  await client.wait(frame => frame.payload?.event?.data?.content?.[0]?.text === 'DSH 主动推送的公网回传消息', '未收到 DSH 主动消息')

  stack.dsh.requestApproval()
  const approval = await client.wait(frame => frame.payload?.type === 'approval/requested', '未收到审批请求')
  let response = await fetch(`${stack.base}/api/respond`, {
    method: 'POST', headers: auth(stack.token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ type: 'client-response', rpcId: approval.rpcId, result: { ok: true, value: { sessionId: 'session-1', approvalId: 'approval-1', outcome: 'allowed-once' } } }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).accepted, true)

  stack.dsh.requestQuestion()
  const question = await client.wait(frame => frame.payload?.type === 'question/requested', '未收到用户提问请求')
  response = await fetch(`${stack.base}/api/respond`, {
    method: 'POST', headers: auth(stack.token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ type: 'client-response', rpcId: question.rpcId, result: { ok: true, value: { sessionId: 'session-1', answer: { answers: [{ id: 'choice', selected: ['继续'] }] } } } }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).accepted, true)
  assert.equal(stack.records.responses.length, 2)
  assert.equal(stack.records.responses[0].result.value.outcome, 'allowed-once')
  assert.deepEqual(stack.records.responses[1].result.value.answer.answers[0].selected, ['继续'])

  const polled = await fetch(`${stack.base}/api/events.poll?kind=mux&since=0`, { headers: auth(stack.token) })
  assert.equal(polled.status, 200)
  const events = await polled.json()
  assert.ok(events.events.some(record => record.event?.payload?.event?.data?.content?.[0]?.text === 'DSH 主动推送的公网回传消息'))
})

test('会话周边功能：创建/停止、模型、目标、子任务、工作台和归档 RPC 均可往返', async (t) => {
  const stack = await createRealisticStack()
  t.after(() => stack.stop())

  const created = await rpc(stack, 'session.create', { cwd: path.join(stack.tmpRoot, 'project-one') })
  assert.match(created.sessionId, /^session-created-/)
  assert.equal((await rpc(stack, 'session.cancel', { sessionId: 'session-1' })).accepted, true)
  const host = await rpc(stack, 'host.describe')
  assert.equal(host.models[0].id, 'deepseek-chat')
  assert.equal((await rpc(stack, 'session.selectModel', { sessionId: 'session-1', model: 'deepseek-chat', reasoningEffort: 'high' })).model, 'deepseek-chat')

  for (const method of ['goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear']) {
    assert.equal((await rpc(stack, method, { sessionId: 'session-1', ref: { id: 'goal-1', revision: 1 }, objective: '更新后的目标' })).accepted, true)
  }
  const subagents = await rpc(stack, 'subagent.list', { parentSessionId: 'session-1' })
  assert.equal(subagents.entries[0].id, 'child-1')
  assert.equal((await rpc(stack, 'subagent.interrupt', { parentSessionId: 'session-1', childSessionId: 'child-1', mode: 'continuable' })).accepted, true)

  let workspaces = await rpc(stack, 'workspace.list')
  assert.equal(workspaces.items[0].title, 'project-one')
  const workspace = await rpc(stack, 'workspace.create', { path: path.join(stack.tmpRoot, 'project-two') })
  assert.equal(workspace.workspace.title, 'project-two')
  assert.equal((await rpc(stack, 'workspace.archiveSession', { sessionId: 'session-1' })).archived, true)
  workspaces = await rpc(stack, 'workspace.list')
  assert.deepEqual(workspaces.archivedSessionIds, ['session-1'])
})

test('反馈与公开内容：校验、成功转发、隐私掩码、节流、公告和更新元数据', async (t) => {
  const stack = await createRealisticStack()
  t.after(() => stack.stop())

  let res = await fetch(`${stack.base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(res.status, 401)

  const invalidCases = [
    [{ type: 'invalid', message: 'x' }, 400, 'invalid type'],
    [{ type: 'bug', message: '' }, 400, 'message required'],
    [{ type: 'bug', message: 'x'.repeat(2001) }, 400, 'message too long'],
    [{ type: 'bug', message: 'x', contact: 'y'.repeat(201) }, 400, 'contact too long'],
  ]
  for (const [body, status, error] of invalidCases) {
    res = await fetch(`${stack.base}/feedback`, {
      method: 'POST', headers: auth(stack.token, { 'content-type': 'application/json' }), body: JSON.stringify(body),
    })
    assert.equal(res.status, status)
    assert.equal((await res.json()).error, error)
  }

  const marker = `TEST-user-flow-${Date.now()}`
  res = await fetch(`${stack.base}/feedback`, {
    method: 'POST', headers: auth(stack.token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ type: 'bug', message: marker, contact: '', appVersion: '0.6.10-rc.1' }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.equal(stack.records.feedback.length, 1)
  assert.equal(stack.records.feedback[0].message, marker)
  assert.equal(stack.records.feedback[0].appVersion, '0.6.10-rc.1')
  assert.equal(stack.records.feedback[0].contact, undefined)
  assert.equal(stack.records.feedback[0].clientIp, '127.0.0.x')

  res = await fetch(`${stack.base}/feedback`, {
    method: 'POST', headers: auth(stack.token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ type: 'suggestion', message: '第二次提交应被节流' }),
  })
  assert.equal(res.status, 429)
  assert.ok(Number(res.headers.get('retry-after')) > 0)

  const announcements = await fetch(`${stack.base}/announcements.json`)
  assert.equal(announcements.status, 200)
  const announcementBody = await announcements.json()
  assert.ok(Array.isArray(announcementBody.items))
  assert.ok(announcementBody.items.length > 0)

  const update = await fetch(`${stack.base}/update.json?local=0.6.10-rc.1`)
  assert.equal(update.status, 200)
  const updateBody = await update.json()
  assert.equal(typeof updateBody.version, 'string')
  assert.equal(typeof updateBody.notes, 'string')
  assert.ok(Array.isArray(updateBody.history))
})

test('用户文件流：列表、图片上传、下载内容/文件名、暂停探测与取消', async (t) => {
  const stack = await createRealisticStack()
  t.after(() => stack.stop())
  const encodedRoot = encodeURIComponent(stack.tmpRoot)

  let res = await fetch(`${stack.base}/fs/list?path=${encodedRoot}`, { headers: auth(stack.token) })
  assert.equal(res.status, 200)
  assert.ok((await res.json()).entries.some(entry => entry.name === 'sample.txt'))

  const bytes = Buffer.from(TEST_PNG_BASE64, 'base64')
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const session = `image-upload-${Date.now()}`
  res = await fetch(`${stack.base}/fs/upload?path=${encodedRoot}&name=${encodeURIComponent('用户图片.png')}&session=${session}&offset=0`, {
    method: 'POST', headers: auth(stack.token, { 'content-type': 'application/octet-stream' }), body: bytes.subarray(0, 20),
  })
  assert.equal(res.status, 200)

  res = await fetch(`${stack.base}/fs/upload-probe?path=${encodedRoot}&name=${encodeURIComponent('用户图片.png')}&session=${session}`, { headers: auth(stack.token) })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).partialSize, 20)

  res = await fetch(`${stack.base}/fs/upload?path=${encodedRoot}&name=${encodeURIComponent('用户图片.png')}&session=${session}&offset=20&finish=1&sha256=${sha256}`, {
    method: 'POST', headers: auth(stack.token, { 'content-type': 'application/octet-stream' }), body: bytes.subarray(20),
  })
  assert.equal(res.status, 201)
  assert.deepEqual(fs.readFileSync(path.join(stack.tmpRoot, '用户图片.png')), bytes)

  res = await fetch(`${stack.base}/fs/file?path=${encodeURIComponent(path.join(stack.tmpRoot, '用户图片.png'))}`, { headers: auth(stack.token) })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition') || '', /filename\*=UTF-8''/)
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes)

  const cancelSession = `cancel-${Date.now()}`
  res = await fetch(`${stack.base}/fs/upload?path=${encodedRoot}&name=cancel.bin&session=${cancelSession}&offset=0`, {
    method: 'POST', headers: auth(stack.token, { 'content-type': 'application/octet-stream' }), body: 'partial-data',
  })
  assert.equal(res.status, 200)
  res = await fetch(`${stack.base}/fs/upload-control?path=${encodedRoot}&name=cancel.bin&session=${cancelSession}&action=cancel`, {
    method: 'POST', headers: auth(stack.token),
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).cancelled, true)
})

test('管理页设备流：状态鉴权、设备备注和踢下线', async (t) => {
  const stack = await createRealisticStack()
  const client = await connectClient(stack)
  t.after(async () => { client.close(); await stack.stop() })

  let res = await fetch(`${stack.base}/admin/api/state`)
  assert.equal(res.status, 401)

  res = await fetch(`${stack.base}/admin/api/state`, {
    headers: auth(stack.token, { 'x-dsh-remote-client': 'admin' }),
  })
  assert.equal(res.status, 200)
  let state = await res.json()
  assert.equal(state.ok, true)
  assert.equal(state.mode, 'gateway')
  assert.equal(state.upstream.reachable, true)
  assert.ok(state.devices.some(device => device.ip === '127.0.0.1'))

  res = await fetch(`${stack.base}/admin/api/note`, {
    method: 'POST',
    headers: auth(stack.token, { 'content-type': 'application/json', 'x-dsh-remote-client': 'admin' }),
    body: JSON.stringify({ ip: '127.0.0.1', name: '真实测试手机' }),
  })
  assert.equal(res.status, 200)

  res = await fetch(`${stack.base}/admin/api/state`, {
    headers: auth(stack.token, { 'x-dsh-remote-client': 'admin' }),
  })
  state = await res.json()
  assert.ok(state.devices.some(device => device.ip === '127.0.0.1' && device.note === '真实测试手机'))

  const closed = new Promise(resolve => client.ws.addEventListener('close', resolve, { once: true }))
  res = await fetch(`${stack.base}/admin/api/kick`, {
    method: 'POST',
    headers: auth(stack.token, { 'content-type': 'application/json', 'x-dsh-remote-client': 'admin' }),
    body: JSON.stringify({ ip: '127.0.0.1' }),
  })
  assert.equal(res.status, 200)
  assert.ok((await res.json()).kicked >= 1)
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('被踢设备的 WebSocket 未断开')), 2000)),
  ])
})
