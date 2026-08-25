/* DSH Remote Prompt 转写核心模块（dev 分支实验功能）
 * 纯逻辑、零依赖：密钥掩码、固定整理提示词、状态码文案和 SSE 增量解析。
 * 浏览器通过 window.TranscribeCore 使用，Node 测试通过 CommonJS 使用。
 * 当前仅在 dev 分支保留，不接入稳定版主界面。
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

  function maskApiKey(key) {
    const value = String(key || '')
    if (!value) return ''
    if (value.length <= 8) return '****' + value.slice(-4)
    return value.slice(0, 4) + '****' + value.slice(-4)
  }

  function statusMessage(status) {
    if (status === 400) return '请求参数错误：请检查 API 地址、模型名或输入内容（400）'
    if (status === 401 || status === 403) return '认证失败：API 密钥无效或无权限（' + status + '）'
    if (status === 404) return '接口不存在：请检查 API 地址是否以 /v1 结尾（404）'
    if (status === 429) return '请求过于频繁或额度不足（429）'
    if (status >= 500) return '服务端错误（' + status + '）'
    return '请求失败（HTTP ' + status + '）'
  }

  function parseSseData(line) {
    const data = String(line || '').trim().replace(/^data:\s*/, '').trim()
    if (data === '[DONE]') return { type: 'done' }
    let value
    try { value = JSON.parse(data) } catch { return { type: 'skip' } }
    if (value.error) return { type: 'error', error: String(value.error.message || statusMessage(Number(value.error.code) || 0)) }
    const piece = value.choices?.[0]?.delta?.content
    return typeof piece === 'string' ? { type: 'delta', text: piece } : { type: 'skip' }
  }

  async function consumeSse(reader, decoder, onDelta, options = {}) {
    let buffer = ''
    let full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      options.onChunk?.()
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const parsed = parseSseData(line)
        if (parsed.type === 'done') { await reader.cancel?.(); return full }
        if (parsed.type === 'error') throw new Error(parsed.error)
        if (parsed.type === 'delta') {
          full += parsed.text
          onDelta?.(parsed.text)
        }
      }
    }
    return full
  }

  return { TRANSCRIBE_SYSTEM_PROMPT, maskApiKey, statusMessage, parseSseData, consumeSse }
})
