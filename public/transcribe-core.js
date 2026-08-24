/* DSH Remote prompt 转写核心纯逻辑: 密钥掩码 / 固定 System Prompt / 状态码错误文案
 * 浏览器全局 window.TranscribeCore + Node CommonJS 双形态(与 history-core.js 同模式),
 * app.js 与 tests/transcribe-core.test.js 共用。
 * SystemPrompt 面向豆包等通用助手, 要求把用户原始文字改写为分条分点、逻辑清晰、
 * 修正语句/错别字、删除无意义口语语气词、可直接使用的提示词。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TranscribeCore = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const TRANSCRIBE_SYSTEM_PROMPT = [
    '你是文本整理助手。请把用户发来的原始文字改写成一条可直接使用的提示词，要求：',
    '1. 分条分点：把内容按要点拆成编号列表，层次清晰；',
    '2. 逻辑清晰：按「目标—背景—要求—输出」的顺序整理，删除冗余重复；',
    '3. 修正语句与错别字：修正病句、错别字、标点与大小写问题；',
    '4. 删除无意义口语语气词：去掉「那个、就是说、嗯、啊、然后」等口头禅；',
    '5. 保留原意：不增删核心信息，不擅自补充额外要求；',
    '6. 直接输出改写结果，不解释、不客套。'
  ].join('\n')

  /* API 密钥掩码: 前4位 + **** + 后4位, 过短时只保留后4位 */
  function maskApiKey(key) {
    if (!key) return ''
    if (key.length <= 8) return '****' + String(key).slice(-4)
    return String(key).slice(0, 4) + '****' + String(key).slice(-4)
  }

  /* OpenAI 兼容接口 HTTP 状态码 → 用户可读失败原因(中文) */
  function statusMessage(status) {
    if (status === 400) return '请求参数错误：请检查 API 地址、模型名或输入内容（400）'
    if (status === 401 || status === 403) return '认证失败：API 密钥无效或无权限（' + status + '）'
    if (status === 404) return '接口不存在：请检查 API 地址是否以 /v1 结尾（' + status + '）'
    if (status === 429) return '请求过于频繁或额度不足（' + status + '）'
    if (status >= 500) return '服务端错误（' + status + '）'
    return '请求失败（HTTP ' + status + '）'
  }

  /* 消费 SSE 响应流并逐段回调增量文本。
   * reader: ReadableStreamDefaultReader; decoder: TextDecoder; onDelta(text) 每段增量回调。
   * 按 \n 切行、跳过非 data: 行; 遇 [DONE] 提前结束; 遇 error 帧抛 Error。
   * 返回累计全文(可能为空字符串)。流被外部 AbortSignal 中断时抛 AbortError。
   * app.js 的 transcribeChat 流式循环与单元测试共用。 */
  async function consumeSse(reader, decoder, onDelta, opts) {
    opts = opts || {}
    let buf = ''
    let full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      if (opts.onChunk) opts.onChunk() // 每块网络数据到达后回调(用于空闲超时计时)
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const parsed = parseSseData(line)
        if (parsed.type === 'done') { reader.cancel(); return full }
        if (parsed.type === 'error') throw new Error(parsed.error)
        if (parsed.type === 'delta') {
          full += parsed.text
          if (onDelta) onDelta(parsed.text)
        }
      }
    }
    return full
  }

  /* 解析一条 SSE "data:" 行的增量输出。
   * 返回 { type: 'delta', text } / { type: 'done' } / { type: 'error', error } / { type: 'skip' }。
   * 兼容 OpenAI 兼容接口流式响应(choices[].delta.content)与 [DONE] 结束符;
   * 忽略 usage/finish_reason 等无内容帧; 非 JSON 行按 skip 处理不强杀。
   * app.js 流式读取循环与单元测试共用。 */
  function parseSseData(line) {
    const data = String(line).trim().replace(/^data:\s*/, '').trim()
    if (data === '[DONE]') return { type: 'done' }
    let obj
    try { obj = JSON.parse(data) } catch { return { type: 'skip' } }
    if (obj.error) {
      const code = typeof obj.error.code === 'number' ? obj.error.code : 0
      const text = obj.error.message || statusMessage(code)
      return { type: 'error', error: String(text) }
    }
    const piece = obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content
    if (typeof piece === 'string') return { type: 'delta', text: piece }
    return { type: 'skip' }
  }

  return { TRANSCRIBE_SYSTEM_PROMPT, maskApiKey, statusMessage, parseSseData, consumeSse }
})
