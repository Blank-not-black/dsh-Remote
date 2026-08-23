/* 统计核心单元测试: 北京时段边界 + 四桶 × 双模型 × 双时段价格 + 幂等 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const stats = require('../gateway-stats.cjs')

/** 构造北京 local 时间的 UTC 毫秒时间戳(Asia/Shanghai = UTC+8)。 */
function bjTime(y, m, d, h, min = 0, s = 0) {
  return Date.UTC(y, m - 1, d, h, min, s) - stats.BJ_OFFSET_MS
}

test('北京时段边界: 9:00 含 / 12:00 不含 / 14:00 含 / 18:00 不含', () => {
  assert.equal(stats.beijingHour(bjTime(2026, 1, 1, 9, 0)), 9)
  assert.equal(stats.periodOfHour(9), 'peak')
  assert.equal(stats.periodOfHour(12), 'off')
  assert.equal(stats.periodOfHour(14), 'peak')
  assert.equal(stats.periodOfHour(18), 'off')
  assert.equal(stats.beijingDate(bjTime(2026, 1, 1, 23, 59)), '2026-01-01')
  // 北京时间 0 点 = UTC 前一日 16 点, 日期归属北京自然日
  assert.equal(stats.beijingDate(bjTime(2026, 1, 1, 0, 0)), '2026-01-01')
})

test('周末全天按谷时计费，工作日仍按峰谷边界', () => {
  assert.equal(stats.isWeekendDate('2026-08-22'), true) // 周六
  assert.equal(stats.isWeekendDate('2026-08-23'), true) // 周日
  assert.equal(stats.isWeekendDate('2026-08-24'), false) // 周一
  assert.equal(stats.periodOfDateHour('2026-08-22', 9), 'off')
  assert.equal(stats.periodOfDateHour('2026-08-23', 14), 'off')
  assert.equal(stats.periodOfDateHour('2026-08-24', 9), 'peak')
  assert.equal(stats.eventKey(bjTime(2026, 8, 22, 10)).period, 'off')
})

test('四桶 × 双模型 × 双时段价格断言(元/百万 tokens)', () => {
  const cases = [
    // [model, period, bucketKey, tokens, expectedCost]
    ['deepseek-v4-flash', 'peak', 'input', 1e6, 3.0],
    ['deepseek-v4-flash', 'peak', 'cacheRead', 1e6, 0.10],
    ['deepseek-v4-flash', 'peak', 'cacheWrite', 1e6, 3.0],
    ['deepseek-v4-flash', 'peak', 'output', 1e6, 9.0],
    ['deepseek-v4-flash', 'off', 'input', 1e6, 1.5],
    ['deepseek-v4-flash', 'off', 'cacheRead', 1e6, 0.05],
    ['deepseek-v4-flash', 'off', 'cacheWrite', 1e6, 1.5],
    ['deepseek-v4-flash', 'off', 'output', 1e6, 4.5],
    ['deepseek-v4-pro', 'peak', 'input', 1e6, 9.0],
    ['deepseek-v4-pro', 'peak', 'cacheRead', 1e6, 0.30],
    ['deepseek-v4-pro', 'peak', 'cacheWrite', 1e6, 9.0],
    ['deepseek-v4-pro', 'peak', 'output', 1e6, 27.0],
    ['deepseek-v4-pro', 'off', 'input', 1e6, 4.5],
    ['deepseek-v4-pro', 'off', 'cacheRead', 1e6, 0.15],
    ['deepseek-v4-pro', 'off', 'cacheWrite', 1e6, 4.5],
    ['deepseek-v4-pro', 'off', 'output', 1e6, 13.5],
  ]
  for (const [model, period, key, tokens, expected] of cases) {
    const bucket = stats.emptyBucket()
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    usage[key] = tokens
    stats.addUsage(bucket, model, period, usage)
    assert.equal(bucket[key], tokens, `${model}/${period}/${key} tokens`)
    assert.ok(Math.abs(bucket.cost - expected) < 1e-9, `${model}/${period}/${key}: ${bucket.cost} != ${expected}`)
  }
})

test('addUsage 忽略非法 usage, 未知模型费用为 0 但 token 照记', () => {
  const b = stats.emptyBucket()
  stats.addUsage(b, 'unknown-model', 'peak', { input: 100, output: -5, cacheRead: NaN, cacheWrite: 20 })
  assert.equal(b.input, 100)
  assert.equal(b.cacheWrite, 20)
  assert.equal(b.output, 0)
  assert.equal(b.cost, 0)
})

test('summarizeDay 按北京小时归入 peak/off', () => {
  const day = {
    date: '2026-01-01',
    hours: {
      9: { m: { input: 10, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0.001 } },
      12: { m: { input: 20, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0.002 } },
      14: { m: { input: 40, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0.004 } },
      18: { m: { input: 80, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0.008 } },
    },
  }
  const s = stats.summarizeDay(day)
  assert.equal(s.peak.input, 50)
  assert.equal(s.off.input, 100)
  assert.equal(s.total.input, 150)
})

