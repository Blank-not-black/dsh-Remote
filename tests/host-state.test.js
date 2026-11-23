'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { editable, writeItems } = require('../public/host-queue.js')
const { changes, initial, timing } = require('../public/host-schedule.js')

const row = (id, placement = 'queued', content = [{ type: 'text', text: id }]) => ({ id, placement, message: { id, content } })

test('batch uses current Host order, never re-steers or touches withdrawn/context entries, and reports each outcome', async () => {
  const calls = []
  const wanted = ['withdrawn', 'third', 'second', 'first', 'steered', 'context'].map(id => row(id))
  const snapshot = { running: true, items: [row('first'), row('second'), row('third'), row('steered', 'steering'), row('context', 'context'), row('unselected')] }
  const results = await writeItems({ sessionId: 'session', wanted, snapshot, action: { kind: 'steer' }, valid: () => true,
    rpc: async (method, payload) => {
      calls.push([method, payload.itemId, payload.action.kind])
      if (payload.itemId === 'second') throw Object.assign(new Error('drained'), { code: 'session/queue-item-not-found' })
      return { accepted: true }
    },
  })
  assert.deepEqual(calls, ['first', 'second', 'third'].map(id => ['session.updateQueue', id, 'steer']))
  assert.deepEqual(results.map(({ item, result }) => [item.id, result]), [['first', 'accepted'], ['second', 'rejected'], ['third', 'accepted'], ['steered', 'rejected'], ['context', 'rejected'], ['withdrawn', 'rejected']])
})

test('an unconfirmed write stops the batch without replay, and a session switch suppresses submission', async () => {
  const wanted = [row('first'), row('next')], calls = []
  const options = { sessionId: 'session', wanted, snapshot: { items: wanted, running: true }, action: { kind: 'steer' },
    rpc: async (method, payload) => { calls.push(payload.itemId); throw Object.assign(new Error('receipt unavailable'), { operationPending: true }) },
  }
  assert.deepEqual((await writeItems({ ...options, valid: () => true })).map(result => result.result), ['unknown', 'skipped'])
  assert.deepEqual((await writeItems({ ...options, valid: () => false })).map(result => result.result), ['skipped', 'skipped'])
  assert.deepEqual(calls, ['first'])
})

test('editing requires unchanged text-only content and sends the expected content but no attachment', async () => {
  const original = row('original'), changed = row('original', 'queued', [{ type: 'text', text: 'different' }])
  const withFile = row('original', 'queued', [...original.message.content, { type: 'file', attachment: { name: 'example.txt' } }])
  assert.equal(editable(withFile), false)
  assert.equal(editable(row('hidden', 'queued', null)), false)
  const action = { kind: 'edit', content: [{ type: 'text', text: 'replacement' }] }, calls = []
  for (const [item, expected] of [[withFile, 'rejected'], [changed, 'rejected'], [original, 'accepted']]) {
    const results = await writeItems({ sessionId: 'session', wanted: [original], snapshot: { running: true, items: [item] }, action,
      valid: () => true, rpc: async (method, payload) => { calls.push(payload); return { accepted: true } },
    })
    assert.equal(results[0].result, expected)
  }
  assert.deepEqual(calls, [{ sessionId: 'session', itemId: 'original', action, expectedContent: original.message.content }])
})

test('Schedule forwards local calendar rules and explicit offsets without resolving DST in Remote', () => {
  const zone = 'America/New_York'
  assert.deepEqual(timing({ kind: 'at', timingValue: '2030-03-10 02:30', zone }), { kind: 'at', at: { date: '2030-03-10', time: '02:30:00', time_zone: zone } })
  assert.deepEqual(timing({ kind: 'at', timingValue: '2030-11-03T01:30:00-05:00', zone }), { kind: 'at', at: '2030-11-03T01:30:00-05:00' })
  assert.deepEqual(timing({ kind: 'weekly', timingValue: '09:10', zone, weekdays: '7, 2' }), { kind: 'weekly', weekly: { time: '09:10:00', time_zone: zone, weekdays: [2, 7] } })
  assert.throws(() => timing({ kind: 'weekly', timingValue: '09:10', zone, weekdays: '1, 1' }))
  assert.throws(() => timing({ kind: 'daily', timingValue: '09:10', zone: 'invalid/zone' }))
  assert.throws(() => timing({ kind: 'every', timingValue: '59' }))
})

test('Schedule edits retain untouched rules and creation settings from another client', () => {
  const task = { title: 'Existing', prompt: 'Instructions', kind: 'daily', time: '03:15:00', timeZone: 'America/New_York', target: { kind: 'new_once', create: { cwd: 'C:/source', agentPreset: 'custom' } } }
  const before = initial(task)
  assert.deepEqual(changes({ ...before, title: 'Renamed' }, before, task), { title: 'Renamed' })
  assert.deepEqual(changes({ ...before, cwd: 'C:/other' }, before, task), { target: { kind: 'new_once', create: { cwd: 'C:/other', agentPreset: 'custom' } } })
  assert.deepEqual(changes({ ...before, destination: 'session', sessionId: 'reused' }, before, task), { target: { kind: 'session', sessionId: 'reused' } })
})

test('delivery completion requires a matching message and terminal event before the next turn', () => {
  const source = readFileSync(path.join(__dirname, '../gateway.js'), 'utf8')
  const context = vm.createContext({})
  vm.runInContext(source.slice(source.indexOf('function scheduledExecution('), source.indexOf('async function translateModernRpc(')), context)
  const record = (type, data = {}) => ({ event: { type, data } })
  const message = record('user/message', { id: 'delivery' }), step = record('step/start'), nextTurn = record('turn/start')
  const end = kind => record('turn/end', { reason: { kind } })
  const status = (records, running = false) => context.scheduledExecution(records, 'delivery', running)
  assert.equal(status([step, end('completed')]), 'unverified')
  assert.equal(status([message], true), 'unverified')
  assert.equal(status([message, step], true), 'running')
  assert.equal(status([message, nextTurn, step, end('completed')]), 'unverified')
  assert.equal(status([message, step, end('completed')]), 'completed')
  assert.equal(status([message, step, end('error')]), 'failed')
  assert.equal(status([message, step, end('aborted')]), 'aborted')
})
