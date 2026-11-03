/* Explicit, cached explanations. No summary request is made during rendering. */
;(function (root) {
  'use strict'
  const cache = new Map()
  let config, scope, mounted = false
  const text = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
  function context() {
    const connection = config?.capture()
    if (scope && !scope.valid()) reset()
    if (connection) scope = connection
    return connection
  }
  const keyOf = item => JSON.stringify([item.sessionId, item.approvalId, item.callId || '', item.reason || ''])
  const eligible = item => /^Auto review denied tool "[^"]+"(?::|$)/.test(item?.reason || '')
  const current = item => config.items().some(value => keyOf(value) === keyOf(item))
  function html(item) {
    if (!eligible(item)) return ''
    context()
    const row = cache.get(keyOf(item))
    const label = text('AI 中文总结（消耗 token）', 'AI Chinese summary (uses tokens)')
    return '<section class="approval-ai" data-approval-ai="' + esc(item.approvalId) + '" data-ai-session="' + esc(item.sessionId) + '">'
      + '<button type="button" class="deck-summary-button" data-ai-generate' + (row ? ' disabled' : '') + '>' + (row?.phase === 'loading' ? text('正在生成…', 'Generating…') : label) + '</button>'
      + '<p class="approval-ai-copy" role="status">' + esc(row?.text || text('按需生成，仅供参考；请结合完整请求决定。', 'Optional reference; decide using the full request.')) + '</p></section>'
  }
  function update(item) {
    for (const node of root.document?.querySelectorAll('[data-approval-ai]') || []) {
      if (node.dataset.approvalAi !== item.approvalId || node.dataset.aiSession !== item.sessionId) continue
      // Set text only; model output is never interpreted as HTML or Markdown.
      const row = cache.get(keyOf(item)), button = node.querySelector('[data-ai-generate]'), copy = node.querySelector('[role="status"]')
      if (button) { button.disabled = !!row; button.textContent = row?.phase === 'loading' ? text('正在生成…','Generating…') : text('AI 中文总结（消耗 token）','AI Chinese summary (uses tokens)') }
      if (copy && row) copy.textContent = row.text
    }
  }
  async function generate(item) {
    const connection = context(), key = keyOf(item)
    if (!connection?.valid() || !eligible(item) || cache.has(key) || !current(item)) return
    if (!root.confirm(text('将此审批的工具名和审查理由交给当前会话配置的模型生成中文短摘要，会消耗 token；不发送完整对话或工具参数。摘要仅供参考，原始请求和审批决定保持不变。是否继续？',
      'Send this approval’s tool name and review reason to the current session model for a Chinese summary? This uses tokens. Full conversation and tool arguments are excluded. The summary is only a reference; the request and approval decision remain unchanged.'))) return
    if (!connection.valid() || !current(item)) return
    while (cache.size >= 40) {
      const old = [...cache].find(([, value]) => value.phase !== 'loading')
      if (!old) return
      cache.delete(old[0])
    }
    const controller = new AbortController(), row = { phase: 'loading', controller, text: text('正在生成，不影响允许或拒绝。','Generating; Allow and Reject remain available.') }
    cache.set(key, row); update(item)
    const timer = setTimeout(() => controller.abort(), 18_000)
    try {
      const response = await root.fetch(config.url(connection, '/remote/api/approval-summary'), { method: 'POST',
        headers: { ...config.headers(connection), 'content-type':'application/json' },
        body: JSON.stringify({ sessionId:item.sessionId, approvalId:item.approvalId, ...(item.callId ? { callId:item.callId } : {}), consent:true }),
        signal:controller.signal })
      const value = await response.json()
      if (!response.ok || value.ok !== true || typeof value.summary !== 'string' || value.summary.length > 240) throw Error('unavailable')
      row.phase = 'done'; row.text = text('AI 中文总结（仅供参考）：','AI Chinese summary (reference only): ') + value.summary
    } catch {
      row.phase = 'error'; row.text = text('摘要未生成，可能已产生 token 消耗；请查看原始理由。本请求不会自动重试。','Summary unavailable; tokens may have been used. Read the original reason. This request will not retry automatically.')
    } finally {
      clearTimeout(timer)
      if (connection.valid() && cache.get(key) === row && current(item)) update(item)
    }
  }
  function reset() { for (const row of cache.values()) row.controller?.abort(); cache.clear(); scope = null }
  function mount(value) {
    config = value
    if (mounted) return
    mounted = true
    root.document?.addEventListener('click', event => {
      const button = event.target?.closest?.('[data-ai-generate]'), node = button?.closest('[data-approval-ai]')
      if (!node) return
      event.preventDefault(); event.stopPropagation()
      const item = config.items().find(item => item.approvalId === node.dataset.approvalAi && item.sessionId === node.dataset.aiSession)
      if (item) void generate(item)
    })
  }
  root.DshApprovalSummary = { html, mount, reset, generate }
})(window)
