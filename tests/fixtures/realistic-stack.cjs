'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const GATEWAY = path.join(ROOT, 'gateway.js')
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_TOKEN = 'realistic-user-flow-test-token'
const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII='

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key || '') + WS_GUID).digest('base64')
}

function encodeWsFrame(opcode, payload) {
  const body = Buffer.from(payload || '')
  let header
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length])
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([header, body])
}

function encodeWsJson(value) {
  return encodeWsFrame(0x1, JSON.stringify(value))
}

function attachAutoPong(socket) {
  let pending = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 2) {
      const first = pending[0]
      const second = pending[1]
      let offset = 2
      let length = second & 0x7f
      if (length === 126) {
        if (pending.length < 4) return
        length = pending.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (pending.length < 10) return
        length = Number(pending.readBigUInt64BE(2))
        offset = 10
      }
      const masked = (second & 0x80) !== 0
      const maskOffset = offset
      if (masked) offset += 4
      if (pending.length < offset + length) return
      let payload = pending.subarray(offset, offset + length)
      if (masked) {
        const mask = pending.subarray(maskOffset, maskOffset + 4)
        const decoded = Buffer.alloc(length)
        for (let i = 0; i < length; i++) decoded[i] = payload[i] ^ mask[i % 4]
        payload = decoded
      }
      pending = pending.subarray(offset + length)
      const opcode = first & 0x0f
      if (opcode === 0x9 && !socket.destroyed) socket.write(encodeWsFrame(0xA, payload))
      if (opcode === 0x8) socket.end()
    }
  })
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function rpcValue(method, payload, state) {
  const session = state.sessions[0]
  switch (method) {
    case 'session.list': return { items: state.sessions }
    case 'session.history': return { events: state.history.map(event => ({ event })), hasMore: false }
    case 'session.create': {
      const created = { ...session, sessionId: `session-created-${state.createdSessions + 1}`, cwd: payload.cwd || '/tmp/workbench/new-project' }
      state.createdSessions++
      state.sessions.unshift(created)
      return { sessionId: created.sessionId }
    }
    case 'session.prompt': return { accepted: true }
    case 'session.cancel': return { accepted: true }
    case 'session.selectModel': return { accepted: true, model: payload.model }
    case 'host.describe': return {
      version: 'test-dsh-1.0.0',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', reasoningEfforts: ['low', 'high'] }],
    }
    case 'workspace.list': return {
      items: [{ workspaceId: 'workspace-1', path: path.join(state.tmpRoot, 'project-one'), title: 'project-one', sessionIds: [session.sessionId] }],
      archivedSessionIds: state.archivedSessionIds,
    }
    case 'workspace.create': return { workspace: { workspaceId: 'workspace-created', path: payload.path, title: path.basename(payload.path), sessionIds: [] } }
    case 'workspace.archiveSession':
      if (!state.archivedSessionIds.includes(payload.sessionId)) state.archivedSessionIds.push(payload.sessionId)
      return { archived: true }
    case 'goal.edit': return { accepted: true }
    case 'goal.pause': return { accepted: true }
    case 'goal.resume': return { accepted: true }
    case 'goal.complete': return { accepted: true }
    case 'goal.clear': return { accepted: true }
    case 'subagent.list': return { entries: [{ id: 'child-1', label: '测试子任务', mode: 'continuable', activity: 'running' }] }
    case 'subagent.interrupt': return { accepted: true }
    default: return { accepted: true, echo: payload }
  }
}