test('StatsStore 幂等: 同 seq 重复不重复计费, gap 不处理', () => {
  const dir = path.join(os.tmpdir(), 'dsh-remote-stats-test-' + crypto.randomBytes(6).toString('hex'))
  const store = new stats.StatsStore(dir)
  const ev = (seq, time, model = 'deepseek-v4-pro') => ({
    type: 'assistant/message',
    seq,
    time,
    data: {
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 5 },
      message: { source: { model } },
    },
  })
  const t = bjTime(2026, 8, 17, 10, 0) // 高峰, 且在定价生效日之后
  const r1 = store.processEvent('s1', ev(0, t))
  assert.equal(r1.processed, true)
  const r2 = store.processEvent('s1', ev(0, t))
  assert.equal(r2.skip, true)
  const r3 = store.processEvent('s1', ev(2, t)) // gap: seq=2 > cursor+1(1)
  assert.equal(r3.gap, true)

  const day = store._loadDay('2026-08-17')
  const bucket = day.hours[10]['deepseek-v4-pro']
  assert.equal(bucket.input, 1000)
  assert.equal(bucket.output, 100)
  assert.equal(bucket.cacheRead, 10)
  assert.equal(bucket.cacheWrite, 5)
  // pro peak: input 1000/1e6*9=0.009, output 100/1e6*27=0.0027, cacheRead 10/1e6*0.30=0.000003, cacheWrite 5/1e6*9=0.000045
  const expectedCost = 1000 / 1e6 * 9 + 100 / 1e6 * 27 + 10 / 1e6 * 0.30 + 5 / 1e6 * 9
  assert.ok(Math.abs(bucket.cost - expectedCost) < 1e-12)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('StatsStore 周末峰时小时仍使用谷时价格并汇总到 off', () => {
  const dir = path.join(os.tmpdir(), 'dsh-remote-stats-test-' + crypto.randomBytes(6).toString('hex'))
  const store = new stats.StatsStore(dir)
  store.processEvent('weekend', {
    type: 'assistant/message', seq: 0, time: bjTime(2026, 8, 22, 10, 0),
    data: { usage: { inputTokens: 1e6, outputTokens: 1e6 }, message: { source: { model: 'deepseek-v4-flash' } } },
  })
  const day = store._loadDay('2026-08-22')
  const bucket = day.hours[10]['deepseek-v4-flash']
  assert.equal(bucket.cost, 1.5 + 4.5)
  // 模拟 rc.1 已用峰时价格落盘的周末历史记录，查询时也必须按新规则纠正。
  bucket.cost = 3.0 + 9.0
  store._saveDay(day)
  const totals = stats.summarizeDay(day)
  assert.equal(totals.peak.input, 0)
  assert.equal(totals.off.input, 1e6)
  assert.equal(totals.off.cost, 1.5 + 4.5)
  const detail = store.detail('2026-08-22')
  assert.equal(detail.hours[10].period, 'off')
  assert.equal(detail.hours[10].models['deepseek-v4-flash'].cost, 1.5 + 4.5)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('StatsStore 定价生效日前事件推进游标, 生效后首条事件正常计费', () => {
  const dir = path.join(os.tmpdir(), 'dsh-remote-stats-test-' + crypto.randomBytes(6).toString('hex'))
  const store = new stats.StatsStore(dir)
  const event = (seq, time, input) => ({
    type: 'assistant/message',
    seq,
    time,
    data: {
      usage: { inputTokens: input, outputTokens: 0 },
      message: { source: { model: 'deepseek-v4-flash' } },
    },
  })
  const beforePricing = store.processEvent('s1', event(0, bjTime(2026, 8, 16, 12), 100))
  assert.equal(beforePricing.processed, false)
  assert.equal(beforePricing.gap, false)
  const firstPriced = store.processEvent('s1', event(1, bjTime(2026, 8, 17, 10), 200))
  assert.equal(firstPriced.processed, true)
  assert.equal(store._loadDay('2026-08-17').hours[10]['deepseek-v4-flash'].input, 200)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('StatsStore summary/detail 日期窗口与 24 小时结构', () => {
  const dir = path.join(os.tmpdir(), 'dsh-remote-stats-test-' + crypto.randomBytes(6).toString('hex'))
  const store = new stats.StatsStore(dir)
  store.processEvent('s1', {
    type: 'assistant/message', seq: 0, time: bjTime(2026, 8, 17, 15, 0),
    data: { usage: { inputTokens: 1e6, outputTokens: 1e6 }, message: { source: { model: 'deepseek-v4-flash' } } },
  })
  const detail = store.detail('2026-08-17')
  assert.equal(detail.hours.length, 24)
  assert.equal(detail.hours[15].period, 'peak')
  assert.equal(detail.hours[15].models['deepseek-v4-flash'].cost, 3.0 + 9.0)
  const summary = store.summary(3)
  assert.ok(summary.length >= 1)
  assert.equal(summary[summary.length - 1].date, stats.beijingDate(Date.now()))
  assert.ok(summary[0].date >= stats.PRICING_START_DATE)
  fs.rmSync(dir, { recursive: true, force: true })
})
