'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const TranscribeCore = require('../public/transcribe-core.js')

test('Prompt 转写核心：密钥掩码和固定整理要求', () => {
  assert.equal(TranscribeCore.maskApiKey('0123456789'), '0123****6789')
  assert.equal(TranscribeCore.maskApiKey(''), '')
  assert.equal(TranscribeCore.maskApiKey('abcdefgh'), '****efgh')
  for (const word of ['分条分点', '逻辑清晰', '错别字', '保留原意', '直接输出']) {
    assert.ok(TranscribeCore.TRANSCRIBE_SYSTEM_PROMPT.includes(word))
  }
})

test('Prompt 转写核心：解析 OpenAI 兼容 SSE 数据帧', () => {
  assert.deepEqual(TranscribeCore.parseSseData('data: {"choices":[{"delta":{"content":"你好"}}]}'), { type: 'delta', text: '你好' })
  assert.deepEqual(TranscribeCore.parseSseData('data: [DONE]'), { type: 'done' })
  assert.deepEqual(TranscribeCore.parseSseData('data: {"choices":[{"finish_reason":"stop"}]}'), { type: 'skip' })
  assert.match(TranscribeCore.parseSseData('data: {"error":{"message":"boom"}}').error, /boom/)
})

test('Prompt 转写核心：跨网络分块消费 SSE 并保持增量顺序', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'))
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n'))
      controller.close()
    }
  })
  const chunks = []
  const full = await TranscribeCore.consumeSse(stream.getReader(), new TextDecoder(), value => chunks.push(value))
  assert.equal(full, '你好世界')
  assert.deepEqual(chunks, ['你好', '世界'])
})
