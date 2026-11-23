'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHmac } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { createOperationsNotifier, hermesAlertDelivery } = require('../relay/operations.cjs')
const { createTrafficMonitor } = require('../relay/traffic-alert.cjs')

test('operations batches new orders and traffic signals, retrying the same alert without sensitive metadata', async t => {
  const sent = []
  let resolveDelivered
  const delivered = new Promise(resolve => { resolveDelivered = resolve })
  const notifier = createOperationsNotifier({
    url: 'https://relay.example.test/sponsor/monitor', batchMs: 1, retryMs: 1,
    async deliver(message) {
      sent.push(message)
      if (sent.length === 1) throw Error('simulated delivery failure')
      resolveDelivered()
    }
  })
  t.after(() => notifier.close())
  notifier.notify({ event: 'SPONSOR_RELAY_ORDER_SUBMITTED', email: 'buyer@example.test' })
  notifier.notify({ event: 'SPONSOR_RELAY_ORDER_SUBMITTED' })
  notifier.notify({ event: 'SPONSOR_RELAY_SUSTAINED_TRAFFIC', grantId: 'private-grant' })
  notifier.notify({ event: 'unsupported-type', text: 'private-text' })
  const abort = new AbortController()
  try {
    await Promise.race([delivered, delay(1000, null, { signal: abort.signal }).then(() => { throw Error('Alert retry timed out') })])
  } finally { abort.abort() }
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0], sent[1])
  assert.match(sent[1].text, /新订单待审核 · 2 条\n持续高流量 · 1 条/)
  assert.doesNotMatch(JSON.stringify(sent[1]), /buyer@|private-grant|private-text/)
})

test('Hermes delivery signs the raw payload with a fresh timestamp and requires an acknowledged delivery', async () => {
  const secret = 'H'.repeat(43), url = 'https://hermes.example.test/webhooks/dsh-relay'
  let now = 180_000, result = 'delivered'
  const signature = []
  const send = hermesAlertDelivery({
    url, secret, now: () => now,
    fetcher: async (target, request) => {
      assert.equal(target.href, url)
      assert.equal(request.method, 'POST')
      assert.equal(request.redirect, 'error')
      const timestamp = String(now / 1000)
      assert.equal(request.headers['x-request-id'], 'same-delivery-id')
      assert.equal(request.headers['x-webhook-timestamp'], timestamp)
      const expected = createHmac('sha256', secret).update(timestamp + '.' + request.body).digest('hex')
      assert.equal(request.headers['x-webhook-signature-v2'], expected)
      signature.push(expected)
      assert.deepEqual(JSON.parse(request.body), { event_type: 'dsh_remote.relay_alert', subject: '提醒', message: '待审核 1 条' })
      return Response.json({ status: result })
    }
  })
  const alert = { subject: '提醒', text: '待审核 1 条', idempotencyKey: 'same-delivery-id' }
  await send(alert)
  now += 1000
  result = 'duplicate'
  await send(alert)
  assert.notEqual(signature[0], signature[1])
  result = 'ignored'
  await assert.rejects(send(alert), /did not confirm/)
  assert.equal(hermesAlertDelivery({ url: url.replace('https:', 'http:'), secret }), null)
  assert.equal(hermesAlertDelivery({ url, secret: 'short' }), null)
})

test('traffic view fills idle minutes and keeps only the latest sixty windows', () => {
  let at = 60_000
  const monitor = createTrafficMonitor({ wallNow: () => at, now: () => at })
  monitor.bytes({}, 40)
  at += 2 * 60_000
  monitor.bytes({}, 60)
  monitor.bytes({}, 3)
  assert.deepEqual(monitor.traffic().samples.map(sample => sample.bytes), [40, 0, 63])
  at += 60 * 60_000
  assert.equal(monitor.traffic().samples.length, 60)
  assert.ok(monitor.traffic().samples.every(sample => sample.bytes === 0))
})
