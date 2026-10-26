/* Durable approval records: session audit events (approval/asked + approval/decided)
 * plus Auto review final denials. Collection, explanation and HTML live here so the
 * mobile and desktop clients render the same record; storage stays in the client. */
'use strict'
;(function (root) {
  const MAX_RECORDS = 40
  const MAX_TEXT = 600
  const AUTO_DENIED = /^Auto review rejected tool "([^"]+)"; its body was not executed(?::\s*([\s\S]*))?$/
  const AUTO_ASKED = /^Auto review denied tool "([^"]+)"(?::\s*([\s\S]*))?$/
  const AUTO_FAILED = /^Auto review of tool "([^"]+)" failed; its body was not executed(?::\s*([\s\S]*))?$/
  const ESCALATION = /^escalate sandbox to ([a-z-]+):\s*([\s\S]*)$/
  const OUTCOMES = {
    'allowed-once': 'approval.outcomeAllowed',
    rejected: 'approval.outcomeRejected',
    cancelled: 'approval.outcomeCancelled',
    unavailable: 'approval.outcomeUnavailable',
    pending: 'approval.outcomePending',
  }
  const WHY = {
    'allowed-once': 'approval.whyAllowed',
    rejected: 'approval.whyRejected',
    cancelled: 'approval.whyCancelled',
    unavailable: 'approval.whyUnavailable',
    pending: 'approval.whyPending',
    'auto-deny': 'approval.whyAutoDenied',
  }
  const KIND = {
    auto: 'approval.kindAuto', escalation: 'approval.kindEscalation',
    'auto-deny': 'approval.kindAutoDenied', request: 'approval.kindRequest',
  }

  const text = (value, max = MAX_TEXT) => {
    if (typeof value !== 'string') return ''
    const trimmed = value.replace(/\s+/g, ' ').trim()
    return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
  const timeOf = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0

  // 本地机械词句替换，不调用模型或外部翻译服务。未识别的原文保持不变。
  // 先保护命令、路径、URL 和引号内容，避免翻译工具参数或改变其含义。
  function chineseReference(value) {
    const original = String(value || ''), protectedParts = []
    let output = original.replace(/`[^`]*`|"[^"\n]*"|(?<![A-Za-z0-9])'[^'\n]*'|https?:\/\/[^\s]+|[A-Za-z]:[\\/][^\s,;]+|(?:\.{0,2}\/)[^\s,;]+/g, part => {
      protectedParts.push(part); return '\uE000' + (protectedParts.length - 1) + '\uE001'
    })
    const phrases = [
      [/\b(?:this|the) (?:command|action|operation) (?:would|will) delete files outside (?:of )?(?:the )?workspace\b/gi, '此操作将删除工作区之外的文件'],
      [/\b(?:this|the) (?:command|action|operation) (?:could|may|might|can) delete files outside (?:of )?(?:the )?workspace\b/gi, '此操作可能删除工作区之外的文件'],
      [/\bthe user (?:has not|hasn't) (?:explicitly )?authorized (?:this|the) (?:action|operation|command)\b/gi, '用户尚未明确授权此操作'],
      [/\bthe user (?:did not|didn't) request\b/gi, '用户未要求'],
      [/\bnot (?:explicitly )?requested by the user\b/gi, '用户未明确要求'],
      [/\bno (?:explicit )?user (?:authorization|approval|consent)\b/gi, '没有明确的用户授权'],
      [/\b(?:this|the) (?:command|action|operation|tool call) (?:could|may|might|can)\b/gi, '此操作可能'],
      [/\b(?:this|the) (?:command|action|operation|tool call) (?:would|will)\b/gi, '此操作将'],
      [/\b(?:is|are) not (?:explicitly )?authorized\b/gi, '未获明确授权'],
      [/\b(?:is|are) not allowed\b/gi, '不允许'],
      [/\b(?:does not|doesn't) (?:have|include) (?:explicit )?(?:user )?(?:authorization|approval)\b/gi, '未获得用户明确授权'],
      [/\bwithout (?:explicit )?user (?:approval|authorization|consent)\b/gi, '未经用户明确批准'],
      [/\b(?:requires?|needs?) (?:explicit )?user (?:approval|authorization|confirmation)\b/gi, '需要用户明确批准'],
      [/\b(?:outside|out of) (?:of )?(?:the )?(?:(?:allowed|approved|current) )?workspace\b/gi, '在工作区之外'],
      [/\boutside (?:the )?(?:authorized|approved) scope\b/gi, '超出已授权范围'],
      [/\b(?:user |explicit )?(?:authorization|approval) is (?:missing|required|unclear|insufficient)\b/gi, '缺少明确的用户授权'],
      [/\brecursive(?:ly)? delet(?:e|es|ion|ing)\b/gi, '递归删除'],
      [/\bdelet(?:e|es|ing) (?:existing )?files\b/gi, '删除文件'],
      [/\b(?:overwrite|overwrites|overwriting) (?:existing )?(?:files|data)\b/gi, '覆盖已有文件或数据'],
      [/\birreversible (?:actions?|operations?|changes?)\b/gi, '不可逆操作'],
      [/\bdestructive (?:actions?|operations?|changes?)\b/gi, '破坏性操作'],
      [/\b(?:expose|leak|exfiltrate) (?:secrets|credentials|tokens|sensitive data)\b/gi, '泄露密钥、凭据或敏感数据'],
      [/\b(?:send|transmit|upload) (?:private|sensitive|local) (?:data|files)\b/gi, '发送私有或敏感数据'],
      [/\buntrusted (?:server|endpoint|service|destination)\b/gi, '不可信的服务'],
      [/\bexternal (?:server|endpoint|service|destination)\b/gi, '外部服务'],
      [/\b(?:elevated|administrator|admin) privileges\b/gi, '管理员权限'],
      [/\bpermission denied\b/gi, '权限被拒绝'], [/\baccess denied\b/gi, '访问被拒绝'],
      [/\bread[- ]only\b/gi, '只读'], [/\bnetwork access\b/gi, '网络访问'],
      [/\b(?:review|request) timed out\b/gi, '审查请求超时'], [/\btimeout\b/gi, '超时'],
      [/\b(?:risk of|may cause) data loss\b/gi, '可能导致数据丢失'],
    ]
    for (const [pattern, replacement] of phrases) output = output.replace(pattern, replacement)
    return output.replace(/\uE000(\d+)\uE001/g, (_match, index) => protectedParts[Number(index)] ?? _match)
  }

  function feedback(value) {
    const raw = String(value || ''), denied = AUTO_DENIED.exec(raw), asked = AUTO_ASKED.exec(raw), failed = AUTO_FAILED.exec(raw)
    const match = denied || asked || failed
    if (!match || root.I18N?.lang === 'en') return { text: raw, translated: false }
    const prefix = failed ? '自动审查失败，工具未执行' : denied ? '自动审查拒绝，工具未执行' : '自动审查未通过，等待人工决定'
    return { text: prefix + '（' + match[1] + '）' + (match[2] ? '：' + chineseReference(match[2]) : ''), translated: true }
  }

  function displayReason(value) {
    const raw = String(value || ''), rendered = feedback(raw)
    return rendered.translated ? rendered.text + '\n\n原文：' + raw : raw
  }

  function feedbackHtml(value) {
    let raw = typeof value === 'string' ? value : ''
    if (!raw && value && typeof value === 'object') {
      const blocks = Array.isArray(value) ? value : value.content
      raw = Array.isArray(blocks) ? blocks.filter(block => block?.type === 'text').map(block => String(block.text || '')).join('\n') : typeof value.text === 'string' ? value.text : ''
    }
    const rendered = feedback(raw)
    if (!rendered.translated) return ''
    let original
    try { original = typeof value === 'string' ? value : JSON.stringify(value, null, 2) } catch { original = raw }
    return `<section class="approval-translation"><h4>自动审查反馈 · 中文参考</h4><p>${esc(rendered.text.slice(0, 12000))}</p><details><summary>查看原文</summary><pre>${esc(String(original).slice(0, 12000))}</pre></details></section>`
  }

  function kindOf(reason) {
    if (AUTO_ASKED.test(reason || '') || AUTO_DENIED.test(reason || '')) return 'auto'
    if (ESCALATION.test(reason || '')) return 'escalation'
    return 'request'
  }

  function create() { return new Map() }

  function trim(records) {
    if (records.size <= MAX_RECORDS) return
    const rows = Array.from(records.values()).sort((a, b) => (b.askedAt || b.decidedAt || 0) - (a.askedAt || a.decidedAt || 0))
    for (const row of rows.slice(MAX_RECORDS)) records.delete(row.id)
  }

  function put(records, next) {
    if (!next.id) return false
    records.set(next.id, { ...(records.get(next.id) || {}), ...next })
    trim(records)
    return true
  }

  function resultText(event) {
    const message = event?.data?.message || event?.data || {}
    const blocks = message?.content
    if (!Array.isArray(blocks)) return ''
    return blocks.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n')
  }

  function fromAutoDenial(records, sessionId, event) {
    const callId = text(event?.data?.message?.toolCallId || event?.data?.callId, 120)
    const match = AUTO_DENIED.exec(resultText(event))
    if (!match) return false
    const id = 'auto-deny:' + String(sessionId || '') + ':' + (callId || String(event?.seq ?? ''))
    if (records.has(id)) return false
    return put(records, {
      id, sessionId: String(sessionId || ''), kind: 'auto-deny',
      toolName: text(match?.[1], 80) || 'tool', reason: text(match?.[2] || ''),
      callId, outcome: 'rejected', askedAt: timeOf(event?.time), decidedAt: timeOf(event?.time),
      askedSeq: Number.isFinite(event?.seq) ? event.seq : null, decidedSeq: Number.isFinite(event?.seq) ? event.seq : null,
    })
  }

  /** Collect one session-log event. Returns true when the record set changed. */
  function fromEvent(records, sessionId, event) {
    const type = event?.type
    const data = event?.data || {}
    if (type === 'approval/asked') {
      const id = typeof data.id === 'string' ? data.id : ''
      if (!id) return false
      const reason = text(data.reason)
      return put(records, {
        id, sessionId: String(sessionId || ''), kind: kindOf(reason), toolName: text(data.toolName, 80) || 'tool',
        reason, callId: text(data.callId, 120), askedAt: timeOf(event.time), askedSeq: Number.isFinite(event.seq) ? event.seq : null,
        outcome: records.get(id)?.outcome || 'pending', detailsPending: false,
      })
    }
    if (type === 'approval/decided') {
      const id = typeof data.id === 'string' ? data.id : ''
      if (!id) return false
      const previous = records.get(id)
      if (Number.isFinite(previous?.decidedSeq) && Number.isFinite(event.seq) && event.seq < previous.decidedSeq) return false
      return put(records, {
        id, sessionId: previous?.sessionId || String(sessionId || ''), detailsPending: previous?.detailsPending ?? !previous,
        outcome: text(data.outcome, 40) || 'unknown',
        decidedAt: timeOf(event.time), decidedSeq: Number.isFinite(event.seq) ? event.seq : null,
      })
    }
    if (type === 'tool/result') return fromAutoDenial(records, sessionId, event)
    return false
  }

  /** Collect one live gateway frame (approval/requested or approval/resolved). */
  function fromFrame(records, frame) {
    if (!frame || typeof frame !== 'object') return false
    if (frame.type === 'approval/requested') {
      const id = typeof frame.approvalId === 'string' ? frame.approvalId : ''
      if (!id) return false
      const reason = text(frame.reason)
      return put(records, {
        id, sessionId: String(frame.sessionId || ''), kind: kindOf(reason), toolName: text(frame.toolName, 80) || 'tool',
        reason, callId: text(frame.callId, 120), askedAt: records.get(id)?.askedAt || Date.now(),
        askedSeq: records.get(id)?.askedSeq ?? null, detailsPending: false,
        outcome: records.get(id)?.outcome && records.get(id).outcome !== 'pending' ? records.get(id).outcome : 'pending',
      })
    }
    if (frame.type === 'approval/resolved') {
      const id = typeof frame.approvalId === 'string' ? frame.approvalId : ''
      if (!id) return false
      const previous = records.get(id)
      return put(records, { id, sessionId: previous?.sessionId || String(frame.sessionId || ''),
        detailsPending: previous?.detailsPending ?? !previous, outcome: text(frame.outcome, 40) || 'unknown', decidedAt: Date.now() })
    }
    return false
  }

  function summary(record) {
    const reason = record?.reason || ''
    const auto = AUTO_ASKED.exec(reason) || AUTO_DENIED.exec(reason)
    if (auto) return { kind: 'auto', text: text(auto[2] || '') }
    const escalation = ESCALATION.exec(reason)
    if (escalation) return { kind: 'escalation', target: escalation[1], text: text(escalation[2]) }
    return { kind: record?.kind === 'auto-deny' ? 'auto-deny' : 'request', text: text(reason) }
  }

  const outcomeKey = outcome => OUTCOMES[outcome] || 'approval.outcomeUnknown'
  const isPending = record => !record?.outcome || record.outcome === 'pending' || record.outcome === 'unknown'
  const kindKey = record => KIND[record?.kind] || KIND[(summary(record) || {}).kind] || KIND.request

  function list(records, limit = MAX_RECORDS) {
    if (!(records instanceof Map)) return []
    return Array.from(records.values()).filter(record => !record.detailsPending)
      .sort((a, b) => (b.askedAt || 0) - (a.askedAt || 0))
      .slice(0, Math.max(1, limit))
  }

  function reasonHtml(record, t) {
    const info = summary(record)
    const label = t(KIND[info.kind] || KIND.request)
    const raw = info.text || t('approval.noReason')
    const localized = root.I18N?.lang !== 'en' && ['auto', 'auto-deny'].includes(info.kind) ? chineseReference(raw) : raw
    const original = localized !== raw ? `<details class="approval-original"><summary>查看原文 · 中文为机械翻译参考</summary><div>${esc(raw)}</div></details>` : ''
    return `<div class="approval-record-reason"><span class="approval-record-kind">${esc(label)}</span><div class="approval-record-copy">${esc(localized)}${original}</div></div>`
  }

  function recordHtml(record, t, { session = '', now = Date.now() } = {}) {
    const outcome = isPending(record) ? 'pending' : record.outcome
    const badgeKey = outcomeKey(outcome)
    const whyKey = WHY[record?.kind === 'auto-deny' ? 'auto-deny' : outcome] || WHY.pending
    const time = record.decidedAt || record.askedAt
    return `<article class="approval-record${isPending(record) ? ' is-pending' : ''}" data-approval-record="${esc(record.id)}">
      <div class="approval-record-head"><span class="approval-record-title">🔐 ${esc(record.toolName || t('tool.default'))}</span><span class="approval-record-badge ${esc(outcome)}">${esc(t(badgeKey))}</span></div>
      ${reasonHtml(record, t)}
      <div class="approval-record-why">${esc(t(whyKey))}</div>
      <div class="approval-record-meta">${session ? esc(session) + ' · ' : ''}${esc(relTime(time, t, now))}</div>
    </article>`
  }

  function lineHtml(record, t, { now = Date.now() } = {}) {
    const outcome = isPending(record) ? 'pending' : record.outcome
    const badgeKey = outcomeKey(outcome)
    const whyKey = WHY[record?.kind === 'auto-deny' ? 'auto-deny' : outcome] || WHY.pending
    return `<details class="approval-event${isPending(record) ? ' is-pending' : ''}" data-approval-event="${esc(record.id)}">
      <summary>🔐 ${esc(record.toolName || t('tool.default'))}<span class="approval-event-badge ${esc(outcome)}">${esc(t(badgeKey))}</span><span class="approval-event-time">${esc(relTime(record.decidedAt || record.askedAt, t, now))}</span></summary>
      ${reasonHtml(record, t)}
      <div class="approval-record-why">${esc(t(whyKey))}</div>
    </details>`
  }

  function relTime(millis, t, now = Date.now()) {
    if (!millis) return ''
    const delta = Math.max(0, now - millis)
    if (delta < 60_000) return t('approval.justNow')
    if (delta < 3_600_000) return t('approval.minutesAgo', { n: Math.floor(delta / 60_000) })
    if (delta < 86_400_000) return t('approval.hoursAgo', { n: Math.floor(delta / 3_600_000) })
    const date = new Date(millis)
    const pad = value => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function serialize(records) {
    return JSON.stringify(Array.from(records.values()).map(record => ({
      id: record.id, sessionId: record.sessionId, kind: record.kind, toolName: record.toolName,
      reason: record.reason, callId: record.callId, outcome: record.outcome,
      askedAt: record.askedAt, decidedAt: record.decidedAt,
      detailsPending: record.detailsPending === true, askedSeq: record.askedSeq, decidedSeq: record.decidedSeq,
    })))
  }

  function restore(raw) {
    const records = create()
    let rows
    try { rows = JSON.parse(raw || '[]') } catch { return records }
    if (!Array.isArray(rows)) return records
    for (const row of rows.slice(0, MAX_RECORDS)) {
      if (!row || typeof row.id !== 'string' || !row.id) continue
      put(records, {
        id: row.id.slice(0, 512), sessionId: text(row.sessionId, 120), kind: kindOf(text(row.reason)) === 'auto' && row.kind === 'auto-deny' ? 'auto-deny' : (['auto', 'escalation', 'auto-deny', 'request'].includes(row.kind) ? row.kind : kindOf(text(row.reason))),
        toolName: text(row.toolName, 80) || 'tool', reason: text(row.reason), callId: text(row.callId, 120),
        outcome: text(row.outcome, 40) || 'pending', askedAt: timeOf(row.askedAt), decidedAt: timeOf(row.decidedAt),
        detailsPending: row.detailsPending === true,
        askedSeq: Number.isFinite(row.askedSeq) ? row.askedSeq : null, decidedSeq: Number.isFinite(row.decidedSeq) ? row.decidedSeq : null,
      })
    }
    return records
  }

  root.DshApprovalRecords = {
    create, fromEvent, fromFrame, summary, kindOf, list, recordHtml, lineHtml,
    outcomeKey, isPending, serialize, restore, relTime, chineseReference, displayReason, feedbackHtml, MAX: MAX_RECORDS,
  }
})(window)
