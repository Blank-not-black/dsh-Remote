'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const mobile = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const desktop = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')

test('手机和桌面端聚合 DSH 实时思考分片并由最终消息接管', () => {
  for (const source of [mobile, desktop]) {
    assert.match(source, /event\?\.type === 'assistant\/chunk'/)
    assert.match(source, /chunk\.type === 'reasoning-delta'/)
    assert.match(source, /event\?\.type === 'reasoning-chunks'/)
    assert.match(source, /Array\.isArray\(data\.texts\) \? data\.texts\.join\(''\)/)
    assert.match(source, /event\?\.type === 'assistant\/message'/)
    assert.match(source, /partialReasoning\.delete\(key\)/)
    assert.match(source, /block\.thinkingLive/)
  }
})

test('历史尾页中的未完成思考也会恢复而不是继续被内部事件过滤', () => {
  assert.match(mobile, /for \(const entry of incoming\) \{[\s\S]{0,180}applyReasoningStreamEvent\(ev\)/)
  assert.match(desktop, /for \(const entry of v\.events \|\| \[\]\) \{[\s\S]{0,180}applyReasoningStreamEvent\(ev\)/)
})

test('模型未公布 reasoning 元数据时提供 low high max 三档兼容选择', () => {
  for (const source of [mobile, desktop]) {
    assert.match(source, /function reasoningEffortOptions\(model\)/)
    assert.match(source, /model\?\.reasoning\?\.efforts/)
    assert.match(source, /model\?\.reasoningEfforts/)
    assert.match(source, /\['low', 'high', 'max'\]\.map/)
    assert.match(source, /reasoningEffort: effortId/)
    assert.match(source, /models\.effortCustomHint/)
  }
})

test('思考流聚合逻辑按 turn step index 隔离并在最终消息后清理', () => {
  const start = mobile.indexOf('function reasoningStreamKey')
  const end = mobile.indexOf('let reasoningRenderTimer', start)
  const context = { state: { history: { partialReasoning: new Map() } } }
  vm.createContext(context)
  vm.runInContext(`${mobile.slice(start, end)}\nthis.apply = applyReasoningStreamEvent`, context)

  context.apply({ type: 'assistant/chunk', data: { turn: 2, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } })
  context.apply({ type: 'assistant/chunk', data: { turn: 2, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先分析' } } })
  context.apply({ type: 'reasoning-chunks', data: { turn: 2, step: 2, index: 0, texts: ['再', '确认'] } })
  assert.deepEqual([...context.state.history.partialReasoning.values()].map(item => item.text), ['先分析', '再确认'])
  context.apply({ type: 'assistant/message', data: { turn: 2, step: 1, content: [] } })
  assert.deepEqual([...context.state.history.partialReasoning.values()].map(item => item.text), ['再确认'])
})

test('reasoning 档位归一化保留官方目录并为未知路由生成三档', () => {
  const start = mobile.indexOf('function reasoningEffortOptions')
  const end = mobile.indexOf('async function selectSessionEffort', start)
  const context = { t: key => key }
  vm.createContext(context)
  vm.runInContext(`${mobile.slice(start, end)}\nthis.options = reasoningEffortOptions`, context)

  const official = context.options({ reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } })
  assert.deepEqual(Array.from(official.efforts, item => item.id), ['off', 'high'])
  assert.equal(official.defaultEffort, 'high')
  assert.equal(official.custom, false)

  const fallback = context.options(undefined)
  assert.deepEqual(Array.from(fallback.efforts, item => item.id), ['low', 'high', 'max'])
  assert.equal(fallback.custom, true)
})
