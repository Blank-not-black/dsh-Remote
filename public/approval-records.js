/* Durable approval records: session audit events (approval/asked + approval/decided)
 * plus Auto review final denials. Collection, explanation and HTML live here so the
 * mobile and desktop clients render the same record; storage stays in the client. */
'use strict'
;(function (root) {
  const MAX_RECORDS = 40
  const MAX_TEXT = 600
  const AUTO_DENIED = /^Auto review rejected tool "([^"]+)"; its body was not executed(?::\s*([\s\S]*))?$/
  const AUTO_ASKED = /^Auto review denied tool "([^"]+)"(?::\s*([\s\S]*))?$/
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
    const body = esc(info.text || t('approval.noReason'))
    return `<div class="approval-record-reason"><span class="approval-record-kind">${esc(label)}</span><span>${body}</span></div>`
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
    outcomeKey, isPending, serialize, restore, relTime, MAX: MAX_RECORDS,
  }
})(window)