async function createDshServer(port, tmpRoot, records) {
  let seq = 10
  const sockets = { mux: new Set(), host: new Set() }
  const state = {
    tmpRoot,
    createdSessions: 0,
    archivedSessionIds: [],
    sessions: [{
      sessionId: 'session-1', cwd: path.join(tmpRoot, 'project-one'), running: false, updatedAt: Date.now(),
      projections: { asOfSeq: 1, values: {
        title: '真实功能测试会话',
        goal: { id: 'goal-1', revision: 1, phase: 'active', objective: '验证全部用户功能' },
        todos: { items: [{ content: '发送与接收消息', status: 'in_progress' }] },
      } },
    }],
    history: [
      { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '历史用户文本' }] } },
      { seq: 2, type: 'assistant/message', data: { role: 'assistant', content: [
        { type: 'text', text: '历史回复文本' },
        { type: 'image', mediaType: 'image/png', data: TEST_PNG_BASE64 },
      ] } },
    ],
  }

  function broadcast(kind, payload, rpcId = `server-${Date.now()}`) {
    const frame = encodeWsJson({ rpcId, payload })
    for (const socket of sockets[kind]) if (!socket.destroyed) socket.write(frame)
  }

  function broadcastSessionEvent(event) {
    state.history.push(event)
    broadcast('mux', { type: 'session/event', sessionId: 'session-1', event })
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/') return json(res, 200, { ok: true, service: 'realistic-fake-dsh' })
      if (req.url === '/api/respond') {
        const body = await readJson(req)
        records.responses.push(body)
        return json(res, 200, { accepted: true })
      }
      if (!req.url.startsWith('/api/')) return json(res, 404, { error: 'not-found' })
      const body = await readJson(req)
      records.requests.push({ path: req.url, body, headers: req.headers })
      const method = body.method || req.url.slice('/api/'.length)
      const payload = body.payload || {}
      if (method === 'session.prompt') {
        records.prompts.push(payload)
        const userEvent = { seq: ++seq, type: 'user/message', data: { role: 'user', content: payload.content || [] } }
        const assistantEvent = { seq: ++seq, type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: `已收到第 ${records.prompts.length} 条消息` }] } }
        broadcastSessionEvent(userEvent)
        setTimeout(() => broadcastSessionEvent(assistantEvent), 20)
      }
      return json(res, 200, { result: { ok: true, value: rpcValue(method, payload, state) } })
    } catch (err) {
      json(res, 400, { error: String(err?.message || err) })
    }
  })

  server.on('upgrade', (req, socket) => {
    const kind = req.url.includes('events.host') ? 'host' : 'mux'
    sockets[kind].add(socket)
    socket.on('close', () => sockets[kind].delete(socket))
    socket.on('error', () => {})
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`
    )
    attachAutoPong(socket)
    const payload = kind === 'host'
      ? { type: 'host/session-status', sessionId: 'session-1', running: false }
      : { type: 'session/subscribed', sessionId: 'session-1' }
    socket.write(encodeWsJson({ rpcId: `${kind}-baseline`, payload }))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    state,
    broadcast,
    broadcastSessionEvent,
    requestApproval() {
      broadcast('mux', { type: 'approval/requested', sessionId: 'session-1', approvalId: 'approval-1', toolName: 'shell', reason: '执行测试命令' }, 'approval-rpc-1')
    },
    requestQuestion() {
      broadcast('mux', { type: 'question/requested', sessionId: 'session-1', questions: [{ id: 'choice', header: '测试问题', question: '是否继续？', options: [{ label: '继续', description: '继续测试' }], multiSelect: false }] }, 'question-rpc-1')
    },
    pushAssistant(text) {
      broadcastSessionEvent({ seq: ++seq, type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text }] } })
    },
    async close() {
      for (const group of Object.values(sockets)) for (const socket of group) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

async function createFeedbackCollector(port, records) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/submit') return json(res, 404, { error: 'not-found' })
    try {
      const body = await readJson(req)
      records.feedback.push(body)
      json(res, 200, { ok: true })
    } catch (err) {
      json(res, 400, { error: String(err?.message || err) })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { close: () => new Promise(resolve => server.close(resolve)) }
}

async function createMobileUiProxy(port, gatewayPort, dsh, records) {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'))
  const server = http.createServer((req, res) => {
    if (req.url === '/__test__/records' && req.method === 'GET') return json(res, 200, records)
    if (req.url === '/__test__/approval' && req.method === 'POST') {
      dsh.requestApproval()
      return json(res, 200, { ok: true })
    }
    if (req.url === '/__test__/question' && req.method === 'POST') {
      dsh.requestQuestion()
      return json(res, 200, { ok: true })
    }
    if (req.url === '/mobile' || req.url.startsWith('/mobile?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': indexHtml.length })
      res.end(indexHtml)
      return
    }
    const upstream = http.request({
      hostname: '127.0.0.1', port: gatewayPort, method: req.method, path: req.url, headers: req.headers,
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', err => json(res, 502, { error: err.message }))
    req.pipe(upstream)
  })
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(gatewayPort, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      upstream.write(raw + '\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { close: () => new Promise(resolve => server.close(resolve)) }
}

async function waitFor(check, timeoutMs, failure) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (err) { lastError = err }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${failure}${lastError ? `: ${lastError.message}` : ''}`)
}

