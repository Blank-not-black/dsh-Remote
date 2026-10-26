'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
test('DSH file tools: real local source, stable call id, session-scoped receipt and no premature success', async t => {
  const { createDeliveryTools } = await import('../packages/plugin/file-delivery.mjs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-tool-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const filename = path.join(tmp, '报告.txt'); fs.writeFileSync(filename, 'report')
  const calls = [], ctx = { workingDirectory: { ensure: async () => tmp }, fs: {
    resolve: async p => path.resolve(tmp, p), stat: async p => ({ type: fs.statSync(p).isFile() ? 'file' : 'directory', size: fs.statSync(p).size }), processPath: p => p,
  } }
  const tools = createDeliveryTools(ctx, async (method, body) => { calls.push({ method, body }); return body ? { id: body.id, phase: 'pending' } : { devices: [] } })
  const exec = { agent: { session: { id: 'session-1' } }, callId: 'call-1', signal: new AbortController().signal }
  assert.deepEqual(tools.map(t => t.name), ['remote_devices', 'remote_send_file', 'remote_file_status'])
  await tools[0].execute({}, exec)
  const out = await tools[1].execute({ path: '报告.txt', device_id: 'device-1' }, exec)
  assert.match(out.message, /待确认/); assert.match(out.message, /尚未接收/)
  assert.equal(calls[1].body.path, filename); assert.equal(calls[1].body.workspaceRoot, tmp)
  await tools[1].execute({ path: '报告.txt', device_id: 'device-1' }, exec)
  assert.equal(calls[1].body.id, calls[2].body.id)
  await tools[2].execute({ transfer_id: calls[1].body.id }, exec)
  assert.equal(calls[3].body.sessionId, 'session-1')
  assert.equal(tools[1].output.render({}, out)[0].type, 'text')
  await assert.rejects(tools[1].execute({ path: '../outside.txt', device_id: 'device-1' }, {}), /有效的 DSH 会话/)
  await assert.rejects(tools[1].execute({ path: '报告.txt', device_id: 'device-1', bypass: true }, exec), /参数无效/)
  const denied = createDeliveryTools(ctx, async () => { throw Error('lost response') })
  await assert.rejects(denied[1].execute({ path: filename, device_id: 'device-1' }, exec), new RegExp('结果未确认.*' + calls[1].body.id))
})

test('DSH file tools reject a symlink outside the working directory before invoking the gateway', async t => {
  const { createDeliveryTools } = await import('../packages/plugin/file-delivery.mjs')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-tool-link-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const cwd = path.join(tmp, 'project'), outside = path.join(tmp, 'outside'); fs.mkdirSync(cwd); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'file.txt'), 'private')
  fs.symlinkSync(outside, path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const ctx = { workingDirectory: { ensure: async () => cwd }, fs: { resolve: async p => path.resolve(cwd, p), stat: async () => ({ type: 'file', size: 7 }), processPath: p => p } }
  let requests = 0
  const tools = createDeliveryTools(ctx, async () => { requests++ })
  await assert.rejects(tools[1].execute({ path: 'link/file.txt', device_id: 'receiver' }, { agent: { session: { id: 's' } }, callId: 'c' }), /不能通过链接越界/)
  assert.equal(requests, 0)
})

test('optional DSH tool service registers raw JSON schemas and uses only its configured gateway token', async () => {
  const { registerFileDeliveryTools } = await import('../packages/plugin/file-delivery.mjs')
  const definitions = [], requests = [], services = { tools: { register: def => { definitions.push(def); return () => {} } }, fs: { resolve() {} }, workingDirectory: { ensure() {} } }
  const ctx = { inject(names, callback) { assert.deepEqual(names, ['tools', 'fs', 'workingDirectory']); callback({ get: name => services[name], effect: fn => fn() }) } }
  assert.equal(registerFileDeliveryTools({}, {}), false)
  registerFileDeliveryTools(ctx, { gatewayBase: () => 'http://127.0.0.1:1234', gatewayToken: () => 'isolated-master', fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ devices: [] }) } } })
  assert.equal(definitions.length, 3)
  const value = await definitions[0].execute({}, { agent: { session: { id: 's' } }, callId: 'c' })
  assert.equal(value.ok, true); assert.equal(requests[0].options.headers.authorization, 'Bearer isolated-master')
  assert.equal(requests[0].url, 'http://127.0.0.1:1234/admin/api/file-inbox')
  assert.equal(definitions[1].parameters.additionalProperties, false)
  assert.deepEqual(definitions[1].parameters.required, ['path', 'device_id'])
  assert.doesNotMatch(value.details, /isolated-master/)
})
