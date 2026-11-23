'use strict'

// Opt-in integration against the installed DSH, never the user's profile.
// DSH_TEST_CLI_ROOT points to the @deepseek-ai/dsh package directory.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const { once } = require('node:events')
const net = require('node:net')
const crypto = require('node:crypto')

test('installed DSH: isolated Web boot and Remote RPC compatibility', { skip: !process.env.DSH_TEST_CLI_ROOT, timeout: 90000 }, async t => {
  const installedVersion = JSON.parse(fs.readFileSync(path.join(process.env.DSH_TEST_CLI_ROOT, 'package.json'))).version
  const [major, minor, patch] = installedVersion.split('.').map(part => Number.parseInt(part, 10))
  const hasJobRoster = major > 0 || minor >= 2
  const hasCurrentDescriptor = major === 0 && minor === 2 && patch >= 1
  const hasIndependentFork = major > 0 || minor > 2 || (minor === 2 && patch >= 2)
  t.diagnostic('Isolated installed DSH ' + installedVersion)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-installed-'))
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), DSH_REMOTE_FS_ROOT: home, DSH_REMOTE_TOKEN: 'installed-dsh-test-token', DSH_REMOTE_AUTOSTART: '0' }
  for (const key of Object.keys(env)) if (/proxy|api[_-]?key|secret/i.test(key)) delete env[key]
  const children = []
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.kill(); await closed }
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const pluginPatch = path.join(home, 'remote.patch.yml')
  const liveQueueSessionId = crypto.randomUUID()
  const liveContinuationSessionId = crypto.randomUUID()
  const testCombinedFeatures = process.env.DSH_TEST_HOST_STATE_ONLY === '1' && /^0\.2\.(?:[2-9]|\d{2,})(?:[.-]|$)/.test(installedVersion)
  const diffWorkspace = path.join(home, 'reference-workspace')
  if (testCombinedFeatures) {
    fs.mkdirSync(diffWorkspace)
    execFileSync('git', ['init', '--quiet'], { cwd: diffWorkspace, env, windowsHide: true })
    fs.writeFileSync(path.join(diffWorkspace, 'fixture reference.txt'), 'before change\n')
  }
  const plugins = [{ id: 'remote-test', name: path.join(__dirname, '../packages/plugin/index.mjs').replace(/\\/g, '/') }]
  if (hasCurrentDescriptor && process.env.DSH_TEST_TEAMS_ROOT) plugins.push({ id: 'teams-published', name: path.join(process.env.DSH_TEST_TEAMS_ROOT, 'lib/index.js').replace(/\\/g, '/'), config: { stateDir: '.agent-teams' } })
  for (const [id, key] of [['cost-published', 'DSH_TEST_COST_ROOT'], ['tasks-published', 'DSH_TEST_TASKBOARD_ROOT'], ['skills-published', 'DSH_TEST_SKILLS_ROOT'], ['context-published', 'DSH_TEST_CONTEXT_ROOT']]) {
    if (process.env[key]) plugins.push({ id, name: path.join(process.env[key], 'lib/index.js').replace(/\\/g, '/') })
  }
  if (hasCurrentDescriptor) {
    // The fixture creates durable history and stops continuation before model execution.
    const fixturePlugin = path.join(home, 'subagent-fixture.mjs')
    fs.writeFileSync(fixturePlugin, `
export const name = 'remote-compat-fixture'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const inject = ['sessions', 'attachments']
export async function apply(ctx) {
  const parent = ctx.sessions.create('compat-parent', { meta: { cwd: ${JSON.stringify(home)} } })
  parent.append('turn/start', { turn: 0 })
  parent.append('user/message', { id: 'fixture-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fixture question' }] }, { surfaceOp: 'append' })
  parent.append('assistant/message', { turn: 0, step: 0, stream: [], usage: { inputTokens: 3, outputTokens: 5 }, message: { id: 'fixture-result', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Fixture result' }] } }, { surfaceOp: 'append' })
  parent.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
  parent.append('turn/start', { turn: 1 })
  parent.append('user/message', { id: 'fixture-later', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Later question excluded from fork' }] }, { surfaceOp: 'append' })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
  const attachment = await ctx.get('attachments').saveImage({ data: png, mediaType: 'image/png' })
  parent.append('user/message', { id: 'fixture-image', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment }] }, { surfaceOp: 'append' })
  const child = ctx.sessions.create('compat-child', { meta: { cwd: ${JSON.stringify(home)}, parentSession: parent.id, origin: 'subagent' } })
  child.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'compat-fixture', label: 'Fixture child' })
  parent.append('subagent/catalog', { version: 0, childId: child.id, childCreatedAt: child.header.createdAt, mode: 'one-shot', label: 'Fixture child' })
  const grandchild = ctx.sessions.create('compat-grandchild', { meta: { cwd: ${JSON.stringify(home)}, parentSession: child.id, origin: 'subagent' } })
  grandchild.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'compat-fixture', label: 'Fixture grandchild' })
  child.append('subagent/catalog', { version: 0, childId: grandchild.id, childCreatedAt: grandchild.header.createdAt, mode: 'one-shot', label: 'Fixture grandchild' })
  if (${hasIndependentFork}) {
    parent.append('team/mode', { enabled: true })
    parent.append('team/task', { version: 2, teamId: parent.id, task: { id: 'task-1', revision: 1, subject: 'Fixture team work', description: '', status: 'in_progress', ownerId: child.id, ownerName: 'worker', blockedBy: [], writeScopes: [] } })
  }
  function appendFailure(session) {
    session.append('turn/start', { turn: 0 })
    session.append('user/message', { id: 'fixture-admitted', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fixture admitted work' }] }, { surfaceOp: 'append' })
    session.append('assistant/attempt', { turn: 0, step: 0, stream: [{ type: 'reasoning-chunks', time0: Date.now(), index: 0, dt: [0], texts: ['Fixture preserved reasoning'] }, { type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: 'Fixture provider timeout', status: 504 } } } }] })
    session.append('turn/end', { turn: 0, reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'Fixture provider timeout', status: 504 } } })
  }
  appendFailure(ctx.sessions.create('compat-provider-failure', { meta: { cwd: ${JSON.stringify(home)} } }))
  ctx.on('agent/pre-step', ({ agent }, next) => {
    if (agent.session.id === ${JSON.stringify(liveContinuationSessionId)}) throw new Error('Compatibility fixture stops before model execution')
    return next()
  })
  const queued = ctx.sessions.create('compat-queue-state', { meta: { cwd: ${JSON.stringify(home)} } })
  const message = (id, source, content) => ({ id, role: 'user', source, content })
  queued.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message('fixture-queued', { kind: 'user' }, [{ type: 'text', text: 'Queued fixture' }])] })
  queued.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message('fixture-steered', { kind: 'user' }, [{ type: 'text', text: 'Steered fixture' }]), message('fixture-context', { kind: 'system' }, [{ type: 'text', text: 'Context fixture' }])] })
  await ctx.sessions.flush(queued)
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.id === ${JSON.stringify(liveContinuationSessionId)}) appendFailure(agent.session)
    if (agent.session.id === ${JSON.stringify(liveQueueSessionId)}) {
      agent.inject(message('fixture-editable', { kind: 'user' }, [{ type: 'text', text: 'Editable fixture' }]))
    }
  })
  if (${testCombinedFeatures}) ctx.inject(['connection', 'agents', 'tools', 'workspaceChanges'], (fixture) => {
    fixture.connection.fetch.register({
      path: '/api/remote-compat-fixture', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        try {
          const { sessionId, task } = await request.json()
          const agent = fixture.agents.get(sessionId)
          if (!agent) return new Response('Fixture agent unavailable', { status: 404 })
          if (task === 'review') {
            const tool = fixture.tools.get('exit_plan_mode', agent)
            if (!tool) return new Response('Plan tool unavailable', { status: 404 })
            const result = await tool.execute({ plan: '# Fixture plan\\nCheck the integrated controls.' }, {
              agent, callId: 'fixture-plan-review', signal: AbortSignal.timeout(12000),
            })
            return Response.json(result)
          }
          const { session } = agent
          session.append('turn/start', { turn: 1 })
          // Await the real workspace recorder's initial snapshot before editing.
          await fixture.parallel('agent/turn-stopping', { agent, turn: 1 })
          await writeFile(join(${JSON.stringify(diffWorkspace)}, 'fixture reference.txt'), 'after change\\n')
          session.append('tool/result', { turn: 1, step: 0, message: {
            id: 'fixture-change-result', role: 'tool', source: { kind: 'tool', callId: 'fixture-file-update' },
            toolCallId: 'fixture-file-update', content: [{ type: 'text', text: 'Updated fixture file' }], isError: false,
          } }, { surfaceOp: 'append' })
          await fixture.parallel('agent/turn-stopping', { agent, turn: 1 })
          session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          await fixture.sessions.flush(session)
          return Response.json({ ok: true })
        } catch (error) {
          return new Response(String(error), { status: 500 })
        }
      },
    })
  })
}
`)
    plugins.push({ id: 'subagent-fixture', name: fixturePlugin.replace(/\\/g, '/') })
  }
  const startupPatch = [{ insert: plugins }]
  if (testCombinedFeatures) startupPatch.push({ id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'first-search' } })
  fs.writeFileSync(pluginPatch, JSON.stringify(startupPatch))
  const dsh = spawn(process.execPath, [path.join(process.env.DSH_TEST_CLI_ROOT, 'lib/bin.js'), '--profile', 'web', '--patch', pluginPatch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(dsh)
  let logs = ''
  for (const output of [dsh.stdout, dsh.stderr]) output.on('data', chunk => { logs += chunk })
  const deadline = Date.now() + 60000
  let url
  while (Date.now() < deadline && dsh.exitCode === null) {
    url = logs.match(/http:\/\/127\.0\.0\.1:\d+[^\s\x1b]*/)?.[0]
    if (url) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(url, logs.replace(/(token[=:])[^\s&]+/gi, '$1[redacted]'))
  t.diagnostic('DSH startup URL found')
  const response = await fetch(url, { redirect: 'manual' })
  assert.equal(response.status, 303)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const pluginPage = await fetch(new URL('/remote/', url), { headers: { cookie } })
  assert.equal(pluginPage.status, 200, 'Remote plugin mounted on the real DSH Web server')
  for (const asset of ['genui.js', 'genui.css', 'md.js', 'subagents.js', 'subagents.css', 'turn-results.js', 'teams.js', 'announcement-forms.js', 'host-queue.js', 'host-schedule.js', 'host-state.css']) {
    const served = await fetch(new URL('/remote/' + asset, url), { headers: { cookie } })
    assert.equal(served.status, 200)
    assert.equal(await served.text(), fs.readFileSync(path.join(__dirname, '../public', asset), 'utf8'), 'DSH serves current ' + asset)
  }
  const cookieFile = path.join(home, 'upstream.cookie')
  fs.writeFileSync(cookieFile, cookie, { mode: 0o600 })
  fs.mkdirSync(path.join(home, '.dsh-remote'), { recursive: true })
  fs.writeFileSync(path.join(home, '.dsh-remote/dsh-upstream.cookie'), cookie, { mode: 0o600 })
  const reserve = net.createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const gateway = spawn(process.execPath, [path.join(__dirname, '../gateway.js')], { cwd: home, env: { ...env, HOST: '127.0.0.1', PORT: String(port), TOKEN: env.DSH_REMOTE_TOKEN, DSH_UPSTREAM: new URL(url).origin, DSH_REMOTE_DSH_COOKIE_FILE: cookieFile, UPDATE_CHECK_URL: 'http://127.0.0.1:1/update.json' }, windowsHide: true, stdio: 'ignore' })
  children.push(gateway)
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(base + '/health')).ok } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready)
  const pluginStateResponse = await fetch(base + '/remote/api/plugins/state', { headers: { authorization: `Bearer ${env.DSH_REMOTE_TOKEN}` } })
  assert.equal(pluginStateResponse.status, 200)
  const pluginState = await pluginStateResponse.json()
  assert.equal(pluginState.profile, 'web', 'plugin manager detects the actual isolated boot profile')
  assert.equal(pluginState.writable, true, 'DSH CLI path is resolved from this running installation')
  assert.equal(pluginState.runtimeAvailable, true)
  assert.ok(pluginState.runtime.length > 0)
  for (const [id, key] of [['cost-published', 'DSH_TEST_COST_ROOT'], ['tasks-published', 'DSH_TEST_TASKBOARD_ROOT'], ['skills-published', 'DSH_TEST_SKILLS_ROOT'], ['context-published', 'DSH_TEST_CONTEXT_ROOT']]) {
    if (process.env[key]) assert.ok(pluginState.runtime.some(row => row.id.endsWith(':' + id) && row.phase === 'active'), id + ' runtime is active')
  }
  assert.equal((await fetch(base + '/remote/api/plugins/state')).status, 401)
  const remoteHeaders = { authorization: `Bearer ${env.DSH_REMOTE_TOKEN}`, 'content-type': 'application/json' }
  const rawRpc = async (method, payload = {}) => {
    const res = await fetch(base + '/api/' + method, { method: 'POST', headers: remoteHeaders, body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-' + method, method, payload }) })
    return res.json()
  }
  const rpc = async (method, payload) => {
    const body = await rawRpc(method, payload)
    assert.equal(body.result?.ok, true, `${method}: ${JSON.stringify(body)}`)
    return body.result.value
  }
  assert.ok(Array.isArray((await rpc('session.list')).items))
  const created = await rpc('session.create', { cwd: home })
  assert.ok(created.sessionId)
  if (process.env.DSH_TEST_HOST_STATE_ONLY && major === 0 && minor === 2 && patch < 2) {
    const response = await fetch(base + '/api/schedule.list', { method: 'POST', headers: { authorization: `Bearer ${env.DSH_REMOTE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'old-schedule-list', method: 'schedule.list', payload: {} }) })
    assert.equal((await response.json()).result?.error?.code, 'schedule/unsupported')
    assert.deepEqual((await rpc('session.queueState', { sessionId: created.sessionId })).items, [])
    return
  }
  if (testCombinedFeatures) {
    await t.test('real Host search, workspace pinning and reference catalogs', async () => {
      const { sessionId } = await rpc('session.create', { cwd: diffWorkspace })
      const files = await rpc('fileReferences.list', { sessionId, query: 'fixture' })
      assert.ok(files.some(file => file.path === 'fixture reference.txt'))
      const references = await rpc('sessionReferenceResolver.candidates', { sessionId, query: '' })
      assert.ok(references.some(row => row.sessionId === 'compat-parent' && row.mention.startsWith('@')))
      const search = await rpc('session.search', { query: 'Fixture question' })
      assert.ok(search.items.some(item => item.sessionId === 'compat-parent'))
      assert.ok((await rpc('workspace.pinSession', { sessionId })).pinnedSessionIds.includes(sessionId))
      assert.ok((await rpc('workspace.list')).pinnedSessionIds.includes(sessionId))
      assert.ok(!(await rpc('workspace.unpinSession', { sessionId })).pinnedSessionIds.includes(sessionId))
    })

    await t.test('real Plan tool review uses the Host question and response channel', async () => {
      const { sessionId } = created
      const command = await fetch(base + '/remote/api/command', { method: 'POST', headers: remoteHeaders,
        body: JSON.stringify({ sessionId, line: '/plan' }) })
      assert.equal(command.status, 202)
      let operation
      for (let attempt = 0; attempt < 60; attempt++) {
        const status = await fetch(base + '/remote/api/command-status?' + new URLSearchParams({ sessionId }), { headers: remoteHeaders })
        operation = (await status.json()).operation
        if (operation && !operation.active) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.equal(operation?.phase, 'complete')
      const poll = async () => (await (await fetch(base + '/api/events.poll?kind=mux&since=0', { headers: remoteHeaders })).json())
      await poll()
      const review = fetch(new URL('/api/remote-compat-fixture', url), { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ task: 'review', sessionId }) })
      let frame
      for (let attempt = 0; attempt < 60 && !frame; attempt++) {
        const result = await poll()
        frame = [...result.baseline, ...result.events.map(row => row.event)].find(item =>
          item.payload?.type === 'question/requested' && item.payload.sessionId === sessionId)
        if (!frame) await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!frame) assert.fail('Plan question was not broadcast: ' + await (await review).text())
      const [question] = frame.payload.questions
      assert.equal(question.intent?.kind, 'plan-review')
      assert.match(question.detail, /^# Fixture plan/)
      const response = await fetch(base + '/api/respond', { method: 'POST', headers: remoteHeaders,
        body: JSON.stringify({ type: 'client-response', rpcId: frame.rpcId, result: { ok: true, value: {
          sessionId, answer: { answers: [{ id: question.id, selected: [question.intent.approve] }] },
        } } }) })
      assert.deepEqual(await response.json(), { accepted: true })
      const reviewed = await review
      assert.equal(reviewed.status, 200, await reviewed.clone().text())
      assert.deepEqual(await reviewed.json(), { approved: true })
    })

    await t.test('real Host serves the authenticated change summary and file comparison through the gateway', async () => {
      const { sessionId } = await rpc('session.create', { cwd: diffWorkspace })
      await fetch(base + '/remote/api/command?' + new URLSearchParams({ sessionId }), { headers: remoteHeaders })
      const changed = await fetch(new URL('/api/remote-compat-fixture', url), { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ task: 'diff', sessionId }) })
      assert.equal(changed.status, 200, await changed.text())
      const history = await rpc('session.history', { sessionId, maxMessages: 30 })
      const notice = history.events.map(entry => entry.event || entry).find(event => event.type === 'workspace/changes')
      assert.ok(notice, 'Host recorded the change event')
      const query = new URLSearchParams({ sessionId, seq: notice.seq })
      const summaryResponse = await fetch(base + '/api/changes.summary?' + query, { headers: remoteHeaders })
      assert.equal(summaryResponse.status, 200, await summaryResponse.clone().text())
      const summary = await summaryResponse.json()
      const index = summary.files.findIndex(file => file.path === 'fixture reference.txt')
      assert.ok(index >= 0)
      query.set('index', String(index))
      const diffResponse = await fetch(base + '/api/changes.diff?' + query, { headers: remoteHeaders })
      assert.equal(diffResponse.status, 200, await diffResponse.clone().text())
      const diff = JSON.stringify(await diffResponse.json())
      assert.match(diff, /before change/)
      assert.match(diff, /after change/)
    })
  }
  await t.test('Host queue snapshot and cross-client Schedule CRUD', { skip: !/^0\.2\.(?:[2-9]|\d{2,})(?:[.-]|$)/.test(installedVersion) }, async () => {
    const native = async (method, args) => {
      const response = await fetch(new URL('/api/' + method, url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'native-' + method, method, payload: { args } }) })
      const body = await response.json()
      assert.equal(body.result?.ok, true, `${method}: ${JSON.stringify(body)}`)
      return body.result.value
    }
    assert.deepEqual((await rpc('session.queueState', { sessionId: created.sessionId })).items, [])
    const queue = await rpc('session.queueState', { sessionId: 'compat-queue-state' })
    assert.deepEqual(queue.items.map(({ id, placement }) => [id, placement]), [['fixture-queued', 'queued'], ['fixture-steered', 'steering'], ['fixture-context', 'context']])
    assert.equal((await rpc('session.deliveryStatus', { sessionId: 'compat-queue-state', messageId: 'fixture-queued' })).status, 'pending')
    assert.equal((await rpc('session.deliveryStatus', { sessionId: 'compat-parent', messageId: 'fixture-user' })).status, 'completed')
    const liveQueue = await rpc('session.create', { cwd: home, sessionId: liveQueueSessionId })
    assert.equal(liveQueue.sessionId, liveQueueSessionId)
    const editTarget = { sessionId: liveQueueSessionId, itemId: 'fixture-editable' }
    const updated = [{ type: 'text', text: 'Updated fixture' }]
    assert.equal((await rpc('session.updateQueue', { ...editTarget, action: { kind: 'edit', content: updated }, expectedContent: [{ type: 'text', text: 'Editable fixture' }] })).accepted, true)
    const edited = (await rpc('session.queueState', { sessionId: editTarget.sessionId })).items.find(item => item.id === editTarget.itemId)
    assert.deepEqual(edited.content ?? edited.message?.content, updated)
    const rejectedSteer = await rawRpc('session.updateQueue', { ...editTarget, action: { kind: 'steer' } })
    assert.equal(rejectedSteer.result?.error?.code, 'session/steer-unavailable')
    assert.equal((await rpc('session.updateQueue', { ...editTarget, action: { kind: 'remove' } })).accepted, true)
    assert.ok((await rpc('session.queueState', { sessionId: editTarget.sessionId })).items.every(item => item.id !== editTarget.itemId))
    const fixture = { title: 'Isolated Schedule', prompt: 'Do not run this scheduled fixture', timing: { kind: 'after', after_seconds: 172800 }, target: { kind: 'session', sessionId: created.sessionId } }
    const fromRemote = await rpc('schedule.create', fixture)
    assert.ok(fromRemote.id)
    assert.ok((await native('schedule/list', { request: {} })).items.some(item => item.id === fromRemote.id))
    assert.deepEqual((await rpc('schedule.history', { id: fromRemote.id, limit: 5 })).records, [])
    const fromHost = await native('schedule/create', { request: { ...fixture, title: 'Created by native caller' } })
    assert.ok((await rpc('schedule.list', { limit: 20, offset: 0 })).items.some(item => item.id === fromHost.id))
    const saved = await rpc('schedule.view', { id: fromHost.id })
    assert.equal(saved.id, fromHost.id)
    const paused = await rpc('schedule.edit', { id: saved.id, action: 'update', patch: { active: false }, expectedUpdatedAt: saved.updatedAt ?? null })
    assert.equal(paused.id, saved.id)
    assert.equal((await native('schedule/view', { request: { id: saved.id } })).status, 'paused')
    const resumed = await rpc('schedule.edit', { id: saved.id, action: 'update', patch: { active: true }, expectedUpdatedAt: paused.updatedAt ?? null })
    assert.equal(resumed.status, 'active')
    assert.equal((await rpc('schedule.edit', { id: saved.id, action: 'delete', expectedUpdatedAt: resumed.updatedAt ?? null })).deleted, true)
    const authenticated = (route, token, method = 'GET', payload) => fetch(base + route, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}),
    })
    const operation = { method: 'schedule.run', payload: { id: fromRemote.id } }
    const receiptRoute = '/api/operations?id=' + crypto.randomUUID()
    const admitted = await authenticated(receiptRoute, env.DSH_REMOTE_TOKEN, 'POST', operation)
    assert.equal(admitted.status, 202)
    let receipt = await admitted.json()
    for (let attempt = 0; receipt.phase === 'running' && attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      receipt = await (await authenticated(receiptRoute, env.DSH_REMOTE_TOKEN)).json()
    }
    assert.equal(receipt.phase, 'complete')
    assert.deepEqual(receipt.result.result.value, { id: fromRemote.id })
    const repeated = await authenticated(receiptRoute, env.DSH_REMOTE_TOKEN, 'POST', operation)
    assert.deepEqual((await repeated.json()).result, receipt.result)
    const { records } = await native('schedule/history', { request: { id: fromRemote.id, limit: 5 } })
    assert.equal(records.length, 1)
    const [delivered] = records
    assert.equal(delivered.targetSessionId, created.sessionId)
    assert.ok(delivered.messageId && delivered.deliveredAt)
    const execution = await rpc('session.deliveryStatus', { sessionId: delivered.targetSessionId, messageId: delivered.messageId })
    assert.ok(['pending', 'running', 'failed', 'unverified'].includes(execution.status))
    if (!process.env.DSH_TEST_HOST_STATE_ONLY) return
    const owner = env.DSH_REMOTE_TOKEN
    assert.equal((await authenticated('/admin/api/device-keys/mode', owner, 'POST', { enabled: true })).status, 200)
    const { entry: device } = await (await authenticated('/admin/api/device-keys/create', owner, 'POST', { note: 'Read-only fixture', hostStateReadOnly: true })).json()
    assert.deepEqual(await (await authenticated('/api/host-state-access', device.token)).json(), { writable: false })
    const list = await authenticated('/api/schedule.list', device.token, 'POST', { type: 'client-request', method: 'schedule.list', rpcId: 'read-only-list', payload: {} })
    assert.ok((await list.json()).result?.value?.items.some(item => item.id === fromRemote.id))
    for (const [method, payload] of [['schedule.edit', { id: fromRemote.id, action: 'delete' }], ['session.updateQueue', { sessionId: created.sessionId, itemId: 'fixture', action: { kind: 'remove' } }]]) {
      const response = await authenticated('/api/operations?id=' + crypto.randomUUID(), device.token, 'POST', { method, payload })
      assert.equal(response.status, 403)
      assert.equal((await authenticated('/api/' + method, device.token, 'POST', { type: 'client-request', method, rpcId: 'read-only-write', payload })).status, 403)
    }
    assert.equal((await authenticated('/admin/api/device-keys/host-state-access', owner, 'POST', { id: device.id, readOnly: false })).status, 200)
    assert.deepEqual(await (await authenticated('/api/host-state-access', device.token)).json(), { writable: true })
    const standaloneTarget = await native('session/create', { request: { cwd: home } })
    const standalone = await native('schedule/create', { request: { ...fixture, timing: { kind: 'after', after_seconds: 3 }, target: { kind: 'session', sessionId: standaloneTarget.sessionId } } })
    const gatewayClosed = once(gateway, 'exit')
    gateway.kill()
    await gatewayClosed
    let standaloneHistory
    for (let attempt = 0; attempt < 48; attempt++) {
      standaloneHistory = await native('schedule/history', { request: { id: standalone.id, limit: 5 } })
      if (standaloneHistory.records.length) break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.equal(standaloneHistory.records[0]?.targetSessionId, standaloneTarget.sessionId, 'The Host delivered with the Remote gateway stopped')
  })
  if (process.env.DSH_TEST_HOST_STATE_ONLY) return
  for (const client of ['public/app.js', 'public/desktop/desktop.js']) {
    const disposable = await rpc('session.create', { cwd: home })
    const clientSource = fs.readFileSync(path.join(__dirname, '..', client), 'utf8')
    const code = clientSource.slice(clientSource.indexOf('const emptySessionCleanup'), clientSource.indexOf('async function openSession'))
    const context = { rpc, state: { current: disposable.sessionId, server: base, byId: new Map([[disposable.sessionId, disposable]]), queues: {} }, $: () => ({ value: '' }), captureConnection: () => ({ valid: () => true }), refreshSessions: async () => { await rpc('workspace.list') } }
    require('node:vm').createContext(context)
    require('node:vm').runInContext(code, context)
    assert.equal(await context.archiveEmptySessionOnLeave(disposable.sessionId), true, client + ' archives actual DSH empty history')
    const refreshedWorkspaces = await rpc('workspace.list')
    assert.ok(refreshedWorkspaces.archivedSessionIds.includes(disposable.sessionId), 'cleanup persists after fresh upstream read')
  }
  const command = await fetch(new URL('/remote/api/command', url), { method: 'POST', headers: { cookie, authorization: `Bearer ${env.DSH_REMOTE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: created.sessionId, line: '/remote-compat-unknown' }) })
  const commandResult = await command.json()
  assert.equal(commandResult.ok, true, JSON.stringify(commandResult))
  assert.equal(commandResult.executed, false)
  assert.ok(commandResult.debug.commandNames.length, 'real agents/commands service is available')
  const catalog = await fetch(base + '/remote/api/command?' + new URLSearchParams({ sessionId: created.sessionId }),
    { headers: { authorization: 'Bearer ' + env.DSH_REMOTE_TOKEN } })
  assert.equal(catalog.status, 200)
  assert.deepEqual((await catalog.json()).commands.map(row => row.name), commandResult.debug.commandNames)
  if (hasCurrentDescriptor) {
    const skills = await rpc('skills.list', { sessionId: created.sessionId })
    assert.ok(skills.skills.some(row => row.name === 'dsh-remote-doctor'))
    assert.ok(skills.skills.every(row => !('path' in row)))
  }
  await rpc('session.rename', { sessionId: created.sessionId, title: 'Remote compatibility smoke' })
  const history = await rpc('session.history', { sessionId: created.sessionId, maxMessages: 60 })
  assert.ok(Array.isArray(history.events))
  const models = await rpc('session.models', { sessionId: created.sessionId })
  const nativeCatalogResponse = await fetch(new URL('/api/session/modelCatalog', url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'native-model-catalog', method: 'session/modelCatalog', payload: { args: {} } }) })
  const nativeCatalog = await nativeCatalogResponse.json()
  assert.equal(nativeCatalog.result?.ok, true)
  assert.ok(Array.isArray(models.groups))
  assert.deepEqual(models.groups, nativeCatalog.result.value.groups, 'Remote preserves the native catalog, including an unconfigured empty profile')
  const teamsWorkspace = (await rpc('workspace.create', { path: home })).workspace
  assert.ok(teamsWorkspace.workspaceId)
  for (const [key, route] of [['DSH_TEST_COST_ROOT', '/remote/api/insights/cost'], ['DSH_TEST_COST_ROOT', '/remote/api/insights/peak-reminders'], ['DSH_TEST_SKILLS_ROOT', '/remote/api/skills/list'], ['DSH_TEST_TASKBOARD_ROOT', '/remote/api/task-board?workspaceId=' + encodeURIComponent(teamsWorkspace.workspaceId)]]) {
    if (!process.env[key]) continue
    const response = await fetch(base + route, { headers: { authorization: `Bearer ${env.DSH_REMOTE_TOKEN}` } })
    assert.equal(response.status, 200, route)
    const data = await response.json()
    assert.equal(data.available, true, route + ': ' + JSON.stringify(data) + '\n' + logs.slice(-10000).replace(/(token[=:])[^\s&]+/gi, '$1[redacted]'))
    assert.equal(data.schema, 1)
    t.diagnostic('Verified published adapter ' + route.split('?')[0] + ' without model execution')
  }
  if (process.env.DSH_TEST_TASKBOARD_ROOT) {
    const native = await fetch(new URL('/api/task-board/state', url), { headers: { cookie } })
    assert.equal(native.status, 200)
    assert.ok([6, 7].includes((await native.json()).schemaVersion))
  }
  if (hasCurrentDescriptor && process.env.DSH_TEST_CONTEXT_ROOT) {
    const response = await fetch(base + '/api/dsh-context/detail', { method: 'POST', headers: { authorization: `Bearer ${env.DSH_REMOTE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'compat-parent' }) })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.ok, true)
    assert.ok(require('../public/insights.js').contextOf(data.value?.head), 'published context detail remains displayable')
    t.diagnostic('Verified published context detail through Remote on a durable fixture session')
  }
  if (hasCurrentDescriptor && process.env.DSH_TEST_TEAMS_ROOT) {
    const { pathToFileURL } = require('node:url')
    const { createTeamDir } = await import(pathToFileURL(path.join(process.env.DSH_TEST_TEAMS_ROOT, 'lib/state.js')).href)
    const now = Date.now()
    const captain = await rpc('session.create', { workspaceId: teamsWorkspace.workspaceId })
    await createTeamDir(path.join(home, '.agent-teams'), { id: 'remote-published-team', name: '真实团队桥接', captainSessionId: captain.sessionId, phase: 'staged', createdAt: now, taskSeq: 0, members: [], tasks: [] })
    const rawTeams = await fetch(new URL('/plugins/dsh-agent-teams/state', url), { headers: { cookie } })
    assert.equal(rawTeams.status, 200)
    assert.ok((await rawTeams.json()).teams.some(team => team.teamId === 'remote-published-team'))
    // Emulate the same connection-cookie file used by the deployed plugin.
    fs.mkdirSync(path.join(home, '.dsh-remote'), { recursive: true })
    fs.writeFileSync(path.join(home, '.dsh-remote/dsh-upstream.cookie'), cookie, { mode: 0o600 })
    const remoteTeams = await fetch(base + '/remote/api/teams?workspaceId=' + encodeURIComponent(teamsWorkspace.workspaceId), { headers: { authorization: `Bearer ${env.DSH_REMOTE_TOKEN}` } })
    assert.equal(remoteTeams.status, 200)
    const snapshot = await remoteTeams.json()
    assert.equal(snapshot.available, true); assert.ok(snapshot.teams.some(team => team.teamId === 'remote-published-team'))
    assert.ok(snapshot.teams.every(team => team.captainSessionId === captain.sessionId))
    t.diagnostic('Verified published AgentTeams mounted in real DSH through the authenticated Remote gateway, without model execution')
  }
  await rpc('settings.describe')
  await rpc('llm.providers')
  assert.deepEqual((await rpc('subagent.list', { parentSessionId: created.sessionId })).entries, [], 'removed subagents/list is bridged through the real durable catalog')
  if (hasCurrentDescriptor) {
    const failedHistory = await rpc('session.history', { sessionId: 'compat-provider-failure', maxMessages: 60 })
    const activity = require('../public/activity.js')
    const attempt = failedHistory.events.find(entry => entry.event.type === 'assistant/attempt')?.event
    const failure = failedHistory.events.find(entry => entry.event.type === 'turn/end')?.event
    if (hasIndependentFork) assert.equal(failedHistory.projections.values.conversationContinuation, failure.seq)
    assert.match(activity.attemptHtml(attempt), /Fixture preserved reasoning/)
    assert.match(activity.failureHtml(activity.failure(failure)), /TIMEOUT[\s\S]*504/)
    assert.match(activity.attemptHtml(attempt), /Fixture provider timeout/)
    t.diagnostic('Verified real DSH durable provider failure and failed-attempt reasoning through the authenticated Remote history API; no model request')
    assert.ok((await rpc('session.list')).items.some(item => item.sessionId === 'compat-parent'), 'Durable fixture loaded: ' + logs.slice(-12000).replace(/(token[=:])[^\s&]+/gi, '$1[redacted]'))
    const source = await rpc('session.history', { sessionId: 'compat-parent', maxMessages: 60 })
    const boundary = source.events.find(entry => entry.event?.type === 'turn/end' && entry.event.data.turn === 0)?.event.seq
    assert.ok(Number.isSafeInteger(boundary))
    const result = await rpc('session.fork', { sessionId: 'compat-parent', atSeq: boundary })
    assert.ok(result.sessionId)
    const summaries = (await rpc('session.list')).items
    const branchSummary = summaries.find(item => item.sessionId === result.sessionId)
    assert.ok(branchSummary)
    assert.equal(branchSummary.parentSessionId, hasIndependentFork ? undefined : 'compat-parent')
    assert.notEqual(branchSummary.origin, 'subagent')
    for (const client of ['public/app.js', 'public/desktop/desktop.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', client), 'utf8')
      const code = source.slice(source.indexOf('function isTopLevelSession'), source.indexOf('const GOAL_TERMINAL_PHASES'))
      const context = require('node:vm').createContext({ state: { sessions: summaries } })
      require('node:vm').runInContext(code, context)
      assert.ok(context.topLevelSessions().some(item => item.sessionId === result.sessionId), client + ' lists the real DSH fork')
      assert.ok(!context.topLevelSessions().some(item => item.sessionId === 'compat-child'), client + ' keeps real subagents out of the main list')
    }
    const fork = await rpc('session.history', { sessionId: result.sessionId, maxMessages: 60 })
    assert.ok(JSON.stringify(fork.events).includes('Fixture result'))
    assert.ok(!JSON.stringify(fork.events).includes('Later question excluded from fork'))
    const footer = require('../public/turn-results.js').summarize(source.events.map(entry => ({ ...entry, seq: entry.event.seq })), 'compat-parent').get(boundary)
    assert.equal(footer.text, 'Fixture result')
    assert.equal(footer.total, 8)
    assert.equal(footer.partial, false)
    assert.equal(footer.time, source.events.find(entry => entry.event.seq === boundary).event.time)
    t.diagnostic('Verified real DSH exact completed-turn fork, final answer, usage and timestamp without a model call')
    for (const [parentSessionId, childSessionId, hasChildren] of [['compat-parent', 'compat-child', true], ['compat-child', 'compat-grandchild', false]]) {
      const catalog = await rpc('subagent.list', { parentSessionId })
      assert.equal(catalog.entries.length, 1)
      assert.equal(catalog.entries[0].kind, 'child')
      assert.equal(catalog.entries[0].id, childSessionId)
      assert.equal(catalog.entries[0].mode, 'one-shot')
      assert.equal(catalog.entries[0].hasChildren, hasChildren)
      if (hasIndependentFork && parentSessionId === 'compat-parent') {
        assert.equal(catalog.agentTeam?.enabled, true)
        assert.equal(catalog.agentTeam.tasks[0].ownerId, childSessionId)
        assert.equal(catalog.agentTeam.tasks[0].ownerName, 'worker')
        assert.ok(Number.isSafeInteger(catalog.teamSeq))
      }
      const childHistory = await rpc('session.history', { sessionId: childSessionId, parentSessionId, subagentMode: 'one-shot' })
      assert.ok(Array.isArray(childHistory.events))
    }
    t.diagnostic('Verified real durable subagent and grandchild catalogs/history without running a model')
  }
  const health = await (await fetch(base + '/health')).json()
  t.diagnostic('Verified real DSH: session list/create/rename/history/models, workspace create, settings, providers')
  assert.ok(health.events)
  let polled
  for (let i = 0; i < 100; i++) {
    polled = await (await fetch(base + '/api/events.poll?kind=mux&since=0', { headers: { authorization: `Bearer ${env.DSH_REMOTE_TOKEN}` } })).json()
    if (polled.events.some(entry => entry.event.payload.type === 'session/queue' && entry.event.payload.sessionId === created.sessionId)
      && (!hasJobRoster || polled.events.some(entry => entry.event.payload.type === 'session/jobs' && entry.event.payload.sessionId === created.sessionId))) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(polled.events.some(entry => entry.event.payload.type === 'session/subscribed'), 'real remote.mux session snapshot reached Remote')
  assert.ok(polled.events.some(entry => entry.event.payload.type === 'session/reasoning'), 'new assistant-stream baseline reached Remote')
  assert.ok(polled.events.some(entry => entry.event.payload.type === 'session/queue' && entry.event.payload.sessionId === created.sessionId), 'real Inbox projection reached the Remote queue contract')
  if (hasJobRoster) assert.ok(polled.events.some(entry => entry.event.payload.type === 'session/jobs' && entry.event.payload.sessionId === created.sessionId), 'real job/list roster reached Remote')
  assert.ok(!polled.events.some(entry => entry.event.payload.type === 'stream/error'), 'generated streams opened without protocol errors')
  const ticketResponse = await fetch(base + '/api/ws-ticket', { method: 'POST', headers: { authorization: `Bearer ${env.DSH_REMOTE_TOKEN}` } })
  assert.equal(ticketResponse.status, 200)
  const { ticket } = await ticketResponse.json()
  const lateFrames = []
  const replayTypes = hasJobRoster ? ['session/queue', 'session/jobs'] : ['session/queue']
  const lateClient = new WebSocket(base.replace(/^http/, 'ws') + '/api/events.mux?ticket=' + encodeURIComponent(ticket))
  lateClient.addEventListener('message', event => lateFrames.push(JSON.parse(event.data)))
  t.after(() => lateClient.close())
  for (let i = 0; i < 100; i++) {
    if (replayTypes.every(type => lateFrames.some(frame => frame.payload?.type === type && frame.payload.sessionId === created.sessionId))) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  for (const type of replayTypes) {
    assert.ok(lateFrames.some(frame => frame.payload?.type === type && frame.payload.sessionId === created.sessionId), 'late authenticated client receives ' + type)
  }
  lateClient.close()
  if (hasIndependentFork) {
    const { sessionId } = await rpc('session.create', { cwd: home, sessionId: liveContinuationSessionId })
    assert.equal(sessionId, liveContinuationSessionId)
    const failure = await rpc('session.history', { sessionId, maxMessages: 60 })
    const ending = failure.projections.values.conversationContinuation
    const id = crypto.randomUUID(), operationUrl = base + '/api/operations?id=' + id
    const start = await fetch(operationUrl, { method: 'POST', headers: remoteHeaders,
      body: JSON.stringify({ method: 'session.continue', payload: { sessionId, ending } }),
    })
    assert.equal(start.status, 202)
    let receipt
    for (let attempt = 0; attempt < 40; attempt++) {
      receipt = await (await fetch(operationUrl, { headers: remoteHeaders })).json()
      if (receipt.phase !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(receipt.result?.result?.value?.accepted, true, JSON.stringify(receipt.result))
    t.diagnostic('Verified real DSH accepts an empty continuation prompt via a durable receipt without running a model')
  }
  const apk = path.join(__dirname, '../apk/dsh-remote.apk')
  if (fs.existsSync(apk)) {
    const downloaded = await fetch(base + '/dsh-remote.apk')
    assert.equal(downloaded.status, 200)
    const digest = crypto.createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex')
    const update = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/update.json')))
    assert.equal(digest, update.sha256, 'APK served by the real gateway matches update.json')
    t.diagnostic('Verified APK download SHA-256 against the published local update manifest')
  }
  if (hasCurrentDescriptor) {
    const source = await rpc('session.history', { sessionId: 'compat-parent', maxMessages: 60 })
    const attachment = source.events.find(({ event }) => event.data?.id === 'fixture-image').event.data.content[0].attachment
    const imageRequest = (headers, sessionId, route = '/api/session.attachment') => fetch(base + route, {
      method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture-image-rpc', method: 'session.attachment', payload: { sessionId, attachment } }),
    })
    const verifyImages = async headers => {
      const allowed = await (await imageRequest(headers, 'compat-parent')).json()
      assert.equal(allowed.result?.ok, true, JSON.stringify(allowed.result?.error))
      assert.equal(allowed.result.value.attachment.attachmentId, attachment.attachmentId)
      assert.ok(allowed.result.value.data)
      const wrongSession = await (await imageRequest(headers, created.sessionId)).json()
      assert.equal(wrongSession.result?.error?.code, 'session/attachment-not-in-history')
      assert.equal((await imageRequest(headers, 'compat-parent', '/api/session/attachment')).status, 404)
    }
    await verifyImages(remoteHeaders)
    assert.equal((await imageRequest({ 'content-type': 'application/json' }, 'compat-parent')).status, 401)
    const admin = (action, body) => fetch(base + '/admin/api/device-keys/' + action, {
      method: 'POST', headers: { ...remoteHeaders, 'x-dsh-remote-client': 'admin' }, body: JSON.stringify(body),
    })
    const device = await (await admin('create', { note: 'isolated preview', hostStateReadOnly: true })).json()
    assert.ok(device.entry?.token)
    assert.equal((await admin('mode', { enabled: true })).status, 200)
    await verifyImages({ ...remoteHeaders, authorization: 'Bearer ' + device.entry.token })
    t.diagnostic('Verified session-scoped historical images in real DSH with master and device credentials')
  }
})