async function createRealisticStack(options = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-realistic-'))
  const token = options.token || DEFAULT_TOKEN
  const dshPort = await getFreePort()
  const feedbackPort = await getFreePort()
  const gatewayPort = await getFreePort()
  const mobilePort = await getFreePort()
  const records = { requests: [], prompts: [], responses: [], feedback: [] }
  fs.mkdirSync(path.join(tmpRoot, 'project-one'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, 'sample.txt'), '真实文件下载内容')
  const dsh = await createDshServer(dshPort, tmpRoot, records)
  const feedback = options.publicFeedback ? null : await createFeedbackCollector(feedbackPort, records)
  let logs = ''
  const env = {
    ...process.env,
    HOME: tmpRoot,
    USERPROFILE: tmpRoot,
    PORT: String(gatewayPort),
    HOST: '127.0.0.1',
    TOKEN: token,
    TOKEN_FILE: path.join(tmpRoot, 'token'),
    DSH_UPSTREAM: `http://127.0.0.1:${dshPort}`,
    DSH_REMOTE_FS_ROOT: tmpRoot,
    DSH_REMOTE_NOTES: path.join(tmpRoot, 'notes.json'),
    DSH_REMOTE_WORKBENCH: path.join(tmpRoot, 'workbench.json'),
    DSH_REMOTE_DSH_SERVICE: 'invalid realistic test service',
    GATEWAY_WS_UPGRADE_TIMEOUT_MS: '1000',
    GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
    GATEWAY_WS_PING_MS: '1000',
    GATEWAY_WS_PONG_TIMEOUT_MS: '3000',
    UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
    UPDATE_INTERVAL_MS: '3600000',
    UPDATE_PROXY: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
  }
  delete env.NODE_USE_ENV_PROXY
  if (feedback) env.DSH_REMOTE_FEEDBACK_URL = `http://127.0.0.1:${feedbackPort}/submit`
  else delete env.DSH_REMOTE_FEEDBACK_URL
  delete env.http_proxy
  delete env.https_proxy
  delete env.all_proxy
  const gateway = spawn(process.execPath, [GATEWAY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const capture = chunk => { logs = (logs + chunk.toString()).slice(-12000) }
  gateway.stdout.on('data', capture)
  gateway.stderr.on('data', capture)
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/health`, { signal: AbortSignal.timeout(500) })
    if (!res.ok) return false
    const health = await res.json()
    return health.upstreamOk && health.events?.mux?.connected && health.events?.host?.connected
  }, 7000, `gateway failed to become healthy\n${logs}`)
  const mobileProxy = await createMobileUiProxy(mobilePort, gatewayPort, dsh, records)

  let stopped = false
  return {
    base: `http://127.0.0.1:${gatewayPort}`,
    mobileBase: `http://127.0.0.1:${mobilePort}`,
    token,
    tmpRoot,
    records,
    dsh,
    logs: () => logs,
    async stop() {
      if (stopped) return
      stopped = true
      if (gateway.exitCode === null) gateway.kill('SIGTERM')
      await Promise.race([once(gateway, 'exit').catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))])
      await dsh.close()
      await feedback?.close()
      await mobileProxy.close()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    },
  }
}

module.exports = { createRealisticStack, DEFAULT_TOKEN, TEST_PNG_BASE64, getFreePort }

if (require.main === module) {
  createRealisticStack().then((stack) => {
    process.stdout.write(JSON.stringify({ base: stack.base, mobileBase: stack.mobileBase, token: stack.token, tmpRoot: stack.tmpRoot }) + '\n')
    let closing = false
    const close = async () => {
      if (closing) return
      closing = true
      await stack.stop()
      process.exit(0)
    }
    process.on('SIGINT', close)
    process.on('SIGTERM', close)
  }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
